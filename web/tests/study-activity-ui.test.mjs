import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStorage, createStudyStore } from "../js/store.js";
import { withApp } from "./helpers/app-harness.mjs";
import { accountFixture, deferred } from "./helpers/account-fixture.mjs";
import { KEY, SEARCH, CATALOG_OPTIONS, withClock, fixture, seed, start, gradeInput, review, rewrite, wake } from "./helpers/activity-consumer-fixture.mjs";

const activity = (view) => view.querySelector("[data-study-activity]");
async function mount(f, callback, options = {}) {
  await withApp({ storage: f.storage, search: SEARCH, catalogOptions: CATALOG_OPTIONS, ...options }, callback);
  assert.equal(f.storage.getItem(KEY), "normal-learner-state-untouched");
}

test("the actual Home renders all 210 retained reviews, not 192 capped feed entries, before and after reload", async () => withClock(async () => {
  const f = fixture();
  for (let d = 0; d < 5; d++) {
    const id = `activity${d}`; seed(f.store, id, 42);
    let current = start(f.store, id, 42);
    for (let i = 0; i < 42; i++) {
      const result = f.store.submitGrade(gradeInput(current, `${id}:${i}`));
      current = { session: result.session, current_card: result.next_card };
    }
  }
  assert.equal(f.store.getSnapshot().activity.filter((event) => event.type === "grade_submitted").length, 192);
  const before = f.scoped.getItem(KEY);
  for (let load = 0; load < 2; load++) await mount(f, async ({ view, errors }) => {
    assert.match(activity(view).textContent, /210 recorded reviews/);
    assert.doesNotMatch(activity(view).textContent, /192|example reviews/);
    assert.equal(view.querySelectorAll("[data-activity-date]").length, 7);
    assert.equal(view.querySelectorAll('[data-level="4"]').length, 1);
    assert.doesNotMatch(activity(view).textContent, /PRIVATE_/);
    assert.deepEqual(errors, []);
  });
  assert.equal(f.scoped.getItem(KEY), before);
}));

test("weighted examples stay separate and seven unweighted legacy demo events receive no invented weights", async () => withClock(async (clock) => {
  const f = fixture(); seed(f.store); review(f.store);
  rewrite(f.scoped, (raw) => {
    raw.activity.push({ type: "demo_review_activity", at: new Date(clock.now()).toISOString(), reviewCount: 9 });
    for (let i = 0; i < 7; i++) raw.activity.push({ type: "demo_review_activity", at: new Date(clock.now() - i * 86_400_000).toISOString() });
  });
  const before = f.scoped.getItem(KEY);
  await mount(f, async ({ view }) => {
    const panel = activity(view);
    assert.match(panel.textContent, /1 recorded review/);
    assert.match(panel.querySelector("[data-activity-examples]").textContent, /9 example reviews · counted separately/);
    assert.equal(panel.dataset.historyStatus, "partial");
    assert.match(panel.textContent, /Partial retained history.*Lifetime completeness unknown/s);
    assert.equal(panel.querySelectorAll('[data-level="1"]').length, 1, "example weights cannot brighten the real-review series");
    assert.equal(panel.querySelectorAll('[data-level="4"]').length, 0);
    const day = panel.querySelector('[data-level="1"]');
    assert.match(day.getAttribute("aria-label"), /1 recorded review; 9 example reviews, counted separately/);
    assert.doesNotMatch(panel.textContent, /10 recorded|28 recorded|lifetime total|missing \d+ reviews/i);
  });
  assert.equal(f.scoped.getItem(KEY), before);
}));

test("only old unweighted demo events render zero recorded and zero examples, not a guessed demo chart", async () => withClock(async (clock) => {
  const f = fixture(); seed(f.store);
  rewrite(f.scoped, (raw) => { raw.activity = Array.from({ length: 7 }, (_, i) => ({
    type: "demo_review_activity", at: new Date(clock.now() - i * 86_400_000).toISOString(),
  })); });
  await mount(f, async ({ view }) => {
    assert.match(activity(view).textContent, /0 recorded reviews/);
    assert.equal(activity(view).querySelector("[data-activity-examples]"), null);
    assert.equal(activity(view).querySelectorAll('[data-level="0"]').length, 7);
    assert.equal(activity(view).dataset.historyStatus, "partial");
  });
}));

test("legacy timing diagnostics cover all retained history, not the displayed week's actual review total", async () => withClock(async () => {
  const f = fixture(); seed(f.store); const result = review(f.store);
  rewrite(f.scoped, (raw) => {
    const completed = raw.sessions[result.receipt.session.session_id];
    raw.sessions.legacy = { ...completed, id: "legacy", reviewsApplied: 2, history: [
      { transition: "applied", cardId: "activity.term0", at: "2026-07-01T12:00:00.000Z", rating: "good" },
      { transition: "applied", cardId: "activity.term0", at: "2026-09-02T12:00:00.000Z", rating: "good" },
    ] };
  });
  const before = f.scoped.getItem(KEY);
  await mount(f, async ({ view }) => {
    assert.match(activity(view).textContent, /1 recorded review/);
    assert.match(activity(view).querySelector("[data-activity-legacy]").textContent,
      /2 legacy entries across all retained history use scheduled times, not actual review times/);
    assert.match(activity(view).textContent, /Partial retained history/);
  });
  assert.equal(f.scoped.getItem(KEY), before);
}));

test("archived-only Home retains recorded activity with no active decks and no recent events", async () => withClock(async () => {
  const f = fixture(); seed(f.store); review(f.store);
  f.store.setDeckArchived({ deck_id: "activity", archived: true,
    expected_revision: f.store.getSnapshot().personalDecks.activity.revision, client_action_id: "archive:activity" });
  rewrite(f.scoped, (raw) => { raw.activity = []; });
  const before = f.scoped.getItem(KEY);
  await mount(f, async ({ view, errors }) => {
    assert.match(view.textContent, /Your next session starts with a deck/);
    assert.match(activity(view).textContent, /1 recorded review/);
    assert.ok(view.querySelector(".activity-history-panel"));
    assert.equal(view.querySelector("[data-start-deck]"), null);
    assert.deepEqual(errors, []);
  });
  assert.equal(f.scoped.getItem(KEY), before);
}));

test("a genuine empty history renders an available zero without claiming lifetime completeness", async () => withClock(async () => {
  const f = fixture();
  await mount(f, async ({ view }) => {
    assert.equal(activity(view).dataset.studyActivity, "available");
    assert.match(activity(view).textContent, /0 recorded reviews.*Lifetime completeness unknown/s);
    assert.equal(activity(view).querySelectorAll('[data-level="0"]').length, 7);
  });
  assert.equal(f.scoped.getItem(KEY), null, "rendering an empty history does not create learner state");
}));

for (const failure of ["missing", "throws", "async-rejection", "wrong-revision", "bad-total", "invalid-date"]) {
  test(`activity ${failure} is unavailable without disabling readiness or starting a fatal workspace`, async () => withClock(async () => {
    const f = accountFixture(); seed(f.server("account-a").store);
    const options = { ...f.options, async hydrateSnapshot(data) {
      const model = await f.options.hydrateSnapshot(data);
      const read = failure === "missing" ? undefined : (args) => {
        if (failure === "throws") throw new Error("Synthetic activity failure");
        if (failure === "async-rejection") return Promise.reject(new Error("Not a synchronous projection"));
        const value = model.reads.getStudyActivity(args);
        if (failure === "wrong-revision") value.app_revision++;
        if (failure === "bad-total") value.review_count = 17;
        if (failure === "invalid-date") value.days[0].date = "2026-02-30";
        return value;
      };
      return { ...model, reads: { ...model.reads, getStudyActivity: read } };
    } };
    await withApp({ accountOptions: options, catalogOptions: CATALOG_OPTIONS }, async ({ view, click, flush, errors }) => {
      assert.equal(activity(view).dataset.studyActivity, "unavailable");
      assert.match(activity(view).textContent, /Activity unavailable/);
      assert.doesNotMatch(activity(view).textContent, /0 recorded|example review/);
      assert.equal(activity(view).querySelectorAll("[data-activity-date]").length, 0);
      assert.match(view.textContent, /2\s*new cards ready/);
      click('[data-start-deck="activity"]'); await flush();
      assert.ok(view.querySelector("[data-study-card-scene]"));
      assert.deepEqual(errors, []);
    });
  }));
}

test("Home labels returned civil dates in the reader's zone without a browser-zone weekday shift", async () => withClock(async () => {
  const f = accountFixture(); seed(f.server("account-a").store); review(f.server("account-a").store);
  const options = { ...f.options, async hydrateSnapshot(data) {
    const reader = createStudyStore({ catalog: [], storage: createMemoryStorage({ [KEY]: data.state_json }), timeZone: "Pacific/Kiritimati" });
    return { kind: "confirmed-account-read-model.v1", snapshot: reader.getSnapshot(), reads: {
      getStudyAvailability: (args) => reader.getStudyAvailability(args), getStudyActivity: (args) => reader.getStudyActivity(args),
    } };
  } };
  await withApp({ accountOptions: options, catalogOptions: CATALOG_OPTIONS }, async ({ view }) => {
    const panel = activity(view);
    assert.equal(panel.dataset.activityZone, "Pacific/Kiritimati");
    const days = panel.querySelectorAll("[data-activity-date]");
    assert.equal(days.at(-1).dataset.activityDate, "2026-09-01");
    assert.equal(days.at(-1).textContent, "T", "September 1 is Tuesday even when the browser is still Monday");
    assert.match(days.at(-1).getAttribute("aria-label"), /2026-09-01: 1 recorded review/);
  });
}));

test("one canonical activity read per Home render, no read on My Decks and no transport operation for the getter", async () => withClock(async () => {
  const f = accountFixture(); seed(f.server("account-a").store);
  const calls = [];
  const options = { ...f.options, async hydrateSnapshot(data) {
    const model = await f.options.hydrateSnapshot(data);
    return { ...model, reads: { ...model.reads, getStudyActivity(args) { calls.push(args); return model.reads.getStudyActivity(args); } } };
  } };
  await withApp({ accountOptions: options, catalogOptions: CATALOG_OPTIONS }, async ({ navigate }) => {
    assert.deepEqual(calls, [{ days: 7 }]);
    await navigate("#decks"); assert.equal(calls.length, 1);
    await navigate("#study"); assert.deepEqual(calls, [{ days: 7 }, { days: 7 }]);
    assert.deepEqual(f.calls, []);
  });
}));

test("a backward clock excludes later-today history until its saved instant, without changing recorded bytes", async () => withClock(async (clock) => {
  const f = fixture(); seed(f.store); review(f.store);
  const reviewedAt = clock.now(); clock.advance(-1000);
  await mount(f, async ({ view, window, flush }) => {
    const before = f.scoped.getItem(KEY);
    assert.match(activity(view).textContent, /0 recorded reviews/);
    clock.advance(1000); await wake(window, flush);
    assert.match(activity(view).textContent, /1 recorded review/);
    assert.equal(activity(view).dataset.activityAsOf, new Date(reviewedAt).toISOString());
    assert.equal(f.scoped.getItem(KEY), before);
  });
}));

test("offline account wake reprojects still-confirmed day/window counts instead of freezing the old chart", async () => withClock(async (clock) => {
  const f = accountFixture(); seed(f.server("account-a").store); review(f.server("account-a").store);
  await withApp({ accountOptions: f.options, catalogOptions: CATALOG_OPTIONS }, async ({ view, window, flush, errors }) => {
    assert.match(activity(view).textContent, /1 recorded review/);
    const before = f.snapshot().state_json;
    f.setLoadHook(() => { throw new Error("Synthetic ordinary offline failure"); });
    clock.advance(8 * 86_400_000); await wake(window, flush);
    assert.equal(activity(view).dataset.studyActivity, "available");
    assert.match(activity(view).textContent, /0 recorded reviews/);
    assert.equal(activity(view).dataset.activityAsOf, new Date(clock.now()).toISOString());
    assert.equal(f.snapshot().state_json, before);
    assert.deepEqual(errors, []);
  });
}));

test("a known newer account revision with failed hydration makes activity unavailable, not offline stale counts", async () => withClock(async () => {
  const f = accountFixture(); seed(f.server("account-a").store); review(f.server("account-a").store);
  let broken = false;
  const options = { ...f.options, async hydrateSnapshot(data) {
    if (broken) throw new Error("Synthetic newer hydration failure");
    return f.options.hydrateSnapshot(data);
  } };
  await withApp({ accountOptions: options, catalogOptions: CATALOG_OPTIONS }, async ({ view, window, flush, errors }) => {
    assert.match(activity(view).textContent, /1 recorded review/);
    seed(f.server("account-a").store, "newer"); broken = true;
    await wake(window, flush);
    assert.equal(activity(view).dataset.studyActivity, "unavailable");
    assert.doesNotMatch(activity(view).textContent, /1 recorded|0 recorded/);
    assert.match(view.textContent, /check availability/);
    assert.deepEqual(errors, []);
  });
}));

test("an idle local-midnight timer reprojects account activity after an ordinary offline failure, without a wake", async () => withClock(async (clock) => {
  const f = accountFixture(); seed(f.server("account-a").store); review(f.server("account-a").store);
  await withApp({ accountOptions: f.options, catalogOptions: CATALOG_OPTIONS }, async ({ view, flush }) => {
    const before = f.snapshot().state_json;
    const initialDate = activity(view).querySelectorAll("[data-activity-date]").at(-1).dataset.activityDate;
    f.setLoadHook(() => { throw new Error("Offline at midnight"); });
    clock.advance(61_000); await flush(61_000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await flush();
    assert.equal(activity(view).dataset.studyActivity, "available");
    const lastDate = activity(view).querySelectorAll("[data-activity-date]").at(-1).dataset.activityDate;
    assert.equal(initialDate, "2026-08-31");
    assert.equal(lastDate, "2026-09-01");
    assert.match(activity(view).textContent, /1 recorded review/);
    assert.equal(f.snapshot().state_json, before);
  });
}, new Date(2026, 7, 31, 23, 59, 0).toISOString()));

test("a delayed clock refresh from account A cannot repaint A activity after account B connects", async () => withClock(async () => {
  const f = accountFixture(); seed(f.server("account-a").store); review(f.server("account-a").store);
  const arrived = deferred(), pause = deferred();
  await withApp({ accountOptions: f.options, catalogOptions: CATALOG_OPTIONS }, async ({ view, window, flush, application, errors }) => {
    assert.match(activity(view).textContent, /1 recorded review/);
    f.setLoadHook(async (binding) => { const old = f.snapshot(binding); arrived.resolve(); await pause.promise; return old; });
    for (const fn of window.listeners.get("focus") ?? []) fn();
    await arrived.promise;
    f.setPrincipal("account-b"); f.setLoadHook(null); await application.reconnect();
    assert.match(activity(view).textContent, /0 recorded reviews/);
    pause.resolve(); for (let i = 0; i < 20; i++) await Promise.resolve(); await flush();
    assert.match(activity(view).textContent, /0 recorded reviews/);
    assert.doesNotMatch(view.textContent, /1 recorded review|Activity activity/);
    assert.deepEqual(errors, []);
  });
}));

test("account invalidation inside activity projection cannot paint old Home markup", async () => withClock(async () => {
  const f = accountFixture(); seed(f.server("account-a").store); review(f.server("account-a").store);
  let controller, revoke = false;
  const options = { ...f.options,
    createStorageController(config) { controller = f.options.createStorageController(config); return controller; },
    async hydrateSnapshot(data) {
      const model = await f.options.hydrateSnapshot(data);
      return { ...model, reads: { ...model.reads, getStudyActivity(args) {
        const value = model.reads.getStudyActivity(args);
        if (revoke) controller.beginEpoch();
        return value;
      } } };
    },
  };
  await withApp({ accountOptions: options, catalogOptions: CATALOG_OPTIONS }, async ({ view, window, flush, errors }) => {
    assert.match(activity(view).textContent, /1 recorded review/);
    revoke = true; await wake(window, flush);
    assert.match(view.textContent, /Account access paused/);
    assert.equal(activity(view), null);
    assert.doesNotMatch(view.textContent, /1 recorded review|Activity activity/);
    assert.deepEqual(errors, []);
  });
}));

test("committed account reveal survives an offline wake; failed and replayed grades add no activity", async () => withClock(async (clock) => {
  const f = accountFixture(); const server = f.server("account-a").store; seed(server);
  const current = start(server); const input = gradeInput(current);
  await withApp({ accountOptions: f.options, catalogOptions: CATALOG_OPTIONS, hash: `#session/${current.session.session_id}` }, async ({ view, execute, window, flush, navigate }) => {
    assert.equal((await execute("submit_grade", { ...input, expected_card_revision: 999 })).ok, false);
    assert.equal(server.getStudyActivity().review_count, 0);
    const scene = view.querySelector("[data-study-card-scene]");
    assert.equal((await execute("submit_grade", input)).ok, true);
    assert.equal(scene.classList.contains("is-flipped"), true);
    f.setLoadHook(() => { throw new Error("Offline during reveal"); });
    clock.advance(300); await wake(window, () => flush(300));
    assert.equal(view.querySelector("[data-study-card-scene]"), scene);
    f.setLoadHook(null); clock.advance(1600); await flush(1600);
    await navigate("#study");
    assert.match(activity(view).textContent, /1 recorded review/);
    assert.equal((await execute("submit_grade", input)).data.receipt.replayed, true);
    await flush();
    assert.match(activity(view).textContent, /1 recorded review/);
    assert.equal(server.getStudyActivity().review_count, 1);
  });
}));
