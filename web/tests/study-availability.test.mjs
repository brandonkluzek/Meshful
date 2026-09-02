import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createMemoryStorage, createStudyStore } from "../js/store.js";
import { WEBMCP_TOOL_NAMES, WEBMCP_TOOL_SCHEMAS } from "../js/webmcp.js";

const NOW = "2026-08-31T12:00:00.000Z";
const KEY = "adaptive-study-lab:web-state:v1";

function seedDeck(store, {
  deckId = "availability", cards = ["root", "child", "independent"],
  edges = [{ from: "root", to: "child" }],
} = {}) {
  store.ingestDeck({
    operation: "create", idempotency_key: `availability:seed:${deckId}`,
    deck: {
      schema_version: "normalized-definition-deck.v2", deck_id: deckId, title: "Availability",
      cards: cards.map(id => ({ id, term: id,
        definition: `Private canonical definition of ${id}.`, criteria: [`Private criterion for ${id}.`] })),
      edges,
    },
  });
}

function createFixture(options) {
  const storage = createMemoryStorage();
  let instant = NOW;
  let clockReads = 0;
  const clock = () => { clockReads += 1; return instant; };
  const store = createStudyStore({ catalog: [], storage, clock });
  seedDeck(store, options);
  return { store, storage, clock, clockReads: () => clockReads, setTime: value => { instant = value; } };
}

function start(store, key, { deckId = "availability", limit = 1 } = {}) {
  return store.startStudySession({ deck_id: deckId, limit, idempotency_key: `start:${key}` });
}

function grade(store, started, rating, key) {
  const current = started.current_card;
  return store.submitGrade({
    session_id: started.session.session_id, card_id: current.card_id,
    expected_card_revision: current.card_revision,
    expected_session_revision: started.session.session_revision,
    answer_text: "Synthetic fixture recall attempt.", answer_origin: "chat", rating,
    rubric_evidence: current.required_concepts.map(item => ({
      rubric_item_id: item.rubric_item_id, status: rating === "again" ? "missed" : "met",
      note: "Synthetic mechanics evidence, not a semantic-quality result.",
    })),
    feedback: "Synthetic fixture only.", misconceptions: [], confidence: 1,
    idempotency_key: `grade:${key}`,
  });
}

function finish(store, session, disposition, key) {
  return store.finishStudySession({
    session_id: session.session_id, expected_session_revision: session.session_revision,
    disposition, idempotency_key: `finish:${key}`,
  });
}

function cloneStore(fixture) {
  return createStudyStore({ catalog: [], storage: createMemoryStorage(fixture.storage.dump()), clock: fixture.clock });
}

function assertQueueMatches(fixture, expectedIds) {
  const availability = fixture.store.getStudyAvailability({ deck_id: "availability" });
  const row = availability.decks[0];
  const clone = cloneStore(fixture);
  const session = start(clone, "queue-membership", { limit: 50 });
  assert.equal(session.session.total, row.due_count + row.eligible_new_count);
  assert.deepEqual(clone.getSnapshot().sessions[session.session.session_id].queue, expectedIds);
}

function updateTitle(store, title = "Updated title") {
  return store.updateDeck({
    deck_id: "availability", expected_deck_revision: store.getSnapshot().personalDecks.availability.revision,
    patch: { title }, idempotency_key: `title:${title}`,
  });
}

test("availability distinguishes ready from blocked without changing state or starting a session", () => {
  const { store, storage } = createFixture();
  const before = storage.dump();
  const snapshot = store.getSnapshot();
  const result = store.getStudyAvailability({ deck_id: "availability", blocked_limit: 20 });
  assert.equal(result.as_of, NOW);
  assert.equal(result.app_revision, snapshot.revision);
  assert.equal(result.active_session, null);
  assert.deepEqual(result.decks[0], {
    deck_id: "availability", deck_revision: 1, archived: false,
    due_count: 0, eligible_new_count: 2, blocked_new_count: 1,
    next_due_at: null, resumable_session: null,
  });
  assert.equal(result.blockers.items[0].card_id, "availability.child");
  assert.deepEqual(result.blockers.items[0].unmet_prerequisites, [{
    card_id: "availability.root", term: "root", owner_deck_id: "availability",
    owner_deck_title: "Availability", catalog_deck_id: null, catalog_version: null,
    reason: "PARENT_RECALL_REQUIRED",
  }]);
  assert.deepEqual(store.getSnapshot(), snapshot);
  assert.deepEqual(storage.dump(), before);
  assert.equal(JSON.stringify(result).includes("Private canonical"), false);
  assert.equal(JSON.stringify(result).includes("Private criterion"), false);
});

test("all-deck and empty reads have the same closed shape and do not invent a session", () => {
  const storage = createMemoryStorage();
  const store = createStudyStore({ catalog: [], storage, clock: () => NOW });
  const before = storage.dump();
  assert.deepEqual(store.getStudyAvailability(), {
    as_of: NOW, app_revision: 0, active_session: null, decks: [], blockers: null,
  });
  assert.deepEqual(storage.dump(), before);
  seedDeck(store);
  seedDeck(store, { deckId: "other", cards: ["one"], edges: [] });
  const all = store.getStudyAvailability();
  assert.deepEqual(all.decks.map(row => row.deck_id), ["availability", "other"]);
  for (const row of all.decks) {
    assert.deepEqual(store.getStudyAvailability({ deck_id: row.deck_id }).decks, [row]);
  }
  assert.equal(all.blockers, null);
  assert.equal(all.active_session, null);
});

test("availability takes exactly one clock sample for a coherent as_of", () => {
  const f = createFixture();
  const previousReads = f.clockReads();
  assert.equal(f.store.getStudyAvailability({ deck_id: "availability", blocked_limit: 10 }).as_of, NOW);
  assert.equal(f.clockReads() - previousReads, 1);
});

test("fresh queue membership matches the availability counts without touching the read fixture", () => {
  const f = createFixture();
  const before = f.storage.dump();
  assertQueueMatches(f, ["availability.root", "availability.independent"]);
  assert.deepEqual(f.storage.dump(), before);
  const overview = f.store.getLearningOverview();
  assert.equal(overview.new_available_total, 2);
  assert.equal(overview.decks[0].new_count, 3, "raw unseen count is intentionally distinct from eligible new count");
});

test("newly unlocked cards appear in availability without refilling an existing fixed queue", () => {
  const f = createFixture();
  const initial = start(f.store, "fixed-queue", { limit: 2 });
  const result = grade(f.store, initial, "good", "root");
  assert.equal(result.next_card.card_id, "availability.independent");
  const before = f.store.getSnapshot();
  const bytes = f.storage.dump();
  const availability = f.store.getStudyAvailability({ deck_id: "availability", blocked_limit: 10 });
  assert.equal(availability.decks[0].eligible_new_count, 2);
  assert.equal(availability.decks[0].blocked_new_count, 0);
  assert.equal(availability.active_session.session_id, initial.session.session_id);
  assert.equal(availability.active_session.total, 2);
  assert.equal(availability.active_session.remaining, 1);
  assert.equal(availability.active_session.current_card_id, "availability.independent");
  assert.equal(availability.decks[0].resumable_session, null);
  assert.deepEqual(f.store.getSnapshot(), before);
  assert.deepEqual(f.storage.dump(), bytes);
});

test("completed batches report available new work without starting or resuming anything", () => {
  const f = createFixture();
  const result = grade(f.store, start(f.store, "single-root"), "good", "single-root");
  assert.equal(result.session.status, "completed");
  const before = f.storage.dump();
  const row = f.store.getStudyAvailability().decks[0];
  assert.equal(row.eligible_new_count, 2);
  assert.equal(row.resumable_session, null);
  assert.equal(f.store.getStudyAvailability().active_session, null);
  assertQueueMatches(f, ["availability.child", "availability.independent"]);
  assert.deepEqual(f.storage.dump(), before);
});

test("next_due_at is strictly future and advances past exact due boundaries", () => {
  const f = createFixture();
  const root = grade(f.store, start(f.store, "root-good"), "good", "root-good");
  const child = grade(f.store, start(f.store, "child-easy"), "easy", "child-easy");
  const rootDue = root.schedule.next.due_at;
  const childDue = child.schedule.next.due_at;
  assert.ok(Date.parse(NOW) < Date.parse(rootDue));
  assert.ok(Date.parse(rootDue) < Date.parse(childDue));
  const before = f.storage.dump();
  for (const [at, dueCount, nextDue, queue] of [
    [NOW, 0, rootDue, ["availability.independent"]],
    [new Date(Date.parse(rootDue) - 1).toISOString(), 0, rootDue, ["availability.independent"]],
    [rootDue, 1, childDue, ["availability.root", "availability.independent"]],
    [childDue, 2, null, ["availability.root", "availability.child", "availability.independent"]],
  ]) {
    f.setTime(at);
    const availability = f.store.getStudyAvailability();
    assert.equal(availability.as_of, at);
    assert.equal(availability.decks[0].due_count, dueCount);
    assert.equal(availability.decks[0].eligible_new_count, 1);
    assert.equal(availability.decks[0].next_due_at, nextDue);
    assert.equal(availability.active_session, null);
    if (nextDue) assert.ok(Date.parse(nextDue) > Date.parse(at));
    assertQueueMatches(f, queue);
  }
  assert.deepEqual(f.storage.dump(), before, "time projections and isolated queue probes never write the original state");
});

test("a paused queue is resumable until another active session conflicts", () => {
  const f = createFixture();
  seedDeck(f.store, { deckId: "other", cards: ["one"], edges: [] });
  const initial = start(f.store, "pause-original", { limit: 2 });
  finish(f.store, initial.session, "pause", "pause-original");
  let row = f.store.getStudyAvailability({ deck_id: "availability" }).decks[0];
  assert.equal(row.resumable_session.session_id, initial.session.session_id);
  assert.equal(row.resumable_session.current_card_id, "availability.root");
  assert.equal(row.resumable_session.can_resume, true);
  assert.equal(row.resumable_session.reason, null);
  const other = start(f.store, "active-other", { deckId: "other" });
  const beforeConflict = f.storage.dump();
  const availability = f.store.getStudyAvailability({ deck_id: "availability" });
  assert.equal(availability.active_session.session_id, other.session.session_id);
  assert.equal(availability.decks[0].resumable_session.can_resume, false);
  assert.equal(availability.decks[0].resumable_session.reason, "ACTIVE_SESSION_EXISTS");
  assert.throws(() => start(f.store, "conflicted-resume"), { code: "ACTIVE_SESSION_EXISTS" });
  assert.deepEqual(f.storage.dump(), beforeConflict);
  finish(f.store, other.session, "end", "end-other");
  row = f.store.getStudyAvailability({ deck_id: "availability" }).decks[0];
  assert.equal(row.resumable_session.can_resume, true);
  const resumed = start(f.store, "resume-original", { limit: 1 });
  assert.equal(resumed.session.session_id, initial.session.session_id);
  assert.equal(resumed.current_card.card_id, row.resumable_session.current_card_id);
  assert.equal(resumed.session.total, 2, "resume retains the queue, not the newly requested limit");
});

test("archived cards and decks are excluded from readiness and future due dates", () => {
  const f = createFixture();
  grade(f.store, start(f.store, "archive-root"), "good", "archive-root");
  f.store.updateCards({
    deck_id: "availability", expected_deck_revision: f.store.getSnapshot().personalDecks.availability.revision,
    // Internal parents cannot be archived while their active child remains.
    updates: ["root", "child"].map(id => ({ card_id: `availability.${id}`, patch: { archived: true } })),
    idempotency_key: "archive-reviewed-root",
  });
  const row = f.store.getStudyAvailability().decks[0];
  assert.equal(row.next_due_at, null);
  assert.equal(row.due_count, 0);
  assert.equal(row.eligible_new_count, 1);
  assert.equal(row.blocked_new_count, 0);
  f.store.setDeckArchived({
    deck_id: "availability", archived: true,
    expected_revision: f.store.getSnapshot().personalDecks.availability.revision,
    client_action_id: "archive-deck",
  });
  const before = f.storage.dump();
  assert.deepEqual(f.store.getStudyAvailability().decks, []);
  const explicit = f.store.getStudyAvailability({ deck_id: "availability", blocked_limit: 10 });
  assert.equal(explicit.decks[0].archived, true);
  assert.equal(explicit.decks[0].due_count + explicit.decks[0].eligible_new_count + explicit.decks[0].blocked_new_count, 0);
  assert.equal(explicit.decks[0].next_due_at, null);
  assert.deepEqual(explicit.blockers.items, []);
  assert.deepEqual(f.storage.dump(), before);
});

test("blocker pagination is stable, revision-bound, and contains only display-safe metadata", () => {
  const f = createFixture({
    cards: ["root", "first", "second", "third"],
    edges: ["first", "second", "third"].map(to => ({ from: "root", to })),
  });
  const before = f.storage.dump();
  const first = f.store.getStudyAvailability({ deck_id: "availability", blocked_limit: 1 });
  assert.equal(first.blockers.total_blocked_cards, 3);
  assert.equal(first.blockers.items[0].card_id, "availability.first");
  assert.ok(first.blockers.next_cursor);
  const second = f.store.getStudyAvailability({
    deck_id: "availability", blocked_limit: 1, blocked_cursor: first.blockers.next_cursor,
  });
  assert.equal(second.blockers.items[0].card_id, "availability.second");
  f.setTime("2026-09-03T12:00:00.000Z");
  const third = f.store.getStudyAvailability({
    deck_id: "availability", blocked_limit: 1, blocked_cursor: second.blockers.next_cursor,
  });
  assert.equal(third.blockers.items[0].card_id, "availability.third");
  assert.equal(third.blockers.next_cursor, null);
  assert.equal(third.app_revision, first.app_revision);
  assert.deepEqual(Object.keys(third.blockers.items[0]).sort(), ["card_id", "term", "unmet_prerequisites"]);
  assert.deepEqual(f.storage.dump(), before);
  updateTitle(f.store);
  const changed = f.storage.dump();
  assert.throws(() => f.store.getStudyAvailability({
    deck_id: "availability", blocked_limit: 1, blocked_cursor: first.blockers.next_cursor,
  }), { code: "STALE_AVAILABILITY_CURSOR" });
  assert.deepEqual(f.storage.dump(), changed);
});

test("invalid and cross-deck blocker cursors fail without writes", () => {
  const f = createFixture();
  seedDeck(f.store, { deckId: "other", cards: ["one"], edges: [] });
  const revision = f.store.getSnapshot().revision;
  const before = f.storage.dump();
  for (const cursor of [
    "offset:0", "availability-v1:garbage:availability:0",
    `availability-v1:${revision}:other:0`, `availability-v1:${revision}:%E0%A4%A:0`,
    `availability-v1:${revision}:availability:-1`, `availability-v1:${revision}:availability:2`,
    `availability-v1:${revision}:availability:9007199254740992`,
    "availability-v1:9007199254740992:availability:0",
  ]) {
    assert.throws(() => f.store.getStudyAvailability({
      deck_id: "availability", blocked_limit: 1, blocked_cursor: cursor,
    }), { code: "INVALID_CURSOR" }, cursor);
  }
  assert.deepEqual(f.storage.dump(), before);
});

test("the longest supported legacy deck ID round-trips through an emitted blocker cursor", () => {
  const storage = createMemoryStorage();
  const store = createStudyStore({ catalog: [], storage, clock: () => NOW });
  const deckId = `d${":".repeat(256)}`;
  // Retained local decks may predate lean-v2 slug IDs. This existing legacy
  // authoring helper is fixture setup only, not a new agent tool or workflow.
  const preview = store.previewDeckChanges({
    target: { kind: "new", deck_id: deckId, title: "Legacy identity fixture" },
    cards_upsert: ["root", "first", "second"].map(id => ({
      id, term: id, definition: "Legacy fixture definition.",
    })),
    edges_upsert: ["first", "second"].map(dependent_card_id => ({
      prerequisite_card_id: "root", dependent_card_id,
    })),
  });
  store.applyDeckChanges({ preview_token: preview.preview_token, expected_base_revision: 0,
    client_action_id: "create-legacy-cursor-fixture" });
  const before = storage.dump();
  const first = store.getStudyAvailability({ deck_id: deckId, blocked_limit: 1 });
  assert.ok(first.blockers.next_cursor.length > 512, "fixture exercises URI expansion of a valid ID");
  const second = store.getStudyAvailability({ deck_id: deckId, blocked_limit: 1,
    blocked_cursor: first.blockers.next_cursor });
  assert.equal(second.blockers.items[0].card_id, `${deckId}.second`);
  assert.equal(second.blockers.next_cursor, null);
  assert.deepEqual(storage.dump(), before);
});

test("closed availability inputs reject unsafe or incomplete requests without mutation", () => {
  const f = createFixture();
  const before = f.storage.dump();
  for (const args of [null, [], { blocked_limit: 1 }, { blocked_limit: 0, blocked_cursor: "x" },
    { deck_id: "availability", blocked_limit: -1 }, { deck_id: "availability", blocked_limit: 51 },
    { deck_id: "availability", blocked_limit: 1.5 }, { deck_id: "availability", blocked_limit: "1" },
    { deck_id: "availability", blocked_cursor: "x" }]) {
    assert.throws(() => f.store.getStudyAvailability(args), { code: "INVALID_ARGUMENT" });
  }
  assert.throws(() => f.store.getStudyAvailability({ deck_id: "availability", start: true }), { code: "UNKNOWN_FIELD" });
  assert.throws(() => f.store.getStudyAvailability({ deck_id: "missing" }), { code: "DECK_NOT_FOUND" });
  assert.deepEqual(f.storage.dump(), before);
});

test("a confirmed-state read-only adapter recomputes time without writes or a durable command", () => {
  const f = createFixture();
  const result = grade(f.store, start(f.store, "read-only-adapter"), "good", "read-only-adapter");
  let writes = 0;
  const raw = f.storage.getItem(KEY);
  const reader = createStudyStore({
    catalog: [], clock: f.clock,
    storage: {
      getItem: key => key === KEY ? raw : null,
      setItem() { writes += 1; throw new Error("No account read writes allowed"); },
      removeItem() { writes += 1; throw new Error("No account read removal allowed"); },
    },
  });
  for (const at of [NOW, result.schedule.next.due_at]) {
    f.setTime(at);
    assert.deepEqual(reader.getStudyAvailability({ deck_id: "availability", blocked_limit: 5 }),
      f.store.getStudyAvailability({ deck_id: "availability", blocked_limit: 5 }));
  }
  assert.equal(writes, 0);
  assert.equal(f.storage.getItem(KEY), raw);
});

test("a shared-storage reader refreshes one confirmed revision and cannot accept an old page cursor", () => {
  const f = createFixture({
    cards: ["root", "one", "two"], edges: ["one", "two"].map(to => ({ from: "root", to })),
  });
  const reader = createStudyStore({ catalog: [], storage: f.storage, clock: f.clock });
  const first = reader.getStudyAvailability({ deck_id: "availability", blocked_limit: 1 });
  grade(f.store, start(f.store, "cross-context"), "good", "cross-context");
  const before = f.storage.dump();
  const next = reader.getStudyAvailability({ deck_id: "availability", blocked_limit: 1 });
  assert.ok(next.app_revision > first.app_revision);
  assert.equal(next.decks[0].eligible_new_count, 2);
  assert.equal(next.decks[0].blocked_new_count, 0);
  assert.equal(next.blockers.next_cursor, null);
  assert.throws(() => reader.getStudyAvailability({
    deck_id: "availability", blocked_limit: 1, blocked_cursor: first.blockers.next_cursor,
  }), { code: "STALE_AVAILABILITY_CURSOR" });
  assert.deepEqual(f.storage.dump(), before);
});

test("read-only availability adds no wire tool or input/output constraint", () => {
  const stripDescriptionAnnotations = value => Array.isArray(value)
    ? value.map(stripDescriptionAnnotations)
    : (!value || typeof value !== "object") ? value
      : Object.fromEntries(Object.entries(value)
        .filter(([key, child]) => !(key === "description" && typeof child === "string"))
        .map(([key, child]) => [key, stripDescriptionAnnotations(child)]));
  assert.equal(WEBMCP_TOOL_NAMES.length, 13);
  assert.equal(WEBMCP_TOOL_NAMES.some(name => /availability/.test(name)), false);
  assert.equal(createHash("sha256")
    .update(JSON.stringify(stripDescriptionAnnotations(WEBMCP_TOOL_SCHEMAS)))
    .digest("hex"),
  "50708cab1727763ce19805361dc0d574fd3faa6654401aaba3a34c591ccd23eb");
});
