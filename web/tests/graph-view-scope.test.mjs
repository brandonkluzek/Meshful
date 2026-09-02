import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { CATALOG } from "../data/catalog.js";
import { buildGraphIndex } from "../js/graph-scope.js";
import {
  graphNodeLimitForWidth,
  graphPinStorageKey,
  graphProjectionForDeck,
  graphScopeCopy,
  layoutForGraphProjection,
  resolveGraphSearch,
} from "../js/graph-view.js";

function chainDeck({ version = "v1" } = {}) {
  const cards = Array.from({ length: 8 }, (_, index) => ({
    id: `n${index}`,
    term: `Node ${index}`,
    moduleId: index < 4 ? "first" : "second",
  }));
  cards.push({ id: "isolated", term: "Isolated", moduleId: "other" });
  return {
    id: "chain",
    version,
    modules: [
      { id: "first", title: "First module", order: 0 },
      { id: "second", title: "Second module", order: 1 },
      { id: "other", title: "Other module", order: 2 },
    ],
    cards,
    edges: Array.from({ length: 7 }, (_, index) => ({
      id: `authored-${index}-${index + 1}`,
      source: `n${index}`,
      target: `n${index + 1}`,
      evidence: "authored",
    })),
  };
}

function largeChainDeck() {
  const cards = Array.from({ length: 36 }, (_, index) => ({
    id: `n${index}`,
    term: `Node ${index}`,
    moduleId: index < 12 ? "first" : index < 24 ? "middle" : "last",
  }));
  return {
    id: "large-chain",
    version: "v1",
    modules: [
      { id: "first", title: "First module", order: 0 },
      { id: "middle", title: "Middle module", order: 1 },
      { id: "last", title: "Last module", order: 2 },
    ],
    cards,
    edges: Array.from({ length: 35 }, (_, index) => ({
      id: `authored-${index}-${index + 1}`,
      source: `n${index}`,
      target: `n${index + 1}`,
      evidence: "authored",
    })),
  };
}

test("large deck graph defaults to a bounded real-relation projection", () => {
  const deck = largeChainDeck();
  const projection = graphProjectionForDeck(deck);

  assert.notEqual(projection.kind, "full");
  assert.ok(projection.nodeIds.length <= 24);
  assert.ok(projection.nodeIds.length < deck.cards.length);
  const visible = new Set(projection.nodeIds);
  for (const edge of projection.edges) {
    assert.ok(visible.has(edge.source));
    assert.ok(visible.has(edge.target));
  }
});

test("focused large deck graph selects the focused term's bounded module", () => {
  const deck = largeChainDeck();
  const projection = graphProjectionForDeck(deck, { focusCardId: "n20" });

  assert.equal(projection.kind, "module");
  assert.equal(projection.scope.moduleId, "middle");
  assert.ok(projection.nodeIds.includes("n20"));
});

test("viewport limits keep narrow graphs bounded without shrinking node geometry", () => {
  assert.equal(graphNodeLimitForWidth(390), 10);
  assert.equal(graphNodeLimitForWidth(720), 10);
  assert.equal(graphNodeLimitForWidth(721), 18);
  assert.equal(graphNodeLimitForWidth(980), 18);
  assert.equal(graphNodeLimitForWidth(1_075), 24);
  assert.equal(graphNodeLimitForWidth(0), 24);
});

test("projection layout renders authored explicit edges without card prerequisites", () => {
  const deck = chainDeck();
  const projection = graphProjectionForDeck(deck, { nodeLimit: 20 });
  const layout = layoutForGraphProjection(projection);

  assert.deepEqual(
    layout.edges.map((edge) => edge.id),
    deck.edges.map((edge) => edge.id),
  );
  assert.ok(layout.edges.every((edge) => edge.evidence === "authored"));
});

test("global search opens a term outside the initial module", () => {
  const index = buildGraphIndex(chainDeck());
  const initial = graphProjectionForDeck(chainDeck(), { nodeLimit: 4 });
  assert.ok(!initial.nodeIds.includes("n6"));

  const result = resolveGraphSearch(index, {
    query: "Node 6",
    nodeLimit: 4,
  });

  assert.equal(result.status, "focus");
  assert.equal(result.match.id, "n6");
  assert.equal(result.projection.kind, "module");
  assert.equal(result.projection.scope.moduleId, "second");
  assert.ok(result.projection.nodeIds.includes("n6"));
});

test("graph search treats punctuation and spacing as equivalent", () => {
  const deck = CATALOG.find((candidate) => candidate.id === "software-engineering-foundations");
  const result = resolveGraphSearch(buildGraphIndex(deck), {
    query: "topological-sort",
    nodeLimit: 24,
  });

  assert.equal(result.status, "focus");
  assert.equal(result.match.id, "se-topological-sort");
  assert.ok(result.projection.nodeIds.includes("se-topological-sort"));
});

test("selected-term search preserves an exact path beyond the ordinary node cap", () => {
  const index = buildGraphIndex(chainDeck());
  const result = resolveGraphSearch(index, {
    query: "Node 5",
    selectedId: "n0",
    nodeLimit: 4,
    contextDepth: 1,
  });

  assert.equal(result.status, "path");
  assert.equal(result.direction, "forward");
  assert.equal(result.projection.kind, "path");
  assert.deepEqual(result.projection.path.nodeIds, ["n0", "n1", "n2", "n3", "n4", "n5"]);
  assert.deepEqual(result.projection.path.edgeIds, [
    "authored-0-1",
    "authored-1-2",
    "authored-2-3",
    "authored-3-4",
    "authored-4-5",
  ]);
  assert.ok(result.projection.nodeIds.length >= result.projection.path.nodeIds.length);
  assert.ok(result.projection.path.nodeIds.every((id) => result.projection.nodeIds.includes(id)));
});

test("selected-term search resolves a dependency in the reverse direction", () => {
  const index = buildGraphIndex(chainDeck());
  const result = resolveGraphSearch(index, {
    query: "Node 0",
    selectedId: "n5",
    nodeLimit: 4,
    contextDepth: 0,
  });

  assert.equal(result.status, "path");
  assert.equal(result.direction, "reverse");
  assert.deepEqual(result.projection.path.nodeIds, ["n0", "n1", "n2", "n3", "n4", "n5"]);
  assert.equal(result.projection.truncated, false);
});

test("no-path search moves to the matched scope and reports the boundary honestly", () => {
  const index = buildGraphIndex(chainDeck());
  const result = resolveGraphSearch(index, {
    query: "Isolated",
    selectedId: "n0",
    nodeLimit: 4,
  });

  assert.equal(result.status, "no_path");
  assert.equal(result.match.id, "isolated");
  assert.ok(result.projection.nodeIds.includes("isolated"));
  assert.match(graphScopeCopy(result.projection, index), /^Showing \d+ of 9 terms/);
});

test("pin keys separate deck revisions and dynamic graph scopes", () => {
  const firstDeck = chainDeck({ version: "v1" });
  const secondDeck = chainDeck({ version: "v2" });
  const index = buildGraphIndex(firstDeck);
  const firstModule = graphProjectionForDeck(firstDeck, { nodeLimit: 4 });
  const secondModule = resolveGraphSearch(index, {
    query: "Node 6",
    nodeLimit: 4,
  }).projection;

  const firstKey = graphPinStorageKey(firstDeck, firstModule);
  assert.notEqual(firstKey, graphPinStorageKey(firstDeck, secondModule));
  assert.notEqual(firstKey, graphPinStorageKey(secondDeck, firstModule));
  assert.match(firstKey, /^adaptive-study\.graph-pins\.v2\./);
});

test("learning and recency render simultaneously without a graph-layer toggle", async () => {
  const source = await readFile(new URL("../js/graph-view.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /data-graph-mode/);
  assert.match(source, /button\.dataset\.learning = state\.learning/);
  assert.match(source, /button\.dataset\.freshness = state\.freshness/);
  assert.match(source, /class="node-recency"/);
  assert.match(source, /Border: learning/);
  assert.match(source, /Dot: recency/);
});
