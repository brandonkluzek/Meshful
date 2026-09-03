const DAY_MS = 86_400_000;
const LOCAL_CIVIL_VERSION = "local-civil-v1";

// These helpers consume RAW saved streak state, never a prior display projection.
// The old top-level counters remain UTC evidence; no activity log is reconstructed.
export function projectStreak(saved, at, { timeZone } = {}) {
  const copy = cloneSaved(saved);
  const legacyUtc = counters(copy);
  const instant = asDate(at);
  const current = civilContext(instant, timeZone);
  const local = readLocal(copy);
  if (!local) {
    return {
      ...copy,
      current: unexpiredCount(legacyUtc, instant.toISOString().slice(0, 10)),
      trackingBasis: "legacy-utc",
      legacyUtc,
      timeZone: "UTC",
      recordedTimeZone: "UTC",
      timeZoneChanged: false,
    };
  }

  const timeZoneChanged = canonicalTimeZone(local.timeZone) !== current.timeZone;
  return {
    ...copy,
    current: timeZoneChanged ? 0 : unexpiredCount(local, current.day),
    longest: local.longest,
    lastActivityDate: local.lastActivityDate,
    trackingBasis: LOCAL_CIVIL_VERSION,
    legacyUtc,
    timeZone: current.timeZone,
    recordedTimeZone: local.timeZone,
    timeZoneChanged,
  };
}

// Only call for a newly committed grade, not receipt replay or a read. A first
// local grade starts at one, independently of all preserved legacy UTC counts.
export function recordLocalStreak(saved, at, { timeZone } = {}) {
  const copy = cloneSaved(saved);
  counters(copy);
  const today = civilContext(asDate(at), timeZone);
  const local = readLocal(copy);
  let current = 1;
  if (local && canonicalTimeZone(local.timeZone) === today.timeZone) {
    const elapsed = dayDifference(today.day, local.lastActivityDate);
    if (elapsed === 0) current = Math.max(1, local.current);
    else if (elapsed === 1) current = local.current + 1;
  }
  // A changed zone cannot establish continuity from a date label alone. Reset
  // prospectively on this grade; retain the prior proven local longest count.
  assertCounter(current, "current");
  copy.localCivil = {
    ...(local ?? {}),
    version: LOCAL_CIVIL_VERSION,
    current,
    longest: Math.max(local?.longest ?? 0, current),
    lastActivityDate: today.day,
    timeZone: today.timeZone,
  };
  return copy;
}

function cloneSaved(saved) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
    throw new TypeError("saved streak must be an object");
  }
  return structuredClone(saved);
}

function counters(value) {
  assertCounter(value.current, "current");
  assertCounter(value.longest, "longest");
  if (value.lastActivityDate !== null) dayIndex(value.lastActivityDate);
  return {
    current: value.current,
    longest: value.longest,
    lastActivityDate: value.lastActivityDate,
  };
}

function readLocal(saved) {
  if (!Object.hasOwn(saved, "localCivil")) return null;
  const local = saved.localCivil;
  if (!local || typeof local !== "object" || Array.isArray(local)
    || local.version !== LOCAL_CIVIL_VERSION) {
    throw new RangeError("Unsupported local civil streak record");
  }
  counters(local);
  if (typeof local.timeZone !== "string") {
    throw new RangeError("Recorded local streak requires an IANA time zone");
  }
  return local;
}

function assertCounter(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Streak ${name} must be a nonnegative safe integer`);
  }
}

function asDate(at) {
  if (!(at instanceof Date) && typeof at !== "string" && typeof at !== "number") {
    throw new TypeError("at must be a Date or timestamp");
  }
  const date = new Date(at instanceof Date ? at.getTime() : at);
  if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid streak timestamp");
  return date;
}

function civilFormatter(timeZone) {
  if (timeZone !== undefined
    && (typeof timeZone !== "string" || !timeZone || /^[+-]/.test(timeZone))) {
    throw new RangeError("timeZone must name an IANA time zone");
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    era: "short",
  });
}

function canonicalTimeZone(timeZone) {
  return civilFormatter(timeZone).resolvedOptions().timeZone;
}

function civilContext(at, timeZone) {
  const formatter = civilFormatter(timeZone);
  const parts = Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, value]));
  if (parts.era !== "AD") throw new RangeError("Unsupported civil streak year");
  const day = `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`;
  dayIndex(day);
  return { day, timeZone: formatter.resolvedOptions().timeZone };
}

function dayIndex(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new RangeError("Streak day must be a YYYY-MM-DD civil date");
  }
  const date = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
    throw new RangeError("Invalid streak civil date");
  }
  return date.getTime() / DAY_MS;
}

function dayDifference(today, previous) {
  return previous === null ? null : dayIndex(today) - dayIndex(previous);
}

function unexpiredCount(saved, today) {
  const elapsed = dayDifference(today, saved.lastActivityDate);
  return elapsed === 0 || elapsed === 1 ? saved.current : 0;
}
