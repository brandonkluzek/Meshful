import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryStorage, createStudyStore } from "../js/store.js";


test("catalog normalization derives compact stable edge IDs for long canonical card IDs", () => {
  const prerequisite = `course.${"prerequisite-".repeat(7)}concept`;
  const dependent = `course.${"dependent-".repeat(8)}concept`;
  assert.ok(prerequisite.length <= 128);
  assert.ok(dependent.length <= 128);
  assert.ok(`edge:${prerequisite}:${dependent}`.length > 128);

  const catalog = [{
    id: "course",
    title: "Course",
    version: "1.0.0",
    cards: [
      { id: prerequisite, term: "Prerequisite", definition: "The prerequisite concept." },
      {
        id: dependent,
        term: "Dependent",
        definition: "The dependent concept.",
        prerequisite_ids: [prerequisite],
      },
    ],
  }];

  const first = createStudyStore({ catalog, storage: createMemoryStorage() }).getCatalogSnapshot()[0];
  const second = createStudyStore({ catalog, storage: createMemoryStorage() }).getCatalogSnapshot()[0];

  assert.equal(first.edges.length, 1);
  assert.equal(first.edges[0].id, second.edges[0].id);
  assert.ok(first.edges[0].id.length <= 128);
  assert.equal(first.edges[0].prerequisiteCardId, prerequisite);
  assert.equal(first.edges[0].dependentCardId, dependent);
});


test("graph inspection can return a complete large course without a 200-card ceiling", () => {
  const cards = Array.from({ length: 439 }, (_, index) => ({
    id: `programming-i.card-${index + 1}`,
    term: `Card ${index + 1}`,
    definition: `Definition ${index + 1}`,
  }));
  const store = createStudyStore({
    catalog: [{ id: "programming-i", title: "Programming I", version: "1.0.0", cards }],
    storage: createMemoryStorage(),
  });
  const installed = store.addLibraryDeck({
    library_deck_id: "programming-i",
    expected_catalog_version: "1.0.0",
    client_action_id: "install-large-course",
  });

  const graph = store.inspectDeckGraph({
    deck_id: installed.deck.id,
    scope: "overview",
    limit: 1_000,
  });

  assert.equal(graph.truncated, false);
  assert.equal(graph.nodes.length, 439);
});
