import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStorage, createStudyStore } from "../js/store.js";
import { registerWebMCPTools } from "../js/webmcp.js";

const NOW = "2026-08-30T12:00:00.000Z";
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// Contract-compatible synthetic guard. Accounts owns authentication and its
// actual WeakSet-backed fence; no account package is copied into this runtime.
function makeGuard() {
  let epoch = 0;
  let principalId = "account-a";
  const tickets = new WeakSet();
  return {
    capture() {
      const ticket = Object.freeze({ epoch, principalId });
      tickets.add(ticket);
      return ticket;
    },
    isCurrent(ticket) {
      return tickets.has(ticket) && ticket.epoch === epoch && ticket.principalId === principalId;
    },
    changePrincipal(next) { principalId = next; epoch += 1; },
  };
}

function fixture() {
  const storage = createMemoryStorage();
  const store = createStudyStore({ storage, clock: () => new Date(NOW), catalog: [] });
  const created = store.ingestDeck({ operation: "create", idempotency_key: "create-a", deck: {
    schema_version: "normalized-definition-deck.v2", deck_id: "account-deck", title: "Private account A deck",
    cards: [{ id: "term-1", term: "Term", definition: "Private canonical definition.", criteria: ["State the definition."], tags: [] }],
    edges: [],
  } });
  const args = { deck_id: created.deck_id, expected_deck_revision: created.deck_revision,
    patch: { title: "Edited account A deck" }, idempotency_key: "edit-a" };
  return { store, storage, args };
}

async function capture(store, executionGuard, onVisibleEffect, onRegister) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const tools = new Map();
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    modelContext: { registerTool: async (tool) => {
      tools.set(tool.name, tool);
      if (onRegister) await onRegister(tool);
    } },
  } });
  try {
    const result = await registerWebMCPTools({ store, executionGuard, onVisibleEffect });
    assert.equal(result.registered.length, 13);
    tools.registration = result;
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  }
  return tools;
}

test("execution guard must provide both synchronous contract functions", async () => {
  const { store } = fixture();
  for (const executionGuard of [null, {}, { capture() {} }, { isCurrent() {} }, { capture: true, isCurrent() {} }]) {
    await assert.rejects(registerWebMCPTools({ store, executionGuard }), /executionGuard/);
  }
});

test("browser-local registration stays compatible without an account guard", async () => {
  const { store, args } = fixture();
  let effectMetadata;
  const tools = await capture(store, undefined, (_effect, metadata) => { effectMetadata = metadata; });
  const result = await tools.get("update_deck").execute(args);
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(effectMetadata, "execution_context"), false);
});

test("stale execution ticket stops a mutation before dispatch", async () => {
  const { store, args, storage } = fixture();
  const before = storage.dump();
  const guard = makeGuard();
  const captureTicket = guard.capture;
  let captures = 0;
  guard.capture = () => {
    const ticket = captureTicket();
    captures += 1;
    if (captures > 1) guard.changePrincipal("account-b");
    return ticket;
  };
  let effects = 0;
  const tools = await capture(store, guard, () => { effects += 1; });
  const result = await tools.get("update_deck").execute(args);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ACCOUNT_CHANGED");
  assert.equal(result.error.retryable, false);
  assert.equal(effects, 0);
  assert.deepEqual(storage.dump(), before);
});

test("read result resolving after an account change is not returned to the agent", async () => {
  const { store } = fixture();
  const guard = makeGuard();
  const entered = deferred(); const finish = deferred();
  const facade = { ...store, async getLearningOverview(...args) {
    const result = store.getLearningOverview(...args);
    entered.resolve(); await finish.promise; return result;
  } };
  const tools = await capture(facade, guard);
  const request = tools.get("get_learning_overview").execute({});
  await entered.promise;
  guard.changePrincipal("account-b"); finish.resolve();
  const result = await request;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ACCOUNT_CHANGED");
  assert.equal(Object.hasOwn(result, "data"), false);
  assert.doesNotMatch(JSON.stringify(result), /Private account A deck/);
});

test("late old-account commit is preserved but neither revealed nor returned as current-account success", async () => {
  const { store, args } = fixture();
  const guard = makeGuard();
  const entered = deferred(); const finish = deferred();
  const facade = { ...store, async updateDeck(...input) {
    const result = store.updateDeck(...input);
    entered.resolve(); await finish.promise; return result;
  } };
  let effects = 0;
  const tools = await capture(facade, guard, () => { effects += 1; });
  const request = tools.get("update_deck").execute(args);
  await entered.promise;
  guard.changePrincipal("account-b"); finish.resolve();
  const result = await request;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ACCOUNT_CHANGED_AFTER_COMMIT");
  assert.equal(result.error.retryable, false);
  assert.match(result.error.message, /original account/i);
  assert.equal(Object.hasOwn(result, "data"), false);
  assert.equal(effects, 0);
  assert.equal(store.getDeck({ scope: "personal", deck_id: args.deck_id }).deck.title, args.patch.title);
  assert.equal(store.updateDeck(args).receipt.replayed, true, "the previous account's commit is not rolled back or repeated");
});

test("same execution ticket reaches presentation and is checked again after its awaited effect", async () => {
  const { store, args } = fixture();
  const guard = makeGuard();
  const entered = deferred(); const finish = deferred();
  let captured; let captures = 0; let suppressed = false;
  let effectTicket; let currentOnEntry;
  const captureTicket = guard.capture;
  guard.capture = () => { captures += 1; captured = captureTicket(); return captured; };
  const tools = await capture(store, guard, async (_effect, metadata) => {
    effectTicket = metadata.execution_context;
    currentOnEntry = guard.isCurrent(effectTicket);
    entered.resolve(); await finish.promise;
    suppressed = !guard.isCurrent(metadata.execution_context);
  });
  captures = 0;
  const request = tools.get("update_deck").execute(args);
  await entered.promise;
  guard.changePrincipal("account-b"); finish.resolve();
  const result = await request;
  assert.equal(effectTicket, captured);
  assert.equal(currentOnEntry, true);
  assert.equal(suppressed, true);
  assert.equal(captures, 1, "do not capture a replacement ticket after an await");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ACCOUNT_CHANGED_AFTER_COMMIT");
  assert.equal(Object.hasOwn(result, "data"), false);
});

test("same principal after logout/login still invalidates the original epoch", async () => {
  const { store, args } = fixture();
  const guard = makeGuard();
  const tools = await capture(store, guard, async () => {
    guard.changePrincipal(null);
    guard.changePrincipal("account-a");
  });
  const result = await tools.get("update_deck").execute(args);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ACCOUNT_CHANGED_AFTER_COMMIT");
});

test("presentation failure does not mask the final identity check or turn an unchanged-account commit into failure", async () => {
  for (const changeAccount of [false, true]) {
    const { store, args } = fixture();
    const guard = makeGuard();
    const tools = await capture(store, guard, async () => {
      if (changeAccount) guard.changePrincipal("account-b");
      throw new Error("Synthetic animation failure");
    });
    const result = await tools.get("update_deck").execute(args);
    assert.equal(result.ok, !changeAccount);
    if (changeAccount) assert.equal(result.error.code, "ACCOUNT_CHANGED_AFTER_COMMIT");
    else assert.equal(result.data.receipt.replayed, false);
    assert.equal(store.updateDeck(args).receipt.replayed, true);
  }
});

test("guard failures fail closed; asynchronous isCurrent is not accepted as truthy authorization", async () => {
  for (const isCurrent of [() => { throw new Error("Fence unavailable"); }, async () => true]) {
    const { store, args, storage } = fixture();
    const before = storage.dump();
    const tools = await capture(store, { capture: () => ({}), isCurrent });
    const result = await tools.get("update_deck").execute(args);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "ACCOUNT_CHANGED");
    assert.deepEqual(storage.dump(), before);
  }
});

test("same-account replay emits no second visible effect while guarded reads and writes stay schema-compatible", async () => {
  const { store, args } = fixture();
  const guard = makeGuard();
  let effects = 0;
  const tools = await capture(store, guard, () => { effects += 1; });
  assert.equal((await tools.get("get_learning_overview").execute({})).ok, true);
  const first = await tools.get("update_deck").execute(args);
  const second = await tools.get("update_deck").execute(args);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.data.receipt.replayed, false);
  assert.equal(second.data.receipt.replayed, true);
  assert.equal(second.data.receipt.transaction_id, first.data.receipt.transaction_id);
  assert.equal(effects, 1);
});

test("unconfirmed durable responses permit exact-intent retry without exposing a commit or presentation effect", async () => {
  for (const code of ["REQUEST_UNCONFIRMED", "COMMIT_UNCONFIRMED", "MALFORMED_RESPONSE"]) {
    const { store, args, storage } = fixture();
    const before = storage.dump();
    const facade = { ...store, async updateDeck() {
      throw Object.assign(new Error("Preserve and retry the original action."), { code });
    } };
    let effects = 0;
    const tools = await capture(facade, makeGuard(), () => { effects += 1; });
    const result = await tools.get("update_deck").execute(args);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(result.error.retryable, true);
    assert.equal(effects, 0);
    assert.deepEqual(storage.dump(), before);
  }
});

test("SERVICE_BUSY permits the identical intent after release with one commit and one visible effect", async () => {
  const { store, args, storage } = fixture();
  const original = structuredClone(args);
  const before = storage.dump();
  const attempts = [];
  let busy = true;
  const facade = { ...store, async updateDeck(input, context) {
    attempts.push({ input: structuredClone(input), context: structuredClone(context) });
    if (busy) {
      // Retry classification comes from the explicit code allowlist, not an
      // arbitrary adapter flag. Durable outbox recovery is tested separately.
      throw Object.assign(new Error("Preserve and retry the identical request."), { code: "SERVICE_BUSY", retryable: false });
    }
    return store.updateDeck(input, context);
  } };
  let effects = 0;
  const tools = await capture(facade, makeGuard(), () => { effects += 1; });
  const rejected = await tools.get("update_deck").execute(args);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "SERVICE_BUSY");
  assert.equal(rejected.error.retryable, true);
  assert.equal(Object.hasOwn(rejected, "data"), false);
  assert.equal(effects, 0);
  assert.deepEqual(storage.dump(), before);
  assert.deepEqual(args, original);

  busy = false;
  const committed = await tools.get("update_deck").execute(args);
  assert.equal(committed.ok, true);
  assert.equal(committed.data.receipt.replayed, false);
  assert.equal(committed.data.receipt.idempotency_key, original.idempotency_key);
  assert.equal(effects, 1);
  const saved = storage.dump();
  const replay = await tools.get("update_deck").execute(args);
  assert.equal(replay.ok, true);
  assert.equal(replay.data.receipt.replayed, true);
  assert.equal(replay.data.receipt.transaction_id, committed.data.receipt.transaction_id);
  assert.equal(replay.data.receipt.app_revision, committed.data.receipt.app_revision);
  assert.equal(effects, 1);
  assert.deepEqual(storage.dump(), saved);
  assert.deepEqual(attempts, Array.from({ length: 3 }, () => ({
    input: original, context: { source: "webmcp", tool_name: "update_deck" },
  })));
});

test("adapter retryable flags cannot promote invalid, cross-account, conflicting or unknown errors", async () => {
  for (const code of ["INVALID_TOOL_INPUT", "ACCOUNT_CHANGED", "IDEMPOTENCY_CONFLICT", "INPUT_TOO_LARGE", "UNKNOWN_ADAPTER_ERROR"]) {
    const { store, args, storage } = fixture();
    const before = storage.dump();
    const facade = { ...store, async updateDeck() {
      throw Object.assign(new Error("Nonretryable control."), { code, retryable: true });
    } };
    let effects = 0;
    const tools = await capture(facade, makeGuard(), () => { effects += 1; });
    const result = await tools.get("update_deck").execute(args);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(result.error.retryable, false, code);
    assert.equal(Object.hasOwn(result, "data"), false);
    assert.equal(effects, 0);
    assert.deepEqual(storage.dump(), before);
  }
});

test("old registered callbacks cannot acquire a new account's authority", async () => {
  const { store, args, storage } = fixture();
  const guard = makeGuard();
  let effects = 0;
  const tools = await capture(store, guard, () => { effects += 1; });
  const before = storage.dump();
  guard.changePrincipal("account-b");
  for (const [name, input] of [["get_learning_overview", {}], ["update_deck", args]]) {
    const result = await tools.get(name).execute(input);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "ACCOUNT_CHANGED");
    assert.equal(Object.hasOwn(result, "data"), false);
    assert.doesNotMatch(JSON.stringify(result), /Private account A deck/);
  }
  assert.equal(effects, 0);
  assert.deepEqual(storage.dump(), before);
});

test("an account switch during asynchronous registration leaves the entire tool surface unavailable", async () => {
  const { store, args, storage } = fixture();
  const guard = makeGuard();
  const before = storage.dump();
  const tools = await capture(store, guard, undefined, async (tool) => {
    if (tool.name === "get_learning_overview") {
      await Promise.resolve();
      guard.changePrincipal("account-b");
    }
  });
  assert.equal(tools.registration.failed.code, "ACCOUNT_CHANGED");
  const result = await tools.get("update_deck").execute(args);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ACCOUNT_CHANGED");
  assert.deepEqual(storage.dump(), before);
});

test("malformed or unrelated receipts never falsely confirm a previous account's commit", async () => {
  for (const mutation of [
    () => ({ receipt: { transaction_id: "", replayed: false } }),
    (result) => ({ ...result, receipt: { ...result.receipt, operation: "add_cards" } }),
    (result) => ({ ...result, receipt: { ...result.receipt, idempotency_key: "unrelated-intent" } }),
  ]) {
    const { store, args, storage } = fixture();
    const before = storage.dump();
    // Get a valid-shaped response from a separate synthetic store. The tested
    // facade does not commit to this store before switching the account.
    const other = fixture();
    const expected = other.store.updateDeck(other.args);
    const guard = makeGuard();
    const tools = await capture({ ...store, async updateDeck() {
      guard.changePrincipal("account-b");
      return mutation(expected);
    } }, guard);
    const result = await tools.get("update_deck").execute(args);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "ACCOUNT_CHANGED");
    assert.match(result.error.message, /may already/);
    assert.deepEqual(storage.dump(), before);
  }
});

test("same-account mismatched receipt is invalid output and emits no visible effect", async () => {
  const { store, args } = fixture();
  const other = fixture();
  const expected = other.store.updateDeck(other.args);
  expected.receipt.idempotency_key = "unrelated-intent";
  let effects = 0;
  const tools = await capture({ ...store, updateDeck: async () => expected }, makeGuard(), () => { effects += 1; });
  const result = await tools.get("update_deck").execute(args);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_TOOL_OUTPUT");
  assert.equal(effects, 0);
});
