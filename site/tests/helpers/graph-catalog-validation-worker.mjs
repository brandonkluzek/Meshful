import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import {
  countEdgeCrossings,
  findEdgeNodeIntersections,
  findNodeCollisions,
} from "../../public/study/js/graph-engine.js";
import {
  graphProjectionForDeck,
  layoutForGraphProjection,
} from "../../public/study/js/graph-view.js";

const NUMBER_PATTERN = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?`;
const SINGLE_CUBIC_PATTERN = new RegExp(
  `^M ${NUMBER_PATTERN} ${NUMBER_PATTERN} C ${NUMBER_PATTERN} ${NUMBER_PATTERN} ${NUMBER_PATTERN} ${NUMBER_PATTERN} ${NUMBER_PATTERN} ${NUMBER_PATTERN}$`,
);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareIds(left, right) {
  return String(left).localeCompare(String(right), "en", {
    numeric: true,
    sensitivity: "base",
  });
}

function sourceId(edge) {
  return edge.source ?? edge.prerequisiteCardId ?? edge.prerequisite_card_id ??
    edge.prerequisiteId ?? edge.prerequisite_id;
}

function targetId(edge) {
  return edge.target ?? edge.dependentCardId ?? edge.dependent_card_id ??
    edge.cardId ?? edge.card_id;
}

function prerequisiteId(value) {
  if (typeof value === "string") return value;
  return value?.id ?? value?.cardId ?? value?.card_id ??
    value?.prerequisiteCardId ?? value?.prerequisite_card_id ?? value?.source;
}

function relationKey(source, target) {
  return `${source}\u0000${target}`;
}

function expectedInternalRelations(deck) {
  const cardIds = new Set(deck.cards.map((card) => card.id));
  const relations = new Set();
  for (const edge of deck.edges ?? []) {
    const source = sourceId(edge);
    const target = targetId(edge);
    if (cardIds.has(source) && cardIds.has(target)) {
      relations.add(relationKey(source, target));
    }
  }
  for (const card of deck.cards) {
    const prerequisites = card.prerequisite_ids ?? card.prerequisites ?? [];
    for (const prerequisite of prerequisites) {
      const source = prerequisiteId(prerequisite);
      if (cardIds.has(source)) relations.add(relationKey(source, card.id));
    }
  }
  return [...relations].sort(compareIds);
}

function actualRelations(edges) {
  return edges
    .map((edge) => relationKey(edge.source, edge.target))
    .sort(compareIds);
}

function sameOrderedValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cross(left, right) {
  return left.x * right.y - left.y * right.x;
}

// The signed-curvature numerator of a cubic Bezier is quadratic. Count its
// simple roots in the open unit interval rather than inferring inflections
// from the SVG string or from a rendering screenshot.
function interiorInflectionCount(edge) {
  const [p0, p1, p2, p3] = [edge.start, edge.controlA, edge.controlB, edge.end];
  const a = {
    x: -p0.x + 3 * p1.x - 3 * p2.x + p3.x,
    y: -p0.y + 3 * p1.y - 3 * p2.y + p3.y,
  };
  const b = {
    x: 3 * p0.x - 6 * p1.x + 3 * p2.x,
    y: 3 * p0.y - 6 * p1.y + 3 * p2.y,
  };
  const c = {
    x: -3 * p0.x + 3 * p1.x,
    y: -3 * p0.y + 3 * p1.y,
  };
  const quadratic = -6 * cross(a, b);
  const linear = 6 * cross(c, a);
  const constant = 2 * cross(c, b);
  const scale = Math.max(1, Math.abs(quadratic), Math.abs(linear), Math.abs(constant));
  const epsilon = scale * 1e-9;
  let roots;
  if (Math.abs(quadratic) <= epsilon) {
    roots = Math.abs(linear) <= epsilon ? [] : [-constant / linear];
  } else {
    const discriminant = linear * linear - 4 * quadratic * constant;
    if (discriminant < -epsilon * scale) return 0;
    const squareRoot = Math.sqrt(Math.max(0, discriminant));
    roots = [
      (-linear - squareRoot) / (2 * quadratic),
      (-linear + squareRoot) / (2 * quadratic),
    ];
  }
  return roots
    .filter((root, index) =>
      Number.isFinite(root) &&
      root > 1e-7 && root < 1 - 1e-7 &&
      roots.findIndex((candidate) => Math.abs(candidate - root) < 1e-7) === index &&
      Math.abs(2 * quadratic * root + linear) > epsilon,
    )
    .length;
}

function finitePoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function layoutFingerprint(layout) {
  const stableGeometry = {
    nodes: layout.nodes.map((node) => ({
      id: node.id,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      layer: node.layer,
      order: node.order,
    })),
    edges: layout.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      start: edge.start,
      controlA: edge.controlA,
      controlB: edge.controlB,
      end: edge.end,
      path: edge.path,
    })),
    bounds: layout.bounds,
  };
  return createHash("sha256").update(JSON.stringify(stableGeometry)).digest("hex");
}

function pointBounds(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

function boundsOverlap(first, second) {
  return first.minX <= second.maxX && first.maxX >= second.minX &&
    first.minY <= second.maxY && first.maxY >= second.minY;
}

// Keep the production diagnostic definitions while cheaply rejecting geometry
// whose bounding boxes cannot meet. This turns the catalog gate from an all-pair
// scan into a sweep over only plausible edge pairs.
function diagnosticCrossingCount(edges) {
  const ordered = edges.map((edge) => ({ edge, bounds: pointBounds(edge.points) }))
    .sort((left, right) => left.bounds.minX - right.bounds.minX || compareIds(left.edge.id, right.edge.id));
  const active = [];
  let crossings = 0;
  for (const current of ordered) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index].bounds.maxX < current.bounds.minX) active.splice(index, 1);
    }
    for (const candidate of active) {
      if (!boundsOverlap(candidate.bounds, current.bounds)) continue;
      crossings += countEdgeCrossings([candidate.edge, current.edge]);
    }
    active.push(current);
  }
  return crossings;
}

function diagnosticEdgeCardPenetrations(edges, nodes) {
  const nodeBounds = nodes.map((node) => ({
    node,
    bounds: {
      minX: node.x,
      minY: node.y,
      maxX: node.x + node.width,
      maxY: node.y + node.height,
    },
  }));
  const pairs = new Set();
  for (const edge of edges) {
    const edgeBounds = pointBounds(edge.points);
    const candidates = nodeBounds
      .filter((candidate) => boundsOverlap(edgeBounds, candidate.bounds))
      .map((candidate) => candidate.node);
    for (const { edgeId, nodeId } of findEdgeNodeIntersections([edge], candidates)) {
      pairs.add(`${edgeId}\u0000${nodeId}`);
    }
  }
  return pairs.size;
}

function validateLayout(deck, entry, projection, layout) {
  const expectedCardIds = deck.cards.map((card) => card.id).sort(compareIds);
  const expectedRelations = expectedInternalRelations(deck);
  const projectedCardIds = projection.nodes.map((node) => node.id).sort(compareIds);
  const layoutCardIds = layout.nodes.map((node) => node.id).sort(compareIds);

  invariant(expectedCardIds.length === entry.card_count,
    `${deck.id}: release index says ${entry.card_count} cards, chunk has ${expectedCardIds.length}`);
  invariant(projection.kind === "full" && projection.complete && !projection.truncated,
    `${deck.id}: production projection is not a complete full-deck projection`);
  invariant(sameOrderedValues(projectedCardIds, expectedCardIds),
    `${deck.id}: projection did not preserve every catalog card`);
  invariant(sameOrderedValues(layoutCardIds, expectedCardIds),
    `${deck.id}: layout did not preserve every projected card`);
  invariant(sameOrderedValues(actualRelations(projection.edges), expectedRelations),
    `${deck.id}: projection did not preserve every internal prerequisite relation`);
  invariant(sameOrderedValues(actualRelations(layout.edges), expectedRelations),
    `${deck.id}: layout did not preserve every projected prerequisite relation`);

  for (const node of layout.nodes) {
    invariant(
      [node.x, node.y, node.width, node.height].every(Number.isFinite) &&
        node.width > 0 && node.height > 0,
      `${deck.id}: node ${node.id} has non-finite or non-positive geometry`,
    );
  }
  const collisions = findNodeCollisions(layout.nodes);
  invariant(collisions.length === 0,
    `${deck.id}: layout contains ${collisions.length} node collision(s)`);

  for (const edge of layout.edges) {
    invariant(SINGLE_CUBIC_PATTERN.test(edge.path),
      `${deck.id}: edge ${edge.id} is not exactly one M followed by one C`);
    invariant(
      [edge.start, edge.controlA, edge.controlB, edge.end].every(finitePoint) &&
        Array.isArray(edge.points) && edge.points.length >= 2 && edge.points.every(finitePoint) &&
        Number.isFinite(edge.length) && edge.length > 0 &&
        Number.isFinite(edge.directDistance) && edge.directDistance > 0,
      `${deck.id}: edge ${edge.id} has invalid route geometry`,
    );
    invariant(interiorInflectionCount(edge) === 1,
      `${deck.id}: edge ${edge.id} does not have exactly one simple interior inflection`);
  }

  return {
    deckId: deck.id,
    title: deck.title,
    nodes: layout.nodes.length,
    edges: layout.edges.length,
    crossings: diagnosticCrossingCount(layout.edges),
    edgeCardPenetrations: diagnosticEdgeCardPenetrations(layout.edges, layout.nodes),
    fingerprint: layoutFingerprint(layout),
  };
}

async function validateDeck(entry) {
  const payload = JSON.parse(await readFile(join(workerData.releaseRoot, entry.chunk.key), "utf8"));
  const deck = payload.deck;
  invariant(deck?.id === entry.catalog_deck_id,
    `${entry.catalog_deck_id}: chunk contains an unexpected deck identity`);
  const layoutStartedAt = performance.now();
  const projection = graphProjectionForDeck(deck);
  const layout = layoutForGraphProjection(projection, { viewportWidth: 818 });
  const layoutDurationMs = performance.now() - layoutStartedAt;
  const diagnosticsStartedAt = performance.now();
  const result = validateLayout(deck, entry, projection, layout);
  result.layoutDurationMs = layoutDurationMs;
  result.diagnosticsDurationMs = performance.now() - diagnosticsStartedAt;

  if (workerData.deterministicDeckIds.includes(deck.id)) {
    const repeatStartedAt = performance.now();
    const repeated = layoutForGraphProjection(graphProjectionForDeck(deck), { viewportWidth: 818 });
    result.determinismRepeatDurationMs = performance.now() - repeatStartedAt;
    const repeatedFingerprint = layoutFingerprint(repeated);
    invariant(repeatedFingerprint === result.fingerprint,
      `${deck.id}: equal inputs produced different graph geometry`);
    result.determinismChecked = true;
  } else {
    result.determinismChecked = false;
  }
  return result;
}

async function run() {
  const results = [];
  for (const entry of workerData.entries) results.push(await validateDeck(entry));
  return results;
}

run().then(
  (results) => parentPort.postMessage({ results }),
  (error) => parentPort.postMessage({
    error: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    },
  }),
);
