import test from "node:test";
import assert from "node:assert/strict";
import { createAccountRuntime } from "../js/account-runtime.js";
import { createAccountSnapshotHydrator } from "../js/account-snapshot.js";
import { withApp } from "./helpers/app-harness.mjs";
import { accountFixture, deferred, KEY } from "./helpers/account-fixture.mjs";

// Real canonical projection; disposable controller/transport for lifecycle
// ordering only. No hosted authentication, Web Locks or account activation claim.
const NativeDate = Date;
async function withClock(callback) {
  let wall = NativeDate.parse("2026-08-31T16:00:00.000Z");
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [wall])); }
    static now() { return wall; }
  };
  try { await callback({ set: (value) => { wall = NativeDate.parse(value); } }); }
  finally { globalThis.Date = NativeDate; }
}
function seed(store, id = "availability") {
  return store.ingestDeck({ operation: "create", idempotency_key: `seed:${id}`, deck: {
    schema_version: "normalized-definition-deck.v2", deck_id: id, title: `Private ${id}`,
    cards: ["root", "child1", "child2"].map((id) => ({ id, term: id,
      definition: `PRIVATE_DEFINITION ${id}`, criteria: [`PRIVATE_CRITERION ${id}`] })),
    edges: [{ from: "root", to: "child1" }, { from: "root", to: "child2" }],
  } });
}
function update(store, id = "availability", title = "Updated course") {
  return store.updateDeck({ deck_id: id, expected_deck_revision: store.getSnapshot().personalDecks[id].revision,
    patch: { title }, idempotency_key: `title:${title}` });
}
function gradeRoot(store) {
  const current = store.startStudySession({ deck_id: "availability", limit: 1, idempotency_key: "fixture:start" });
  return store.submitGrade({ session_id: current.session.session_id, expected_session_revision: current.session.session_revision,
    card_id: current.current_card.card_id, expected_card_revision: current.current_card.card_revision,
    answer_origin: "chat", answer_text: "Injected provider-free mechanics judgment.", rating: "again",
    rubric_evidence: current.current_card.required_concepts.map((item) => ({ rubric_item_id: item.rubric_item_id,
      status: "missed", note: "Synthetic fixture only." })), feedback: "Synthetic fixture only.",
    misconceptions: [], confidence: 1, idempotency_key: "fixture:grade" });
}

test("the hydrator exposes only a bound canonical read beside a serializable snapshot", async () => withClock(async () => {
  const f = accountFixture(); seed(f.server("account-a").store);
  const before = f.snapshot();
  const hydrate = createAccountSnapshotHydrator(() => []);
  const model = await hydrate(before);
  assert.equal(model.kind, "confirmed-account-read-model.v1");
  assert.deepEqual(Object.keys(model.reads), ["getStudyAvailability", "getStudyActivity"]);
  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.reads), true);
  assert.deepEqual(structuredClone(model.snapshot), model.snapshot);
  assert.equal(model.snapshot.reads, undefined);
  const args = { deck_id: "availability", blocked_limit: 1 };
  assert.deepEqual(model.reads.getStudyAvailability(args), f.server("account-a").store.getStudyAvailability(args));
  assert.equal(f.snapshot().state_json, before.state_json);
}));

test("account availability is synchronous, detached, definition-free, and performs no transport or storage write", async () => withClock(async () => {
  const f = accountFixture(); seed(f.server("account-a").store);
  let loads = 0;
  f.setLoadHook(() => { loads++; return f.snapshot(); });
  const runtime = createAccountRuntime(f.options);
  try {
    const session = await runtime.connect();
    const before = f.snapshot().state_json;
    const result = session.store.getStudyAvailability({ deck_id: "availability", blocked_limit: 1 });
    assert.equal(result.then, undefined);
    assert.equal(result.app_revision, session.store.getSnapshot().revision);
    assert.equal(result.decks[0].eligible_new_count, 1);
    assert.equal(result.decks[0].blocked_new_count, 2);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DEFINITION|PRIVATE_CRITERION/);
    assert.ok(result.blockers.next_cursor);
    const next = session.store.getStudyAvailability({ deck_id: "availability", blocked_limit: 1, blocked_cursor: result.blockers.next_cursor });
    assert.equal(next.blockers.items.length, 1);
    assert.notEqual(next.blockers.items[0].card_id, result.blockers.items[0].card_id);
    result.decks[0].eligible_new_count = 10000;
    assert.equal(session.store.getStudyAvailability().decks[0].eligible_new_count, 1);
    assert.equal(loads, 1);
    assert.deepEqual(f.calls, []);
    assert.equal(f.snapshot().state_json, before);
    assert.deepEqual(session.getRecovery(), { command: null, claim: null });
    for (const method of ["seedDemoState", "setDeckArchived", "seedMasteredDemoDeck"]) assert.equal(session.store[method], undefined);
  } finally { runtime.dispose(); }
}));

test("confirmed account availability recomputes due time without a network reload or snapshot write", async () => withClock(async (clock) => {
  const f = accountFixture(); seed(f.server("account-a").store); gradeRoot(f.server("account-a").store);
  const runtime = createAccountRuntime(f.options);
  try {
    const session = await runtime.connect();
    const before = f.snapshot().state_json;
    const initial = session.store.getStudyAvailability();
    assert.equal(initial.decks[0].due_count, 0);
    assert.equal(initial.decks[0].eligible_new_count, 0);
    clock.set(initial.decks[0].next_due_at);
    const later = session.store.getStudyAvailability();
    assert.equal(later.decks[0].due_count, 1);
    assert.equal(later.decks[0].next_due_at, null);
    assert.notEqual(later.as_of, initial.as_of);
    assert.equal(later.app_revision, initial.app_revision);
    assert.equal(f.snapshot().state_json, before);
    assert.deepEqual(f.calls, []);
  } finally { runtime.dispose(); }
}));

test("imported canonical app revision is not confused with the independent durable revision", async () => {
  const f = accountFixture(); const store = f.server("account-a").store;
  seed(store); update(store, "availability", "A"); update(store, "availability", "B");
  const raw = f.snapshot();
  assert.ok(JSON.parse(raw.state_json).revision > 1);
  f.setLoadHook(() => ({ ...raw, durable_revision: 1 }));
  const runtime = createAccountRuntime(f.options);
  try {
    const session = await runtime.connect();
    const result = session.store.getStudyAvailability();
    assert.equal(result.app_revision, JSON.parse(raw.state_json).revision);
    assert.notEqual(result.app_revision, 1);
    assert.equal(await session.refresh(), 1);
  } finally { runtime.dispose(); }
});

test("retired A reads cannot acquire B or a later A epoch, including the synchronous invalidation sink", async () => {
  const f = accountFixture(); seed(f.server("account-a").store, "a"); seed(f.server("account-b").store, "b");
  let oldRead, invalidationChecks = 0;
  const runtime = createAccountRuntime({ ...f.options, onInvalidate() {
    if (oldRead) { assert.throws(() => oldRead(), { code: "ACCOUNT_CHANGED" }); invalidationChecks++; }
  } });
  try {
    const a = await runtime.connect(); oldRead = a.store.getStudyAvailability;
    f.setPrincipal("account-b"); const b = await runtime.connect();
    assert.throws(() => oldRead(), { code: "ACCOUNT_CHANGED" });
    assert.deepEqual(b.store.getStudyAvailability().decks.map((deck) => deck.deck_id), ["b"]);
    f.setPrincipal("account-a"); runtime.invalidate();
    const again = await runtime.connect();
    assert.throws(() => oldRead(), { code: "ACCOUNT_CHANGED" });
    assert.deepEqual(again.store.getStudyAvailability().decks.map((deck) => deck.deck_id), ["a"]);
    assert.ok(invalidationChecks >= 2);
  } finally { runtime.dispose(); }
});

test("invalidation during the synchronous canonical read suppresses its old-account result", async () => {
  const f = accountFixture(); seed(f.server("account-a").store);
  let invalidate = false;
  const runtime = createAccountRuntime({ ...f.options, async hydrateSnapshot(data) {
    const model = await f.options.hydrateSnapshot(data);
    return { ...model, reads: { getStudyAvailability(args) {
      const result = model.reads.getStudyAvailability(args);
      if (invalidate) runtime.invalidate();
      return result;
    } } };
  } });
  try {
    const session = await runtime.connect(); invalidate = true;
    assert.throws(() => session.store.getStudyAvailability(), { code: "ACCOUNT_CHANGED" });
  } finally { runtime.dispose(); }
});

test("a known newer snapshot retires the reader before hydration, and an older response cannot reinstate it", async () => {
  const f = accountFixture(); const server = f.server("account-a").store; seed(server);
  const initial = f.snapshot(); const entered = deferred(), pause = deferred();
  let hold = true;
  const runtime = createAccountRuntime({ ...f.options, async hydrateSnapshot(data) {
    if (data.durable_revision > initial.durable_revision && hold) { entered.resolve(); await pause.promise; }
    return f.options.hydrateSnapshot(data);
  } });
  try {
    const session = await runtime.connect(); update(server);
    const successor = f.snapshot();
    const pending = session.refresh(); await entered.promise;
    assert.throws(() => session.store.getStudyAvailability(), { code: "STUDY_AVAILABILITY_UNAVAILABLE" });
    f.setLoadHook(() => initial);
    await assert.rejects(session.refresh(), { code: "STALE_ACCOUNT_SNAPSHOT" });
    assert.throws(() => session.store.getStudyAvailability(), { code: "STUDY_AVAILABILITY_UNAVAILABLE" });
    hold = false; pause.resolve();
    await assert.rejects(pending, { code: "STALE_ACCOUNT_SNAPSHOT" });
    f.setLoadHook(() => successor);
    await session.refresh();
    assert.equal(session.store.getStudyAvailability().app_revision, JSON.parse(successor.state_json).revision);
  } finally { pause.resolve(); runtime.dispose(); }
});

test("a superseded hydration cannot install its old reader after a newer snapshot is adopted", async () => {
  const f = accountFixture(); const server = f.server("account-a").store; seed(server);
  const pause = deferred(), entered = deferred(); let delayedRevision = null;
  const runtime = createAccountRuntime({ ...f.options, async hydrateSnapshot(data) {
    if (data.durable_revision === delayedRevision) { entered.resolve(); await pause.promise; }
    return f.options.hydrateSnapshot(data);
  } });
  try {
    const session = await runtime.connect(); update(server, "availability", "First change");
    delayedRevision = f.snapshot().durable_revision;
    const older = session.refresh(); await entered.promise;
    update(server, "availability", "Second change");
    const revision = await session.refresh();
    const before = session.store.getStudyAvailability();
    pause.resolve(); assert.equal(await older, revision);
    assert.equal(session.store.getStudyAvailability().app_revision, before.app_revision);
    assert.equal(session.store.getSnapshot().personalDecks.availability.title, "Second change");
  } finally { pause.resolve(); runtime.dispose(); }
});

test("a newer response arriving from a superseded request still retires an older confirmed reader", async () => {
  const f = accountFixture(); const server = f.server("account-a").store; seed(server);
  const initial = f.snapshot(); const arrived = deferred(), pause = deferred();
  const runtime = createAccountRuntime(f.options);
  try {
    const session = await runtime.connect(); update(server);
    const newer = f.snapshot();
    f.setLoadHook(async () => { arrived.resolve(); await pause.promise; return newer; });
    const earlier = session.refresh(); await arrived.promise;
    f.setLoadHook(() => initial);
    assert.equal(await session.refresh(), initial.durable_revision);
    assert.equal(session.store.getStudyAvailability().app_revision, JSON.parse(initial.state_json).revision);
    pause.resolve(); await assert.rejects(earlier, { code: "STALE_ACCOUNT_SNAPSHOT" });
    assert.throws(() => session.store.getStudyAvailability(), { code: "STUDY_AVAILABILITY_UNAVAILABLE" });
    await assert.rejects(session.refresh(), { code: "STALE_ACCOUNT_SNAPSHOT" });
    f.setLoadHook(() => newer); await session.refresh();
    assert.equal(session.store.getStudyAvailability().app_revision, JSON.parse(newer.state_json).revision);
  } finally { pause.resolve(); runtime.dispose(); }
});

test("blocker cursors are forwarded exactly and become stale after confirmed snapshot replacement", async () => {
  const f = accountFixture(); seed(f.server("account-a").store);
  const runtime = createAccountRuntime(f.options);
  try {
    const session = await runtime.connect();
    const page = session.store.getStudyAvailability({ deck_id: "availability", blocked_limit: 1 });
    update(f.server("account-a").store);
    await session.refresh();
    assert.throws(() => session.store.getStudyAvailability({ deck_id: "availability", blocked_limit: 1,
      blocked_cursor: page.blockers.next_cursor }), { code: "STALE_AVAILABILITY_CURSOR" });
    assert.ok(session.store.getStudyAvailability({ deck_id: "availability", blocked_limit: 1 }).blockers.next_cursor);
  } finally { runtime.dispose(); }
});

for (const kind of ["missing", "async", "mismatched"]) {
  test(`${kind} read capabilities fail closed without a durable read or local mutation fallback`, async () => {
    const f = accountFixture(); seed(f.server("account-a").store);
    const runtime = createAccountRuntime({ ...f.options, async hydrateSnapshot(data) {
      const model = await f.options.hydrateSnapshot(data);
      if (kind === "missing") return model.snapshot;
      return { ...model, reads: { getStudyAvailability: kind === "async" ? async () => ({}) : () => ({ app_revision: -1 }) } };
    } });
    try {
      const session = await runtime.connect();
      assert.throws(() => session.store.getStudyAvailability(), { code: kind === "missing" ? "STUDY_AVAILABILITY_UNAVAILABLE" : "INVALID_ACCOUNT_RESPONSE" });
      assert.deepEqual(f.calls, []);
    } finally { runtime.dispose(); }
  });
}

test("explicit Check availability reloads after a transient account hydration failure, then uses only the durable start", async () => {
  const f = accountFixture(); seed(f.server("account-a").store);
  let loads = 0, failHydration = false; const failed = deferred();
  f.setLoadHook(() => { loads++; return f.snapshot(); });
  const options = { ...f.options, async hydrateSnapshot(data) {
    if (failHydration) { failed.resolve(); throw new Error("Transient catalog hydration failure"); }
    return f.options.hydrateSnapshot(data);
  } };
  await withApp({ accountOptions: options, storageError: new Error("No local fallback allowed"),
    catalogOptions: { catalog: [], seedExamples: false } }, async ({ view, window, click, flush }) => {
    update(f.server("account-a").store);
    failHydration = true;
    for (const callback of window.listeners.get("focus") ?? []) callback();
    await failed.promise;
    await Promise.resolve();
    const beforeRetry = loads;
    failHydration = false;
    click('[data-start-deck="availability"]'); await flush();
    assert.ok(loads > beforeRetry);
    assert.equal(f.calls.filter((call) => call.method === "startStudySession").length, 1);
    assert.match(view.textContent, /Answer in chat/);
    assert.doesNotMatch(view.textContent, /Study availability unavailable/);
  });
});

test("an account switch during explicit availability recovery cannot start the old deck or reveal its data", async () => {
  const f = accountFixture(); seed(f.server("account-a").store, "a"); seed(f.server("account-b").store, "b");
  let failHydration = false; const failed = deferred(), entered = deferred(), pause = deferred();
  const options = { ...f.options, async hydrateSnapshot(data) {
    if (failHydration) { failed.resolve(); throw new Error("Transient fixture failure"); }
    return f.options.hydrateSnapshot(data);
  } };
  await withApp({ accountOptions: options, storageError: new Error("No local fallback allowed"),
    catalogOptions: { catalog: [], seedExamples: false } }, async ({ view, window, click, flush, application }) => {
    update(f.server("account-a").store, "a"); failHydration = true;
    for (const callback of window.listeners.get("focus") ?? []) callback();
    await failed.promise; await Promise.resolve(); failHydration = false;
    f.setLoadHook(async (binding) => {
      const data = f.snapshot(binding);
      if (binding === "account-a") { entered.resolve(); await pause.promise; }
      return data;
    });
    click('[data-start-deck="a"]'); await entered.promise;
    f.setPrincipal("account-b"); await application.reconnect();
    pause.resolve(); await flush();
    assert.equal(f.calls.filter((call) => call.method === "startStudySession").length, 0);
    assert.match(view.textContent, /Private b/);
    assert.doesNotMatch(view.textContent, /Private a|PRIVATE_DEFINITION|PRIVATE_CRITERION|Updated course/);
  });
});

for (const activeDeck of ["requested", "other"]) {
  test(`availability recovery reconciles a newly discovered ${activeDeck}-deck active session before starting`, async () => {
    const f = accountFixture(); const server = f.server("account-a").store;
    seed(server, "requested"); seed(server, "other");
    let failHydration = false; const failed = deferred();
    const options = { ...f.options, async hydrateSnapshot(data) {
      if (failHydration) { failed.resolve(); throw new Error("Transient fixture hydration failure"); }
      return f.options.hydrateSnapshot(data);
    } };
    await withApp({ accountOptions: options, catalogOptions: { catalog: [], seedExamples: false } }, async ({ view, window, click, flush, location }) => {
      const active = server.startStudySession({ deck_id: activeDeck, limit: 1, idempotency_key: "external-active" });
      failHydration = true;
      for (const callback of window.listeners.get("focus") ?? []) callback();
      await failed.promise; await Promise.resolve(); failHydration = false;
      click('[data-start-deck="requested"]'); await flush();
      assert.match(view.textContent, /Answer in chat/);
      const state = server.getSnapshot();
      assert.equal(state.sessions[state.activeSessionId].deckId, "requested");
      if (activeDeck === "requested") {
        assert.equal(location.hash, `#session/${active.session.session_id}`);
        assert.equal(f.calls.filter((call) => call.method === "startStudySession").length, 0);
        assert.equal(f.calls.filter((call) => call.method === "finishStudySession").length, 0);
      } else {
        assert.equal(state.sessions[active.session.session_id].status, "paused");
        assert.equal(f.calls.filter((call) => call.method === "startStudySession").length, 1);
        assert.equal(f.calls.filter((call) => call.method === "finishStudySession").length, 1);
      }
    });
  });
}
