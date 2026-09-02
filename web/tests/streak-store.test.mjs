import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStorage, createStudyStore } from "../js/store.js";

const KEY = "adaptive-study-lab:web-state:v1";
const LEGACY = { current: 417, longest: 500, lastActivityDate: "2026-08-29" };

function fixture() {
  let instant = "2026-08-30T23:55:00.000Z";
  const initial = createMemoryStorage();
  const author = createStudyStore({ catalog: [], storage: initial, clock: () => instant, timeZone: "America/Chicago" });
  author.ingestDeck({ operation: "create", idempotency_key: "seed:deck", deck: {
    schema_version: "normalized-definition-deck.v2", deck_id: "streak-test", title: "Streak mechanics",
    cards: ["one", "two", "three"].map(id => ({ id, term: id, definition: `Definition ${id}.`, criteria: ["State the definition."] })), edges: [],
  } });
  // Synthetic legacy counters, not a reconstructed 417-day activity history.
  const saved = JSON.parse(initial.getItem(KEY));
  saved.streak = { ...LEGACY };
  const memory = createMemoryStorage({ [KEY]: JSON.stringify(saved) });
  let writes = 0;
  let failWrite = false;
  const storage = { ...memory, setItem(key, value) {
    if (failWrite) throw Object.assign(new Error("Injected quota failure"), { code: "TEST_QUOTA" });
    writes++; memory.setItem(key, value);
  } };
  const clock = () => instant;
  const open = (timeZone = "America/Chicago") => createStudyStore({ catalog: [], storage, clock, timeZone });
  return { store: open(), storage, open, raw: () => JSON.parse(memory.getItem(KEY)), writes: () => writes,
    at(value) { instant = value; }, fail(value) { failWrite = value; } };
}

function start(store, key) {
  return store.startStudySession({ deck_id: "streak-test", limit: 1, idempotency_key: `start:${key}` });
}

function input(current, key) {
  return {
    session_id: current.session.session_id, card_id: current.current_card.card_id,
    expected_session_revision: current.session.session_revision, expected_card_revision: current.current_card.card_revision,
    answer_text: "Synthetic recall attempt.", answer_origin: "chat", rating: "good",
    rubric_evidence: current.current_card.required_concepts.map(item => ({ rubric_item_id: item.rubric_item_id, status: "met", note: "Clock mechanics fixture." })),
    feedback: "Injected grade; not grading-quality evidence.", misconceptions: [], confidence: 1, idempotency_key: `grade:${key}`,
  };
}

function projections(store) {
  const snapshot = store.getSnapshot().streak;
  assert.deepEqual(store.inspectAppState().streak, snapshot);
  assert.deepEqual(store.listMyDecks().global_streak, snapshot);
  return snapshot;
}

test("all three streak reads preserve legacy UTC bytes and cannot create local tracking, including after idle expiry", () => {
  const f = fixture();
  const before = f.storage.dump();
  const now = projections(f.store);
  assert.equal(now.current, 417);
  assert.equal(now.trackingBasis, "legacy-utc");
  assert.deepEqual(now.legacyUtc, LEGACY);
  assert.equal(now.localCivil, undefined);
  f.at("2026-09-03T12:00:00.000Z");
  const expired = projections(f.open());
  assert.equal(expired.current, 0);
  assert.equal(expired.longest, 500);
  assert.deepEqual(expired.legacyUtc, LEGACY);
  assert.deepEqual(f.storage.dump(), before);
  assert.equal(f.writes(), 0);
});

test("first real committed grade starts local one without replacing UTC counters or earlier receipts", () => {
  const f = fixture();
  const oldReceipt = f.raw().actionReceipts["webmcp:seed:deck"];
  assert.ok(oldReceipt);
  const current = start(f.store, "first");
  assert.equal(f.raw().streak.localCivil, undefined, "starting a session is not a study day");
  const result = f.store.submitGrade(input(current, "first"));
  const raw = f.raw();
  const { localCivil, ...legacy } = raw.streak;
  assert.deepEqual(legacy, LEGACY);
  assert.deepEqual(localCivil, { version: "local-civil-v1", current: 1, longest: 1, lastActivityDate: "2026-08-30", timeZone: "America/Chicago" });
  assert.deepEqual(raw.actionReceipts["webmcp:seed:deck"], oldReceipt);
  assert.equal(result.session.status, "completed");
  assert.equal(projections(f.store).current, 1);
  assert.equal(projections(f.store).trackingBasis, "local-civil-v1");
  assert.deepEqual(projections(f.store).legacyUtc, LEGACY);
});

test("UTC midnight is one Chicago day, local midnight is a new day, and idle expiry never changes saved history", () => {
  const f = fixture();
  const first = f.store.submitGrade(input(start(f.store, "first"), "first"));
  const firstHistory = structuredClone(f.raw().personalDecks["streak-test"].cards[first.card_id].reviewHistory);
  f.at("2026-08-31T00:05:00.000Z");
  f.store.submitGrade(input(start(f.store, "second"), "second"));
  assert.equal(projections(f.store).current, 1);
  f.at("2026-08-31T05:05:00.000Z");
  f.store.submitGrade(input(start(f.store, "third"), "third"));
  assert.equal(projections(f.store).current, 2);
  assert.equal(projections(f.store).lastActivityDate, "2026-08-31");
  const bytes = f.storage.dump();
  const writes = f.writes();
  f.at("2026-09-03T12:00:00.000Z");
  const expired = projections(f.open());
  assert.equal(expired.current, 0);
  assert.equal(expired.longest, 2);
  assert.equal(expired.localCivil.current, 2);
  assert.deepEqual(expired.legacyUtc, LEGACY);
  assert.deepEqual(f.raw().personalDecks["streak-test"].cards[first.card_id].reviewHistory, firstHistory);
  assert.deepEqual(f.storage.dump(), bytes);
  assert.equal(f.writes(), writes);
});

test("grade replay on a later day returns the old receipt without another review, streak update or write", () => {
  const f = fixture();
  const args = input(start(f.store, "first"), "first");
  const committed = f.store.submitGrade(args);
  const saved = f.storage.dump();
  const writes = f.writes();
  f.at("2026-09-03T12:00:00.000Z");
  const replayed = f.open().submitGrade(args);
  assert.equal(replayed.receipt.replayed, true);
  assert.deepEqual({ ...replayed, receipt: { ...replayed.receipt, replayed: false } }, committed);
  assert.deepEqual(f.storage.dump(), saved);
  assert.equal(f.writes(), writes);
  assert.equal(f.raw().personalDecks["streak-test"].cards[committed.card_id].reviewHistory.length, 1);
});

test("a failed grade save cannot create a prospective streak and unchanged retry commits once", () => {
  const f = fixture();
  const args = input(start(f.store, "first"), "first");
  const before = f.store.getSnapshot();
  const bytes = f.storage.dump();
  const writes = f.writes();
  f.fail(true);
  assert.throws(() => f.store.submitGrade(args), error => error.code === "TEST_QUOTA");
  assert.deepEqual(f.store.getSnapshot(), before);
  assert.deepEqual(f.storage.dump(), bytes);
  assert.equal(f.raw().streak.localCivil, undefined);
  f.fail(false);
  f.store.submitGrade(args);
  assert.equal(f.writes(), writes + 1);
  assert.equal(projections(f.store).current, 1);
  assert.deepEqual(projections(f.store).legacyUtc, LEGACY);
});
