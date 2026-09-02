import test from "node:test";
import assert from "node:assert/strict";
import { createAccountRuntime } from "../js/account-runtime.js";
import { createAccountSnapshotHydrator } from "../js/account-snapshot.js";
import { createLocalClaimSource } from "../js/local-claim-source.js";
import { createMemoryStorage } from "../js/store.js";
import { CATALOG } from "../data/catalog.js";
import { accountFixture, deferred, KEY, REF } from "./helpers/account-fixture.mjs";

test("account startup uses authenticated load, no local mutation methods or seed, and device-only navigation", async () => {
  const fixture = accountFixture();
  const runtime = createAccountRuntime(fixture.options);
  const connected = await runtime.connect();
  assert.equal(fixture.clients.length, 1);
  assert.deepEqual(connected.store.getSnapshot().personalDecks, {});
  for (const name of ["setDeckArchived", "seedDemoState", "seedMasteredDemoDeck"]) assert.equal(connected.store[name], undefined);
  connected.store.setView({ route: "decks" });
  assert.equal(connected.store.getSnapshot().view.route, "decks");
  assert.equal(fixture.snapshot().state_json, null);
  runtime.dispose();
});

test("server snapshots hydrate without copying them into the optional synchronous browser cache", async () => {
  const fixture = accountFixture();
  let cacheAccesses = 0;
  const runtime = createAccountRuntime({ ...fixture.options, createStorageController(options) {
    const controller = fixture.options.createStorageController(options);
    return { ...controller, async acquire(input) {
      const lease = await controller.acquire(input);
      return { ...lease, cache: new Proxy({}, { get() { cacheAccesses++; throw new Error("optional cache is not an account snapshot store"); } }) };
    } };
  } });
  const session = await runtime.connect();
  await session.refresh();
  assert.deepEqual(session.store.getSnapshot().personalDecks, {});
  assert.equal(cacheAccesses, 0);
  runtime.dispose();
});

test("old discovery cannot bind after a newer account discovery", async () => {
  const first = deferred();
  const fixture = accountFixture();
  let requests = 0;
  const runtime = createAccountRuntime({ ...fixture.options, fetchImpl: (...args) => ++requests === 1 ? first.promise : fixture.options.fetchImpl(...args) });
  const old = runtime.connect();
  fixture.setPrincipal("account-b");
  const fresh = await runtime.connect();
  first.resolve(new Response(JSON.stringify({ ok: true, data: { account_binding: "account-a" } })));
  await assert.rejects(old, { code: "ACCOUNT_CHANGED" });
  assert.equal(fresh.accountBinding, "account-b");
  assert.equal(fixture.clients.length, 1);
  runtime.dispose();
});

test("A to logout to A retires the old lease and creates a new client", async () => {
  const fixture = accountFixture();
  const runtime = createAccountRuntime(fixture.options);
  const old = await runtime.connect();
  const ticket = old.executionGuard.capture();
  runtime.invalidate();
  const fresh = await runtime.connect();
  assert.equal(old.isCurrent(ticket), false);
  assert.throws(() => old.store.getSnapshot(), { code: "ACCOUNT_CHANGED" });
  assert.equal(fresh.isCurrent(), true);
  assert.equal(fixture.clients.length, 2);
  runtime.dispose();
});

test("reconnection awaits native release after synchronous invalidation before reacquiring a writer", async () => {
  const fixture = accountFixture();
  const release = deferred();
  let acquisitions = 0;
  const runtime = createAccountRuntime({ ...fixture.options, createStorageController(options) {
    const controller = fixture.options.createStorageController(options);
    return { ...controller, async acquire(input) {
      const lease = await controller.acquire(input);
      acquisitions++;
      return acquisitions === 1 ? { ...lease, release() {
        lease.release(); // Synchronous authority invalidation, asynchronous native completion.
        return release.promise;
      } } : lease;
    } };
  } });
  const old = await runtime.connect();
  runtime.invalidate();
  assert.equal(old.isCurrent(), false);
  const connecting = runtime.connect();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(acquisitions, 1);
  assert.equal(fixture.clients.length, 1);
  release.resolve();
  assert.equal((await connecting).isCurrent(), true);
  assert.equal(acquisitions, 2);
  runtime.dispose();
});

test("invalidation during hydration cannot install an old account snapshot", async () => {
  const fixture = accountFixture();
  const paused = deferred();
  const entered = deferred();
  let wait = false;
  const runtime = createAccountRuntime({ ...fixture.options, async hydrateSnapshot(data) {
    if (wait && data.account_binding === "account-a") { entered.resolve(); await paused.promise; }
    return fixture.options.hydrateSnapshot(data);
  } });
  const old = await runtime.connect();
  wait = true;
  const loading = old.refresh();
  await entered.promise;
  fixture.setPrincipal("account-b");
  const fresh = await runtime.connect();
  paused.resolve();
  await assert.rejects(loading, { code: "ACCOUNT_CHANGED" });
  assert.equal(fresh.accountBinding, "account-b");
  assert.deepEqual(fresh.store.getSnapshot().personalDecks, {});
  runtime.dispose();
});

test("late/out-of-order hydration and equal-revision divergent bytes cannot rewind the visible state", async () => {
  const fixture = accountFixture();
  const pause = deferred();
  const entered = deferred();
  let pending = true;
  const runtime = createAccountRuntime({ ...fixture.options, async hydrateSnapshot(data) {
    if (data.durable_revision === 1 && pending) { pending = false; entered.resolve(); await pause.promise; }
    return { personalDecks: {}, revision: data.durable_revision };
  } });
  const session = await runtime.connect();
  fixture.setLoadHook(() => ({ ...fixture.snapshot(), durable_revision: 1, state_json: "one" }));
  const slow = session.refresh();
  await entered.promise;
  fixture.setLoadHook(() => ({ ...fixture.snapshot(), durable_revision: 2, state_json: "two" }));
  await session.refresh();
  pause.resolve();
  assert.equal(await slow, 2, "a refresh superseded by adopted newer data must not become a false save failure");
  assert.equal(session.store.getSnapshot().revision, 2);
  fixture.setLoadHook(() => ({ ...fixture.snapshot(), durable_revision: 2, state_json: "changed" }));
  await assert.rejects(session.refresh(), { code: "ACCOUNT_SNAPSHOT_CONFLICT" });
  assert.equal(session.store.getSnapshot().revision, 2);
  runtime.dispose();
});

test("a backend account-change rejection synchronously revokes data and old callbacks", async () => {
  const fixture = accountFixture();
  let hidden = 0;
  const runtime = createAccountRuntime({ ...fixture.options, onInvalidate() { hidden++; } });
  const session = await runtime.connect();
  fixture.setLoadHook(() => { throw Object.assign(new Error("changed"), { code: "ACCOUNT_CHANGED", status: 409 }); });
  await assert.rejects(session.refresh(), { code: "ACCOUNT_CHANGED" });
  assert.equal(session.isCurrent(), false);
  assert.equal(hidden, 2);
  runtime.dispose();
});

test("missing/busy native lease access never falls back to a client or browser learner store", async () => {
  const fixture = accountFixture();
  const runtime = createAccountRuntime({ ...fixture.options, createStorageController(options) {
    const controller = fixture.options.createStorageController(options);
    return { ...controller, acquire() { throw new Error("native lock busy"); } };
  } });
  await assert.rejects(runtime.connect(), /native lock busy/);
  assert.equal(fixture.clients.length, 0);
  assert.equal(fixture.snapshot().state_json, null);
  runtime.dispose();
});

test("read-only account hydration refuses a client-side legacy migration", async () => {
  const fixture = accountFixture();
  fixture.server("account-a").store.addLibraryDeck({ library_deck_id: "linear-algebra-i", expected_catalog_version: "1.0.0-example", client_action_id: "install" });
  const started = fixture.server("account-a").store.startStudySession({ deck_id: "deck-linear-algebra-i", idempotency_key: "start" });
  const data = fixture.snapshot();
  const state = JSON.parse(data.state_json);
  state.sessions[started.session.session_id].phase = "answer_committed";
  state.sessions[started.session.session_id].pendingAttempt = { status: "awaiting_agent_grade" };
  const raw = JSON.stringify(state);
  const hydrate = createAccountSnapshotHydrator(() => CATALOG);
  await assert.rejects(hydrate({ catalog_ref: REF, state_json: raw }), /server-owned state migration/);
  assert.equal(data.state_json, fixture.snapshot().state_json);
});

test("explicit local-source preparation preserves original bytes and pins the first destination across accounts", async () => {
  const raw = " { \"exact\": \"α\" }\r\n";
  const storage = createMemoryStorage({ [KEY]: raw });
  const locks = { request: (name, options, callback) => callback({ name, mode: options.mode }) };
  const source = createLocalClaimSource({ siteId: "fixture", storage, locks, catalogRef: REF, makeId: () => "lineage" });
  const preview = source.inspect();
  assert.equal(storage.dump()[KEY], raw);
  const first = await source.prepare({ ...preview, accountBinding: "account-a", check() {} });
  assert.equal(first.rawStateJson, raw);
  assert.equal(first.sourceId, "browser:lineage");
  await assert.rejects(source.prepare({ ...preview, accountBinding: "account-b", check() {} }), /already reserved/);
  assert.equal(storage.getItem(KEY), raw);
  assert.equal((await source.prepare({ ...preview, accountBinding: "account-a", check() {} })).sourceId, first.sourceId);
});

test("local-source quota and changed-after-preview faults send no claim and preserve raw data", async () => {
  const storage = createMemoryStorage({ [KEY]: "original" });
  const locks = { request: (name, options, callback) => callback({ name, mode: options.mode }) };
  const source = createLocalClaimSource({ siteId: "fixture", storage, locks, catalogRef: REF });
  const preview = source.inspect();
  storage.setItem(KEY, "new bytes");
  await assert.rejects(source.prepare({ ...preview, accountBinding: "a", check() {} }), /changed after confirmation/);
  assert.equal(storage.getItem(KEY), "new bytes");
  const full = createLocalClaimSource({ siteId: "fixture", storage: { ...storage, setItem() { throw new Error("quota"); } }, locks, catalogRef: REF });
  await assert.rejects(full.prepare({ ...full.inspect(), accountBinding: "a", check() {} }), /quota/);
  assert.equal(storage.getItem(KEY), "new bytes");
});

test("claim preparation synchronously excludes tool writes and a second confirmation", async () => {
  const fixture = accountFixture();
  const pause = deferred(), entered = deferred();
  const runtime = createAccountRuntime({ ...fixture.options, localClaimSource: {
    inspect: () => ({ rawStateJson: "{}", catalogRef: REF }),
    async prepare() { entered.resolve(); await pause.promise; throw new Error("source unavailable"); },
  } });
  const session = await runtime.connect();
  const preview = await session.previewLocalClaim();
  const confirming = session.confirmLocalClaim(preview, session.accountBinding);
  await entered.promise;
  await assert.rejects(session.store.ingestDeck({}), { code: "CLAIM_RECOVERY_REQUIRED" });
  await assert.rejects(session.confirmLocalClaim(preview, session.accountBinding), { code: "LOCAL_CLAIM_NOT_EMPTY" });
  pause.resolve();
  await assert.rejects(confirming, /source unavailable/);
  assert.equal(fixture.calls.length, 0);
  assert.equal(session.getRecovery().claim, null);
  runtime.dispose();
});

test("a confirmed claim sets a durable revision floor and retains recovery until that snapshot hydrates", async () => {
  const fixture = accountFixture();
  const bodies = [];
  const raw = " {\"kept\":\"exact α bytes\"}\r\n";
  const sourceDigest = "sha256:" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const runtime = createAccountRuntime({ ...fixture.options, hydrateSnapshot: (data) => ({ personalDecks: {}, revision: data.durable_revision }),
    localClaimSource: { inspect: () => ({ rawStateJson: raw, catalogRef: REF }), prepare: (source) => ({ ...source, sourceId: "source-exact" }) },
    async fetchImpl(url, options) {
      if (!url.endsWith("/claims")) return fixture.options.fetchImpl(url, options);
      const body = JSON.parse(options.body); bodies.push(body);
      return Response.json({ ok: true, data: { durable_revision: 1, catalog_ref: REF, result: {
        source_id: body.source_id, source_digest: sourceDigest,
        receipt: { operation: "claim_local_state", idempotency_key: body.request_id, replayed: bodies.length > 1 },
      } } });
    },
  });
  const session = await runtime.connect();
  const preview = await session.previewLocalClaim();
  await assert.rejects(session.confirmLocalClaim(preview, session.accountBinding), { code: "STALE_ACCOUNT_SNAPSHOT" });
  assert.equal(session.getRecovery().claim.request.raw_state_json, raw);
  await assert.rejects(session.previewLocalClaim(), { code: "LOCAL_CLAIM_NOT_EMPTY" });
  fixture.setLoadHook(() => ({ ...fixture.snapshot(), durable_revision: 1, state_json: raw }));
  const recovered = await session.retryLocalClaim();
  assert.equal(recovered.receipt.replayed, true);
  assert.deepEqual(bodies[1], bodies[0]);
  assert.equal(session.getRecovery().claim, null);
  assert.equal(session.store.getSnapshot().revision, 1);
  runtime.dispose();
});
