const DEFAULT_NODE_LIMIT = 80;

function compareIds(left, right) {
  const a = String(left);
  const b = String(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function requiredId(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function boundedInteger(value, fallback, label, minimum = 0) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum) {
    throw new TypeError(`${label} must be an integer greater than or equal to ${minimum}.`);
  }
  return resolved;
}

function endpointId(edge, direction, index) {
  const candidates = direction === "source"
    ? [
        edge.source,
        edge.prerequisiteCardId,
        edge.prerequisite_card_id,
        edge.prerequisiteId,
        edge.prerequisite_id,
      ]
    : [
        edge.target,
        edge.dependentCardId,
        edge.dependent_card_id,
        edge.cardId,
        edge.card_id,
      ];
  return requiredId(
    candidates.find((candidate) => typeof candidate === "string"),
    `edge ${direction} at index ${index}`,
  );
}

function prerequisiteId(value, cardId, index) {
  if (typeof value === "string") return requiredId(value, `prerequisite ${index} for ${cardId}`);
  if (!value || typeof value !== "object") {
    throw new TypeError(`prerequisite ${index} for ${cardId} must identify a card.`);
  }
  return requiredId(
    value.id ??
      value.cardId ??
      value.card_id ??
      value.prerequisiteCardId ??
      value.prerequisite_card_id ??
      value.source,
    `prerequisite ${index} for ${cardId}`,
  );
}

function normalizedModule(rawModule, index) {
  if (typeof rawModule === "string") {
    const id = requiredId(rawModule, `module id at index ${index}`);
    return { id, title: id, order: index };
  }
  if (!rawModule || typeof rawModule !== "object") {
    throw new TypeError(`module at index ${index} must be a string or object.`);
  }
  const id = requiredId(
    rawModule.id ?? rawModule.moduleId ?? rawModule.module_id ?? rawModule.slug ?? rawModule.title,
    `module id at index ${index}`,
  );
  const title = String(rawModule.title ?? rawModule.name ?? rawModule.label ?? id).trim() || id;
  const order = Number.isFinite(rawModule.order)
    ? rawModule.order
    : Number.isFinite(rawModule.position)
      ? rawModule.position
      : index;
  return { ...rawModule, id, title, order };
}

function moduleIdForCard(card) {
  const raw = card.moduleId ?? card.module_id ?? card.module;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (raw && typeof raw === "object") {
    return requiredId(
      raw.id ?? raw.moduleId ?? raw.module_id ?? raw.slug ?? raw.title,
      `module for card ${card.id}`,
    );
  }
  return "unassigned";
}

function assertIndex(index) {
  if (
    !index ||
    !Array.isArray(index.nodes) ||
    !Array.isArray(index.edges) ||
    !(index.cardById instanceof Map) ||
    !(index.incoming instanceof Map) ||
    !(index.outgoing instanceof Map)
  ) {
    throw new TypeError("index must be created by buildGraphIndex().");
  }
  return index;
}

function assertKnownCard(index, cardId, label = "cardId") {
  const id = requiredId(cardId, label);
  if (!index.cardById.has(id)) throw new RangeError(`Unknown card: ${id}.`);
  return id;
}

function graphNeighbors(index, nodeId) {
  const neighbors = new Set();
  for (const edge of index.incoming.get(nodeId) ?? []) neighbors.add(edge.source);
  for (const edge of index.outgoing.get(nodeId) ?? []) neighbors.add(edge.target);
  return [...neighbors].sort(compareIds);
}

function breadthLayers(index, seedIds, maxDepth, direction = "both") {
  const depths = new Map(seedIds.map((id) => [id, 0]));
  let frontier = [...seedIds].sort(compareIds);
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next = new Set();
    for (const id of frontier) {
      const edges = direction === "upstream"
        ? index.incoming.get(id)
        : direction === "downstream"
          ? index.outgoing.get(id)
          : null;
      const neighbors = edges
        ? edges.map((edge) => direction === "upstream" ? edge.source : edge.target)
        : graphNeighbors(index, id);
      for (const neighbor of neighbors) {
        if (!depths.has(neighbor)) {
          depths.set(neighbor, depth);
          next.add(neighbor);
        }
      }
    }
    frontier = [...next].sort(compareIds);
  }
  return depths;
}

function orderedByDepth(depths, excluded = new Set()) {
  return [...depths.entries()]
    .filter(([id]) => !excluded.has(id))
    .sort(([leftId, leftDepth], [rightId, rightDepth]) =>
      leftDepth - rightDepth || compareIds(leftId, rightId),
    )
    .map(([id]) => id);
}

function edgesWithin(index, nodeIds) {
  const ids = nodeIds instanceof Set ? nodeIds : new Set(nodeIds);
  return index.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
}

function makeProjection(index, {
  kind,
  scope,
  candidates,
  primaryIds = [],
  boundaryIds = [],
  nodeLimit,
  path = null,
}) {
  const limit = boundedInteger(nodeLimit, DEFAULT_NODE_LIMIT, "nodeLimit", 1);
  const eligible = [];
  const eligibleSet = new Set();
  for (const id of candidates) {
    if (!index.cardById.has(id) || eligibleSet.has(id)) continue;
    eligibleSet.add(id);
    eligible.push(id);
  }
  const includedPriority = eligible.slice(0, limit);
  const includedSet = new Set(includedPriority);
  const nodeIds = [...includedSet].sort(compareIds);
  const eligibleEdges = edgesWithin(index, eligibleSet);
  const edges = edgesWithin(index, includedSet);
  const edgeIds = edges.map((edge) => edge.id);
  const omittedNodeIds = eligible.filter((id) => !includedSet.has(id));
  const includedEdgeIds = new Set(edgeIds);
  const omittedEdgeIds = eligibleEdges
    .filter((edge) => !includedEdgeIds.has(edge.id))
    .map((edge) => edge.id);
  const requestedPrimary = [...new Set(primaryIds)].filter((id) => eligibleSet.has(id));
  const requestedBoundary = [...new Set(boundaryIds)].filter((id) => eligibleSet.has(id));
  const omittedPrimaryNodeIds = requestedPrimary.filter((id) => !includedSet.has(id));
  const omittedBoundaryNodeIds = requestedBoundary.filter((id) => !includedSet.has(id));
  const truncated = omittedNodeIds.length > 0;

  return {
    kind,
    scope: { ...scope },
    deckId: index.deckId,
    nodes: nodeIds.map((id) => index.cardById.get(id)),
    edges,
    nodeIds,
    edgeIds,
    primaryNodeIds: requestedPrimary.filter((id) => includedSet.has(id)).sort(compareIds),
    boundaryNodeIds: requestedBoundary.filter((id) => includedSet.has(id)).sort(compareIds),
    path,
    complete: !truncated,
    truncated,
    truncation: {
      truncated,
      reason: truncated ? "node_limit" : null,
      nodeLimit: limit,
      eligibleNodeCount: eligible.length,
      includedNodeCount: nodeIds.length,
      omittedNodeCount: omittedNodeIds.length,
      omittedNodeIds: [...omittedNodeIds].sort(compareIds),
      eligibleEdgeCount: eligibleEdges.length,
      includedEdgeCount: edges.length,
      omittedEdgeCount: omittedEdgeIds.length,
      omittedEdgeIds: [...omittedEdgeIds].sort(compareIds),
      omittedPrimaryNodeCount: omittedPrimaryNodeIds.length,
      omittedPrimaryNodeIds: [...omittedPrimaryNodeIds].sort(compareIds),
      omittedBoundaryNodeCount: omittedBoundaryNodeIds.length,
      omittedBoundaryNodeIds: [...omittedBoundaryNodeIds].sort(compareIds),
    },
    excludedByScope: {
      nodeCount: index.nodes.length - eligibleSet.size,
      edgeCount: index.edges.length - eligibleEdges.length,
    },
  };
}

/**
 * Build a deterministic, lightweight adjacency index. Original card and edge
 * fields survive normalization; only stable graph fields are added.
 */
export function buildGraphIndex(deck) {
  if (!deck || typeof deck !== "object" || !Array.isArray(deck.cards)) {
    throw new TypeError("deck must provide a cards array.");
  }
  const deckId = requiredId(deck.id ?? "deck", "deck id");
  const moduleById = new Map();
  (deck.modules ?? []).forEach((module, index) => {
    const normalized = normalizedModule(module, index);
    if (moduleById.has(normalized.id)) {
      throw new TypeError(`Duplicate module id: ${normalized.id}.`);
    }
    moduleById.set(normalized.id, normalized);
  });

  const cardById = new Map();
  for (const [index, card] of deck.cards.entries()) {
    if (!card || typeof card !== "object") {
      throw new TypeError(`card at index ${index} must be an object.`);
    }
    const id = requiredId(card.id, `card id at index ${index}`);
    if (cardById.has(id)) throw new TypeError(`Duplicate card id: ${id}.`);
    const moduleId = moduleIdForCard({ ...card, id });
    if (!moduleById.has(moduleId)) {
      const raw = card.module;
      const inferred = raw && typeof raw === "object"
        ? normalizedModule(raw, moduleById.size)
        : { id: moduleId, title: moduleId === "unassigned" ? "Unassigned" : moduleId, order: moduleById.size };
      moduleById.set(moduleId, { ...inferred, id: moduleId });
    }
    cardById.set(id, {
      ...card,
      id,
      term: String(card.term ?? card.title ?? card.label ?? id),
      moduleId,
      moduleMetadata: moduleById.get(moduleId),
    });
  }

  const relationByKey = new Map();
  const edgeIdSet = new Set();
  function addEdge(edge, index, sourceKind) {
    const source = endpointId(edge, "source", index);
    const target = endpointId(edge, "target", index);
    if (!cardById.has(source) || !cardById.has(target)) {
      const missing = [source, target].filter((id) => !cardById.has(id));
      throw new RangeError(`Edge ${source} -> ${target} references missing card${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`);
    }
    if (source === target) throw new TypeError(`Self prerequisite is not allowed: ${source}.`);
    const relationKey = `${source}\u0000${target}`;
    if (relationByKey.has(relationKey)) return relationByKey.get(relationKey);
    const id = requiredId(
      edge.id ?? edge.edgeId ?? edge.edge_id ?? `${source}->${target}`,
      `edge id at index ${index}`,
    );
    if (edgeIdSet.has(id)) throw new TypeError(`Duplicate edge id: ${id}.`);
    const normalized = { ...edge, id, source, target, sourceKind };
    relationByKey.set(relationKey, normalized);
    edgeIdSet.add(id);
    return normalized;
  }

  (deck.edges ?? []).forEach((edge, index) => {
    if (!edge || typeof edge !== "object") {
      throw new TypeError(`edge at index ${index} must be an object.`);
    }
    addEdge(edge, index, "explicit");
  });
  for (const card of cardById.values()) {
    (card.prerequisites ?? []).forEach((prerequisite, index) => {
      const source = prerequisiteId(prerequisite, card.id, index);
      addEdge(
        { source, target: card.id, id: `${source}->${card.id}` },
        index,
        "card_prerequisite",
      );
    });
  }

  const nodes = [...cardById.values()].sort((a, b) => compareIds(a.id, b.id));
  const edges = [...relationByKey.values()].sort((a, b) =>
    compareIds(a.source, b.source) || compareIds(a.target, b.target) || compareIds(a.id, b.id),
  );
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    incoming.get(edge.target).push(edge);
    outgoing.get(edge.source).push(edge);
  }
  for (const collection of [...incoming.values(), ...outgoing.values()]) {
    collection.sort((a, b) =>
      compareIds(a.source, b.source) || compareIds(a.target, b.target) || compareIds(a.id, b.id),
    );
  }

  const modules = [...moduleById.values()]
    .map((module) => ({
      ...module,
      cardIds: nodes.filter((node) => node.moduleId === module.id).map((node) => node.id),
    }))
    .filter((module) => module.cardIds.length > 0)
    .sort((a, b) => a.order - b.order || compareIds(a.id, b.id));
  const resolvedModuleById = new Map(modules.map((module) => [module.id, module]));
  for (const node of nodes) node.moduleMetadata = resolvedModuleById.get(node.moduleId);

  return {
    deckId,
    deckMetadata: Object.fromEntries(
      Object.entries(deck).filter(([key]) => !["cards", "edges", "modules"].includes(key)),
    ),
    nodes,
    edges,
    nodeIds: nodes.map((node) => node.id),
    edgeIds: edges.map((edge) => edge.id),
    modules,
    cardById,
    edgeById: new Map(edges.map((edge) => [edge.id, edge])),
    moduleById: resolvedModuleById,
    incoming,
    outgoing,
  };
}

export function projectModule(indexInput, moduleIdInput, options = {}) {
  const index = assertIndex(indexInput);
  const moduleId = requiredId(moduleIdInput, "moduleId");
  const module = index.moduleById.get(moduleId);
  if (!module) throw new RangeError(`Unknown module: ${moduleId}.`);
  const boundaryDepth = boundedInteger(options.boundaryDepth, 1, "boundaryDepth");
  const primary = [...module.cardIds].sort(compareIds);
  const primarySet = new Set(primary);
  const depths = breadthLayers(index, primary, boundaryDepth, "both");
  const boundary = orderedByDepth(depths, primarySet);
  return makeProjection(index, {
    kind: "module",
    scope: {
      moduleId,
      module: { ...module, cardIds: [...module.cardIds] },
      boundaryDepth,
    },
    candidates: [...primary, ...boundary],
    primaryIds: primary,
    boundaryIds: boundary,
    nodeLimit: options.nodeLimit,
  });
}

export function projectNeighborhood(indexInput, cardIdInput, options = {}) {
  const index = assertIndex(indexInput);
  const cardId = assertKnownCard(index, cardIdInput);
  const upstreamDepth = boundedInteger(options.upstreamDepth, 2, "upstreamDepth");
  const downstreamDepth = boundedInteger(options.downstreamDepth, 2, "downstreamDepth");
  const upstream = breadthLayers(index, [cardId], upstreamDepth, "upstream");
  const downstream = breadthLayers(index, [cardId], downstreamDepth, "downstream");
  const depthById = new Map([[cardId, 0]]);
  for (const [id, depth] of [...upstream, ...downstream]) {
    depthById.set(id, Math.min(depthById.get(id) ?? Infinity, depth));
  }
  const neighbors = orderedByDepth(depthById, new Set([cardId]));
  return makeProjection(index, {
    kind: "neighborhood",
    scope: {
      cardId,
      upstreamDepth,
      downstreamDepth,
      upstreamDepths: Object.fromEntries([...upstream].sort(([a], [b]) => compareIds(a, b))),
      downstreamDepths: Object.fromEntries([...downstream].sort(([a], [b]) => compareIds(a, b))),
    },
    candidates: [cardId, ...neighbors],
    primaryIds: [cardId],
    boundaryIds: neighbors,
    nodeLimit: options.nodeLimit,
  });
}

function shortestPath(index, sourceId, targetId) {
  const queue = [sourceId];
  const parent = new Map([[sourceId, null]]);
  const parentEdge = new Map();
  while (queue.length > 0 && !parent.has(targetId)) {
    const current = queue.shift();
    const edges = [...(index.outgoing.get(current) ?? [])].sort((a, b) =>
      compareIds(a.target, b.target) || compareIds(a.id, b.id),
    );
    for (const edge of edges) {
      if (parent.has(edge.target)) continue;
      parent.set(edge.target, current);
      parentEdge.set(edge.target, edge.id);
      queue.push(edge.target);
    }
  }
  if (!parent.has(targetId)) return null;
  const nodeIds = [];
  const edgeIds = [];
  let current = targetId;
  while (current !== null) {
    nodeIds.push(current);
    const edgeId = parentEdge.get(current);
    if (edgeId) edgeIds.push(edgeId);
    current = parent.get(current) ?? null;
  }
  nodeIds.reverse();
  edgeIds.reverse();
  return { nodeIds, edgeIds, distance: edgeIds.length };
}

export function findDependencyPath(indexInput, sourceIdInput, targetIdInput, options = {}) {
  const index = assertIndex(indexInput);
  const sourceId = assertKnownCard(index, sourceIdInput, "sourceId");
  const targetId = assertKnownCard(index, targetIdInput, "targetId");
  const contextDepth = boundedInteger(options.contextDepth, 1, "contextDepth");
  const nodeLimit = boundedInteger(options.nodeLimit, DEFAULT_NODE_LIMIT, "nodeLimit", 1);
  const path = shortestPath(index, sourceId, targetId);

  if (!path) {
    const projection = makeProjection(index, {
      kind: "path",
      scope: { sourceId, targetId, contextDepth },
      candidates: [sourceId, targetId],
      primaryIds: [sourceId, targetId],
      nodeLimit,
      path: null,
    });
    return { ...projection, found: false, canProject: true, status: "no_path" };
  }

  if (path.nodeIds.length > nodeLimit) {
    return {
      kind: "path",
      scope: { sourceId, targetId, contextDepth },
      deckId: index.deckId,
      found: true,
      canProject: false,
      status: "path_exceeds_node_limit",
      nodes: [],
      edges: [],
      nodeIds: [],
      edgeIds: [],
      primaryNodeIds: [],
      boundaryNodeIds: [],
      path,
      complete: false,
      truncated: false,
      truncation: {
        truncated: false,
        reason: "path_exceeds_node_limit",
        nodeLimit,
        requiredNodeCount: path.nodeIds.length,
        requiredEdgeCount: path.edgeIds.length,
      },
      excludedByScope: {
        nodeCount: index.nodes.length,
        edgeCount: index.edges.length,
      },
    };
  }

  const pathSet = new Set(path.nodeIds);
  const contextDepths = breadthLayers(index, path.nodeIds, contextDepth, "both");
  const contextIds = orderedByDepth(contextDepths, pathSet);
  const projection = makeProjection(index, {
    kind: "path",
    scope: { sourceId, targetId, contextDepth },
    candidates: [...path.nodeIds, ...contextIds],
    primaryIds: path.nodeIds,
    boundaryIds: contextIds,
    nodeLimit,
    path,
  });
  return { ...projection, found: true, canProject: true, status: "found" };
}

function projectAll(index, nodeLimit) {
  return makeProjection(index, {
    kind: "full",
    scope: {},
    candidates: index.nodeIds,
    primaryIds: index.nodeIds,
    nodeLimit,
  });
}

function defaultAnchorId(index, candidateIds = index.nodeIds) {
  const allowed = new Set(candidateIds);
  const roots = candidateIds.filter((id) =>
    (index.incoming.get(id) ?? []).every((edge) => !allowed.has(edge.source)),
  );
  const bridges = candidateIds.filter((id) =>
    (index.incoming.get(id) ?? []).some((edge) => allowed.has(edge.source)) &&
    (index.outgoing.get(id) ?? []).some((edge) => allowed.has(edge.target)),
  );
  const complexity = (card) => {
    const term = String(card?.term ?? "");
    const words = term.trim().split(/\s+/).filter(Boolean).length;
    const tags = Array.isArray(card?.tags) ? card.tags : [];
    const specialistShape = tags.some((tag) =>
      /^shape:(?:contrast|diagnostic|theorem-role|counterexample)$/i.test(tag),
    );
    return term.length + Math.max(0, words - 3) * 8 +
      (/\b[A-Z]{2,}\b|[=]/.test(term) ? 20 : 0) +
      (specialistShape ? 24 : 0);
  };
  const scoreCandidates = (ids) => ids.map((id) => {
    const directDependents = (index.outgoing.get(id) ?? [])
      .filter((edge) => allowed.has(edge.target)).length;
    const probe = projectNeighborhood(index, id, { nodeLimit: 10 });
    const averageComplexity = probe.nodes.reduce((sum, card) =>
      sum + complexity(card), 0) / Math.max(1, probe.nodes.length);
    return {
      id,
      directDependents,
      probeNodeCount: probe.nodes.length,
      probeEdgeCount: probe.edges.length,
      averageComplexity,
      score: probe.edges.length * 4 + probe.nodes.length * 2 - averageComplexity,
      term: String(index.cardById.get(id)?.term ?? id).normalize("NFKC").toLocaleLowerCase(),
    };
  });
  let scored = scoreCandidates(roots).filter((candidate) =>
    candidate.directDependents >= 2 && candidate.probeNodeCount >= 8,
  );
  if (scored.length === 0) scored = scoreCandidates(bridges);
  if (scored.length === 0) scored = scoreCandidates(roots.length > 0 ? roots : candidateIds);
  scored.sort((a, b) =>
    b.score - a.score ||
    a.term.localeCompare(b.term, "en", { sensitivity: "base" }) ||
    compareIds(a.id, b.id),
  );
  return scored[0]?.id ?? candidateIds[0] ?? null;
}

export function chooseDefaultGraphProjection(indexInput, options = {}) {
  const index = assertIndex(indexInput);
  const nodeLimit = boundedInteger(options.nodeLimit, DEFAULT_NODE_LIMIT, "nodeLimit", 1);
  if (index.nodes.length <= nodeLimit) {
    return { ...projectAll(index, nodeLimit), selectionReason: "small_deck" };
  }

  const focusCardId = options.focusCardId && index.cardById.has(options.focusCardId)
    ? options.focusCardId
    : null;
  const preferredModuleId = options.preferredModuleId && index.moduleById.has(options.preferredModuleId)
    ? options.preferredModuleId
    : null;
  const moduleId = preferredModuleId ?? (focusCardId ? index.cardById.get(focusCardId).moduleId : null);
  if (moduleId) {
    const module = index.moduleById.get(moduleId);
    if (module.cardIds.length <= nodeLimit) {
      return {
        ...projectModule(index, moduleId, { boundaryDepth: 1, nodeLimit }),
        selectionReason: preferredModuleId ? "preferred_module" : "focus_module",
      };
    }
    const center = focusCardId && index.cardById.get(focusCardId).moduleId === moduleId
      ? focusCardId
      : defaultAnchorId(index, module.cardIds);
    return {
      ...projectNeighborhood(index, center, { nodeLimit }),
      selectionReason: "oversized_module",
    };
  }

  const firstModule = index.modules[0];
  if (firstModule && firstModule.cardIds.length <= nodeLimit) {
    return {
      ...projectModule(index, firstModule.id, { boundaryDepth: 1, nodeLimit }),
      selectionReason: "first_module",
    };
  }
  const center = focusCardId ?? defaultAnchorId(index, firstModule?.cardIds ?? index.nodeIds);
  return {
    ...projectNeighborhood(index, center, { nodeLimit }),
    selectionReason: firstModule ? "oversized_module" : "first_card",
  };
}
