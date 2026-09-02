const DEFAULT_LAYOUT_OPTIONS = Object.freeze({
  nodeWidth: 170,
  nodeHeight: 58,
  layerGap: 104,
  rowGap: 42,
  padding: 72,
  routeMargin: 32,
  routeLaneGap: 10,
  boundsPadding: 24,
  sweeps: 8,
});

export class GraphValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GraphValidationError";
    this.code = code;
    this.details = details;
  }
}

function compareIds(a, b) {
  const left = String(a);
  const right = String(b);
  const natural = left.localeCompare(right, "en", {
    numeric: true,
    sensitivity: "base",
  });
  if (natural !== 0) return natural;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function requireId(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GraphValidationError(
      "INVALID_ID",
      `${label} must be a non-empty string.`,
      { label, value },
    );
  }
  return value.trim();
}

function finitePositive(value, fallback, label) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new GraphValidationError(
      "INVALID_LAYOUT_OPTION",
      `${label} must be a positive finite number.`,
      { label, value: resolved },
    );
  }
  return resolved;
}

function finiteNonNegative(value, fallback, label) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new GraphValidationError(
      "INVALID_LAYOUT_OPTION",
      `${label} must be a non-negative finite number.`,
      { label, value: resolved },
    );
  }
  return resolved;
}

function normalizeOptions(options = {}) {
  return {
    nodeWidth: finitePositive(
      options.nodeWidth,
      DEFAULT_LAYOUT_OPTIONS.nodeWidth,
      "nodeWidth",
    ),
    nodeHeight: finitePositive(
      options.nodeHeight,
      DEFAULT_LAYOUT_OPTIONS.nodeHeight,
      "nodeHeight",
    ),
    layerGap: finitePositive(
      options.layerGap,
      DEFAULT_LAYOUT_OPTIONS.layerGap,
      "layerGap",
    ),
    rowGap: finiteNonNegative(
      options.rowGap,
      DEFAULT_LAYOUT_OPTIONS.rowGap,
      "rowGap",
    ),
    padding: finiteNonNegative(
      options.padding,
      DEFAULT_LAYOUT_OPTIONS.padding,
      "padding",
    ),
    routeMargin: finiteNonNegative(
      options.routeMargin,
      DEFAULT_LAYOUT_OPTIONS.routeMargin,
      "routeMargin",
    ),
    routeLaneGap: finitePositive(
      options.routeLaneGap,
      DEFAULT_LAYOUT_OPTIONS.routeLaneGap,
      "routeLaneGap",
    ),
    boundsPadding: finiteNonNegative(
      options.boundsPadding,
      DEFAULT_LAYOUT_OPTIONS.boundsPadding,
      "boundsPadding",
    ),
    sweeps: Math.max(
      0,
      Math.floor(
        finiteNonNegative(
          options.sweeps,
          DEFAULT_LAYOUT_OPTIONS.sweeps,
          "sweeps",
        ),
      ),
    ),
  };
}

function prerequisiteId(prerequisite, cardId) {
  if (typeof prerequisite === "string") {
    return requireId(prerequisite, `prerequisite for card ${cardId}`);
  }
  if (prerequisite && typeof prerequisite === "object") {
    return requireId(
      prerequisite.id ?? prerequisite.cardId ?? prerequisite.source,
      `prerequisite for card ${cardId}`,
    );
  }
  throw new GraphValidationError(
    "INVALID_PREREQUISITE",
    `Card ${cardId} has an invalid prerequisite.`,
    { cardId, prerequisite },
  );
}

function normalizeGraphInput(input) {
  const cardInput = Array.isArray(input)
    ? input
    : input && Array.isArray(input.cards)
      ? input.cards
      : null;

  let nodes;
  let edges;

  if (cardInput) {
    nodes = cardInput.map((card, index) => {
      const value = typeof card === "string" ? { id: card, term: card } : card;
      if (!value || typeof value !== "object") {
        throw new GraphValidationError(
          "INVALID_NODE",
          `Card at index ${index} must be an object or string.`,
          { index, value: card },
        );
      }
      const id = requireId(value.id, `card id at index ${index}`);
      const prerequisites = (value.prerequisites ?? [])
        .map((item) => prerequisiteId(item, id))
        .sort(compareIds);
      return { ...value, id, prerequisites };
    });
    edges = nodes.flatMap((node) =>
      node.prerequisites.map((source) => ({
        id: `${source}->${node.id}`,
        source,
        target: node.id,
      })),
    );
  } else if (
    input &&
    typeof input === "object" &&
    Array.isArray(input.nodes) &&
    Array.isArray(input.edges)
  ) {
    nodes = input.nodes.map((node, index) => {
      const value = typeof node === "string" ? { id: node, term: node } : node;
      if (!value || typeof value !== "object") {
        throw new GraphValidationError(
          "INVALID_NODE",
          `Node at index ${index} must be an object or string.`,
          { index, value: node },
        );
      }
      return {
        ...value,
        id: requireId(value.id, `node id at index ${index}`),
      };
    });
    edges = input.edges.map((edge, index) => {
      if (!edge || typeof edge !== "object") {
        throw new GraphValidationError(
          "INVALID_EDGE",
          `Edge at index ${index} must be an object.`,
          { index, value: edge },
        );
      }
      const source = requireId(edge.source, `edge source at index ${index}`);
      const target = requireId(edge.target, `edge target at index ${index}`);
      return {
        ...edge,
        id: requireId(edge.id ?? `${source}->${target}`, `edge id at index ${index}`),
        source,
        target,
      };
    });
  } else {
    throw new GraphValidationError(
      "INVALID_GRAPH",
      "Graph input must be a card array, { cards }, or { nodes, edges }.",
    );
  }

  nodes.sort((a, b) => compareIds(a.id, b.id));
  edges.sort(
    (a, b) =>
      compareIds(a.source, b.source) ||
      compareIds(a.target, b.target) ||
      compareIds(a.id, b.id),
  );

  const nodeIds = new Set();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      throw new GraphValidationError(
        "DUPLICATE_NODE",
        `Duplicate node id: ${node.id}.`,
        { nodeId: node.id },
      );
    }
    nodeIds.add(node.id);
  }

  const edgeIds = new Set();
  const relations = new Set();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      throw new GraphValidationError(
        "DUPLICATE_EDGE",
        `Duplicate edge id: ${edge.id}.`,
        { edgeId: edge.id },
      );
    }
    edgeIds.add(edge.id);

    const relation = JSON.stringify([edge.source, edge.target]);
    if (relations.has(relation)) {
      throw new GraphValidationError(
        "DUPLICATE_RELATION",
        `Duplicate prerequisite relation: ${edge.source} -> ${edge.target}.`,
        { source: edge.source, target: edge.target },
      );
    }
    relations.add(relation);

    const missing = [edge.source, edge.target].filter((id) => !nodeIds.has(id));
    if (missing.length > 0) {
      throw new GraphValidationError(
        "MISSING_ENDPOINT",
        `Edge ${edge.id} references missing node${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
        { edgeId: edge.id, missing },
      );
    }
  }

  return { nodes, edges };
}

function insertSorted(queue, id) {
  let low = 0;
  let high = queue.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareIds(queue[middle], id) < 0) low = middle + 1;
    else high = middle;
  }
  queue.splice(low, 0, id);
}

function graphMetadata(graph) {
  const incoming = new Map(graph.nodes.map((node) => [node.id, []]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, []]));
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const levels = new Map(graph.nodes.map((node) => [node.id, 0]));

  for (const edge of graph.edges) {
    outgoing.get(edge.source).push(edge);
    incoming.get(edge.target).push(edge);
    indegree.set(edge.target, indegree.get(edge.target) + 1);
  }
  for (const collection of [...incoming.values(), ...outgoing.values()]) {
    collection.sort(
      (a, b) =>
        compareIds(a.source, b.source) ||
        compareIds(a.target, b.target) ||
        compareIds(a.id, b.id),
    );
  }

  const ready = graph.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id)
    .sort(compareIds);
  const topological = [];

  while (ready.length > 0) {
    const id = ready.shift();
    topological.push(id);
    for (const edge of outgoing.get(id)) {
      levels.set(
        edge.target,
        Math.max(levels.get(edge.target), levels.get(id) + 1),
      );
      const nextDegree = indegree.get(edge.target) - 1;
      indegree.set(edge.target, nextDegree);
      if (nextDegree === 0) insertSorted(ready, edge.target);
    }
  }

  if (topological.length !== graph.nodes.length) {
    const cycleNodes = graph.nodes
      .map((node) => node.id)
      .filter((id) => indegree.get(id) > 0)
      .sort(compareIds);
    throw new GraphValidationError(
      "CYCLE",
      `Prerequisite graph must be acyclic. Cycle involves: ${cycleNodes.join(", ")}.`,
      { nodeIds: cycleNodes },
    );
  }

  return { incoming, outgoing, levels, topological };
}

function layerPositions(layers) {
  const positions = new Map();
  layers.forEach((layer, level) => {
    layer.forEach((id, order) => positions.set(id, { level, order }));
  });
  return positions;
}

function reorderedLayer(ids, neighborEdges, positions, direction) {
  const currentOrder = new Map(ids.map((id, index) => [id, index]));
  const barycenters = new Map();

  for (const id of ids) {
    const neighbors = neighborEdges
      .get(id)
      .map((edge) => (direction === "incoming" ? edge.source : edge.target))
      .map((neighborId) => positions.get(neighborId))
      .filter(Boolean)
      .map((position) => position.order);
    if (neighbors.length > 0) {
      barycenters.set(
        id,
        neighbors.reduce((total, value) => total + value, 0) / neighbors.length,
      );
    }
  }

  return [...ids].sort((a, b) => {
    const aCenter = barycenters.get(a);
    const bCenter = barycenters.get(b);
    if (aCenter !== undefined && bCenter !== undefined && aCenter !== bCenter) {
      return aCenter - bCenter;
    }
    if (aCenter !== undefined && bCenter === undefined) return -1;
    if (aCenter === undefined && bCenter !== undefined) return 1;
    return currentOrder.get(a) - currentOrder.get(b) || compareIds(a, b);
  });
}

function crossingCount(graph, layers, levels) {
  const positions = layerPositions(layers);
  const groups = new Map();
  for (const edge of graph.edges) {
    const key = `${levels.get(edge.source)}:${levels.get(edge.target)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  }

  let crossings = 0;
  for (const edges of groups.values()) {
    for (let first = 0; first < edges.length; first += 1) {
      for (let second = first + 1; second < edges.length; second += 1) {
        const a = edges[first];
        const b = edges[second];
        if (
          a.source === b.source ||
          a.target === b.target ||
          levels.get(a.source) !== levels.get(b.source) ||
          levels.get(a.target) !== levels.get(b.target)
        ) {
          continue;
        }
        const sourceDelta =
          positions.get(a.source).order - positions.get(b.source).order;
        const targetDelta =
          positions.get(a.target).order - positions.get(b.target).order;
        if (sourceDelta * targetDelta < 0) crossings += 1;
      }
    }
  }
  return crossings;
}

function layerSignature(layers) {
  return layers.map((layer) => layer.join("\u0001")).join("\u0002");
}

function orderLayers(graph, metadata, sweeps) {
  const maxLevel = Math.max(0, ...metadata.levels.values());
  let layers = Array.from({ length: maxLevel + 1 }, () => []);
  for (const node of graph.nodes) layers[metadata.levels.get(node.id)].push(node.id);
  for (const layer of layers) layer.sort(compareIds);

  let best = layers.map((layer) => [...layer]);
  let bestCrossings = crossingCount(graph, best, metadata.levels);
  let bestSignature = layerSignature(best);

  for (let iteration = 0; iteration < sweeps; iteration += 1) {
    for (let level = 1; level < layers.length; level += 1) {
      layers[level] = reorderedLayer(
        layers[level],
        metadata.incoming,
        layerPositions(layers),
        "incoming",
      );
    }
    for (let level = layers.length - 2; level >= 0; level -= 1) {
      layers[level] = reorderedLayer(
        layers[level],
        metadata.outgoing,
        layerPositions(layers),
        "outgoing",
      );
    }

    const crossings = crossingCount(graph, layers, metadata.levels);
    const signature = layerSignature(layers);
    if (
      crossings < bestCrossings ||
      (crossings === bestCrossings && signature < bestSignature)
    ) {
      best = layers.map((layer) => [...layer]);
      bestCrossings = crossings;
      bestSignature = signature;
    }
  }
  return best;
}

function portOffset(index, count, nodeHeight) {
  if (count <= 1) return 0;
  const available = Math.max(0, nodeHeight - 16);
  return -available / 2 + (available * index) / (count - 1);
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function compactOrthogonalPoints(points) {
  const deduplicated = [];
  for (const point of points) {
    const next = { x: rounded(point.x), y: rounded(point.y) };
    const previous = deduplicated.at(-1);
    if (!previous || previous.x !== next.x || previous.y !== next.y) {
      deduplicated.push(next);
    }
  }

  let changed = true;
  while (changed && deduplicated.length > 2) {
    changed = false;
    for (let index = 1; index < deduplicated.length - 1; index += 1) {
      const previous = deduplicated[index - 1];
      const current = deduplicated[index];
      const next = deduplicated[index + 1];
      if (
        (previous.x === current.x && current.x === next.x) ||
        (previous.y === current.y && current.y === next.y)
      ) {
        deduplicated.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return deduplicated;
}

function pathFromPoints(points) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}

function coordinateKey(value) {
  return String(rounded(value));
}

function sortedCoordinates(values) {
  return [...new Set(values.map((value) => coordinateKey(value)))]
    .map(Number)
    .sort((a, b) => a - b);
}

class RouteQueue {
  constructor() {
    this.values = [];
  }

  push(value) {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent].priority <= value.priority) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }

  pop() {
    if (this.values.length === 0) return null;
    const first = this.values[0];
    const last = this.values.pop();
    if (this.values.length > 0) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.values.length) break;
        const child =
          right < this.values.length &&
          this.values[right].priority < this.values[left].priority
            ? right
            : left;
        if (this.values[child].priority >= last.priority) break;
        this.values[index] = this.values[child];
        index = child;
      }
      this.values[index] = last;
    }
    return first;
  }
}

function makeRoutingGrid(nodes, edgeSpecs, options) {
  const clearance = Math.min(10, Math.max(6, options.routeLaneGap * 0.8));
  const obstacles = nodes.map((node) => ({
    left: node.x - clearance,
    right: node.x + node.width + clearance,
    top: node.y - clearance,
    bottom: node.y + node.height + clearance,
  }));
  const xs = [];
  const ys = [];

  for (const node of nodes) {
    xs.push(
      node.x,
      node.x - clearance,
      node.x + node.width,
      node.x + node.width + clearance,
    );
    ys.push(node.y - clearance, node.y + node.height + clearance);
  }
  for (const spec of edgeSpecs) {
    xs.push(spec.start.x, spec.startStub.x, spec.endStub.x, spec.end.x);
    ys.push(spec.start.y, spec.end.y);
  }

  const layerBands = new Map();
  for (const node of nodes) {
    const layer = Number.isInteger(node.layer) ? node.layer : node.x;
    const band = layerBands.get(layer) ?? {
      layer,
      left: node.x,
      right: node.x + node.width,
    };
    band.left = Math.min(band.left, node.x);
    band.right = Math.max(band.right, node.x + node.width);
    layerBands.set(layer, band);
  }
  const bands = [...layerBands.values()].sort((a, b) => a.layer - b.layer);
  for (let layer = 0; layer < bands.length - 1; layer += 1) {
    const left = bands[layer].right + clearance;
    const right = bands[layer + 1].left - clearance;
    if (left > right) continue;
    for (let x = left; x <= right; x += options.routeLaneGap) xs.push(x);
    xs.push(right);
  }

  const nodeMinY = Math.min(...nodes.map((node) => node.y));
  const nodeMaxY = Math.max(...nodes.map((node) => node.y + node.height));
  const outside = options.routeMargin + options.routeLaneGap * 6;
  const minY = nodeMinY - outside;
  const maxY = nodeMaxY + outside;
  for (let y = minY; y <= maxY; y += options.routeLaneGap) ys.push(y);
  ys.push(maxY);

  const xValues = sortedCoordinates(xs);
  const yValues = sortedCoordinates(ys);
  const xIndex = new Map(xValues.map((value, index) => [coordinateKey(value), index]));
  const yIndex = new Map(yValues.map((value, index) => [coordinateKey(value), index]));
  const epsilon = 0.0001;

  function clearHorizontal(x1, x2, y) {
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    return !obstacles.some(
      (obstacle) =>
        y > obstacle.top + epsilon &&
        y < obstacle.bottom - epsilon &&
        right > obstacle.left + epsilon &&
        left < obstacle.right - epsilon,
    );
  }

  function clearVertical(x, y1, y2) {
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);
    return !obstacles.some(
      (obstacle) =>
        x > obstacle.left + epsilon &&
        x < obstacle.right - epsilon &&
        bottom > obstacle.top + epsilon &&
        top < obstacle.bottom - epsilon,
    );
  }

  const horizontalClear = yValues.map((y) =>
    xValues.slice(1).map((x, index) => clearHorizontal(xValues[index], x, y)),
  );
  const verticalClear = xValues.map((x) =>
    yValues.slice(1).map((y, index) => clearVertical(x, yValues[index], y)),
  );

  return {
    clearance,
    xs: xValues,
    ys: yValues,
    xIndex,
    yIndex,
    horizontalClear,
    verticalClear,
  };
}

const ROUTE_LEFT = 1;
const ROUTE_RIGHT = 2;
const ROUTE_UP = 4;
const ROUTE_DOWN = 8;

function routeAtomicKey(a, b) {
  if (a.yi === b.yi) {
    return `h:${a.yi}:${Math.min(a.xi, b.xi)}`;
  }
  return `v:${a.xi}:${Math.min(a.yi, b.yi)}`;
}

function routeStateKey(xi, yi, direction) {
  return `${xi}:${yi}:${direction}`;
}

function findGridRoute(
  grid,
  startPoint,
  endPoint,
  occupancy,
  { allowOverlap = false } = {},
) {
  const start = {
    xi: grid.xIndex.get(coordinateKey(startPoint.x)),
    yi: grid.yIndex.get(coordinateKey(startPoint.y)),
  };
  const end = {
    xi: grid.xIndex.get(coordinateKey(endPoint.x)),
    yi: grid.yIndex.get(coordinateKey(endPoint.y)),
  };
  if (
    !Number.isInteger(start.xi) ||
    !Number.isInteger(start.yi) ||
    !Number.isInteger(end.xi) ||
    !Number.isInteger(end.yi)
  ) {
    return null;
  }

  const queue = new RouteQueue();
  const costs = new Map();
  const previous = new Map();
  const startKey = routeStateKey(start.xi, start.yi, "none");
  costs.set(startKey, 0);
  queue.push({ ...start, direction: "none", cost: 0, priority: 0 });

  function heuristic(xi, yi) {
    return (
      Math.abs(grid.xs[end.xi] - grid.xs[xi]) +
      Math.abs(grid.ys[end.yi] - grid.ys[yi])
    );
  }

  let finalState = null;
  while (queue.values.length > 0) {
    const current = queue.pop();
    const currentKey = routeStateKey(current.xi, current.yi, current.direction);
    if (current.cost !== costs.get(currentKey)) continue;
    if (current.xi === end.xi && current.yi === end.yi) {
      finalState = current;
      break;
    }

    const candidates = [];
    if (
      current.xi < end.xi &&
      grid.horizontalClear[current.yi]?.[current.xi]
    ) {
      candidates.push({
        xi: current.xi + 1,
        yi: current.yi,
        direction: "horizontal",
        length: grid.xs[current.xi + 1] - grid.xs[current.xi],
      });
    }
    if (
      current.yi > 0 &&
      grid.verticalClear[current.xi]?.[current.yi - 1]
    ) {
      candidates.push({
        xi: current.xi,
        yi: current.yi - 1,
        direction: "vertical",
        length: grid.ys[current.yi] - grid.ys[current.yi - 1],
      });
    }
    if (
      current.yi < grid.ys.length - 1 &&
      grid.verticalClear[current.xi]?.[current.yi]
    ) {
      candidates.push({
        xi: current.xi,
        yi: current.yi + 1,
        direction: "vertical",
        length: grid.ys[current.yi + 1] - grid.ys[current.yi],
      });
    }

    for (const next of candidates) {
      const atomicKey = routeAtomicKey(current, next);
      const overlaps = occupancy.atomic.has(atomicKey);
      if (overlaps && !allowOverlap) continue;
      const nextKey = routeStateKey(next.xi, next.yi, next.direction);
      const turn =
        current.direction !== "none" && current.direction !== next.direction
          ? 14
          : 0;
      const nextVertexMask = occupancy.vertices.get(`${next.xi}:${next.yi}`) ?? 0;
      const currentVertexMask = occupancy.vertices.get(`${current.xi}:${current.yi}`) ?? 0;
      const oppositeMask = next.direction === "horizontal"
        ? ROUTE_UP | ROUTE_DOWN
        : ROUTE_LEFT | ROUTE_RIGHT;
      const crosses =
        (nextVertexMask & oppositeMask) || (currentVertexMask & oppositeMask);
      const congestion = crosses
        ? 5000
        : nextVertexMask || currentVertexMask
          ? 24
          : 0;
      const nextCost =
        current.cost +
        next.length +
        turn +
        congestion +
        (overlaps ? 20_000 : 0);
      if (nextCost >= (costs.get(nextKey) ?? Infinity)) continue;
      costs.set(nextKey, nextCost);
      previous.set(nextKey, currentKey);
      queue.push({
        ...next,
        cost: nextCost,
        priority: nextCost + heuristic(next.xi, next.yi),
      });
    }
  }

  if (!finalState) return null;
  const states = [];
  let key = routeStateKey(finalState.xi, finalState.yi, finalState.direction);
  while (key) {
    const [xi, yi] = key.split(":").map(Number);
    states.push({ xi, yi });
    key = previous.get(key);
  }
  states.reverse();
  return states.map(({ xi, yi }) => ({ x: grid.xs[xi], y: grid.ys[yi] }));
}

function markRouteOccupancy(points, grid, occupancy) {
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    const ax = grid.xIndex.get(coordinateKey(a.x));
    const ay = grid.yIndex.get(coordinateKey(a.y));
    const bx = grid.xIndex.get(coordinateKey(b.x));
    const by = grid.yIndex.get(coordinateKey(b.y));
    if (![ax, ay, bx, by].every(Number.isInteger)) continue;
    if (ay === by) {
      for (let xi = Math.min(ax, bx); xi < Math.max(ax, bx); xi += 1) {
        occupancy.atomic.add(`h:${ay}:${xi}`);
        occupancy.vertices.set(
          `${xi}:${ay}`,
          (occupancy.vertices.get(`${xi}:${ay}`) ?? 0) | ROUTE_RIGHT,
        );
        occupancy.vertices.set(
          `${xi + 1}:${ay}`,
          (occupancy.vertices.get(`${xi + 1}:${ay}`) ?? 0) | ROUTE_LEFT,
        );
      }
    } else {
      for (let yi = Math.min(ay, by); yi < Math.max(ay, by); yi += 1) {
        occupancy.atomic.add(`v:${ax}:${yi}`);
        occupancy.vertices.set(
          `${ax}:${yi}`,
          (occupancy.vertices.get(`${ax}:${yi}`) ?? 0) | ROUTE_DOWN,
        );
        occupancy.vertices.set(
          `${ax}:${yi + 1}`,
          (occupancy.vertices.get(`${ax}:${yi + 1}`) ?? 0) | ROUTE_UP,
        );
      }
    }
  }
}

function routeEdges(graph, nodes, metadata, options) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const orderById = new Map(nodes.map((node) => [node.id, node.order]));
  const outgoingOrder = new Map();
  const incomingOrder = new Map();

  for (const node of nodes) {
    const outgoing = [...metadata.outgoing.get(node.id)].sort(
      (a, b) =>
        metadata.levels.get(a.target) - metadata.levels.get(b.target) ||
        orderById.get(a.target) - orderById.get(b.target) ||
        compareIds(a.target, b.target) ||
        compareIds(a.id, b.id),
    );
    outgoing.forEach((edge, index) =>
      outgoingOrder.set(edge.id, { index, count: outgoing.length }),
    );

    const incoming = [...metadata.incoming.get(node.id)].sort(
      (a, b) =>
        metadata.levels.get(a.source) - metadata.levels.get(b.source) ||
        orderById.get(a.source) - orderById.get(b.source) ||
        compareIds(a.source, b.source) ||
        compareIds(a.id, b.id),
    );
    incoming.forEach((edge, index) =>
      incomingOrder.set(edge.id, { index, count: incoming.length }),
    );
  }

  const edgeComparator = (a, b) => {
    const aSource = nodeById.get(a.source);
    const bSource = nodeById.get(b.source);
    const aTarget = nodeById.get(a.target);
    const bTarget = nodeById.get(b.target);
    return (
      aSource.layer - bSource.layer ||
      aTarget.layer - bTarget.layer ||
      aSource.order - bSource.order ||
      aTarget.order - bTarget.order ||
      compareIds(a.id, b.id)
    );
  };

  const edgeSpecs = [...graph.edges].sort(edgeComparator).map((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const output = outgoingOrder.get(edge.id);
    const input = incomingOrder.get(edge.id);
    const start = {
      x: source.x + source.width,
      y:
        source.y +
        source.height / 2 +
        portOffset(output.index, output.count, source.height),
    };
    const end = {
      x: target.x,
      y:
        target.y +
        target.height / 2 +
        portOffset(input.index, input.count, target.height),
    };

    return {
      ...edge,
      start,
      end,
      startStub: { x: start.x + Math.min(10, Math.max(6, options.routeLaneGap * 0.8)), y: start.y },
      endStub: { x: end.x - Math.min(10, Math.max(6, options.routeLaneGap * 0.8)), y: end.y },
      sourceLayer: source.layer,
      targetLayer: target.layer,
    };
  });

  const grid = makeRoutingGrid(nodes, edgeSpecs, options);
  const primaryOrder = [...edgeSpecs].sort((a, b) =>
    (a.targetLayer - a.sourceLayer) - (b.targetLayer - b.sourceLayer) ||
    Math.abs(b.end.y - b.start.y) - Math.abs(a.end.y - a.start.y) ||
    edgeComparator(a, b),
  );
  const longFirst = [...edgeSpecs].sort((a, b) =>
    (b.targetLayer - b.sourceLayer) - (a.targetLayer - a.sourceLayer) ||
    Math.abs(b.end.y - b.start.y) - Math.abs(a.end.y - a.start.y) ||
    edgeComparator(a, b),
  );

  function attempt(order, allowOverlap = false) {
    const occupancy = { atomic: new Set(), vertices: new Map() };
    const routed = new Map();
    for (let lane = 0; lane < order.length; lane += 1) {
      const spec = order[lane];
      const middle = findGridRoute(
        grid,
        spec.startStub,
        spec.endStub,
        occupancy,
        { allowOverlap },
      );
      if (!middle) return null;
      const points = compactOrthogonalPoints([
        spec.start,
        spec.startStub,
        ...middle.slice(1, -1),
        spec.endStub,
        spec.end,
      ]);
      markRouteOccupancy(points, grid, occupancy);
      routed.set(spec.id, {
        ...spec,
        lane,
        points,
        path: pathFromPoints(points),
      });
    }
    return edgeSpecs.map((edge) => routed.get(edge.id));
  }

  const attempts = [
    primaryOrder,
    [...primaryOrder].reverse(),
    longFirst,
    [...longFirst].reverse(),
  ];
  for (const order of attempts) {
    const result = attempt(order);
    if (result) return result;
  }

  const fallback = attempt(primaryOrder, true);
  if (fallback) return fallback;
  throw new GraphValidationError(
    "EDGE_ROUTE_FAILED",
    "Could not find an orthogonal route through the available graph channels.",
  );
}

function cubicPoint(start, controlA, controlB, end, t) {
  const inverse = 1 - t;
  return {
    x:
      inverse ** 3 * start.x +
      3 * inverse ** 2 * t * controlA.x +
      3 * inverse * t ** 2 * controlB.x +
      t ** 3 * end.x,
    y:
      inverse ** 3 * start.y +
      3 * inverse ** 2 * t * controlA.y +
      3 * inverse * t ** 2 * controlB.y +
      t ** 3 * end.y,
  };
}

function sampledCubic(start, controlA, controlB, end, samples = 28) {
  return Array.from({ length: samples + 1 }, (_, index) => {
    const point = cubicPoint(start, controlA, controlB, end, index / samples);
    return { x: rounded(point.x), y: rounded(point.y) };
  });
}

function lineIntersection(a, b, c, d, { includeEndpoints = false } = {}) {
  const firstVector = { x: b.x - a.x, y: b.y - a.y };
  const secondVector = { x: d.x - c.x, y: d.y - c.y };
  const denominator =
    firstVector.x * secondVector.y - firstVector.y * secondVector.x;
  if (Math.abs(denominator) < 1e-8) return null;
  const offset = { x: c.x - a.x, y: c.y - a.y };
  const firstParameter =
    (offset.x * secondVector.y - offset.y * secondVector.x) / denominator;
  const secondParameter =
    (offset.x * firstVector.y - offset.y * firstVector.x) / denominator;
  const minimum = includeEndpoints ? -1e-6 : 1e-3;
  const maximum = includeEndpoints ? 1 + 1e-6 : 1 - 1e-3;
  if (
    firstParameter < minimum ||
    firstParameter > maximum ||
    secondParameter < minimum ||
    secondParameter > maximum
  ) {
    return null;
  }
  return {
    x: rounded(a.x + firstParameter * firstVector.x),
    y: rounded(a.y + firstParameter * firstVector.y),
  };
}

function pointInsideRect(point, rect, margin = 0) {
  return (
    point.x > rect.x - margin &&
    point.x < rect.x + rect.width + margin &&
    point.y > rect.y - margin &&
    point.y < rect.y + rect.height + margin
  );
}

function segmentIntersectsRect(start, end, rect, margin = 0) {
  if (pointInsideRect(start, rect, margin) || pointInsideRect(end, rect, margin)) return true;
  const left = rect.x - margin;
  const right = rect.x + rect.width + margin;
  const top = rect.y - margin;
  const bottom = rect.y + rect.height + margin;
  const corners = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  return corners.some((corner, index) =>
    lineIntersection(start, end, corner, corners[(index + 1) % corners.length], {
      includeEndpoints: true,
    }),
  );
}

function polylineIntersectsRect(points, rect, margin = 0) {
  return points.slice(1).some((point, index) =>
    segmentIntersectsRect(points[index], point, rect, margin),
  );
}

function polylinesCross(first, second) {
  for (let aIndex = 1; aIndex < first.length; aIndex += 1) {
    for (let bIndex = 1; bIndex < second.length; bIndex += 1) {
      if (lineIntersection(first[aIndex - 1], first[aIndex], second[bIndex - 1], second[bIndex])) {
        return true;
      }
    }
  }
  return false;
}

function routeCurvedEdges(graph, nodes, metadata) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoingPort = new Map();
  const incomingPort = new Map();

  for (const node of nodes) {
    const outgoing = [...metadata.outgoing.get(node.id)].sort((a, b) => {
      const targetA = nodeById.get(a.target);
      const targetB = nodeById.get(b.target);
      return targetA.y - targetB.y || compareIds(a.target, b.target);
    });
    outgoing.forEach((edge, index) => outgoingPort.set(edge.id, { index, count: outgoing.length }));
    const incoming = [...metadata.incoming.get(node.id)].sort((a, b) => {
      const sourceA = nodeById.get(a.source);
      const sourceB = nodeById.get(b.source);
      return sourceA.y - sourceB.y || compareIds(a.source, b.source);
    });
    incoming.forEach((edge, index) => incomingPort.set(edge.id, { index, count: incoming.length }));
  }

  const ordered = [...graph.edges].sort((a, b) => {
    const spanA = nodeById.get(a.target).layer - nodeById.get(a.source).layer;
    const spanB = nodeById.get(b.target).layer - nodeById.get(b.source).layer;
    return spanB - spanA || compareIds(a.source, b.source) || compareIds(a.target, b.target);
  });
  const routed = [];

  for (const [lane, edge] of ordered.entries()) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const output = outgoingPort.get(edge.id);
    const input = incomingPort.get(edge.id);
    const start = {
      x: source.x + source.width,
      y: source.y + source.height / 2 + portOffset(output.index, output.count, source.height),
    };
    const end = {
      x: target.x,
      y: target.y + target.height / 2 + portOffset(input.index, input.count, target.height),
    };
    const span = Math.max(1, target.layer - source.layer);
    const offsets = span > 1
      ? [0, -90, 90, -180, 180, -320, 320, -520, 520, -760, 760, -1040, 1040]
      : [0, -64, 64, -128, 128, -220, 220];
    let best = null;

    for (const offset of offsets) {
      const horizontal = Math.max(38, (end.x - start.x) * 0.38);
      const controlA = { x: start.x + horizontal, y: start.y + offset };
      const controlB = { x: end.x - horizontal, y: end.y + offset };
      const points = sampledCubic(start, controlA, controlB, end);
      const nodeHits = nodes.filter((node) =>
        node.id !== edge.source &&
        node.id !== edge.target &&
        polylineIntersectsRect(points, node, 8),
      ).length;
      const crossings = routed.filter((candidate) => polylinesCross(points, candidate.points)).length;
      const score = nodeHits * 1_000_000 + crossings * 1_000 + Math.abs(offset);
      if (!best || score < best.score) {
        best = { controlA, controlB, points, score };
      }
      if (nodeHits === 0 && crossings === 0 && offset === 0) break;
    }

    routed.push({
      ...edge,
      lane,
      sourceLayer: source.layer,
      targetLayer: target.layer,
      start,
      end,
      controlA: best.controlA,
      controlB: best.controlB,
      points: best.points,
      path: `M ${rounded(start.x)} ${rounded(start.y)} C ${rounded(best.controlA.x)} ${rounded(best.controlA.y)} ${rounded(best.controlB.x)} ${rounded(best.controlB.y)} ${rounded(end.x)} ${rounded(end.y)}`,
    });
  }

  return graph.edges.map((edge) => routed.find((candidate) => candidate.id === edge.id));
}

function readableRoutePoints(points, nodes, edge) {
  const blockers = nodes.filter(
    (node) => node.id !== edge.source && node.id !== edge.target,
  );
  const simplified = [points[0]];
  let index = 0;
  while (index < points.length - 1) {
    let next = points.length - 1;
    while (
      next > index + 1 &&
      blockers.some((node) => segmentIntersectsRect(points[index], points[next], node, 12))
    ) {
      next -= 1;
    }
    simplified.push(points[next]);
    index = next;
  }
  return simplified.filter(
    (point, pointIndex, route) =>
      pointIndex === 0 ||
      point.x !== route[pointIndex - 1].x ||
      point.y !== route[pointIndex - 1].y,
  );
}

function roundedRoutePath(points, radius = 16) {
  if (points.length < 2) return "";
  const commands = [`M ${rounded(points[0].x)} ${rounded(points[0].y)}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];
    const incomingLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outgoingLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const curve = Math.min(radius, incomingLength / 3, outgoingLength / 3);
    if (curve < 0.5) {
      commands.push(`L ${rounded(corner.x)} ${rounded(corner.y)}`);
      continue;
    }
    const before = {
      x: corner.x - ((corner.x - previous.x) / incomingLength) * curve,
      y: corner.y - ((corner.y - previous.y) / incomingLength) * curve,
    };
    const after = {
      x: corner.x + ((next.x - corner.x) / outgoingLength) * curve,
      y: corner.y + ((next.y - corner.y) / outgoingLength) * curve,
    };
    commands.push(
      `L ${rounded(before.x)} ${rounded(before.y)} Q ${rounded(corner.x)} ${rounded(corner.y)} ${rounded(after.x)} ${rounded(after.y)}`,
    );
  }
  const end = points.at(-1);
  commands.push(`L ${rounded(end.x)} ${rounded(end.y)}`);
  return commands.join(" ");
}

function routeReadableEdges(graph, nodes, metadata, options) {
  return routeEdges(graph, nodes, metadata, options).map((edge) => {
    const points = readableRoutePoints(edge.points, nodes, edge);
    return {
      ...edge,
      points,
      start: points[0],
      end: points.at(-1),
      path: roundedRoutePath(points),
    };
  });
}

function layoutBounds(nodes, edges, padding) {
  if (nodes.length === 0) {
    return {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
    };
  }

  const xs = [];
  const ys = [];
  for (const node of nodes) {
    xs.push(node.x, node.x + node.width);
    ys.push(node.y, node.y + node.height);
  }
  for (const edge of edges) {
    for (const point of edge.points) {
      xs.push(point.x);
      ys.push(point.y);
    }
  }
  const minX = Math.min(...xs) - padding;
  const minY = Math.min(...ys) - padding;
  const maxX = Math.max(...xs) + padding;
  const maxY = Math.max(...ys) + padding;
  return {
    x: rounded(minX),
    y: rounded(minY),
    width: rounded(maxX - minX),
    height: rounded(maxY - minY),
    minX: rounded(minX),
    minY: rounded(minY),
    maxX: rounded(maxX),
    maxY: rounded(maxY),
  };
}

/**
 * Lay out concept cards as fixed-size nodes in a left-to-right prerequisite DAG.
 * A card's `prerequisites` become directed prerequisite -> card edges.
 */
export function layoutGraph(cards, options = {}) {
  const resolved = normalizeOptions(options);
  const graph = normalizeGraphInput(cards);
  const metadata = graphMetadata(graph);

  if (graph.nodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      bounds: layoutBounds([], [], resolved.boundsPadding),
    };
  }

  const layers = orderLayers(graph, metadata, resolved.sweeps);
  const positions = layerPositions(layers);
  const maxRows = Math.max(...layers.map((layer) => layer.length));
  const maxLayerHeight =
    maxRows * resolved.nodeHeight + Math.max(0, maxRows - 1) * resolved.rowGap;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodes = [];

  layers.forEach((layer, level) => {
    const layerHeight =
      layer.length * resolved.nodeHeight +
      Math.max(0, layer.length - 1) * resolved.rowGap;
    const layerTop = resolved.padding + (maxLayerHeight - layerHeight) / 2;
    layer.forEach((id, order) => {
      nodes.push({
        ...nodeById.get(id),
        id,
        x: rounded(
          resolved.padding +
            level * (resolved.nodeWidth + resolved.layerGap) +
            ((order % 3) - 1) * 14,
        ),
        y: rounded(
          layerTop +
            order * (resolved.nodeHeight + resolved.rowGap) +
            (level % 2 === 0 ? -12 : 12),
        ),
        width: resolved.nodeWidth,
        height: resolved.nodeHeight,
        layer: level,
        order,
      });
    });
  });

  const edges = routeReadableEdges(graph, nodes, metadata, resolved);
  const bounds = layoutBounds(nodes, edges, resolved.boundsPadding);

  return { nodes, edges, bounds };
}

/**
 * Re-route an existing layered layout after bounded card pins move. The layer
 * and order stay fixed; only card coordinates, obstacle routes, and bounds are
 * recalculated.
 */
export function reroutePinnedLayout(layout, positionOverrides, options = {}) {
  if (!layout || !Array.isArray(layout.nodes) || !Array.isArray(layout.edges)) {
    throw new GraphValidationError(
      "INVALID_LAYOUT",
      "layout must provide nodes and edges.",
    );
  }
  const positionFor = (id) =>
    positionOverrides?.get?.(id) ?? positionOverrides?.[id] ?? null;
  const nodes = layout.nodes.map((node) => {
    const position = positionFor(node.id);
    if (!position) return { ...node };
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      throw new GraphValidationError(
        "INVALID_PIN",
        `Pinned position for ${node.id} must be finite.`,
        { nodeId: node.id, position },
      );
    }
    return { ...node, x: rounded(position.x), y: rounded(position.y) };
  });
  if (hasNodeCollisions(nodes, options.collisionGap ?? 10)) {
    throw new GraphValidationError(
      "PIN_COLLISION",
      "Pinned cards must not overlap another card.",
    );
  }

  const resolved = normalizeOptions({
    nodeWidth: layout.nodes[0]?.width ?? DEFAULT_LAYOUT_OPTIONS.nodeWidth,
    nodeHeight: layout.nodes[0]?.height ?? DEFAULT_LAYOUT_OPTIONS.nodeHeight,
    ...options,
  });
  const graph = normalizeGraphInput({ nodes, edges: layout.edges });
  const metadata = graphMetadata(graph);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (source.x + source.width + resolved.routeLaneGap * 2 >= target.x) {
      throw new GraphValidationError(
        "PIN_LAYER_ORDER",
        "Pinned cards must preserve left-to-right prerequisite space.",
        { edgeId: edge.id },
      );
    }
  }
  const edges = routeReadableEdges(graph, nodes, metadata, resolved);
  return {
    nodes,
    edges,
    bounds: layoutBounds(nodes, edges, resolved.boundsPadding),
  };
}

function normalizedForHelpers(input) {
  return normalizeGraphInput(input);
}

function assertKnownNode(graph, nodeId) {
  const id = requireId(nodeId, "nodeId");
  if (!graph.nodes.some((node) => node.id === id)) {
    throw new GraphValidationError(
      "UNKNOWN_NODE",
      `Unknown node: ${id}.`,
      { nodeId: id },
    );
  }
  return id;
}

function trace(input, nodeId, direction, options = {}) {
  const graph = normalizedForHelpers(input);
  graphMetadata(graph);
  const start = assertKnownNode(graph, nodeId);
  const requestedDepth = options.transitive === false ? 1 : options.maxDepth;
  const maxDepth = requestedDepth === undefined ? Infinity : requestedDepth;
  if (
    maxDepth !== Infinity &&
    (!Number.isInteger(maxDepth) || maxDepth < 0)
  ) {
    throw new GraphValidationError(
      "INVALID_TRACE_DEPTH",
      "maxDepth must be a non-negative integer or Infinity.",
      { maxDepth },
    );
  }

  const byNode = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    if (direction === "upstream") byNode.get(edge.target).push(edge);
    else byNode.get(edge.source).push(edge);
  }
  for (const edges of byNode.values()) {
    edges.sort(
      (a, b) =>
        compareIds(a.source, b.source) ||
        compareIds(a.target, b.target) ||
        compareIds(a.id, b.id),
    );
  }

  const queue = [{ id: start, depth: 0 }];
  const depths = new Map([[start, 0]]);
  const edgeIds = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth >= maxDepth) continue;
    for (const edge of byNode.get(current.id)) {
      const neighbor = direction === "upstream" ? edge.source : edge.target;
      const nextDepth = current.depth + 1;
      edgeIds.add(edge.id);
      if (!depths.has(neighbor) || nextDepth < depths.get(neighbor)) {
        depths.set(neighbor, nextDepth);
        queue.push({ id: neighbor, depth: nextDepth });
      }
    }
  }

  if (options.includeSelf === false) depths.delete(start);
  return {
    nodeIds: [...depths.keys()].sort(compareIds),
    edgeIds: [...edgeIds].sort(compareIds),
    depths: Object.fromEntries([...depths.entries()].sort(([a], [b]) => compareIds(a, b))),
  };
}

export function traceUpstream(input, nodeId, options = {}) {
  return trace(input, nodeId, "upstream", options);
}

export function traceDownstream(input, nodeId, options = {}) {
  return trace(input, nodeId, "downstream", options);
}

export function focusSubgraph(input, nodeId, options = {}) {
  const graph = normalizedForHelpers(input);
  graphMetadata(graph);
  const start = assertKnownNode(graph, nodeId);
  const upstream = traceUpstream(graph, start, {
    maxDepth: options.upstreamDepth ?? 1,
  });
  const downstream = traceDownstream(graph, start, {
    maxDepth: options.downstreamDepth ?? 1,
  });
  const nodeIds = new Set([start, ...upstream.nodeIds, ...downstream.nodeIds]);
  return {
    nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
    edges: graph.edges.filter(
      (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
    ),
    nodeIds: [...nodeIds].sort(compareIds),
  };
}

export function semanticZoomLevel(scaleOrTransform, thresholds = {}) {
  const scale =
    typeof scaleOrTransform === "number"
      ? scaleOrTransform
      : scaleOrTransform?.scale ?? scaleOrTransform?.k;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new GraphValidationError(
      "INVALID_SCALE",
      "Zoom scale must be a positive finite number.",
      { scale },
    );
  }
  const overviewMax = thresholds.overviewMax ?? 0.38;
  const focusMin = thresholds.focusMin ?? 1.12;
  if (
    !Number.isFinite(overviewMax) ||
    !Number.isFinite(focusMin) ||
    overviewMax <= 0 ||
    focusMin <= overviewMax
  ) {
    throw new GraphValidationError(
      "INVALID_ZOOM_THRESHOLDS",
      "Zoom thresholds must satisfy 0 < overviewMax < focusMin.",
      { overviewMax, focusMin },
    );
  }
  if (scale < overviewMax) return "overview";
  if (scale < focusMin) return "working";
  return "focus";
}

function requireRect(value, label) {
  if (
    !value ||
    !Number.isFinite(value.x ?? 0) ||
    !Number.isFinite(value.y ?? 0) ||
    !Number.isFinite(value.width) ||
    !Number.isFinite(value.height) ||
    value.width < 0 ||
    value.height < 0
  ) {
    throw new GraphValidationError(
      "INVALID_RECT",
      `${label} must provide finite, non-negative width and height.`,
      { label, value },
    );
  }
  return {
    x: value.x ?? 0,
    y: value.y ?? 0,
    width: value.width,
    height: value.height,
  };
}

function normalizedPadding(padding = 32) {
  if (typeof padding === "number") {
    if (!Number.isFinite(padding) || padding < 0) {
      throw new GraphValidationError("INVALID_PADDING", "Padding cannot be negative.");
    }
    return { top: padding, right: padding, bottom: padding, left: padding };
  }
  const result = {
    top: padding?.top ?? 0,
    right: padding?.right ?? 0,
    bottom: padding?.bottom ?? 0,
    left: padding?.left ?? 0,
  };
  if (Object.values(result).some((value) => !Number.isFinite(value) || value < 0)) {
    throw new GraphValidationError("INVALID_PADDING", "Padding cannot be negative.");
  }
  return result;
}

export function fitTransform(boundsInput, viewportInput, options = {}) {
  const bounds = requireRect(boundsInput, "bounds");
  const viewport = requireRect(viewportInput, "viewport");
  const padding = normalizedPadding(options.padding ?? 32);
  const minScale = finitePositive(options.minScale, 0.08, "minScale");
  const maxScale = finitePositive(options.maxScale, 1.5, "maxScale");
  if (minScale > maxScale) {
    throw new GraphValidationError(
      "INVALID_SCALE_RANGE",
      "minScale cannot exceed maxScale.",
    );
  }
  const availableWidth = Math.max(1, viewport.width - padding.left - padding.right);
  const availableHeight = Math.max(1, viewport.height - padding.top - padding.bottom);
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const scale = Math.min(
    maxScale,
    Math.max(minScale, Math.min(availableWidth / width, availableHeight / height)),
  );
  const x =
    viewport.x +
    padding.left +
    (availableWidth - bounds.width * scale) / 2 -
    bounds.x * scale;
  const y =
    viewport.y +
    padding.top +
    (availableHeight - bounds.height * scale) / 2 -
    bounds.y * scale;
  return { x: rounded(x), y: rounded(y), scale: rounded(scale) };
}

/**
 * Fit a graph without making card terms illegible. Small graphs are shown in
 * full. If a full-deck fit would fall below the readable scale, this returns a
 * centered, pannable window around the selected card instead.
 */
export function readableFitTransform(
  boundsInput,
  viewportInput,
  focusInput,
  options = {},
) {
  const bounds = requireRect(boundsInput, "bounds");
  const viewport = requireRect(viewportInput, "viewport");
  const focus = requireRect(focusInput, "focus");
  const padding = normalizedPadding(options.padding ?? 32);
  const minReadableScale = finitePositive(
    options.minReadableScale,
    0.72,
    "minReadableScale",
  );
  const maxScale = finitePositive(options.maxScale, 1.05, "maxScale");
  if (minReadableScale > maxScale) {
    throw new GraphValidationError(
      "INVALID_SCALE_RANGE",
      "minReadableScale cannot exceed maxScale.",
    );
  }
  const full = fitTransform(bounds, viewport, {
    padding,
    minScale: Math.min(0.08, minReadableScale),
    maxScale,
  });
  if (full.scale >= minReadableScale) {
    return { ...full, strategy: "full-graph", fullGraphVisible: true };
  }

  const availableWidth = Math.max(
    1,
    viewport.width - padding.left - padding.right,
  );
  const availableHeight = Math.max(
    1,
    viewport.height - padding.top - padding.bottom,
  );
  const scale = minReadableScale;
  return {
    x: rounded(
      viewport.x +
        padding.left +
        (availableWidth - focus.width * scale) / 2 -
        focus.x * scale,
    ),
    y: rounded(
      viewport.y +
        padding.top +
        (availableHeight - focus.height * scale) / 2 -
        focus.y * scale,
    ),
    scale: rounded(scale),
    strategy: "readable-window",
    fullGraphVisible: false,
  };
}

export function clampTransform(
  transform,
  boundsInput,
  viewportInput,
  options = {},
) {
  const bounds = requireRect(boundsInput, "bounds");
  const viewport = requireRect(viewportInput, "viewport");
  const scale = transform?.scale ?? transform?.k;
  if (
    !Number.isFinite(transform?.x) ||
    !Number.isFinite(transform?.y) ||
    !Number.isFinite(scale) ||
    scale <= 0
  ) {
    throw new GraphValidationError(
      "INVALID_TRANSFORM",
      "Transform must provide finite x, y, and positive scale.",
      { transform },
    );
  }
  const visibleMargin = finiteNonNegative(
    options.visibleMargin,
    48,
    "visibleMargin",
  );
  const centerSmall = options.centerSmall !== false;

  function clampAxis(position, contentStart, contentSize, viewportStart, viewportSize) {
    const axisMargin = Math.min(visibleMargin, viewportSize / 2);
    const scaledSize = contentSize * scale;
    if (centerSmall && scaledSize <= viewportSize - axisMargin * 2) {
      return (
        viewportStart +
        (viewportSize - scaledSize) / 2 -
        contentStart * scale
      );
    }
    const minimum =
      viewportStart + axisMargin - (contentStart + contentSize) * scale;
    const maximum =
      viewportStart + viewportSize - axisMargin - contentStart * scale;
    return Math.min(maximum, Math.max(minimum, position));
  }

  return {
    x: rounded(
      clampAxis(transform.x, bounds.x, bounds.width, viewport.x, viewport.width),
    ),
    y: rounded(
      clampAxis(transform.y, bounds.y, bounds.height, viewport.y, viewport.height),
    ),
    scale: rounded(scale),
  };
}

export function findNodeCollisions(nodes, gap = 0) {
  if (!Array.isArray(nodes)) {
    throw new GraphValidationError("INVALID_NODES", "nodes must be an array.");
  }
  if (!Number.isFinite(gap) || gap < 0) {
    throw new GraphValidationError("INVALID_COLLISION_GAP", "gap cannot be negative.");
  }
  const ordered = [...nodes].sort((a, b) => compareIds(a.id, b.id));
  const collisions = [];
  for (let first = 0; first < ordered.length; first += 1) {
    const a = ordered[first];
    requireRect(a, `node ${a.id}`);
    for (let second = first + 1; second < ordered.length; second += 1) {
      const b = ordered[second];
      requireRect(b, `node ${b.id}`);
      const overlapX =
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY =
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (overlapX > -gap && overlapY > -gap) {
        collisions.push({
          a: a.id,
          b: b.id,
          overlapX: rounded(Math.max(0, overlapX)),
          overlapY: rounded(Math.max(0, overlapY)),
        });
      }
    }
  }
  return collisions;
}

export function hasNodeCollisions(nodes, gap = 0) {
  return findNodeCollisions(nodes, gap).length > 0;
}

function edgeSegments(edges) {
  if (!Array.isArray(edges)) {
    throw new GraphValidationError("INVALID_EDGES", "edges must be an array.");
  }
  return edges.flatMap((edge) => {
    if (!Array.isArray(edge?.points) || edge.points.length < 2) {
      throw new GraphValidationError(
        "INVALID_EDGE_POINTS",
        `Edge ${edge?.id ?? "(unknown)"} must provide at least two points.`,
      );
    }
    return edge.points.slice(1).map((point, index) => {
      const start = edge.points[index];
      if (
        !Number.isFinite(start?.x) ||
        !Number.isFinite(start?.y) ||
        !Number.isFinite(point?.x) ||
        !Number.isFinite(point?.y) ||
        (start.x === point.x && start.y === point.y)
      ) {
        throw new GraphValidationError(
          "INVALID_EDGE_SEGMENT",
          `Edge ${edge.id} segment ${index} must be finite and non-zero.`,
        );
      }
      return {
        edgeId: edge.id,
        index,
        start,
        end: point,
        orientation:
          start.y === point.y
            ? "horizontal"
            : start.x === point.x
              ? "vertical"
              : "diagonal",
        x1: Math.min(start.x, point.x),
        x2: Math.max(start.x, point.x),
        y1: Math.min(start.y, point.y),
        y2: Math.max(start.y, point.y),
      };
    });
  });
}

/** Return every pair of distinct edges sharing a positive-length segment. */
export function findEdgeSegmentOverlaps(edges) {
  const segments = edgeSegments(edges);
  const overlaps = [];
  for (let first = 0; first < segments.length; first += 1) {
    const a = segments[first];
    for (let second = first + 1; second < segments.length; second += 1) {
      const b = segments[second];
      if (
        a.edgeId === b.edgeId ||
        a.orientation !== b.orientation ||
        a.orientation === "diagonal"
      ) continue;
      if (a.orientation === "horizontal" && a.y1 === b.y1) {
        const length = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        if (length > 0) {
          overlaps.push({
            a: a.edgeId,
            b: b.edgeId,
            orientation: a.orientation,
            coordinate: a.y1,
            length: rounded(length),
          });
        }
      } else if (a.orientation === "vertical" && a.x1 === b.x1) {
        const length = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        if (length > 0) {
          overlaps.push({
            a: a.edgeId,
            b: b.edgeId,
            orientation: a.orientation,
            coordinate: a.x1,
            length: rounded(length),
          });
        }
      }
    }
  }
  return overlaps;
}

function pointOnSegment(point, start, end, tolerance = 0.001) {
  const cross = (point.x - start.x) * (end.y - start.y) -
    (point.y - start.y) * (end.x - start.x);
  if (Math.abs(cross) > tolerance) return false;
  return point.x >= Math.min(start.x, end.x) - tolerance &&
    point.x <= Math.max(start.x, end.x) + tolerance &&
    point.y >= Math.min(start.y, end.y) - tolerance &&
    point.y <= Math.max(start.y, end.y) + tolerance;
}

function directionKey(dx, dy) {
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return null;
  return `${rounded(dx / length)}:${rounded(dy / length)}`;
}

function raysAt(segments, point) {
  const rays = new Set();
  for (const segment of segments) {
    if (!pointOnSegment(point, segment.start, segment.end)) continue;
    const toStart = directionKey(segment.start.x - point.x, segment.start.y - point.y);
    const toEnd = directionKey(segment.end.x - point.x, segment.end.y - point.y);
    if (toStart) rays.add(toStart);
    if (toEnd) rays.add(toEnd);
  }
  return rays;
}

/**
 * Return visible four-arm junctions between distinct edge polylines. This
 * counts ordinary segment-interior crossings and complementary bend-to-bend
 * crossings, while excluding card ports and simple endpoint touches.
 */
export function findEdgeCrossings(edges) {
  const crossings = [];
  for (let first = 0; first < edges.length; first += 1) {
    const a = edges[first];
    for (let second = first + 1; second < edges.length; second += 1) {
      const b = edges[second];
      const aSegments = edgeSegments([a]);
      const bSegments = edgeSegments([b]);
      const candidates = new Map();
      const addCandidate = (point) => {
        candidates.set(`${coordinateKey(point.x)}:${coordinateKey(point.y)}`, point);
      };
      for (const aSegment of aSegments) {
        for (const bSegment of bSegments) {
          const point = lineIntersection(
            aSegment.start,
            aSegment.end,
            bSegment.start,
            bSegment.end,
          );
          if (point) addCandidate(point);
        }
      }
      for (const point of [...a.points, ...b.points]) {
        if (aSegments.some((segment) => pointOnSegment(point, segment.start, segment.end)) &&
          bSegments.some((segment) => pointOnSegment(point, segment.start, segment.end))) {
          addCandidate(point);
        }
      }

      for (const point of candidates.values()) {
        const isPort = [a.start, a.end, b.start, b.end]
          .filter(Boolean)
          .some((port) =>
            Math.abs(port.x - point.x) < 0.5 && Math.abs(port.y - point.y) < 0.5,
        );
        if (isPort) continue;
        const aRays = raysAt(aSegments, point);
        const bRays = raysAt(bSegments, point);
        const allRays = new Set([...aRays, ...bRays]);
        if (aRays.size < 2 || bRays.size < 2 || allRays.size < 4) continue;
        crossings.push({ a: a.id, b: b.id, ...point });
      }
    }
  }
  return crossings;
}

export function countEdgeCrossings(edges) {
  return findEdgeCrossings(edges).length;
}

/** Return edge segments that pass through a non-endpoint card rectangle. */
export function findEdgeNodeIntersections(edges, nodes) {
  const segments = edgeSegments(edges);
  const nodeList = Array.isArray(nodes) ? nodes : [];
  nodeList.forEach((node) => requireRect(node, `node ${node.id}`));
  const intersections = [];
  for (const segment of segments) {
    const edge = edges.find((candidate) => candidate.id === segment.edgeId);
    for (const node of nodeList) {
      if (node.id === edge.source || node.id === edge.target) continue;
      const crosses = segmentIntersectsRect(segment.start, segment.end, node, 0);
      if (crosses) {
        intersections.push({
          edgeId: segment.edgeId,
          segmentIndex: segment.index,
          nodeId: node.id,
        });
      }
    }
  }
  return intersections;
}
