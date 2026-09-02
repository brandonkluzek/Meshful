import assert from "node:assert/strict";
import test from "node:test";

import { CATALOG } from "../data/catalog.js";
import { createMemoryStorage, createStudyStore } from "../js/store.js";

const NOW = "2026-09-02T12:00:00.000Z";

function makeStore() {
  return createStudyStore({
    catalog: CATALOG,
    storage: createMemoryStorage(),
    clock: () => new Date(NOW),
  });
}

function collectCardPages(store, args) {
  const cards = [];
  let cursor;
  do {
    const page = store.inspectDeck({ ...args, cursor, limit: 3 });
    cards.push(...page.cards);
    cursor = page.next_cursor;
  } while (cursor);
  return cards;
}

function completeCurrentSession(store, sessionId, actionPrefix) {
  const reviewedIds = [];
  while (true) {
    const inspected = store.inspectStudySession({ session_id: sessionId });
    if (inspected.session.status === "completed") return reviewedIds;

    assert.equal(inspected.session.phase, "awaiting_answer");
    assert.deepEqual(Object.keys(inspected.current_card).sort(), ["id", "term"]);
    const cardId = inspected.current_card.id;
    const captured = store.captureAnswer({
      session_id: sessionId,
      card_id: cardId,
      answer: `Representative recall for ${inspected.current_card.term}`,
      expected_session_revision: inspected.session.revision,
      client_action_id: `${actionPrefix}-capture-${cardId}`,
    });
    const preview = store.previewReview({
      session_id: sessionId,
      card_id: cardId,
      capture_id: captured.capture_id,
      assessment: {
        verdict: "correct",
        confidence: 0.9,
        feedback: "Representative correct review for the public-example path.",
        misconceptions: [],
      },
    });
    store.applyReview({
      review_token: preview.review_token,
      expected_session_revision: preview.session_revision,
      client_action_id: `${actionPrefix}-apply-${cardId}`,
    });
    reviewedIds.push(cardId);
  }
}

test("the public catalog has three stable examples and 18 ordered cards", () => {
  assert.equal(CATALOG.length, 3);
  assert.equal(CATALOG.reduce((total, deck) => total + deck.cards.length, 0), 18);
  assert.deepEqual(CATALOG.map((deck) => deck.id), [
    "linear-algebra-i",
    "introductory-mechanics",
    "software-engineering-foundations",
  ]);
});

test("every example preview paginates through its complete ordered card list", () => {
  const store = makeStore();
  for (const deck of CATALOG) {
    const cards = collectCardPages(store, { scope: "library", deck_id: deck.id, view: "cards" });
    assert.deepEqual(cards.map((card) => card.id), deck.cards.map((card) => card.id));
    assert.deepEqual(cards.map((card) => card.definition), deck.cards.map((card) => card.definition));
  }
});

for (const catalogDeck of CATALOG) {
  test(`${catalogDeck.title} completes install, collection, graph, and study paths`, () => {
    const store = makeStore();
    const installArgs = {
      library_deck_id: catalogDeck.id,
      expected_catalog_version: catalogDeck.version,
      client_action_id: `install-${catalogDeck.id}`,
    };
    const installed = store.addLibraryDeck(installArgs);
    assert.equal(installed.already_installed, false);
    assert.equal(installed.deck.source.catalogDeckId, catalogDeck.id);
    assert.deepEqual(store.addLibraryDeck(installArgs), installed);

    const personal = store.getDeck({ scope: "personal", deck_id: installed.deck.id });
    assert.deepEqual(
      personal.deck.cards.map((card) => card.card_id),
      catalogDeck.cards.map((card) => `${installed.deck.id}.${card.id}`),
    );
    assert.equal(personal.prerequisite_edge_count, catalogDeck.cards.reduce((sum, card) => sum + card.prerequisites.length, 0));

    const session = store.startStudySession({
      deck_id: installed.deck.id,
      limit: catalogDeck.cards.length,
      idempotency_key: `start-${catalogDeck.id}`,
    });
    const reviewedIds = completeCurrentSession(store, session.session.session_id, catalogDeck.id);
    assert.ok(reviewedIds.length >= 1);
    assert.ok(reviewedIds.length <= catalogDeck.cards.length);
  });
}
