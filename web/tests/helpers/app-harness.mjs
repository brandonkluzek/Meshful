import { readFile } from "node:fs/promises";

const shell = await readFile(new URL("../../index.html", import.meta.url), "utf8");
let instance = 0;

// Exercises the actual app module, store and registered tools without a browser
// dependency. This models DOM/events/timers, not layout or browser persistence.
class ElementDouble {
  constructor(tag, document) {
    this.tagName = tag;
    this.ownerDocument = document;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.className = "";
    this.clientWidth = 1075;
    this.clientHeight = 750;
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
    };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(name) { return name === "class" ? this.className : this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  set hidden(value) { if (value) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
  get hidden() { return this.attributes.has("hidden"); }
  get isConnected() { return this.ownerDocument.body?.contains(this) ?? false; }
  set innerHTML(html) {
    this.html = html;
    this.replaceChildren();
    const stack = [this];
    for (const token of html.matchAll(/<!--[\s\S]*?-->|<\/?([a-z][\w-]*)([^>]*)>|([^<]+)/gi)) {
      if (token[0].startsWith("<!--")) continue;
      if (token[3] !== undefined) { stack.at(-1).append(this.ownerDocument.createTextNode(token[3])); continue; }
      if (token[0].startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
      const element = new ElementDouble(token[1].toLowerCase(), this.ownerDocument);
      for (const attr of token[2].matchAll(/([:\w-]+)(?:\s*=\s*"([^"]*)")?/g)) element.setAttribute(attr[1], attr[2] ?? "");
      stack.at(-1).append(element);
      if (!/\/\s*>$/.test(token[0]) && !["input", "br", "hr", "meta", "link"].includes(element.tagName)) stack.push(element);
    }
  }
  get innerHTML() { return this.html ?? ""; }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  get textContent() { return (this.text ?? "") + this.children.map((node) => node.textContent).join(""); }
  append(...children) {
    for (let child of children) {
      if (typeof child === "string") child = this.ownerDocument.createTextNode(child);
      if (child.tagName === "#fragment") this.append(...child.children);
      else { child.parentNode = this; this.children.push(child); }
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.text = "";
    this.append(...children);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
    this.parentNode = null;
  }
  matches(selector) {
    return selector.split(",").some((part) => {
      const match = /^([a-z]+|\.[\w-]+)?(?:\[([\w-]+)(?:=['"]([^'"]*)['"])?\])?$/.exec(part.trim());
      if (!match) throw new Error("Unsupported test selector: " + part);
      const [, kind, attr, value] = match;
      if (kind?.startsWith(".") && !this.classList.contains(kind.slice(1))) return false;
      if (kind && !kind.startsWith(".") && this.tagName !== kind) return false;
      return !attr || (value === undefined ? this.getAttribute(attr) !== null : this.getAttribute(attr) === value);
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
    return this.children.flatMap((node) => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
  removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((fn) => fn !== callback)); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
}

export async function withApp({ storage, search = "", hash = "#study", storageError = null, reducedMotion = false, accountOptions = null, catalogOptions = null } = {}, callback) {
  const document = { compatMode: "CSS1Compat" };
  document.createElement = (tag) => new ElementDouble(tag, document);
  document.createElementNS = (_, tag) => document.createElement(tag);
  document.createTextNode = (text) => { const node = document.createElement("#text"); node.textContent = text; return node; };
  document.createDocumentFragment = () => document.createElement("#fragment");
  document.body = document.createElement("body");
  document.body.innerHTML = shell;
  document.querySelector = (selector) => document.body.querySelector(selector);
  document.querySelectorAll = (selector) => document.body.querySelectorAll(selector);
  document.addEventListener = (...args) => document.body.addEventListener(...args);
  document.removeEventListener = (...args) => document.body.removeEventListener(...args);
  const registrations = new Map();
  document.modelContext = {
    registerTool(definition) {
      if (registrations.has(definition.name)) throw new Error("Duplicate tool registration");
      registrations.set(definition.name, definition);
    },
    unregisterTool: (name) => registrations.delete(name),
  };
  const window = document.createElement("window");
  window.top = window;
  window.innerWidth = 1075;
  window.matchMedia = () => ({ matches: reducedMotion });
  let timerId = 0;
  let now = 0;
  const timers = new Map();
  const pendingEvents = new Set();
  const schedule = (callback, delay = 0) => { timers.set(++timerId, { callback, at: now + delay }); return timerId; };
  const errors = [];
  const navigations = [];
  const location = {
    search, pathname: "/", origin: "http://test.invalid", href: `http://test.invalid/${search}${hash}`,
    get hash() { return hash; },
    set hash(value) {
      const next = value.startsWith("#") ? value : "#" + value;
      if (next === hash) return;
      hash = next;
      schedule(() => { for (const fn of window.listeners.get("hashchange") ?? []) fn(); });
    },
    assign: (value) => navigations.push(value),
    reload: () => navigations.push("reload"),
  };
  window.location = location;
  const globals = {
    document, window, location,
    console: { ...console, error: (...args) => errors.push(args), warn: (...args) => errors.push(args) },
    setTimeout: schedule,
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => schedule(fn),
    confirm: () => { throw new Error("Tests must explicitly authorize any reset"); },
  };
  const previous = new Map([...Object.keys(globals), "localStorage"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.assign(globalThis, globals);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { if (storageError) throw storageError; return storage; } });
  async function flush(duration = 0) {
    await Promise.all([...pendingEvents]);
    const until = now + duration;
    for (let count = 0; count < 100; count++) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { now = until; return; }
      timers.delete(next[0]);
      now = next[1].at;
      await next[1].callback();
      await Promise.resolve();
    }
    throw new Error("App did not settle within 100 timer callbacks");
  }
  let application;
  try {
    const { initializeWebsite } = await import(new URL(`../../js/app.js?app-test=${++instance}`, import.meta.url));
    const { CATALOG } = await import("../../data/catalog.js");
    application = initializeWebsite ? await initializeWebsite({ accountOptions, catalogOptions: catalogOptions ?? { catalog: CATALOG, seedExamples: true } }) : undefined;
    await flush();
    const view = document.querySelector("[data-view]");
    await callback({
      document, window, view, location, errors, navigations, registrations, flush, application,
      click(selector) {
        const target = document.querySelector(selector);
        if (!target) throw new Error("No click target: " + selector);
        for (const listener of document.body.listeners.get("click") ?? []) {
          const work = Promise.resolve(listener({ target }));
          pendingEvents.add(work);
          work.finally(() => pendingEvents.delete(work));
        }
      },
      async navigate(nextHash) { location.hash = nextHash; await flush(); },
      async execute(name, input) {
        const tool = registrations.get(name);
        if (!tool) throw new Error("Tool is not registered: " + name);
        return tool.execute(input);
      },
    });
  } finally {
    application?.dispose?.();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}
