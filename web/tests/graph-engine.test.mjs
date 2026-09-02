import test from "node:test";
import assert from "node:assert/strict";

import {
  GraphValidationError,
  clampTransform,
  countEdgeCrossings,
  findEdgeNodeIntersections,
  findEdgeSegmentOverlaps,
  findNodeCollisions,
  fitTransform,
  focusSubgraph,
  hasNodeCollisions,
  layoutGraph,
  readableFitTransform,
  reroutePinnedLayout,
  semanticZoomLevel,
  traceDownstream,
  traceUpstream,
} from "../js/graph-engine.js";
import { CATALOG } from "../data/catalog.js";

const representativeCards = [
  { id: "scalar", term: "Scalar", prerequisites: [] },
  { id: "vector", term: "Vector", prerequisites: [] },
  {
    id: "linear-independence",
    term: "Linear independence",
    prerequisites: ["vector"],
  },
  {
    id: "span",
    term: "Span",
    prerequisites: ["vector", "scalar"],
  },
  {
    id: "basis",
    term: "Basis",
    prerequisites: ["span", "linear-independence"],
  },
  {
    id: "linear-map",
    term: "Linear map",
    prerequisites: ["vector", "scalar"],
  },
  {
    id: "coordinates",
    term: "Coordinates",
    prerequisites: ["basis"],
  },
  {
    id: "matrix",
    term: "Matrix representation",
    prerequisites: ["basis", "linear-map"],
  },
  {
    id: "eigenvalue",
    term: "Eigenvalue",
    prerequisites: ["matrix"],
  },
  {
    id: "diagonalization",
    term: "Diagonalization",
    prerequisites: ["basis", "eigenvalue"],
  },
];

const largeExampleCards = Array.from({ length: 30 }, (_, index) => ({
  id: `large-${index}`,
  term: `Large example ${index}`,
  prerequisites: index === 0 ? [] : [`large-${index - 1}`],
}));

function nodeMap(layout) {
  return new Map(layout.nodes.map((node) => [node.id, node]));
}

function segmentPassesThroughNodeInterior(start, end, node) {
  for (let step = 1; step < 100; step += 1) {
    const ratio = step / 100;
    const x = start.x + (end.x - start.x) * ratio;
    const y = start.y + (end.y - start.y) * ratio;
    if (x > node.x && x < node.x + node.width && y > node.y && y < node.y + node.height) {
      return true;
    }
  }
  return false;
}

function assertRoutesAvoidOtherNodes(layout) {
  for (const edge of layout.edges) {
    for (let index = 1; index < edge.points.length; index += 1) {
      for (const node of layout.nodes) {
        if (node.id === edge.source || node.id === edge.target) continue;
        assert.equal(
          segmentPassesThroughNodeInterior(edge.points[index - 1], edge.points[index], node),
          false,
          `${edge.id} must avoid ${node.id} and its term label`,
        );
      }
    }
  }
}

test("layout is deterministic even when cards and prerequisites are reordered", () => {
  const first = layoutGraph(representativeCards);
  const second = layoutGraph(
    [...representativeCards]
      .reverse()
      .map((card) => ({ ...card, prerequisites: [...card.prerequisites].reverse() })),
  );

  assert.deepEqual(second, first);
  assert.deepEqual(
    first.nodes.map(({ id, layer, order }) => ({ id, layer, order })),
    [
      { id: "scalar", layer: 0, order: 0 },
      { id: "vector", layer: 0, order: 1 },
      { id: "linear-map", layer: 1, order: 0 },
      { id: "span", layer: 1, order: 1 },
      { id: "linear-independence", layer: 1, order: 2 },
      { id: "basis", layer: 2, order: 0 },
      { id: "matrix", layer: 3, order: 0 },
      { id: "coordinates", layer: 3, order: 1 },
      { id: "eigenvalue", layer: 4, order: 0 },
      { id: "diagonalization", layer: 5, order: 0 },
    ],
  );
});

test("fixed-size nodes do not overlap and all edges point to a later layer", () => {
  const layout = layoutGraph(representativeCards);
  const nodes = nodeMap(layout);

  assert.equal(hasNodeCollisions(layout.nodes), false);
  assert.deepEqual(findNodeCollisions(layout.nodes), []);
  for (const node of layout.nodes) {
    assert.equal(node.width, 170);
    assert.equal(node.height, 58);
  }
  for (const edge of layout.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    assert.ok(source.layer < target.layer, `${edge.id} must point left-to-right`);
    assert.ok(source.x + source.width < target.x);
  }

  const minNodeX = Math.min(...layout.nodes.map((node) => node.x));
  const minNodeY = Math.min(...layout.nodes.map((node) => node.y));
  const maxNodeX = Math.max(...layout.nodes.map((node) => node.x + node.width));
  const maxNodeY = Math.max(...layout.nodes.map((node) => node.y + node.height));
  assert.ok(layout.bounds.minX < minNodeX);
  assert.ok(layout.bounds.minY < minNodeY);
  assert.ok(layout.bounds.maxX > maxNodeX);
  assert.ok(layout.bounds.maxY > maxNodeY);
});

test("readable routes use node-side anchors, avoid labels, and remain deterministic", () => {
  const layout = layoutGraph(representativeCards);
  const nodes = nodeMap(layout);
  const longEdge = layout.edges.find(
    (edge) => edge.source === "basis" && edge.target === "diagonalization",
  );
  assert.ok(longEdge, "representative graph should retain its far dependency");
  assert.ok(longEdge.points.length >= 2, "far dependencies retain a visible route");

  for (const edge of layout.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    const first = edge.points[0];
    const last = edge.points.at(-1);
    assert.equal(first.x, source.x + source.width);
    assert.equal(last.x, target.x);
    assert.match(edge.path, /^M /);
    assert.equal(typeof edge.lane, "number");

  }
  assertRoutesAvoidOtherNodes(layout);

  const again = layoutGraph(representativeCards);
  assert.deepEqual(
    again.edges.map(({ id, lane, points }) => ({ id, lane, points })),
    layout.edges.map(({ id, lane, points }) => ({ id, lane, points })),
  );
});

test("upstream and downstream traces distinguish direct from far dependencies", () => {
  const upstream = traceUpstream(representativeCards, "diagonalization");
  assert.deepEqual(upstream.nodeIds, [
    "basis",
    "diagonalization",
    "eigenvalue",
    "linear-independence",
    "linear-map",
    "matrix",
    "scalar",
    "span",
    "vector",
  ]);
  assert.equal(upstream.depths.diagonalization, 0);
  assert.equal(upstream.depths.vector, 3);

  const direct = traceUpstream(representativeCards, "diagonalization", {
    transitive: false,
  });
  assert.deepEqual(direct.nodeIds, ["basis", "diagonalization", "eigenvalue"]);
  assert.deepEqual(direct.edgeIds, [
    "basis->diagonalization",
    "eigenvalue->diagonalization",
  ]);

  const downstream = traceDownstream(representativeCards, "scalar", {
    includeSelf: false,
  });
  assert.ok(downstream.nodeIds.includes("diagonalization"));
  assert.equal(downstream.nodeIds.includes("scalar"), false);
});

test("focus subgraph applies independent upstream and downstream depth limits", () => {
  const focus = focusSubgraph(representativeCards, "basis", {
    upstreamDepth: 1,
    downstreamDepth: 1,
  });
  assert.deepEqual(focus.nodeIds, [
    "basis",
    "coordinates",
    "diagonalization",
    "linear-independence",
    "matrix",
    "span",
  ]);
  assert.ok(
    focus.edges.every(
      (edge) =>
        focus.nodeIds.includes(edge.source) && focus.nodeIds.includes(edge.target),
    ),
  );
});

test("missing endpoints and prerequisite cycles fail with structured errors", () => {
  assert.throws(
    () => layoutGraph([{ id: "dependent", prerequisites: ["missing"] }]),
    (error) =>
      error instanceof GraphValidationError &&
      error.code === "MISSING_ENDPOINT" &&
      error.details.missing[0] === "missing",
  );

  assert.throws(
    () =>
      layoutGraph([
        { id: "a", prerequisites: ["c"] },
        { id: "b", prerequisites: ["a"] },
        { id: "c", prerequisites: ["b"] },
      ]),
    (error) =>
      error instanceof GraphValidationError &&
      error.code === "CYCLE" &&
      error.details.nodeIds.join(",") === "a,b,c",
  );
});

test("semantic zoom, fit, clamp, and collision helpers are bounded", () => {
  assert.equal(semanticZoomLevel(0.37), "overview");
  assert.equal(semanticZoomLevel(0.4), "working");
  assert.equal(semanticZoomLevel(0.68), "working");
  assert.equal(semanticZoomLevel({ scale: 0.8 }), "working");
  assert.equal(semanticZoomLevel({ k: 1.4 }), "focus");

  const bounds = { x: -20, y: 10, width: 1000, height: 500 };
  const viewport = { x: 0, y: 0, width: 800, height: 600 };
  const fit = fitTransform(bounds, viewport, {
    padding: 40,
    minScale: 0.1,
    maxScale: 1,
  });
  assert.ok(fit.scale >= 0.1 && fit.scale <= 1);
  assert.ok(Number.isFinite(fit.x) && Number.isFinite(fit.y));

  const clamped = clampTransform(
    { x: -100_000, y: 100_000, scale: fit.scale },
    bounds,
    viewport,
  );
  assert.ok(clamped.x > -100_000);
  assert.ok(clamped.y < 100_000);

  assert.deepEqual(
    findNodeCollisions([
      { id: "a", x: 0, y: 0, width: 10, height: 10 },
      { id: "b", x: 5, y: 5, width: 10, height: 10 },
    ]),
    [{ a: "a", b: "b", overlapX: 5, overlapY: 5 }],
  );
});

test("the public example graphs have clear, non-overlapping routes", () => {
  for (const candidate of CATALOG) {
    const candidateLayout = layoutGraph(candidate.cards);
    assert.deepEqual(
      findEdgeSegmentOverlaps(candidateLayout.edges),
      [],
      `${candidate.id} must not share positive-length route segments`,
    );
    assert.deepEqual(
      findEdgeNodeIntersections(candidateLayout.edges, candidateLayout.nodes),
      [],
      `${candidate.id} routes must not pass through cards`,
    );
  }

  const deck = CATALOG.find((candidate) => candidate.id === "linear-algebra-i");
  const layout = layoutGraph(deck.cards);

  assert.equal(layout.nodes.length, deck.cards.length);
  assert.equal(
    layout.edges.length,
    deck.cards.reduce((total, card) => total + card.prerequisites.length, 0),
  );
  assert.deepEqual(findNodeCollisions(layout.nodes), []);
  assert.deepEqual(findEdgeSegmentOverlaps(layout.edges), []);
  assert.deepEqual(findEdgeNodeIntersections(layout.edges, layout.nodes), []);
  assertRoutesAvoidOtherNodes(layout);
  const crossings = countEdgeCrossings(layout.edges);
  assert.ok(Number.isInteger(crossings) && crossings >= 0);
  assert.ok(layout.bounds.width > 0 && layout.bounds.height > 0);

  const again = layoutGraph([...deck.cards].reverse());
  assert.deepEqual(again, layout);
});

test("readable fit uses a focused window instead of shrinking large-deck labels", () => {
  const layout = layoutGraph(largeExampleCards);
  const focus = layout.nodes.find((node) => node.id === "large-15");
  const transform = readableFitTransform(
    layout.bounds,
    { x: 0, y: 0, width: 1167, height: 926 },
    focus,
    {
      padding: { top: 90, right: 370, bottom: 70, left: 70 },
      minReadableScale: 0.78,
      maxScale: 1.05,
    },
  );

  assert.equal(transform.strategy, "readable-window");
  assert.equal(transform.fullGraphVisible, false);
  assert.ok(transform.scale >= 0.78);
  assert.ok(13 * transform.scale >= 10, "13px term labels remain visibly readable");

  const compact = readableFitTransform(
    { x: 0, y: 0, width: 400, height: 240 },
    { x: 0, y: 0, width: 900, height: 700 },
    { x: 120, y: 80, width: 176, height: 52 },
    { padding: 40, minReadableScale: 0.68, maxScale: 1.05 },
  );
  assert.equal(compact.strategy, "full-graph");
  assert.equal(compact.fullGraphVisible, true);
});

test("adversarial pinned cards reroute the complete graph without geometry regressions", () => {
  const deck = CATALOG.find((candidate) => candidate.id === "linear-algebra-i");
  const layout = layoutGraph(deck.cards);
  const byId = nodeMap(layout);
  for (const [nodeId, position] of [
    ["la-vector", { x: byId.get("la-vector").x, y: byId.get("la-vector").y - 280 }],
    ["la-scalar", { x: byId.get("la-scalar").x, y: byId.get("la-scalar").y + 280 }],
  ]) {
    const rerouted = reroutePinnedLayout(layout, new Map([[nodeId, position]]));
    assert.deepEqual(findEdgeSegmentOverlaps(rerouted.edges), []);
    assert.deepEqual(
      findEdgeNodeIntersections(rerouted.edges, rerouted.nodes),
      [],
    );
    assertRoutesAvoidOtherNodes(rerouted);
  }
});

test("valid DAG routing retries instead of failing on a greedy lane dead end", () => {
  const cards = [
    { id: "n0", prerequisites: [] },
    { id: "n1", prerequisites: ["n0"] },
    { id: "n2", prerequisites: ["n1"] },
    { id: "n3", prerequisites: ["n2"] },
    { id: "n4", prerequisites: ["n0", "n1", "n2"] },
    { id: "n5", prerequisites: ["n2"] },
  ];
  const layout = layoutGraph(cards);
  assert.equal(layout.nodes.length, 6);
  assert.deepEqual(findEdgeSegmentOverlaps(layout.edges), []);
  assert.deepEqual(findEdgeNodeIntersections(layout.edges, layout.nodes), []);
  assert.deepEqual(
    layoutGraph(
      [...cards]
        .reverse()
        .map((card) => ({ ...card, prerequisites: [...card.prerequisites].reverse() })),
    ),
    layout,
  );
});

test("crossing audit counts complementary bends as a rendered four-arm crossing", () => {
  const edges = [
    {
      id: "a",
      source: "a0",
      target: "a1",
      points: [{ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }],
    },
    {
      id: "b",
      source: "b0",
      target: "b1",
      points: [{ x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 10 }],
    },
  ];
  assert.equal(countEdgeCrossings(edges), 1);
});
