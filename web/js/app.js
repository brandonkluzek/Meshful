import { loadWebsiteLibrary } from "./library-loader.js";
import { presentLibrary, graphForPersonal } from "./library-view.js";
import { renderDefinition } from "./definition-renderer.js";
import { createBrowserWorkspace } from "./browser-workspace.js";
import { createAccountRuntime } from "./account-runtime.js";
import { calendarRelativeLabel, observeViewClock } from "./view-clock.js";
import { mountGraphView } from "./graph-view.js";
import { isDeckFullyMastered } from "./mastery.js";
import {
  createStudyStore,
  createMemoryStorage,
  fsrsFreshnessForReview,
  learnednessForReview,
  StudyStoreError,
} from "./store.js";
import { registerWebMCPTools } from "./webmcp.js";

const view = document.querySelector("[data-view]");
const loading = document.querySelector("[data-loading]");
const deckDialog = document.querySelector("[data-deck-dialog]");
const deckDialogContent = document.querySelector("[data-deck-dialog-content]");
const accountDialog = document.querySelector("[data-account-dialog]");
const settingsDialog = document.querySelector("[data-settings-dialog]");
const toastRegion = document.querySelector("[data-toasts]");
const params = new URLSearchParams(location.search);
const demoMode = params.get("demo");
let workspace = null;
let store = null;
let accountMode = false;
let accountRuntime = null;
let accountSession = null;
let claimPreview = null;
let startupSequence = 0;
let stopClock = null;
let toolRegistration = Promise.resolve();
let registeredToolNames = [];
let library = [];
let catalogSettings = null;
const getCatalogDeck = (id) => library.find((deck) => deck.id === id);

const ui = {
  catalogQuery: "",
  catalogSubject: "All",
  catalogEvidence: "All",
  catalogLimit: 24,
  deckStatus: "active",
  graphCleanup: null,
  graphPulse: null,
  archiveConfirmDeckId: null,
  renderTimer: null,
  revealTimer: null,
  failed: false,
  revealingUntil: 0,
  mutationBusy: false,
  emptyStudyDeckId: null,
  availabilityTimer: null,
};

function captureView() {
  if (!accountMode) return { local: true };
  if (!accountSession) return null;
  try { return { session: accountSession, ticket: accountSession.executionGuard.capture() }; }
  catch { return null; }
}

function isViewCurrent(context) {
  return accountMode ? Boolean(context?.session === accountSession && accountSession?.isCurrent(context.ticket)) : Boolean(context?.local);
}

function invalidateAccountView() {
  accountSession = null;
  store = null;
  workspace = null;
  claimPreview = null;
  ui.failed = true;
  ui.mutationBusy = false;
  ui.graphPulse = null;
  ui.revealingUntil = 0;
  ui.emptyStudyDeckId = null;
  clearTimeout(ui.renderTimer);
  clearTimeout(ui.revealTimer);
  clearTimeout(ui.availabilityTimer);
  stopClock?.();
  stopClock = null;
  ui.graphCleanup?.();
  ui.graphCleanup = null;
  closeOverlayDialogs();
  deckDialogContent.replaceChildren();
  toastRegion.replaceChildren();
  // Display-only wrapper identity must not survive an account boundary either.
  document.querySelector("[data-action='open-account']")?.replaceChildren("Account");
  accountDialog?.replaceChildren();
  settingsDialog?.replaceChildren();
  loading.hidden = true;
  view.hidden = false;
  view.innerHTML = emptyState({ title: "Account access paused", copy: "Reconnect to verify your account. Saved work and recovery data have not been reset.",
    action: '<button class="button button-primary" type="button" data-reconnect-account>Reconnect</button>' });
}

function showAccountSettings() {
  if (!accountSession) return;
  const recovery = accountSession.getRecovery();
  accountDialog.innerHTML = `<div class="account-panel"><div class="dialog-header-compact"><h2 id="account-title">Account</h2><button class="icon-button" type="button" data-close-account aria-label="Close account">×</button></div>
    <p class="account-note">Connected account. Study changes are saved after server confirmation.</p>
    <button class="account-menu-row" type="button" data-open-settings>Settings</button>
    <a class="button button-quiet" data-account-signout href="/signout-with-chatgpt?return_to=%2F" target="_top">Sign out</a></div>`;
  settingsDialog.innerHTML = `<div class="account-panel"><div class="dialog-header-compact"><h2 id="settings-title">Settings</h2><button class="icon-button" type="button" data-close-settings aria-label="Close settings">×</button></div>
    <div class="settings-row"><span>Study data</span><span>Account-backed</span></div>
    <p class="account-note">Browser-only data stays separate. Nothing is imported automatically.</p>
    ${recovery.command ? '<button class="button" type="button" data-retry-account-write>Recover pending save</button>' : ""}
    ${recovery.claim ? '<p class="account-note">An earlier import needs confirmation. Its original backup is retained.</p><button class="button" type="button" data-retry-account-claim>Retry original import</button>' : '<button class="button" type="button" data-preview-local-claim>Copy browser data to this account…</button>'}
    <div data-claim-confirmation></div></div>`;
}

async function uiMutation(method, args, context) {
  if (!isViewCurrent(context)) return null;
  const result = await store[method](args);
  if (!isViewCurrent(context)) return null;
  if (accountMode) {
    try { await context.session.refresh(context.ticket); }
    catch (error) {
      if (isViewCurrent(context)) {
        showFatal(new Error("Your save was confirmed, but the updated view could not load. Reconnect before continuing; do not repeat the action."));
      }
      throw error;
    }
    if (!isViewCurrent(context)) return null;
  }
  return result;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHTML(value).replaceAll("`", "&#096;");
}

function actionId(prefix) {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${id}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value ?? 0));
}

function formatDate(value, fallback = "No activity yet") {
  if (!value) return fallback;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T12:00:00` : value);
  if (!Number.isFinite(date.valueOf())) return fallback;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatRelative(value) {
  return calendarRelativeLabel(value, new Date(), formatDate);
}

function readStudyAvailability(snapshot, deckId = null, blockedLimit = 0) {
  try {
    if (typeof store.getStudyAvailability !== "function") return null;
    const result = store.getStudyAvailability(deckId ? { deck_id: deckId, blocked_limit: blockedLimit } : {});
    if (!result || result.app_revision !== snapshot.revision || !Array.isArray(result.decks)) return null;
    return result;
  } catch {
    // Unknown readiness is not permission to probe by starting an empty queue.
    return null;
  }
}

function deckAvailability(availability, deckId) {
  return availability?.decks.find((deck) => deck.deck_id === deckId) ?? null;
}

function readyCount(availability) {
  return availability ? availability.due_count + availability.eligible_new_count : 0;
}

function nextReviewLabel(value) {
  if (!value || !Number.isFinite(new Date(value).valueOf())) return "";
  return `Next review ${new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(value))}.`;
}

function availabilityLabel(available) {
  if (!available) return "Study availability unavailable. Check again before starting.";
  const parts = [];
  if (available.due_count) parts.push(`${formatNumber(available.due_count)} ${available.due_count === 1 ? "review" : "reviews"} due`);
  if (available.eligible_new_count) parts.push(`${formatNumber(available.eligible_new_count)} new ready`);
  if (available.blocked_new_count) parts.push(`${formatNumber(available.blocked_new_count)} awaiting prerequisites`);
  return parts.length ? parts.join(" · ") : `No reviews due now. ${nextReviewLabel(available.next_due_at) || "No new cards ready."}`;
}

function canStartAvailable(available) {
  if (!available || available.archived) return false;
  return available.resumable_session ? available.resumable_session.can_resume === true : readyCount(available) > 0;
}

function armAvailabilityRefresh(availability, route, snapshot) {
  clearTimeout(ui.availabilityTimer);
  ui.availabilityTimer = null;
  const session = route.name === "session" ? snapshot.sessions?.[route.id] : null;
  if (!["study", "decks"].includes(route.name) && !(session && session.status !== "active")) return;
  const now = Date.now();
  const next = (availability?.decks ?? [])
    .filter((deck) => !deck.archived && (!session || deck.deck_id === session.deckId))
    .map((deck) => new Date(deck.next_due_at ?? "").valueOf())
    .filter((date) => Number.isFinite(date))
    .sort((a, b) => a - b)[0];
  if (!next) return;
  const context = captureView();
  ui.availabilityTimer = setTimeout(() => {
    ui.availabilityTimer = null;
    if (isViewCurrent(context)) queueRender();
  }, Math.max(25, Math.min(2_147_483_647, next - now + 25)));
}

function streakBasisLabel(streak) {
  if (streak?.timeZoneChanged) return "Time zone changed · study to begin a new local streak";
  return streak?.trackingBasis === "legacy-utc" ? "UTC history" : "Local-day streak";
}

function subjectClass(subject) {
  const normalized = String(subject ?? "").toLowerCase();
  if (normalized.includes("math")) return "mathematics";
  if (normalized.includes("physics")) return "physics";
  if (normalized.includes("economic")) return "economics";
  if (normalized.includes("chem")) return "chemistry";
  if (normalized.includes("bio")) return "biology";
  if (normalized.includes("anatom") || normalized.includes("medicine")) return "medicine";
  if (normalized.includes("law")) return "law";
  return "mathematics";
}

function evidenceForDeck(deck) {
  const value = String(
    deck.evidenceTier ??
    deck.evidence_tier ??
    deck.audit?.evidenceTier ??
    "demo_fixture",
  ).toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (["bounded_ready", "bounded", "c5_ready"].includes(value)) {
    return { key: "bounded_ready", label: "Bounded-ready" };
  }
  if (["reviewed_c4", "reviewed_through_c4", "c4_reviewed"].includes(value)) {
    return { key: "reviewed_c4", label: "Reviewed through C4" };
  }
  if (["structural", "structurally_valid", "valid"].includes(value)) {
    return { key: "structural", label: "Structurally valid" };
  }
  if (value === "ai_review_with_second_reader_repairs") {
    return { key: "ai_reviewed", label: "AI-reviewed · second-reader repairs" };
  }
  return { key: "demo_fixture", label: "Demo fixture" };
}

function icon(name) {
  const paths = {
    arrow: '<path d="M4 10h11M11 6l4 4-4 4" />',
    archive: '<rect x="3" y="5" width="14" height="11" rx="2" /><path d="M2.5 3h15v3h-15zM8 9h4" />',
    book: '<path d="M3.5 4.5a2 2 0 0 1 2-2H9v14H5.5a2 2 0 0 0-2 1.5V4.5ZM16.5 4.5a2 2 0 0 0-2-2H11v14h3.5a2 2 0 0 1 2 1.5V4.5Z" />',
    flame: '<path d="M10 17c3.2 0 5.5-2.2 5.5-5.4 0-2.7-1.6-4.8-4.4-7.7.1 2.4-.9 3.8-2 4.8-.3-1.4-1.2-2.4-2.1-3.2.1 2.8-2.5 3.7-2.5 6.4C4.5 15 6.8 17 10 17Z" />',
    graph: '<path d="M4 14 8 9l4 2 4-6" /><circle cx="4" cy="14" r="1.5" /><circle cx="8" cy="9" r="1.5" /><circle cx="12" cy="11" r="1.5" /><circle cx="16" cy="5" r="1.5" />',
    search: '<circle cx="8.5" cy="8.5" r="5" /><path d="m12.3 12.3 3.7 3.7" />',
    stack: '<rect x="4" y="5" width="12" height="10" rx="2" /><path d="M6 3h8M6 17h8" />',
    restore: '<path d="M4 7V3m0 0h4M4 3l3 3a6 6 0 1 1-1.4 6" />',
  };
  return `<svg viewBox="0 0 20 20" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}

function getRoute() {
  const raw = location.hash.replace(/^#/, "") || "study";
  const [name, id] = raw.split("/");
  if (name === "session" && id) return { name, id };
  if (name === "graph" && id) return { name, id };
  if (["study", "decks", "library"].includes(name)) return { name };
  return { name: "study" };
}

function setActiveNav(route) {
  const active = route.name === "session" ? "study" : route.name === "graph" ? "decks" : route.name;
  document.querySelectorAll("[data-nav]").forEach((item) => {
    if (item.dataset.nav === active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  document.body.dataset.route = route.name;
}

function personalDeckArray(snapshot, { archived = false, availability = null } = {}) {
  return Object.values(snapshot.personalDecks ?? {})
    .filter((deck) => Boolean(deck.archived) === archived)
    .sort((a, b) => {
      const left = deckAvailability(availability, a.id);
      const right = deckAvailability(availability, b.id);
      return (right?.due_count ?? 0) - (left?.due_count ?? 0) ||
        (right?.eligible_new_count ?? 0) - (left?.eligible_new_count ?? 0) || a.title.localeCompare(b.title);
    });
}

function metricsForDeck(deck) {
  const cards = (deck.cardOrder ?? Object.keys(deck.cards ?? {}))
    .map((id) => deck.cards[id])
    .filter((card) => card && !card.archived);
  const introduced = cards.filter((card) => Number(card.review?.repetitions ?? 0) > 0);
  const due = cards.filter((card) =>
    Number(card.review?.repetitions ?? 0) > 0 &&
    new Date(card.review?.dueAt ?? 0).valueOf() <= Date.now(),
  );
  const reviewedDates = cards
    .map((card) => card.review?.lastReviewedAt)
    .filter(Boolean)
    .sort();
  const measuredAt = new Date();
  const freshnessValues = introduced.map((card) =>
    fsrsFreshnessForReview(card.review, measuredAt),
  );
  const learnednessValues = cards.map((card) => learnednessForReview(card.review));
  return {
    total: cards.length,
    introduced: introduced.length,
    dueCount: due.length,
    newCount: cards.length - introduced.length,
    freshness: introduced.length
      ? Math.round((freshnessValues.reduce((sum, value) => sum + value, 0) / introduced.length) * 100)
      : 0,
    mastery: cards.length
      ? Math.round((learnednessValues.reduce((sum, value) => sum + value, 0) / cards.length) * 100)
      : 0,
    lastStudied: reviewedDates.at(-1) ?? null,
  };
}

function cardStatesForDeck(deck) {
  return Object.fromEntries(Object.entries(deck.cards ?? {}).map(([id, card]) => [id, {
    reviewCount: card.review?.repetitions ?? 0,
    dueAt: card.review?.dueAt ?? null,
    lastReviewedAt: card.review?.lastReviewedAt ?? null,
  }]));
}

function readStudyActivity(snapshot) {
  try {
    if (typeof store.getStudyActivity !== "function") return null;
    const activity = store.getStudyActivity({ days: 7 });
    const count = (value) => Number.isSafeInteger(value) && value >= 0;
    if (!activity || activity.app_revision !== snapshot.revision || !Array.isArray(activity.days) || activity.days.length !== 7 ||
        !count(activity.review_count) || !count(activity.example_review_count) ||
        typeof activity.as_of !== "string" || !Number.isFinite(new Date(activity.as_of).valueOf()) || typeof activity.time_zone !== "string" ||
        activity.history?.basis !== "retained-review-records" || activity.history.scope !== "all-retained-history" ||
        !["consistent", "partial"].includes(activity.history.status) || activity.history.lifetime_completeness !== "unknown" ||
        !count(activity.history.legacy_timestamp_count) || !Array.isArray(activity.history.issues)) return null;
    new Intl.DateTimeFormat(undefined, { timeZone: activity.time_zone }); // Reject an invalid zone, never guess one.
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "narrow", timeZone: "UTC" });
    let reviews = 0, examples = 0, previousDate = "";
    const days = activity.days.map((day) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || day.date <= previousDate ||
          !count(day.review_count) || !count(day.example_review_count)) throw new Error("Invalid activity day");
      // This UTC surrogate formats a Gregorian civil label only. It is never
      // converted into the browser zone or used to re-bucket review timestamps.
      const civilLabel = new Date(`${day.date}T12:00:00.000Z`);
      if (civilLabel.toISOString().slice(0, 10) !== day.date) throw new Error("Invalid activity date");
      previousDate = day.date;
      reviews += day.review_count;
      examples += day.example_review_count;
      return { ...day, label: weekday.format(civilLabel),
        level: day.review_count === 0 ? 0 : day.review_count === 1 ? 1 : day.review_count < 4 ? 2 : day.review_count < 7 ? 3 : 4 };
    });
    if (reviews !== activity.review_count || examples !== activity.example_review_count) return null;
    return { ...activity, days };
  } catch {
    // Failed or stale evidence is unavailable, not a plausible zero or a recent
    // event/demo/progress fallback. Readiness remains an independent capability.
    return null;
  }
}

function hasExampleProgress(deck) {
  return Object.values(deck.cards ?? {}).some((card) => card.review?.demoSeeded === true);
}

function resumableSessionFor(snapshot, availability) {
  const active = snapshot.sessions?.[availability?.active_session?.session_id];
  if (active?.status === "active" && active.currentCardId) return active;
  const sessions = (availability?.decks ?? [])
    .filter((deck) => deck.resumable_session?.can_resume === true)
    .map((deck) => snapshot.sessions?.[deck.resumable_session.session_id])
    .filter((session) => session?.status === "paused" && session.currentCardId);
  return sessions.find((session) => session.deckId === snapshot.view?.selectedDeckId) ??
    sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || b.id.localeCompare(a.id))[0] ?? null;
}

function activityDay(day) {
  const reviewLabel = `${formatNumber(day.review_count)} recorded ${day.review_count === 1 ? "review" : "reviews"}`;
  const exampleLabel = day.example_review_count ? `; ${formatNumber(day.example_review_count)} example ${day.example_review_count === 1 ? "review" : "reviews"}, counted separately` : "";
  return `<div class="activity-day" data-activity-date="${escapeAttribute(day.date)}" data-level="${day.level}" role="img" aria-label="${escapeAttribute(day.date)}: ${reviewLabel}${exampleLabel}" data-activity-tooltip="${reviewLabel}${exampleLabel}" tabindex="0"><span class="activity-dot" aria-hidden="true"></span><span aria-hidden="true">${escapeHTML(day.label)}</span></div>`;
}

function renderStudyActivity(snapshot, activity) {
  const streak = snapshot.streak;
  return `<div class="activity-module" data-study-activity="${activity ? "available" : "unavailable"}"${activity ? ` data-activity-as-of="${escapeAttribute(activity.as_of)}" data-activity-zone="${escapeAttribute(activity.time_zone)}" data-history-status="${activity.history.status}"` : ""}>
    <div class="activity-heading">
      <div><span>Study activity</span><strong>${activity ? `${formatNumber(activity.review_count)} recorded ${activity.review_count === 1 ? "review" : "reviews"}` : "Activity unavailable"}</strong></div>
      ${streak.current ? `<span class="activity-streak" aria-label="${formatNumber(streak.current)}-day study streak · ${escapeAttribute(streakBasisLabel(streak))}" title="${escapeAttribute(streakBasisLabel(streak))}">${icon("flame")}<strong>${formatNumber(streak.current)}</strong>${streak.trackingBasis === "legacy-utc" ? '<small class="streak-basis">UTC history</small>' : ""}</span>` : streak.timeZoneChanged ? `<small class="streak-basis">${escapeHTML(streakBasisLabel(streak))}</small>` : ""}
    </div>
    ${activity ? `
      <div class="activity-strip" aria-label="Recorded reviews over the last seven days in ${escapeAttribute(activity.time_zone)}">${activity.days.map(activityDay).join("")}</div>
      ${activity.example_review_count ? `<p class="activity-examples" data-activity-examples>${formatNumber(activity.example_review_count)} example ${activity.example_review_count === 1 ? "review" : "reviews"} · counted separately</p>` : ""}
      <p class="activity-coverage">Last 7 days · ${escapeHTML(activity.time_zone)}.<br>${activity.history.status === "partial" ? "Partial retained history; some records need attention." : "Based on retained review records."} Lifetime completeness unknown.</p>
      ${activity.history.legacy_timestamp_count ? `<p class="activity-coverage" data-activity-legacy>${formatNumber(activity.history.legacy_timestamp_count)} legacy ${activity.history.legacy_timestamp_count === 1 ? "entry" : "entries"} across all retained history use scheduled times, not actual review times.</p>` : ""}
    ` : '<p class="activity-coverage">Recorded activity could not be read. Your saved history has not been changed.</p>'}
  </div>`;
}

function renderStudyHome(snapshot, availability) {
  const decks = personalDeckArray(snapshot, { availability });
  const chosenEmpty = snapshot.personalDecks?.[ui.emptyStudyDeckId];
  if (chosenEmpty && !chosenEmpty.archived) {
    return renderStudyNoWork(snapshot, chosenEmpty, readStudyAvailability(snapshot, chosenEmpty.id, 5), null, availability);
  }
  const activity = readStudyActivity(snapshot);
  if (!decks.length) {
    return `
      <section class="page page-compact">
        <div class="study-home-heading">
          <div><p class="eyebrow">Study</p><h1>Your next session starts with a deck.</h1></div>
        </div>
        ${emptyState({
          title: "Build your study queue",
          copy: "Choose a deck from the library to begin.",
          action: '<a class="button button-primary" href="#library">Browse the library</a>',
        })}
        <aside class="activity-history-panel" aria-label="Retained study activity">${renderStudyActivity(snapshot, activity)}</aside>
      </section>`;
  }

  const resumableSession = resumableSessionFor(snapshot, availability);
  const active = resumableSession ? snapshot.personalDecks[resumableSession.deckId]
    : decks.find((deck) => canStartAvailable(deckAvailability(availability, deck.id))) ?? decks[0];
  const activeAvailability = deckAvailability(availability, active.id);
  const activeMetrics = metricsForDeck(active);
  const activeMastered = isDeckFullyMastered(activeMetrics);
  const totalDue = (availability?.decks ?? []).reduce((sum, deck) => sum + deck.due_count, 0);
  const totalNew = (availability?.decks ?? []).reduce((sum, deck) => sum + deck.eligible_new_count, 0);
  const readyLabel = !availability ? "check availability" : totalDue ? totalDue === 1 ? "review due" : "reviews due"
    : totalNew ? totalNew === 1 ? "new card ready" : "new cards ready" : "reviews due";
  return `
    <section class="page">
      <header class="study-home-heading">
        <h1>Study</h1>
      </header>

      <div class="study-hero">
        <div class="study-hero-main">
          <div>
            <p class="eyebrow">${resumableSession || totalDue || totalNew ? "Ready now" : "Study status"}</p>
            <div class="due-number"><strong>${availability ? formatNumber(totalDue || totalNew) : "—"}</strong><span>${readyLabel}</span></div>
          </div>
          <div class="study-hero-copy">
            <div class="study-title-line">
              <h2>${escapeHTML(active.title)}</h2>
              ${activeMastered ? '<span class="mastery-chip">✓ Mastered</span>' : ""}
            </div>
            <p>${resumableSession ? `${resumableSession.cursor} of ${resumableSession.queue.length} complete` : `${activeMetrics.mastery}% mastered · ${escapeHTML(availabilityLabel(activeAvailability))}`}</p>
            <button class="button button-primary" type="button" data-start-deck="${escapeAttribute(active.id)}" ${resumableSession ? `data-resume-session="${escapeAttribute(resumableSession.id)}"` : ""}>
              ${resumableSession ? "Resume session" : canStartAvailable(activeAvailability) ? "Start session" : "View study status"} ${icon("arrow")}
            </button>
          </div>
        </div>
        <aside class="study-hero-side" aria-label="Study progress">
          ${renderStudyActivity(snapshot, activity)}
          <div class="hero-metrics">
            <div class="hero-metric"><span>Mastered</span><strong>${activeMetrics.mastery}%</strong></div>
            <div class="hero-metric"><span>${activeAvailability?.due_count || !activeAvailability?.eligible_new_count ? "Due now" : "New ready"}</span><strong>${activeAvailability ? activeAvailability.due_count || activeAvailability.eligible_new_count : "—"}</strong></div>
          </div>
        </aside>
      </div>

      <div class="section-heading"><h2>Your queue</h2><a href="#decks">View all decks</a></div>
      <div class="deck-queue">
        ${decks.slice(0, 5).map((deck) => queueRow(deck, deckAvailability(availability, deck.id))).join("")}
      </div>
    </section>`;
}

function queueRow(deck, available) {
  const metrics = metricsForDeck(deck);
  const mastered = isDeckFullyMastered(metrics);
  return `
    <article class="queue-row${mastered ? " is-mastered" : ""}">
      <div><h3>${escapeHTML(deck.title)}</h3><p>${mastered ? '<span class="mastery-inline">✓ Mastered</span>' : `${metrics.mastery}% mastered`} · ${hasExampleProgress(deck) ? "Example progress" : formatRelative(metrics.lastStudied)}</p><p>${escapeHTML(availabilityLabel(available))}</p></div>
      <div class="queue-due"><strong>${available ? formatNumber(available.due_count || available.eligible_new_count) : "—"}</strong><span>${available?.due_count || !available?.eligible_new_count ? "due" : "new ready"}</span></div>
      <button class="button button-sm" type="button" data-start-deck="${escapeAttribute(deck.id)}">Study</button>
    </article>`;
}

function renderMyDecks(snapshot, availability) {
  const archived = ui.deckStatus === "archived";
  const decks = personalDeckArray(snapshot, { archived, availability });
  return `
    <section class="page">
      <header class="page-heading page-heading-simple">
        <h1>My Decks</h1>
        <a class="button button-primary" href="#library">Add from library</a>
      </header>
      <div class="filter-bar">
        <div class="filter-pills" aria-label="Deck status">
          <button class="filter-pill" type="button" data-deck-status="active" aria-pressed="${String(!archived)}">Active</button>
          <button class="filter-pill" type="button" data-deck-status="archived" aria-pressed="${String(archived)}">Archived</button>
        </div>
      </div>
      ${decks.length ? `<div class="card-grid">${decks.map((deck) => personalDeckCard(deck, deckAvailability(availability, deck.id))).join("")}</div>` : emptyState({
        title: archived ? "No archived decks" : "Your collection is empty",
        copy: archived ? "Archived decks stay here with their review history intact." : "Add a deck from the library to begin building a personal review history.",
        action: archived ? "" : '<a class="button button-primary" href="#library">Browse library</a>',
      })}
    </section>`;
}

function personalDeckCard(deck, available) {
  const metrics = metricsForDeck(deck);
  const mastered = !deck.archived && isDeckFullyMastered(metrics);
  const confirmingArchive = ui.archiveConfirmDeckId === deck.id;
  const status = deck.archived ? "Archived" : mastered ? "✓ Mastered" : !available ? "Check availability"
    : available.due_count ? `${available.due_count} due` : available.eligible_new_count ? `${available.eligible_new_count} new ready`
      : available.blocked_new_count ? "Prerequisites" : "Scheduled";
  return `
    <article class="deck-card subject-${subjectClass(deck.subject)}${mastered ? " is-mastered" : ""}">
      <div class="card-topline">
        <span>${escapeHTML(deck.subject)}</span>
        <span class="status-pill" data-tone="${mastered ? "mastered" : available?.due_count ? "due" : "learn"}">${escapeHTML(status)}</span>
      </div>
      <h2>${escapeHTML(deck.title)}</h2>
      ${deck.description ? `<p>${escapeHTML(deck.description)}</p>` : ""}
      <div class="mastery-row">
        <strong>${metrics.mastery}% mastered</strong>
        <span>${deck.archived ? "Reviews paused" : escapeHTML(availabilityLabel(available))}</span>
      </div>
      <div class="progress-track" role="progressbar" aria-label="${metrics.mastery}% mastered" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${metrics.mastery}"><span style="--progress:${metrics.mastery}%"></span></div>
      <div class="card-facts"><span>${metrics.total} cards</span><span>${hasExampleProgress(deck) ? "Example progress" : formatRelative(metrics.lastStudied)}</span>${catalogSettings?.legacyDeckIds?.includes(deck.source?.catalogDeckId) ? '<span>Saved example</span>' : ""}</div>
      <div class="card-actions">
        ${deck.archived
          ? `<button class="button button-sm" type="button" data-archive-deck="${escapeAttribute(deck.id)}" data-archive="false" data-revision="${deck.revision}" ${accountMode ? 'disabled title="Restore is not yet supported for account-backed decks"' : ""}>${icon("restore")} Restore</button>`
          : `<button class="button button-sm" type="button" data-start-deck="${escapeAttribute(deck.id)}">Study</button>
             <a class="button button-sm button-quiet" href="#graph/${escapeAttribute(deck.id)}">${icon("graph")} Graph</a>
             <button class="button button-sm button-quiet" type="button" data-request-archive="${escapeAttribute(deck.id)}" aria-label="Remove ${escapeAttribute(deck.title)}" ${accountMode ? 'disabled title="Remove is not yet supported for account-backed decks"' : ""}>${icon("archive")} Remove</button>`}
      </div>
      ${confirmingArchive ? `
        <div class="archive-confirmation" role="alertdialog" aria-labelledby="archive-title-${escapeAttribute(deck.id)}">
          <div><strong id="archive-title-${escapeAttribute(deck.id)}">Remove ${escapeHTML(deck.title)}?</strong><span>You can restore it later with its review history intact.</span></div>
          <div>
            <button class="button button-sm button-quiet" type="button" data-cancel-archive>Cancel</button>
            <button class="button button-sm button-danger" type="button" data-confirm-archive="${escapeAttribute(deck.id)}" data-revision="${deck.revision}">Remove</button>
          </div>
        </div>` : ""}
    </article>`;
}

function renderLibrary(snapshot) {
  const subjects = ["All", ...new Set(library.flatMap((deck) => [deck.subject, ...(deck.crossListedSubjects ?? [])]))];
  const evidenceOptions = [
    ["All", "All evidence"],
    ["bounded_ready", "Bounded-ready"],
    ["reviewed_c4", "Reviewed through C4"],
    ["structural", "Structurally valid"],
    ["ai_reviewed", "AI-reviewed"],
    ["demo_fixture", "Demo fixtures"],
  ].filter(([key]) => key === "All" || library.some((deck) => evidenceForDeck(deck).key === key));
  const hasEvidenceFilter = evidenceOptions.length > 2;
  const selectedEvidence = hasEvidenceFilter ? ui.catalogEvidence : "All";
  const query = ui.catalogQuery.trim().toLowerCase();
  const matches = library.filter((deck) => {
    if (ui.catalogSubject !== "All" && deck.subject !== ui.catalogSubject && !deck.crossListedSubjects?.includes(ui.catalogSubject)) return false;
    if (selectedEvidence !== "All" && evidenceForDeck(deck).key !== selectedEvidence) return false;
    if (!query) return true;
    return [
      deck.title,
      deck.subject,
      deck.level,
      deck.description,
      deck.coverageSummary,
      ...(deck.tags ?? []),
      deck.searchText ?? "",
      ...(deck.cards ?? []).map((card) => card.term),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
  const visibleMatches = matches.slice(0, ui.catalogLimit);
  return `
    <section class="page">
      <header class="page-heading page-heading-simple">
        <h1>Library</h1>
      </header>
      <div class="filter-bar">
        <label class="search-field">
          ${icon("search")}
          <span class="sr-only">Search the library</span>
          <input type="search" value="${escapeAttribute(ui.catalogQuery)}" placeholder="Search subjects or terms" data-library-search autocomplete="off" />
        </label>
      </div>
      <div class="filter-pills" aria-label="Library subjects">
        ${subjects.map((subject) => `<button class="filter-pill" type="button" data-library-subject="${escapeAttribute(subject)}" aria-pressed="${String(ui.catalogSubject === subject)}">${escapeHTML(subject)}</button>`).join("")}
      </div>
      ${hasEvidenceFilter ? `<div class="library-evidence-filter">
        <label for="library-evidence">Evidence</label>
        <select id="library-evidence" class="select-field" data-library-evidence>
          ${evidenceOptions.map(([key, label]) => `<option value="${escapeAttribute(key)}" ${selectedEvidence === key ? "selected" : ""}>${escapeHTML(label)}</option>`).join("")}
        </select>
      </div>` : ""}
      <p class="library-result-count" aria-live="polite">Showing ${visibleMatches.length} of ${matches.length} ${matches.length === 1 ? "deck" : "decks"}</p>
      ${matches.length ? `
        <div class="card-grid">${visibleMatches.map((deck) => libraryCard(deck, snapshot)).join("")}</div>
        ${visibleMatches.length < matches.length ? `<div class="catalog-more"><button class="button button-quiet" type="button" data-library-more>Show more decks</button></div>` : ""}
      ` : emptyState({
        title: "No decks match",
        copy: "Try another subject or a broader term.",
        action: '<button class="button" type="button" data-clear-library>Clear filters</button>',
      })}
    </section>`;
}

function installedPersonalDeck(catalogId, snapshot) {
  return Object.values(snapshot.personalDecks ?? {}).find((deck) => deck.source?.catalogDeckId === catalogId) ?? null;
}

function libraryCard(deck, snapshot) {
  const installed = installedPersonalDeck(deck.id, snapshot);
  const earlierVersion = installed && String(installed.source.catalogVersion) !== String(deck.version);
  return `
    <article class="library-card subject-${subjectClass(deck.subject)}">
      <div class="card-topline">
        <span>${escapeHTML(deck.subject)}</span>
        <span class="status-pill" ${installed ? 'data-tone="learn"' : ""}>${installed ? "In My Decks" : "Available"}</span>
      </div>
      <h2>${escapeHTML(deck.title)}</h2>
      ${deck.description ? `<p>${escapeHTML(deck.description)}</p>` : ""}
      <div class="card-facts">
        <span>${deck.cardCount} cards</span>
        ${earlierVersion ? '<span>New edition · your saved version is unchanged</span>' : ""}
      </div>
      <div class="card-actions">
        <button class="button button-sm button-quiet" type="button" data-preview-deck="${escapeAttribute(deck.id)}">Preview</button>
        ${installed
          ? `<a class="button button-sm" href="#decks">Open deck</a>`
          : `<button class="button button-sm" type="button" data-add-deck="${escapeAttribute(deck.id)}" data-version="${escapeAttribute(deck.version)}">Add deck</button>`}
      </div>
    </article>`;
}

function renderStudySession(snapshot, sessionId, availability) {
  const session = snapshot.sessions?.[sessionId];
  if (!session) return notFound("That study session is not available.");
  const deck = snapshot.personalDecks?.[session.deckId];
  if (!deck) return notFound("The deck for this session is not available.");
  if (session.status === "paused" && !deck.archived) return renderSessionPaused(snapshot, session, deck, availability);
  if (["completed", "finished", "abandoned"].includes(session.status)) return renderSessionComplete(snapshot, session, deck, availability);
  if (session.status !== "active" || deck.archived) return notFound("This study session is no longer active.");
  const card = session.currentCardId ? deck.cards?.[session.currentCardId] : null;
  if (!card || card.archived) return notFound("The current card is not available. Return home to continue.");
  const revealed = session.phase === "answer_committed";
  const progress = session.queue.length ? Math.round((session.cursor / session.queue.length) * 100) : 100;
  return `
    <section class="session-shell" data-session-id="${escapeAttribute(session.id)}">
      <header class="session-header">
        <span class="session-deck-name">${escapeHTML(deck.title)}</span>
        <div class="session-progress">
          <strong>${session.cursor + 1} / ${session.queue.length}</strong>
          <div class="progress-track"><span style="--progress:${progress}%"></span></div>
        </div>
        <button class="button button-sm button-quiet session-exit" type="button" data-pause-session="${escapeAttribute(session.id)}">Exit</button>
      </header>
      <div class="study-stage">
        <div class="study-card-stack" data-card-stack>
          <div class="stack-card" aria-hidden="true"></div>
          <div class="stack-card" aria-hidden="true"></div>
          <div class="study-card-scene ${revealed ? "is-flipped" : ""}" data-study-card-scene data-card-id="${escapeAttribute(card.id)}">
            <article class="study-card-face study-card-front">
              <h1 class="study-term">${escapeHTML(card.term)}</h1>
            </article>
            <article class="study-card-face study-card-back">
              <span class="study-card-kicker">Definition</span>
              <div class="study-definition" data-study-definition></div>
              <footer class="study-card-foot"><span>${escapeHTML(card.term)}</span><span>Canonical answer</span></footer>
            </article>
          </div>
        </div>
      </div>
      <div class="study-controls">
        <div class="chat-study-status" aria-live="polite">
          <strong>${revealed ? "Definition revealed" : "Answer in chat"}</strong>
          <span>${revealed ? "Continue in chat for feedback." : "Define the term in your own words."}</span>
        </div>
      </div>
    </section>`;
}

function hydrateStudyDefinition(snapshot, sessionId) {
  const session = snapshot.sessions?.[sessionId];
  if (session?.status !== "active" || session.phase !== "answer_committed") return;
  const deck = snapshot.personalDecks?.[session.deckId];
  const card = session.currentCardId ? deck?.cards?.[session.currentCardId] : null;
  const definition = view.querySelector("[data-study-definition]");
  if (definition && card) renderDefinition(definition, card.definition);
}

function renderSessionPaused(snapshot, session, deck, availability) {
  const available = deckAvailability(availability, deck.id);
  if (!available?.resumable_session?.can_resume) {
    return renderStudyNoWork(snapshot, deck, readStudyAvailability(snapshot, deck.id, 5), session, availability);
  }
  return `
    <section class="session-shell">
      <header class="session-header"><span class="session-deck-name">${escapeHTML(deck.title)}</span><span></span><a class="button button-sm button-quiet session-exit" href="#study">Done</a></header>
      <div class="session-complete"><div>
        <h1>Session paused.</h1>
        <p class="quiet">Your place is saved. ${session.cursor} of ${session.queue.length} cards reviewed.</p>
        <div class="card-actions">
          <button class="button button-primary" type="button" data-start-deck="${escapeAttribute(deck.id)}">Resume session</button>
          <a class="button" href="#study">Back home</a>
        </div>
      </div></div>
    </section>`;
}

function prerequisiteGuidance(snapshot, deck, availability) {
  const page = availability?.blockers;
  if (!page?.items?.length) return "";
  const reasons = {
    PARENT_NOT_INSTALLED: "The prerequisite deck is not installed.",
    PARENT_MISSING: "The required prerequisite is unavailable.",
    PARENT_UNRESOLVED: "The required prerequisite could not be resolved.",
    PARENT_CARD_ARCHIVED: "The prerequisite card is archived.",
    PARENT_DECK_ARCHIVED: "The prerequisite deck is archived.",
    PARENT_BASE_CONFLICT: "The prerequisite's saved edition needs attention.",
    PARENT_AMBIGUOUS: "The prerequisite's exact owner needs attention.",
    PARENT_RECALL_REQUIRED: "Review this prerequisite first.",
  };
  return `<div class="study-prerequisites"><h2>Required prerequisites</h2><ul>${page.items.map((item) => `
    <li><strong>${escapeHTML(item.term ?? "Blocked card")}</strong><ul>${item.unmet_prerequisites.slice(0, 5).map((parent) => {
      const owner = parent.owner_deck_id ? snapshot.personalDecks?.[parent.owner_deck_id] : null;
      return `<li>${escapeHTML(parent.term ?? "Required prerequisite")}${parent.owner_deck_title ? ` · ${escapeHTML(parent.owner_deck_title)}` : ""}
        <p class="quiet">${escapeHTML(reasons[parent.reason] ?? "This prerequisite needs attention before the card can be introduced.")}</p>
        ${owner && !owner.archived && owner.id !== deck.id ? `<button class="button button-sm" type="button" data-start-deck="${escapeAttribute(owner.id)}">Open ${escapeHTML(owner.title)}</button>` : parent.reason === "PARENT_NOT_INSTALLED" ? '<a class="button button-sm" href="#library">Find prerequisite in Library</a>' : ""}</li>`;
    }).join("")}${item.unmet_prerequisites.length > 5 ? `<li>${item.unmet_prerequisites.length - 5} more prerequisites need attention.</li>` : ""}</ul></li>`).join("")}</ul>
    ${page.next_cursor ? `<p class="quiet">Showing ${page.items.length} of ${page.total_blocked_cards} blocked cards. The graph shows the deck's prerequisite relationships.</p>` : ""}</div>`;
}

function renderStudyNoWork(snapshot, deck, availability, session = null, collectionAvailability = availability) {
  const available = deckAvailability(availability, deck.id);
  const paused = available?.resumable_session;
  const canStart = canStartAvailable(available);
  const blocked = (available?.blocked_new_count ?? 0) > 0 || paused?.reason === "PREREQUISITE_NOT_SATISFIED";
  const conflict = paused?.reason === "ACTIVE_SESSION_EXISTS";
  const activeElsewhere = snapshot.sessions?.[availability?.active_session?.session_id];
  const returning = activeElsewhere && activeElsewhere.deckId !== deck.id ? activeElsewhere : resumableSessionFor(snapshot, collectionAvailability);
  const canReturn = returning && returning.deckId !== deck.id;
  const alternate = personalDeckArray(snapshot, { availability: collectionAvailability }).find((item) => item.id !== deck.id && canStartAvailable(deckAvailability(collectionAvailability, item.id)));
  const title = !available ? "Study availability unavailable" : canStart ? "Ready to study" : conflict ? "Another session is active"
    : blocked ? "Prerequisites need attention" : paused?.can_resume === false ? "Paused session needs attention" : "Nothing ready in this deck";
  const pauseMessage = conflict ? " Switch decks to save the active session's place before checking this queue."
    : paused?.reason === "CARD_NOT_FOUND" ? " The paused card is unavailable; your saved queue has not been changed." : "";
  return `<section class="page page-compact" data-study-availability-deck="${escapeAttribute(deck.id)}">
    <header class="page-heading"><div><p class="eyebrow">Study</p><h1>${escapeHTML(deck.title)}</h1></div></header>
    ${emptyState({ title, copy: !available ? "Check again before starting. Your saved place and review history have not changed."
      : `${availabilityLabel(available)}${blocked && available.next_due_at ? ` · ${nextReviewLabel(available.next_due_at)}` : ""}${pauseMessage}${paused || session?.status === "paused" ? " Your paused place is saved." : session?.queue.length === 0 ? " No cards were reviewed in this batch." : ""}`,
      action: `<div class="card-actions"><button class="button ${canStart ? "button-primary" : "button-quiet"}" type="button" data-start-deck="${escapeAttribute(deck.id)}">${canStart ? paused ? "Resume session" : "Start session" : conflict ? "Switch decks" : "Check availability"}</button>
        ${canReturn ? `<button class="button" type="button" data-start-deck="${escapeAttribute(returning.deckId)}">Return to ${escapeHTML(snapshot.personalDecks[returning.deckId].title)}</button>`
          : alternate ? `<button class="button" type="button" data-start-deck="${escapeAttribute(alternate.id)}">Study ${escapeHTML(alternate.title)}</button>` : '<a class="button" href="#decks">My Decks</a>'}
        <button class="button button-quiet" type="button" data-back-study>Back home</button></div>`,
    })}
    ${prerequisiteGuidance(snapshot, deck, availability)}
    <div class="card-actions"><a class="button button-quiet" href="#graph/${escapeAttribute(deck.id)}">View graph</a></div>
  </section>`;
}

function renderSessionComplete(snapshot, session, deck, availability) {
  if (session.queue.length === 0 && session.reviewsApplied === 0) {
    return renderStudyNoWork(snapshot, deck, readStudyAvailability(snapshot, deck.id, 5), session, availability);
  }
  const available = deckAvailability(availability, deck.id);
  const canContinue = canStartAvailable(available);
  const mastered = isDeckFullyMastered(metricsForDeck(deck));
  const streak = snapshot.streak;
  const ended = session.status !== "completed";
  const heading = ended ? "Session ended" : "Session complete";
  return `
    <section class="session-shell">
      <header class="session-header"><span class="session-deck-name">${escapeHTML(deck.title)}</span><span></span><a class="button button-sm button-quiet session-exit" href="#study">Done</a></header>
      <div class="session-complete">
        <div>
          <p class="eyebrow">${heading}</p>
          <h1>${heading}.</h1>
          <p class="quiet">${session.reviewsApplied ? "Your reviewed cards are scheduled." : "No cards were reviewed in this batch."}</p>
          <p class="quiet" data-study-remaining>${escapeHTML(availabilityLabel(available))}</p>
          ${mastered ? `<div class="mastery-earned" role="status"><span aria-hidden="true">✓</span><div><strong>Deck mastered</strong><small>${hasExampleProgress(deck) ? "Example progress · 100% mastered" : "100% mastery reached. Reviews will keep it strong."}</small></div></div>` : ""}
          <div class="session-summary">
            <div><strong>${session.reviewsApplied}</strong><span>Reviewed</span></div>
            <div><strong>${session.queue.length}</strong><span>Session cards</span></div>
            <div><strong class="summary-streak">${icon("flame")}${streak.current}</strong><span>${escapeHTML(streakBasisLabel(streak))}</span></div>
          </div>
          <div class="card-actions">
            ${canContinue ? `<button class="button button-primary" type="button" data-start-deck="${escapeAttribute(deck.id)}" data-continue-study>Continue</button>` : ""}
            <a class="button ${canContinue ? "button-quiet" : "button-primary"}" href="#study">Back home</a>
            <a class="button" href="#graph/${escapeAttribute(deck.id)}">View graph</a>
          </div>
          ${!canContinue && (available?.blocked_new_count || available?.resumable_session?.reason === "PREREQUISITE_NOT_SATISFIED") ? `<button class="button button-quiet" type="button" data-start-deck="${escapeAttribute(deck.id)}">View prerequisites</button>` : ""}
        </div>
      </div>
    </section>`;
}

function emptyState({ title, copy, action }) {
  return `
    <div class="empty-state">
      <div class="empty-state-inner">
        <div class="empty-icon">${icon("stack")}</div>
        <h2>${escapeHTML(title)}</h2>
        <p>${escapeHTML(copy)}</p>
        ${action}
      </div>
    </div>`;
}

function notFound(copy) {
  return `<section class="page page-compact">${emptyState({ title: "Nothing here", copy, action: '<a class="button" href="#study">Return home</a>' })}</section>`;
}

function showDeckPreview(deckId) {
  const deck = getCatalogDeck(deckId);
  if (!deck) return;
  const snapshot = store.getSnapshot();
  const installed = installedPersonalDeck(deck.id, snapshot);
  const dependencies = catalogSettings?.catalog?.library?.decks?.[deck.id]?.requiredCatalogDeckIds?.filter((id) => id !== deck.id) ?? [];
  const earlierVersion = installed && String(installed.source.catalogVersion) !== String(deck.version);
  deckDialogContent.innerHTML = `
    <div class="deck-dialog-inner">
      <header class="dialog-header">
        <div><p class="eyebrow">${escapeHTML(deck.subject)} · ${deck.cardCount} cards</p><h2 id="deck-dialog-title">${escapeHTML(deck.title)}</h2></div>
        <button class="icon-button" type="button" data-close-dialog aria-label="Close preview">×</button>
      </header>
      <div class="deck-dialog-scroll">
        ${deck.coverageSummary ? `<p class="dialog-summary">${escapeHTML(deck.coverageSummary)}</p>` : ""}
        <div class="evidence-row evidence-row-dialog" data-evidence="${escapeAttribute(evidenceForDeck(deck).key)}"><span>Evidence</span><strong>${escapeHTML(evidenceForDeck(deck).label)}</strong></div>
        <p class="account-note">Edition ${escapeHTML(deck.version)}${earlierVersion ? " · your installed edition and review history stay unchanged." : ""}</p>
        ${dependencies.length ? `<p class="account-note">Adds ${dependencies.length} prerequisite ${dependencies.length === 1 ? "course" : "courses"} with this deck: ${dependencies.map((id) => escapeHTML(getCatalogDeck(id)?.title ?? id)).join(", ")}. You study only the exact terms needed to unlock a new concept.</p>` : ""}
        <div class="term-table-wrap" tabindex="0" aria-label="All ${deck.cardCount} terms">
          <table class="term-table">
            <thead><tr><th scope="col">Term</th><th scope="col">Module</th></tr></thead>
            <tbody>
              ${deck.cards.map((card) => `<tr><td>${escapeHTML(card.term)}</td><td>${escapeHTML(card.module || "Concepts")}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>
      <div class="dialog-actions">
        <button class="button button-quiet" type="button" data-close-dialog>Close</button>
        ${installed
          ? '<a class="button button-primary" href="#decks" data-close-dialog>Open My Decks</a>'
          : `<button class="button button-primary" type="button" data-add-deck="${escapeAttribute(deck.id)}" data-version="${escapeAttribute(deck.version)}">Add to My Decks</button>`}
      </div>
    </div>`;
  deckDialog.showModal();
}

function toast(message, { actionLabel = null, onAction = null, duration = 3200 } = {}) {
  const context = captureView();
  if (!isViewCurrent(context)) return;
  const element = document.createElement("div");
  element.className = "toast";
  const text = document.createElement("span");
  text.textContent = message;
  element.append(text);
  let timer;
  if (actionLabel && typeof onAction === "function") {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "toast-action";
    action.textContent = actionLabel;
    action.addEventListener("click", () => {
      if (!isViewCurrent(context)) return;
      clearTimeout(timer);
      element.remove();
      onAction();
    }, { once: true });
    element.append(action);
  }
  toastRegion.append(element);
  timer = setTimeout(() => element.remove(), duration);
  return element;
}

function showFatal(error) {
  console.error(error);
  ui.failed = true;
  clearTimeout(ui.renderTimer);
  clearTimeout(ui.revealTimer);
  clearTimeout(ui.availabilityTimer);
  ui.graphCleanup?.();
  ui.graphCleanup = null;
  document.body.dataset.route = "study";
  loading.hidden = true;
  view.hidden = false;
  view.innerHTML = `
    <section class="page page-compact">
      <div class="error-state">
        <div class="empty-state-inner">
          <div class="empty-icon">!</div>
          <h2>The study workspace could not open.</h2>
          <p>${escapeHTML(error?.message ?? "An unexpected error occurred.")}</p>
          <p>Your saved data has not been reset. Retry after restoring storage access or the matching app version.</p>
          <div class="card-actions">
            <button class="button button-primary" type="button" data-retry-startup>Retry</button>
            ${accountMode ? '<button class="button" type="button" data-reconnect-account>Reconnect account</button>' : workspace && !workspace.ephemeral ? '<button class="button" type="button" data-download-saved>Download saved data</button>' : ""}
          </div>
        </div>
      </div>
    </section>`;
}

function queueRender(delay = 0, onRendered = null, completesReveal = false) {
  if (ui.failed) return;
  const context = captureView();
  if (!isViewCurrent(context)) return;
  clearTimeout(ui.renderTimer);
  ui.renderTimer = setTimeout(async () => {
    if (!isViewCurrent(context)) return;
    ui.renderTimer = null;
    try {
      await render();
      if (onRendered && isViewCurrent(context)) requestAnimationFrame(() => { if (isViewCurrent(context)) onRendered(); });
    } catch (error) {
      if (isViewCurrent(context)) showFatal(error);
    }
  }, completesReveal ? delay : Math.max(delay, ui.revealingUntil - Date.now()));
}

function closeOverlayDialogs() {
  if (deckDialog?.open) deckDialog.close();
  if (accountDialog?.open) accountDialog.close();
  if (settingsDialog?.open) settingsDialog.close();
}

async function render() {
  if (!store || ui.failed) return;
  const context = captureView();
  if (!isViewCurrent(context)) return;
  clearTimeout(ui.revealTimer);
  ui.revealTimer = null;
  ui.revealingUntil = 0;
  ui.graphCleanup?.();
  ui.graphCleanup = null;
  const route = getRoute();
  if (route.name !== "study") ui.emptyStudyDeckId = null;
  setActiveNav(route);
  const beforeViewSync = store.getSnapshot();
  const selectedDeckId = route.name === "graph" && beforeViewSync.personalDecks?.[route.id]
    ? route.id
    : route.name === "session"
      ? beforeViewSync.sessions?.[route.id]?.deckId
      : undefined;
  store.setView({
    route: route.name,
    ...(selectedDeckId ? { selectedDeckId } : {}),
  });
  const snapshot = store.getSnapshot();
  const availability = ["study", "decks", "session"].includes(route.name) ? readStudyAvailability(snapshot) : null;
  if (!isViewCurrent(context)) return;
  if (demoMode === "error") throw new Error("This is the intentional error-state preview.");

  if (route.name === "graph") {
    const personal = snapshot.personalDecks?.[route.id];
    if (!personal || personal.archived) {
      view.innerHTML = notFound("That active deck graph is not available.");
    } else {
      const deck = graphForPersonal(personal, snapshot);
      const activePulse = ui.graphPulse?.deckId === personal.id && Date.now() - ui.graphPulse.at < 8_000
        ? ui.graphPulse.cardId
        : null;
      ui.graphCleanup = mountGraphView(view, {
        deck,
        cardStates: cardStatesForDeck({ cards: Object.fromEntries(deck.cards.map((card) => [card.id, card])) }),
        focusCardId: deck.rootCardIds[0] ?? null,
        storage: workspace.storage,
        pulseCardId: activePulse,
        onBack: () => { if (isViewCurrent(context)) location.hash = "decks"; },
        onStudy: (cardId) => {
          const ownerDeckId = deck.cards.find((card) => card.id === cardId)?.ownerDeckId ?? personal.id;
          if (isViewCurrent(context)) return startSession(ownerDeckId);
        },
      });
    }
  } else if (route.name === "session") {
    const markup = renderStudySession(snapshot, route.id, availability);
    if (!isViewCurrent(context)) return;
    view.innerHTML = markup;
    hydrateStudyDefinition(snapshot, route.id);
  } else if (route.name === "decks") {
    view.innerHTML = renderMyDecks(snapshot, availability);
  } else if (route.name === "library") {
    view.innerHTML = renderLibrary(snapshot);
  } else {
    const markup = renderStudyHome(snapshot, availability);
    if (!isViewCurrent(context)) return;
    view.innerHTML = markup;
  }
  armAvailabilityRefresh(availability, route, snapshot);
  loading.hidden = true;
  view.hidden = false;
  view.focus?.({ preventScroll: true });
}

async function startSession(deckId) {
  const context = captureView();
  if (!isViewCurrent(context) || ui.mutationBusy || ui.revealingUntil > Date.now()) return;
  ui.mutationBusy = true;
  async function reconcileActiveSession() {
    if (!isViewCurrent(context)) return null;
    const snapshot = store.getSnapshot();
    const active = snapshot.sessions?.[snapshot.activeSessionId];
    if (active?.status === "active" && active.deckId === deckId) {
      ui.emptyStudyDeckId = null;
      location.hash = `session/${active.id}`;
      queueRender();
      return null;
    }
    if (!snapshot.personalDecks?.[deckId] || snapshot.personalDecks[deckId].archived) {
      throw new Error("That active deck is not available.");
    }
    if (active?.status === "active") await pauseSession(active.id, context);
    return isViewCurrent(context) ? store.getSnapshot() : null;
  }
  try {
    let confirmed = await reconcileActiveSession();
    if (!confirmed || !isViewCurrent(context)) return;
    let available = deckAvailability(readStudyAvailability(confirmed, deckId), deckId);
    if (!available && accountMode) {
      // An explicit retry can recover a transient hydration failure. It may
      // only reload the original account, never fall back to a local start.
      await context.session.refresh(context.ticket);
      if (!isViewCurrent(context)) return;
      // Recovery can discover a session that was absent in the old snapshot.
      // Reopen it exactly, or explicitly pause the other deck before starting.
      confirmed = await reconcileActiveSession();
      if (!confirmed || !isViewCurrent(context)) return;
      available = deckAvailability(readStudyAvailability(confirmed, deckId), deckId);
    }
    if (!isViewCurrent(context)) return;
    if (!canStartAvailable(available)) {
      // A deck choice may safely pause another queue, but never manufacture an
      // empty completed session just to discover there is no eligible work.
      ui.emptyStudyDeckId = deckId;
      store.setView({ route: "study", selectedDeckId: deckId });
      location.hash = "study";
      queueRender();
      return;
    }
    ui.emptyStudyDeckId = null;
    const result = await uiMutation("startStudySession", {
      deck_id: deckId,
      limit: 12,
      idempotency_key: actionId("start-session"),
    }, context);
    if (!result || !isViewCurrent(context)) return;
    location.hash = `session/${result.session.session_id}`;
    queueRender();
  } catch (error) {
    if (isViewCurrent(context)) { toast(error.message); queueRender(); }
  } finally { if (isViewCurrent(context)) ui.mutationBusy = false; }
}

function pauseSession(sessionId, context = captureView()) {
  if (!isViewCurrent(context)) return;
  const session = store.getSnapshot().sessions?.[sessionId];
  if (session?.status !== "active") return;
  return uiMutation("finishStudySession", {
    session_id: session.id,
    disposition: "pause",
    expected_session_revision: session.revision,
    idempotency_key: actionId("pause-session"),
  }, context);
}

function localReviewedCard(deck, submittedId) {
  if (!deck || !submittedId) return null;
  if (Object.hasOwn(deck.cards, submittedId)) return deck.cards[submittedId];
  const prefix = `${deck.id}.`;
  if (submittedId.startsWith(prefix)) return deck.cards[submittedId.slice(prefix.length)] ?? null;
  return null;
}

async function handleVisibleEffect(effect, metadata = {}) {
  const context = accountMode ? { session: accountSession, ticket: metadata.execution_context } : captureView();
  if (!isViewCurrent(context)) return;
  if (accountMode) {
    try { await context.session.refresh(context.ticket); }
    catch {
      if (isViewCurrent(context)) showFatal(new Error("Your grade or deck change was saved. Reconnect to load its confirmed state; do not submit it again."));
      return;
    }
    if (!isViewCurrent(context)) return;
  }
  const value = effect?.visible_effect ?? effect ?? {};
  if (value.type === "study_grade_committed") {
    const snapshot = store.getSnapshot();
    const deck = snapshot.personalDecks?.[snapshot.sessions?.[value.session_id]?.deckId];
    const card = localReviewedCard(deck, value.reviewed_card_id);
    if (card) ui.graphPulse = { deckId: deck.id, cardId: card.id, at: Date.now() };
    const scene = view.querySelector("[data-study-card-scene]");
    const definition = scene?.querySelector("[data-study-definition]");
    const status = view.querySelector(".chat-study-status");
    if (!scene || !definition || !card ||
        scene.closest("[data-session-id]")?.dataset.sessionId !== value.session_id ||
        scene.dataset.cardId !== card.id) {
      queueRender();
      return;
    }
    // A previously queued metadata refresh must not cut this committed reveal short.
    clearTimeout(ui.renderTimer);
    ui.renderTimer = null;
    renderDefinition(definition, value.reviewed_card?.definition_md ?? "");
    status?.querySelector("strong")?.replaceChildren("Definition revealed");
    status?.querySelector("span")?.replaceChildren("Grade saved. Moving to the next card.");
    scene.classList.add("is-flipped");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ui.revealingUntil = Date.now() + (reducedMotion ? 900 : 1510);
    if (reducedMotion) {
      queueRender(900, null, true);
      return;
    }
    clearTimeout(ui.revealTimer);
    ui.revealTimer = setTimeout(() => {
      if (!isViewCurrent(context) || !scene.isConnected) return;
      scene.classList.add("is-departing");
      queueRender(260, null, true);
    }, 1_250);
    return;
  }
  if (value.type === "webmcp_state_committed") {
    queueRender();
    return;
  }
  if (value.type === "answer_revealed") {
    queueRender();
    return;
  }
  if (value.type === "review_applied") {
    const snapshot = store.getSnapshot();
    const session = snapshot.sessions?.[value.session_id];
    ui.graphPulse = { deckId: session?.deckId, cardId: value.card_id, at: Date.now() };
    view.querySelector("[data-study-card-scene]")?.classList.add("is-departing");
    queueRender(230);
    return;
  }
  queueRender();
}

function bootstrap() {
  if (!workspace.seedExamples || !catalogSettings?.seedExamples) return;
  if (!Object.keys(store.getSnapshot().personalDecks).length) {
    const primary = getCatalogDeck("linear-algebra-i");
    const added = store.addLibraryDeck({
      library_deck_id: primary.id,
      expected_catalog_version: primary.version,
      client_action_id: "first-run:add-linear-algebra-i",
    });
    store.seedDemoState(added.deck.id);
  }
  store.seedMasteredDemoDeck();
}

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (target.closest("[data-reconnect-account]")) return reconnectAccount();
  if (target.closest("[data-account-signout]")) { accountRuntime?.invalidate(); return; }
  if (target.closest("[data-retry-startup]")) return location.reload();
  if (target.closest("[data-download-saved]")) {
    try {
      const raw = workspace.savedData();
      if (raw === null) return toast("There is no saved study data to download.");
      const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `meshful-${workspace.recordingId ?? "study"}-backup.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { toast(error.message); }
    return;
  }
  if (ui.failed) return;
  const context = captureView();
  if (!isViewCurrent(context)) return;
  if (target.closest("[data-back-study], [data-nav='study']")) {
    ui.emptyStudyDeckId = null;
    if (target.closest("[data-back-study]")) location.hash = "study";
    queueRender();
    return;
  }
  if (accountMode && target.closest("[data-preview-local-claim]")) {
    try {
      const preview = await context.session.previewLocalClaim();
      if (!isViewCurrent(context)) return;
      claimPreview = preview;
      settingsDialog.querySelector("[data-claim-confirmation]").innerHTML = `<p class="account-note">Copy ${formatNumber(claimPreview.bytes)} bytes into account <strong>${escapeHTML(claimPreview.accountBinding)}</strong>? This is a one-time copy, including any existing example progress. The browser workspace and exact backup remain unchanged. This will not merge with existing account data.</p><button class="button button-primary" type="button" data-confirm-local-claim>Copy to this account</button><button class="button button-quiet" type="button" data-cancel-local-claim>Cancel</button>`;
    } catch (error) { if (isViewCurrent(context)) toast(error.message); }
    return;
  }
  if (target.closest("[data-cancel-local-claim]")) { claimPreview = null; settingsDialog.querySelector("[data-claim-confirmation]")?.replaceChildren(); return; }
  if (accountMode && (target.closest("[data-confirm-local-claim]") || target.closest("[data-retry-account-claim]") || target.closest("[data-retry-account-write]"))) {
    if (ui.mutationBusy) return;
    ui.mutationBusy = true;
    try {
      if (target.closest("[data-confirm-local-claim]")) await context.session.confirmLocalClaim(claimPreview, claimPreview?.accountBinding);
      else if (target.closest("[data-retry-account-claim]")) await context.session.retryLocalClaim();
      else await context.session.retryPending();
      if (!isViewCurrent(context)) return;
      claimPreview = null;
      showAccountSettings();
      toast("Saved account state loaded. Browser data and recovery backups were preserved.");
      queueRender();
    } catch (error) { if (isViewCurrent(context)) { showAccountSettings(); toast(error.message); } }
    finally { if (isViewCurrent(context)) ui.mutationBusy = false; }
    return;
  }
  if (target.closest("[data-action='open-account']")) {
    if (accountMode) showAccountSettings();
    return accountDialog?.showModal();
  }
  if (target.closest("[data-open-settings]")) {
    if (accountMode) showAccountSettings();
    accountDialog?.close();
    return settingsDialog?.showModal();
  }
  if (target.closest("[data-close-account]")) return accountDialog?.close();
  if (target.closest("[data-close-settings]")) return settingsDialog?.close();
  if (target.closest("[data-close-dialog]")) return deckDialog.close();
  if (target.closest("[data-preview-deck]")) return showDeckPreview(target.closest("[data-preview-deck]").dataset.previewDeck);
  if (target.closest("[data-clear-library]")) {
    ui.catalogQuery = "";
    ui.catalogSubject = "All";
    ui.catalogEvidence = "All";
    ui.catalogLimit = 24;
    return queueRender();
  }
  const subject = target.closest("[data-library-subject]")?.dataset.librarySubject;
  if (subject) {
    ui.catalogSubject = subject;
    ui.catalogLimit = 24;
    return queueRender();
  }
  if (target.closest("[data-library-more]")) {
    ui.catalogLimit += 24;
    return queueRender();
  }
  const status = target.closest("[data-deck-status]")?.dataset.deckStatus;
  if (status) {
    ui.deckStatus = status;
    return queueRender();
  }
  const add = target.closest("[data-add-deck]");
  if (add) {
    if (ui.mutationBusy) return;
    ui.mutationBusy = true;
    try {
      const result = await uiMutation("addLibraryDeck", {
        library_deck_id: add.dataset.addDeck,
        expected_catalog_version: add.dataset.version,
        client_action_id: actionId("add-deck"),
      }, context);
      if (!result || !isViewCurrent(context)) return;
      if (deckDialog.open) deckDialog.close();
      toast(`${result.deck.title} added to My Decks`);
      return queueRender();
    } catch (error) {
      if (isViewCurrent(context)) return toast(error.message);
    } finally { if (isViewCurrent(context)) ui.mutationBusy = false; }
  }
  if (accountMode && target.closest("[data-request-archive], [data-confirm-archive], [data-archive-deck], [data-reset-local]")) return;
  const archiveRequest = target.closest("[data-request-archive]");
  if (archiveRequest) {
    ui.archiveConfirmDeckId = archiveRequest.dataset.requestArchive;
    return queueRender(0, () => view.querySelector("[data-cancel-archive]")?.focus());
  }
  if (target.closest("[data-cancel-archive]")) {
    const deckId = ui.archiveConfirmDeckId;
    ui.archiveConfirmDeckId = null;
    return queueRender(0, () => {
      [...view.querySelectorAll("[data-request-archive]")]
        .find((button) => button.dataset.requestArchive === deckId)
        ?.focus();
    });
  }
  const archiveConfirm = target.closest("[data-confirm-archive]");
  if (archiveConfirm) {
    try {
      const result = store.setDeckArchived({
        deck_id: archiveConfirm.dataset.confirmArchive,
        archived: true,
        expected_revision: Number(archiveConfirm.dataset.revision),
        client_action_id: actionId("archive-deck"),
      });
      ui.archiveConfirmDeckId = null;
      toast(`${result.deck.title} archived`, {
        actionLabel: "Undo",
        duration: 8000,
        onAction: () => {
          try {
            store.setDeckArchived({
              deck_id: result.deck.id,
              archived: false,
              expected_revision: result.deck.revision,
              client_action_id: actionId("undo-archive"),
            });
            ui.deckStatus = "active";
            queueRender();
          } catch (error) {
            toast(error.message);
          }
        },
      });
      return queueRender();
    } catch (error) {
      return toast(error.message);
    }
  }
  const archive = target.closest("[data-archive-deck]");
  if (archive) {
    try {
      const archived = archive.dataset.archive === "true";
      store.setDeckArchived({
        deck_id: archive.dataset.archiveDeck,
        archived,
        expected_revision: Number(archive.dataset.revision),
        client_action_id: actionId(archived ? "archive-deck" : "restore-deck"),
      });
      toast(archived ? "Deck archived" : "Deck restored");
      return queueRender();
    } catch (error) {
      return toast(error.message);
    }
  }
  const start = target.closest("[data-start-deck]");
  if (start) {
    return startSession(start.dataset.startDeck);
  }
  const pause = target.closest("[data-pause-session]");
  if (pause) {
    if (ui.mutationBusy) return;
    ui.mutationBusy = true;
    try {
      await pauseSession(pause.dataset.pauseSession, context);
      if (!isViewCurrent(context)) return;
      location.hash = "study";
    } catch (error) { if (isViewCurrent(context)) toast(error.message); }
    finally { if (isViewCurrent(context)) ui.mutationBusy = false; }
    queueRender();
    return;
  }
  if (target.closest("[data-reset-local]")) {
    const scope = workspace.recordingId ? `recording workspace ${workspace.recordingId}` : "study workspace";
    if (confirm(`Reset this ${scope}? This removes its decks, sessions, and review history in this browser.`)) {
      try {
        workspace.reset();
        location.assign(`${location.pathname}${location.search}#study`);
      } catch (error) { toast(error.message); }
    }
  }
});

document.addEventListener("input", (event) => {
  if (event.target.matches("[data-library-search]")) {
    ui.catalogQuery = event.target.value;
    ui.catalogLimit = 24;
    queueRender(80);
  }
  if (event.target.matches("[data-library-evidence]")) {
    ui.catalogEvidence = event.target.value;
    ui.catalogLimit = 24;
    queueRender();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (deckDialog?.open || accountDialog?.open || settingsDialog?.open) {
      closeOverlayDialogs();
      return;
    }
    if (ui.archiveConfirmDeckId) {
      const deckId = ui.archiveConfirmDeckId;
      ui.archiveConfirmDeckId = null;
      queueRender(0, () => {
        [...view.querySelectorAll("[data-request-archive]")]
          .find((button) => button.dataset.requestArchive === deckId)
          ?.focus();
      });
    }
  }
});

window.addEventListener("hashchange", () => {
  const context = captureView();
  if (!isViewCurrent(context)) return;
  closeOverlayDialogs();
  ui.archiveConfirmDeckId = null;
  render().catch((error) => { if (isViewCurrent(context)) showFatal(error); });
});

function startViewClock() {
  stopClock?.();
  const context = captureView();
  const idleStudyView = () => {
    const route = getRoute();
    if (["study", "decks"].includes(route.name)) return true;
    const session = route.name === "session" ? store.getSnapshot().sessions?.[route.id] : null;
    return session && session.status !== "active";
  };
  stopClock = observeViewClock({ async onRefresh() {
    if (!isViewCurrent(context) || !idleStudyView()) return;
    if (accountMode) {
      try { await context.session.refresh(context.ticket); }
      catch { /* A clock wake does not confirm writes. Still-valid readers may reproject time offline. */ }
      if (!isViewCurrent(context) || !idleStudyView()) return;
    }
    queueRender();
  } });
}

async function finishStartup() {
  const context = captureView();
  const selectedStore = store;
  await render();
  if (ui.failed || !isViewCurrent(context)) return;
  // Registration is serialized across epochs: a late old registration cannot
  // overwrite a newer account's handlers. Its pinned guard is already revoked.
  toolRegistration = toolRegistration.catch(() => {}).then(async () => {
    if (!isViewCurrent(context)) return;
    if (registeredToolNames.length) {
      const modelContext = document.modelContext;
      if (typeof modelContext?.unregisterTool !== "function") {
        toast("Reload this page to reconnect site tools to the current account.");
        return;
      }
      for (const name of registeredToolNames) {
        if (!isViewCurrent(context)) return;
        await modelContext.unregisterTool(name);
      }
      registeredToolNames = [];
    }
    if (!isViewCurrent(context)) return;
    const webmcpRegistration = await registerWebMCPTools({ store: selectedStore, onVisibleEffect: handleVisibleEffect,
      ...(accountMode ? { executionGuard: context.session.executionGuard } : {}) });
    registeredToolNames = webmcpRegistration.registered ?? [];
    if (!isViewCurrent(context)) return;
    if (webmcpRegistration.failed) {
      console.warn("Site tools unavailable", webmcpRegistration.failed);
      toast("Site tools are unavailable; the website still works normally");
    }
  });
  await toolRegistration;
  if (isViewCurrent(context)) startViewClock();
}

async function reconnectAccount() {
  const attempt = ++startupSequence;
  try {
    const connected = await accountRuntime.connect();
    if (attempt !== startupSequence || !connected.isCurrent()) return;
    accountSession = connected;
    store = connected.store;
    // Only view preferences may be ephemeral here; no local business store exists.
    workspace = { storage: createMemoryStorage(), label: "Account-backed", ephemeral: false, seedExamples: false };
    ui.failed = false;
    showAccountSettings();
    await finishStartup();
  } catch (error) {
    if (attempt === startupSequence) showFatal(error);
  }
}

export async function initializeWebsite({ accountOptions = null, catalogOptions = null } = {}) {
  if (accountRuntime || store) throw new Error("The website already selected a persistence path.");
  accountMode = accountOptions !== null;
  try {
    if (!accountMode) workspace = createBrowserWorkspace(location.search);
    catalogSettings = catalogOptions ?? await loadWebsiteLibrary({ storedStateJson: workspace?.savedData() });
    library = presentLibrary(catalogSettings.browseCatalog ?? catalogSettings.catalog.catalog ?? catalogSettings.catalog, catalogSettings);
  } catch (error) { showFatal(error); return; }
  if (accountMode) {
    try {
      accountRuntime = createAccountRuntime({ ...accountOptions, onInvalidate: invalidateAccountView,
        onReplay: ({ execution_context }) => {
          if (accountSession?.isCurrent(execution_context)) queueRender();
        } });
      await reconnectAccount();
    } catch (error) { invalidateAccountView(); showFatal(error); }
    return { reconnect: reconnectAccount, invalidate: () => accountRuntime?.invalidate(), dispose: () => accountRuntime?.dispose() };
  }
  try {
  // Storage access and hydration can both fail. Neither belongs outside recovery.
  store = createStudyStore({ catalog: catalogSettings.catalog, retainedCatalogs: catalogSettings.retainedCatalogs ?? [], storage: workspace.storage });
  bootstrap();
  const storageLabel = settingsDialog?.querySelector("[data-storage-label]");
  const storageState = settingsDialog?.querySelector("[data-storage-state]");
  if (storageLabel) storageLabel.textContent = workspace.label;
  if (storageState) storageState.textContent = workspace.ephemeral ? "Not saved after reload" : "Saved in this browser";
  if (demoMode === "loading") setTimeout(() => finishStartup().catch(showFatal), 700);
  else await finishStartup();
} catch (error) {
  if (error instanceof StudyStoreError || error instanceof Error) showFatal(error);
  else showFatal(new Error("The local workspace could not initialize."));
  }
}
