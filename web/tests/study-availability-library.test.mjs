import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createMemoryStorage, createStudyStore } from "../js/store.js";
import { prepareLibraryCatalog } from "../js/library-catalog.js";
import { catalogId, FIXTURE_VERSION, preparedFixture } from "./helpers/library-fixture.mjs";

const KEY = "adaptive-study-lab:web-state:v1";
const NOW = "2026-08-31T12:00:00.000Z";
const LATER = "2026-10-31T12:00:00.000Z";
const NEXT_VERSION = "synthetic-reviewed.v2";
const PARENT = "opaque-parent";
const CHILD = "opaque-child";
const PARENT_TERM = "Original parent concept";
const CHILD_TERM = "Dependent concept";

function card(id, term, prerequisite_ids = []) {
  return {
    id, term, prerequisite_ids,
    definition: `Synthetic reference answer for ${term}.`,
    required_concepts: [{ rubric_item_id: `criterion-${id}`, text: "State the synthetic definition." }],
  };
}

function definitions(parentSource = "alpha", parentTerm = PARENT_TERM) {
  return [
    [parentSource, [card(PARENT, parentTerm), card("opaque-unused", "Unrelated concept")]],
    ["beta", [card(CHILD, CHILD_TERM, [PARENT])]],
  ];
}

function trackedStorage(initial = {}) {
  const backing = createMemoryStorage(initial);
  const storage = {
    attempts: 0,
    rejectWrites: false,
    getItem: (key) => backing.getItem(key),
    setItem(key, value) {
      storage.attempts += 1;
      if (storage.rejectWrites) throw new Error("Availability attempted a storage write");
      backing.setItem(key, value);
    },
    removeItem: (key) => backing.removeItem(key),
    dump: () => backing.dump(),
  };
  return storage;
}

function install(store, sourceId, version = FIXTURE_VERSION, key = `install:${sourceId}`) {
  return store.addLibraryDeck({
    library_deck_id: catalogId(sourceId), expected_catalog_version: version, client_action_id: key,
  });
}

async function fixture(sourceDefinitions = definitions(), root = "beta") {
  const { feed, prepared } = await preparedFixture(sourceDefinitions);
  const time = { at: NOW };
  const clock = () => time.at;
  const storage = trackedStorage();
  const store = createStudyStore({ catalog: prepared, storage, clock });
  const installed = install(store, root);
  const deckIds = Object.fromEntries(installed.installation.decks.map((entry) => [entry.catalog_deck_id, entry.deck_id]));
  return {
    feed, prepared, catalog: prepared, retainedCatalogs: [], store, storage, time, clock, deckIds,
    parentDeckId: deckIds[catalogId("alpha")], childDeckId: installed.deck.id,
  };
}

// Deliberately damaged recovery states are synthetic and dense. Normal mutation
// APIs prevent several of these states; no prepared-descriptor impersonation,
// source files, real learner stores or fabricated mastery are involved.
function recovered(original, mutate, { catalog = original.catalog, retainedCatalogs = original.retainedCatalogs } = {}) {
  const state = original.store.getSnapshot();
  mutate(state);
  const storage = trackedStorage({ [KEY]: JSON.stringify(state) });
  const store = createStudyStore({ catalog, retainedCatalogs, storage, clock: original.clock });
  return { ...original, catalog, retainedCatalogs, store, storage };
}

function readOnlyAvailability(f, args = { deck_id: f.childDeckId, blocked_limit: 50 }) {
  const snapshot = f.store.getSnapshot();
  const bytes = f.storage.dump();
  const attempts = f.storage.attempts;
  f.storage.rejectWrites = true;
  let result;
  try {
    result = f.store.getStudyAvailability(args);
    assert.deepEqual(f.store.getStudyAvailability(args), result, "unchanged inputs produce unchanged availability");
    assert.deepEqual(f.store.getSnapshot(), snapshot, "availability does not mutate learner memory");
  } finally {
    f.storage.rejectWrites = false;
  }
  assert.deepEqual(f.storage.dump(), bytes, "availability preserves exact persisted bytes");
  assert.equal(f.storage.attempts, attempts, "availability makes no commit attempt");
  assert.equal(result.as_of, f.clock());
  assert.equal(result.app_revision, snapshot.revision);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-source-canary|Synthetic reference answer/);
  return result;
}

function summary(result, deckId) {
  const row = result.decks.find((deck) => deck.deck_id === deckId);
  assert.ok(row, `availability contains deck ${deckId}`);
  return row;
}

function expectedParent(f, reason, overrides = {}) {
  return {
    card_id: PARENT,
    term: PARENT_TERM,
    owner_deck_id: f.parentDeckId,
    owner_deck_title: "Synthetic alpha",
    catalog_deck_id: catalogId("alpha"),
    catalog_version: FIXTURE_VERSION,
    reason,
    ...overrides,
  };
}

function singleBlocker(f, expected) {
  const result = readOnlyAvailability(f);
  const row = summary(result, f.childDeckId);
  assert.equal(row.eligible_new_count, 0);
  assert.equal(row.blocked_new_count, 1);
  assert.equal(result.blockers.deck_id, f.childDeckId);
  assert.equal(result.blockers.total_blocked_cards, 1);
  assert.deepEqual(result.blockers.items, [{ card_id: CHILD, term: CHILD_TERM, unmet_prerequisites: [expected] }]);
  assert.equal(result.blockers.next_cursor, null);
  return result;
}

function start(f, deckId, key) {
  return f.store.startStudySession({ deck_id: deckId, limit: 1, idempotency_key: `start:${key}` });
}

function grade(f, deckId, rating, key) {
  const started = start(f, deckId, key);
  const current = started.current_card;
  assert.ok(current, "the synthetic grade has an actual current card");
  return f.store.submitGrade({
    session_id: started.session.session_id, card_id: current.card_id,
    expected_card_revision: current.card_revision,
    expected_session_revision: started.session.session_revision,
    answer_text: "Synthetic recall attempt.", answer_origin: "chat", rating,
    rubric_evidence: current.required_concepts.map((item) => ({
      rubric_item_id: item.rubric_item_id, status: "met", note: "Synthetic mechanics test.",
    })),
    feedback: "Synthetic scheduling evidence, not semantic grading acceptance.",
    misconceptions: [], confidence: 1, idempotency_key: `grade:${key}`,
  });
}

function update(f, deckId, cardId, patch, key) {
  return f.store.updateCards({
    deck_id: deckId, expected_deck_revision: f.store.getSnapshot().personalDecks[deckId].revision,
    updates: [{ card_id: cardId, patch }], idempotency_key: `update:${key}`,
  });
}

function archiveParent(f, key) {
  return f.store.setDeckArchived({
    deck_id: f.parentDeckId, archived: true,
    expected_revision: f.store.getSnapshot().personalDecks[f.parentDeckId].revision,
    client_action_id: `archive:${key}`,
  });
}

// Independent fixture hash, not the adapter's digest helper. A distinct valid
// release is required: the store rejects conflicting bytes under one version.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function nextRelease(parentSource = "alpha") {
  const { feed } = await preparedFixture(definitions(parentSource, "Current release parent concept"));
  const next = structuredClone(feed);
  next.catalog_ref.version = NEXT_VERSION;
  for (const deck of next.catalog) deck.version = NEXT_VERSION;
  for (const mapping of next.runtime_identity_map.decks) mapping.catalog_deck_version = NEXT_VERSION;
  next.catalog_ref.digest = `sha256:${createHash("sha256").update(stableJson(next.catalog), "utf8").digest("hex")}`;
  return prepareLibraryCatalog(next);
}

test("Library availability defaults to counts with no blocker page or write", async () => {
  const f = await fixture();
  const result = readOnlyAvailability(f, { deck_id: f.childDeckId });
  assert.equal(result.blockers, null);
  assert.equal(result.active_session, null);
  assert.equal(summary(result, f.childDeckId).blocked_new_count, 1);
  assert.equal(summary(result, f.childDeckId).eligible_new_count, 0);
});

test("an installed but unreviewed exact parent reports recall required with canonical metadata", async () => {
  const f = await fixture();
  singleBlocker(f, expectedParent(f, "PARENT_RECALL_REQUIRED"));
});

test("a missing installation retains known catalog metadata without inventing an installed owner ID", async () => {
  const original = await fixture();
  const f = recovered(original, (state) => { delete state.personalDecks[original.parentDeckId]; });
  singleBlocker(f, expectedParent(f, "PARENT_NOT_INSTALLED", { owner_deck_id: null }));
});

test("a missing canonical parent card differs from a missing parent installation", async () => {
  const original = await fixture();
  const f = recovered(original, (state) => {
    const parent = state.personalDecks[original.parentDeckId];
    delete parent.cards[PARENT];
    parent.cardOrder = parent.cardOrder.filter((id) => id !== PARENT);
  });
  singleBlocker(f, expectedParent(f, "PARENT_MISSING"));
});

test("an unresolved edited prerequisite exposes null display metadata instead of parsing its dotted ID", async () => {
  const f = await fixture();
  const unknown = "guessed-owner.not-a-canonical-parent";
  update(f, f.childDeckId, CHILD, { prerequisite_ids: [unknown] }, "unresolved");
  singleBlocker(f, {
    card_id: unknown, term: null, owner_deck_id: null, owner_deck_title: null,
    catalog_deck_id: null, catalog_version: null, reason: "PARENT_UNRESOLVED",
  });
});

test("an archived exact parent card reports the card archive instead of missing recall", async () => {
  const f = await fixture();
  grade(f, f.parentDeckId, "good", "before-card-archive");
  update(f, f.parentDeckId, PARENT, { archived: true }, "archive-card");
  singleBlocker(f, expectedParent(f, "PARENT_CARD_ARCHIVED"));
});

test("an archived exact parent deck reports the deck archive without restoring it", async () => {
  const f = await fixture();
  grade(f, f.parentDeckId, "good", "before-deck-archive");
  archiveParent(f, "parent");
  singleBlocker(f, expectedParent(f, "PARENT_DECK_ARCHIVED"));
});

test("duplicate exact parent installations are ambiguous even when both contain prior Good recall", async () => {
  const original = await fixture();
  grade(original, original.parentDeckId, "good", "before-duplicate");
  const f = recovered(original, (state) => {
    state.personalDecks["duplicate-parent-installation"] = {
      ...structuredClone(state.personalDecks[original.parentDeckId]), id: "duplicate-parent-installation",
    };
  });
  singleBlocker(f, expectedParent(f, "PARENT_AMBIGUOUS", { owner_deck_id: null }));
});

for (const rating of ["again", "hard"]) {
  test(`${rating} on the exact parent does not turn repetition count into availability`, async () => {
    const f = await fixture();
    grade(f, f.parentDeckId, rating, `parent-${rating}`);
    assert.equal(f.store.getSnapshot().personalDecks[f.parentDeckId].cards[PARENT].review.repetitions, 1);
    singleBlocker(f, expectedParent(f, "PARENT_RECALL_REQUIRED"));
  });
}

for (const rating of ["good", "easy"]) {
  test(`${rating} on the exact parent unlocks the child without finishing the parent course`, async () => {
    const f = await fixture();
    grade(f, f.parentDeckId, rating, `parent-${rating}`);
    assert.equal(f.store.getSnapshot().personalDecks[f.parentDeckId].cards["opaque-unused"].review.repetitions, 0);
    const result = readOnlyAvailability(f);
    assert.equal(summary(result, f.childDeckId).eligible_new_count, 1);
    assert.equal(summary(result, f.childDeckId).blocked_new_count, 0);
    assert.equal(result.blockers.total_blocked_cards, 0);
    assert.deepEqual(result.blockers.items, []);
  });
}

test("multiple external prerequisites count one blocked child and list only unmet exact parents", async () => {
  const { prepared } = await preparedFixture();
  const storage = trackedStorage();
  const clock = () => NOW;
  const store = createStudyStore({ catalog: prepared, storage, clock });
  const installed = install(store, "gamma");
  const ids = Object.fromEntries(installed.installation.decks.map((entry) => [entry.catalog_deck_id, entry.deck_id]));
  const f = { store, storage, clock, childDeckId: installed.deck.id };
  let result = readOnlyAvailability(f);
  assert.equal(result.blockers.total_blocked_cards, 1);
  assert.deepEqual(result.blockers.items[0].unmet_prerequisites.map((parent) => parent.card_id), ["beta.branch", "delta.branch"]);
  grade(f, ids[catalogId("alpha")], "good", "diamond-root");
  grade(f, ids[catalogId("beta")], "good", "diamond-left");
  result = readOnlyAvailability(f);
  assert.equal(summary(result, installed.deck.id).blocked_new_count, 1);
  assert.deepEqual(result.blockers.items[0].unmet_prerequisites.map((parent) => [parent.card_id, parent.reason]), [
    ["delta.branch", "PARENT_RECALL_REQUIRED"],
  ]);
});

test("prior Good survives a later Again for a still-new child's availability", async () => {
  const f = await fixture();
  grade(f, f.parentDeckId, "good", "parent-initial-good");
  f.time.at = LATER;
  grade(f, f.parentDeckId, "again", "parent-later-again");
  const result = readOnlyAvailability(f);
  assert.equal(summary(result, f.childDeckId).eligible_new_count, 1);
  assert.equal(summary(result, f.childDeckId).blocked_new_count, 0);
});

test("an actually reviewed child remains due after parent archival and cold reload", async () => {
  const f = await fixture();
  grade(f, f.parentDeckId, "good", "parent-before-child");
  grade(f, f.childDeckId, "again", "child-introduction");
  archiveParent(f, "after-child-introduction");
  f.time.at = LATER;
  f.store = createStudyStore({ catalog: f.catalog, storage: f.storage, clock: f.clock });
  const result = readOnlyAvailability(f);
  const row = summary(result, f.childDeckId);
  assert.equal(row.due_count, 1);
  assert.equal(row.eligible_new_count, 0);
  assert.equal(row.blocked_new_count, 0);
  assert.deepEqual(result.blockers.items, []);
  assert.equal(f.store.getSnapshot().personalDecks[f.childDeckId].cards[CHILD].review.repetitions, 1);
});

test("a paused new child reports whether its external parent still permits resume, without resuming", async () => {
  const f = await fixture();
  grade(f, f.parentDeckId, "good", "parent-before-pause");
  const started = start(f, f.childDeckId, "child-to-pause");
  f.store.finishStudySession({
    session_id: started.session.session_id, disposition: "pause",
    expected_session_revision: started.session.session_revision, idempotency_key: "pause:child",
  });
  const beforeArchive = readOnlyAvailability(f);
  const resumable = summary(beforeArchive, f.childDeckId).resumable_session;
  assert.equal(resumable.session_id, started.session.session_id);
  assert.equal(resumable.status, "paused");
  assert.equal(resumable.current_card_id, CHILD);
  assert.equal(resumable.can_resume, true);
  assert.equal(resumable.reason, null);
  archiveParent(f, "paused-child-parent");
  const afterArchive = singleBlocker(f, expectedParent(f, "PARENT_DECK_ARCHIVED"));
  const blocked = summary(afterArchive, f.childDeckId).resumable_session;
  assert.equal(blocked.session_id, started.session.session_id);
  assert.equal(blocked.status, "paused");
  assert.equal(blocked.can_resume, false);
  assert.equal(typeof blocked.reason, "string");
  assert.ok(blocked.reason.length > 0);
  assert.equal(afterArchive.active_session, null);
});

test("missing-parent labels come from the child's retained release even when the current owner changed", async () => {
  const original = await fixture();
  const current = await nextRelease("omega");
  const f = recovered(original, (state) => { delete state.personalDecks[original.parentDeckId]; }, {
    catalog: current, retainedCatalogs: [original.prepared],
  });
  singleBlocker(f, expectedParent(f, "PARENT_NOT_INSTALLED", { owner_deck_id: null }));
});

test("an installed retained-release parent resolves by its exact old pin, not the new default owner", async () => {
  const original = await fixture();
  grade(original, original.parentDeckId, "good", "retained-parent");
  const current = await nextRelease("omega");
  const f = recovered(original, () => {}, { catalog: current, retainedCatalogs: [original.prepared] });
  const result = readOnlyAvailability(f);
  assert.equal(summary(result, f.childDeckId).eligible_new_count, 1);
  assert.equal(summary(result, f.childDeckId).blocked_new_count, 0);
  assert.deepEqual(result.blockers.items, []);
});

async function withWrongEdition({ keepCorrect }) {
  const original = await fixture();
  grade(original, original.parentDeckId, "good", "original-edition-parent");
  const current = await nextRelease();
  const wrongStorage = trackedStorage();
  const wrongStore = createStudyStore({ catalog: current, storage: wrongStorage, clock: original.clock });
  const installed = install(wrongStore, "alpha", NEXT_VERSION, "install:new-edition-parent");
  const wrong = { store: wrongStore, storage: wrongStorage, clock: original.clock };
  grade(wrong, installed.deck.id, "good", "wrong-edition-parent");
  const other = wrongStore.getSnapshot().personalDecks[installed.deck.id];
  return recovered(original, (state) => {
    if (!keepCorrect) delete state.personalDecks[original.parentDeckId];
    state.personalDecks["wrong-edition-parent-installation"] = { ...other, id: "wrong-edition-parent-installation" };
  }, { catalog: current, retainedCatalogs: [original.prepared] });
}

test("only a wrong-edition installation reports base conflict despite its Good recall", async () => {
  const f = await withWrongEdition({ keepCorrect: false });
  const result = readOnlyAvailability(f);
  assert.equal(summary(result, f.childDeckId).eligible_new_count, 0);
  assert.equal(summary(result, f.childDeckId).blocked_new_count, 1);
  const [parent] = result.blockers.items[0].unmet_prerequisites;
  assert.equal(parent.reason, "PARENT_BASE_CONFLICT");
  assert.equal(parent.card_id, PARENT);
  assert.equal(parent.term, PARENT_TERM);
  assert.equal(parent.catalog_deck_id, catalogId("alpha"));
  assert.equal(parent.catalog_version, FIXTURE_VERSION);
});

test("one correct parent edition plus another wrong edition is eligible, not ambiguous", async () => {
  const f = await withWrongEdition({ keepCorrect: true });
  const result = readOnlyAvailability(f);
  assert.equal(summary(result, f.childDeckId).eligible_new_count, 1);
  assert.equal(summary(result, f.childDeckId).blocked_new_count, 0);
  assert.deepEqual(result.blockers.items, []);
});

test("availability result objects cannot mutate the Library, learner state or a later read", async () => {
  const f = await fixture();
  const result = readOnlyAvailability(f);
  const original = structuredClone(result);
  for (const mutate of [
    () => { result.decks[0].blocked_new_count = 900; },
    () => { result.blockers.items[0].term = "Mutated result"; },
    () => { result.blockers.items[0].unmet_prerequisites[0].reason = "Invented reason"; },
    () => { result.blockers.items.length = 0; },
  ]) {
    try { mutate(); } catch (error) { assert.ok(error instanceof TypeError, "frozen results may reject mutation"); }
  }
  assert.deepEqual(readOnlyAvailability(f), original);
  assert.equal(f.prepared.catalog.find((deck) => deck.id === catalogId("alpha")).cards[0].term, PARENT_TERM);
});
