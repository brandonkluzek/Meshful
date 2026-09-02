import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGraphIndex,
  chooseDefaultGraphProjection,
  findDependencyPath,
  projectModule,
  projectNeighborhood,
} from "../js/graph-scope.js";

const modules = [
  { id: "foundations", title: "Foundations", order: 0, sourceLabel: "authored" },
  { id: "methods", title: "Methods", order: 1 },
  { id: "applications", title: "Applications", order: 2 },
  { id: "later", title: "Later", order: 3 },
];

const cards = [
  { id: "a0", term: "A zero", moduleId: "foundations", difficulty: 1 },
  { id: "a1", term: "A one", moduleId: "foundations" },
  { id: "b0", term: "B zero", moduleId: "methods" },
  { id: "b1", term: "B one", moduleId: "methods" },
  { id: "c0", term: "C zero", moduleId: "applications" },
  { id: "d0", term: "D zero", moduleId: "later" },
];

const edges = [
  { id: "edge-a0-a1", source: "a0", target: "a1", provenance: "fixture" },
  { id: "edge-a1-b0", source: "a1", target: "b0" },
  { id: "edge-a1-b1", source: "a1", target: "b1" },
  { id: "edge-b0-c0", source: "b0", target: "c0" },
  { id: "edge-b1-c0", source: "b1", target: "c0" },
  { id: "edge-c0-d0", source: "c0", target: "d0" },
];

function fixture({ reverse = false } = {}) {
  return {
    id: "course",
    title: "Course",
    modules: reverse ? [...modules].reverse() : modules,
    cards: reverse ? [...cards].reverse() : cards,
    edges: reverse ? [...edges].reverse() : edges,
  };
}

function assertUsesOnlyRealRelations(index, projection) {
  const indexEdges = new Map(index.edges.map((edge) => [edge.id, edge]));
  const visibleNodes = new Set(projection.nodeIds);
  for (const edge of projection.edges) {
    const original = indexEdges.get(edge.id);
    assert.ok(original, `${edge.id} must exist in the source index`);
    assert.equal(edge.source, original.source);
    assert.equal(edge.target, original.target);
    assert.ok(visibleNodes.has(edge.source));
    assert.ok(visibleNodes.has(edge.target));
  }
}

test("buildGraphIndex preserves explicit identities and authored module metadata", () => {
  const index = buildGraphIndex(fixture());

  assert.deepEqual(index.nodeIds, ["a0", "a1", "b0", "b1", "c0", "d0"]);
  assert.deepEqual(index.edgeIds, [
    "edge-a0-a1",
    "edge-a1-b0",
    "edge-a1-b1",
    "edge-b0-c0",
    "edge-b1-c0",
    "edge-c0-d0",
  ]);
  assert.equal(index.cardById.get("a0").difficulty, 1);
  assert.equal(index.cardById.get("a0").moduleId, "foundations");
  assert.equal(index.cardById.get("a0").moduleMetadata.sourceLabel, "authored");
  assert.equal(index.edgeById.get("edge-a0-a1").provenance, "fixture");
  assert.deepEqual(index.moduleById.get("methods").cardIds, ["b0", "b1"]);
});

test("module projection includes deterministic off-module boundary terms and no fabricated edges", () => {
  const firstIndex = buildGraphIndex(fixture());
  const secondIndex = buildGraphIndex(fixture({ reverse: true }));
  const first = projectModule(firstIndex, "methods", {
    boundaryDepth: 1,
    nodeLimit: 80,
  });
  const second = projectModule(secondIndex, "methods", {
    boundaryDepth: 1,
    nodeLimit: 80,
  });

  assert.deepEqual(first.nodeIds, ["a1", "b0", "b1", "c0"]);
  assert.deepEqual(first.primaryNodeIds, ["b0", "b1"]);
  assert.deepEqual(first.boundaryNodeIds, ["a1", "c0"]);
  assert.deepEqual(first.edgeIds, [
    "edge-a1-b0",
    "edge-a1-b1",
    "edge-b0-c0",
    "edge-b1-c0",
  ]);
  assert.equal(first.truncated, false);
  assert.equal(first.scope.module.sourceLabel, undefined);
  assert.deepEqual(second, first);
  assertUsesOnlyRealRelations(firstIndex, first);
});

test("module projection enforces a deterministic cap and reports every omitted scope identity", () => {
  const index = buildGraphIndex(fixture());
  const projection = projectModule(index, "methods", {
    boundaryDepth: 1,
    nodeLimit: 3,
  });

  assert.deepEqual(projection.nodeIds, ["a1", "b0", "b1"]);
  assert.deepEqual(projection.primaryNodeIds, ["b0", "b1"]);
  assert.deepEqual(projection.boundaryNodeIds, ["a1"]);
  assert.equal(projection.complete, false);
  assert.equal(projection.truncated, true);
  assert.deepEqual(projection.truncation.omittedNodeIds, ["c0"]);
  assert.deepEqual(projection.truncation.omittedBoundaryNodeIds, ["c0"]);
  assert.deepEqual(projection.truncation.omittedEdgeIds, [
    "edge-b0-c0",
    "edge-b1-c0",
  ]);
  assertUsesOnlyRealRelations(index, projection);
});

test("neighborhood projection honors independent directed depths deterministically", () => {
  const first = projectNeighborhood(buildGraphIndex(fixture()), "b0", {
    upstreamDepth: 2,
    downstreamDepth: 1,
    nodeLimit: 80,
  });
  const second = projectNeighborhood(buildGraphIndex(fixture({ reverse: true })), "b0", {
    upstreamDepth: 2,
    downstreamDepth: 1,
    nodeLimit: 80,
  });

  assert.deepEqual(first.nodeIds, ["a0", "a1", "b0", "c0"]);
  assert.deepEqual(first.primaryNodeIds, ["b0"]);
  assert.deepEqual(first.scope.upstreamDepths, { a0: 2, a1: 1, b0: 0 });
  assert.deepEqual(first.scope.downstreamDepths, { b0: 0, c0: 1 });
  assert.deepEqual(second, first);
  assertUsesOnlyRealRelations(buildGraphIndex(fixture()), first);
});

test("dependency path selects the deterministic exact shortest route and only truncates context", () => {
  const index = buildGraphIndex(fixture({ reverse: true }));
  const projection = findDependencyPath(index, "a0", "c0", {
    contextDepth: 1,
    nodeLimit: 4,
  });

  assert.equal(projection.found, true);
  assert.equal(projection.canProject, true);
  assert.equal(projection.status, "found");
  assert.deepEqual(projection.path, {
    nodeIds: ["a0", "a1", "b0", "c0"],
    edgeIds: ["edge-a0-a1", "edge-a1-b0", "edge-b0-c0"],
    distance: 3,
  });
  assert.deepEqual(projection.primaryNodeIds, ["a0", "a1", "b0", "c0"]);
  assert.equal(projection.truncated, true, "the alternate-path context is capped");
  assert.deepEqual(projection.truncation.omittedNodeIds, ["b1", "d0"]);
  assertUsesOnlyRealRelations(index, projection);
});

test("dependency path fails honestly rather than truncating an exact path", () => {
  const result = findDependencyPath(buildGraphIndex(fixture()), "a0", "d0", {
    contextDepth: 0,
    nodeLimit: 4,
  });

  assert.equal(result.found, true);
  assert.equal(result.canProject, false);
  assert.equal(result.status, "path_exceeds_node_limit");
  assert.equal(result.truncated, false);
  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.path.nodeIds, ["a0", "a1", "b0", "c0", "d0"]);
  assert.equal(result.truncation.requiredNodeCount, 5);
});

test("default projection uses full small decks and focus modules for bounded large decks", () => {
  const smallIndex = buildGraphIndex(fixture());
  const small = chooseDefaultGraphProjection(smallIndex, { nodeLimit: 6 });
  assert.equal(small.kind, "full");
  assert.equal(small.selectionReason, "small_deck");
  assert.equal(small.truncated, false);

  const largeCards = Array.from({ length: 10 }, (_, index) => ({
    id: `large-${String(index).padStart(2, "0")}`,
    term: `Large ${index}`,
    moduleId: index < 5 ? "first" : "second",
  }));
  const large = chooseDefaultGraphProjection(buildGraphIndex({
    id: "large",
    modules: [
      { id: "first", title: "First", order: 0 },
      { id: "second", title: "Second", order: 1 },
    ],
    cards: largeCards,
    edges: [
      { id: "bridge", source: "large-04", target: "large-05" },
    ],
  }), {
    focusCardId: "large-07",
    nodeLimit: 6,
  });

  assert.equal(large.kind, "module");
  assert.equal(large.selectionReason, "focus_module");
  assert.equal(large.scope.moduleId, "second");
  assert.ok(large.nodeIds.includes("large-07"));
  assert.ok(large.boundaryNodeIds.includes("large-04"));
  assert.equal(large.nodeIds.length, 6);
});
