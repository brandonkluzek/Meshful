import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createBrowserWorkspace, LEARNER_STORAGE_KEY } from "../public/study/js/browser-workspace.js";
import { createMemoryStorage, createStudyStore } from "../public/study/js/store.js";

// Every case replaces browser globals, so explicitly serialize this file even
// when the surrounding runner enables top-level concurrency.
const serialTest = (name, callback) => test(name, { concurrency: false }, callback);

const SEARCH = "?recording=study-card-ui-successor";
const CATALOG_OPTIONS = { catalog: [], seedExamples: false };
const shell = `
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="app-shell" data-app-shell>
    <header class="topbar"><button data-action="open-account" aria-label="Open account"></button></header>
    <main id="main" class="main" tabindex="-1">
      <div data-loading role="status"></div>
      <div data-view hidden></div>
    </main>
    <nav class="mobile-nav"><a href="#study" data-nav="study">Study</a><a href="#decks" data-nav="decks">My Decks</a><a href="#library" data-nav="library">Library</a></nav>
  </div>
  <dialog data-deck-dialog><div data-deck-dialog-content></div></dialog>
  <dialog data-account-dialog></dialog>
  <dialog data-settings-dialog></dialog>
  <div data-toasts></div>`;

let appInstance = 0;

// Same boundary as the retained app harness: exercise the actual app/store/tool
// modules with deterministic DOM, events and timers. This is not layout proof.
class ElementDouble {
  constructor(tag, document) {
    this.tagName = tag;
    this.ownerDocument = document;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    const dataset = {};
    this.dataset = new Proxy(dataset, {
      set: (target, key, value) => {
        target[key] = String(value);
        const attribute = String(key).replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
        this.attributes.set(`data-${attribute}`, String(value));
        return true;
      },
      deleteProperty: (target, key) => {
        delete target[key];
        const attribute = String(key).replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
        this.attributes.delete(`data-${attribute}`);
        return true;
      },
    });
    this.style = {};
    this.listeners = new Map();
    this.className = "";
    this.clientWidth = 1075;
    this.clientHeight = 750;
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => {
        this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" ");
      },
      remove: (...names) => {
        this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" ");
      },
    };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
    if (name.startsWith("data-")) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_, character) => character.toUpperCase())] = String(value);
    }
  }
  getAttribute(name) {
    if (name === "class") return this.className;
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.startsWith("data-")) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, character) => character.toUpperCase())];
  }
  set hidden(value) { if (value) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
  get hidden() { return this.hasAttribute("hidden"); }
  get isConnected() { return this.ownerDocument.body?.contains(this) ?? false; }
  set innerHTML(html) {
    this.html = html;
    this.replaceChildren();
    const stack = [this];
    for (const token of html.matchAll(/<!--[\s\S]*?-->|<\/?([a-z][\w-]*)([^>]*)>|([^<]+)/gi)) {
      if (token[0].startsWith("<!--")) continue;
      if (token[3] !== undefined) {
        stack.at(-1).append(this.ownerDocument.createTextNode(token[3]));
        continue;
      }
      if (token[0].startsWith("</")) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const element = new ElementDouble(token[1].toLowerCase(), this.ownerDocument);
      for (const attribute of token[2].matchAll(/([:\w-]+)(?:\s*=\s*"([^"]*)")?/g)) {
        element.setAttribute(attribute[1], attribute[2] ?? "");
      }
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
      else {
        child.parentNode = this;
        this.children.push(child);
      }
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
      if (!match) throw new Error(`Unsupported test selector: ${part}`);
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
    return this.children.flatMap((node) => [
      ...(node.matches(selector) ? [node] : []),
      ...node.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(type, callback) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((listener) => listener !== callback));
  }
  focus() { this.ownerDocument.activeElement = this; }
  show() { this.open = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
}

async function withApp({ storage, hash, reducedMotion = false, mobile = false, agentHost = true }, callback) {
  const document = { compatMode: "CSS1Compat", visibilityState: "visible", hidden: false };
  document.createElement = (tag) => new ElementDouble(tag, document);
  document.createElementNS = (_, tag) => document.createElement(tag);
  document.createTextNode = (value) => {
    const node = document.createElement("#text");
    node.textContent = value;
    return node;
  };
  document.createDocumentFragment = () => document.createElement("#fragment");
  document.body = document.createElement("body");
  document.body.innerHTML = shell;
  document.querySelector = (selector) => document.body.querySelector(selector);
  document.querySelectorAll = (selector) => document.body.querySelectorAll(selector);
  document.addEventListener = (...args) => document.body.addEventListener(...args);
  document.removeEventListener = (...args) => document.body.removeEventListener(...args);

  const registrations = new Map();
  if (agentHost) {
    document.modelContext = {
      registerTool(definition) { registrations.set(definition.name, definition); },
      unregisterTool(name) { registrations.delete(name); },
    };
  }

  const window = document.createElement("window");
  window.top = window;
  window.innerWidth = mobile ? 390 : 1075;
  window.matchMedia = (query) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotion
      : query.includes("max-width") || query.includes("pointer: coarse") ? mobile
        : false,
    addEventListener() {},
    removeEventListener() {},
  });
  const opened = [];
  window.open = (...args) => { opened.push(args); return null; };

  let timerId = 0;
  let now = 0;
  const timers = new Map();
  const pendingEvents = new Set();
  const schedule = (handler, delay = 0) => {
    timers.set(++timerId, { handler, at: now + Number(delay || 0) });
    return timerId;
  };
  const location = {
    search: SEARCH,
    pathname: "/",
    origin: "http://test.invalid",
    href: `http://test.invalid/${SEARCH}${hash}`,
    get hash() { return hash; },
    set hash(value) {
      const next = value.startsWith("#") ? value : `#${value}`;
      if (next === hash) return;
      hash = next;
      schedule(() => Promise.all((window.listeners.get("hashchange") ?? []).map((listener) => listener())));
    },
    assign() {},
    reload() {},
  };
  window.location = location;
  const clipboardWrites = [];
  const navigator = { clipboard: { async writeText(value) { clipboardWrites.push(value); } } };
  window.navigator = navigator;
  const errors = [];
  const globals = {
    document,
    window,
    location,
    console: { ...console, error: (...args) => errors.push(args), warn: (...args) => errors.push(args) },
    setTimeout: schedule,
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (handler) => schedule(handler),
    confirm: () => { throw new Error("This focused test never authorizes a browser mutation prompt."); },
  };
  const previous = new Map([...Object.keys(globals), "localStorage", "navigator"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]));
  Object.assign(globalThis, globals);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });

  async function flush(duration = 0) {
    const until = now + duration;
    for (let count = 0; count < 200; count++) {
      await Promise.resolve();
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) {
        now = until;
        await Promise.resolve();
        return;
      }
      timers.delete(next[0]);
      now = next[1].at;
      await next[1].handler();
    }
    throw new Error("Study-card app did not settle within 200 timer callbacks.");
  }

  let application;
  try {
    const appModule = await import(new URL(`../public/study/js/app.js?study-card-ui=${++appInstance}`, import.meta.url));
    application = await appModule.initializeWebsite({ catalogOptions: CATALOG_OPTIONS });
    await flush();
    const view = document.querySelector("[data-view]");
    await callback({
      clipboardWrites,
      document,
      errors,
      flush,
      location,
      opened,
      registrations,
      view,
      window,
      click(selector) {
        const target = document.querySelector(selector);
        if (!target) throw new Error(`No click target: ${selector}`);
        const workItems = [];
        for (const listener of document.body.listeners.get("click") ?? []) {
          const work = Promise.resolve(listener({ target }));
          pendingEvents.add(work);
          void work.finally(() => pendingEvents.delete(work));
          workItems.push(work);
        }
        return Promise.all(workItems);
      },
      async settleEvents() {
        await Promise.all(pendingEvents);
        await flush();
      },
      execute(name, input) {
        const tool = registrations.get(name);
        if (!tool) throw new Error(`Tool is not registered: ${name}`);
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

function seedDeck(store, deckId, count) {
  store.ingestDeck({
    operation: "create",
    idempotency_key: `seed:${deckId}`,
    deck: {
      schema_version: "normalized-definition-deck.v2",
      deck_id: deckId,
      title: "Study card UI fixture",
      cards: Array.from({ length: count }, (_, index) => ({
        id: `term${index + 1}`,
        term: `Term ${index + 1}`,
        definition: `PRIVATE_DEFINITION_${index + 1}`,
        criteria: [`PRIVATE_CRITERION_${index + 1}`],
      })),
      edges: [],
    },
  });
}

function gradeInput(current, key, rating = "good") {
  return {
    session_id: current.session.session_id,
    expected_session_revision: current.session.session_revision,
    card_id: current.current_card.card_id,
    expected_card_revision: current.current_card.card_revision,
    answer_text: "Injected provider-free mechanics answer, not learner evidence.",
    answer_origin: "chat",
    rating,
    rubric_evidence: current.current_card.required_concepts.map((item) => ({
      rubric_item_id: item.rubric_item_id,
      status: rating === "again" ? "missed" : "met",
      note: "Injected Study-card UI mechanics evidence.",
    })),
    feedback: "Injected Study-card UI mechanics feedback.",
    misconceptions: [],
    confidence: 1,
    idempotency_key: `grade:${key}`,
  };
}

function freshFixture(count = 3, deckId = "study-card-ui") {
  deckId = deckId.toLowerCase();
  const storage = createMemoryStorage({ [LEARNER_STORAGE_KEY]: "normal-learner-bytes-must-stay-untouched" });
  const scoped = createBrowserWorkspace(SEARCH, () => storage).storage;
  const store = createStudyStore({ catalog: [], storage: scoped });
  seedDeck(store, deckId, count);
  const opened = store.startStudySession({ deck_id: deckId, limit: count, idempotency_key: `start:${deckId}` });
  return { deckId, opened, scoped, storage, store };
}

function dueThenContinuousFixture() {
  const fixture = freshFixture(3, "due-then-continuous");
  const initialSession = fixture.opened.session.session_id;
  for (let index = 0; index < 3; index++) {
    const current = fixture.store.getStudySession({ session_id: initialSession });
    fixture.store.submitGrade(gradeInput(current, `introduce:${index}`));
  }
  const state = JSON.parse(fixture.scoped.getItem(LEARNER_STORAGE_KEY));
  const deck = state.personalDecks[fixture.deckId];
  const currentTime = Date.now();
  for (const [index, id] of deck.cardOrder.entries()) {
    deck.cards[id].review.dueAt = new Date(currentTime + (index < 2 ? -60_000 : 86_400_000)).toISOString();
  }
  fixture.scoped.setItem(LEARNER_STORAGE_KEY, JSON.stringify(state));
  // The persisted edit models time passing between sessions. Rehydrate so the
  // canonical scheduler, not test-only object mutation, derives the new queue.
  fixture.store = createStudyStore({ catalog: [], storage: fixture.scoped });
  fixture.opened = fixture.store.startStudySession({
    deck_id: fixture.deckId,
    limit: 3,
    idempotency_key: "start:due-then-continuous:second",
  });
  assert.equal(fixture.opened.session.due_segment_total, 2);
  return fixture;
}

async function settleMicrotasks() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

async function settleCommittedReveal(ui, pending) {
  const result = await pending;
  await ui.flush();
  return result;
}

async function advanceCommittedReveal(ui) {
  await ui.click("[data-advance-study-card]");
  await ui.flush(500);
}

function readCurrent(fixture) {
  return createStudyStore({ catalog: [], storage: fixture.scoped })
    .getStudySession({ session_id: fixture.opened.session.session_id });
}

serialTest("session header uses the canonical due segment and then a separate continuous counter", async () => {
  const fixture = dueThenContinuousFixture();
  await withApp({ storage: fixture.storage, hash: `#session/${fixture.opened.session.session_id}` }, async (ui) => {
    assert.equal(ui.view.querySelector("[data-session-progress]")?.textContent.trim(), "1 of 2 due");

    let current = readCurrent(fixture);
    let pending = ui.execute("submit_grade", gradeInput(current, "due:1"));
    await settleMicrotasks();
    await settleCommittedReveal(ui, pending);
    assert.equal(ui.view.querySelector("[data-session-progress]")?.textContent.trim(), "1 of 2 due");
    await advanceCommittedReveal(ui);
    assert.equal(ui.view.querySelector("[data-session-progress]")?.textContent.trim(), "2 of 2 due");

    current = readCurrent(fixture);
    pending = ui.execute("submit_grade", gradeInput(current, "due:2"));
    await settleMicrotasks();
    await settleCommittedReveal(ui, pending);
    assert.equal(ui.view.querySelector("[data-session-progress]")?.textContent.trim(), "2 of 2 due");
    await advanceCommittedReveal(ui);
    assert.equal(ui.view.querySelector("[data-session-progress]")?.textContent.trim(), "Continuous · 1");
    assert.deepEqual(ui.errors, []);
  });
});

for (const rating of ["again", "hard", "good", "easy"]) {
  serialTest(`${rating} holds its committed definition until one explicit next-card departure`, async () => {
    const fixture = freshFixture(2, `outcome-${rating}`);
    await withApp({ storage: fixture.storage, hash: `#session/${fixture.opened.session.session_id}` }, async (ui) => {
      const scene = ui.view.querySelector("[data-study-card-scene]");
      let departures = 0;
      const add = scene.classList.add;
      scene.classList.add = (...names) => {
        departures += names.filter((name) => name === "is-departing").length;
        add(...names);
      };
      const pending = ui.execute("submit_grade", gradeInput(fixture.opened, `outcome:${rating}`, rating));
      await settleMicrotasks();
      assert.equal(scene.classList.contains("is-flipped"), true);
      assert.equal(scene.dataset.studyOutcome, rating);
      assert.match(scene.querySelector("[data-study-definition]").textContent, /PRIVATE.?DEFINITION.?1/);
      assert.equal(ui.view.querySelector("[data-session-completion]"), null);
      assert.equal((await settleCommittedReveal(ui, pending)).ok, true);
      const committedBytes = fixture.scoped.getItem(LEARNER_STORAGE_KEY);
      assert.equal(ui.view.querySelector("[data-advance-study-card]")?.textContent, "Next card");
      await ui.flush(60_000);
      assert.equal(ui.view.querySelector("[data-study-card-scene]"), scene);
      assert.equal(departures, 0);
      await advanceCommittedReveal(ui);
      const nextScene = ui.view.querySelector("[data-study-card-scene]");
      assert.equal(departures, 1);
      assert.notEqual(nextScene, scene);
      assert.equal(nextScene.querySelector(".study-term")?.textContent.trim(), "Term 2");
      assert.equal(nextScene.querySelector("[data-study-definition]")?.textContent.trim(), "");
      assert.doesNotMatch(ui.view.textContent, /PRIVATE.?DEFINITION.?1/);
      assert.equal(fixture.scoped.getItem(LEARNER_STORAGE_KEY), committedBytes, "Next card is presentation-only");
      assert.deepEqual(ui.errors, []);
    });
  });
}

serialTest("the final definition waits for Finish session without another stored change", async () => {
  const fixture = freshFixture(1, "final-reveal");
  await withApp({ storage: fixture.storage, hash: `#session/${fixture.opened.session.session_id}` }, async (ui) => {
    const scene = ui.view.querySelector("[data-study-card-scene]");
    const pending = ui.execute("submit_grade", gradeInput(fixture.opened, "final-reveal"));
    await settleMicrotasks();
    assert.equal(scene.classList.contains("is-flipped"), true);
    assert.match(scene.querySelector("[data-study-definition]").textContent, /PRIVATE.?DEFINITION.?1/);
    assert.equal(ui.view.querySelector("[data-session-completion]"), null);
    assert.equal((await settleCommittedReveal(ui, pending)).ok, true);
    const committedBytes = fixture.scoped.getItem(LEARNER_STORAGE_KEY);
    assert.equal(ui.view.querySelector("[data-advance-study-card]")?.textContent, "Finish session");
    await ui.flush(60_000);
    assert.equal(ui.view.querySelector("[data-study-card-scene]"), scene);
    assert.equal(ui.view.querySelector("[data-session-completion]"), null);
    await advanceCommittedReveal(ui);
    assert.match(ui.view.querySelector("[data-session-completion]")?.textContent ?? "", /Session complete/);
    assert.equal(fixture.scoped.getItem(LEARNER_STORAGE_KEY), committedBytes, "Finish session is presentation-only");
    assert.deepEqual(ui.errors, []);
  });
});

for (const host of [
  { label: "agent desktop", agentHost: true, mobile: false, copy: /Need an agent\?.*Answer this term in ChatGPT or Codex\./i },
  { label: "standalone Chrome", agentHost: false, mobile: false, copy: /Need an agent\?.*Answer this term in ChatGPT or Codex\./i },
  { label: "mobile", agentHost: false, mobile: true, copy: /Study on desktop.*Open Meshful in ChatGPT or Codex\./i },
]) {
  serialTest(`delayed help is once-per-session, dismissible, and specific to ${host.label}`, async () => {
    const fixture = freshFixture(1, `help-${host.label.replaceAll(" ", "-")}`);
    await withApp({ storage: fixture.storage, hash: `#session/${fixture.opened.session.session_id}`,
      agentHost: host.agentHost, mobile: host.mobile }, async (ui) => {
      assert.equal(ui.document.querySelector("[data-study-agent-help]"), null);
      assert.equal(ui.document.querySelector("[data-show-study-help]")?.getAttribute("aria-expanded"), "false");
      await ui.flush(39_999);
      assert.equal(ui.document.querySelector("[data-study-agent-help]"), null);
      await ui.flush(1);
      const help = ui.document.querySelector("[data-study-agent-help]");
      assert.ok(help);
      assert.equal(help.getAttribute("role"), "region");
      assert.equal(ui.document.querySelector("[data-show-study-help]")?.getAttribute("aria-expanded"), "true");
      assert.match(help.textContent, host.copy);
      assert.ok(help.querySelector("[data-dismiss-study-help]"));
      ui.click("[data-dismiss-study-help]");
      await ui.settleEvents();
      assert.equal(ui.document.querySelector("[data-study-agent-help]"), null);
      assert.equal(ui.document.querySelector("[data-show-study-help]")?.getAttribute("aria-expanded"), "false");
      await ui.flush(60_000);
      assert.equal(ui.document.querySelector("[data-study-agent-help]"), null, "dismissal does not nag again in the same session");
    });
  });
}

serialTest("desktop help copy is identical in agent-hosted and standalone Chrome contexts", async () => {
  const copies = [];
  for (const agentHost of [true, false]) {
    const fixture = freshFixture(1, `same-desktop-help-${agentHost}`);
    await withApp({ storage: fixture.storage, hash: `#session/${fixture.opened.session.session_id}`, agentHost }, async (ui) => {
      ui.click("[data-show-study-help]");
      await ui.settleEvents();
      copies.push(ui.document.querySelector("[data-study-agent-help]")?.textContent.replace(/\s+/g, " ").trim());
    });
  }
  assert.equal(copies[0], copies[1]);
});

serialTest("a dismissed help nudge stays quiet after the next card in the same session", async () => {
  const fixture = freshFixture(2, "help-once-per-session");
  await withApp({ storage: fixture.storage, hash: `#session/${fixture.opened.session.session_id}` }, async (ui) => {
    const firstScene = ui.view.querySelector("[data-study-card-scene]");
    ui.click("[data-show-study-help]");
    await ui.settleEvents();
    assert.ok(ui.document.querySelector("[data-study-agent-help]"));
    ui.click("[data-dismiss-study-help]");
    await ui.settleEvents();

    const pending = ui.execute("submit_grade", gradeInput(fixture.opened, "help-once-per-session"));
    await settleMicrotasks();
    await settleCommittedReveal(ui, pending);
    await advanceCommittedReveal(ui);
    assert.notEqual(ui.view.querySelector("[data-study-card-scene]"), firstScene);
    await ui.flush(40_000);
    assert.equal(ui.document.querySelector("[data-study-agent-help]"), null);
  });
});

serialTest("Reveal and Skip obey independent capabilities and keep distinct committed presentation", async () => {
  const capabilityStore = createStudyStore({ catalog: [], storage: createMemoryStorage() });
  const capabilities = capabilityStore.getSnapshot().capabilities ?? {};
  for (const action of ["reveal", "skip"]) {
    const fixture = freshFixture(2, `${action}-capability`);
    const selector = action === "reveal" ? "[data-reveal-answer]" : "[data-skip-card]";
    const capability = action === "reveal" ? "revealed_attempts" : "skipped_attempts";
    await withApp({ storage: fixture.storage, hash: `#session/${fixture.opened.session.session_id}` }, async (ui) => {
      const before = fixture.scoped.getItem(LEARNER_STORAGE_KEY);
      const scene = ui.view.querySelector("[data-study-card-scene]");
      const control = ui.view.querySelector(selector);
      if (capabilities[capability] !== true) {
        assert.ok(!control || control.disabled === true || control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true");
        assert.equal(fixture.scoped.getItem(LEARNER_STORAGE_KEY), before);
        assert.equal(scene.classList.contains("is-flipped"), false);
        assert.equal(scene.querySelector("[data-study-definition]").textContent, "");
        return;
      }

      assert.ok(control);
      await ui.click(selector);
      await ui.flush();
      const warning = ui.document.querySelector("[data-study-nonanswer-warning]");
      assert.ok(warning);
      assert.equal(warning.tagName, "dialog");
      assert.equal(warning.getAttribute("role"), "dialog");
      assert.equal(warning.getAttribute("aria-modal"), "false");
      assert.equal(ui.document.querySelector("[data-deck-dialog]").open, undefined);
      assert.equal(fixture.scoped.getItem(LEARNER_STORAGE_KEY), before);
      assert.equal(scene.classList.contains("is-flipped"), false);
      assert.equal(scene.querySelector("[data-study-definition]").textContent, "");

      if (action === "reveal") {
        await ui.click("[data-cancel-study-nonanswer]");
        await ui.flush();
        assert.equal(ui.document.querySelector("[data-study-nonanswer-warning]"), null);
        assert.equal(ui.document.activeElement, control);
        assert.equal(fixture.scoped.getItem(LEARNER_STORAGE_KEY), before);
        await ui.click(selector);
        await ui.flush();
        assert.ok(ui.document.querySelector("[data-study-nonanswer-warning]"));
      }

      const pending = ui.click("[data-confirm-study-nonanswer]");
      await settleMicrotasks();
      const committed = JSON.parse(fixture.scoped.getItem(LEARNER_STORAGE_KEY));
      const persisted = committed.sessions[fixture.opened.session.session_id];
      assert.equal(persisted.reviewsApplied, 1);
      assert.equal(persisted.history.filter((event) => event.transition === "grade_submitted").length, 1);
      assert.equal(persisted.history.at(-1).attempt_kind, action);
      assert.equal(persisted.history.at(-1).rating, "again");
      if (action === "reveal") {
        assert.equal(scene.classList.contains("is-flipped"), true);
        assert.match(scene.querySelector("[data-study-definition]").textContent, /PRIVATE.?DEFINITION.?1/);
        await pending;
        await ui.flush(60_000);
        assert.equal(ui.view.querySelector("[data-study-card-scene]"), scene);
        assert.equal(ui.view.querySelector("[data-advance-study-card]")?.textContent, "Next card");
        const committedBytes = fixture.scoped.getItem(LEARNER_STORAGE_KEY);
        await advanceCommittedReveal(ui);
        assert.equal(fixture.scoped.getItem(LEARNER_STORAGE_KEY), committedBytes);
      } else {
        assert.equal(scene.classList.contains("is-flipped"), false);
        assert.equal(scene.querySelector("[data-study-definition]").textContent, "");
        assert.equal(ui.view.querySelector("[data-advance-study-card]"), null);
        await ui.flush(5_000);
        await pending;
        await ui.flush();
      }
      assert.notEqual(ui.view.querySelector("[data-study-card-scene]"), scene);
      const after = JSON.parse(fixture.scoped.getItem(LEARNER_STORAGE_KEY));
      assert.equal(after.sessions[fixture.opened.session.session_id].reviewsApplied, 1);
      assert.deepEqual(ui.errors, []);
    });
  }
});

serialTest("one confirmed non-answer warning covers Reveal and Skip for that session", async () => {
  const capabilityStore = createStudyStore({ catalog: [], storage: createMemoryStorage() });
  const capabilities = capabilityStore.getSnapshot().capabilities ?? {};
  const fixture = freshFixture(3, "shared-nonanswer-warning");
  await withApp({ storage: fixture.storage, hash: `#session/${fixture.opened.session.session_id}` }, async (ui) => {
    if (capabilities.revealed_attempts !== true || capabilities.skipped_attempts !== true) {
      assert.equal(ui.view.querySelector("[data-study-nonanswer-warning]"), null);
      return;
    }

    const before = fixture.scoped.getItem(LEARNER_STORAGE_KEY);
    await ui.click("[data-reveal-answer]");
    await ui.flush();
    assert.ok(ui.view.querySelector("[data-study-nonanswer-warning]"));
    await ui.click("[data-cancel-study-nonanswer]");
    await ui.flush();
    assert.equal(ui.view.querySelector("[data-study-nonanswer-warning]"), null);
    assert.equal(fixture.scoped.getItem(LEARNER_STORAGE_KEY), before);

    await ui.click("[data-reveal-answer]");
    await ui.flush();
    const revealPending = ui.click("[data-confirm-study-nonanswer]");
    await settleMicrotasks();
    assert.equal(JSON.parse(fixture.scoped.getItem(LEARNER_STORAGE_KEY)).sessions[fixture.opened.session.session_id].reviewsApplied, 1);
    await settleCommittedReveal(ui, revealPending);
    await advanceCommittedReveal(ui);

    const skipPending = ui.click("[data-skip-card]");
    await settleMicrotasks();
    assert.equal(ui.view.querySelector("[data-study-nonanswer-warning]"), null, "the accepted warning is shared across both actions");
    await ui.flush(5_000);
    await skipPending;
    await ui.flush();
    const after = JSON.parse(fixture.scoped.getItem(LEARNER_STORAGE_KEY));
    assert.equal(after.sessions[fixture.opened.session.session_id].reviewsApplied, 2);
    assert.equal(after.sessions[fixture.opened.session.session_id].history.filter((event) => event.transition === "grade_submitted").length, 2);
    assert.deepEqual(ui.errors, []);
  });
});

serialTest("session presentation exposes readable controls and a reduced-motion fallback", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../public/study/js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/study/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /data-session-progress/);
  assert.match(app, /data-study-live-status aria-live="polite"/);
  assert.match(app, /data-study-agent-help/);
  assert.match(app, /data-dismiss-study-help/);
  assert.match(app, /const STUDY_HELP_DELAY_MS = 40_000/);
  assert.match(app, /allowReveal \? '<button[^']*data-reveal-answer>Reveal answer<\/button>'/);
  assert.match(app, /allowSkip \? '<button[^']*data-skip-card>Skip card<\/button>'/);
  assert.doesNotMatch(app, /Reveal \/ skip/);
  assert.match(app, /data-show-study-help aria-label="How to answer" title="How to answer" aria-controls="study-agent-help" aria-expanded=/);
  assert.match(app, /role="group" aria-label="Study actions"/);
  assert.match(app, /action === "reveal" \? "revealed_attempts"/);
  assert.match(app, /action === "skip" \? "skipped_attempts"/);
  assert.match(app, /studyNonAnswerAcknowledgedSessions: new Set\(\)/);
  assert.match(app, /if \(ui\.studyNonAnswerAcknowledgedSessions\.has\(session\.id\)\) \{\s*return submitNonAnswerCard\(request, context\);/);
  assert.match(app, /document\.createElement\("dialog"\)[\s\S]*?"role", "dialog"[\s\S]*?aria-modal", "false"[\s\S]*?warning\.show\(\)/);
  assert.match(app, /Confirm once and we won’t ask again this session\./);
  assert.match(app, /data-cancel-study-nonanswer/);
  assert.match(app, /ui\.studyNonAnswerAcknowledgedSessions\.add\(confirmNonAnswer\.dataset\.sessionId\);[\s\S]*?submitNonAnswerCard\(confirmNonAnswer, context\)/);
  assert.match(app, /if \(view\.querySelector\("\[data-study-nonanswer-warning\]"\)\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?closeStudyNonAnswerConfirmation\(\{ restoreFocus: true \}\)/);
  assert.doesNotMatch(app.match(/function showStudyNonAnswerConfirmation[\s\S]*?\n\}/)?.[0] ?? "", /deckDialogContent|showModal/);
  assert.match(app, /attempt_kind: action/);
  assert.match(app, /if \(presentationAction === "skip"\)[\s\S]*Moving to the next card without revealing the answer\.[\s\S]*scene\.classList\.add\("is-departing"\);/);
  assert.match(app, /renderDefinition\(definition,[\s\S]*revealStudyCardFaces\(scene\);[\s\S]*data-study-advance-pending/);
  assert.match(app, /next\.dataset\.advanceStudyCard = "true";[\s\S]*next\.textContent = nextLabel;[\s\S]*actions\.replaceChildren\(next\);/);
  assert.match(app, /const advanceStudyCard = target\.closest\("\[data-advance-study-card\]"\);[\s\S]*scene\?\.classList\.add\("is-departing"\);[\s\S]*queueRender\(delay, null, true\);/);
  assert.match(app, /if \(!completesReveal && view\.querySelector\("\[data-study-advance-pending\]"\)\) return;/);
  assert.doesNotMatch(app, /await waitForReveal\(1_280\)/);
  assert.match(app, /const helpKey = session\.id;/);
  assert.match(app, /document\.addEventListener\("visibilitychange",[\s\S]*if \(document\.hidden\) pauseStudyHelpTimer\(\);[\s\S]*else armStudyHelpTimer\(\);/);
  assert.match(app, /data-study-outcome/);
  assert.match(app, /data-session-completion/);
  assert.match(app, /label: `Continuous · \$\{position\}`/);

  assert.match(css, /\.session-deck-name\s*\{[^}]*font-size:\s*(?:16px|1rem|clamp\([^;]*16px\))/s);
  assert.match(css, /\.session-progress strong\s*\{[^}]*font-size:\s*(?:15px|0\.9375rem|clamp\([^;]*15px\))/s);
  assert.match(css, /\[data-session-progress\]\[data-progress-mode="continuous"\]\s*\{[^}]*color:\s*var\(--ink-1\);[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;/s);
  assert.match(css, /\[data-session-progress\]\[data-progress-mode="continuous"\]::before\s*\{[^}]*display:\s*none;[^}]*content:\s*none;/s);
  assert.match(css, /\.session-progress-continuous \.progress-track span\s*\{[^}]*width:\s*32%;[^}]*background:\s*var\(--ink-1\);[^}]*animation:\s*study-continuous-progress 6\.5s linear infinite;/s);
  assert.match(css, /\.session-exit\s*\{[^}]*min-height:\s*(?:44px|2\.75rem)[^}]*min-width:/s);
  assert.match(css, /\.study-control-actions\s*\{[^}]*padding-inline:\s*50px/s);
  assert.match(css, /\.study-help-button\s*\{[^}]*position:\s*absolute;[^}]*width:\s*44px;[^}]*height:\s*44px;[^}]*color:\s*var\(--ink-1\);[^}]*background:\s*var\(--surface-2\);[^}]*border:\s*1px solid var\(--line-strong\);/s);
  assert.match(css, /\.study-reveal-action,[\s\S]*\.study-skip-action,[\s\S]*\.study-next-action\s*\{[^}]*min-height:\s*44px;/);
  assert.match(css, /\.study-nonanswer-warning\s*\{[^}]*position:\s*static;[^}]*width:\s*min\(360px, calc\(100% - 24px\)\);[^}]*padding:\s*12px 14px;[^}]*background:\s*var\(--surface-2\);[^}]*box-shadow:\s*0 10px 24px rgba\(0, 0, 0, 0\.2\);/s);
  assert.match(css, /\.study-nonanswer-warning::backdrop\s*\{[^}]*display:\s*none;[^}]*background:\s*transparent;[^}]*backdrop-filter:\s*none;/s);
  assert.match(css, /\.study-card-scene\.is-flipped\.is-departing\s*\{[^}]*transform:[^;}]*rotateY\(180deg\)/s);
  assert.match(css, /\.study-agent-help,\s*\n\[data-study-agent-help\]\s*\{[^}]*background:\s*var\(--surface-1\);/s);
  assert.match(css, /\.session-complete\[hidden\],[\s\S]*\[data-study-agent-help\]\[hidden\]\s*\{[^}]*display:\s*none !important;/);
  assert.match(css, /\.session-complete\[data-session-completion\]\s*\{[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration:\s*0\.001ms !important;[\s\S]*transition-duration:\s*0\.001ms !important;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.study-completion-mark i\s*\{[^}]*animation:\s*none !important;[^}]*animation-delay:\s*0ms !important;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.session-progress-continuous \.progress-track span\s*\{[^}]*animation:\s*none !important;[^}]*transform:\s*none !important;/);
});
