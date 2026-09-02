const civilIndex = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;

export function calendarRelativeLabel(value, now = new Date(), formatDate = (date) => date.toLocaleDateString()) {
  if (!value) return "Never studied";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Never studied";
  const days = civilIndex(now) - civilIndex(date);
  if (days === 0) return "Studied today";
  if (days === 1) return "Studied yesterday";
  if (days > 1 && days < 7) return `Studied ${days} days ago`;
  return `Studied ${formatDate(date)}`;
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
