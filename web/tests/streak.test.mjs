import test from "node:test";
import assert from "node:assert/strict";

import { projectStreak, recordLocalStreak } from "../js/streak.js";

const CHICAGO = { timeZone: "America/Chicago" };
const EMPTY = Object.freeze({ current: 0, longest: 0, lastActivityDate: null });

function localStreak(overrides = {}) {
  return {
    current: 80,
    longest: 100,
    lastActivityDate: "2026-08-29",
    localCivil: {
      version: "local-civil-v1",
      current: 4,
      longest: 9,
      lastActivityDate: "2026-08-29",
      timeZone: "America/Chicago",
      ...overrides,
    },
  };
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") deepFreeze(child);
  }
  return Object.freeze(value);
}

test("a Chicago day is counted once across UTC midnight", () => {
  const first = recordLocalStreak(EMPTY, "2026-08-29T23:50:00Z", CHICAGO);
  const second = recordLocalStreak(first, "2026-08-30T00:10:00Z", CHICAGO);
  assert.deepEqual(second.localCivil, {
    version: "local-civil-v1", current: 1, longest: 1,
    lastActivityDate: "2026-08-29", timeZone: "America/Chicago",
  });
});

test("two Chicago civil days count separately within one UTC day", () => {
  const first = recordLocalStreak(EMPTY, "2026-08-30T04:55:00Z", CHICAGO);
  const second = recordLocalStreak(first, "2026-08-30T05:05:00Z", CHICAGO);
  assert.equal(first.localCivil.lastActivityDate, "2026-08-29");
  assert.equal(second.localCivil.lastActivityDate, "2026-08-30");
  assert.equal(second.localCivil.current, 2);
  assert.equal(second.localCivil.longest, 2);
});

for (const [label, firstAt, nextAt, firstDay, nextDay] of [
  ["spring DST: 23-hour day", "2026-03-08T06:05:00Z", "2026-03-09T05:05:00Z", "2026-03-08", "2026-03-09"],
  ["fall DST: 25-hour day", "2026-11-01T05:05:00Z", "2026-11-02T06:05:00Z", "2026-11-01", "2026-11-02"],
]) {
  test(`${label} still advances by one civil day`, () => {
    const first = recordLocalStreak(EMPTY, firstAt, CHICAGO);
    const next = recordLocalStreak(first, nextAt, CHICAGO);
    assert.equal(first.localCivil.lastActivityDate, firstDay);
    assert.equal(next.localCivil.lastActivityDate, nextDay);
    assert.equal(next.localCivil.current, 2);
    assert.equal(projectStreak(first, nextAt, CHICAGO).current, 1);
  });
}

test("the repeated fall DST hour cannot add a second day", () => {
  const first = recordLocalStreak(EMPTY, "2026-11-01T06:30:00Z", CHICAGO);
  const repeated = recordLocalStreak(first, "2026-11-01T07:30:00Z", CHICAGO);
  assert.deepEqual(repeated.localCivil, first.localCivil);
});

test("local projection keeps today/yesterday grace then expires without changing raw counts", () => {
  const saved = deepFreeze(localStreak());
  const before = JSON.stringify(saved);
  const sameDay = projectStreak(saved, "2026-08-30T04:59:00Z", CHICAGO);
  const yesterday = projectStreak(saved, "2026-08-31T04:59:00Z", CHICAGO);
  const expired = projectStreak(saved, "2026-08-31T05:00:00Z", CHICAGO);
  assert.equal(sameDay.current, 4);
  assert.equal(yesterday.current, 4);
  assert.equal(expired.current, 0);
  assert.equal(expired.longest, 9);
  assert.equal(expired.lastActivityDate, "2026-08-29");
  assert.equal(expired.trackingBasis, "local-civil-v1");
  assert.deepEqual(expired.localCivil, saved.localCivil);
  assert.notStrictEqual(expired.localCivil, saved.localCivil);
  assert.deepEqual(expired.legacyUtc, { current: 80, longest: 100, lastActivityDate: "2026-08-29" });
  assert.equal(JSON.stringify(saved), before);
});

test("legacy projection expires by UTC days and does not reinterpret dates in the supplied local zone", () => {
  const saved = deepFreeze({ current: 8, longest: 15, lastActivityDate: "2026-08-29" });
  const before = JSON.stringify(saved);
  assert.equal(projectStreak(saved, "2026-08-29T23:59:00Z", CHICAGO).current, 8);
  assert.equal(projectStreak(saved, "2026-08-30T23:59:00Z", CHICAGO).current, 8);
  const expired = projectStreak(saved, "2026-08-31T00:00:00Z", CHICAGO);
  assert.equal(expired.current, 0);
  assert.equal(expired.longest, 15);
  assert.equal(expired.timeZone, "UTC");
  assert.equal(expired.recordedTimeZone, "UTC");
  assert.equal(expired.timeZoneChanged, false);
  assert.equal(expired.trackingBasis, "legacy-utc");
  assert.deepEqual(expired.legacyUtc, saved);
  assert.equal(Object.hasOwn(expired, "localCivil"), false);
  assert.deepEqual(expired, projectStreak(saved, "2026-08-31T00:00:00Z", { timeZone: "Asia/Tokyo" }));
  assert.equal(JSON.stringify(saved), before);
});

test("the first prospective local grade starts at one and preserves legacy bytes and extra evidence", () => {
  const saved = deepFreeze({
    current: 80, longest: 100, lastActivityDate: "2026-08-30",
    receipt: { id: "unchanged-receipt", committed_at: "2026-08-30T00:01:02.003Z" },
    activity: [{ at: "2026-08-28T23:59:00Z" }, { at: "2026-08-29T23:59:00Z" }],
  });
  const before = JSON.stringify(saved);
  const at = new Date("2026-08-30T04:15:00Z");
  const recorded = recordLocalStreak(saved, at, CHICAGO);
  const { localCivil, ...preserved } = recorded;
  assert.equal(localCivil.current, 1);
  assert.equal(localCivil.longest, 1);
  assert.equal(localCivil.lastActivityDate, "2026-08-29");
  assert.equal(JSON.stringify(preserved), before);
  assert.equal(JSON.stringify(saved), before);
  assert.equal(at.toISOString(), "2026-08-30T04:15:00.000Z");
  assert.notStrictEqual(recorded.receipt, saved.receipt);
  assert.notStrictEqual(recorded.activity, saved.activity);
  const projected = projectStreak(recorded, at, CHICAGO);
  assert.equal(projected.current, 1);
  assert.equal(projected.longest, 1);
  assert.deepEqual(projected.receipt, saved.receipt);
  assert.deepEqual(projected.activity, saved.activity);
  assert.deepEqual(projected.localCivil, localCivil);
  assert.deepEqual(projected.legacyUtc, { current: 80, longest: 100, lastActivityDate: "2026-08-30" });
});

test("same-day grades preserve the count, yesterday increments, and a gap starts at one", () => {
  const saved = localStreak();
  const same = recordLocalStreak(saved, "2026-08-29T20:00:00Z", CHICAGO);
  assert.equal(same.localCivil.current, 4);
  const next = recordLocalStreak(same, "2026-08-30T20:00:00Z", CHICAGO);
  assert.equal(next.localCivil.current, 5);
  const gap = recordLocalStreak(next, "2026-09-02T20:00:00Z", CHICAGO);
  assert.equal(gap.localCivil.current, 1);
  assert.equal(gap.localCivil.longest, 9);
  const longest = recordLocalStreak(localStreak({ current: 9, longest: 9 }), "2026-08-30T20:00:00Z", CHICAGO);
  assert.equal(longest.localCivil.longest, 10);
});

test("calendar boundaries use Gregorian civil dates, including leap days", () => {
  for (const [previous, at, expected] of [
    ["2028-02-28", "2028-02-29T18:00:00Z", "2028-02-29"],
    ["2028-02-29", "2028-03-01T18:00:00Z", "2028-03-01"],
    ["2026-12-31", "2027-01-01T18:00:00Z", "2027-01-01"],
  ]) {
    const recorded = recordLocalStreak(localStreak({ lastActivityDate: previous }), at, CHICAGO);
    assert.equal(recorded.localCivil.lastActivityDate, expected);
    assert.equal(recorded.localCivil.current, 5);
  }
});

test("future saved days do not receive grace or inflate a backdated grade", () => {
  const saved = localStreak({ lastActivityDate: "2026-08-31" });
  assert.equal(projectStreak(saved, "2026-08-30T20:00:00Z", CHICAGO).current, 0);
  const recorded = recordLocalStreak(saved, "2026-08-30T20:00:00Z", CHICAGO);
  assert.equal(recorded.localCivil.current, 1);
  assert.equal(recorded.localCivil.longest, 9);
  assert.equal(recorded.localCivil.lastActivityDate, "2026-08-30");
});

test("a timezone change flags projection uncertainty and restarts only on a new grade", () => {
  const saved = deepFreeze(localStreak());
  const before = JSON.stringify(saved);
  const changedZone = { timeZone: "Asia/Tokyo" };
  const at = "2026-08-29T20:00:00Z";
  const projected = projectStreak(saved, at, changedZone);
  assert.equal(projected.timeZoneChanged, true);
  assert.equal(projected.recordedTimeZone, "America/Chicago");
  assert.equal(projected.timeZone, "Asia/Tokyo");
  assert.equal(projected.current, 0);
  assert.equal(projected.longest, 9);
  assert.deepEqual(projected.localCivil, saved.localCivil);
  assert.equal(JSON.stringify(saved), before);
  const recorded = recordLocalStreak(saved, at, changedZone);
  assert.equal(recorded.localCivil.current, 1);
  assert.equal(recorded.localCivil.longest, 9);
  assert.equal(recorded.localCivil.lastActivityDate, "2026-08-30");
  assert.equal(recorded.localCivil.timeZone, "Asia/Tokyo");
  assert.equal(projectStreak(recorded, at, changedZone).timeZoneChanged, false);
  assert.equal(recorded.current, saved.current);
  assert.equal(recorded.longest, saved.longest);
  assert.equal(recorded.lastActivityDate, saved.lastActivityDate);
});

test("equivalent IANA aliases do not create an ambiguous timezone boundary", () => {
  const saved = localStreak({ timeZone: "US/Central" });
  const projected = projectStreak(saved, "2026-08-30T20:00:00Z", CHICAGO);
  assert.equal(projected.timeZoneChanged, false);
  assert.equal(projected.current, 4);
  assert.equal(recordLocalStreak(saved, "2026-08-30T20:00:00Z", CHICAGO).localCivil.current, 5);
});

test("omitting timeZone uses the runtime local zone and agrees with an explicit selection", () => {
  const at = "2026-08-30T04:15:00Z";
  const runtimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const implicit = recordLocalStreak(EMPTY, at);
  const explicit = recordLocalStreak(EMPTY, at, { timeZone: runtimeZone });
  assert.deepEqual(implicit, explicit);
  assert.equal(implicit.localCivil.timeZone, runtimeZone);
  assert.deepEqual(projectStreak(implicit, at), projectStreak(implicit, at, { timeZone: runtimeZone }));
});

test("empty history has no streak and reads cannot start local tracking", () => {
  const projected = projectStreak(EMPTY, "2026-08-30T20:00:00Z", CHICAGO);
  assert.equal(projected.current, 0);
  assert.equal(projected.longest, 0);
  assert.equal(projected.lastActivityDate, null);
  assert.equal(projected.trackingBasis, "legacy-utc");
  assert.equal(Object.hasOwn(projected, "localCivil"), false);
});

test("invalid dates, counters, zones, and local versions fail without overwriting evidence", () => {
  for (const operate of [projectStreak, recordLocalStreak]) {
    assert.throws(() => operate(EMPTY, "not-a-date", CHICAGO), RangeError);
    assert.throws(() => operate(EMPTY, null, CHICAGO), TypeError);
    assert.throws(() => operate(EMPTY, "2026-08-30T20:00:00Z", { timeZone: "Mars/Olympus" }), RangeError);
    assert.throws(() => operate(EMPTY, "2026-08-30T20:00:00Z", { timeZone: "+01:00" }), RangeError);
    assert.throws(() => operate({ ...EMPTY, lastActivityDate: "2026-02-30" }, "2026-08-30T20:00:00Z", CHICAGO), RangeError);
    assert.throws(() => operate({ ...EMPTY, current: -1 }, "2026-08-30T20:00:00Z", CHICAGO), RangeError);
    const unsupported = deepFreeze(localStreak({ version: "unknown-v2" }));
    const before = JSON.stringify(unsupported);
    assert.throws(() => operate(unsupported, "2026-08-30T20:00:00Z", CHICAGO), RangeError);
    assert.equal(JSON.stringify(unsupported), before);
  }
});
