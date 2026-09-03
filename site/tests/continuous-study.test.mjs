import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CATALOG } from "../public/study/data/catalog.js";
import { createMemoryStorage, createStudyStore } from "../public/study/js/store.js";

const NOW = "2026-09-02T12:00:00.000Z";

function masteredDemoStore() {
  const store = createStudyStore({
    catalog: CATALOG,
    storage: createMemoryStorage(),
    clock: () => new Date(NOW),
  });
  const primary = CATALOG.find((deck) => deck.id === "linear-algebra-i");
  const added = store.addLibraryDeck({
    library_deck_id: primary.id,
    expected_catalog_version: primary.version,
    client_action_id: "continuous:add-primary",
  });
  store.seedDemoState(added.deck.id);
  return store;
}

test("a fully mastered future-due deck starts a continuous early-practice session", () => {
  const store = masteredDemoStore();
  const seeded = store.seedMasteredDemoDeck();
  const deckId = seeded.deck.id;
  const availability = store.getStudyAvailability({ deck_id: deckId }).decks[0];

  assert.equal(availability.due_count, 0);
  assert.equal(availability.eligible_new_count, 0);
  assert.equal(availability.practice_count, 12);
  assert.ok(new Date(availability.next_due_at) > new Date(NOW));

  const started = store.startStudySession({
    deck_id: deckId,
    limit: 12,
    idempotency_key: "continuous:start-mastered",
  });
  assert.equal(started.session.status, "active");
  assert.equal(started.session.total, 12);
  assert.equal(started.session.due_segment_total, 0);
  assert.equal(started.session.queue_phase, "continuous");
  assert.equal(started.session.queue_phase_position, 1);
  assert.ok(started.current_card);

  const session = store.getSnapshot().sessions[started.session.session_id];
  assert.equal(session.mode, "continuous");
  assert.equal(session.queue.length, 12);
});

test("continuous progress keeps its due boundary across reload and resume", () => {
  const storage = createMemoryStorage();
  const store = createStudyStore({ catalog: CATALOG, storage, clock: () => new Date(NOW) });
  const primary = CATALOG.find((deck) => deck.id === "linear-algebra-i");
  const added = store.addLibraryDeck({
    library_deck_id: primary.id,
    expected_catalog_version: primary.version,
    client_action_id: "continuous-boundary:add-primary",
  });
  store.seedDemoState(added.deck.id);
  const availability = store.getStudyAvailability({ deck_id: added.deck.id }).decks[0];
  const started = store.startStudySession({
    deck_id: added.deck.id,
    limit: 50,
    idempotency_key: "continuous-boundary:start",
  });

  assert.ok(started.session.due_segment_total > 0);
  assert.equal(started.session.due_segment_total, availability.due_count);
  assert.equal(started.session.queue_phase, "due");
  assert.equal(started.session.queue_phase_position, 1);

  const persistedEntries = Object.entries(storage.dump());
  assert.equal(persistedEntries.length, 1);
  const [storageKey, raw] = persistedEntries[0];
  const persisted = JSON.parse(raw);
  const persistedSession = persisted.sessions[started.session.session_id];
  persistedSession.cursor = persistedSession.dueSegmentCount;
  persistedSession.currentCardId = persistedSession.queue[persistedSession.cursor];
  storage.setItem(storageKey, JSON.stringify(persisted));

  const reloaded = createStudyStore({ catalog: CATALOG, storage, clock: () => new Date(NOW) });
  const atBoundary = reloaded.getStudySession({ session_id: started.session.session_id });
  assert.equal(atBoundary.session.due_segment_total, availability.due_count);
  assert.equal(atBoundary.session.queue_phase, "continuous");
  assert.equal(atBoundary.session.queue_phase_position, 1);

  const paused = reloaded.finishStudySession({
    session_id: started.session.session_id,
    disposition: "pause",
    expected_session_revision: atBoundary.session.session_revision,
    idempotency_key: "continuous-boundary:pause",
  });
  assert.equal(paused.status, "paused");
  const resumed = reloaded.startStudySession({
    deck_id: added.deck.id,
    idempotency_key: "continuous-boundary:resume",
  });
  assert.equal(resumed.session.due_segment_total, availability.due_count);
  assert.equal(resumed.session.queue_phase, "continuous");
  assert.equal(resumed.session.queue_phase_position, 1);
});

test("Study UI removes the scheduled-queue dead end", async () => {
  const [app, webmcp] = await Promise.all([
    readFile(new URL("../public/study/js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/study/js/webmcp.js", import.meta.url), "utf8"),
  ]);

  assert.match(app, /availability\.practice_count \?\? 0/);
  assert.match(app, /available for extra practice/);
  assert.match(app, /"Start studying"/);
  assert.match(app, /Continue studying/);
  assert.doesNotMatch(app, /View study status|Check availability/);
  assert.match(app, /date\.getFullYear\(\) === current\.getFullYear\(\)/);
  assert.match(webmcp, /continuous queue/);
  assert.match(webmcp, /early practice by nearest due date/);
});
