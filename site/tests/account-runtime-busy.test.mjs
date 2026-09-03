import assert from "node:assert/strict";
import test from "node:test";

import { createAccountRuntime } from "../public/study/js/account-runtime.js";

const CATALOG_REF = Object.freeze({ version: "release-1", digest: "sha256:" + "a".repeat(64) });
const clone = (value) => structuredClone(value);

function accountData(revision, personalDecks = {}) {
  return {
    account_binding: "account-A",
    durable_revision: revision,
    catalog_ref: CATALOG_REF,
    state_json: revision === 0 ? null : JSON.stringify({ personalDecks }),
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(status < 400 ? { ok: true, data } : {
    ok: false,
    error: { code: data.code, message: data.message ?? data.code },
  }), { status, headers: { "content-type": "application/json" } });
}

function serviceBusy(label = "busy") {
  return { code: "SERVICE_BUSY", message: label, status: 503 };
}

function createControllerFactory(log) {
  return ({ onInvalidate }) => {
    let epoch = 0;
    let principalId = null;
    let live = true;
    const current = (ticket) => live && ticket?.epoch === epoch &&
      (ticket.principalId === null || ticket.principalId === principalId);
    const access = (kind) => {
      const ticket = Object.freeze({ epoch, principalId, kind });
      let held = true;
      const guard = {
        capture: () => ticket,
        isCurrent: (candidate) => held && candidate === ticket && current(candidate),
      };
      return {
        executionGuard: guard,
        outbox: { read: () => null, write: () => {} },
        claim: { read: () => null, write: () => {} },
        recovery: { read: () => ({ version: 1, pending: null, settled: null }) },
        isCurrent: () => held && current(ticket),
        runMutation: (work) => work(),
        release: async () => { held = false; },
        released: Promise.resolve(),
      };
    };
    return {
      executionGuard: { isCurrent: current },
      beginEpoch() {
        epoch += 1;
        principalId = null;
        live = true;
        onInvalidate({ reason: "account-boundary" });
        log.push("beginEpoch");
        return Object.freeze({ epoch, principalId: null });
      },
      bindPrincipal(nextPrincipal, bootstrapTicket) {
        assert.equal(current(bootstrapTicket), true);
        principalId = nextPrincipal;
        log.push("bindPrincipal");
        return Object.freeze({ epoch, principalId });
      },
      browse({ accountBinding, ticket }) {
        assert.equal(accountBinding, principalId);
        assert.equal(current(ticket), true);
        log.push("browse");
        return {
          executionGuard: {
            capture: () => Object.freeze({ epoch, principalId }),
            isCurrent: current,
          },
          isCurrent: current,
        };
      },
      async acquireStudy() {
        log.push("acquireStudy");
        return access("study");
      },
      async runExclusiveMutation(_scope, operation) {
        log.push("short-writer");
        const writer = access("mutation");
        try {
          const prepared = operation.prepare ? await operation.prepare(writer) : undefined;
          return await operation.mutate(writer, prepared);
        } finally { await writer.release(); }
      },
      dispose() {
        live = false;
        onInvalidate({ reason: "dispose" });
      },
    };
  };
}

async function setup({ wait = async () => {}, onReplay = () => {} } = {}) {
  const log = [];
  const stateQueue = [accountData(0)];
  const queryCalls = [];
  const commands = [];
  const archives = [];
  let durableClients = 0;
  let lastState = accountData(0);
  const client = {
    async load() { return clone(lastState); },
    async addLibraryDeck(args) {
      commands.push(clone(args));
      return {
        deck: { deck_id: "deck-algorithms-i", title: "Algorithms I" },
        receipt: { operation: "add_library_deck", idempotency_key: args.client_action_id, replayed: false },
        visible_effect: { type: "deck_added", deck_id: "deck-algorithms-i" },
      };
    },
    async setDeckArchived(args) {
      archives.push(clone(args));
      return {
        deck: { id: args.deck_id, title: "Introduction to Mathematical Proofs", archived: args.archived, revision: args.expected_revision + 1 },
        receipt: { operation: "set_deck_archived", idempotency_key: args.client_action_id, replayed: false },
        visible_effect: { type: args.archived ? "deck_archived" : "deck_restored", deck_id: args.deck_id },
      };
    },
    getPending: () => null,
    retryPending: async () => null,
  };
  const runtime = createAccountRuntime({
    createSessionController: createControllerFactory(log),
    createDurableClient: () => { durableClients += 1; return client; },
    hydrateSnapshot: async (data, { check }) => {
      check();
      const parsed = data.state_json ? JSON.parse(data.state_json) : { personalDecks: {} };
      return { revision: data.durable_revision, personalDecks: parsed.personalDecks, sessions: {}, activity: [] };
    },
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url, "https://meshful.test").pathname;
      if (path.endsWith("/state")) {
        const next = stateQueue.shift();
        if (!next) throw new Error("unexpected state read");
        if (next.code) return json(next, next.status);
        lastState = next;
        return json(next);
      }
      if (path.endsWith("/queries")) {
        const body = JSON.parse(options.body);
        queryCalls.push(body);
        return json({ durable_revision: lastState.durable_revision, result: { operation: body.operation } });
      }
      throw new Error(`unexpected request ${path}`);
    },
    storageOptions: {},
    wait,
    onReplay,
  });
  const session = await runtime.connect();
  return {
    runtime,
    session,
    client,
    stateQueue,
    setLastState(value) { lastState = value; },
    log,
    queryCalls,
    commands,
    archives,
    durableClientCount: () => durableClients,
  };
}

test("connect and reads remain lock-free and do not construct a durable writer client", async () => {
  const fixture = await setup();
  assert.deepEqual(fixture.log, ["beginEpoch", "bindPrincipal", "browse"]);
  assert.equal(fixture.durableClientCount(), 0);
  const result = await fixture.session.store.searchLibrary({ query: "algorithms" });
  assert.deepEqual(result, { operation: "search_library" });
  assert.deepEqual(fixture.queryCalls, [{ operation: "search_library", args: { query: "algorithms" } }]);
  assert.equal(fixture.durableClientCount(), 0);
});

test("account archive and restore each use one auto-releasing short writer", async () => {
  const fixture = await setup();
  const archive = { deck_id: "deck-proof", archived: true, expected_revision: 3, client_action_id: "archive-once" };
  const restore = { deck_id: "deck-proof", archived: false, expected_revision: 4, client_action_id: "restore-once" };
  await fixture.session.store.setDeckArchived(archive);
  await fixture.session.store.setDeckArchived(restore);
  assert.deepEqual(fixture.archives, [archive, restore]);
  assert.equal(fixture.log.filter((item) => item === "short-writer").length, 2);
  assert.equal(fixture.durableClientCount(), 2, "a fresh durable client is scoped to each writer");
});

test("Library install uses one short writer and is never a tab-wide lease", async () => {
  const fixture = await setup();
  const action = {
    library_deck_id: "academic-reviewed-v1:algorithms-i",
    expected_catalog_version: "release-1",
    client_action_id: "add-once",
  };
  const result = await fixture.session.store.addLibraryDeck(action);
  assert.deepEqual(fixture.commands, [action]);
  assert.equal(result.receipt.idempotency_key, "add-once");
  assert.equal(fixture.log.at(-1), "short-writer");
});

test("SERVICE_BUSY retries only state hydration", async () => {
  const waits = [];
  const fixture = await setup({ wait: async (delay) => { waits.push(delay); } });
  fixture.stateQueue.push(serviceBusy(), accountData(1, { deck: { id: "deck" } }));
  await fixture.session.refresh(fixture.session.executionGuard.capture());
  assert.deepEqual(waits, [75]);
  assert.equal(fixture.session.store.getSnapshot().personalDecks.deck.id, "deck");
  assert.equal(fixture.durableClientCount(), 0);
});

test("an account boundary cancels a busy retry before a second state read", async () => {
  let enterWait;
  const waiting = new Promise((resolve) => { enterWait = resolve; });
  let releaseWait;
  const fixture = await setup({ wait: async () => {
    enterWait();
    await new Promise((resolve) => { releaseWait = resolve; });
  } });
  fixture.stateQueue.push(serviceBusy(), accountData(1, { stale: { id: "stale" } }));
  const refresh = fixture.session.refresh(fixture.session.executionGuard.capture());
  await waiting;
  fixture.runtime.invalidate();
  releaseWait();
  await assert.rejects(refresh, (error) => error?.code === "ACCOUNT_CHANGED");
  assert.throws(() => fixture.session.store.getSnapshot(), (error) => error?.code === "ACCOUNT_CHANGED");
});

test("persistent SERVICE_BUSY stops after three total refresh attempts", async () => {
  const fixture = await setup();
  fixture.stateQueue.push(serviceBusy("one"), serviceBusy("two"), serviceBusy("three"));
  await assert.rejects(
    fixture.session.refresh(fixture.session.executionGuard.capture()),
    (error) => error?.code === "SERVICE_BUSY" && error.message === "three",
  );
});
