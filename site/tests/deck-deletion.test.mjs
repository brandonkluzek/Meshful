import assert from "node:assert/strict";
import test from "node:test";

import { CATALOG } from "../public/study/data/catalog.js";
import { createMemoryStorage, createStudyStore } from "../public/study/js/store.js";

const STORAGE_KEY = "adaptive-study-lab:web-state:v1";
const NOW = "2026-09-03T12:00:00.000Z";

function makeStore(storage = createMemoryStorage()) {
  return createStudyStore({
    catalog: CATALOG,
    storage,
    clock: () => new Date(NOW),
    timeZone: "America/Chicago",
  });
}

function install(store, actionId = "install") {
  const source = CATALOG.find((deck) => deck.id === "introductory-mechanics");
  return store.addLibraryDeck({
    library_deck_id: source.id,
    expected_catalog_version: source.version,
    client_action_id: actionId,
  }).deck;
}

function archive(store, deck, actionId = "archive") {
  return store.setDeckArchived({
    deck_id: deck.id,
    archived: true,
    expected_revision: deck.revision,
    client_action_id: actionId,
  }).deck;
}

function deletionArgs(store, deck, actionId = "delete") {
  const impact = store.getDeckDeletionImpact({ deck_id: deck.id });
  return {
    deck_id: deck.id,
    deck_instance_id: impact.deck_instance_id,
    expected_revision: impact.deck_revision,
    expected_app_revision: impact.app_revision,
    expected_impact_digest: impact.impact_digest,
    confirm_permanent_deletion: true,
    idempotency_key: actionId,
  };
}

test("archive stays reversible and deletion requires an archived exact instance", () => {
  const storage = createMemoryStorage();
  const store = makeStore(storage);
  const installed = install(store);
  const activeImpact = store.getDeckDeletionImpact({ deck_id: installed.id });
  assert.equal(activeImpact.can_delete, false);
  assert.equal(activeImpact.blocker, "DECK_NOT_ARCHIVED");
  assert.throws(() => store.deleteDeck({
    ...deletionArgs(store, installed),
    idempotency_key: "delete-active",
  }), (error) => error?.code === "DECK_NOT_ARCHIVED");

  const archived = archive(store, installed);
  const restored = store.setDeckArchived({
    deck_id: installed.id,
    archived: false,
    expected_revision: archived.revision,
    client_action_id: "restore",
  }).deck;
  assert.equal(restored.archived, false);
  const archivedAgain = archive(store, restored, "archive-again");
  const args = deletionArgs(store, archivedAgain);
  assert.throws(() => store.deleteDeck({
    ...args,
    deck_instance_id: "deck-instance-wrong",
    idempotency_key: "wrong-instance",
  }), (error) => error?.code === "DECK_INSTANCE_CHANGED");
  assert.ok(JSON.parse(storage.getItem(STORAGE_KEY)).personalDecks[installed.id]);
});

test("active-session archive fails without writes; paused-session deletion is explicit and complete", () => {
  const storage = createMemoryStorage();
  const store = makeStore(storage);
  const installed = install(store);
  const started = store.startStudySession({
    deck_id: installed.id,
    limit: 2,
    idempotency_key: "start",
  });
  const before = storage.getItem(STORAGE_KEY);
  assert.throws(() => archive(store, store.getSnapshot().personalDecks[installed.id]),
    (error) => error?.code === "DECK_IN_ACTIVE_SESSION");
  assert.equal(storage.getItem(STORAGE_KEY), before);

  store.finishStudySession({
    session_id: started.session.session_id,
    disposition: "pause",
    expected_session_revision: started.session.session_revision,
    idempotency_key: "pause",
  });
  const archived = archive(store, store.getSnapshot().personalDecks[installed.id]);
  const args = deletionArgs(store, archived);
  const deleted = store.deleteDeck(args);
  assert.equal(deleted.deleted_deck_instance_id, installed.deck_instance_id);
  assert.equal(store.getSnapshot().personalDecks[installed.id], undefined);
  assert.equal(store.getSnapshot().sessions[started.session.session_id], undefined);
  const saved = storage.getItem(STORAGE_KEY);
  const replay = store.deleteDeck(args);
  assert.deepEqual({ ...replay, receipt: { ...replay.receipt, replayed: false } }, deleted);
  assert.equal(replay.receipt.replayed, true);
  assert.equal(storage.getItem(STORAGE_KEY), saved, "an exact replay performs no second write");
  assert.equal(makeStore(storage).getSnapshot().personalDecks[installed.id], undefined);
});

test("same-id reinstall creates a new instance and a stale deletion cannot remove it", () => {
  const storage = createMemoryStorage();
  const store = makeStore(storage);
  const first = install(store, "first-install");
  const firstArchived = archive(store, first, "first-archive");
  const staleDelete = deletionArgs(store, firstArchived, "first-delete");
  store.deleteDeck(staleDelete);

  const second = install(store, "second-install");
  assert.equal(second.id, first.id);
  assert.notEqual(second.deck_instance_id, first.deck_instance_id);
  assert.deepEqual(store.deleteDeck(staleDelete).deleted_deck_instance_id, first.deck_instance_id);
  assert.equal(store.getSnapshot().personalDecks[second.id].deckInstanceId, second.deck_instance_id);
  assert.equal(store.searchLibrary({ query: "Introductory Mechanics", limit: 10 })
    .results.some((deck) => deck.id === "introductory-mechanics"), true,
  "deleting a personal installation never deletes the immutable Library catalog");
});

test("a persistence failure rolls deletion back in memory and storage", () => {
  const backing = createMemoryStorage();
  let failWrites = false;
  const storage = {
    getItem: (key) => backing.getItem(key),
    removeItem: (key) => backing.removeItem(key),
    setItem(key, value) {
      if (failWrites) throw new Error("quota failure");
      backing.setItem(key, value);
    },
  };
  const store = makeStore(storage);
  const archived = archive(store, install(store));
  const args = deletionArgs(store, archived);
  const before = backing.getItem(STORAGE_KEY);
  failWrites = true;
  assert.throws(() => store.deleteDeck(args), /quota failure/);
  assert.equal(backing.getItem(STORAGE_KEY), before);
  assert.ok(store.getSnapshot().personalDecks[archived.id]);
});
