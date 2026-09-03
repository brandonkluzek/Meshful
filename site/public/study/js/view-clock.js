const civilIndex = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;

export function calendarRelativeLabel(value, now = new Date()) {
  if (!value) return "Not studied yet";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Not studied yet";
  const days = civilIndex(now) - civilIndex(date);
  const elapsed = now.valueOf() - date.valueOf();
  if (days < 0 || elapsed < 0) return "Last studied time unavailable";
  if (days === 0 && elapsed >= 0 && elapsed < 5 * 60_000) return "Last studied just now";
  if (days === 0) return "Last studied today";
  if (days === 1) return "Last studied yesterday";
  if (days < 7) return `Last studied ${days} days ago`;
  if (days < 14) return "Last studied a week ago";
  if (days < 30) return `Last studied ${Math.round(days / 7)} weeks ago`;
  if (days < 45) return "Last studied a month ago";
  if (days < 365) return `Last studied ${Math.round(days / 30)} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "Last studied a year ago" : `Last studied ${years} years ago`;
}

// Presentation refresh only: this never writes a review, changes a stored UTC
// day, or derives an exact streak from incomplete historical records.
export function observeViewClock({ onRefresh, eventTarget = globalThis.window, document = globalThis.document,
  now = () => new Date(), schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout } = {}) {
  let stopped = false;
  let timer;
  function arm() {
    cancel(timer);
    const date = now();
    const civilMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).valueOf();
    // Prospective activity uses local civil days; retained legacy streaks still
    // expire on UTC days. Either projection can change while this page is idle.
    // One timer covers both boundaries without changing any stored day keys.
    const utcMidnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
    timer = schedule(refresh, Math.max(25, Math.min(civilMidnight, utcMidnight) - date.valueOf() + 25));
  }
  function refresh() {
    if (stopped) return;
    if (document.visibilityState !== "hidden") onRefresh();
    arm();
  }
  const visible = () => { if (document.visibilityState !== "hidden") refresh(); };
  eventTarget.addEventListener("focus", refresh);
  eventTarget.addEventListener("pageshow", refresh);
  document.addEventListener("visibilitychange", visible);
  arm();
  return () => {
    stopped = true;
    cancel(timer);
    eventTarget.removeEventListener("focus", refresh);
    eventTarget.removeEventListener("pageshow", refresh);
    document.removeEventListener?.("visibilitychange", visible);
  };
}
