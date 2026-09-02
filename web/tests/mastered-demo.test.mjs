import test from "node:test";
import assert from "node:assert/strict";
import { CATALOG } from "../data/catalog.js";
import { createMemoryStorage, createStudyStore, learnednessForReview } from "../js/store.js";
import { isDeckFullyMastered } from "../js/mastery.js";

const NOW = "2026-08-30T12:00:00.000Z";
const SAMPLE_ID = "deck-introductory-mechanics";
const storageKey = "adaptive-study-lab:web-state:v1";
const makeStore = (storage = createMemoryStorage(), catalog = CATALOG) =>
  createStudyStore({ catalog, storage, clock: () => new Date(NOW) });

function install(store, id) {
  const entry = CATALOG.find((deck) => deck.id === id);
  return store.addLibraryDeck({
    library_deck_id: id,
    expected_catalog_version: entry.version,
    client_action_id: `install:${id}`,
  }).deck.id;
}

function seedPrimary(store) {
  const id = install(store, "linear-algebra-i");
  store.seedDemoState(id);
  return id;
}

test("mastered sample persists beside the unchanged active Linear Algebra course", () => {
  const storage = createMemoryStorage();
  const store = makeStore(storage);
  const primaryId = seedPrimary(store);
  store.startStudySession({ deck_id: primaryId, limit: 12, idempotency_key: "keep-current-session" });
  const before = store.getSnapshot();
  const result = store.seedMasteredDemoDeck();
  const after = store.getSnapshot();
  assert.equal(result.added, true);
  assert.equal(result.demo_state, true);
  assert.equal(Object.keys(after.personalDecks).length, 2);
  assert.deepEqual(after.personalDecks[primaryId], before.personalDecks[primaryId]);
  for (const field of ["sessions", "activeSessionId", "view", "streak"]) {
    assert.deepEqual(after[field], before[field], `${field} stays unchanged`);
  }
  assert.deepEqual(after.activity.slice(0, before.activity.length), before.activity);
  assert.equal(after.activity.at(-1).type, "demo_deck_seeded");
  const sample = after.personalDecks[SAMPLE_ID];
  assert.equal(sample.title, "Introductory Mechanics");
  assert.equal(sample.archived, false);
  assert.equal(sample.cardOrder.length, 12);
  const cards = Object.values(sample.cards);
  const mastery = Math.round(cards.reduce((sum, card) => sum + learnednessForReview(card.review), 0) / cards.length * 100);
  assert.equal(isDeckFullyMastered({ total: cards.length, newCount: 0, mastery }), true);
  assert.ok(cards.every((card) => card.review.demoSeeded && card.review.repetitions > 0));
  assert.ok(cards.every((card) => new Date(card.review.dueAt) > new Date(NOW)));
  assert.ok(cards.every((card) => card.reviewHistory.length === 0), "fixture seed does not fabricate learner answers");
  assert.deepEqual(makeStore(storage).getSnapshot(), after);
});

test("adding the mastered sample preserves an already full activity history", () => {
  const storage = createMemoryStorage();
  seedPrimary(makeStore(storage));
  const persisted = JSON.parse(storage.getItem(storageKey));
  persisted.activity = Array.from({ length: 200 }, (_, index) => ({
    type: "existing_activity",
    sequence: index,
    at: NOW,
  }));
  storage.setItem(storageKey, JSON.stringify(persisted));
  const store = makeStore(storage);
  const before = store.getSnapshot();
  assert.equal(store.seedMasteredDemoDeck().added, true);
  assert.deepEqual(store.getSnapshot().activity, before.activity);
  assert.deepEqual(makeStore(storage).getSnapshot().activity, before.activity);
});

test("reloading and removing the mastered sample never reseed or restore it", () => {
  const storage = createMemoryStorage();
  const store = makeStore(storage);
  seedPrimary(store);
  store.seedMasteredDemoDeck();
  const seeded = storage.getItem(storageKey);
  assert.equal(store.seedMasteredDemoDeck().added, false);
  assert.equal(storage.getItem(storageKey), seeded);
  const reloaded = makeStore(storage);
  assert.equal(reloaded.seedMasteredDemoDeck().added, false);
  assert.equal(storage.getItem(storageKey), seeded);
  reloaded.setDeckArchived({
    deck_id: SAMPLE_ID,
    archived: true,
    expected_revision: reloaded.getSnapshot().personalDecks[SAMPLE_ID].revision,
    client_action_id: "remove-completed-sample",
  });
  const removed = storage.getItem(storageKey);
  assert.equal(makeStore(storage).seedMasteredDemoDeck().added, false);
  assert.equal(storage.getItem(storageKey), removed);
  assert.equal(makeStore(storage).getSnapshot().personalDecks[SAMPLE_ID].archived, true);
});

test("existing courses and non-demo workspaces are never given invented progress", () => {
  const unseeded = makeStore();
  install(unseeded, "linear-algebra-i");
  const unseededBefore = unseeded.getSnapshot();
  assert.equal(unseeded.seedMasteredDemoDeck().added, false);
  assert.deepEqual(unseeded.getSnapshot(), unseededBefore);

  const existing = makeStore();
  seedPrimary(existing);
  install(existing, "introductory-mechanics");
  const existingBefore = existing.getSnapshot();
  assert.equal(existing.seedMasteredDemoDeck().added, false);
  assert.deepEqual(existing.getSnapshot(), existingBefore);
  assert.ok(Object.values(existingBefore.personalDecks[SAMPLE_ID].cards).every((card) => card.review.repetitions === 0));

  const missing = makeStore(createMemoryStorage(), CATALOG.filter((deck) => deck.id !== "introductory-mechanics"));
  seedPrimary(missing);
  const missingBefore = missing.getSnapshot();
  assert.equal(missing.seedMasteredDemoDeck().added, false);
  assert.deepEqual(missing.getSnapshot(), missingBefore);
});

test("failed sample persistence rolls back without changing the current course or session", () => {
  const memory = createMemoryStorage();
  let rejectWrite = false;
  const storage = {
    getItem: (key) => memory.getItem(key),
    removeItem: (key) => memory.removeItem(key),
    setItem: (key, value) => {
      if (rejectWrite) throw new Error("quota exceeded");
      memory.setItem(key, value);
    },
  };
  const store = makeStore(storage);
  const primaryId = seedPrimary(store);
  store.startStudySession({ deck_id: primaryId, limit: 2, idempotency_key: "preserve-during-quota-failure" });
  const before = store.getSnapshot();
  const bytes = memory.getItem(storageKey);
  rejectWrite = true;
  assert.throws(() => store.seedMasteredDemoDeck(), /quota exceeded/);
  assert.equal(memory.getItem(storageKey), bytes);
  assert.deepEqual(store.getSnapshot(), before);
  rejectWrite = false;
  assert.equal(store.seedMasteredDemoDeck().added, true);
  assert.deepEqual(makeStore(storage).getSnapshot().sessions, before.sessions);
});
