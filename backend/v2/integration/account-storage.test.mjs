// Provider-free composition only. Web Locks, storage, events and ingress are
// deterministic injected fixtures; Accounts, the v2 client, HTTP and SQLite are
// the actual delivery modules. This does not establish native browser quota,
// hosted authentication, two-device behavior, or a Worker memory/CPU allowance.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { setup, accountsRoot, canonicalRoot, origin } from "../test-support/real-runtime.mjs";
import { stableJson } from "../../src/contracts.mjs";
import {
  makeMaxNativeV2Args, makeNativeV2RegressionArgs,
  MAX_NATIVE_V2_CREATE_ARGS_SHA256,
} from "../test-support/capacity-fixtures.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.byteLength(value, "utf8");
const code = (value) => (error) => error.code === value;
const sourceFiles = [
  ...["browser-storage.mjs", "browser-storage-records.mjs", "browser-state.mjs",
    "tests/browser-storage-fixtures.mjs", "core.mjs", "sites.mjs", "index.mjs"]
    .map((file) => [`accounts/${file}`, join(accountsRoot, "accounts", file)]),
  ...["store.js", "library-catalog.js", "streak.js", "webmcp.js"]
    .map((file) => [`canonical/${file}`, join(canonicalRoot, "web/js", file)]),
  ...["durable-client.mjs", "canonical-engine.mjs", "learner-service.mjs", "http-handler.mjs",
    "d1-repository.mjs", "fragment-codec.mjs", "capacity.mjs", "json-budget.mjs", "request-identity.mjs"]
    .map((file) => [`backend/v2/${file}`, new URL(`../src/${file}`, import.meta.url)]),
  ["backend/v1/durable-client.mjs", new URL("../../src/durable-client.mjs", import.meta.url)],
  ["backend/v1/contracts.mjs", new URL("../../src/contracts.mjs", import.meta.url)],
  ["backend/v2/real-runtime.mjs", new URL("../test-support/real-runtime.mjs", import.meta.url)],
  ["backend/v2/capacity-fixtures.mjs", new URL("../test-support/capacity-fixtures.mjs", import.meta.url)],
  ["backend/v2/migration", new URL("../migrations/0002_fragmented_storage.sql", import.meta.url)],
];
async function sourceHashes() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async ([label, file]) => [label, digest(await readFile(file))])));
}
const before = await sourceHashes();
assert.equal(before["accounts/browser-storage.mjs"], "7222622717397cc9ef2a8255430869ed77a2cd6dea580949ee292eee1d8a43bc");
assert.equal(before["accounts/browser-storage-records.mjs"], "0f9e1cdf8c9009c2919de29c7b6298e762523d50c23e4d96ca0552658e96011f");
const { createAccountStorageController, DEFAULT_STORAGE_LIMITS } = await import(pathToFileURL(join(accountsRoot, "accounts/browser-storage.mjs")));
// Import the Accounts lane's public test seam read-only; do not duplicate its
// lock/storage implementation or its private test cases in Backend.
const { createBrowserHarness, createDeferred } = await import(pathToFileURL(join(accountsRoot, "accounts/tests/browser-storage-fixtures.mjs")));

let nonce = 0;
function fixtureController(t, browser, tab = browser.tabs[0]) {
  const invalidations = [];
  const controller = createAccountStorageController({
    siteId: "backend-v2-composition", storage: tab.storage, locks: tab.locks,
    eventTarget: tab.window, channelFactory: null,
    nonce: () => `composition-${++nonce}`,
    onInvalidate: ({ reason }) => invalidations.push(reason),
  });
  t.after(() => controller.dispose());
  return { controller, invalidations };
}
function assertAccountOperationsHeldLock(browser) {
  const operations = browser.storageStats.operations.filter((item) => item.key?.includes(":account:"));
  assert.ok(operations.length > 0);
  assert.ok(operations.every((item) => item.heldLocks.includes(`${item.key.slice(0, item.key.lastIndexOf(":"))}:writer`)),
    "every account storage access holds that account's exclusive fixture Web Lock");
  assert.ok(browser.storageStats.operations.every((item) => !item.key || item.key.startsWith("meshful:accounts:v2:")),
    "no silent fallback to unscoped or legacy local state");
}

test("205026B exact intent survives lost acknowledgement and a later acknowledged-action lease reload", async (t) => {
  const h = await setup(t);
  const browser = createBrowserHarness({ origin });
  const { controller } = fixtureController(t, browser);
  const args = makeNativeV2RegressionArgs();
  assert.equal(bytes(JSON.stringify(args)), 205_026);
  const posts = [];
  let loseAcknowledgement = true;
  let originalDraft;
  let committedState;
  let binding;
  const tickets = [];

  // Pass 0 loses an actual committed HTTP result. Pass 1 recovers the pending
  // action. Pass 2 starts with the acknowledged record retained by Accounts.
  for (let pass = 0; pass < 3; pass++) {
    const bootstrapTicket = controller.beginEpoch();
    const authenticated = await h.call("storage-regression", "state");
    assert.equal(authenticated.status, 200);
    const compact = authenticated.body.data;
    assert.equal(compact.snapshot_encoding, "canonical-json.v1");
    assert.equal(Object.hasOwn(compact, "state"), false, "server sends the canonical JSON only once");
    binding ??= compact.account_binding;
    assert.equal(compact.account_binding, binding);
    // Only the principal returned through actual Accounts authentication is
    // bound. No user id or email from an action grants ownership here.
    const ticket = controller.bindPrincipal(compact.account_binding, bootstrapTicket);
    const lease = await controller.acquire({ accountBinding: compact.account_binding, ticket });
    const execution = lease.executionGuard.capture();
    tickets.push(execution);
    assert.equal(browser.lockStats.active.length, 1);
    const client = h.client("storage-regression", { outbox: lease.outbox, afterResponse(response, url, init) {
      if (url.endsWith("/commands")) {
        posts.push({ text: init.body, binding: init.headers["X-Meshful-Account"], status: response.status });
        if (loseAcknowledgement && response.status === 200) {
          loseAcknowledgement = false;
          throw new Error("synthetic lost acknowledgement after real SQL commit");
        }
      }
      return response;
    } });
    const loaded = await client.load();
    assert.equal(lease.executionGuard.isCurrent(execution), true);
    assert.equal(loaded.account_binding, binding);
    assert.equal(loaded.durable_revision, pass === 0 ? 0 : 1);
    if (pass === 0) {
      await assert.rejects(client.ingestDeck(args), code("REQUEST_UNCONFIRMED"));
      const recovery = lease.recovery.read();
      originalDraft = recovery.original;
      assert.ok(originalDraft === recovery.pending);
      assert.equal(JSON.parse(originalDraft).command.expected_revision, 0);
      assert.ok(isDeepStrictEqual(JSON.parse(originalDraft).command.args, args));
      committedState = (await h.call("storage-regression", "state")).body.data.state_json;
    } else {
      const pending = client.getPending();
      assert.equal(pending.recoveryStatus, "recovery-required");
      assert.equal(pending.accountBinding, binding);
      assert.equal(pending.command.expected_revision, 0);
      assert.ok(isDeepStrictEqual(pending.command.args, args));
      if (pass === 2) {
        const beforeMismatch = browser.bytes.get(lease.keys.outbox);
        await assert.rejects(client.ingestDeck({ ...args, deck: { ...args.deck, title: "Different intent" } }), code("PENDING_COMMAND"));
        assert.ok(browser.bytes.get(lease.keys.outbox) === beforeMismatch, "a new intent cannot replace recovery evidence");
      }
      const result = await client.retryPending();
      assert.equal(result.receipt.replayed, true);
      assert.equal(lease.outbox.read(), null, "acknowledgement is settled for this lease");
      assert.ok(lease.recovery.read().settled.original === originalDraft, "Accounts retains the exact original recovery draft");
      const reloaded = await client.load();
      assert.equal(reloaded.durable_revision, 1);
      assert.ok(reloaded.state_json === committedState);
      assert.ok(isDeepStrictEqual(reloaded.state, JSON.parse(committedState)));
      if (pass === 2) {
        const deck = await client.getDeck({ scope: "personal", deck_id: result.deck_id });
        assert.equal(deck.card_count, 50);
        assert.ok(deck.deck.cards.every((card, index) => card.definition_md === args.deck.cards[index].definition));
        lease.cache.write(reloaded);
        assert.ok(isDeepStrictEqual(lease.cache.read(), reloaded));
      }
    }
    assert.equal(lease.executionGuard.isCurrent(execution), true);
    await lease.release();
    assert.equal(lease.executionGuard.isCurrent(execution), false);
    assert.equal(browser.lockStats.active.length, 0);
  }
  assert.equal(posts.length, 3);
  assert.ok(posts.every((post) => post.status === 200 && post.binding === binding && post.text === posts[0].text),
    "all three delivery attempts carry the exact original command bytes and binding");
  assert.ok(tickets.every((ticket) => !controller.executionGuard.isCurrent(ticket)));
  assert.equal(await h.db.prepare("SELECT COUNT(*) AS n FROM meshful_v2_receipts").first("n"), 1);
  assertAccountOperationsHeldLock(browser);
  t.diagnostic(`args=205026B command=${bytes(posts[0].text)}B state=${bytes(committedState)}B SQL receipts=1 lease generations=3`);
});

test("a late A commit and revoked A outbox cleanup cannot alter B's pending action or UI guard", async (t) => {
  const h = await setup(t);
  const browser = createBrowserHarness({ origin });
  const { controller } = fixtureController(t, browser);
  const aBootstrapTicket = controller.beginEpoch();
  const aBootstrap = (await h.call("switch-a", "state")).body.data;
  const aTicket = controller.bindPrincipal(aBootstrap.account_binding, aBootstrapTicket);
  const leaseA = await controller.acquire({ accountBinding: aBootstrap.account_binding, ticket: aTicket });
  const responseReady = createDeferred();
  const releaseResponse = createDeferred();
  t.after(() => releaseResponse.resolve());
  const clientA = h.client("switch-a", { outbox: leaseA.outbox, async afterResponse(response, url) {
    if (url.endsWith("/commands")) {
      responseReady.resolve(response.status);
      await releaseResponse.promise;
    }
    return response;
  } });
  await clientA.load();
  const executionA = leaseA.executionGuard.capture();
  const delayedA = clientA.ingestDeck(makeNativeV2RegressionArgs({ idempotencyKey: "switch-action-a" }));
  assert.equal(await responseReady.promise, 200, "A is committed in actual SQLite before switching");
  const aRecoveryBytes = browser.bytes.get(leaseA.keys.outbox);

  const bBootstrapTicket = controller.beginEpoch({ broadcast: true });
  await leaseA.released;
  const bBootstrap = (await h.call("switch-b", "state")).body.data;
  assert.notEqual(bBootstrap.account_binding, aBootstrap.account_binding);
  const bTicket = controller.bindPrincipal(bBootstrap.account_binding, bBootstrapTicket);
  const leaseB = await controller.acquire({ accountBinding: bBootstrap.account_binding, ticket: bTicket });
  assert.notEqual(leaseA.keys.outbox, leaseB.keys.outbox);
  const clientB = h.client("switch-b", { outbox: leaseB.outbox, afterResponse(response, url) {
    if (url.endsWith("/commands") && response.status === 200) throw new Error("synthetic B response loss");
    return response;
  } });
  await clientB.load();
  const executionB = leaseB.executionGuard.capture();
  const argsB = makeNativeV2RegressionArgs({ idempotencyKey: "switch-action-b" });
  await assert.rejects(clientB.ingestDeck(argsB), code("REQUEST_UNCONFIRMED"));
  const bRecoveryBytes = browser.bytes.get(leaseB.keys.outbox);
  const bWrites = browser.storageStats.operations.filter((item) => item.key === leaseB.keys.outbox && item.operation === "write").length;
  releaseResponse.resolve();
  const lateA = await delayedA;
  assert.equal(lateA.receipt.replayed, false, "a known server commit remains known after local cleanup fails");
  assert.equal(clientA.getPending().recoveryStatus, "committed-outbox-pending");
  assert.equal(leaseA.executionGuard.isCurrent(executionA), false, "Website must suppress A's late UI result");
  assert.equal(leaseB.executionGuard.isCurrent(executionB), true);
  assert.throws(() => leaseA.outbox.write(null), code("ACCOUNT_LEASE_LOST"));
  assert.ok(browser.bytes.get(leaseA.keys.outbox) === aRecoveryBytes);
  assert.ok(browser.bytes.get(leaseB.keys.outbox) === bRecoveryBytes);
  assert.equal(browser.storageStats.operations.filter((item) => item.key === leaseB.keys.outbox && item.operation === "write").length, bWrites);
  assert.ok(isDeepStrictEqual(leaseB.outbox.read().command.args, argsB));
  assert.equal(leaseB.outbox.read().accountBinding, bBootstrap.account_binding);
  assert.equal((await h.call("switch-a", "state")).body.data.durable_revision, 1);
  assert.equal((await h.call("switch-b", "state")).body.data.durable_revision, 1);
  assert.equal(await h.db.prepare("SELECT COUNT(*) AS n FROM meshful_v2_receipts").first("n"), 2);
  assertAccountOperationsHeldLock(browser);
  await leaseB.release();
  t.diagnostic("two authenticated owners, two SQL commits; late A delivery blocked by its guard; B recovery bytes unchanged");
});

test("default 5MiB draft admits the original maximum native action and exact replay; oversized optional cache refuses safely", async (t) => {
  const h = await setup(t, { catalog: [] });
  const browser = createBrowserHarness({ origin });
  const { controller, invalidations } = fixtureController(t, browser);
  assert.equal(controller.limits.draftBytes, 5 * 1024 * 1024);
  assert.equal(controller.limits.cacheBytes, 1_000_000);
  assert.ok(isDeepStrictEqual(controller.limits, DEFAULT_STORAGE_LIMITS));
  const bootstrapTicket = controller.beginEpoch();
  const bootstrap = (await h.call("maximum-native", "state")).body.data;
  const ticket = controller.bindPrincipal(bootstrap.account_binding, bootstrapTicket);
  const lease = await controller.acquire({ accountBinding: bootstrap.account_binding, ticket });
  const args = makeMaxNativeV2Args();
  assert.equal(bytes(JSON.stringify(args)), 4_523_091);
  assert.equal(digest(JSON.stringify(args)), MAX_NATIVE_V2_CREATE_ARGS_SHA256);
  const intentDigest = digest(stableJson(args));
  const posts = [];
  const client = h.client("maximum-native", { outbox: lease.outbox, afterResponse(response, url, init) {
    if (url.endsWith("/commands")) {
      const sent = JSON.parse(init.body);
      posts.push({ digest: digest(init.body), bytes: bytes(init.body), status: response.status,
        expectedRevision: sent.expected_revision, intent: digest(stableJson(sent.args)) });
      assert.equal(sent.request_id, args.idempotency_key, "the original 128-NUL key is not replaced or normalized");
    }
    return response;
  } });
  const initial = await client.load();
  lease.cache.write(initial); // A prior known-good optional cache must survive refusal.
  const cacheBefore = browser.bytes.get(lease.keys.cache);
  const execution = lease.executionGuard.capture();
  h.resetMetrics();
  const ingested = await client.ingestDeck(args);
  const writeMetrics = structuredClone(h.metrics);
  assert.equal(ingested.receipt.replayed, false);
  const firstSettled = lease.recovery.read().settled;
  const draftBytes = bytes(firstSettled.original);
  assert.ok(draftBytes > 4_523_091 && draftBytes <= controller.limits.draftBytes);
  assert.ok(isDeepStrictEqual(JSON.parse(firstSettled.original).command.args, args));
  const loaded = await client.load();
  assert.equal(loaded.durable_revision, 1);
  assert.ok(bytes(loaded.state_json) > 6_700_000);
  assert.equal(loaded.state.schemaVersion, 2);
  const replayed = await client.ingestDeck(args);
  assert.equal(replayed.receipt.replayed, true);
  assert.equal(replayed.deck_id, ingested.deck_id);
  assert.equal(lease.outbox.read(), null);
  const replayEvidence = lease.recovery.read().settled;
  assert.equal(JSON.parse(replayEvidence.original).command.expected_revision, 1);
  assert.equal(JSON.parse(replayEvidence.previous).command.expected_revision, 1);
  assert.equal(JSON.parse(replayEvidence.pending).command.expected_revision, 0);
  assert.ok([replayEvidence.original, replayEvidence.previous, replayEvidence.pending]
    .every((raw) => digest(stableJson(JSON.parse(raw).command.args)) === intentDigest));
  assert.deepEqual(posts.map(({ status, expectedRevision }) => [status, expectedRevision]), [[200, 0], [409, 1], [200, 0]]);
  assert.equal(posts[2].digest, posts[0].digest, "receipt recovery resends the original full command bytes");
  assert.ok(posts.every((post) => post.intent === intentDigest));
  assert.equal((await client.load()).durable_revision, 1);
  assert.equal(await h.db.prepare("SELECT COUNT(*) AS n FROM meshful_v2_receipts").first("n"), 1);

  const writesBefore = browser.storageStats.operations.filter((item) => item.operation === "write").length;
  const recoveryBefore = browser.bytes.get(lease.keys.outbox);
  assert.throws(() => lease.cache.write(loaded), code("ACCOUNT_STORAGE_LIMIT"));
  assert.ok(browser.bytes.get(lease.keys.cache) === cacheBefore);
  assert.ok(browser.bytes.get(lease.keys.outbox) === recoveryBefore);
  assert.equal(browser.storageStats.operations.filter((item) => item.operation === "write").length, writesBefore);
  assert.equal(lease.isCurrent(), true, "codec admission refusal does not implicitly retire the caller");
  // Explicit consumer handling, not a claimed automatic Accounts behavior:
  // reject hydration/invalidate the presentation, preserve the old bytes, and
  // never raise the cache limit, disable recovery, or write unscoped local data.
  controller.dispose();
  await lease.released;
  assert.equal(lease.executionGuard.isCurrent(execution), false);
  assert.equal(invalidations.at(-1), "disposed");
  assert.ok(browser.bytes.get(lease.keys.cache) === cacheBefore);
  assert.ok(browser.bytes.get(lease.keys.outbox) === recoveryBefore);
  assertAccountOperationsHeldLock(browser);
  const outboxBytes = Math.max(...browser.storageStats.operations
    .filter((item) => item.operation === "write" && item.key === lease.keys.outbox).map((item) => bytes(item.value)));
  assert.ok(outboxBytes <= controller.limits.outboxBytes);
  assert.ok(writeMetrics.maxBindBytes < 2_000_000 && writeMetrics.maxParameters <= 100);
  t.diagnostic(`max args=4523091B command=${posts[0].bytes}B draft=${draftBytes}B outer-outbox-peak=${outboxBytes}B state=${bytes(loaded.state_json)}B`);
  t.diagnostic(`real SQLite commit SQL=${writeMetrics.queries} batch=${writeMetrics.batches.join(",")} max-bind=${writeMetrics.maxBindBytes}B; cache refused at 1000000B without writes`);
});

test("the read-only Accounts/canonical sources and Backend composition remain byte-identical through this receipt", async (t) => {
  const after = await sourceHashes();
  assert.deepEqual(after, before);
  for (const [label, hash] of Object.entries(after)) t.diagnostic(`${label} ${hash}`);
});
