import test from "node:test";
import assert from "node:assert/strict";
import { createAccountRuntime } from "../js/account-runtime.js";
import { accountFixture, deferred } from "./helpers/account-fixture.mjs";
import { withClock, seed, review } from "./helpers/activity-consumer-fixture.mjs";

// Deliberately injected trusted-JavaScript accessors, not server-JSON payloads
// or evidence of a hosted account leak. All state and transport are disposable.
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const eventTurn = () => new Promise((resolve) => setImmediate(resolve));
const onCopy = (value, callback) => Object.defineProperty(value, "fixture_copy_sink", {
  enumerable: true, get() { callback(); return "injected-only"; },
});

function reviewedFixture() {
  const fixture = accountFixture();
  seed(fixture.server("account-a").store, "activity", 3);
  review(fixture.server("account-a").store);
  return fixture;
}

for (const sink of ["snapshot", "catalog-reference", "availability-capability", "activity-capability"]) {
  test(`${sink} reentry cannot publish a superseded hydration`, { timeout: 5000 }, async () => withClock(async () => {
    const f = reviewedFixture(), entered = deferred(), held = deferred();
    let session, outer, nested, successor, copied = false, observed;
    const reenter = () => {
      if (copied) return;
      copied = true;
      observed = session.store.getSnapshot().revision;
      nested = settle(session.refresh());
      entered.resolve();
    };
    const runtime = createAccountRuntime({ ...f.options, async hydrateSnapshot(data) {
      const model = await f.options.hydrateSnapshot(data);
      if (data.durable_revision !== 20) return model;
      if (sink === "snapshot") return { ...model, snapshot: onCopy({ ...model.snapshot }, reenter) };
      if (sink.endsWith("-capability")) {
        const name = sink.startsWith("availability") ? "getStudyAvailability" : "getStudyActivity";
        const reads = { ...model.reads };
        Object.defineProperty(reads, name, { enumerable: true, get() { reenter(); return model.reads[name]; } });
        return { ...model, reads };
      }
      return model;
    } });
    try {
      session = await runtime.connect();
      const initialAppRevision = session.store.getSnapshot().revision;
      const server = f.server("account-a").store;
      review(server, "activity", "second");
      const older = { ...f.snapshot(), durable_revision: 20, catalog_ref: { ...f.snapshot().catalog_ref } };
      review(server, "activity", "third");
      successor = { ...f.snapshot(), durable_revision: 21 };
      const raw = f.snapshot().state_json;
      if (sink === "catalog-reference") onCopy(older.catalog_ref, reenter);
      let loads = 0, outerState = "pending";
      f.setLoadHook(() => ++loads === 1 ? older : held.promise);
      outer = settle(session.refresh()).then((outcome) => { outerState = outcome.error?.code ?? `resolved:${outcome.value}`; return outcome; });
      await entered.promise; await eventTurn();
      assert.equal(observed, initialAppRevision, "Every copy/accessor sees the previous complete snapshot.");
      assert.equal(outerState, "pending", "Superseded hydration must wait for its held successor.");
      assert.equal(session.store.getSnapshot().revision, initialAppRevision);
      assert.throws(() => session.store.getStudyActivity(), { code: "STUDY_ACTIVITY_UNAVAILABLE" });
      assert.throws(() => session.store.getStudyAvailability(), { code: "STUDY_AVAILABILITY_UNAVAILABLE" });
      held.resolve(successor);
      assert.deepEqual(await outer, { value: 21 });
      assert.deepEqual(await nested, { value: 21 });
      assert.equal(session.store.getStudyActivity().review_count, 3);
      assert.equal(session.store.getStudyActivity().app_revision, session.store.getSnapshot().revision);
      assert.equal(session.store.getStudyAvailability().app_revision, session.store.getSnapshot().revision);
      assert.equal(f.snapshot().state_json, raw);
      assert.deepEqual(f.calls, []);
    } finally {
      held.resolve(successor ?? f.snapshot());
      await Promise.allSettled([outer, nested].filter(Boolean));
      runtime.dispose();
    }
  }));
}

test("failed catalog serialization publishes none of the candidate read model", async () => withClock(async () => {
  const f = reviewedFixture(), runtime = createAccountRuntime(f.options);
  try {
    const session = await runtime.connect();
    const original = session.store.getSnapshot();
    review(f.server("account-a").store, "activity", "second");
    const valid = { ...f.snapshot(), durable_revision: 20 };
    const invalid = { ...valid, catalog_ref: { ...valid.catalog_ref, uncloneable: () => {} } };
    f.setLoadHook(() => invalid);
    await assert.rejects(session.refresh(), { name: "DataCloneError" });
    assert.deepEqual(session.store.getSnapshot(), original, "Cloning failure must not partially adopt the snapshot.");
    assert.throws(() => session.store.getStudyActivity(), { code: "STUDY_ACTIVITY_UNAVAILABLE" });
    assert.throws(() => session.store.getStudyAvailability(), { code: "STUDY_AVAILABILITY_UNAVAILABLE" });
    f.setLoadHook(() => valid);
    assert.equal(await session.refresh(), 20);
    assert.equal(session.store.getStudyActivity().review_count, 2);
    assert.equal(f.snapshot().state_json, valid.state_json);
    assert.deepEqual(f.calls, []);
  } finally { runtime.dispose(); }
}));

test("catalog-copy account invalidation cannot publish or return the retired revision", async () => withClock(async () => {
  const f = reviewedFixture(), runtime = createAccountRuntime(f.options);
  try {
    const session = await runtime.connect();
    review(f.server("account-a").store, "activity", "second");
    const raw = f.snapshot().state_json;
    const data = { ...f.snapshot(), durable_revision: 20, catalog_ref: onCopy({ ...f.snapshot().catalog_ref }, () => runtime.invalidate()) };
    f.setLoadHook(() => data);
    await assert.rejects(session.refresh(), { code: "ACCOUNT_CHANGED" });
    assert.equal(session.isCurrent(), false);
    assert.throws(() => session.store.getSnapshot(), { code: "ACCOUNT_CHANGED" });
    assert.throws(() => session.store.getStudyActivity(), { code: "ACCOUNT_CHANGED" });
    assert.throws(() => session.store.getStudyAvailability(), { code: "ACCOUNT_CHANGED" });
    assert.equal(f.snapshot().state_json, raw);
    assert.deepEqual(f.calls, []);
  } finally { runtime.dispose(); }
}));

test("validated response primitives are not reread after snapshot-copy staging", async () => withClock(async () => {
  const f = reviewedFixture(); let copied = false;
  const lateReads = [];
  const runtime = createAccountRuntime({ ...f.options, async hydrateSnapshot(data) {
    const model = await f.options.hydrateSnapshot(data);
    if (data.durable_revision !== 20) return model;
    return { ...model, snapshot: onCopy({ ...model.snapshot }, () => { copied = true; }) };
  } });
  try {
    const session = await runtime.connect();
    review(f.server("account-a").store, "activity", "second");
    const raw = f.snapshot().state_json, data = { ...f.snapshot(), durable_revision: 20 };
    for (const name of ["durable_revision", "state_json"]) {
      const value = data[name];
      Object.defineProperty(data, name, { enumerable: true, get() { if (copied) lateReads.push(name); return value; } });
    }
    f.setLoadHook(() => data);
    assert.equal(await session.refresh(), 20);
    assert.equal(copied, true);
    assert.deepEqual(lateReads, [], "The publication tail must use validated primitive locals only.");
    assert.equal(session.store.getStudyActivity().review_count, 2);
    assert.equal(f.snapshot().state_json, raw);
    assert.deepEqual(f.calls, []);
  } finally { runtime.dispose(); }
}));
