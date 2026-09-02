import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStorage, createStudyStore } from "../js/store.js";

const NOW = "2026-08-30T12:00:00.000Z";

function card(id, prerequisites = []) {
  return {
    id, term: id, definition: `Definition of ${id}.`,
    required_concepts: ["State the definition."], prerequisite_ids: prerequisites,
  };
}

function rawDeck(id, cards) {
  return { id, title: id, version: "1", cards };
}

function install(store, libraryId, key = libraryId) {
  return store.addLibraryDeck({
    library_deck_id: libraryId, expected_catalog_version: "1", client_action_id: `install:${key}`,
  });
}

function start(store, deckId, key, limit = 20) {
  return store.startStudySession({ deck_id: deckId, limit, idempotency_key: `start:${key}` });
}

function grade(store, started, rating, key) {
  const current = started.current_card;
  return store.submitGrade({
    session_id: started.session.session_id,
    card_id: current.card_id,
    expected_card_revision: current.card_revision,
    expected_session_revision: started.session.session_revision,
    answer_text: "Synthetic recall attempt.", answer_origin: "chat", rating,
    rubric_evidence: current.required_concepts.map(item => ({
      rubric_item_id: item.rubric_item_id, status: "met", note: "Synthetic mechanics test.",
    })),
    feedback: "Synthetic scheduling evidence, not a semantic grading evaluation.",
    misconceptions: [], confidence: 1, idempotency_key: `grade:${key}`,
  });
}

function update(store, deckId, cardId, patch, key) {
  return store.updateCards({
    deck_id: deckId,
    expected_deck_revision: store.getDeck({ scope: "personal", deck_id: deckId }).deck.deck_revision,
    updates: [{ card_id: cardId, patch }], idempotency_key: `update:${key}`,
  });
}

function archive(store, deckId, key) {
  return store.setDeckArchived({
    deck_id: deckId, archived: true,
    expected_revision: store.getDeck({ scope: "personal", deck_id: deckId }).deck.deck_revision,
    client_action_id: `archive:${key}`,
  });
}

function unchangedAfter(store, storage, fn, code) {
  const snapshot = store.getSnapshot();
  const bytes = storage.dump();
  assert.throws(fn, error => error.code === code);
  assert.deepEqual(storage.dump(), bytes);
  assert.deepEqual(store.getSnapshot(), snapshot);
}

function externalFixture({ unrelatedFirst = false } = {}) {
  let instant = NOW;
  const catalog = [
    rawDeck("parent", [card("root")]),
    rawDeck("child", [
      ...(unrelatedFirst ? [card("independent")] : []),
      card("dependent", ["deck-parent.root"]),
    ]),
  ];
  const storage = createMemoryStorage();
  const store = createStudyStore({ catalog, storage, clock: () => instant });
  const parent = install(store, "parent").deck.id;
  const child = install(store, "child").deck.id;
  return { store, storage, catalog, parent, child, advance(at) { instant = at; }, clock: () => instant };
}

test("missing external parents remain required instead of creating accidental roots", () => {
  const store = createStudyStore({
    catalog: [rawDeck("child", [card("child.dependent", ["parent.base"])])],
    storage: createMemoryStorage(), clock: () => NOW,
  });
  const installed = install(store, "child");
  assert.equal(store.getLearningOverview().new_available_total, 0);
  const session = start(store, installed.deck.id, "missing-parent");
  assert.equal(session.session.status, "completed");
  assert.equal(session.current_card, undefined);
});

for (const rating of ["again", "hard"]) {
  test(`${rating}-only prerequisite evidence does not unlock a never-introduced child`, () => {
    const store = createStudyStore({
      catalog: [rawDeck("local", [card("parent"), card("child", ["parent"])])],
      storage: createMemoryStorage(), clock: () => NOW,
    });
    const installed = install(store, "local");
    const attempt = start(store, installed.deck.id, rating, 1);
    grade(store, attempt, rating, rating);
    assert.equal(store.getLearningOverview().new_available_total, 0);
    const next = start(store, installed.deck.id, `${rating}:after`);
    assert.equal(next.current_card, undefined);
  });
}

for (const rating of ["good", "easy"]) {
  test(`prior ${rating} recall unlocks required external cards without a whole-course completion proxy`, () => {
    const { store, parent, child } = externalFixture();
    grade(store, start(store, parent, rating, 1), rating, rating);
    const next = start(store, child, `${rating}:child`);
    assert.equal(next.current_card.card_id, `${child}.dependent`);
  });
}

test("historical Good survives a later Again, reload, and non-material edits but not a changed grading target", () => {
  const fixture = externalFixture();
  const { store, parent, child, storage, catalog } = fixture;
  grade(store, start(store, parent, "initial", 1), "good", "initial");
  update(store, parent, "root", { tags: ["metadata-only"] }, "tag");
  fixture.advance("2026-09-30T12:00:00.000Z");
  grade(store, start(store, parent, "later", 1), "again", "later");
  const reloaded = createStudyStore({ catalog, storage, clock: fixture.clock });
  assert.equal(reloaded.getLearningOverview().new_available_total, 1);
  update(reloaded, parent, "root", { definition_md: "A materially corrected definition." }, "corrected");
  assert.equal(reloaded.getLearningOverview().new_available_total, 1, "only the corrected parent is now available");
  assert.equal(start(reloaded, child, "blocked-after-edit").current_card, undefined);
  grade(reloaded, start(reloaded, parent, "hard-after-edit", 1), "hard", "hard-after-edit");
  assert.equal(start(reloaded, child, "still-blocked").current_card, undefined);
  fixture.advance("2026-10-30T12:00:00.000Z");
  grade(reloaded, start(reloaded, parent, "good-after-edit", 1), "good", "good-after-edit");
  assert.equal(start(reloaded, child, "unblocked-again").current_card.card_id, `${child}.dependent`);
});

test("a never-reviewed current card is rejected after a required parent's material edit, without a grade or receipt", () => {
  const { store, storage, parent, child } = externalFixture();
  grade(store, start(store, parent, "parent", 1), "good", "parent");
  const current = start(store, child, "child");
  update(store, parent, "root", { definition_md: "New parent recall target." }, "change-parent");
  unchangedAfter(store, storage, () => store.getStudySession({ session_id: current.session.session_id }), "PREREQUISITE_NOT_SATISFIED");
  unchangedAfter(store, storage, () => grade(store, current, "good", "stale-child"), "PREREQUISITE_NOT_SATISFIED");
  assert.equal(store.getSnapshot().personalDecks[child].cards.dependent.review.repetitions, 0);
});

test("a paused new card cannot resume after a parent is archived; ending the session is still available", () => {
  const { store, storage, parent, child } = externalFixture();
  grade(store, start(store, parent, "parent", 1), "good", "parent");
  const current = start(store, child, "child");
  store.finishStudySession({
    session_id: current.session.session_id, disposition: "pause",
    expected_session_revision: current.session.session_revision, idempotency_key: "pause:child",
  });
  archive(store, parent, "parent");
  const snapshot = store.getSnapshot();
  unchangedAfter(store, storage, () => start(store, child, "resume"), "PREREQUISITE_NOT_SATISFIED");
  const result = store.finishStudySession({
    session_id: current.session.session_id, disposition: "end",
    expected_session_revision: snapshot.sessions[current.session.session_id].revision, idempotency_key: "end:blocked-child",
  });
  assert.equal(result.status, "finished");
});

test("a valid current grade commits once while a newly blocked next card is deferred", () => {
  const { store, storage, parent, child } = externalFixture({ unrelatedFirst: true });
  grade(store, start(store, parent, "parent", 1), "good", "parent");
  const current = start(store, child, "child", 2);
  assert.equal(current.current_card.card_id, `${child}.independent`);
  archive(store, parent, "parent");
  const result = grade(store, current, "good", "first-only");
  assert.equal(result.session.status, "completed");
  assert.equal(result.next_card, undefined);
  assert.equal(result.reviewed_card.card_id, `${child}.independent`);
  const snapshot = store.getSnapshot();
  const bytes = storage.dump();
  const replayed = grade(store, current, "good", "first-only");
  assert.equal(replayed.review_id, result.review_id);
  assert.deepEqual(storage.dump(), bytes);
  assert.deepEqual(store.getSnapshot(), snapshot);
  assert.equal(snapshot.personalDecks[child].cards.independent.review.repetitions, 1);
  assert.equal(snapshot.personalDecks[child].cards.dependent.review.repetitions, 0);
});

test("an actually reviewed child never relocks after a parent archive, including after reload", () => {
  const fixture = externalFixture();
  const { store, storage, catalog, parent, child } = fixture;
  grade(store, start(store, parent, "parent", 1), "good", "parent");
  grade(store, start(store, child, "child", 1), "again", "child");
  archive(store, parent, "parent");
  fixture.advance("2026-10-01T12:00:00.000Z");
  const reloaded = createStudyStore({ catalog, storage, clock: fixture.clock });
  const next = start(reloaded, child, "review-introduced-child", 1);
  assert.equal(next.current_card.card_id, `${child}.dependent`);
  assert.equal(grade(reloaded, next, "good", "review-introduced-child").session.status, "completed");
});

test("legacy missing optional prompt remains compatible with existing catalog normalization", () => {
  const original = rawDeck("empty-prompt", [{ ...card("term"), prompt: "" }]);
  const store = createStudyStore({ catalog: [original], storage: createMemoryStorage(), clock: () => NOW });
  const deck = install(store, original.id).deck.id;
  assert.equal(store.getDeck({ scope: "personal", deck_id: deck }).deck.cards[0].prompt, null);
});
