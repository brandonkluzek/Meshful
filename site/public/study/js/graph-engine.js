const DEFAULT_LAYOUT_OPTIONS = Object.freeze({
  nodeWidth: 174,
  nodeHeight: 64,
  layerGap: 112,
  forwardGap: 76,
  idealEdgeGap: 96,
  layerDrift: null,
  rowGap: 36,
  padding: 56,
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
    forwardGap: finiteNonNegative(
      options.forwardGap,
      DEFAULT_LAYOUT_OPTIONS.forwardGap,
      "forwardGap",
    ),
    idealEdgeGap: finiteNonNegative(
      options.idealEdgeGap,
      DEFAULT_LAYOUT_OPTIONS.idealEdgeGap,
      "idealEdgeGap",
    ),
    layerDrift: options.layerDrift == null
      ? DEFAULT_LAYOUT_OPTIONS.layerDrift
      : finiteNonNegative(options.layerDrift, 0, "layerDrift"),
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

function layerEdgeLength(graph, layers) {
  const positions = layerPositions(layers);
  return graph.edges.reduce((total, edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    const sourceLayer = layers[source.level];
    const targetLayer = layers[target.level];
    const sourceCenter = source.order - (sourceLayer.length - 1) / 2;
    const targetCenter = target.order - (targetLayer.length - 1) / 2;
    return total + Math.abs(targetCenter - sourceCenter);
  }, 0);
}

function betterLayerOrder(candidate, best) {
  return candidate.crossings < best.crossings ||
    (candidate.crossings === best.crossings && candidate.length < best.length) ||
    (candidate.crossings === best.crossings &&
      candidate.length === best.length &&
      candidate.signature < best.signature);
}

function transposeLayers(graph, layers, levels) {
  let current = {
    crossings: crossingCount(graph, layers, levels),
    length: layerEdgeLength(graph, layers),
    signature: layerSignature(layers),
  };
  let changed = true;
  let passes = 0;
  while (changed && passes < 6) {
    changed = false;
    passes += 1;
    for (const layer of layers) {
      for (let index = 0; index < layer.length - 1; index += 1) {
        [layer[index], layer[index + 1]] = [layer[index + 1], layer[index]];
        const candidate = {
          crossings: crossingCount(graph, layers, levels),
          length: layerEdgeLength(graph, layers),
          signature: layerSignature(layers),
        };
        if (
          candidate.crossings < current.crossings ||
          (candidate.crossings === current.crossings && candidate.length < current.length)
        ) {
          current = candidate;
          changed = true;
        } else {
          [layer[index], layer[index + 1]] = [layer[index + 1], layer[index]];
        }
      }
    }
  }
  return current;
}

function orderLayers(graph, metadata, sweeps) {
  const maxLevel = Math.max(0, ...metadata.levels.values());
  let layers = Array.from({ length: maxLevel + 1 }, () => []);
  for (const node of graph.nodes) layers[metadata.levels.get(node.id)].push(node.id);
  for (const layer of layers) layer.sort(compareIds);

  let best = layers.map((layer) => [...layer]);
  let bestScore = {
    crossings: crossingCount(graph, best, metadata.levels),
    length: layerEdgeLength(graph, best),
    signature: layerSignature(best),
  };

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

    const score = transposeLayers(graph, layers, metadata.levels);
    if (betterLayerOrder(score, bestScore)) {
      best = layers.map((layer) => [...layer]);
      bestScore = score;
    }
  }
  return best;
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function projectSeparatedCenters(desired, separation) {
  const blocks = [];
  desired.forEach((value, index) => {
    blocks.push({
      start: index,
      end: index,
      sum: value - index * separation,
      count: 1,
    });
    while (blocks.length > 1) {
      const current = blocks.at(-1);
      const previous = blocks.at(-2);
      if (previous.sum / previous.count <= current.sum / current.count) break;
      blocks.splice(-2, 2, {
        start: previous.start,
        end: current.end,
        sum: previous.sum + current.sum,
        count: previous.count + current.count,
      });
    }
  });
  const result = Array(desired.length);
  for (const block of blocks) {
    const mean = block.sum / block.count;
    for (let index = block.start; index <= block.end; index += 1) {
      result[index] = mean + index * separation;
    }
  }
  return result;
}

function optimizedVerticalCenters(layers, metadata, options) {
  const separation = options.nodeHeight + options.rowGap;
  const maxRows = Math.max(...layers.map((layer) => layer.length));
  const maxHeight = maxRows * options.nodeHeight + Math.max(0, maxRows - 1) * options.rowGap;
  const centers = new Map();

  layers.forEach((layer) => {
    const layerHeight = layer.length * options.nodeHeight +
      Math.max(0, layer.length - 1) * options.rowGap;
    const top = options.padding + (maxHeight - layerHeight) / 2;
    layer.forEach((id, order) => {
      centers.set(id, top + order * separation + options.nodeHeight / 2);
    });
  });

  const updateLayer = (level) => {
    const ids = layers[level];
    const desired = ids.map((id) => {
      const neighbors = [
        ...metadata.incoming.get(id).map((edge) => edge.source),
        ...metadata.outgoing.get(id).map((edge) => edge.target),
      ].map((neighborId) => centers.get(neighborId)).filter(Number.isFinite);
      if (neighbors.length === 0) return centers.get(id);
      return median(neighbors) * 0.76 + centers.get(id) * 0.24;
    });
    const projected = projectSeparatedCenters(desired, separation);
    ids.forEach((id, index) => centers.set(id, projected[index]));
  };

  const iterations = Math.max(4, options.sweeps);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let level = 1; level < layers.length; level += 1) updateLayer(level);
    for (let level = layers.length - 2; level >= 0; level -= 1) updateLayer(level);
  }

  const minimumTop = Math.min(...centers.values()) - options.nodeHeight / 2;
  const shift = options.padding - minimumTop;
  for (const [id, center] of centers) centers.set(id, center + shift);
  return centers;
}

function relaxedNodePositions(graph, layers, metadata, options) {
  const verticalCenters = optimizedVerticalCenters(layers, metadata, options);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const positions = new Map();
  const anchors = new Map();
  const minimumForward = options.nodeWidth + Math.max(options.forwardGap, options.layerGap * 0.62);
  const idealDistance = options.nodeWidth + Math.max(options.idealEdgeGap, options.layerGap * 0.74);

  layers.forEach((layer, level) => {
    layer.forEach((id, order) => {
      const position = {
        x: options.padding + level * (options.nodeWidth + options.layerGap),
        y: verticalCenters.get(id) - options.nodeHeight / 2,
      };
      positions.set(id, position);
      anchors.set(id, { ...position, order, level });
    });
  });

  const sortedNodes = [...graph.nodes].sort((a, b) => compareIds(a.id, b.id));
  const sortedEdges = [...graph.edges].sort((a, b) =>
    compareIds(a.source, b.source) || compareIds(a.target, b.target) || compareIds(a.id, b.id),
  );
  const intermediateNodesByEdge = new Map(sortedEdges.map((edge) => {
    const sourceLevel = anchors.get(edge.source).level;
    const targetLevel = anchors.get(edge.target).level;
    const blockers = layers
      .slice(sourceLevel + 1, targetLevel)
      .flat()
      .map((id) => nodeById.get(id));
    return [edge.id, blockers];
  }));
  const projectFlow = () => {
    for (let pass = 0; pass < 4; pass += 1) {
      for (const edge of sortedEdges) {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        const shortfall = minimumForward - (target.x - source.x);
        if (shortfall <= 0) continue;
        source.x -= shortfall / 2;
        target.x += shortfall / 2;
      }
    }
  };

  const positionIterations = graph.nodes.length > 320
    ? 22
    : graph.nodes.length > 200
      ? 32
      : graph.nodes.length > 150
        ? 52
        : 80;
  for (let iteration = 0; iteration < positionIterations; iteration += 1) {
    const alpha = Math.max(0.16, 1 - iteration / (positionIterations + 12));
    const deltas = new Map(sortedNodes.map((node) => [node.id, { x: 0, y: 0 }]));

    for (const edge of sortedEdges) {
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      const deltaX = target.x - source.x;
      const deltaY = target.y - source.y;
      const distance = Math.max(1, Math.hypot(deltaX, deltaY));
      const pull = Math.max(-10, Math.min(10, (distance - idealDistance) * 0.035 * alpha));
      const xPull = (deltaX / distance) * pull / 2;
      const yPull = (deltaY / distance) * pull / 2;
      deltas.get(edge.source).x += xPull;
      deltas.get(edge.source).y += yPull;
      deltas.get(edge.target).x -= xPull;
      deltas.get(edge.target).y -= yPull;
    }

    for (const node of sortedNodes) {
      const position = positions.get(node.id);
      const anchor = anchors.get(node.id);
      const delta = deltas.get(node.id);
      position.x += delta.x;
      position.y += delta.y + (anchor.y - position.y) * 0.018 * alpha;
      if (options.layerDrift !== null) {
        position.x += (anchor.x - position.x) * 0.12 * alpha;
        position.x = Math.max(
          anchor.x - options.layerDrift,
          Math.min(anchor.x + options.layerDrift, position.x),
        );
      }
    }

    for (let pass = 0; options.layerDrift === null && pass < 3; pass += 1) {
      for (let first = 0; first < sortedNodes.length; first += 1) {
        const firstNode = sortedNodes[first];
        const firstPosition = positions.get(firstNode.id);
        for (let second = first + 1; second < sortedNodes.length; second += 1) {
          const secondNode = sortedNodes[second];
          const secondPosition = positions.get(secondNode.id);
          const deltaX = secondPosition.x - firstPosition.x;
          const deltaY = secondPosition.y - firstPosition.y;
          const overlapX = options.nodeWidth + 24 - Math.abs(deltaX);
          const overlapY = options.nodeHeight + 24 - Math.abs(deltaY);
          if (overlapX <= 0 || overlapY <= 0) continue;
          const sameLayer = anchors.get(firstNode.id).level === anchors.get(secondNode.id).level;
          if (sameLayer || overlapY <= overlapX * 1.15) {
            const direction = deltaY === 0
              ? (compareIds(firstNode.id, secondNode.id) < 0 ? 1 : -1)
              : Math.sign(deltaY);
            firstPosition.y -= direction * overlapY * 0.52;
            secondPosition.y += direction * overlapY * 0.52;
          } else {
            const direction = deltaX === 0
              ? (compareIds(firstNode.id, secondNode.id) < 0 ? 1 : -1)
              : Math.sign(deltaX);
            firstPosition.x -= direction * overlapX * 0.52;
            secondPosition.x += direction * overlapX * 0.52;
          }
        }
      }
    }

    for (const edge of sortedEdges) {
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      const sourceCenter = {
        x: source.x + options.nodeWidth / 2,
        y: source.y + options.nodeHeight / 2,
      };
      const targetCenter = {
        x: target.x + options.nodeWidth / 2,
        y: target.y + options.nodeHeight / 2,
      };
      const span = targetCenter.x - sourceCenter.x;
      if (span <= 1) continue;
      for (const node of intermediateNodesByEdge.get(edge.id)) {
        const position = positions.get(node.id);
        const center = {
          x: position.x + options.nodeWidth / 2,
          y: position.y + options.nodeHeight / 2,
        };
        const amount = (center.x - sourceCenter.x) / span;
        if (amount <= 0.04 || amount >= 0.96) continue;
        const easedAmount = amount * amount * (3 - 2 * amount);
        const lineY = sourceCenter.y + (targetCenter.y - sourceCenter.y) * easedAmount;
        const slope = Math.abs(
          (targetCenter.y - sourceCenter.y) * 6 * amount * (1 - amount) / span,
        );
        const clearance = options.nodeHeight / 2 + slope * options.nodeWidth / 2 + 28;
        const delta = center.y - lineY;
        if (Math.abs(delta) >= clearance) continue;
        const direction = delta === 0
          ? (compareIds(node.id, edge.id) < 0 ? -1 : 1)
          : Math.sign(delta);
        position.y += direction * (clearance - Math.abs(delta)) * 0.32 * alpha;
      }
    }

    for (const layer of layers) {
      const desired = layer.map((id) => positions.get(id).y + options.nodeHeight / 2);
      const projected = projectSeparatedCenters(desired, options.nodeHeight + options.rowGap);
      layer.forEach((id, index) => {
        positions.get(id).y = projected[index] - options.nodeHeight / 2;
      });
    }
    projectFlow();
  }

  for (const id of metadata.topological) {
    for (const edge of metadata.outgoing.get(id)) {
      const source = positions.get(id);
      const target = positions.get(edge.target);
      target.x = Math.max(target.x, source.x + minimumForward);
    }
  }

  const minimumX = Math.min(...[...positions.values()].map((position) => position.x));
  const minimumY = Math.min(...[...positions.values()].map((position) => position.y));
  for (const position of positions.values()) {
    position.x = rounded(position.x + options.padding - minimumX);
    position.y = rounded(position.y + options.padding - minimumY);
  }
  return positions;
}

function stableUnit(value) {
  let hash = 2_166_136_261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 4_294_967_295;
}

function explicitGraphGroupKey(node) {
  const moduleTag = (node.tags ?? []).find((tag) => /(?:^|-)m\d+$/i.test(String(tag)));
  if (moduleTag) return String(moduleTag).toLocaleLowerCase();
  const idModule = String(node.id).match(/\.([a-z0-9]+-m\d+)-/i)?.[1];
  return idModule?.toLocaleLowerCase() ?? null;
}

function undirectedNeighbors(graph) {
  const neighbors = new Map(graph.nodes.map((node) => [node.id, new Set()]));
  for (const edge of graph.edges) {
    neighbors.get(edge.source).add(edge.target);
    neighbors.get(edge.target).add(edge.source);
  }
  return neighbors;
}

function weakComponentKeys(graph, neighbors) {
  const seen = new Set();
  const components = [];
  const orderedIds = graph.nodes.map((node) => node.id).sort(compareIds);
  for (const start of orderedIds) {
    if (seen.has(start)) continue;
    const queue = [start];
    const members = [];
    seen.add(start);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      members.push(current);
      for (const next of [...neighbors.get(current)].sort(compareIds)) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    members.sort(compareIds);
    components.push(members);
  }
  components.sort((left, right) =>
    right.length - left.length || compareIds(left[0], right[0]),
  );
  return new Map(components.flatMap((members, index) =>
    members.map((id) => [id, `component-${index}`]),
  ));
}

function graphDistances(start, neighbors) {
  const distances = new Map([[start, 0]]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const nextDistance = distances.get(current) + 1;
    const adjacent = [...neighbors.get(current)].sort(compareIds);
    for (const next of adjacent) {
      if (distances.has(next)) continue;
      distances.set(next, nextDistance);
      queue.push(next);
    }
  }
  return distances;
}

// Some older decks have no reliable module tags. In that case, derive stable
// graph-distance neighborhoods rather than falling back to one giant cluster.
// Farthest-point seeds spread through the prerequisite topology; multi-source
// assignment then keeps closely related cards in the same visual neighborhood.
function graphGroupKeys(graph) {
  const neighbors = undirectedNeighbors(graph);
  const componentKeys = weakComponentKeys(graph, neighbors);
  const componentCount = new Set(componentKeys.values()).size;
  const componentSizes = new Map();
  for (const key of componentKeys.values()) {
    componentSizes.set(key, (componentSizes.get(key) ?? 0) + 1);
  }
  const largestComponent = Math.max(0, ...componentSizes.values());
  if (componentCount > 1 && largestComponent <= graph.nodes.length * 0.45) {
    return { keys: componentKeys, inferred: true };
  }

  const explicit = new Map(graph.nodes.map((node) => [node.id, explicitGraphGroupKey(node)]));
  const explicitKeys = new Set([...explicit.values()].filter(Boolean));
  if (explicitKeys.size > 1 || graph.nodes.length < 24) {
    return {
      keys: new Map(graph.nodes.map((node) => [node.id, explicit.get(node.id) ?? "concepts"])),
      inferred: false,
    };
  }

  const ordered = [...graph.nodes].sort((a, b) => compareIds(a.id, b.id));
  const targetGroups = Math.max(2, Math.min(12, Math.ceil(ordered.length / 20)));
  const firstSeed = [...ordered].sort((left, right) =>
    neighbors.get(right.id).size - neighbors.get(left.id).size || compareIds(left.id, right.id),
  )[0].id;
  const seeds = [firstSeed];
  const nearestDistance = new Map(ordered.map((node) => [node.id, Infinity]));

  while (seeds.length < targetGroups) {
    const latestDistances = graphDistances(seeds.at(-1), neighbors);
    for (const node of ordered) {
      nearestDistance.set(
        node.id,
        Math.min(nearestDistance.get(node.id), latestDistances.get(node.id) ?? Infinity),
      );
    }
    const candidate = [...ordered]
      .filter((node) => !seeds.includes(node.id))
      .sort((left, right) => {
        const leftDistance = nearestDistance.get(left.id);
        const rightDistance = nearestDistance.get(right.id);
        if (leftDistance !== rightDistance) return rightDistance - leftDistance;
        const degreeDifference = neighbors.get(right.id).size - neighbors.get(left.id).size;
        return degreeDifference || compareIds(left.id, right.id);
      })[0];
    if (!candidate) break;
    seeds.push(candidate.id);
  }

  const distancesBySeed = seeds.map((seed) => graphDistances(seed, neighbors));
  return { keys: new Map(ordered.map((node) => {
    let bestIndex = 0;
    let bestDistance = Infinity;
    distancesBySeed.forEach((distances, index) => {
      const distance = distances.get(node.id) ?? Infinity;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return [node.id, `neighborhood-${bestIndex}`];
  })), inferred: true };
}

function circularGroupCost(order, weights) {
  if (order.length <= 2) return 0;
  const positions = new Map(order.map((key, index) => [key, index]));
  let cost = 0;
  for (const [pair, weight] of weights) {
    const [left, right] = pair.split("\u0000");
    const delta = Math.abs(positions.get(left) - positions.get(right));
    const circularDistance = Math.min(delta, order.length - delta);
    cost += weight * circularDistance;
  }
  return cost;
}

function relationshipOrderedGroups(groups, graph, groupKeys) {
  const keys = [...groups.keys()].sort(compareIds);
  if (keys.length <= 2) return keys;
  const weights = new Map();
  for (const edge of graph.edges) {
    const sourceGroup = groupKeys.get(edge.source);
    const targetGroup = groupKeys.get(edge.target);
    if (sourceGroup === targetGroup) continue;
    const pair = [sourceGroup, targetGroup].sort(compareIds).join("\u0000");
    weights.set(pair, (weights.get(pair) ?? 0) + 1);
  }

  let best = [...keys];
  let bestCost = circularGroupCost(best, weights);
  let changed = true;
  for (let pass = 0; changed && pass < keys.length * 2; pass += 1) {
    changed = false;
    for (let first = 0; first < best.length - 1; first += 1) {
      for (let second = first + 1; second < best.length; second += 1) {
        const candidate = [...best];
        [candidate[first], candidate[second]] = [candidate[second], candidate[first]];
        const cost = circularGroupCost(candidate, weights);
        const signature = candidate.join("\u0001");
        const bestSignature = best.join("\u0001");
        if (cost < bestCost || (cost === bestCost && signature < bestSignature)) {
          best = candidate;
          bestCost = cost;
          changed = true;
        }
      }
    }
  }
  return best;
}

// Place a deck as a compact branching web instead of a rank-by-rank barcode.
// Real curriculum modules seed stable circular neighborhoods; prerequisite
// springs then pull related cards together while short-range repulsion and a
// final collision pass keep labels readable. The result is deterministic.
function webNodePositions(graph, metadata, options) {
  const orderedNodes = [...graph.nodes].sort((a, b) => compareIds(a.id, b.id));
  const indexById = new Map(orderedNodes.map((node, index) => [node.id, index]));
  const grouping = graphGroupKeys(graph);
  const groupKeys = grouping.keys;
  const groups = new Map();
  for (const node of orderedNodes) {
    const key = groupKeys.get(node.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const groupOrder = relationshipOrderedGroups(groups, graph, groupKeys);
  const groupEntries = groupOrder.map((key) => [key, groups.get(key)]);
  const nodeArea = (options.nodeWidth + options.rowGap * 0.7) *
    (options.nodeHeight + options.rowGap * 0.7);
  const largestGroup = Math.max(1, ...groupEntries.map(([, members]) => members.length));
  const clusterRadius = Math.max(230, Math.sqrt(largestGroup * nodeArea / (Math.PI * 0.5)));
  const groupCount = groupEntries.length;
  const deckRadius = Math.sqrt(orderedNodes.length * nodeArea / (Math.PI * 0.62));
  const orbitRadius = groupCount <= 1
    ? 0
    : Math.max(clusterRadius * 1.15, deckRadius - clusterRadius * 0.7);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const centers = Array.from({ length: orderedNodes.length }, () => ({ x: 0, y: 0 }));
  const targetCenters = new Map();

  groupEntries.forEach(([key, members], groupIndex) => {
    const groupAngle = groupCount <= 1
      ? 0
      : -Math.PI / 2 + groupIndex * Math.PI * 2 / groupCount;
    const groupRadius = groupCount <= 1
      ? 0
      : orbitRadius * (groupCount >= 5 && groupIndex % 2 === 0 ? 0.48 : 1);
    const target = {
      x: Math.cos(groupAngle) * groupRadius,
      y: Math.sin(groupAngle) * groupRadius,
    };
    targetCenters.set(key, target);
    members.sort((a, b) =>
      metadata.levels.get(a.id) - metadata.levels.get(b.id) || compareIds(a.id, b.id),
    );
    const localStep = Math.sqrt(nodeArea / Math.PI) * 0.9;
    members.forEach((node, localIndex) => {
      const phase = stableUnit(node.id) * 0.7;
      const angle = goldenAngle * localIndex + groupAngle + phase;
      const radius = localStep * Math.sqrt(localIndex + 0.5);
      const position = centers[indexById.get(node.id)];
      position.x = target.x + Math.cos(angle) * radius;
      position.y = target.y + Math.sin(angle) * radius;
    });
  });

  const velocities = centers.map(() => ({ x: 0, y: 0 }));
  const springs = graph.edges.map((edge) => ({
    source: indexById.get(edge.source),
    target: indexById.get(edge.target),
  }));
  const groupForIndex = orderedNodes.map((node) => targetCenters.get(groupKeys.get(node.id)));
  const idealLength = Math.max(options.nodeWidth + 64, 210);
  const interactionRange = Math.max(idealLength * 2.15, 440);
  const iterations = graph.nodes.length > 320 ? 74 : graph.nodes.length > 200 ? 92 : 142;
  const horizontalClearance = options.nodeWidth + Math.max(22, options.rowGap * 0.7);
  const verticalClearance = options.nodeHeight + Math.max(22, options.rowGap * 0.7);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const alpha = 1 - iteration / iterations;
    const forces = centers.map(() => ({ x: 0, y: 0 }));
    for (const edge of springs) {
      const source = centers[edge.source];
      const target = centers[edge.target];
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const pull = Math.max(-22, Math.min(22, (distance - idealLength) * 0.06));
      const fx = dx / distance * pull;
      const fy = dy / distance * pull;
      forces[edge.source].x += fx;
      forces[edge.source].y += fy;
      forces[edge.target].x -= fx;
      forces[edge.target].y -= fy;
    }

    for (let first = 0; first < centers.length; first += 1) {
      for (let second = first + 1; second < centers.length; second += 1) {
        const dx = centers[second].x - centers[first].x;
        const dy = centers[second].y - centers[first].y;
        if (Math.abs(dx) > interactionRange || Math.abs(dy) > interactionRange) continue;
        const distanceSquared = Math.max(64, dx * dx + dy * dy);
        const distance = Math.sqrt(distanceSquared);
        let push = Math.min(5.5, 5_200 / distanceSquared);
        const overlapX = horizontalClearance - Math.abs(dx);
        const overlapY = verticalClearance - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          const normalizedOverlap = Math.min(
            overlapX / horizontalClearance,
            overlapY / verticalClearance,
          );
          push += 2 + normalizedOverlap * 10;
        }
        const fx = dx / distance * push;
        const fy = dy / distance * push;
        forces[first].x -= fx;
        forces[first].y -= fy;
        forces[second].x += fx;
        forces[second].y += fy;
      }
    }

    for (let index = 0; index < centers.length; index += 1) {
      const target = groupForIndex[index];
      forces[index].x += (target.x - centers[index].x) * 0.004;
      forces[index].y += (target.y - centers[index].y) * 0.004;
      velocities[index].x = (velocities[index].x + forces[index].x * alpha) * 0.76;
      velocities[index].y = (velocities[index].y + forces[index].y * alpha) * 0.76;
      centers[index].x += velocities[index].x;
      centers[index].y += velocities[index].y;
    }
  }

  // Open modest corridors for prerequisite strands before the final collision
  // pass. This is deliberately bounded and deterministic: it moves only cards
  // that sit inside the middle of an unrelated edge's direct corridor, while
  // sharing a small counter-force across that edge's endpoints. The router can
  // then use a gentle S instead of taking an extreme detour through another
  // card. Forces are capped so dense decks expand rather than explode.
  const corridorPasses = graph.nodes.length > 320 ? 4 : 7;
  for (let pass = 0; pass < corridorPasses; pass += 1) {
    const corridorForces = centers.map(() => ({ x: 0, y: 0 }));
    let conflicts = 0;
    for (const edge of springs) {
      const source = centers[edge.source];
      const target = centers[edge.target];
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared < 1) continue;
      const length = Math.sqrt(lengthSquared);
      const normal = { x: -dy / length, y: dx / length };
      const halfExtent =
        Math.abs(normal.x) * options.nodeWidth / 2 +
        Math.abs(normal.y) * options.nodeHeight / 2;
      const clearance = halfExtent + 14;
      for (let blocker = 0; blocker < centers.length; blocker += 1) {
        if (blocker === edge.source || blocker === edge.target) continue;
        const point = centers[blocker];
        const amount = ((point.x - source.x) * dx + (point.y - source.y) * dy) /
          lengthSquared;
        if (amount <= 0.1 || amount >= 0.9) continue;
        const closest = {
          x: source.x + dx * amount,
          y: source.y + dy * amount,
        };
        const signedDistance =
          (point.x - closest.x) * normal.x +
          (point.y - closest.y) * normal.y;
        if (Math.abs(signedDistance) >= clearance) continue;
        conflicts += 1;
        const direction = signedDistance === 0
          ? (stableUnit(`${orderedNodes[blocker].id}:${orderedNodes[edge.source].id}:${orderedNodes[edge.target].id}`) < 0.5 ? -1 : 1)
          : Math.sign(signedDistance);
        const push = Math.min(18, (clearance - Math.abs(signedDistance)) * 0.22);
        const fx = normal.x * direction * push;
        const fy = normal.y * direction * push;
        corridorForces[blocker].x += fx;
        corridorForces[blocker].y += fy;
        corridorForces[edge.source].x -= fx * 0.1;
        corridorForces[edge.source].y -= fy * 0.1;
        corridorForces[edge.target].x -= fx * 0.1;
        corridorForces[edge.target].y -= fy * 0.1;
      }
    }
    for (let index = 0; index < centers.length; index += 1) {
      const force = corridorForces[index];
      const magnitude = Math.hypot(force.x, force.y);
      const scale = magnitude > 22 ? 22 / magnitude : 1;
      centers[index].x += force.x * scale;
      centers[index].y += force.y * scale;
    }
    if (conflicts === 0) break;
  }

  for (let pass = 0; pass < 260; pass += 1) {
    let collisions = 0;
    for (let first = 0; first < centers.length; first += 1) {
      for (let second = first + 1; second < centers.length; second += 1) {
        const dx = centers[second].x - centers[first].x;
        const dy = centers[second].y - centers[first].y;
        const overlapX = horizontalClearance - Math.abs(dx);
        const overlapY = verticalClearance - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        collisions += 1;
        if (overlapX / horizontalClearance < overlapY / verticalClearance) {
          const direction = dx === 0
            ? (stableUnit(`${orderedNodes[first].id}:${orderedNodes[second].id}`) < 0.5 ? -1 : 1)
            : Math.sign(dx);
          const shift = overlapX / 2 + 0.05;
          centers[first].x -= direction * shift;
          centers[second].x += direction * shift;
        } else {
          const direction = dy === 0
            ? (stableUnit(`${orderedNodes[second].id}:${orderedNodes[first].id}`) < 0.5 ? -1 : 1)
            : Math.sign(dy);
          const shift = overlapY / 2 + 0.05;
          centers[first].y -= direction * shift;
          centers[second].y += direction * shift;
        }
      }
    }
    if (collisions === 0) break;
  }

  // A web should not collapse into a long strip. Expand only the short axis so
  // spacing is never sacrificed and collisions cannot be introduced.
  const centerMinX = Math.min(...centers.map((point) => point.x));
  const centerMaxX = Math.max(...centers.map((point) => point.x));
  const centerMinY = Math.min(...centers.map((point) => point.y));
  const centerMaxY = Math.max(...centers.map((point) => point.y));
  const contentWidth = centerMaxX - centerMinX + options.nodeWidth;
  const contentHeight = centerMaxY - centerMinY + options.nodeHeight;
  const aspect = contentWidth / Math.max(1, contentHeight);
  const maximumWebAspect = 1.65;
  if (aspect > maximumWebAspect) {
    const midpoint = (centerMinY + centerMaxY) / 2;
    const expansion = aspect / maximumWebAspect;
    centers.forEach((point) => {
      point.y = midpoint + (point.y - midpoint) * expansion;
    });
  } else if (aspect < 1 / maximumWebAspect) {
    const midpoint = (centerMinX + centerMaxX) / 2;
    const expansion = 1 / (maximumWebAspect * aspect);
    centers.forEach((point) => {
      point.x = midpoint + (point.x - midpoint) * expansion;
    });
  }

  // Give dense prerequisite webs a little more breathing room without making
  // sparse decks feel empty. This uniform center scaling preserves the web's
  // topology and aspect while reducing how often a strand must squeeze past a
  // full-size card. The cap keeps Fit useful on the largest catalog courses.
  const edgeDensity = graph.edges.length / Math.max(1, graph.nodes.length);
  const spacingScale = 1 + Math.min(
    0.045,
    Math.max(0, (edgeDensity - 0.8) * 0.03),
  );
  const spacingMidX = (Math.min(...centers.map((point) => point.x)) +
    Math.max(...centers.map((point) => point.x))) / 2;
  const spacingMidY = (Math.min(...centers.map((point) => point.y)) +
    Math.max(...centers.map((point) => point.y))) / 2;
  centers.forEach((point) => {
    point.x = spacingMidX + (point.x - spacingMidX) * spacingScale;
    point.y = spacingMidY + (point.y - spacingMidY) * spacingScale;
  });

  const minimumX = Math.min(...centers.map((point) => point.x - options.nodeWidth / 2));
  const minimumY = Math.min(...centers.map((point) => point.y - options.nodeHeight / 2));
  return new Map(orderedNodes.map((node, index) => [node.id, {
    x: rounded(centers[index].x - options.nodeWidth / 2 - minimumX + options.padding),
    y: rounded(centers[index].y - options.nodeHeight / 2 - minimumY + options.padding),
  }]));
}

function portOffset(index, count, nodeHeight) {
  if (count <= 1) return 0;
  const available = Math.max(0, nodeHeight - 32);
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

function polylineLength(points) {
  return points.slice(1).reduce((total, point, index) =>
    total + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
}

function betterCurve(candidate, best) {
  if (!best) return true;
  return candidate.nodeHits < best.nodeHits ||
    (candidate.nodeHits === best.nodeHits && candidate.crossings < best.crossings) ||
    (candidate.nodeHits === best.nodeHits &&
      candidate.crossings === best.crossings &&
      candidate.curveRank < best.curveRank) ||
    (candidate.nodeHits === best.nodeHits &&
      candidate.crossings === best.crossings &&
      candidate.curveRank === best.curveRank &&
      candidate.length < best.length) ||
    (candidate.nodeHits === best.nodeHits &&
      candidate.crossings === best.crossings &&
      candidate.curveRank === best.curveRank &&
      candidate.length === best.length &&
      candidate.candidateIndex < best.candidateIndex);
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

// Opposed normal offsets create one unmistakable S inflection without a flat
// orthogonal tail. The curve continues naturally into its arrowhead.
const WEB_CURVE_AMPLITUDES = Object.freeze([
  0.055, -0.055,
  0.1, -0.1,
  0.15, -0.15,
  0.21, -0.21,
  0.29, -0.29,
  0.38, -0.38,
]);

function rectangleBoundaryPoint(node, toward) {
  const center = {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
  let dx = toward.x - center.x;
  let dy = toward.y - center.y;
  if (Math.abs(dx) + Math.abs(dy) < 1e-6) {
    dx = 1;
    dy = 0;
  }
  const ratio = 1 / Math.max(
    Math.abs(dx) / (node.width / 2),
    Math.abs(dy) / (node.height / 2),
  );
  return {
    x: center.x + dx * ratio,
    y: center.y + dy * ratio,
  };
}

function routeCurvedEdges(graph, nodes, metadata) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const ordered = [...graph.edges].sort((a, b) => compareIds(a.id, b.id));
  const edgeSpecs = ordered.map((edge, lane) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const sourceCenter = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
    const targetCenter = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    const start = rectangleBoundaryPoint(source, targetCenter);
    const end = rectangleBoundaryPoint(target, sourceCenter);
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const distance = Math.max(1, Math.hypot(deltaX, deltaY));
    const normal = { x: -deltaY / distance, y: deltaX / distance };
    const preferredSign = stableUnit(edge.id) < 0.5 ? -1 : 1;
    const amplitudes = WEB_CURVE_AMPLITUDES.map((amount) => amount * preferredSign);
    const scoreSamples = graph.nodes.length > 200 ? 18 : 26;
    const candidates = amplitudes.map((amplitude, curveRank) => {
      const bend = Math.sign(amplitude) * Math.min(
        300,
        Math.max(12, distance * Math.abs(amplitude)),
      );
      const controlA = {
        x: start.x + deltaX * 0.29 + normal.x * bend,
        y: start.y + deltaY * 0.29 + normal.y * bend,
      };
      const controlB = {
        x: end.x - deltaX * 0.29 - normal.x * bend,
        y: end.y - deltaY * 0.29 - normal.y * bend,
      };
      const points = sampledCubic(start, controlA, controlB, end, scoreSamples);
      const nodeHits = nodes.filter((node) =>
        node.id !== edge.source &&
        node.id !== edge.target &&
        polylineIntersectsRect(points, node, 7),
      ).length;
      return {
        controlA,
        controlB,
        points,
        coarsePoints: sampledCubic(start, controlA, controlB, end, 9),
        nodeHits,
        curveRank,
        length: polylineLength(points),
        candidateIndex: curveRank,
      };
    });
    return {
      ...edge,
      lane,
      sourceLayer: source.layer,
      targetLayer: target.layer,
      directDistance: distance,
      start,
      end,
      candidates,
    };
  });

  // Choose curves against a bounded drawing objective. Node clearance remains
  // the strongest term, while a coarse nine-point trace makes crossings cheap
  // enough to consider on complete decks without the old all-segments global
  // search. Harder, longer routes claim their lanes first.
  const selected = new Map();
  const selectionOrder = [...edgeSpecs].sort((left, right) => {
    const leftMinimumHits = Math.min(...left.candidates.map((candidate) => candidate.nodeHits));
    const rightMinimumHits = Math.min(...right.candidates.map((candidate) => candidate.nodeHits));
    return rightMinimumHits - leftMinimumHits ||
      right.directDistance - left.directDistance ||
      compareIds(left.id, right.id);
  });
  // In unusually dense graphs, node clearance dominates: a locally attractive
  // crossing can otherwise steer a curve through several unrelated cards.
  const useCrossingRefinement = edgeSpecs.length <= Math.max(
    graph.nodes.length * 2,
    360,
  );
  const selectedRoutes = [];
  for (const spec of selectionOrder) {
    const candidates = spec.candidates.map((candidate) => {
      let crossings = 0;
      if (useCrossingRefinement) {
        for (const prior of selectedRoutes) {
          if (
            spec.source === prior.source ||
            spec.source === prior.target ||
            spec.target === prior.source ||
            spec.target === prior.target
          ) continue;
          if (polylinesCross(candidate.coarsePoints, prior.points)) crossings += 1;
        }
      }
      const stretch = candidate.length / spec.directDistance;
      return {
        ...candidate,
        drawingCost: candidate.nodeHits * 10 + crossings * 3 + (stretch - 1) * 4,
        crossings,
      };
    });
    const best = candidates.sort(useCrossingRefinement
      ? (left, right) =>
        left.nodeHits - right.nodeHits ||
        Math.floor(left.curveRank / 2) - Math.floor(right.curveRank / 2) ||
        left.crossings - right.crossings ||
        left.drawingCost - right.drawingCost ||
        left.curveRank - right.curveRank ||
        left.length - right.length
      : (left, right) =>
        left.nodeHits - right.nodeHits ||
        Math.floor(left.curveRank / 2) - Math.floor(right.curveRank / 2) ||
        left.curveRank - right.curveRank ||
        left.length - right.length,
    )[0];
    selected.set(spec.id, best);
    selectedRoutes.push({
      source: spec.source,
      target: spec.target,
      points: best.coarsePoints,
    });
  }

  const routed = edgeSpecs.map((spec) => {
    const best = selected.get(spec.id);
    const points = sampledCubic(spec.start, best.controlA, best.controlB, spec.end, 32);
    return {
      ...spec,
      candidates: undefined,
      controlA: best.controlA,
      controlB: best.controlB,
      curveRank: best.curveRank,
      points,
      length: polylineLength(points),
      path: `M ${rounded(spec.start.x)} ${rounded(spec.start.y)} C ${rounded(best.controlA.x)} ${rounded(best.controlA.y)} ${rounded(best.controlB.x)} ${rounded(best.controlB.y)} ${rounded(spec.end.x)} ${rounded(spec.end.y)}`,
    };
  });

  const routedById = new Map(routed.map((edge) => [edge.id, edge]));
  return graph.edges.map((edge) => routedById.get(edge.id));
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
 * Lay out concept cards as a compact, deterministic branching web. A card's
 * `prerequisites` become directed prerequisite -> card edges, but the visual
 * position is driven by relationship closeness rather than rank columns.
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

  const positions = webNodePositions(graph, metadata, resolved);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodes = metadata.topological.map((id, order) => {
    const position = positions.get(id);
    return {
      ...nodeById.get(id),
      id,
      x: position.x,
      y: position.y,
      width: resolved.nodeWidth,
      height: resolved.nodeHeight,
      layer: metadata.levels.get(id) ?? 0,
      order,
    };
  });

  const edges = routeCurvedEdges(graph, nodes, metadata);
  const bounds = layoutBounds(nodes, edges, resolved.boundsPadding);

  return { nodes, edges, bounds };
}

/**
 * Re-route an existing web layout after bounded card pins move. The logical
 * layer/order metadata stays fixed; only card coordinates, curves, and bounds
 * are recalculated.
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
  const edges = routeCurvedEdges(graph, nodes, metadata);
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

// C_rank from the visual contract: the strongest squared linear relationship
// between prerequisite rank and any 2-D projection of node centers. Values near
// one indicate a rigid rank stripe; lower values indicate a branching web.
export function rankColumnarity(nodes) {
  if (!Array.isArray(nodes) || nodes.length < 3) return 0;
  const samples = nodes.map((node) => ({
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
    rank: Number.isFinite(node.layer) ? node.layer : 0,
  }));
  const mean = samples.reduce((total, sample) => ({
    x: total.x + sample.x / samples.length,
    y: total.y + sample.y / samples.length,
    rank: total.rank + sample.rank / samples.length,
  }), { x: 0, y: 0, rank: 0 });
  let xx = 0;
  let xy = 0;
  let yy = 0;
  let xr = 0;
  let yr = 0;
  let rr = 0;
  for (const sample of samples) {
    const x = sample.x - mean.x;
    const y = sample.y - mean.y;
    const rank = sample.rank - mean.rank;
    xx += x * x;
    xy += x * y;
    yy += y * y;
    xr += x * rank;
    yr += y * rank;
    rr += rank * rank;
  }
  if (rr < 1e-9) return 0;
  const determinant = xx * yy - xy * xy;
  if (determinant < 1e-9) {
    const xScore = xx < 1e-9 ? 0 : xr * xr / (xx * rr);
    const yScore = yy < 1e-9 ? 0 : yr * yr / (yy * rr);
    return rounded(Math.max(0, Math.min(1, Math.max(xScore, yScore))));
  }
  const score = (yy * xr * xr - 2 * xy * xr * yr + xx * yr * yr) /
    (determinant * rr);
  return rounded(Math.max(0, Math.min(1, score)));
}

export function measureLayoutQuality(layout) {
  const nodes = Array.isArray(layout?.nodes) ? layout.nodes : [];
  const edges = Array.isArray(layout?.edges) ? layout.edges : [];
  const bounds = layout?.bounds ?? layoutBounds(nodes, edges, 0);
  const edgeNodePairs = new Set(
    findEdgeNodeIntersections(edges, nodes)
      .map(({ edgeId, nodeId }) => `${edgeId}\u0000${nodeId}`),
  );
  const stretch = edges.length === 0
    ? 1
    : edges.reduce((total, edge) =>
      total + edge.length / Math.max(1, edge.directDistance ?? edge.length), 0) / edges.length;
  return {
    nodeCollisions: findNodeCollisions(nodes).length,
    edgeCrossings: countEdgeCrossings(edges),
    edgeNodeIntersections: edgeNodePairs.size,
    meanEdgeStretch: rounded(stretch),
    rankColumnarity: rankColumnarity(nodes),
    aspectRatio: rounded(bounds.width / Math.max(1, bounds.height)),
  };
}
