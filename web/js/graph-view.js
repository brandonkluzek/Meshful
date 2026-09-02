import {
  clampTransform,
  fitTransform,
  layoutGraph,
  reroutePinnedLayout,
  semanticZoomLevel,
  traceDownstream,
  traceUpstream,
} from "./graph-engine.js";
import {
  buildGraphIndex,
  chooseDefaultGraphProjection,
  findDependencyPath,
  projectNeighborhood,
} from "./graph-scope.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_SCALE = 0.28;
const MAX_SCALE = 1.65;
const DEFAULT_GRAPH_NODE_LIMIT = 24;
const NARROW_MIN_READABLE_SCALE = 0.78;
const POINTER_TAP_SLOP = 8;

export function graphNodeLimitForWidth(width) {
  if (!Number.isFinite(width) || width <= 0) return DEFAULT_GRAPH_NODE_LIMIT;
  if (width <= 720) return 10;
  if (width <= 980) return 18;
  return DEFAULT_GRAPH_NODE_LIMIT;
}

export function graphProjectionForDeck(deck, {
  focusCardId = null,
  nodeLimit = DEFAULT_GRAPH_NODE_LIMIT,
} = {}) {
  const index = buildGraphIndex(deck);
  return chooseDefaultGraphProjection(index, { focusCardId, nodeLimit });
}

export function layoutForGraphProjection(projection) {
  if (!projection?.nodes || !projection?.edges) {
    throw new TypeError("A graph projection with nodes and edges is required.");
  }
  return layoutGraph({ nodes: projection.nodes, edges: projection.edges });
}

function projectionIdentity(projection) {
  const nodeSignature = projection.nodeIds.reduce((hash, id) => {
    let next = hash;
    for (const character of String(id)) {
      next ^= character.codePointAt(0);
      next = Math.imul(next, 16_777_619);
    }
    return next;
  }, 2_166_136_261) >>> 0;
  const suffix = nodeSignature.toString(36);
  if (projection.kind === "module") return `module:${projection.scope.moduleId}:${suffix}`;
  if (projection.kind === "neighborhood") {
    return [
      "neighborhood",
      projection.scope.cardId,
      projection.scope.upstreamDepth,
      projection.scope.downstreamDepth,
      suffix,
    ].join(":");
  }
  if (projection.kind === "path") {
    return `path:${projection.scope.sourceId}:${projection.scope.targetId}:${suffix}`;
  }
  return `full:${suffix}`;
}

export function graphPinStorageKey(deck, projection) {
  const deckId = String(deck?.id ?? "deck");
  const revision = String(
    deck?.revision ?? deck?.catalogRevision ?? deck?.version ?? deck?.updatedAt ?? "current",
  );
  return [
    "adaptive-study.graph-pins.v2",
    encodeURIComponent(deckId),
    encodeURIComponent(revision),
    encodeURIComponent(projectionIdentity(projection)),
  ].join(".");
}

function normalizeTermSearch(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function termMatch(index, query) {
  const normalized = normalizeTermSearch(query);
  if (!normalized) return null;
  const candidates = index.nodes.map((card) => ({
    card,
    term: normalizeTermSearch(card.term),
  }));
  return candidates.find(({ term }) => term === normalized)?.card ??
    candidates.find(({ term }) => term.startsWith(normalized))?.card ??
    candidates.find(({ term }) => term.includes(normalized))?.card ??
    null;
}

function exactPathProjection(index, sourceId, targetId, { nodeLimit, contextDepth }) {
  const exact = findDependencyPath(index, sourceId, targetId, {
    contextDepth: 0,
    nodeLimit: Math.max(1, index.nodeIds.length),
  });
  if (!exact.found) return exact;
  return findDependencyPath(index, sourceId, targetId, {
    contextDepth,
    nodeLimit: Math.max(nodeLimit, exact.path.nodeIds.length),
  });
}

export function resolveGraphSearch(index, {
  query,
  selectedId = null,
  nodeLimit = DEFAULT_GRAPH_NODE_LIMIT,
  contextDepth = 1,
} = {}) {
  const match = termMatch(index, query);
  if (!match) {
    return { status: "not_found", match: null, projection: null, direction: null };
  }

  if (selectedId && selectedId !== match.id && index.cardById.has(selectedId)) {
    const forward = exactPathProjection(index, selectedId, match.id, {
      nodeLimit,
      contextDepth,
    });
    if (forward.found) {
      return { status: "path", match, projection: forward, direction: "forward" };
    }
    const reverse = exactPathProjection(index, match.id, selectedId, {
      nodeLimit,
      contextDepth,
    });
    if (reverse.found) {
      return { status: "path", match, projection: reverse, direction: "reverse" };
    }
  }

  return {
    status: selectedId && selectedId !== match.id ? "no_path" : "focus",
    match,
    projection: chooseDefaultGraphProjection(index, {
      focusCardId: match.id,
      nodeLimit,
    }),
    direction: null,
  };
}

export function graphScopeCopy(projection, index) {
  const shown = projection.nodeIds.length;
  const total = index.nodeIds.length;
  if (projection.kind === "full") return `Showing all ${total} terms`;

  let label;
  if (projection.kind === "module") {
    label = projection.scope.module?.title ?? projection.scope.moduleId;
  } else if (projection.kind === "neighborhood") {
    const card = index.cardById.get(projection.scope.cardId);
    label = `${card?.term ?? "Term"} neighborhood`;
  } else if (projection.kind === "path") {
    const source = index.cardById.get(projection.scope.sourceId);
    const target = index.cardById.get(projection.scope.targetId);
    label = `${source?.term ?? "Term"} → ${target?.term ?? "Term"} path`;
  } else {
    label = titleCase(projection.kind);
  }
  const context = projection.truncated ? " · nearby context limited" : "";
  return `Showing ${shown} of ${total} terms · ${label}${context}`;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function titleCase(value) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stateFor(cardId, cardStates) {
  const value = cardStates?.[cardId] ?? cardStates?.get?.(cardId) ?? {};
  const reviewCount = Number(value.reviewCount ?? value.reviews ?? value.reps ?? 0);
  const dueRaw = value.dueAt ?? value.nextDueAt ?? value.next_due_at ?? null;
  const dueAt = reviewCount > 0 && dueRaw ? new Date(dueRaw) : null;
  const now = Date.now();
  const daysUntilDue = dueAt && Number.isFinite(dueAt.valueOf())
    ? (dueAt.valueOf() - now) / 86_400_000
    : null;
  const learning = reviewCount === 0 ? "unseen" : reviewCount < 3 ? "learning" : "established";
  const freshness = daysUntilDue === null
    ? "new"
    : daysUntilDue <= 0
      ? "due"
      : daysUntilDue <= 2
        ? "soon"
        : "fresh";
  return {
    ...value,
    reviewCount,
    dueAt,
    learning,
    freshness,
  };
}

function formatDue(state) {
  if (!state.dueAt) return "Not introduced";
  if (state.freshness === "due") return "Due now";
  const days = Math.max(1, Math.ceil((state.dueAt.valueOf() - Date.now()) / 86_400_000));
  return days === 1 ? "Due tomorrow" : `Due in ${days} days`;
}

function readPins(storageKey, storage) {
  try {
    const parsed = JSON.parse((storage ?? globalThis.localStorage).getItem(storageKey) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function writePins(storageKey, pins, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(storageKey, JSON.stringify(pins));
  } catch {
    // The graph stays usable if browser storage is unavailable.
  }
}

function iconPath(name) {
  const paths = {
    back: '<path d="m12.5 4-6 6 6 6M7 10h9" />',
    search: '<circle cx="8.5" cy="8.5" r="5" /><path d="m12.3 12.3 3.7 3.7" />',
  };
  return `<svg viewBox="0 0 20 20" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}

export function mountGraphView(container, {
  deck,
  cardStates = {},
  focusCardId = null,
  pulseCardId = null,
  storage = undefined,
  onBack = () => {},
  onStudy = () => {},
} = {}) {
  if (!deck?.cards?.length) throw new Error("A deck with cards is required for the graph view.");

  const index = buildGraphIndex(deck);
  const fullGraph = { nodes: index.nodes, edges: index.edges };
  const missingNotice = deck.missingPrerequisiteIds?.length
    ? `${deck.missingPrerequisiteIds.length} required terms are unavailable in active decks`
    : "";
  const scopeCopy = () => [graphScopeCopy(projection, index), missingNotice].filter(Boolean).join(" · ");
  const initialWidth = container.getBoundingClientRect().width || window.innerWidth;
  let nodeLimit = graphNodeLimitForWidth(initialWidth);
  let projection = chooseDefaultGraphProjection(index, { focusCardId, nodeLimit });
  let currentGraph;
  let layout;
  let nodeById;
  let cardById;
  let positions;
  let pins;
  let pinStorageKey;
  let activeLayout;
  let activeEdges;
  let activeBounds;

  function horizontalPinRange(node) {
    const previous = currentGraph.edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => nodeById.get(edge.source))
      .filter(Boolean);
    const next = currentGraph.edges
      .filter((edge) => edge.source === node.id)
      .map((edge) => nodeById.get(edge.target))
      .filter(Boolean);
    const min = previous.length
      ? Math.max(...previous.map((candidate) => (positions.get(candidate.id)?.x ?? candidate.x) + candidate.width)) + 44
      : layout.bounds.minX + 16;
    const max = next.length
      ? Math.min(...next.map((candidate) => positions.get(candidate.id)?.x ?? candidate.x)) - node.width - 44
      : layout.bounds.maxX - node.width - 16;
    if (min > max) return { min: node.x, max: node.x };
    return { min, max };
  }

  function boundedPin(node, candidate) {
    const horizontal = horizontalPinRange(node);
    const minY = layout.bounds.minY + 16;
    const maxY = layout.bounds.maxY - node.height - 16;
    return {
      x: Math.min(horizontal.max, Math.max(horizontal.min, candidate.x)),
      y: minY > maxY ? node.y : Math.min(maxY, Math.max(minY, candidate.y)),
    };
  }

  function positionCollides(nodeId, position) {
    const node = nodeById.get(nodeId);
    return layout.nodes.some((otherNode) => {
      if (otherNode.id === nodeId) return false;
      const other = positions.get(otherNode.id) ?? otherNode;
      return (
        position.x < other.x + otherNode.width + 10 &&
        position.x + node.width + 10 > other.x &&
        position.y < other.y + otherNode.height + 10 &&
        position.y + node.height + 10 > other.y
      );
    });
  }

  function resetProjectionState(nextProjection) {
    projection = nextProjection;
    currentGraph = { nodes: projection.nodes, edges: projection.edges };
    layout = layoutForGraphProjection(projection);
    nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
    cardById = new Map(projection.nodes.map((card) => [card.id, card]));
    positions = new Map(
      layout.nodes.map((node) => [node.id, { x: node.x, y: node.y }]),
    );
    pinStorageKey = graphPinStorageKey(deck, projection);
    const storedPins = readPins(pinStorageKey, storage);
    pins = {};
    for (const node of layout.nodes) {
      const pin = storedPins[node.id];
      if (!pin || !Number.isFinite(pin.x) || !Number.isFinite(pin.y)) continue;
      const bounded = boundedPin(node, pin);
      if (positionCollides(node.id, bounded)) continue;
      positions.set(node.id, bounded);
      pins[node.id] = bounded;
    }

    activeLayout = layout;
    if (Object.keys(pins).length > 0) {
      try {
        activeLayout = reroutePinnedLayout(layout, positions);
      } catch {
        pins = {};
        for (const node of layout.nodes) {
          positions.set(node.id, { x: node.x, y: node.y });
        }
      }
    }
    if (JSON.stringify(storedPins) !== JSON.stringify(pins)) {
      writePins(pinStorageKey, pins, storage);
    }
    activeEdges = activeLayout.edges;
    activeBounds = activeLayout.bounds;
  }

  resetProjectionState(projection);

  let selectedId = focusCardId && nodeById.has(focusCardId) ? focusCardId : null;
  let transform = { x: 0, y: 0, scale: 0.86 };
  let panning = null;
  let dragging = null;
  const activePointers = new Set();
  let traceDirection = "direct";
  let activePath = projection.path ?? null;
  let searchQuery = "";

  container.innerHTML = `
    <section class="graph-page" aria-label="${escapeHTML(deck.title)} prerequisite graph">
      <div class="graph-toolbar">
        <button class="graph-back" type="button" data-graph-action="back" aria-label="Close graph and return to My Decks"><span aria-hidden="true">×</span> Close</button>
        <div class="graph-title">
          <p class="eyebrow">Deck graph</p>
          <h1>${escapeHTML(deck.title)}</h1>
          <p class="graph-scope-note" data-graph-scope>${escapeHTML(scopeCopy())}</p>
        </div>
        <div class="graph-zoom" aria-label="Graph view controls">
          <button type="button" data-graph-action="zoom-out" aria-label="Zoom out">−</button>
          <button type="button" data-graph-action="zoom-in" aria-label="Zoom in">+</button>
          <button type="button" data-graph-action="fit" aria-label="Fit a readable card view" title="Fit a readable card view">Fit</button>
          <button type="button" data-graph-action="reset" data-action="reset-graph">Reset</button>
        </div>
      </div>
      <div class="graph-search">
        <label class="search-field">
          ${iconPath("search")}
          <span class="sr-only">Search terms</span>
          <input type="search" placeholder="Find a term" data-graph-search autocomplete="off" />
        </label>
      </div>
      <div class="graph-workspace" data-graph-workspace role="application" aria-label="Draggable and zoomable prerequisite map">
        <div class="graph-grid"></div>
        <div class="graph-world" data-graph-world>
          <svg class="graph-edges" width="${activeBounds.maxX + 120}" height="${activeBounds.maxY + 120}" aria-hidden="true" data-graph-edges></svg>
          <div class="graph-nodes" data-graph-nodes></div>
        </div>
        <aside class="graph-inspector" data-graph-inspector aria-label="Card info" aria-live="polite" hidden></aside>
        <div class="graph-legend" aria-label="Graph legend" data-graph-legend></div>
      </div>
    </section>`;

  const workspace = container.querySelector("[data-graph-workspace]");
  const world = container.querySelector("[data-graph-world]");
  const nodesLayer = container.querySelector("[data-graph-nodes]");
  const edgesLayer = container.querySelector("[data-graph-edges]");
  const inspector = container.querySelector("[data-graph-inspector]");
  const legend = container.querySelector("[data-graph-legend]");
  const search = container.querySelector("[data-graph-search]");
  const scopeNote = container.querySelector("[data-graph-scope]");
  const listeners = [];

  function on(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    listeners.push(() => target.removeEventListener(event, handler, options));
  }

  function tracedIds() {
    if (activePath) {
      return {
        nodes: new Set(activePath.nodeIds),
        edges: new Set(activePath.edgeIds),
      };
    }
    if (!selectedId) return { nodes: new Set(), edges: new Set() };
    const direct = traceDirection === "direct";
    const upstream = traceDirection === "downstream"
      ? { nodeIds: [], edgeIds: [] }
      : traceUpstream(currentGraph, selectedId, { transitive: !direct });
    const downstream = traceDirection === "upstream"
      ? { nodeIds: [], edgeIds: [] }
      : traceDownstream(currentGraph, selectedId, { transitive: !direct });
    return {
      nodes: new Set([selectedId, ...upstream.nodeIds, ...downstream.nodeIds]),
      edges: new Set([...upstream.edgeIds, ...downstream.edgeIds]),
    };
  }

  function renderEdges() {
    const traced = tracedIds();
    const definitions = document.createElementNS(SVG_NS, "defs");
    definitions.innerHTML = `
      <marker id="graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 8 4 L 0 8 z"></path>
      </marker>`;
    edgesLayer.replaceChildren(definitions, ...activeEdges.map((edge) => {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", edge.path);
      path.setAttribute("marker-end", "url(#graph-arrow)");
      path.setAttribute("class", [
        "graph-edge",
        selectedId && !traced.edges.has(edge.id) ? "is-muted" : "",
        traced.edges.has(edge.id) ? "is-traced" : "",
        pulseCardId && (edge.source === pulseCardId || edge.target === pulseCardId) ? "is-pulsing" : "",
      ].filter(Boolean).join(" "));
      path.dataset.edgeId = edge.id;
      return path;
    }));
  }

  function renderNodes() {
    const traced = tracedIds();
    const query = normalizeTermSearch(searchQuery);
    const fragment = document.createDocumentFragment();
    for (const node of layout.nodes) {
      const position = positions.get(node.id);
      const state = stateFor(node.id, cardStates);
      const button = document.createElement("button");
      button.type = "button";
      button.className = [
        "graph-node",
        selectedId === node.id ? "is-selected" : "",
        selectedId && !traced.nodes.has(node.id) ? "is-muted" : "",
        traced.nodes.has(node.id) && selectedId !== node.id ? "is-traced" : "",
        pins[node.id] ? "is-pinned" : "",
        query && !normalizeTermSearch(node.term).includes(query) ? "is-muted" : "",
      ].filter(Boolean).join(" ");
      button.dataset.nodeId = node.id;
      button.dataset.learning = state.learning;
      button.dataset.freshness = state.freshness;
      button.setAttribute("aria-pressed", String(selectedId === node.id));
      button.style.transform = `translate(${position.x}px, ${position.y}px)`;
      button.setAttribute("aria-label", `${node.term}. Learning: ${titleCase(state.learning)}. Recency: ${formatDue(state)}.`);
      button.innerHTML = `<span>${escapeHTML(node.term)}</span><i class="node-recency" aria-hidden="true"></i>`;
      fragment.append(button);
    }
    nodesLayer.replaceChildren(fragment);
  }

  function renderInspector() {
    const card = cardById.get(selectedId);
    if (!card) {
      inspector.hidden = true;
      return;
    }
    inspector.hidden = false;
    const state = stateFor(card.id, cardStates);
    const directUpstream = traceUpstream(fullGraph, card.id, {
      transitive: false,
      includeSelf: false,
    });
    const directDownstream = traceDownstream(fullGraph, card.id, {
      transitive: false,
      includeSelf: false,
    });
    const upstream = traceUpstream(fullGraph, card.id, { includeSelf: false });
    const downstream = traceDownstream(fullGraph, card.id, { includeSelf: false });
    inspector.innerHTML = `
      <div class="graph-inspector-header">
        <div>
          <p class="eyebrow">${escapeHTML(card.moduleMetadata?.title ?? card.module ?? "Concept")}</p>
          <h2>${escapeHTML(card.term)}</h2>
        </div>
        <button class="icon-button graph-inspector-close" type="button" data-graph-action="dismiss" aria-label="Close card info">×</button>
      </div>
      <div class="graph-inspector-body">
      <div class="inspector-state">
        <div><strong>${escapeHTML(titleCase(state.learning))}</strong><span>Learning</span></div>
        <div><strong>${escapeHTML(formatDue(state))}</strong><span>Recency</span></div>
      </div>
      <ul class="inspector-list">
        <li><span>Direct prerequisites</span><strong>${directUpstream.nodeIds.length}</strong></li>
        <li><span>Direct dependents</span><strong>${directDownstream.nodeIds.length}</strong></li>
      </ul>
      <div class="card-actions">
        <button class="button button-sm button-quiet" type="button" data-trace="upstream" aria-label="Show prerequisite neighborhood" title="${upstream.nodeIds.length} total prerequisite concepts">Prerequisites</button>
        <button class="button button-sm button-quiet" type="button" data-trace="downstream" aria-label="Show dependent neighborhood" title="${downstream.nodeIds.length} total dependent concepts">Dependents</button>
        <button class="button button-sm" type="button" data-study-card="${escapeHTML(card.id)}">Study</button>
      </div>
      </div>`;
  }

  function renderLegend() {
    legend.innerHTML = `
      <span class="legend-learning"><i aria-hidden="true"></i>Border: learning</span>
      <span class="legend-recency"><i aria-hidden="true"></i>Dot: recency</span>`;
    legend.setAttribute(
      "aria-label",
      "Learning is shown by the card border. Recency is shown by the small dot.",
    );
  }

  function applyTransform(next = transform) {
    const viewport = { x: 0, y: 0, width: workspace.clientWidth, height: workspace.clientHeight };
    transform = clampTransform(next, activeBounds, viewport, { visibleMargin: 72, centerSmall: true });
    world.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
    world.dataset.zoom = semanticZoomLevel(transform.scale);
  }

  function centerNode(nodeId, scale = Math.max(0.78, transform.scale)) {
    const node = nodeById.get(nodeId);
    const position = positions.get(nodeId) ?? node;
    if (!node) return;
    applyTransform({
      scale,
      x: workspace.clientWidth / 2 - (position.x + node.width / 2) * scale,
      y: workspace.clientHeight / 2 - (position.y + node.height / 2) * scale,
    });
  }

  function fitAll() {
    const viewport = {
      x: 0,
      y: 0,
      width: workspace.clientWidth,
      height: workspace.clientHeight,
    };
    const narrow = workspace.clientWidth < 720;
    const next = fitTransform(
      activeBounds,
      viewport,
      {
        padding: narrow
          ? { top: 108, right: 20, bottom: 90, left: 20 }
          : { top: 100, right: 64, bottom: 70, left: 64 },
        minScale: narrow ? NARROW_MIN_READABLE_SCALE : MIN_SCALE,
        maxScale: 0.92,
      },
    );
    world.dataset.fitStrategy = narrow ? "readable-scope" : "full-graph";
    applyTransform(next);
  }

  function updateScopeNote(notice = "") {
    const base = scopeCopy();
    scopeNote.textContent = notice ? `${base} · ${notice}` : base;
  }

  function applyProjection(nextProjection, {
    selectId = null,
    path = nextProjection.path ?? null,
    trace = path ? "path" : "direct",
    notice = "",
    center = true,
  } = {}) {
    cancelDragging();
    cancelPanning();
    activePointers.clear();
    resetProjectionState(nextProjection);
    selectedId = selectId && nodeById.has(selectId) ? selectId : null;
    activePath = path;
    traceDirection = trace;
    searchQuery = "";
    edgesLayer.setAttribute("width", String(activeBounds.maxX + 120));
    edgesLayer.setAttribute("height", String(activeBounds.maxY + 120));
    updateScopeNote(notice);
    renderNodes();
    renderEdges();
    renderInspector();
    renderLegend();
    requestAnimationFrame(() => {
      if (center && selectedId) centerNode(selectedId, 0.86);
      else fitAll();
    });
  }

  function setSelected(nodeId, { center = false, preservePath = false } = {}) {
    if (!nodeById.has(nodeId)) return;
    selectedId = nodeId;
    if (!preservePath) activePath = null;
    traceDirection = "direct";
    renderEdges();
    renderNodes();
    renderInspector();
    if (center) centerNode(nodeId);
  }

  function focusNode(nodeId) {
    [...nodesLayer.querySelectorAll("[data-node-id]")]
      .find((node) => node.dataset.nodeId === nodeId)
      ?.focus({ preventScroll: true });
  }

  function clearSelection({ restoreFocus = false } = {}) {
    cancelDragging();
    cancelPanning();
    const previousId = selectedId;
    selectedId = null;
    activePath = null;
    traceDirection = "direct";
    renderEdges();
    renderNodes();
    renderInspector();
    if (restoreFocus) focusNode(previousId);
  }

  function zoomAt(delta, clientX, clientY) {
    const rect = workspace.getBoundingClientRect();
    const pointX = clientX - rect.left;
    const pointY = clientY - rect.top;
    const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, transform.scale * delta));
    const worldX = (pointX - transform.x) / transform.scale;
    const worldY = (pointY - transform.y) / transform.scale;
    applyTransform({
      scale: nextScale,
      x: pointX - worldX * nextScale,
      y: pointY - worldY * nextScale,
    });
  }

  on(container, "click", (event) => {
    const action = event.target.closest("[data-graph-action]")?.dataset.graphAction;
    if (action === "back") return onBack();
    if (action === "dismiss") return clearSelection({ restoreFocus: true });
    if (action === "fit") return fitAll();
    if (action === "reset") {
      for (const key of Object.keys(pins)) delete pins[key];
      writePins(pinStorageKey, pins, storage);
      for (const node of layout.nodes) positions.set(node.id, { x: node.x, y: node.y });
      activeLayout = layout;
      activeEdges = layout.edges;
      activeBounds = layout.bounds;
      edgesLayer.setAttribute("width", String(activeBounds.maxX + 120));
      edgesLayer.setAttribute("height", String(activeBounds.maxY + 120));
      renderNodes();
      renderEdges();
      return selectedId ? centerNode(selectedId, 0.86) : fitAll();
    }
    if (action === "zoom-in" || action === "zoom-out") {
      const rect = workspace.getBoundingClientRect();
      return zoomAt(
        action === "zoom-in" ? 1.16 : 1 / 1.16,
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
    }
    const trace = event.target.closest("[data-trace]")?.dataset.trace;
    if (trace && selectedId) {
      const nextProjection = projectNeighborhood(index, selectedId, {
        upstreamDepth: trace === "upstream" ? 3 : 0,
        downstreamDepth: trace === "downstream" ? 3 : 0,
        nodeLimit,
      });
      applyProjection(nextProjection, {
        selectId: selectedId,
        path: null,
        trace,
        notice: trace === "upstream"
          ? "prerequisite neighborhood"
          : "dependent neighborhood",
      });
      return;
    }
    const study = event.target.closest("[data-study-card]")?.dataset.studyCard;
    if (study) return onStudy(study);
    const nodeId = event.target.closest("[data-node-id]")?.dataset.nodeId;
    if (nodeId) {
      setSelected(nodeId);
      if (event.detail === 0) focusNode(nodeId);
    }
  });

  on(window, "keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (event.target !== document.body && !container.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (selectedId || activePath) {
      clearSelection({ restoreFocus: true });
    } else if (search.value) {
      search.value = "";
      searchQuery = "";
      renderNodes();
      search.focus();
    } else {
      onBack();
    }
  });

  function movedBeyondTap(gesture, event) {
    return Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > POINTER_TAP_SLOP;
  }

  function releasePointer(target, pointerId) {
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  }

  // A second finger cancels the current drag/pan. It must never turn the end of
  // a multi-touch gesture into a blank-canvas tap or a persisted card pin.
  on(window, "pointerdown", (event) => {
    if (!container.contains(event.target)) return;
    activePointers.add(event.pointerId);
    if (activePointers.size > 1) {
      cancelDragging();
      cancelPanning();
    }
  }, { capture: true });

  on(nodesLayer, "pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false || activePointers.size > 1) return;
    const nodeElement = event.target.closest("[data-node-id]");
    if (!nodeElement) return;
    event.stopPropagation();
    const nodeId = nodeElement.dataset.nodeId;
    const position = positions.get(nodeId);
    dragging = {
      pointerId: event.pointerId,
      nodeId,
      nodeElement,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
      originalPin: pins[nodeId] ? { ...pins[nodeId] } : null,
      previousLayout: activeLayout,
      moved: false,
    };
    workspace.classList.add("is-dragging-node");
    nodeElement.setPointerCapture(event.pointerId);
  });

  // Continue a card drag even after the pointer leaves the absolutely positioned
  // node layer. Pointer capture is not dependable when that layer has no own
  // painted box, so the window is the stable gesture boundary.
  on(window, "pointermove", (event) => {
    if (!dragging) return;
    if (dragging.pointerId !== event.pointerId) return;
    dragging.moved ||= movedBeyondTap(dragging, event);
    if (!dragging.moved) return;
    const dx = (event.clientX - dragging.startX) / transform.scale;
    const dy = (event.clientY - dragging.startY) / transform.scale;
    const base = nodeById.get(dragging.nodeId);
    const candidate = boundedPin(base, {
      x: dragging.originX + dx,
      y: dragging.originY + dy,
    });
    const position = positionCollides(dragging.nodeId, candidate)
      ? positions.get(dragging.nodeId)
      : candidate;
    positions.set(dragging.nodeId, position);
    if (dragging.moved) {
      pins[dragging.nodeId] = position;
      dragging.nodeElement.classList.add("is-pinned");
    }
    dragging.nodeElement.style.transform = `translate(${position.x}px, ${position.y}px)`;
  });

  function cancelDragging() {
    if (!dragging) return;
    const { nodeId, nodeElement, pointerId, originX, originY, originalPin, previousLayout } = dragging;
    dragging = null;
    positions.set(nodeId, { x: originX, y: originY });
    if (originalPin) pins[nodeId] = originalPin;
    else delete pins[nodeId];
    activeLayout = previousLayout;
    activeEdges = activeLayout.edges;
    activeBounds = activeLayout.bounds;
    workspace.classList.remove("is-dragging-node");
    releasePointer(nodeElement, pointerId);
    renderNodes();
    renderEdges();
  }

  function finishDragging(event) {
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    const {
      nodeId,
      nodeElement,
      pointerId,
      moved,
      originX,
      originY,
      originalPin,
      previousLayout,
    } = dragging;
    dragging = null;
    workspace.classList.remove("is-dragging-node");
    releasePointer(nodeElement, pointerId);
    if (moved) {
      try {
        activeLayout = reroutePinnedLayout(layout, positions);
        activeEdges = activeLayout.edges;
        activeBounds = activeLayout.bounds;
      } catch {
        positions.set(nodeId, { x: originX, y: originY });
        if (originalPin) pins[nodeId] = originalPin;
        else delete pins[nodeId];
        activeLayout = previousLayout;
        activeEdges = activeLayout.edges;
        activeBounds = activeLayout.bounds;
      }
      writePins(pinStorageKey, pins, storage);
      edgesLayer.setAttribute("width", String(activeBounds.maxX + 120));
      edgesLayer.setAttribute("height", String(activeBounds.maxY + 120));
      renderNodes();
      renderEdges();
    }
    setSelected(nodeId);
  }

  on(workspace, "pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false || activePointers.size > 1) return;
    if (event.target.closest(".graph-node, .graph-inspector, input, button")) return;
    panning = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: transform.x,
      originY: transform.y,
      moved: false,
    };
    workspace.classList.add("is-panning");
    workspace.setPointerCapture(event.pointerId);
  });

  on(workspace, "pointermove", (event) => {
    if (!panning || panning.pointerId !== event.pointerId) return;
    panning.moved ||= movedBeyondTap(panning, event);
    if (!panning.moved) return;
    applyTransform({
      ...transform,
      x: panning.originX + event.clientX - panning.startX,
      y: panning.originY + event.clientY - panning.startY,
    });
  });

  function cancelPanning() {
    if (!panning) return;
    const { pointerId } = panning;
    panning = null;
    workspace.classList.remove("is-panning");
    releasePointer(workspace, pointerId);
  }

  on(window, "pointerup", (event) => {
    finishDragging(event);
    if (panning?.pointerId === event.pointerId) {
      const wasTap = !panning.moved && !movedBeyondTap(panning, event);
      cancelPanning();
      if (wasTap) clearSelection();
    }
    activePointers.delete(event.pointerId);
  });

  on(window, "pointercancel", (event) => {
    if (dragging?.pointerId === event.pointerId) cancelDragging();
    if (panning?.pointerId === event.pointerId) cancelPanning();
    activePointers.delete(event.pointerId);
  });

  on(workspace, "lostpointercapture", (event) => {
    if (dragging?.pointerId === event.pointerId) cancelDragging();
    if (panning?.pointerId === event.pointerId) cancelPanning();
  });

  on(window, "blur", () => {
    cancelDragging();
    cancelPanning();
    activePointers.clear();
  });

  // Scroll the info sheet without also zooming the graph underneath it.
  on(inspector, "wheel", (event) => event.stopPropagation(), { passive: true });

  on(workspace, "wheel", (event) => {
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX, event.clientY);
  }, { passive: false });

  on(search, "input", () => {
    searchQuery = search.value;
    renderNodes();
  });

  on(search, "keydown", (event) => {
    if (event.key !== "Enter") return;
    const query = search.value.trim();
    if (!query) return;
    const result = resolveGraphSearch(index, {
      query,
      selectedId,
      nodeLimit,
      contextDepth: workspace.clientWidth <= 720 ? 0 : 1,
    });
    if (!result.projection) {
      updateScopeNote(`no term matches “${query}”`);
      return;
    }
    const priorSelected = selectedId ? index.cardById.get(selectedId) : null;
    const notice = result.status === "no_path" && priorSelected
      ? `no prerequisite path between ${priorSelected.term} and ${result.match.term}`
      : result.status === "path"
        ? "exact prerequisite path"
        : "";
    searchQuery = "";
    search.value = "";
    applyProjection(result.projection, {
      selectId: result.match.id,
      path: result.projection.path,
      notice,
    });
  });

  on(window, "resize", () => {
    const nextLimit = graphNodeLimitForWidth(
      container.getBoundingClientRect().width || window.innerWidth,
    );
    if (
      nextLimit < nodeLimit &&
      projection.kind !== "path" &&
      projection.nodeIds.length > nextLimit
    ) {
      nodeLimit = nextLimit;
      const nextProjection = chooseDefaultGraphProjection(index, {
        focusCardId: selectedId ?? focusCardId,
        nodeLimit,
      });
      applyProjection(nextProjection, {
        selectId: selectedId && nextProjection.nodeIds.includes(selectedId)
          ? selectedId
          : null,
      });
      return;
    }
    nodeLimit = nextLimit;
    if (selectedId) centerNode(selectedId);
    else fitAll();
  });

  renderEdges();
  renderNodes();
  renderInspector();
  renderLegend();
  requestAnimationFrame(() => selectedId ? centerNode(selectedId, 0.86) : fitAll());

  return () => listeners.splice(0).forEach((dispose) => dispose());
}
