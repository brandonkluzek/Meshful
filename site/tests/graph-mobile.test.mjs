import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mountGraphView } from "../public/study/js/graph-view.js";

// A provider-free DOM/event double mounts the actual graph view. It models
// bubbling, pointer capture, focus and element replacement, not CSS layout.
class ElementDouble {
  constructor(tag, document) {
    this.tagName = tag;
    this.document = document;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.attributeWrites = new Map();
    this.replaceChildrenCount = 0;
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.value = "";
    this.listeners = new Map();
    this.clientWidth = 390;
    this.clientHeight = 670;
    this.top = tag === "window" ? 0 : 174;
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
    };
  }
  get hidden() { return this.attributes.has("hidden"); }
  set hidden(value) { if (value) this.attributes.set("hidden", ""); else this.attributes.delete("hidden"); }
  setAttribute(name, value) {
    this.attributeWrites.set(name, (this.attributeWrites.get(name) ?? 0) + 1);
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
    if (name.startsWith("data-")) this.dataset[dataKey(name)] = String(value);
  }
  getAttribute(name) {
    if (name === "class") return this.className;
    if (name.startsWith("data-")) return this.dataset[dataKey(name)] ?? null;
    return this.attributes.get(name) ?? null;
  }
  set innerHTML(html) {
    this.html = html;
    this.replaceChildren();
    const stack = [this];
    for (const token of html.matchAll(/<\/?([a-z][\w-]*)([^>]*)>/gi)) {
      if (token[0].startsWith("</")) { stack.pop(); continue; }
      const element = new ElementDouble(token[1], this.document);
      for (const attr of token[2].matchAll(/([:\w-]+)(?:\s*=\s*"([^"]*)")?/g)) {
        element.setAttribute(attr[1], attr[2] ?? "");
      }
      stack.at(-1).append(element);
      if (!/\/\s*>$/.test(token[0]) && !["input", "br", "hr"].includes(token[1])) stack.push(element);
    }
  }
  get innerHTML() { return this.html ?? ""; }
  append(...children) {
    for (const child of children) {
      if (child.tagName === "#fragment") this.append(...child.children);
      else { child.parentNode = this; this.children.push(child); }
    }
  }
  replaceChildren(...children) {
    this.replaceChildrenCount += 1;
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }
  matches(selector) {
    return selector.split(",").some((part) => {
      const match = /^([a-z]+|\.[\w-]+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(part.trim());
      assert.ok(match, "Supported test selector: " + part);
      const [, kind, attribute, value] = match;
      if (kind?.startsWith(".") && !this.classList.contains(kind.slice(1))) return false;
      if (kind && !kind.startsWith(".") && this.tagName !== kind) return false;
      return !attribute || (value === undefined ? this.getAttribute(attribute) !== null : this.getAttribute(attribute) === value);
    });
  }
  closest(selector) {
    for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node;
    return null;
  }
  contains(target) {
    for (let node = target; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(type, callback, options) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ callback, capture: options?.capture ?? false });
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((listener) => listener.callback !== callback));
  }
  setPointerCapture(id) { this.document.captures.set(id, this); }
  hasPointerCapture(id) { return this.document.captures.get(id) === this; }
  releasePointerCapture(id) { if (this.hasPointerCapture(id)) this.document.captures.delete(id); }
  focus() { this.document.activeElement = this; }
  getBoundingClientRect() {
    return { x: 0, left: 0, y: this.top, top: this.top, width: this.clientWidth, height: this.clientHeight };
  }
}

function dataKey(name) {
  return name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function withGraph(callback) {
  const document = { captures: new Map(), activeElement: null };
  document.createElement = (tag) => new ElementDouble(tag, document);
  document.createElementNS = (_, tag) => document.createElement(tag);
  document.createDocumentFragment = () => document.createElement("#fragment");
  const window = document.createElement("window");
  window.innerWidth = 390;
  document.body = document.createElement("body");
  window.append(document.body);
  const container = document.createElement("main");
  document.body.append(container);
  document.activeElement = document.body;
  const storage = new Map();
  let writes = 0;
  let exits = 0;
  let studies = 0;
  const globals = {
    document,
    window,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { writes++; storage.set(key, value); },
    },
    requestAnimationFrame: (callback) => { callback(); return 1; },
  };
  const previous = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.assign(globalThis, globals);
  let dispose;
  try {
    dispose = mountGraphView(container, {
      deck: {
        id: "mobile-fixture",
        title: "Mobile graph",
        cards: ["a", "b", "c", "d"].map((id) => ({ id, term: "Term " + id })),
        edges: [{ id: "a-c", source: "a", target: "c" }, { id: "b-d", source: "b", target: "d" }],
      },
      onBack: () => { exits++; },
      onStudy: () => { studies++; },
    });
    const workspace = container.querySelector("[data-graph-workspace]");
    const inspector = container.querySelector("[data-graph-inspector]");
    const world = container.querySelector("[data-graph-world]");
    const edgesLayer = container.querySelector("[data-graph-edges]");
    function dispatch(target, type, properties = {}) {
      const event = {
        pointerId: 1, button: 0, isPrimary: true, clientX: 20, clientY: 250, detail: 1,
        defaultPrevented: false, stopped: false, ...properties,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; },
      };
      event.target = type.startsWith("pointer") && type !== "pointerdown"
        ? document.captures.get(event.pointerId) ?? target
        : target;
      const path = [];
      for (let node = event.target; node; node = node.parentNode) path.push(node);
      for (const capture of [true, false]) {
        for (const node of capture ? [...path].reverse() : path) {
          for (const listener of node.listeners.get(type) ?? []) {
            if (listener.capture === capture) listener.callback(event);
            if (event.stopped) return event;
          }
        }
      }
      return event;
    }
    const node = (id) => container.querySelector('[data-node-id="' + id + '"]');
    const action = (name) => container.querySelector('[data-graph-action="' + name + '"]');
    const select = (id = "a") => dispatch(node(id), "click", { detail: 0 });
    callback({
      document, window, container, workspace, inspector, world, edgesLayer, dispatch, node, action, select,
      storage, writes: () => writes, exits: () => exits, studies: () => studies,
    });
  } finally {
    dispose?.();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test("selection reuses connector and card elements and only updates their state", () => {
  withGraph(({ edgesLayer, container, node, select, dispatch, action }) => {
    const edge = edgesLayer.querySelector('[data-edge-id="a-c"]');
    const card = node("a");
    const pathWrites = edge.attributeWrites.get("d");
    const replacements = edgesLayer.replaceChildrenCount;
    const nodeReplacements = container.querySelector("[data-graph-nodes]").replaceChildrenCount;
    select("a");
    assert.strictEqual(edgesLayer.querySelector('[data-edge-id="a-c"]'), edge);
    assert.strictEqual(node("a"), card);
    assert.equal(edge.attributeWrites.get("d"), pathWrites);
    assert.equal(edgesLayer.replaceChildrenCount, replacements);
    assert.equal(container.querySelector("[data-graph-nodes]").replaceChildrenCount, nodeReplacements);
    assert.equal(edge.classList.contains("is-traced"), true);
    dispatch(action("dismiss"), "click");
    assert.strictEqual(edgesLayer.querySelector('[data-edge-id="a-c"]'), edge);
    assert.strictEqual(node("a"), card);
    assert.equal(edge.attributeWrites.get("d"), pathWrites);
    assert.equal(edgesLayer.replaceChildrenCount, replacements);
    assert.equal(container.querySelector("[data-graph-nodes]").replaceChildrenCount, nodeReplacements);
    assert.equal(edge.classList.contains("is-traced"), false);
  });
});

test("the mounted graph keeps the full deck, comparison states, and visible context", () => {
  withGraph(({ container, world, edgesLayer, node, select }) => {
    assert.equal(container.querySelectorAll("[data-node-id]").length, 4);
    assert.equal(container.querySelectorAll("[data-graph-scenario]").length, 4);
    assert.equal(world.dataset.fitStrategy, "full-deck-default");
    const marker = edgesLayer.querySelector("marker");
    assert.equal(marker.getAttribute("markerUnits"), "userSpaceOnUse");
    assert.equal(marker.getAttribute("viewBox"), "0 0 14 9");
    assert.equal(marker.getAttribute("markerWidth"), "13");
    assert.equal(marker.querySelector("path").getAttribute("d"), "M 0 0 L 14 4.5 L 0 9 z");
    assert.equal(node("a").dataset.learning, "unseen");
    assert.equal(node("a").style.borderColor, "#626a75");

    select("a");
    assert.equal(edgesLayer.querySelector('[data-edge-id="a-c"]').classList.contains("is-traced"), true);
    assert.equal(edgesLayer.querySelector('[data-edge-id="b-d"]').classList.contains("is-muted"), true);
    assert.equal(node("b").classList.contains("is-muted"), true);
    assert.equal(node("b").dataset.learning, "unseen");
  });
});

test("a drag that returns to its origin skips connector rerouting and persistence", () => {
  withGraph(({ node, dispatch, edgesLayer, writes }) => {
    const edge = edgesLayer.querySelector('[data-edge-id="a-c"]');
    const pathWrites = edge.attributeWrites.get("d");
    const replacements = edgesLayer.replaceChildrenCount;
    const card = node("a");
    dispatch(card, "pointerdown", { clientX: 20, clientY: 250 });
    dispatch(card, "pointermove", { clientX: 60, clientY: 290 });
    dispatch(card, "pointermove", { clientX: 20, clientY: 250 });
    dispatch(card, "pointerup", { clientX: 20, clientY: 250 });
    assert.strictEqual(edgesLayer.querySelector('[data-edge-id="a-c"]'), edge);
    assert.equal(edge.attributeWrites.get("d"), pathWrites);
    assert.equal(edgesLayer.replaceChildrenCount, replacements);
    assert.equal(writes(), 0);
  });
});

test("a node tap opens card info and a blank tap dismisses without moving or persisting", () => {
  withGraph(({ node, dispatch, workspace, inspector, world, writes }) => {
    dispatch(node("a"), "pointerdown");
    dispatch(node("a"), "pointerup");
    assert.equal(inspector.hidden, false);
    assert.equal(node("a").getAttribute("aria-pressed"), "true");
    // A compatibility click retargeted after node replacement must not dismiss.
    dispatch(workspace, "click");
    assert.equal(inspector.hidden, false);
    const transform = world.style.transform;
    dispatch(workspace, "pointerdown");
    dispatch(workspace, "pointerup", { clientX: 24, clientY: 251 });
    assert.equal(inspector.hidden, true);
    assert.equal(world.style.transform, transform);
    assert.equal(node("a").getAttribute("aria-pressed"), "false");
    assert.equal(writes(), 0);
  });
});

test("small finger jitter does not pin a node", () => {
  withGraph(({ node, dispatch, writes, inspector }) => {
    const position = node("a").style.transform;
    dispatch(node("a"), "pointerdown");
    dispatch(node("a"), "pointermove", { clientX: 25, clientY: 254 });
    dispatch(node("a"), "pointerup", { clientX: 25, clientY: 254 });
    assert.equal(node("a").style.transform, position);
    assert.equal(writes(), 0);
    assert.equal(inspector.hidden, false);
  });
});

test("a pan is not a dismissal even when the finger returns to its starting point", () => {
  withGraph(({ select, dispatch, workspace, inspector }) => {
    select();
    dispatch(workspace, "pointerdown");
    dispatch(workspace, "pointermove", { clientX: 70, clientY: 280 });
    dispatch(workspace, "pointermove");
    dispatch(workspace, "pointerup");
    assert.equal(inspector.hidden, false);
    assert.equal(workspace.classList.contains("is-panning"), false);
  });
});

test("only the matching primary pointer can complete a canvas tap", () => {
  withGraph(({ select, dispatch, workspace, inspector }) => {
    select();
    dispatch(workspace, "pointerdown");
    dispatch(workspace, "pointerup", { pointerId: 42, isPrimary: false });
    assert.equal(inspector.hidden, false);
    dispatch(workspace, "pointerup");
    assert.equal(inspector.hidden, true);
    select();
    dispatch(workspace, "pointerdown", { button: 2 });
    dispatch(workspace, "pointerup", { button: 2 });
    assert.equal(inspector.hidden, false);
  });
});

test("cancelled canvas gestures never dismiss and release capture", () => {
  withGraph(({ select, dispatch, workspace, inspector, document }) => {
    select();
    dispatch(workspace, "pointerdown");
    dispatch(workspace, "pointercancel");
    dispatch(workspace, "pointerup");
    assert.equal(inspector.hidden, false);
    assert.equal(workspace.classList.contains("is-panning"), false);
    assert.equal(document.captures.size, 0);
  });
});

test("a second finger cancels a node drag without pinning or changing selection", () => {
  withGraph(({ select, node, dispatch, workspace, inspector, writes }) => {
    select("b");
    const position = node("a").style.transform;
    dispatch(node("a"), "pointerdown");
    dispatch(node("a"), "pointermove", { clientX: 50, clientY: 290 });
    dispatch(workspace, "pointerdown", { pointerId: 2, isPrimary: false });
    dispatch(workspace, "pointerup", { pointerId: 2, isPrimary: false });
    dispatch(workspace, "pointerup");
    assert.equal(node("a").style.transform, position);
    assert.equal(node("b").getAttribute("aria-pressed"), "true");
    assert.equal(inspector.hidden, false);
    assert.equal(writes(), 0);
  });
});

test("pointercancel rolls a node drag back without selecting it", () => {
  withGraph(({ select, node, dispatch, inspector, writes, workspace }) => {
    select("b");
    const position = node("a").style.transform;
    dispatch(node("a"), "pointerdown");
    dispatch(node("a"), "pointermove", { clientX: 60 });
    dispatch(node("a"), "pointercancel");
    assert.equal(node("a").style.transform, position);
    assert.equal(node("b").getAttribute("aria-pressed"), "true");
    assert.equal(inspector.hidden, false);
    assert.equal(workspace.classList.contains("is-dragging-node"), false);
    assert.equal(writes(), 0);
  });
});

test("close card info restores focus, and graph Close exits exactly once", () => {
  withGraph(({ select, dispatch, action, inspector, document, exits }) => {
    select();
    dispatch(action("dismiss"), "click");
    assert.equal(inspector.hidden, true);
    assert.equal(document.activeElement.dataset.nodeId, "a");
    assert.equal(exits(), 0);
    dispatch(action("back"), "click");
    assert.equal(exits(), 1);
  });
});

test("Escape from body dismisses after pointer focus replacement, then exits", () => {
  withGraph(({ node, dispatch, document, inspector, exits }) => {
    dispatch(node("a"), "pointerdown");
    dispatch(node("a"), "pointerup");
    document.activeElement = document.body;
    dispatch(document.activeElement, "keydown", { key: "Escape" });
    assert.equal(inspector.hidden, true);
    assert.equal(exits(), 0);
    dispatch(document.activeElement, "keydown", { key: "Escape" });
    assert.equal(exits(), 1);
  });
});

test("Escape cancels an in-flight drag and release cannot reopen dismissed info", () => {
  withGraph(({ select, node, dispatch, document, inspector, writes }) => {
    select();
    const position = node("a").style.transform;
    dispatch(node("a"), "pointerdown");
    dispatch(node("a"), "pointermove", { clientX: 70, clientY: 290 });
    dispatch(document.body, "keydown", { key: "Escape" });
    dispatch(document.body, "pointerup");
    assert.equal(inspector.hidden, true);
    assert.equal(node("a").style.transform, position);
    assert.equal(writes(), 0);
  });
});

test("Escape in an outside dialog does not close the graph", () => {
  withGraph(({ select, dispatch, document, inspector, exits }) => {
    select();
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    dispatch(dialog, "keydown", { key: "Escape" });
    assert.equal(inspector.hidden, false);
    assert.equal(exits(), 0);
  });
});

test("the info sheet can scroll and its controls do not start canvas gestures", () => {
  withGraph(({ select, dispatch, inspector, workspace, world, studies }) => {
    select();
    const body = inspector.querySelector(".graph-inspector-body");
    const transform = world.style.transform;
    dispatch(body, "pointerdown");
    dispatch(body, "pointerup");
    const wheel = dispatch(body, "wheel", { deltaY: 100 });
    assert.equal(wheel.defaultPrevented, false);
    assert.equal(world.style.transform, transform);
    assert.equal(workspace.classList.contains("is-panning"), false);
    assert.equal(inspector.hidden, false);
    dispatch(inspector.querySelector("[data-study-card]"), "click");
    assert.equal(studies(), 1);
  });
});

test("mobile graph styles keep close controls and sheet scroll within the viewport", async () => {
  const css = await readFile(new URL("../public/study/styles.css", import.meta.url), "utf8");
  assert.match(css, /body\[data-route="graph"\] \.graph-page \{\s*position: fixed;\s*inset: 0;\s*height: 100dvh;/);
  assert.doesNotMatch(css, /body\[data-route="graph"\] \.graph-page \{\s*height: 100vh/);
  assert.match(css, /\.graph-inspector\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.graph-inspector-header \{[^}]*flex: 0 0 auto;/);
  assert.match(css, /\.graph-inspector-body \{[^}]*overflow-y: auto;[^}]*touch-action: pan-y;/);
  assert.match(css, /\.graph-inspector-close \{[^}]*width: 44px;[^}]*height: 44px;/);
  assert.match(css, /\.graph-back \{ grid-column: 2; grid-row: 1; \}/);
  assert.match(css, /max-height: min\(48dvh, calc\(100% - env\(safe-area-inset-bottom\) - 24px\)\)/);
  assert.match(css, /height: calc\(62px \+ env\(safe-area-inset-bottom\)\)/);
  assert.doesNotMatch(css, /\.graph-toolbar \{[^}]*min-height: 150px;/);
  assert.match(css, /\.graph-edge\.is-muted \{ opacity: 0\.34; \}/);
  assert.match(css, /\.graph-edge,\s*\.graph-edge\.is-pulsing \{[^}]*stroke-width: 2\.8;/);
  assert.match(css, /\.graph-edge\.is-traced \{[^}]*stroke-width: 3\.25;/);
  assert.match(css, /\.graph-world\[data-zoom="overview"\] \.graph-node span \{\s*opacity: 0;\s*visibility: hidden;/);
});
