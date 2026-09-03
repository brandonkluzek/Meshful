import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { createDurableClient } from "../integration/backend/v5/src/durable-client.mjs";
import { createAccountSessionController } from "../public/study/accounts/browser-study-session.mjs";
import { createAccountRuntime } from "../public/study/js/account-runtime.js";
import {
  WEBMCP_STUDY_EXECUTION,
  registerWebMCPTools,
} from "../public/study/js/webmcp.js";

const CATALOG_REF = Object.freeze({ version: "release-v2", digest: "sha256:" + "b".repeat(64) });
const NOW = "2026-09-02T16:00:00.000Z";

function schedule(state = "new") {
  return {
    state,
    repetitions: state === "new" ? 0 : 1,
    due_at: state === "new" ? null : "2026-09-03T16:00:00.000Z",
    last_reviewed_at: state === "new" ? null : NOW,
    last_rating: state === "new" ? null : "good",
    learnedness: state === "new" ? 0 : 0.5,
    recency: state === "new" ? 0 : 1,
  };
}

function agentCard(state = "new") {
  return {
    card_id: "deck-A.card-A",
    card_revision: state === "new" ? 1 : 2,
    term: "Directed graph",
    prompt: null,
    definition_md: "A graph whose edges have direction.",
    aliases: [],
    required_concepts: [{ rubric_item_id: "direction", text: "Edges have direction." }],
    accepted_variants: [],
    major_error_concepts: [],
    prerequisite_ids: [],
    tags: ["graphs"],
    source_refs: [],
    difficulty_hint: null,
    module_ids: [],
    provenance: null,
    archived: false,
    scheduling: schedule(state),
  };
}

function sessionResult({ status = "active", revision = 1, reviewed = 0 } = {}) {
  const complete = ["completed", "finished"].includes(status);
  return {
    session_id: "session",
    deck_id: "deck-A",
    deck_title: "Algorithms I",
    status,
    phase: complete ? "complete" : "awaiting_answer",
    session_revision: revision,
    total: 2,
    reviewed,
    remaining: complete ? 0 : 2 - reviewed,
    current_card_id: complete ? null : "deck-A.card-A",
    started_at: NOW,
    updated_at: NOW,
    finished_at: complete ? "2026-09-02T16:05:00.000Z" : null,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createSharedBrowser() {
  const bytes = new Map();
  const tabs = [];
  const holders = new Map();
  const waiters = new Map();
  const lockRequests = [];

  function grant(name) {
    if (holders.has(name)) return;
    const queue = waiters.get(name);
    while (queue?.length) {
      const next = queue.shift();
      if (next.aborted) continue;
      holders.set(name, next);
      next.resolve();
      return;
    }
    waiters.delete(name);
  }

  function createTab(id) {
    const eventTarget = new EventTarget();
    const storage = {
      getItem: (key) => bytes.get(String(key)) ?? null,
      setItem(key, raw) {
        key = String(key);
        const oldValue = bytes.get(key) ?? null;
        const newValue = String(raw);
        bytes.set(key, newValue);
        for (const tab of tabs) {
          if (tab.id === id) continue;
          const event = new Event("storage");
          Object.defineProperties(event, {
            key: { value: key }, oldValue: { value: oldValue }, newValue: { value: newValue },
            storageArea: { value: tab.storage },
          });
          tab.eventTarget.dispatchEvent(event);
        }
      },
      removeItem(key) { bytes.delete(String(key)); },
    };
    const locks = {
      async request(name, options, callback) {
        lockRequests.push({ id, name, options: { ...options } });
        const immediate = options?.ifAvailable === true;
        if (immediate && holders.has(name)) return callback(null);
        const slot = { id, name, resolve: null, aborted: false };
        if (holders.has(name)) {
          const ready = deferred();
          slot.resolve = ready.resolve;
          const queue = waiters.get(name) ?? [];
          queue.push(slot);
          waiters.set(name, queue);
          const abort = () => { slot.aborted = true; ready.reject(new DOMException("Aborted", "AbortError")); };
          options?.signal?.addEventListener("abort", abort, { once: true });
          await ready.promise;
          options?.signal?.removeEventListener("abort", abort);
        } else {
          holders.set(name, slot);
        }
        try { return await callback(Object.freeze({ name, mode: "exclusive" })); }
        finally {
          if (holders.get(name) === slot) holders.delete(name);
          grant(name);
        }
      },
    };
    const tab = { id, eventTarget, storage, locks };
    tabs.push(tab);
    return tab;
  }

  return { createTab, lockRequests, holders, bytes };
}

function createServer({ catalogRef = CATALOG_REF, initialDurableRevision = 0 } = {}) {
  let durableRevision = initialDurableRevision;
  let state = { personalDecks: {}, sessions: {}, activeSessionId: null, activity: [], revision: 0 };
  const receipts = new Map();
  const calls = [];
  let heldResponse = null;

  function stateData() {
    return {
      schema_version: 2,
      snapshot_encoding: "canonical-json.v1",
      account_binding: "account-A",
      durable_revision: durableRevision,
      catalog_ref: catalogRef,
      state_json: durableRevision === 0 ? null : JSON.stringify(state),
    };
  }

  function response(data, status = 200) {
    return new Response(JSON.stringify(status < 400 ? { ok: true, data } : {
      ok: false,
      error: data,
    }), { status, headers: { "content-type": "application/json" } });
  }

  async function fetchImpl(url, options = {}) {
    const parsed = new URL(url, "https://meshful.test");
    const path = parsed.pathname;
    calls.push({ path, method: options.method ?? "GET", body: options.body ?? null });
    if (path.endsWith("/state")) return response(stateData());
    if (path.endsWith("/queries")) {
      const body = JSON.parse(options.body);
      return response({ durable_revision: durableRevision, result: { operation: body.operation, revision: durableRevision } });
    }
    if (path.endsWith("/commands")) {
      const command = JSON.parse(options.body);
      const known = receipts.get(command.request_id);
      if (known) return response({ ...known, result: { ...known.result, receipt: { ...known.result.receipt, replayed: true } } });
      if (command.expected_revision !== durableRevision) {
        return response({ code: "STALE_REVISION", message: "stale" }, 409);
      }
      if (command.operation === "set_deck_archived") {
        const deck = state.personalDecks[command.args.deck_id];
        if (!deck || deck.revision !== command.args.expected_revision) {
          return response({ code: "STALE_REVISION", message: "stale deck" }, 409);
        }
      }
      durableRevision += 1;
      state = { ...state, revision: durableRevision };
      let result;
      if (command.operation === "start_study_session") {
        state.sessions = { session: { id: "session", deckId: command.args.deck_id, status: "active", revision: 1 } };
        state.activeSessionId = "session";
        result = { session: sessionResult(), current_card: agentCard() };
      } else if (command.operation === "submit_grade") {
        result = {
          review_id: "review-1",
          answer_id: "answer-1",
          session_id: "session",
          card_id: "deck-A.card-A",
          card_revision: 2,
          rating: command.args.rating,
          answer_text: command.args.answer_text,
          answer_origin: command.args.answer_origin,
          rubric_evidence: command.args.rubric_evidence,
          feedback: command.args.feedback,
          misconceptions: command.args.misconceptions,
          confidence: command.args.confidence,
          schedule: { previous: schedule(), next: schedule("review") },
          reviewed_card: agentCard("review"),
          session: sessionResult({ revision: 2, reviewed: 1 }),
          next_card: agentCard(),
        };
      } else if (command.operation === "finish_study_session") {
        const status = command.args.disposition === "pause" ? "paused" : "finished";
        state.sessions = { session: { ...state.sessions.session, status, revision: 2 } };
        state.activeSessionId = null;
        result = {
          session_id: "session",
          status,
          summary: {
            reviewed_count: 1,
            rating_counts: { again: 0, hard: 0, good: 1, easy: 0 },
            started_at: "2026-09-02T16:00:00.000Z",
            finished_at: status === "finished" ? "2026-09-02T16:05:00.000Z" : null,
          },
        };
      } else if (command.operation === "add_library_deck") {
        const deck = { id: "deck-algorithms", title: "Algorithms I", archived: false, revision: 1 };
        state.personalDecks = { ...state.personalDecks, [deck.id]: deck };
        result = { deck };
      } else if (command.operation === "set_deck_archived") {
        const deck = state.personalDecks[command.args.deck_id];
        const next = {
          ...deck,
          archived: command.args.archived,
          revision: deck.revision + 1,
        };
        state.personalDecks = { ...state.personalDecks, [next.id]: next };
        result = {
          deck: next,
          visible_effect: {
            type: command.args.archived ? "deck_archived" : "deck_restored",
            deck_id: next.id,
          },
        };
      } else {
        result = {};
      }
      result.receipt = {
        operation: command.operation,
        idempotency_key: command.request_id,
        replayed: false,
        transaction_id: `tx-${durableRevision}`,
        committed_at: NOW,
        previous_app_revision: durableRevision - 1,
        app_revision: durableRevision,
      };
      if (command.operation === "set_deck_archived") {
        result.app_revision = durableRevision;
        result.receipt.client_action_id = command.request_id;
        result.receipt.transaction_id = `durable-archive:${command.request_id}`;
      }
      const data = { durable_revision: durableRevision, result };
      receipts.set(command.request_id, data);
      if (heldResponse?.operation === command.operation) {
        const held = heldResponse;
        heldResponse = null;
        held.entered.resolve();
        await held.release.promise;
        if (held.failAfterCommit) throw new TypeError("Synthetic lost acknowledgement");
      }
      return response(data);
    }
    if (path.endsWith("/claims")) return response({ code: "UNUSED", message: "unused" }, 400);
    return response({ code: "NOT_FOUND", message: "not found" }, 404);
  }

  return {
    fetchImpl,
    calls,
    holdNext(operation, { failAfterCommit = false } = {}) {
      assert.equal(heldResponse, null);
      const entered = deferred();
      const release = deferred();
      heldResponse = { operation, failAfterCommit, entered, release };
      return { entered: entered.promise, release: release.resolve };
    },
    state: () => ({ durableRevision, state: structuredClone(state) }),
  };
}

function createRuntimeFor(tab, server, onStudySuperseded = () => {}, onStudyRelease = () => {}) {
  let nonce = 0;
  return createAccountRuntime({
    createSessionController: (options) => {
      const controller = createAccountSessionController({
        ...options,
        storage: tab.storage,
        locks: tab.locks,
        eventTarget: tab.eventTarget,
        channelFactory: null,
        nonce: () => `${tab.id}-${++nonce}`,
      });
      return Object.freeze({
        ...controller,
        async acquireStudy(input) {
          const lease = await controller.acquireStudy(input);
          return Object.freeze({
            ...lease,
            release() {
              onStudyRelease();
              return lease.release();
            },
          });
        },
      });
    },
    createDurableClient,
    hydrateSnapshot: async (data, { check }) => {
      check();
      const parsed = data.state_json ? JSON.parse(data.state_json) : {
        personalDecks: {}, sessions: {}, activeSessionId: null, activity: [], revision: 0,
      };
      check();
      return parsed;
    },
    fetchImpl: server.fetchImpl,
    storageOptions: { siteId: "site-A", accountCommandWaitMs: 100 },
    onStudySuperseded,
  });
}

async function withRegisteredTools(options, run) {
  const tools = new Map();
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const windowObject = {};
  windowObject.top = windowObject;
  Object.defineProperty(globalThis, "window", { value: windowObject, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", {
    value: {
      modelContext: {
        async registerTool(definition) { tools.set(definition.name, definition); },
      },
    },
    configurable: true,
    writable: true,
  });
  try {
    const registration = await registerWebMCPTools(options);
    assert.equal(registration.supported, true);
    assert.equal(registration.registered.length, 13);
    return await run(tools);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
}

const finishArgs = (idempotencyKey) => ({
  session_id: "session",
  disposition: "end",
  expected_session_revision: 1,
  idempotency_key: idempotencyKey,
});

test("a newly provisioned empty account accepts the server's null catalog reference", async () => {
  const browser = createSharedBrowser();
  const runtime = createRuntimeFor(browser.createTab("A"), createServer({ catalogRef: null }));

  const connected = await runtime.connect();

  assert.deepEqual(connected.store.getSnapshot().personalDecks, {});
  assert.equal(connected.store.getSnapshot().revision, 0);
  runtime.dispose();

  const nonemptyRuntime = createRuntimeFor(browser.createTab("B"), createServer({
    catalogRef: null,
    initialDurableRevision: 1,
  }));
  await assert.rejects(nonemptyRuntime.connect(), (error) => error?.code === "INVALID_ACCOUNT_RESPONSE");
  nonemptyRuntime.dispose();
});

test("a short account command bypasses active Study while explicit takeover still freezes only old Study", async () => {
  const browser = createSharedBrowser();
  const server = createServer();
  const tabA = browser.createTab("A");
  const tabB = browser.createTab("B");
  let supersededA = 0;
  const runtimeA = createRuntimeFor(tabA, server, () => { supersededA += 1; });
  const runtimeB = createRuntimeFor(tabB, server);
  const [sessionA, sessionB] = await Promise.all([runtimeA.connect(), runtimeB.connect()]);

  assert.equal(browser.lockRequests.length, 0, "connecting and hydrating are lock-free");
  const [readA, readB] = await Promise.all([
    sessionA.store.searchLibrary({ query: "math" }),
    sessionB.store.searchLibrary({ query: "physics" }),
  ]);
  assert.equal(readA.operation, "search_library");
  assert.equal(readB.operation, "search_library");
  assert.equal(browser.lockRequests.length, 0, "queries remain lock-free");

  let startGuard;
  let startTicket;
  let unexpectedStartRelease = 0;
  const startContext = {};
  Object.defineProperty(startContext, WEBMCP_STUDY_EXECUTION, { value: {
    bind(guard) { startGuard = guard; startTicket = guard.capture(); return startTicket; },
    deferRelease() { unexpectedStartRelease += 1; },
  } });
  await sessionA.store.startStudySession({
    deck_id: "deck-A", idempotency_key: "start:A",
  }, startContext);
  assert.equal(sessionA.isStudyCurrent(), true);
  assert.equal(sessionA.isStudyCurrent(startTicket), true);
  assert.equal(startGuard.isCurrent(startTicket), true);
  assert.equal(unexpectedStartRelease, 0, "a nonterminal start retains its study lease");
  assert.equal(browser.lockRequests.length, 1);

  await sessionB.store.searchMyDecks({ query: "" });
  assert.equal(sessionB.isCurrent(), true, "the browsing tab stays current while A studies");
  const added = await sessionB.store.addLibraryDeck({
    library_deck_id: "library:algorithms",
    expected_catalog_version: "release-v2",
    client_action_id: "add:B",
  });
  assert.equal(added.receipt.idempotency_key, "add:B");
  assert.equal(sessionA.isStudyCurrent(startTicket), true,
    "the independent account command neither takes over nor releases Study");
  assert.equal(supersededA, 0, "a short command never takes over Study");
  assert.equal(browser.lockRequests.at(-1).name.endsWith(":account-command"), true);

  const archived = await sessionB.store.setDeckArchived({
    deck_id: added.deck.id,
    archived: true,
    expected_revision: added.deck.revision,
    client_action_id: "archive:B",
  });
  const restored = await sessionB.store.setDeckArchived({
    deck_id: added.deck.id,
    archived: false,
    expected_revision: archived.deck.revision,
    client_action_id: "restore:B",
  });
  assert.equal(restored.deck.archived, false);
  assert.equal(sessionA.isStudyCurrent(startTicket), true,
    "archive and restore on another deck leave the Study presentation current");
  assert.equal(supersededA, 0);

  await sessionB.takeOverStudy();
  assert.equal(supersededA, 1);
  assert.equal(sessionA.isCurrent(), true, "account browsing survives study-only takeover");
  assert.equal(sessionA.isStudyCurrent(), false);
  assert.equal(sessionA.isStudyCurrent(startTicket), false, "the exact old presentation ticket is revoked");
  assert.equal(sessionB.isStudyCurrent(), true);
  await assert.rejects(sessionA.store.submitGrade({
    session_id: "session", card_id: "card", expected_card_revision: 0,
    expected_session_revision: 1, answer_text: "answer", answer_origin: "chat",
    rating: "good", rubric_evidence: [], feedback: "ok", misconceptions: [], confidence: 0.8,
    idempotency_key: "grade:A-stale",
  }), (error) => error?.code === "STUDY_SUPERSEDED");

  let gradeGuard;
  let gradeTicket;
  let unexpectedGradeRelease = 0;
  const gradeContext = {};
  Object.defineProperty(gradeContext, WEBMCP_STUDY_EXECUTION, { value: {
    bind(guard) { gradeGuard = guard; gradeTicket = guard.capture(); return gradeTicket; },
    deferRelease() { unexpectedGradeRelease += 1; },
  } });
  const grade = await sessionB.store.submitGrade({
    session_id: "session", card_id: "card", expected_card_revision: 0,
    expected_session_revision: 1, answer_text: "answer", answer_origin: "chat",
    rating: "good", rubric_evidence: [], feedback: "ok", misconceptions: [], confidence: 0.8,
    idempotency_key: "grade:B",
  }, gradeContext);
  assert.equal(grade.review_id, "review-1");
  assert.equal(sessionB.isStudyCurrent(gradeTicket), true);
  assert.equal(gradeGuard.isCurrent(gradeTicket), true);
  assert.equal(unexpectedGradeRelease, 0, "a nonterminal grade retains its study lease");
  assert.equal(server.state().durableRevision, 5,
    "start, Add, Archive, Restore, and one grade each commit exactly once");
  assert.equal(server.calls.filter((call) => call.path.endsWith("/commands") && JSON.parse(call.body).operation === "submit_grade").length, 1);

  let terminalRelease;
  const finishContext = {};
  Object.defineProperty(finishContext, WEBMCP_STUDY_EXECUTION, { value: {
    bind(guard) { assert.equal(guard, gradeGuard); return guard.capture(); },
    deferRelease(release) { terminalRelease = release; },
  } });
  const finished = await sessionB.store.finishStudySession({
    session_id: "session", disposition: "pause", expected_session_revision: 1,
    idempotency_key: "finish:B",
  }, finishContext);
  assert.equal(finished.status, "paused");
  assert.equal(typeof terminalRelease, "function", "terminal release is deferred to WebMCP's final fence");
  assert.equal(sessionB.isStudyCurrent(), true, "the sink keeps authority until WebMCP settles");
  await terminalRelease();
  assert.equal(sessionB.isStudyCurrent(), false);
  runtimeA.dispose();
  runtimeB.dispose();
});

test("two overlapping Add commands queue and rehydrate under one account session", async () => {
  const browser = createSharedBrowser();
  const server = createServer();
  const runtime = createRuntimeFor(browser.createTab("queued-adds"), server);
  const session = await runtime.connect();
  const held = server.holdNext("add_library_deck");

  const first = session.store.addLibraryDeck({
    library_deck_id: "library:math",
    expected_catalog_version: "release-v2",
    client_action_id: "add:queued-first",
  });
  await held.entered;

  let secondSettled = false;
  const second = session.store.addLibraryDeck({
    library_deck_id: "library:physics",
    expected_catalog_version: "release-v2",
    client_action_id: "add:queued-second",
  }).then((value) => {
    secondSettled = true;
    return value;
  }, (error) => {
    secondSettled = true;
    throw error;
  });
  await Promise.resolve();

  assert.equal(secondSettled, false, "the second Add waits for the first short command");
  assert.equal(browser.lockRequests.at(-1).name.endsWith(":account-command-queue"), true);
  assert.equal(browser.lockRequests.at(-1).options.ifAvailable, undefined,
    "the outer short-command lock queues instead of failing immediately");
  assert.ok(browser.lockRequests.at(-1).options.signal instanceof AbortSignal,
    "the queued Add remains cancellable at an account boundary");

  held.release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.receipt.replayed, false);
  assert.equal(secondResult.receipt.replayed, false);
  const adds = server.calls.filter((call) => call.path.endsWith("/commands") &&
    JSON.parse(call.body).operation === "add_library_deck").map((call) => JSON.parse(call.body));
  assert.deepEqual(adds.map((command) => command.request_id), [
    "add:queued-first",
    "add:queued-first",
    "add:queued-second",
  ], "the successor lease may replay the settled exact key before its new Add");
  assert.deepEqual(adds.map((command) => command.expected_revision), [0, 0, 1],
    "the exact replay is idempotent and the queued Add uses the new durable head");
  assert.equal(server.state().durableRevision, 2);
  assert.equal(session.getRecovery().command, null);
  assert.deepEqual(session.getRecovery().commands, []);
  runtime.dispose();
});

test("a queued short command is cancelled by its account boundary", async () => {
  const browser = createSharedBrowser();
  const server = createServer();
  const runtimeA = createRuntimeFor(browser.createTab("queue-owner"), server);
  const runtimeB = createRuntimeFor(browser.createTab("queue-cancelled"), server);
  const [sessionA, sessionB] = await Promise.all([runtimeA.connect(), runtimeB.connect()]);
  const held = server.holdNext("add_library_deck");
  const first = sessionA.store.addLibraryDeck({
    library_deck_id: "library:math",
    expected_catalog_version: "release-v2",
    client_action_id: "add:boundary-owner",
  });
  await held.entered;

  const queued = sessionB.store.addLibraryDeck({
    library_deck_id: "library:physics",
    expected_catalog_version: "release-v2",
    client_action_id: "add:boundary-cancelled",
  });
  await Promise.resolve();
  runtimeB.dispose();
  await assert.rejects(queued, (error) => error?.code === "ACCOUNT_CHANGED");

  held.release();
  await first;
  assert.equal(server.state().durableRevision, 1,
    "the cancelled queue entry never prepares or posts a durable command");
  runtimeA.dispose();
});

test("the short-command queue fails closed after its bounded wait", async () => {
  const browser = createSharedBrowser();
  const server = createServer();
  const runtime = createRuntimeFor(browser.createTab("queue-timeout"), server);
  const session = await runtime.connect();
  const held = server.holdNext("add_library_deck");
  const first = session.store.addLibraryDeck({
    library_deck_id: "library:math",
    expected_catalog_version: "release-v2",
    client_action_id: "add:timeout-owner",
  });
  await held.entered;

  await assert.rejects(session.store.addLibraryDeck({
    library_deck_id: "library:physics",
    expected_catalog_version: "release-v2",
    client_action_id: "add:timeout-waiter",
  }), (error) => error?.code === "ACCOUNT_LEASE_BUSY");

  held.release();
  await first;
  assert.equal(server.state().durableRevision, 1);
  assert.equal(server.calls.filter((call) => call.path.endsWith("/commands") &&
    JSON.parse(call.body).request_id === "add:timeout-waiter").length, 0);
  runtime.dispose();
});

test("only Study and short account commands may overlap; whole-state claims exclude both lanes", async () => {
  const browser = createSharedBrowser();
  const tab = browser.createTab("matrix");
  let nonce = 0;
  const controller = createAccountSessionController({
    siteId: "site-A",
    storage: tab.storage,
    locks: tab.locks,
    eventTarget: tab.eventTarget,
    channelFactory: null,
    nonce: () => `matrix-${++nonce}`,
    onInvalidate: () => {},
  });
  const discovery = controller.beginEpoch();
  const ticket = controller.bindPrincipal("account-A", discovery);
  const scope = { accountBinding: "account-A", ticket };
  let commandId = 0;
  const accountDraft = () => {
    const id = `matrix-command-${++commandId}`;
    return {
      accountBinding: "account-A",
      command: {
        request_id: id,
        expected_revision: 0,
        operation: "add_library_deck",
        args: { client_action_id: id },
      },
    };
  };
  const claimDraft = {
    accountBinding: "account-A",
    request: {
      request_id: "matrix-claim",
      expected_revision: 0,
      source_id: "matrix-source",
      catalog_ref: CATALOG_REF,
      raw_state_json: "{}",
    },
  };

  const study = await controller.acquireStudy({ ...scope, onSuperseded: () => {} });
  const accountResult = await controller.runExclusiveMutation({
    ...scope,
    purpose: "account-command",
  }, { mutate: async (access) => {
    access.outbox.write(access.outbox.read() ?? accountDraft());
    await Promise.resolve();
    access.outbox.write(null);
    return "saved";
  } });
  assert.equal(accountResult, "saved", "the one permitted overlap remains Study plus account command");
  await assert.rejects(controller.runExclusiveMutation({ ...scope, purpose: "claim" }, {
    mutate: async () => {},
  }), (error) => error?.code === "ACCOUNT_LEASE_BUSY");
  await study.release();

  const claimEntered = deferred();
  const releaseClaim = deferred();
  const claim = controller.runExclusiveMutation({ ...scope, purpose: "claim" }, {
    mutate: async (access) => {
      access.claim.write(claimDraft);
      claimEntered.resolve();
      await releaseClaim.promise;
    },
  });
  await claimEntered.promise;
  await assert.rejects(controller.runExclusiveMutation({ ...scope, purpose: "account-command" }, {
    mutate: async () => {},
  }), (error) => error?.code === "ACCOUNT_LEASE_BUSY");
  releaseClaim.resolve();
  await claim;

  const commandEntered = deferred();
  const releaseCommand = deferred();
  const accountCommand = controller.runExclusiveMutation({ ...scope, purpose: "account-command" }, {
    mutate: async (access) => {
      access.outbox.write(access.outbox.read() ?? accountDraft());
      commandEntered.resolve();
      await releaseCommand.promise;
      access.outbox.write(null);
    },
  });
  await commandEntered.promise;
  await assert.rejects(controller.runExclusiveMutation({ ...scope, purpose: "claim" }, {
    mutate: async () => {},
  }), (error) => error?.code === "ACCOUNT_LEASE_BUSY");
  releaseCommand.resolve();
  await accountCommand;
  controller.dispose();
});

test("two controllers make whole-state claims exclude both cross-tab writer lanes", async () => {
  const browser = createSharedBrowser();
  const tabA = browser.createTab("claim-A");
  const tabB = browser.createTab("claim-B");
  const makeController = (tab) => {
    let nonce = 0;
    const controller = createAccountSessionController({
      siteId: "site-A",
      storage: tab.storage,
      locks: tab.locks,
      eventTarget: tab.eventTarget,
      channelFactory: null,
      nonce: () => `${tab.id}-${++nonce}`,
      onInvalidate: () => {},
    });
    const discovery = controller.beginEpoch();
    const ticket = controller.bindPrincipal("account-A", discovery);
    return { controller, scope: { accountBinding: "account-A", ticket } };
  };
  const a = makeController(tabA);
  const b = makeController(tabB);
  let commandId = 0;
  const accountDraft = () => {
    const id = `cross-tab-command-${++commandId}`;
    return {
      accountBinding: "account-A",
      command: {
        request_id: id,
        expected_revision: 0,
        operation: "add_library_deck",
        args: { client_action_id: id },
      },
    };
  };
  const claimDraft = {
    accountBinding: "account-A",
    request: {
      request_id: "cross-tab-claim",
      expected_revision: 0,
      source_id: "cross-tab-source",
      catalog_ref: CATALOG_REF,
      raw_state_json: "{}",
    },
  };

  const studyA = await a.controller.acquireStudy({ ...a.scope, onSuperseded: () => {} });
  await assert.rejects(b.controller.runExclusiveMutation({ ...b.scope, purpose: "claim" }, {
    mutate: async () => { throw new Error("a claim cannot enter during Study"); },
  }), (error) => error?.code === "ACCOUNT_LEASE_BUSY");
  await studyA.release();

  const releaseCommand = deferred();
  const commandEntered = deferred();
  const commandA = a.controller.runExclusiveMutation({ ...a.scope, purpose: "account-command" }, {
    mutate: async (access) => {
      access.outbox.write(accountDraft());
      commandEntered.resolve();
      await releaseCommand.promise;
      access.outbox.write(null);
    },
  });
  await commandEntered.promise;
  await assert.rejects(b.controller.runExclusiveMutation({ ...b.scope, purpose: "claim" }, {
    mutate: async () => { throw new Error("a claim cannot enter during an account command"); },
  }), (error) => error?.code === "ACCOUNT_LEASE_BUSY");
  const studyBesideCommand = await b.controller.acquireStudy({ ...b.scope, onSuperseded: () => {} });
  assert.equal(studyBesideCommand.isCurrent(), true,
    "the failed claim releases its first lock before reporting busy");
  await studyBesideCommand.release();
  releaseCommand.resolve();
  await commandA;

  const releaseClaim = deferred();
  const claimEntered = deferred();
  const claimA = a.controller.runExclusiveMutation({ ...a.scope, purpose: "claim" }, {
    mutate: async (access) => {
      access.claim.write(claimDraft);
      claimEntered.resolve();
      await releaseClaim.promise;
    },
  });
  await claimEntered.promise;
  await assert.rejects(b.controller.runExclusiveMutation({ ...b.scope, purpose: "account-command" }, {
    mutate: async () => { throw new Error("an account command cannot enter during a claim"); },
  }), (error) => error?.code === "ACCOUNT_LEASE_BUSY");

  let queuedStudyEntered = false;
  const queuedStudy = b.controller.acquireStudy({ ...b.scope, onSuperseded: () => {} })
    .then((lease) => { queuedStudyEntered = true; return lease; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(queuedStudyEntered, false, "Study remains queued until the cross-tab claim releases");
  releaseClaim.resolve();
  await claimA;
  const studyAfterClaim = await queuedStudy;
  assert.equal(studyAfterClaim.isCurrent(), true);
  await studyAfterClaim.release();
  a.controller.dispose();
  b.controller.dispose();
});

test("missing Web Locks still permits authenticated browse and denies writes", async () => {
  const browser = createSharedBrowser();
  const server = createServer();
  const tab = browser.createTab("A");
  tab.locks = undefined;
  const runtime = createRuntimeFor(tab, server);
  const session = await runtime.connect();
  assert.equal((await session.store.searchLibrary({ query: "math" })).operation, "search_library");
  await assert.rejects(session.store.addLibraryDeck({
    library_deck_id: "library:algorithms",
    expected_catalog_version: "release-v2",
    client_action_id: "add:no-locks",
  }), (error) => error?.code === "ACCOUNT_LOCKS_UNAVAILABLE");
  runtime.dispose();
});

test("a study action cannot reacquire after its currentness check discovers delayed takeover", async () => {
  const browser = createSharedBrowser();
  const server = createServer();
  const tab = browser.createTab("A");
  let superseded = 0;
  const runtime = createRuntimeFor(tab, server, () => { superseded += 1; });
  const session = await runtime.connect();

  await session.store.startStudySession({ deck_id: "deck-A", idempotency_key: "start:delayed" });
  const studyIntentKey = [...browser.bytes.keys()].find((key) => key.endsWith(":study-intent"));
  assert.ok(studyIntentKey, "study acquisition records its revocation marker");
  browser.bytes.set(studyIntentKey, "v1:accepted-in-another-tab");

  const requestsBefore = browser.lockRequests.length;
  await assert.rejects(session.store.submitGrade({
    session_id: "session", card_id: "card", expected_card_revision: 0,
    expected_session_revision: 1, answer_text: "answer", answer_origin: "chat",
    rating: "good", rubric_evidence: [], feedback: "ok", misconceptions: [], confidence: 0.8,
    idempotency_key: "grade:stale-delayed",
  }), (error) => error?.code === "STUDY_SUPERSEDED");

  assert.equal(superseded, 1, "the delayed marker revokes presentation authority synchronously");
  assert.equal(browser.lockRequests.length, requestsBefore, "the stale action never requests a replacement writer");
  assert.equal(server.state().durableRevision, 1, "only the original start committed");
  assert.equal(server.calls.filter((call) => call.path.endsWith("/commands") &&
    JSON.parse(call.body).operation === "submit_grade").length, 0);
  runtime.dispose();
});

test("registered account tools bind the real study lease and release a terminal session only after the visible sink", async () => {
  const browser = createSharedBrowser();
  const server = createServer();
  const tab = browser.createTab("A");
  let releases = 0;
  const runtime = createRuntimeFor(tab, server, () => {}, () => { releases += 1; });
  const session = await runtime.connect();
  await session.store.startStudySession({ deck_id: "deck-A", idempotency_key: "start:terminal" });

  const sinkEntered = deferred();
  const showSink = deferred();
  let sinkMetadata;
  await withRegisteredTools({
    store: session.store,
    executionGuard: session.executionGuard,
    requireStudyExecutionGuard: true,
    onVisibleEffect: async (_effect, metadata) => {
      sinkMetadata = metadata;
      sinkEntered.resolve();
      await showSink.promise;
    },
  }, async (tools) => {
    const finishing = tools.get("finish_study_session").execute(finishArgs("finish:terminal"));
    await sinkEntered.promise;
    assert.equal(session.isStudyCurrent(sinkMetadata.study_execution_context), true);
    assert.equal(releases, 0, "the writer remains held while committed presentation is pending");
    showSink.resolve();
    const result = await finishing;
    assert.equal(result.ok, true);
    assert.equal(result.data.receipt.operation, "finish_study_session");
    assert.equal(releases, 1, "the terminal bridge settles exactly once after the final response fence");
    assert.equal(session.isStudyCurrent(), false);
  });
  runtime.dispose();
});

test("required account study guard withholds an unbound terminal result and never invokes the visible sink", async () => {
  const browser = createSharedBrowser();
  const server = createServer();
  const tab = browser.createTab("A");
  const runtime = createRuntimeFor(tab, server);
  const session = await runtime.connect();
  await session.store.startStudySession({ deck_id: "deck-A", idempotency_key: "start:missing-guard" });
  let effects = 0;
  const strippedStore = Object.freeze({
    ...session.store,
    finishStudySession(args) { return session.store.finishStudySession(args); },
  });

  await withRegisteredTools({
    store: strippedStore,
    executionGuard: session.executionGuard,
    requireStudyExecutionGuard: true,
    onVisibleEffect: async () => { effects += 1; },
  }, async (tools) => {
    const result = await tools.get("finish_study_session").execute(finishArgs("finish:missing-guard"));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "STUDY_LEASE_UNAVAILABLE");
    assert.equal(result.error.retryable, false);
    assert.equal(Object.hasOwn(result, "data"), false);
    assert.equal(effects, 0);
    assert.equal(server.state().durableRevision, 2, "the withheld result is not misrepresented as uncommitted");
  });
  await session.releaseStudy();
  runtime.dispose();
});

test("takeover during an awaited visible sink suppresses stale presentation and withholds the old result", async () => {
  const browser = createSharedBrowser();
  const server = createServer();
  const runtimeA = createRuntimeFor(browser.createTab("A"), server);
  const runtimeB = createRuntimeFor(browser.createTab("B"), server);
  const [sessionA, sessionB] = await Promise.all([runtimeA.connect(), runtimeB.connect()]);
  await sessionA.store.startStudySession({ deck_id: "deck-A", idempotency_key: "start:sink" });
  let enteredEffects = 0;
  let stalePresentations = 0;

  await withRegisteredTools({
    store: sessionA.store,
    executionGuard: sessionA.executionGuard,
    requireStudyExecutionGuard: true,
    onVisibleEffect: async (_effect, metadata) => {
      enteredEffects += 1;
      await sessionB.takeOverStudy();
      if (sessionA.isStudyCurrent(metadata.study_execution_context)) stalePresentations += 1;
    },
  }, async (tools) => {
    const result = await tools.get("finish_study_session").execute(finishArgs("finish:sink"));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "STUDY_SUPERSEDED");
    assert.equal(Object.hasOwn(result, "data"), false);
    assert.equal(enteredEffects, 1, "the sink observes the committed transition before takeover");
    assert.equal(stalePresentations, 0, "the original presentation ticket is rejected after its await");
    assert.equal(sessionA.isStudyCurrent(), false);
    assert.equal(sessionB.isStudyCurrent(), true);
  });
  await sessionB.releaseStudy();
  runtimeA.dispose();
  runtimeB.dispose();
});

test("a takeover during an unacknowledged registered finish replays the exact key once with no second effect", async () => {
  const browser = createSharedBrowser();
  const server = createServer();
  const runtimeA = createRuntimeFor(browser.createTab("A"), server);
  const runtimeB = createRuntimeFor(browser.createTab("B"), server);
  const [sessionA, sessionB] = await Promise.all([runtimeA.connect(), runtimeB.connect()]);
  await sessionA.store.startStudySession({ deck_id: "deck-A", idempotency_key: "start:replay" });
  const held = server.holdNext("finish_study_session", { failAfterCommit: true });
  const args = finishArgs("finish:replay");
  let effects = 0;
  let oldResult;

  await withRegisteredTools({
    store: sessionA.store,
    executionGuard: sessionA.executionGuard,
    requireStudyExecutionGuard: true,
    onVisibleEffect: async () => { effects += 1; },
  }, async (tools) => {
    const oldExecution = tools.get("finish_study_session").execute(args);
    await held.entered;
    let takeoverSettled = false;
    const takeover = sessionB.takeOverStudy().then(() => { takeoverSettled = true; });
    await Promise.resolve();
    assert.equal(takeoverSettled, false, "takeover waits for the tracked durable mutation to drain");
    held.release();
    oldResult = await oldExecution;
    await takeover;
  });

  assert.equal(oldResult.ok, false);
  assert.equal(oldResult.error.code, "STUDY_SUPERSEDED");
  assert.equal(Object.hasOwn(oldResult, "data"), false);
  assert.equal(effects, 0);
  assert.equal(server.state().durableRevision, 2, "start and the uncertain finish each commit once");

  await withRegisteredTools({
    store: sessionB.store,
    executionGuard: sessionB.executionGuard,
    requireStudyExecutionGuard: true,
    onVisibleEffect: async () => { effects += 1; },
  }, async (tools) => {
    const recovered = await tools.get("finish_study_session").execute(args);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.data.receipt.replayed, true);
    assert.equal(recovered.data.receipt.transaction_id, "tx-2");
  });
  assert.equal(server.state().durableRevision, 2, "the exact replay never commits a second finish");
  assert.equal(effects, 0, "replayed receipts never emit a second visible effect");
  assert.equal(server.calls.filter((call) => call.path.endsWith("/commands") &&
    JSON.parse(call.body).operation === "finish_study_session").length, 2);
  runtimeA.dispose();
  runtimeB.dispose();
});

test("the account Website requires the study execution bridge during WebMCP registration", async () => {
  const source = await readFile(new URL("../public/study/js/app.js", import.meta.url), "utf8");
  assert.match(source, /accountMode \? \{ executionGuard: context\.session\.executionGuard, requireStudyExecutionGuard: true \}/);
});

test("takeover during an unacknowledged grade preserves one commit and exact-key recovery", async () => {
  const browser = createSharedBrowser();
  const server = createServer();
  const tabA = browser.createTab("A");
  const tabB = browser.createTab("B");
  let supersededA = 0;
  const runtimeA = createRuntimeFor(tabA, server, () => { supersededA += 1; });
  const runtimeB = createRuntimeFor(tabB, server);
  const [sessionA, sessionB] = await Promise.all([runtimeA.connect(), runtimeB.connect()]);

  await sessionA.store.startStudySession({ deck_id: "deck-A", idempotency_key: "start:held" });
  const held = server.holdNext("submit_grade", { failAfterCommit: true });
  const gradeArgs = {
    session_id: "session", card_id: "card", expected_card_revision: 0,
    expected_session_revision: 1, answer_text: "answer", answer_origin: "chat",
    rating: "good", rubric_evidence: [], feedback: "ok", misconceptions: [], confidence: 0.8,
    idempotency_key: "grade:held",
  };
  let originalTicket;
  const metadata = {};
  Object.defineProperty(metadata, WEBMCP_STUDY_EXECUTION, { value: {
    bind(guard) { originalTicket = guard.capture(); return originalTicket; },
    deferRelease() { throw new Error("an unacknowledged grade cannot release as completed"); },
  } });
  const uncertain = sessionA.store.submitGrade(gradeArgs, metadata);
  await held.entered;

  const takeover = sessionB.takeOverStudy();
  assert.equal(supersededA, 1, "the accepted new study revokes A presentation synchronously");
  assert.equal(sessionA.isCurrent(), true, "A can still browse the account");
  assert.equal(sessionA.isStudyCurrent(originalTicket), false);
  held.release();
  await assert.rejects(uncertain, (error) => error?.code === "REQUEST_UNCONFIRMED");
  await takeover;

  assert.equal(server.state().durableRevision, 2, "start and the held grade each commit once");
  assert.deepEqual(sessionB.getRecovery().command?.command?.args, gradeArgs);
  const addedWhileGradePending = await sessionB.store.addLibraryDeck({
    library_deck_id: "library:algorithms",
    expected_catalog_version: "release-v2",
    client_action_id: "add:while-grade-pending",
  });
  assert.equal(addedWhileGradePending.receipt.idempotency_key, "add:while-grade-pending");
  assert.deepEqual(sessionB.getRecovery().command?.command?.args, gradeArgs,
    "a successful account command cannot erase the independent Study recovery draft");
  assert.equal(server.state().durableRevision, 3);
  const recovered = await sessionB.retryPending();
  assert.equal(recovered.receipt.replayed, true);
  assert.equal(recovered.receipt.idempotency_key, gradeArgs.idempotency_key);
  assert.equal(server.state().durableRevision, 3, "receipt recovery does not grade twice");
  assert.equal(server.calls.filter((call) => call.path.endsWith("/commands") &&
    JSON.parse(call.body).operation === "submit_grade").length, 2,
  "one uncertain send plus one exact replay are visible");

  await sessionB.releaseStudy({ clearBlock: true });
  runtimeA.dispose();
  runtimeB.dispose();
});

test("a successful Grade cannot erase an independent lost-ack account command", async () => {
  const browser = createSharedBrowser();
  const server = createServer();
  const tab = browser.createTab("A");
  const runtime = createRuntimeFor(tab, server);
  const session = await runtime.connect();

  await session.store.startStudySession({ deck_id: "deck-A", idempotency_key: "start:account-pending" });
  const held = server.holdNext("add_library_deck", { failAfterCommit: true });
  const addArgs = {
    library_deck_id: "library:algorithms",
    expected_catalog_version: "release-v2",
    client_action_id: "add:lost-ack-before-grade",
  };
  const uncertain = session.store.addLibraryDeck(addArgs);
  await held.entered;
  held.release();
  await assert.rejects(uncertain, (error) => error?.code === "REQUEST_UNCONFIRMED");
  assert.deepEqual(session.getRecovery().command?.command?.args, addArgs);

  const grade = await session.store.submitGrade({
    session_id: "session", card_id: "card", expected_card_revision: 0,
    expected_session_revision: 1, answer_text: "answer", answer_origin: "chat",
    rating: "good", rubric_evidence: [], feedback: "ok", misconceptions: [], confidence: 0.8,
    idempotency_key: "grade:after-account-pending",
  });
  assert.equal(grade.review_id, "review-1");
  assert.deepEqual(session.getRecovery().command?.command?.args, addArgs,
    "a successful Study mutation clears only its own recovery lane");
  assert.equal(server.state().durableRevision, 3, "start, lost-ack Add, and Grade each commit once");

  const recovered = await session.retryPending();
  assert.equal(recovered.receipt.replayed, true);
  assert.equal(recovered.receipt.idempotency_key, addArgs.client_action_id);
  assert.equal(server.state().durableRevision, 3);
  assert.equal(session.getRecovery().command, null);
  await session.releaseStudy({ clearBlock: true });
  runtime.dispose();
});

test("a lost-ack Add is discovered after runtime reload and replays through its lane while Study is active", async () => {
  const browser = createSharedBrowser();
  const server = createServer();
  const tab = browser.createTab("reload-add");
  const originalRuntime = createRuntimeFor(tab, server);
  const originalSession = await originalRuntime.connect();
  const addArgs = {
    library_deck_id: "library:algorithms",
    expected_catalog_version: "release-v2",
    client_action_id: "add:reload-lost-ack",
  };
  const held = server.holdNext("add_library_deck", { failAfterCommit: true });
  const uncertain = originalSession.store.addLibraryDeck(addArgs);
  await held.entered;
  held.release();
  await assert.rejects(uncertain, (error) => error?.code === "REQUEST_UNCONFIRMED");
  originalRuntime.dispose();

  const requestsBeforeConnect = browser.lockRequests.length;
  const storageBeforeConnect = new Map(browser.bytes);
  const recoveredRuntime = createRuntimeFor(tab, server);
  const recoveredSession = await recoveredRuntime.connect();
  assert.equal(browser.lockRequests.length, requestsBeforeConnect,
    "recovery discovery reads persisted lanes without requesting or mutating a lock");
  assert.deepEqual(browser.bytes, storageBeforeConnect,
    "recovery discovery leaves both persisted outboxes byte-for-byte unchanged");
  assert.equal(recoveredSession.getRecovery().commandLane, "account-command");
  assert.deepEqual(recoveredSession.getRecovery().commands.map(({ lane }) => lane), ["account-command"]);
  assert.deepEqual(recoveredSession.getRecovery().command?.command?.args, addArgs);

  await recoveredSession.beginStudy();
  assert.equal(recoveredSession.isStudyCurrent(), true);
  const recovered = await recoveredSession.retryPending();
  assert.equal(recovered.receipt.replayed, true);
  assert.equal(recovered.receipt.idempotency_key, addArgs.client_action_id);
  assert.equal(server.state().durableRevision, 1, "the exact replay does not install the deck twice");
  assert.equal(server.calls.filter((call) => call.path.endsWith("/commands") &&
    JSON.parse(call.body).operation === "add_library_deck").length, 2,
  "one uncertain Add send plus one exact replay are visible");
  assert.deepEqual(recoveredSession.getRecovery().commands, []);
  await recoveredSession.releaseStudy({ clearBlock: true });
  recoveredRuntime.dispose();
});

test("dual persisted outboxes remain visible and replay in durable revision order after reload", async () => {
  const browser = createSharedBrowser();
  const server = createServer();
  const tab = browser.createTab("reload-dual");
  const originalRuntime = createRuntimeFor(tab, server);
  const originalSession = await originalRuntime.connect();
  const addArgs = {
    library_deck_id: "library:algorithms",
    expected_catalog_version: "release-v2",
    client_action_id: "add:dual-lost-ack",
  };
  const heldAdd = server.holdNext("add_library_deck", { failAfterCommit: true });
  const uncertainAdd = originalSession.store.addLibraryDeck(addArgs);
  await heldAdd.entered;
  heldAdd.release();
  await assert.rejects(uncertainAdd, (error) => error?.code === "REQUEST_UNCONFIRMED");

  await originalSession.store.startStudySession({
    deck_id: "deck-A",
    idempotency_key: "start:dual-pending",
  });
  const gradeArgs = {
    session_id: "session", card_id: "card", expected_card_revision: 0,
    expected_session_revision: 1, answer_text: "answer", answer_origin: "chat",
    rating: "good", rubric_evidence: [], feedback: "ok", misconceptions: [], confidence: 0.8,
    idempotency_key: "grade:dual-lost-ack",
  };
  const heldGrade = server.holdNext("submit_grade", { failAfterCommit: true });
  const uncertainGrade = originalSession.store.submitGrade(gradeArgs);
  await heldGrade.entered;
  heldGrade.release();
  await assert.rejects(uncertainGrade, (error) => error?.code === "REQUEST_UNCONFIRMED");
  assert.equal(server.state().durableRevision, 3);
  originalRuntime.dispose();

  const recoveredRuntime = createRuntimeFor(tab, server);
  const recoveredSession = await recoveredRuntime.connect();
  const discovered = recoveredSession.getRecovery();
  assert.deepEqual(discovered.commands.map(({ lane }) => lane), ["account-command", "study"]);
  assert.deepEqual(discovered.commands.map(({ command }) => command.command.request_id), [
    addArgs.client_action_id,
    gradeArgs.idempotency_key,
  ], "both independent drafts are visible in their durable revision order");
  assert.equal(discovered.commandLane, "account-command");

  await recoveredSession.beginStudy();
  const recoveredAdd = await recoveredSession.retryPending();
  assert.equal(recoveredAdd.receipt.replayed, true);
  assert.equal(recoveredAdd.receipt.idempotency_key, addArgs.client_action_id);
  assert.deepEqual(recoveredSession.getRecovery().commands.map(({ lane }) => lane), ["study"],
    "replaying the first lane preserves the second pending draft");
  const recoveredGrade = await recoveredSession.retryPending();
  assert.equal(recoveredGrade.receipt.replayed, true);
  assert.equal(recoveredGrade.receipt.idempotency_key, gradeArgs.idempotency_key);
  assert.equal(server.state().durableRevision, 3, "both exact replays leave the three committed effects unchanged");
  assert.deepEqual(recoveredSession.getRecovery().commands, []);
  await recoveredSession.releaseStudy({ clearBlock: true });
  recoveredRuntime.dispose();
});
