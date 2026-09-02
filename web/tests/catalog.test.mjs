import assert from "node:assert/strict";
import test from "node:test";

import { CATALOG, catalogSummary, getCatalogDeck } from "../data/catalog.js";

const REQUIRED_TRUTH_LABELS = Object.freeze({
  provenance: "owner_commissioned_public_example",
  reviewStatus: "not_independently_reviewed",
  contentStatus: "original_public_example",
  licenseStatus: "cc0-1.0",
});

function assertAcyclic(deck) {
  const prerequisitesById = new Map(deck.cards.map((card) => [card.id, card.prerequisites]));
  const visiting = new Set();
  const visited = new Set();

  function visit(cardId) {
    if (visited.has(cardId)) return;
    assert.equal(visiting.has(cardId), false, `${deck.id} contains a cycle at ${cardId}`);
    visiting.add(cardId);
    for (const prerequisiteId of prerequisitesById.get(cardId)) visit(prerequisiteId);
    visiting.delete(cardId);
    visited.add(cardId);
  }

  for (const card of deck.cards) visit(card.id);
}

test("catalog contains the three approved public examples", () => {
  assert.deepEqual(
    CATALOG.map((deck) => [deck.id, deck.cardCount]),
    [
      ["linear-algebra-i", 4],
      ["introductory-mechanics", 12],
      ["software-engineering-foundations", 2],
    ],
  );
  assert.equal(CATALOG.reduce((total, deck) => total + deck.cardCount, 0), 18);
});

test("every example is complete, locally ordered, acyclic, and source-recorded", () => {
  const deckIds = CATALOG.map((deck) => deck.id);
  const cardIds = CATALOG.flatMap((deck) => deck.cards.map((card) => card.id));
  assert.equal(new Set(deckIds).size, deckIds.length);
  assert.equal(new Set(cardIds).size, cardIds.length);

  for (const deck of CATALOG) {
    const positionById = new Map(deck.cards.map((card, index) => [card.id, index]));
    for (const [index, card] of deck.cards.entries()) {
      assert.match(card.id, /^[a-z0-9]+(?:-[a-z0-9]+)+$/);
      assert.ok(card.term.trim());
      assert.ok(card.definition.length > 20);
      assert.ok(card.module.trim());
      assert.ok(card.sourceRefs.length > 0, `${deck.id}/${card.id} has a source ledger`);
      assert.ok(card.sourceRefs.every((url) => url.startsWith("https://")));
      for (const prerequisiteId of card.prerequisites) {
        assert.ok(positionById.has(prerequisiteId));
        assert.ok(positionById.get(prerequisiteId) < index);
      }
    }
    assertAcyclic(deck);
  }
});

test("every example carries final license and honest review labels", () => {
  for (const deck of CATALOG) {
    for (const [field, expected] of Object.entries(REQUIRED_TRUTH_LABELS)) {
      assert.equal(deck[field], expected, `${deck.id}.${field}`);
    }
    assert.equal(deck.version, "1.0.0-example");
    assert.equal(deck.curator, "Meshful public examples");
    assert.match(deck.updatedDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("catalog helpers return stable lookup and card-free summaries", () => {
  const deck = getCatalogDeck("introductory-mechanics");
  const summary = catalogSummary(deck);
  assert.equal(deck?.title, "Introductory Mechanics");
  assert.equal(getCatalogDeck("missing-deck"), null);
  assert.equal(catalogSummary("missing-deck"), null);
  assert.equal(summary.id, deck.id);
  assert.equal(summary.cardCount, deck.cards.length);
  assert.equal("cards" in summary, false);
  assert.equal(Object.isFrozen(summary), true);
});
