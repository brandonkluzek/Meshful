import {
  clampTransform,
  fitTransform,
  layoutGraph,
  reroutePinnedLayout,
  semanticZoomLevel,
  traceDownstream,
  traceUpstream,
} from "./graph-engine.js?graph-revision-19";
import {
  buildGraphIndex,
  chooseDefaultGraphProjection,
  findDependencyPath,
} from "./graph-scope.js?graph-revision-19";
import { renderDefinition } from "./definition-renderer.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_SCALE = 0.045;
const MAX_SCALE = 1.65;
const DEFAULT_GRAPH_NODE_LIMIT = 10_000;
const POINTER_TAP_SLOP = 8;
const ENTIRE_GRAPH_MIN_SCALE = 0.01;

export function graphNodeLimitForWidth(width) {
  if (!Number.isFinite(width) || width <= 0) return DEFAULT_GRAPH_NODE_LIMIT;
  return DEFAULT_GRAPH_NODE_LIMIT;
}

function fullDeckProjection(index, path = null) {
  const projection = chooseDefaultGraphProjection(index, {
    nodeLimit: Math.max(1, index.nodeIds.length),
  });
  return path ? { ...projection, path } : projection;
}

export function graphProjectionForDeck(deck, {
  focusCardId = null,
  nodeLimit = DEFAULT_GRAPH_NODE_LIMIT,
} = {}) {
  const index = buildGraphIndex(deck);
  void focusCardId;
  void nodeLimit;
  return fullDeckProjection(index);
}

export function graphLayoutOptionsForWidth(width) {
  if (!Number.isFinite(width) || width > 980) return {};
  return {
    nodeWidth: 164,
    nodeHeight: 64,
    layerGap: 48,
    forwardGap: 48,
    idealEdgeGap: 64,
    layerDrift: 8,
    rowGap: 34,
    padding: 40,
    boundsPadding: 16,
  };
}

export function layoutForGraphProjection(projection, { viewportWidth = Infinity } = {}) {
  if (!projection?.nodes || !projection?.edges) {
    throw new TypeError("A graph projection with nodes and edges is required.");
  }
  return layoutGraph(
    { nodes: projection.nodes, edges: projection.edges },
    graphLayoutOptionsForWidth(viewportWidth),
  );
}

// Compatibility seam for the Library's full-course preview. Revision 16 is
// full-deck by default, so this now delegates to the same accepted layout
// rather than maintaining a second, visually divergent overview algorithm.
export function layoutEntireGraphProjection(projection, positionOverrides = null) {
  const viewportWidth = Number.isFinite(globalThis.window?.innerWidth)
    ? globalThis.window.innerWidth
    : Infinity;
  const layout = layoutForGraphProjection(projection, { viewportWidth });
  return positionOverrides ? reroutePinnedLayout(layout, positionOverrides) : layout;
}

function projectionIdentity(projection) {
  const identityParts = [
    ...projection.nodeIds,
    ...(projection.edges ?? [])
      .map((edge) => `${edge.source}>${edge.target}`)
      .sort(),
  ];
  const nodeSignature = identityParts.reduce((hash, id) => {
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
    "adaptive-study.graph-pins.web-v1",
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
      return {
        status: "path",
        match,
        projection: fullDeckProjection(index, forward.path),
        direction: "forward",
      };
    }
    const reverse = exactPathProjection(index, match.id, selectedId, {
      nodeLimit,
      contextDepth,
    });
    if (reverse.found) {
      return {
        status: "path",
        match,
        projection: fullDeckProjection(index, reverse.path),
        direction: "reverse",
      };
    }
  }

  return {
    status: selectedId && selectedId !== match.id ? "no_path" : "focus",
    match,
    projection: fullDeckProjection(index),
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
  return `${shown} visible from full ${total}-term deck · ${label}${context}`;
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
  const lastReviewedRaw = value.lastReviewedAt ?? value.last_reviewed_at ?? null;
  const lastReviewedAt = reviewCount > 0 && lastReviewedRaw
    ? new Date(lastReviewedRaw)
    : null;
  const learnedness = Number(value.learnedness);
  const now = Date.now();
  const daysUntilDue = dueAt && Number.isFinite(dueAt.valueOf())
    ? (dueAt.valueOf() - now) / 86_400_000
    : null;
  const learning = reviewCount === 0
    ? "unseen"
    : Number.isFinite(learnedness)
      ? learnedness >= 0.6 ? "established" : "learning"
      : reviewCount < 3 ? "learning" : "established";
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
    learnedness: Number.isFinite(learnedness) ? learnedness : null,
    dueAt,
    lastReviewedAt: lastReviewedAt && Number.isFinite(lastReviewedAt.valueOf())
      ? lastReviewedAt
      : null,
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

function mixHex(start, end, amount) {
  const clamped = Math.max(0, Math.min(1, amount));
  const channels = (value) => [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
  const from = channels(start);
  const to = channels(end);
  return `#${from.map((value, index) =>
    Math.round(value + (to[index] - value) * clamped).toString(16).padStart(2, "0"),
  ).join("")}`;
}

function recencyColor(state) {
  if (state.learning === "unseen") return "#626a75";
  if (!state.lastReviewedAt) return "#f3f0e8";
  const ageDays = Math.max(0, (Date.now() - state.lastReviewedAt.valueOf()) / 86_400_000);
  if (ageDays <= 35) return mixHex("#f0645f", "#efc85c", ageDays / 35);
  if (ageDays <= 150) return mixHex("#efc85c", "#f3f0e8", (ageDays - 35) / 115);
  return "#f3f0e8";
}

function formatLastReviewed(state) {
  if (!state.lastReviewedAt) return "Not reviewed";
  const ageDays = Math.max(0, Math.floor((Date.now() - state.lastReviewedAt.valueOf()) / 86_400_000));
  if (ageDays === 0) return "Reviewed today";
  if (ageDays === 1) return "Reviewed yesterday";
  return `Reviewed ${ageDays} days ago`;
}

function ratingValue(value) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 4) return numeric;
  return ({ again: 1, hard: 2, good: 3, easy: 4 })[
    String(value ?? "").toLocaleLowerCase()
  ] ?? null;
}

function ratingLabel(value) {
  return ({ 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" })[ratingValue(value)]
    ?? String(value ?? "—");
}

function retainedReviews(state) {
  return (Array.isArray(state.reviewHistory) ? state.reviewHistory : [])
    .filter((review) => review && ratingValue(review.rating) !== null)
    .sort((a, b) => new Date(a.submittedAt ?? 0) - new Date(b.submittedAt ?? 0));
}

function formatReviewMoment(value) {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.valueOf())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
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
  progressSource = "learner",
  focusCardId = null,
  pulseCardId = null,
  storage = undefined,
  canStudy = true,
  onBack = () => {},
  onStudy = () => {},
  backAriaLabel = "Close graph and return to My Decks",
  showEntireGraph = false,
} = {}) {
  if (!deck?.cards?.length) throw new Error("A deck with cards is required for the graph view.");
  const showsLearnerProgress = progressSource === "learner";

  const index = buildGraphIndex(deck);
  const fullGraph = { nodes: index.nodes, edges: index.edges };
  const missingNotice = deck.missingPrerequisiteIds?.length
    ? `${deck.missingPrerequisiteIds.length} required terms are unavailable in active decks`
    : "";
  const scopeCopy = () => [graphScopeCopy(projection, index), missingNotice].filter(Boolean).join(" · ");
  const initialWidth = container.getBoundingClientRect().width || window.innerWidth;
  let nodeLimit = showEntireGraph ? index.nodeIds.length : graphNodeLimitForWidth(initialWidth);
  let projection = fullDeckProjection(index);
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

  function boundedPin(node, candidate) {
    const minX = layout.bounds.minX + 16;
    const maxX = layout.bounds.maxX - node.width - 16;
    const minY = layout.bounds.minY + 16;
    const maxY = layout.bounds.maxY - node.height - 16;
    return {
      x: minX > maxX ? node.x : Math.min(maxX, Math.max(minX, candidate.x)),
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
    layout = showEntireGraph
      ? layoutEntireGraphProjection(projection)
      : layoutForGraphProjection(projection, {
          viewportWidth: container.getBoundingClientRect().width || window.innerWidth,
        });
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
        activeLayout = showEntireGraph
          ? layoutEntireGraphProjection(projection, positions)
          : reroutePinnedLayout(layout, positions);
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
  let inspectorDragging = null;
  const activePointers = new Set();
  let traceDirection = "direct";
  let activePath = projection.path ?? null;
  let searchQuery = "";
  const activeStateFor = (cardId) => stateFor(cardId, cardStates);

  container.innerHTML = `
    <section class="graph-page" aria-label="${escapeHTML(deck.title)} prerequisite graph">
      <div class="graph-toolbar">
        <button class="graph-back" type="button" data-graph-action="back" aria-label="${escapeHTML(backAriaLabel)}"><span aria-hidden="true">×</span> Close</button>
        <div class="graph-title">
          <p class="eyebrow">Deck graph</p>
          <h1>${escapeHTML(deck.title)}</h1>
          <p class="sr-only" data-graph-scope aria-live="polite">${escapeHTML(scopeCopy())}</p>
        </div>
        <div class="graph-zoom" aria-label="Graph view controls">
          <button type="button" data-graph-action="zoom-out" aria-label="Zoom out">−</button>
          <button type="button" data-graph-action="zoom-in" aria-label="Zoom in">+</button>
          <button type="button" data-graph-action="fit" aria-label="Fit a readable card view" title="Fit a readable card view">Fit</button>
          <button type="button" data-graph-action="reset" data-action="reset-graph">Reset</button>
        </div>
      </div>
      <div class="graph-workspace" data-graph-workspace role="application" aria-label="Draggable and zoomable prerequisite map">
        <div class="graph-search">
          <label class="search-field">
            ${iconPath("search")}
            <span class="sr-only">Search terms</span>
            <input type="search" placeholder="Find a term" data-graph-search autocomplete="off" />
          </label>
        </div>
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
  const edgeElements = new Map();
  const edgeGradients = new Map();
  const nodeElements = new Map();
  let edgeDefinitions = null;
  let renderedEdgeGeometry = null;
  let renderedNodeLayout = null;

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
    if (!edgeDefinitions) {
      edgeDefinitions = document.createElementNS(SVG_NS, "defs");
      edgeDefinitions.innerHTML = `
        <marker id="graph-arrow" viewBox="0 0 14 9" refX="13.5" refY="4.5" markerWidth="13" markerHeight="8.5" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M 0 0 L 14 4.5 L 0 9 z"></path>
        </marker>`;
    }

    if (activeEdges !== renderedEdgeGeometry) {
      const activeIds = new Set(activeEdges.map((edge) => edge.id));
      for (const edgeId of edgeElements.keys()) {
        if (!activeIds.has(edgeId)) edgeElements.delete(edgeId);
      }
      const orderedPaths = activeEdges.map((edge) => {
        let path = edgeElements.get(edge.id);
        if (!path) {
          path = document.createElementNS(SVG_NS, "path");
          path.setAttribute("marker-end", "url(#graph-arrow)");
          path.dataset.edgeId = edge.id;
          const gradient = document.createElementNS(SVG_NS, "linearGradient");
          const gradientId = `graph-edge-paint-${edgeElements.size}`;
          gradient.setAttribute("id", gradientId);
          gradient.setAttribute("gradientUnits", "userSpaceOnUse");
          const startStop = document.createElementNS(SVG_NS, "stop");
          startStop.setAttribute("offset", "0%");
          const endStop = document.createElementNS(SVG_NS, "stop");
          endStop.setAttribute("offset", "100%");
          gradient.append(startStop, endStop);
          edgeDefinitions.append(gradient);
          edgeGradients.set(edge.id, { gradient, startStop, endStop });
          path.style.stroke = `url(#${gradientId})`;
          edgeElements.set(edge.id, path);
        }
        if (path.getAttribute("d") !== edge.path) path.setAttribute("d", edge.path);
        const paint = edgeGradients.get(edge.id);
        if (paint) {
          paint.gradient.setAttribute("x1", String(edge.start.x));
          paint.gradient.setAttribute("y1", String(edge.start.y));
          paint.gradient.setAttribute("x2", String(edge.end.x));
          paint.gradient.setAttribute("y2", String(edge.end.y));
        }
        return path;
      });
      edgesLayer.replaceChildren(edgeDefinitions, ...orderedPaths);
      renderedEdgeGeometry = activeEdges;
    }

    for (const edge of activeEdges) {
      const path = edgeElements.get(edge.id);
      const paint = edgeGradients.get(edge.id);
      const sourceColor = recencyColor(activeStateFor(edge.source));
      const targetColor = recencyColor(activeStateFor(edge.target));
      if (paint?.startStop.getAttribute("stop-color") !== sourceColor) {
        paint?.startStop.setAttribute("stop-color", sourceColor);
      }
      if (paint?.endStop.getAttribute("stop-color") !== targetColor) {
        paint?.endStop.setAttribute("stop-color", targetColor);
      }
      const className = [
        "graph-edge",
        selectedId && !traced.edges.has(edge.id) ? "is-muted" : "",
        traced.edges.has(edge.id) ? "is-traced" : "",
      ].filter(Boolean).join(" ");
      if (path.getAttribute("class") !== className) path.setAttribute("class", className);
    }
  }

  function renderNodes() {
    const traced = tracedIds();
    const query = normalizeTermSearch(searchQuery);
    const activeIds = new Set(layout.nodes.map((node) => node.id));
    for (const nodeId of nodeElements.keys()) {
      if (!activeIds.has(nodeId)) nodeElements.delete(nodeId);
    }
    const orderedButtons = [];
    for (const node of layout.nodes) {
      const position = positions.get(node.id);
      const state = activeStateFor(node.id);
      let button = nodeElements.get(node.id);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.nodeId = node.id;
        button.innerHTML = `<span>${escapeHTML(node.term)}</span>`;
        nodeElements.set(node.id, button);
      }
      button.className = [
        "graph-node",
        selectedId === node.id ? "is-selected" : "",
        traced.nodes.has(node.id) && selectedId !== node.id ? "is-traced" : "",
        selectedId && !traced.nodes.has(node.id) ? "is-muted" : "",
        pins[node.id] ? "is-pinned" : "",
        query && !normalizeTermSearch(node.term).includes(query) ? "is-search-muted" : "",
      ].filter(Boolean).join(" ");
      button.dataset.learning = state.learning;
      button.dataset.freshness = state.freshness;
      button.dataset.progressSource = showsLearnerProgress ? "learner" : "structure";
      button.setAttribute("aria-pressed", String(selectedId === node.id));
      button.style.transform = `translate(${Math.round(position.x)}px, ${Math.round(position.y)}px)`;
      button.style.width = `${node.width}px`;
      button.style.minHeight = `${node.height}px`;
      button.style.borderColor = recencyColor(state);
      button.setAttribute("aria-label", showsLearnerProgress
        ? `${node.term}. Your learning: ${titleCase(state.learning)}. ${formatLastReviewed(state)}. ${formatDue(state)}.`
        : `${node.term}. Course structure preview.`);
      orderedButtons.push(button);
    }
    if (renderedNodeLayout !== layout) {
      nodesLayer.replaceChildren(...orderedButtons);
      renderedNodeLayout = layout;
    }
  }

  function renderInspector() {
    const card = cardById.get(selectedId);
    if (!card) {
      inspector.hidden = true;
      return;
    }
    inspector.hidden = false;
    const state = activeStateFor(card.id);
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
    const history = retainedReviews(state);
    const recent = history.slice(-5).reverse();
    const average = history.length
      ? (history.reduce((sum, review) => sum + ratingValue(review.rating), 0) / history.length).toFixed(1)
      : null;
    const latestRating = state.lastRating ?? recent[0]?.rating ?? null;
    const recentMarkup = recent.length
      ? recent.map((review) => `
          <li><strong>${escapeHTML(ratingLabel(review.rating))}</strong><span>${escapeHTML(formatReviewMoment(review.submittedAt))}</span></li>`).join("")
      : `<li class="is-empty"><span>${latestRating === null ? "No retained score history yet" : `Latest rating: ${escapeHTML(ratingLabel(latestRating))}`}</span></li>`;
    inspector.innerHTML = `
      <div class="graph-inspector-header" data-inspector-drag-handle>
        <div>
          <p class="eyebrow">${escapeHTML(card.moduleMetadata?.title ?? card.module ?? "Concept")}</p>
          <h2>${escapeHTML(card.term)}</h2>
        </div>
        <button class="icon-button graph-inspector-close" type="button" data-graph-action="dismiss" aria-label="Close card info">×</button>
      </div>
      <div class="graph-inspector-body">
      ${showsLearnerProgress ? `<div class="inspector-state" data-progress-source="learner">
        <div><strong>${escapeHTML(titleCase(state.learning))}</strong><span>Learning</span></div>
        <div><strong>${escapeHTML(formatLastReviewed(state))}</strong><span>Recency</span></div>
      </div>` : `<p class="graph-structure-note">Course structure preview. Add this course and study to see your progress here.</p>`}
      <details class="inspector-disclosure inspector-definition">
        <summary>Definition</summary>
        <div class="inspector-definition-content" data-graph-definition></div>
      </details>
      ${showsLearnerProgress ? `<details class="inspector-disclosure inspector-reviews">
        <summary>Reviews <span>${state.reviewCount} total</span></summary>
        <div class="inspector-review-summary">
          <span><strong>${latestRating === null ? "—" : escapeHTML(ratingLabel(latestRating))}</strong>Latest score</span>
          <span><strong>${average ?? "—"}</strong>Average retained</span>
          <span><strong>${escapeHTML(formatDue(state))}</strong>Next review</span>
        </div>
        <ol class="inspector-review-history">${recentMarkup}</ol>
      </details>` : ""}
      <ul class="inspector-list">
        <li><span>Direct prerequisites</span><strong>${directUpstream.nodeIds.length}</strong></li>
        <li><span>Direct dependents</span><strong>${directDownstream.nodeIds.length}</strong></li>
      </ul>
      <div class="card-actions">
        <button class="button button-sm button-quiet" type="button" data-trace="upstream" aria-label="Show prerequisite neighborhood" title="${upstream.nodeIds.length} total prerequisite concepts">Prerequisites</button>
        <button class="button button-sm button-quiet" type="button" data-trace="downstream" aria-label="Show dependent neighborhood" title="${downstream.nodeIds.length} total dependent concepts">Dependents</button>
        ${canStudy ? `<button class="button button-sm" type="button" data-study-card="${escapeHTML(card.id)}">Study</button>` : ""}
      </div>
      </div>`;
    const definition = inspector.querySelector("[data-graph-definition]");
    const displayDefinition = String(card.definition ?? "")
      .replace(/^\s*\*\*Definition\.?\*\*\s*/i, "");
    if (displayDefinition) renderDefinition(definition, displayDefinition);
    else definition.textContent = "No definition is stored for this term.";
  }

  function renderLegend() {
    legend.innerHTML = showsLearnerProgress
      ? `<span class="recency-scale-title">Recency</span><i class="recency-scale" aria-hidden="true"></i>`
      : `<span class="recency-scale-title">Course structure</span>`;
    legend.setAttribute("aria-label", showsLearnerProgress
      ? "Your unlearned cards have gray borders. Reviewed card borders move from white through yellow to red as your reviews become more recent."
      : "Course structure preview. Progress appears after you add and study this course.");
  }

  function applyTransform(next = transform) {
    const viewport = { x: 0, y: 0, width: workspace.clientWidth, height: workspace.clientHeight };
    transform = clampTransform(next, activeBounds, viewport, { visibleMargin: 72, centerSmall: true });
    if (Math.abs(transform.scale - 1) < 0.0005) {
      transform.x = Math.round(transform.x);
      transform.y = Math.round(transform.y);
      transform.scale = 1;
    }
    world.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
    world.dataset.zoom = semanticZoomLevel(transform.scale);
  }

  function centerNode(nodeId, scale = Math.max(1, transform.scale)) {
    const node = nodeById.get(nodeId);
    const position = positions.get(nodeId) ?? node;
    if (!node) return;
    applyTransform({
      scale,
      x: workspace.clientWidth / 2 - (position.x + node.width / 2) * scale,
      y: workspace.clientHeight / 2 - (position.y + node.height / 2) * scale,
    });
  }

  function showCrispDefault() {
    fitAll();
    world.dataset.fitStrategy = "full-deck-default";
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
        minScale: showEntireGraph ? ENTIRE_GRAPH_MIN_SCALE : MIN_SCALE,
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
    cancelInspectorDragging();
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
      if (center && selectedId) centerNode(selectedId, 1);
      else showCrispDefault();
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
      return selectedId ? centerNode(selectedId, 1) : showCrispDefault();
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
      activePath = null;
      traceDirection = trace;
      renderEdges();
      renderNodes();
      renderInspector();
      updateScopeNote(trace === "upstream" ? "prerequisites highlighted" : "dependents highlighted");
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
    cancelInspectorDragging();
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
      cancelInspectorDragging();
    }
  }, { capture: true });

  on(inspector, "pointerdown", (event) => {
    const handle = event.target.closest("[data-inspector-drag-handle]");
    if (!handle || event.target.closest("button") || event.button !== 0 || event.isPrimary === false) return;
    event.stopPropagation();
    const workspaceRect = workspace.getBoundingClientRect();
    const panelRect = inspector.getBoundingClientRect();
    inspectorDragging = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: panelRect.left - workspaceRect.left,
      originTop: panelRect.top - workspaceRect.top,
    };
    inspector.style.left = `${inspectorDragging.originLeft}px`;
    inspector.style.top = `${inspectorDragging.originTop}px`;
    inspector.style.right = "auto";
    inspector.style.bottom = "auto";
    inspector.classList.add("is-dragging");
    inspector.setPointerCapture(event.pointerId);
  });

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
    if (inspectorDragging?.pointerId === event.pointerId) {
      const panelRect = inspector.getBoundingClientRect();
      const maximumLeft = Math.max(8, workspace.clientWidth - panelRect.width - 8);
      const maximumTop = Math.max(8, workspace.clientHeight - panelRect.height - 8);
      const left = Math.max(8, Math.min(maximumLeft,
        inspectorDragging.originLeft + event.clientX - inspectorDragging.startX));
      const top = Math.max(8, Math.min(maximumTop,
        inspectorDragging.originTop + event.clientY - inspectorDragging.startY));
      inspector.style.left = `${left}px`;
      inspector.style.top = `${top}px`;
      return;
    }
    if (!dragging) return;
    if (dragging.pointerId !== event.pointerId) return;
    dragging.moved ||= movedBeyondTap(dragging, event);
    if (!dragging.moved) return;
    const dx = (event.clientX - dragging.startX) / transform.scale;
    const dy = (event.clientY - dragging.startY) / transform.scale;
    const base = nodeById.get(dragging.nodeId);
    const candidate = Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01
      ? { x: dragging.originX, y: dragging.originY }
      : boundedPin(base, {
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
    const finalPosition = positions.get(nodeId) ?? { x: originX, y: originY };
    let geometryChanged = moved && (
      Math.abs(finalPosition.x - originX) > 0.01 ||
      Math.abs(finalPosition.y - originY) > 0.01
    );
    if (moved && !geometryChanged) {
      positions.set(nodeId, { x: originX, y: originY });
      if (originalPin) pins[nodeId] = originalPin;
      else delete pins[nodeId];
    }
    if (geometryChanged) {
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
        geometryChanged = false;
      }
      if (geometryChanged) {
        writePins(pinStorageKey, pins, storage);
        edgesLayer.setAttribute("width", String(activeBounds.maxX + 120));
        edgesLayer.setAttribute("height", String(activeBounds.maxY + 120));
      }
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

  function cancelInspectorDragging() {
    if (!inspectorDragging) return;
    const { pointerId } = inspectorDragging;
    inspectorDragging = null;
    inspector.classList.remove("is-dragging");
    releasePointer(inspector, pointerId);
  }

  on(window, "pointerup", (event) => {
    if (inspectorDragging?.pointerId === event.pointerId) cancelInspectorDragging();
    finishDragging(event);
    if (panning?.pointerId === event.pointerId) {
      const wasTap = !panning.moved && !movedBeyondTap(panning, event);
      cancelPanning();
      if (wasTap) clearSelection();
    }
    activePointers.delete(event.pointerId);
  });

  on(window, "pointercancel", (event) => {
    if (inspectorDragging?.pointerId === event.pointerId) cancelInspectorDragging();
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
    cancelInspectorDragging();
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
    if (showEntireGraph) {
      activePath = result.projection.path ?? null;
      traceDirection = activePath ? "path" : "direct";
      updateScopeNote(notice);
      setSelected(result.match.id, { center: true, preservePath: true });
      return;
    }
    selectedId = result.match.id;
    activePath = result.projection.path ?? null;
    traceDirection = activePath ? "path" : "direct";
    updateScopeNote(notice);
    renderEdges();
    renderNodes();
    renderInspector();
    centerNode(selectedId, 1);
  });

  on(window, "resize", () => {
    cancelInspectorDragging();
    if (selectedId) centerNode(selectedId);
    else showCrispDefault();
  });

  renderEdges();
  renderNodes();
  renderInspector();
  renderLegend();
  requestAnimationFrame(() => selectedId ? centerNode(selectedId, 1) : showCrispDefault());

  return () => listeners.splice(0).forEach((dispose) => dispose());
}
