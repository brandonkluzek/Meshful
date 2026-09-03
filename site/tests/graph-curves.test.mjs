import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  countEdgeCrossings,
  findEdgeNodeIntersections,
  findNodeCollisions,
  layoutGraph,
  rankColumnarity,
  semanticZoomLevel,
} from "../public/study/js/graph-engine.js";
import {
  graphNodeLimitForWidth,
  graphProjectionForDeck,
  layoutForGraphProjection,
} from "../public/study/js/graph-view.js";

async function reviewedCatalog() {
  const manifest = JSON.parse(await readFile("public/study/data/library-releases.json", "utf8"));
  const entry = manifest.releases.find((release) => release.version === "2026-08-30.reviewed-72.v1");
  assert.ok(entry, "the reviewed graph fixture remains retained");
  const release = JSON.parse(await readFile(`public/study/data/${entry.path}`, "utf8"));
  assert.ok(Array.isArray(release.catalog), "the reviewed graph fixture is a full catalog feed");
  return release.catalog;
}

function curvatureNumerator(edge, t) {
  const { start: p0, controlA: p1, controlB: p2, end: p3 } = edge;
  const inverse = 1 - t;
  const first = {
    x: 3 * inverse ** 2 * (p1.x - p0.x) + 6 * inverse * t * (p2.x - p1.x) + 3 * t ** 2 * (p3.x - p2.x),
    y: 3 * inverse ** 2 * (p1.y - p0.y) + 6 * inverse * t * (p2.y - p1.y) + 3 * t ** 2 * (p3.y - p2.y),
  };
  const second = {
    x: 6 * inverse * (p2.x - 2 * p1.x + p0.x) + 6 * t * (p3.x - 2 * p2.x + p1.x),
    y: 6 * inverse * (p2.y - 2 * p1.y + p0.y) + 6 * t * (p3.y - 2 * p2.y + p1.y),
  };
  return first.x * second.y - first.y * second.x;
}

test("semantic zoom hides labels only in the deep overview", () => {
  assert.equal(semanticZoomLevel(0.2), "overview");
  assert.equal(semanticZoomLevel(0.379), "overview");
  assert.equal(semanticZoomLevel(0.38), "working");
  assert.equal(semanticZoomLevel(1.12), "focus");
});

test("every connector is one gentle S-curve with one inflection and no orthogonal tail", () => {
  const layout = layoutGraph({
    nodes: [
      { id: "a", term: "A" },
      { id: "b", term: "B" },
      { id: "c", term: "C" },
    ],
    edges: [
      { id: "a-b", source: "a", target: "b" },
      { id: "a-c", source: "a", target: "c" },
    ],
  });
  for (const edge of layout.edges) {
    assert.match(edge.path, /^M [^QCL]+ C /);
    assert.equal((edge.path.match(/ C /g) ?? []).length, 1);
    assert.doesNotMatch(edge.path, / [QL] /);
    const baseline = {
      x: edge.end.x - edge.start.x,
      y: edge.end.y - edge.start.y,
    };
    const startTangent = {
      x: edge.controlA.x - edge.start.x,
      y: edge.controlA.y - edge.start.y,
    };
    const endTangent = {
      x: edge.end.x - edge.controlB.x,
      y: edge.end.y - edge.controlB.y,
    };
    const startCross = baseline.x * startTangent.y - baseline.y * startTangent.x;
    const endCross = baseline.x * endTangent.y - baseline.y * endTangent.x;
    assert.ok(Math.abs(startCross) > 1);
    assert.ok(Math.abs(endCross) > 1);
    assert.equal(Math.sign(startCross), Math.sign(endCross));
    const curvatureSigns = Array.from({ length: 99 }, (_, index) =>
      Math.sign(curvatureNumerator(edge, (index + 1) / 100)),
    ).filter(Boolean);
    const signChanges = curvatureSigns.slice(1).filter(
      (sign, index) => sign !== curvatureSigns[index],
    ).length;
    assert.equal(signChanges, 1);
    assert.ok(edge.length / edge.directDistance < 1.5);
  }
});

test("the complete local Linear Algebra release opens as a balanced full-deck graph", async () => {
  const catalog = await reviewedCatalog();
  const deck = catalog.find((candidate) => candidate.id === "academic-reviewed-v1:linear-algebra-i");
  assert.equal(deck.cards.length, 142);
  assert.equal(graphNodeLimitForWidth(390), 10_000);
  const projection = graphProjectionForDeck(deck, { nodeLimit: 1 });
  assert.equal(projection.kind, "full");
  assert.equal(projection.nodes.length, deck.cards.length);
  assert.ok(projection.nodes.some((card) => card.term === "Real inner product"));
  assert.ok(projection.nodes.some((card) => card.term === "Row-equivalence versus column-space diagnostic"));
  assert.ok(projection.nodes.some((card) => card.term === "LU and PLU factorization"));
  const narrowLayout = layoutForGraphProjection(projection, { viewportWidth: 818 });
  assert.equal(narrowLayout.nodes.length, 142);
  assert.equal(narrowLayout.edges.length, projection.edges.length);
  assert.deepEqual(findNodeCollisions(narrowLayout.nodes), []);
  assert.ok(narrowLayout.bounds.width <= 2_500);
  assert.ok(narrowLayout.bounds.height <= 2_100);
  assert.ok(narrowLayout.bounds.width / narrowLayout.bounds.height >= 0.7);
  assert.ok(narrowLayout.bounds.width / narrowLayout.bounds.height <= 1.7);
  const intersections = findEdgeNodeIntersections(narrowLayout.edges, narrowLayout.nodes);
  const intersectingPairs = new Set(intersections.map(({ edgeId, nodeId }) => `${edgeId}>${nodeId}`));
  assert.ok(intersectingPairs.size <= 350);
  assert.ok(countEdgeCrossings(narrowLayout.edges) <= 40);
  assert.ok(rankColumnarity(narrowLayout.nodes) <= 0.75);
});

test("a second real deck also renders every card as a non-columnar web", async () => {
  const catalog = await reviewedCatalog();
  const deck = catalog.find((candidate) => candidate.id === "academic-reviewed-v1:algorithms-i");
  const projection = graphProjectionForDeck(deck);
  const layout = layoutForGraphProjection(projection, { viewportWidth: 818 });
  assert.equal(layout.nodes.length, 140);
  assert.equal(layout.edges.length, projection.edges.length);
  assert.deepEqual(findNodeCollisions(layout.nodes), []);
  assert.ok(layout.bounds.width / layout.bounds.height >= 0.7);
  assert.ok(layout.bounds.width / layout.bounds.height <= 1.7);
  const distinctX = new Set(layout.nodes.map((node) => Math.round(node.x))).size;
  assert.ok(distinctX > layout.nodes.length * 0.8);
  assert.ok(rankColumnarity(layout.nodes) <= 0.75);
});

test("a full deck without module tags is partitioned into a balanced relationship web", async () => {
  const catalog = await reviewedCatalog();
  const deck = catalog.find((candidate) => candidate.id === "academic-reviewed-v1:biology-i");
  const projection = graphProjectionForDeck(deck);
  assert.equal(projection.nodes.length, 120);
  assert.ok(projection.nodes.every((node) => !(node.tags ?? []).some((tag) => /(?:^|-)m\d+$/i.test(String(tag)))));
  const layout = layoutForGraphProjection(projection, { viewportWidth: 818 });
  assert.equal(layout.nodes.length, deck.cards.length);
  assert.deepEqual(findNodeCollisions(layout.nodes), []);
  assert.ok(layout.bounds.width / layout.bounds.height >= 0.7);
  assert.ok(layout.bounds.width / layout.bounds.height <= 1.7);
  assert.ok(rankColumnarity(layout.nodes) <= 0.75);
});
