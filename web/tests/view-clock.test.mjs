import test from "node:test";
import assert from "node:assert/strict";
import { calendarRelativeLabel, observeViewClock } from "../js/view-clock.js";

test("relative study labels use local calendar dates rather than rounded elapsed hours", () => {
  const prior = process.env.TZ;
  process.env.TZ = "America/Chicago";
  try {
    assert.equal(calendarRelativeLabel("2026-08-30T23:58:00-05:00", new Date("2026-08-31T00:02:00-05:00")), "Studied yesterday");
    assert.equal(calendarRelativeLabel("2026-08-30T00:05:00-05:00", new Date("2026-08-30T13:00:00-05:00")), "Studied today");
    assert.equal(calendarRelativeLabel("2026-03-08T00:05:00-06:00", new Date("2026-03-09T00:02:00-05:00")), "Studied yesterday");
    assert.equal(calendarRelativeLabel("2026-11-01T00:05:00-05:00", new Date("2026-11-02T00:02:00-06:00")), "Studied yesterday");
  } finally { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; }
});

test("the view clock rearms at civil midnight and refreshes on focus/pageshow/visibility return", () => {
  let at = new Date(2026, 7, 30, 23, 58), delay, timer, calls = 0;
  const events = new EventTarget();
  const document = new EventTarget(); document.visibilityState = "visible";
  const stop = observeViewClock({ eventTarget: events, document, now: () => at,
    schedule(fn, ms) { timer = fn; delay = ms; return 1; }, cancel() {}, onRefresh() { calls++; } });
  assert.equal(delay, 120025);
  at = new Date(2026, 7, 31, 0, 2); timer();
  assert.equal(calls, 1);
  const utcMidnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  assert.equal(delay, Math.min(86_280_025, utcMidnight - at.valueOf() + 25));
  events.dispatchEvent(new Event("focus"));
  events.dispatchEvent(new Event("pageshow"));
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 3);
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 4);
  stop(); events.dispatchEvent(new Event("focus")); timer();
  assert.equal(calls, 4);
});

test("legacy UTC expiry refreshes before local midnight and then rearms for civil rollover", () => {
  const prior = process.env.TZ;
  process.env.TZ = "America/Chicago";
  let stop;
  try {
    let at = new Date("2026-09-01T18:58:00-05:00"), delay, timer, calls = 0;
    const document = new EventTarget(); document.visibilityState = "visible";
    stop = observeViewClock({ eventTarget: new EventTarget(), document, now: () => at,
      schedule(fn, ms) { timer = fn; delay = ms; return 1; }, cancel() {}, onRefresh() { calls++; } });
    assert.equal(delay, 120025, "UTC midnight arrives five hours before the local one");
    at = new Date("2026-09-01T19:02:00-05:00"); timer();
    assert.equal(calls, 1);
    assert.equal(delay, 17_880_025, "the next applicable boundary is local midnight");
    at = new Date("2026-09-02T00:02:00-05:00"); timer();
    assert.equal(calls, 2);
    assert.equal(delay, 68_280_025, "next UTC midnight remains covered");
  } finally { stop?.(); if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; }
});
