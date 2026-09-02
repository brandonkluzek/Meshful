import test from "node:test";
import assert from "node:assert/strict";
import { createAccountRuntime } from "../js/account-runtime.js";
import { createAccountSnapshotHydrator } from "../js/account-snapshot.js";
import { accountFixture, deferred } from "./helpers/account-fixture.mjs";
import { withClock, seed, review } from "./helpers/activity-consumer-fixture.mjs";

// Actual canonical projector/hydrator with disposable transport/lease doubles.
// These assertions do not activate accounts or qualify hosted authentication.
test("only two bound read capabilities sit beside the serializable confirmed snapshot", async () => withClock(async () => {
  const f = accountFixture(); seed(f.server("account-a").store); review(f.server("account-a").store);
  const before = f.snapshot();
  const model = await createAccountSnapshotHydrator(() => [])(before);
  assert.deepEqual(Object.keys(model.reads).sort(), ["getStudyActivity", "getStudyAvailability"]);
  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.reads), true);
  assert.deepEqual(structuredClone(model.snapshot), model.snapshot);
  assert.equal(model.snapshot.reads, undefined);
  assert.deepEqual(model.reads.getStudyActivity({ days: 7 }), f.server("account-a").store.getStudyActivity({ days: 7 }));
  assert.equal(f.snapshot().state_json, before.state_json);
}));

test("account activity is synchronous, detached and count-only with no extra read transport or writes", async () => withClock(async (clock) => {
  const f = accountFixture(); seed(f.server("account-a").store); review(f.server("account-a").store);
  let loads = 0; f.setLoadHook(() => { loads++; return f.snapshot(); });
  const runtime = createAccountRuntime(f.options);
  try {
    const session = await runtime.connect(); const before = f.snapshot().state_json;
    const read = session.store.getStudyActivity;
    const result = read();
    assert.equal(result.then, undefined);
    assert.equal(result.review_count, 1);
    assert.equal(result.app_revision, session.store.getSnapshot().revision);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|card_id|session_id|rubric|answer/);
    result.days.at(-1).review_count = 999; result.history.issues.push({ code: "invented", count: 999 });
    assert.equal(read().review_count, 1);
    assert.deepEqual(read().history.issues, []);
    clock.advance(8 * 86_400_000);
    assert.equal(read().review_count, 0);
    assert.equal(read({ days: 366 }).review_count, 1);
    assert.equal(loads, 1);
    assert.deepEqual(f.calls, []);
    assert.equal(f.snapshot().state_json, before);
  } finally { runtime.dispose(); }
}));

test("activity app_revision stays canonical when the confirmed durable revision is different", async () => withClock(async () => {
  const f = accountFixture(); seed(f.server("account-a").store); review(f.server("account-a").store);
  f.setLoadHook(() => ({ ...f.snapshot(), durable_revision: 100 }));
  const runtime = createAccountRuntime(f.options);
  try {
    const session = await runtime.connect();
    assert.equal(session.store.getStudyActivity().app_revision, session.store.getSnapshot().revision);
    assert.notEqual(session.store.getStudyActivity().app_revision, 100);
    assert.equal(session.store.getStudyActivity().review_count, 1);
  } finally { runtime.dispose(); }
}));

for (const kind of ["missing", "throwing-accessor", "throwing-read", "async-rejection", "wrong-revision"]) {
  test(`an independently ${kind} activity capability leaves availability valid`, async () => withClock(async () => {
    const f = accountFixture(); seed(f.server("account-a").store);
    const runtime = createAccountRuntime({ ...f.options, async hydrateSnapshot(data) {
      const model = await f.options.hydrateSnapshot(data); const reads = { ...model.reads };
      if (kind === "missing") delete reads.getStudyActivity;
      if (kind === "throwing-accessor") Object.defineProperty(reads, "getStudyActivity", { get() { throw new Error("bad optional accessor"); } });
      if (kind === "throwing-read") reads.getStudyActivity = () => { throw new Error("bad optional read"); };
      if (kind === "async-rejection") reads.getStudyActivity = async () => { throw new Error("bad async read"); };
      if (kind === "wrong-revision") reads.getStudyActivity = () => ({ ...model.reads.getStudyActivity(), app_revision: 999 });
      return { ...model, reads };
    } });
    try {
      const session = await runtime.connect();
      const readiness = session.store.getStudyAvailability();
      assert.throws(() => session.store.getStudyActivity());
      await Promise.resolve();
      assert.deepEqual(session.store.getStudyAvailability(), readiness);
      assert.equal(readiness.decks[0].eligible_new_count, 2);
    } finally { runtime.dispose(); }
  }));
}

test("missing availability does not disable independently valid recorded activity", async () => withClock(async () => {
  const f = accountFixture(); seed(f.server("account-a").store); review(f.server("account-a").store);
  const runtime = createAccountRuntime({ ...f.options, async hydrateSnapshot(data) {
    const model = await f.options.hydrateSnapshot(data);
    return { ...model, reads: { getStudyActivity: model.reads.getStudyActivity } };
  } });
  try {
    const session = await runtime.connect();
    assert.throws(() => session.store.getStudyAvailability(), { code: "STUDY_AVAILABILITY_UNAVAILABLE" });
    assert.equal(session.store.getStudyActivity().review_count, 1);
  } finally { runtime.dispose(); }
}));

test("old account activity functions are retired synchronously through A to B to A", async () => withClock(async () => {
  const f = accountFixture(); seed(f.server("account-a").store); review(f.server("account-a").store);
  const runtime = createAccountRuntime(f.options);
  try {
    const a = await runtime.connect(); const old = a.store.getStudyActivity;
    assert.equal(old().review_count, 1);
    f.setPrincipal("account-b"); const b = await runtime.connect();
    assert.throws(() => old(), { code: "ACCOUNT_CHANGED" });
    assert.equal(b.store.getStudyActivity().review_count, 0);
    f.setPrincipal("account-a"); const next = await runtime.connect();
    assert.throws(() => old(), { code: "ACCOUNT_CHANGED" });
    assert.equal(next.store.getStudyActivity().review_count, 1);
  } finally { runtime.dispose(); }
}));

for (const sink of ["read", "copy"]) {
  test(`account invalidation during the activity ${sink} suppresses the result`, async () => withClock(async () => {
    const f = accountFixture(); seed(f.server("account-a").store); review(f.server("account-a").store);
    let revoke = false;
    const runtime = createAccountRuntime({ ...f.options, async hydrateSnapshot(data) {
      const model = await f.options.hydrateSnapshot(data);
      return { ...model, reads: { ...model.reads, getStudyActivity(args) {
        const result = model.reads.getStudyActivity(args);
        if (revoke && sink === "read") runtime.invalidate();
        if (revoke && sink === "copy") Object.defineProperty(result, "review_count", { enumerable: true, get() { runtime.invalidate(); return 1; } });
        return result;
      } } };
    } });
    try { const session = await runtime.connect(); revoke = true; assert.throws(() => session.store.getStudyActivity(), { code: "ACCOUNT_CHANGED" }); }
    finally { runtime.dispose(); }
  }));
}

test("a known newer revision retires both readers before hydration and failed hydration cannot restore them", async () => withClock(async () => {
  const f = accountFixture(); const server = f.server("account-a").store; seed(server); review(server);
  const initial = f.snapshot(); const entered = deferred(), pause = deferred(); let failNew = true;
  const runtime = createAccountRuntime({ ...f.options, async hydrateSnapshot(data) {
    if (data.durable_revision > initial.durable_revision && failNew) { entered.resolve(); await pause.promise; throw new Error("newer hydrate failed"); }
    return f.options.hydrateSnapshot(data);
  } });
  try {
    const session = await runtime.connect(); review(server, "activity", "second");
    const pending = session.refresh(); const rejected = assert.rejects(pending, /newer hydrate failed/);
    await entered.promise;
    assert.throws(() => session.store.getStudyActivity(), { code: "STUDY_ACTIVITY_UNAVAILABLE" });
    assert.throws(() => session.store.getStudyAvailability(), { code: "STUDY_AVAILABILITY_UNAVAILABLE" });
    pause.resolve(); await rejected;
    f.setLoadHook(() => initial);
    await assert.rejects(session.refresh(), { code: "STALE_ACCOUNT_SNAPSHOT" });
    assert.throws(() => session.store.getStudyActivity(), { code: "STUDY_ACTIVITY_UNAVAILABLE" });
    failNew = false; f.setLoadHook(null); await session.refresh();
    assert.equal(session.store.getStudyActivity().review_count, 2);
  } finally { pause.resolve(); runtime.dispose(); }
}));

test("a newer response from a superseded refresh still removes older activity authority", async () => withClock(async () => {
  const f = accountFixture(); const server = f.server("account-a").store; seed(server); review(server);
  const initial = f.snapshot(); const arrived = deferred(), pause = deferred();
  const runtime = createAccountRuntime(f.options);
  try {
    const session = await runtime.connect(); review(server, "activity", "second"); const newer = f.snapshot();
    f.setLoadHook(async () => { arrived.resolve(); await pause.promise; return newer; });
    const pending = session.refresh(); const rejected = assert.rejects(pending, { code: "STALE_ACCOUNT_SNAPSHOT" }); await arrived.promise;
    f.setLoadHook(() => initial); await session.refresh();
    assert.equal(session.store.getStudyActivity().review_count, 1);
    pause.resolve(); await rejected;
    assert.throws(() => session.store.getStudyActivity(), { code: "STUDY_ACTIVITY_UNAVAILABLE" });
    assert.throws(() => session.store.getStudyAvailability(), { code: "STUDY_AVAILABILITY_UNAVAILABLE" });
    f.setLoadHook(() => newer); await session.refresh();
    assert.equal(session.store.getStudyActivity().review_count, 2);
  } finally { pause.resolve(); runtime.dispose(); }
}));

test("superseded delayed hydration cannot replace newer adopted activity", async () => withClock(async () => {
  const f = accountFixture(); const server = f.server("account-a").store; seed(server, "activity", 3); review(server);
  const entered = deferred(), pause = deferred(); let delayRevision = null;
  const runtime = createAccountRuntime({ ...f.options, async hydrateSnapshot(data) {
    if (data.durable_revision === delayRevision) { entered.resolve(); await pause.promise; }
    return f.options.hydrateSnapshot(data);
  } });
  try {
    const session = await runtime.connect(); review(server, "activity", "second"); delayRevision = f.snapshot().durable_revision;
    const pending = session.refresh(); await entered.promise;
    review(server, "activity", "third"); const revision = await session.refresh();
    assert.equal(session.store.getStudyActivity().review_count, 3);
    pause.resolve(); assert.equal(await pending, revision);
    assert.equal(session.store.getStudyActivity().review_count, 3);
  } finally { pause.resolve(); runtime.dispose(); }
}));
