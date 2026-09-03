import { createWebsiteLocalStore, loadWebsiteLibrary } from "./library-loader.js";
import {
  presentLibrary,
  matchesLibraryQuery,
  graphForCatalog,
  graphForPersonal,
} from "./library-view.js?release=v40-learner-graph";
import { captureSearchFieldState, restoreSearchFieldState } from "./search-field-state.js";
import { prepareAccountStartupShell, showNeutralLoadingShell } from "./startup-view-state.js";
import { renderDefinition } from "./definition-renderer.js";
import { createBrowserWorkspace } from "./browser-workspace.js";
import { createAccountRuntime } from "./account-runtime.js";
import { calendarRelativeLabel, observeViewClock } from "./view-clock.js";
import { mountGraphView } from "./graph-view.js?graph-revision-17";
import { cardStatesForDeck } from "./graph-progress-state.js";
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
const trustedAccountDialogContent = accountDialog
  ? Array.from(accountDialog.childNodes ?? accountDialog.children ?? []).map((node) => node.cloneNode(true))
  : [];
let trustedAccountBinding = null;
const params = new URLSearchParams(location.search);
const demoMode = params.get("demo");
let workspace = null;
let store = null;
let accountMode = false;
let accountRuntime = null;
let accountSession = null;
let accountHydrationPending = false;
let claimPreview = null;
let startupSequence = 0;
let stopClock = null;
let toolRegistration = Promise.resolve();
let registeredToolNames = [];
let library = [];
let catalogSettings = null;
const loadedLibraryDecks = new Map();
const getCatalogDeck = (id) => loadedLibraryDecks.get(id) ?? library.find((deck) => deck.id === id);
const STUDY_HELP_DELAY_MS = 40_000;
const STUDY_PENDING_REVEAL_STORAGE_KEY = "meshful:study-pending-reveal:v1";
const STUDY_OUTCOME_LABELS = Object.freeze({
  again: "Again · review soon",
  hard: "Hard · keep working",
  good: "Good · on track",
  easy: "Easy · strong recall",
  saved: "Grade saved",
});

async function loadExactCatalogDeck(deckId, { includeClosure = false, context = captureView() } = {}) {
  if (!isViewCurrent(context)) return null;
  if (typeof catalogSettings?.loadCatalogDeck !== "function") return getCatalogDeck(deckId);
  const resolved = await catalogSettings.loadCatalogDeck(deckId, { includeClosure });
  if (!isViewCurrent(context)) return null;
  for (const deck of presentLibrary(resolved.catalog, catalogSettings)) loadedLibraryDecks.set(deck.id, deck);
  library = library.map((deck) => loadedLibraryDecks.get(deck.id) ?? deck);
  return getCatalogDeck(deckId);
}

const ui = {
  catalogQuery: "",
  catalogSubject: "All",
  catalogEvidence: "All",
  catalogLimit: 24,
  deckStatus: "active",
  graphCleanup: null,
  graphPulse: null,
  archiveConfirmDeckId: null,
  deleteUnavailableDeckId: null,
  librarySearchTimer: null,
  renderTimer: null,
  revealTimer: null,
  failed: false,
  revealingUntil: 0,
  mutationBusy: false,
  studySuperseded: false,
  emptyStudyDeckId: null,
  availabilityTimer: null,
  studyHelpKey: null,
  studyHelpTimer: null,
  studyHelpRemaining: STUDY_HELP_DELAY_MS,
  studyHelpStartedAt: 0,
  studyHelpShown: false,
  studyHelpDismissed: false,
  studyNonAnswerAcknowledgedSessions: new Set(),
  manualGrade: null,
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
  clearPendingStudyReveal();
  const keepLoading = accountMode && accountHydrationPending;
  accountSession = null;
  store = null;
  workspace = null;
  claimPreview = null;
  ui.failed = !keepLoading;
  ui.mutationBusy = false;
  ui.studySuperseded = false;
  ui.graphPulse = null;
  ui.revealingUntil = 0;
  ui.emptyStudyDeckId = null;
  ui.manualGrade = null;
  ui.deleteUnavailableDeckId = null;
  ui.studyNonAnswerAcknowledgedSessions.clear();
  clearTimeout(ui.renderTimer);
  clearTimeout(ui.librarySearchTimer);
  clearTimeout(ui.revealTimer);
  clearTimeout(ui.availabilityTimer);
  ui.librarySearchTimer = null;
  clearStudyHelp();
  stopClock?.();
  stopClock = null;
  ui.graphCleanup?.();
  ui.graphCleanup = null;
  closeOverlayDialogs();
  deckDialogContent.replaceChildren();
  toastRegion.replaceChildren();
  // Display-only wrapper identity must not survive an account boundary either.
  const accountTrigger = document.querySelector("[data-action='open-account']");
  if (accountTrigger) {
    accountTrigger.setAttribute("aria-label", "Open account");
    accountTrigger.innerHTML = icon("user");
  }
  accountDialog?.replaceChildren();
  settingsDialog?.replaceChildren();
  if (keepLoading) {
    showNeutralLoadingShell({ loading, view, clearView: true });
    return;
  }
  loading.hidden = true;
  view.hidden = false;
  view.innerHTML = emptyState({ title: "Account access paused", copy: "Reconnect to verify your account. Saved work and recovery data have not been reset.",
    action: '<button class="button button-primary" type="button" data-reconnect-account>Reconnect</button>' });
}

function applyStudySupersededState() {
  const shell = view.querySelector(".session-shell");
  if (!shell || !ui.studySuperseded) return;
  shell.dataset.studySuperseded = "true";
  for (const control of shell.querySelectorAll("button, input, textarea, select")) {
    if (control.matches("[data-take-over-study]")) continue;
    if (control.matches("textarea, input")) control.readOnly = true;
    else control.disabled = true;
  }
  if (!shell.querySelector("[data-study-superseded-notice]")) {
    const notice = document.createElement("div");
    notice.className = "study-takeover-notice";
    notice.dataset.studySupersededNotice = "true";
    notice.innerHTML = `<div><strong>Study continued in another tab</strong><p>This card stays visible here. Continue here only if you want to take study control back.</p></div>
      <button class="button button-sm" type="button" data-take-over-study>Continue here</button>`;
    shell.querySelector(".session-header")?.insertAdjacentElement("afterend", notice);
  }
}

function freezeStudyPresentation() {
  ui.studySuperseded = true;
  ui.mutationBusy = false;
  ui.revealingUntil = 0;
  clearTimeout(ui.renderTimer);
  clearTimeout(ui.librarySearchTimer);
  clearTimeout(ui.revealTimer);
  clearTimeout(ui.availabilityTimer);
  closeStudyNonAnswerConfirmation();
  clearStudyHelp({ preserveKey: true });
  ui.renderTimer = null;
  ui.librarySearchTimer = null;
  ui.revealTimer = null;
  ui.availabilityTimer = null;
  applyStudySupersededState();
}

function showRemoteStudyTakeover(deckId) {
  const deck = store?.getSnapshot?.().personalDecks?.[deckId];
  deckDialogContent.innerHTML = `<div class="deck-dialog-inner"><header class="dialog-header">
    <div><p class="eyebrow">Study active elsewhere</p><h2 id="deck-dialog-title">Continue on this device?</h2></div>
    <button class="icon-button" type="button" data-close-dialog aria-label="Close">×</button></header>
    <div class="deck-dialog-scroll"><p class="dialog-summary">${escapeHTML(deck?.title ?? "This deck")} is open in another browser or device. Continuing here will make that study view read-only.</p></div>
    <div class="dialog-actions"><button class="button button-quiet" type="button" data-close-dialog>Cancel</button>
    <button class="button button-primary" type="button" data-confirm-server-takeover="${escapeAttribute(deckId)}">Continue here</button></div></div>`;
  if (!deckDialog.open) deckDialog.showModal();
}

function restoreConnectedAccountDialog(accountBinding) {
  if (trustedAccountBinding === null) trustedAccountBinding = accountBinding;
  if (accountDialog?.childElementCount) return;
  if (accountBinding !== trustedAccountBinding) return;
  if (trustedAccountDialogContent.length) {
    accountDialog.replaceChildren(...trustedAccountDialogContent.map((node) => node.cloneNode(true)));
    return;
  }
  const fallback = document.createElement("template");
  fallback.innerHTML = `<div class="account-panel"><div class="dialog-header-compact">
    <h2 id="account-title">Account</h2><button class="icon-button" type="button" data-close-account aria-label="Close account">×</button></div>
    <p class="account-auth-state"><span aria-hidden="true">✓</span> Signed in with ChatGPT</p>
    <div class="account-storage-card"><div><strong>Study data</strong><span data-account-storage-state>Synced to your account</span></div>
    <p data-account-storage-note>Your decks and progress are available when you sign in.</p></div>
    <button class="account-menu-row" type="button" data-open-settings>Data &amp; privacy <span aria-hidden="true">→</span></button>
    <a class="account-menu-row" data-account-signout href="/signout-with-chatgpt?return_to=%2F" target="_top">Sign out</a></div>`;
  accountDialog.replaceChildren(fallback.content.cloneNode(true));
}

function showAccountSettings() {
  if (!accountSession) return;
  const recovery = accountSession.getRecovery();
  const accountStorageState = accountDialog?.querySelector("[data-account-storage-state]");
  const accountStorageNote = accountDialog?.querySelector("[data-account-storage-note]");
  if (accountStorageState) accountStorageState.textContent = "Synced to your account";
  if (accountStorageNote) accountStorageNote.textContent = "Your decks and progress are available when you sign in.";
  settingsDialog.innerHTML = `<div class="account-panel"><div class="dialog-header-compact"><h2 id="settings-title">Data &amp; privacy</h2><button class="icon-button" type="button" data-close-settings aria-label="Close settings">×</button></div>
    <section class="settings-section" aria-label="Study data">
      <div class="settings-row"><span data-storage-label>Study data</span><span data-storage-state>Synced to your account</span></div>
      <p class="account-note">Your decks and progress are available when you sign in. Your full chat is not copied into Meshful.</p>
      <button class="button button-quiet" type="button" data-preview-local-claim>Copy browser data to account</button>
      <p class="account-note">This optional one-time copy is available only while the account is empty. Your browser copy stays intact.</p>
      ${recovery.command ? '<button class="button button-quiet" type="button" data-retry-account-write>Recover saved action</button>' : ""}
      ${recovery.claim ? '<button class="button button-quiet" type="button" data-retry-account-claim>Recover browser-data copy</button>' : ""}
      <div data-claim-confirmation></div>
    </section>
    <section class="settings-section" aria-label="Data deletion">
      <h3>Data deletion</h3>
      <div class="settings-row"><span>Permanent deletion</span><span>Not available yet</span></div>
      <p class="account-note">Archiving a deck keeps its cards and study history. Permanent deletion will be added after Meshful can safely remove a deck without affecting a later reinstall.</p>
    </section></div>`;
}

function syncLocalStorageUI() {
  const storageLabel = settingsDialog?.querySelector("[data-storage-label]");
  const storageState = settingsDialog?.querySelector("[data-storage-state]");
  const storageNote = settingsDialog?.querySelector("[data-storage-note]");
  const accountStorageState = accountDialog?.querySelector("[data-account-storage-state]");
  const accountStorageNote = accountDialog?.querySelector("[data-account-storage-note]");
  const state = workspace.ephemeral ? "Not saved after reload" : "Saved in this browser";
  const summaryState = workspace.ephemeral ? "Temporary" : "Saved in this browser";
  const summaryNote = workspace.ephemeral
    ? "This example is temporary and is not saved after reload."
    : workspace.recordingId
      ? "This isolated recording workspace stays in this browser."
      : "Decks, reviews, and progress stay in this browser. ChatGPT sign-in identifies you, but study data does not sync between devices yet.";
  if (storageLabel) storageLabel.textContent = workspace.label;
  if (storageState) storageState.textContent = state;
  if (storageNote) storageNote.textContent = summaryNote;
  if (accountStorageState) accountStorageState.textContent = summaryState;
  if (accountStorageNote) accountStorageNote.textContent = summaryNote;
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

function studySessionProgress(session) {
  const queueLength = Array.isArray(session?.queue) ? session.queue.length : 0;
  const cursor = Math.max(0, Math.min(Number(session?.cursor ?? 0), queueLength));
  const dueTotal = Math.max(0, Math.min(
    Number.isInteger(session?.dueSegmentCount) ? session.dueSegmentCount : 0,
    queueLength,
  ));
  if (!session?.currentCardId || cursor >= queueLength) {
    return { phase: "complete", label: "Complete", percent: 100, dueTotal, position: null };
  }
  if (cursor < dueTotal) {
    const position = cursor + 1;
    return {
      phase: "due",
      label: `${position} of ${dueTotal} due`,
      percent: dueTotal ? Math.round((position / dueTotal) * 100) : 0,
      dueTotal,
      position,
    };
  }
  const position = cursor - dueTotal + 1;
  return {
    phase: "continuous",
    label: `Continuous · ${position}`,
    percent: 100,
    dueTotal,
    position,
  };
}

function studyNonAnswerSupported(action, snapshot = store?.getSnapshot?.()) {
  const capability = action === "reveal" ? "revealed_attempts"
    : action === "skip" ? "skipped_attempts"
      : null;
  if (!capability) return false;
  if (snapshot?.capabilities?.[capability] === true) return true;
  try { return store?.inspectAppState?.().capabilities?.[capability] === true; }
  catch { return false; }
}

function isMobileStudyViewport() {
  return window.matchMedia?.("(max-width: 720px)")?.matches === true;
}

function manualGradeAvailable() {
  return typeof store?.submitSelfGrade === "function";
}

function manualGradeMatches(session, card) {
  return session?.status === "active" && session.phase === "awaiting_answer" &&
    ui.manualGrade?.sessionId === session.id &&
    ui.manualGrade.sessionRevision === session.revision &&
    ui.manualGrade.cardId === card?.id;
}

function manualGradeChoicesMarkup() {
  const pendingRating = ui.manualGrade?.rating ?? null;
  const gradeButton = (rating, title, description) => {
    const selected = pendingRating === rating;
    return `<button class="study-manual-grade study-manual-grade-${rating}${selected ? " is-pending" : ""}" type="button" data-submit-self-grade="${rating}"${pendingRating ? (selected ? "" : " disabled") : ""}><strong>${title}</strong><span>${selected ? "Try again" : description}</span></button>`;
  };
  return `<div class="study-manual-grades" data-study-manual-grades role="group" aria-labelledby="study-manual-grade-title">
    <p id="study-manual-grade-title">How well did you remember it?</p>
    <div class="study-manual-grade-grid">
      ${gradeButton("again", "Again", "Forgot it")}
      ${gradeButton("hard", "Hard", "With effort")}
      ${gradeButton("good", "Good", "Remembered")}
      ${gradeButton("easy", "Easy", "Effortless")}
    </div>
    <button class="button button-sm button-quiet study-manual-grade-back" type="button" data-cancel-self-grade${pendingRating ? " disabled" : ""}>Back</button>
  </div>`;
}

function studyAgentHelpMarkup() {
  const mobile = isMobileStudyViewport();
  const heading = "Choose how to grade";
  const copy = "Use your agent for feedback, or choose Grade myself.";
  return `<aside class="study-agent-help" id="study-agent-help" data-study-agent-help role="region" aria-labelledby="study-agent-help-title">
    <div><strong id="study-agent-help-title">${escapeHTML(heading)}</strong><p aria-live="polite">${escapeHTML(copy)}</p></div>
    <div class="study-agent-help-actions">
      ${mobile ? '<button class="button button-sm button-quiet" type="button" data-copy-study-link>Copy link</button>' : ""}
      <button class="button button-sm button-quiet" type="button" data-dismiss-study-help>Dismiss</button>
    </div>
  </aside>`;
}

function insertStudyAgentHelp() {
  if (!ui.studyHelpKey || ui.studyHelpDismissed) return;
  const shell = view.querySelector("[data-study-help-key]");
  if (!shell || shell.dataset.studyHelpKey !== ui.studyHelpKey || shell.querySelector("[data-study-agent-help]")) return;
  const controls = shell.querySelector(".study-controls");
  if (!controls) return;
  const holder = document.createElement("div");
  holder.innerHTML = studyAgentHelpMarkup();
  const panel = holder.querySelector("[data-study-agent-help]");
  if (panel) {
    controls.append(panel);
    shell.querySelector("[data-show-study-help]")?.setAttribute("aria-expanded", "true");
  }
}

function clearStudyHelp({ preserveKey = false } = {}) {
  clearTimeout(ui.studyHelpTimer);
  ui.studyHelpTimer = null;
  ui.studyHelpStartedAt = 0;
  view?.querySelector?.("[data-study-agent-help]")?.remove();
  view?.querySelector?.("[data-show-study-help]")?.setAttribute("aria-expanded", "false");
  if (!preserveKey) {
    ui.studyHelpKey = null;
    ui.studyHelpRemaining = STUDY_HELP_DELAY_MS;
    ui.studyHelpShown = false;
    ui.studyHelpDismissed = false;
  }
}

function armStudyHelpTimer() {
  if (!ui.studyHelpKey || ui.studyHelpTimer || ui.studyHelpShown || ui.studyHelpDismissed || document.hidden) return;
  ui.studyHelpStartedAt = Date.now();
  const key = ui.studyHelpKey;
  ui.studyHelpTimer = setTimeout(() => {
    ui.studyHelpTimer = null;
    ui.studyHelpStartedAt = 0;
    if (ui.studyHelpKey !== key || ui.studyHelpDismissed) return;
    ui.studyHelpRemaining = 0;
    ui.studyHelpShown = true;
    insertStudyAgentHelp();
  }, Math.max(0, ui.studyHelpRemaining));
}

function syncStudyHelp(session, card, revealed = false) {
  const key = session.id;
  if (ui.studyHelpKey !== key) {
    clearStudyHelp();
    ui.studyHelpKey = key;
  }
  if (revealed) {
    clearStudyHelp({ preserveKey: true });
    ui.studyHelpDismissed = true;
    return;
  }
  if (ui.studyHelpShown) insertStudyAgentHelp();
  else armStudyHelpTimer();
}

function showStudyHelpNow() {
  if (!ui.studyHelpKey) return;
  closeStudyNonAnswerConfirmation();
  clearTimeout(ui.studyHelpTimer);
  ui.studyHelpTimer = null;
  ui.studyHelpStartedAt = 0;
  ui.studyHelpRemaining = 0;
  ui.studyHelpShown = true;
  ui.studyHelpDismissed = false;
  insertStudyAgentHelp();
}

function pauseStudyHelpTimer() {
  if (!ui.studyHelpTimer) return;
  clearTimeout(ui.studyHelpTimer);
  ui.studyHelpTimer = null;
  if (ui.studyHelpStartedAt) {
    ui.studyHelpRemaining = Math.max(0, ui.studyHelpRemaining - (Date.now() - ui.studyHelpStartedAt));
  }
  ui.studyHelpStartedAt = 0;
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
  return calendarRelativeLabel(value, new Date());
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

function scheduledReadyCount(availability) {
  return availability ? availability.due_count + availability.eligible_new_count : 0;
}

function readyCount(availability) {
  return availability ? scheduledReadyCount(availability) + (availability.practice_count ?? 0) : 0;
}

function isExtraPracticeOnly(availability) {
  return Boolean(availability
    && scheduledReadyCount(availability) === 0
    && (availability.practice_count ?? 0) > 0
    && !availability.resumable_session);
}

function nextReviewLabel(value) {
  if (!value || !Number.isFinite(new Date(value).valueOf())) return "";
  const date = new Date(value);
  const current = new Date();
  return `Next review ${new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", ...(date.getFullYear() === current.getFullYear() ? {} : { year: "numeric" }),
    hour: "numeric", minute: "2-digit",
  }).format(date)}.`;
}

function availabilityLabel(available, { includeBlocked = true } = {}) {
  if (!available) return "Study availability unavailable. Check again before starting.";
  const parts = [];
  if (available.due_count) parts.push(`${formatNumber(available.due_count)} ${available.due_count === 1 ? "review" : "reviews"} due`);
  if (available.eligible_new_count) parts.push(`${formatNumber(available.eligible_new_count)} ${available.eligible_new_count === 1 ? "card" : "cards"} available`);
  if (!parts.length && available.practice_count) parts.push(`${formatNumber(available.practice_count)} ${available.practice_count === 1 ? "card" : "cards"} available for extra practice`);
  if (includeBlocked && available.blocked_new_count) parts.push(`${formatNumber(available.blocked_new_count)} later in the course`);
  return parts.length ? parts.join(" · ") : `No reviews due now. ${nextReviewLabel(available.next_due_at) || "No cards available yet."}`;
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
    user: '<circle cx="10" cy="7" r="3" /><path d="M4.5 16c.8-3 2.7-4.5 5.5-4.5s4.7 1.5 5.5 4.5" />',
  };
  return `<svg viewBox="0 0 20 20" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}

function getRoute() {
  const raw = location.hash.replace(/^#/, "") || "study";
  const [name, id] = raw.split("/");
  if (name === "session" && id) return { name, id };
  if (name === "graph" && id) return { name, id };
  if (name === "library-graph" && id) return { name, id };
  if (["study", "decks", "library"].includes(name)) return { name };
  return { name: "study" };
}

function setActiveNav(route) {
  const active = route.name === "session" ? "study" : route.name === "graph" ? "decks"
    : route.name === "library-graph" ? "library" : route.name;
  document.querySelectorAll("[data-nav]").forEach((item) => {
    if (item.dataset.nav === active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  document.body.dataset.route = route.name === "library-graph" ? "graph" : route.name;
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
  const dateLabel = formatDate(day.date, day.date);
  const reviewLabel = `${formatNumber(day.review_count)} recorded ${day.review_count === 1 ? "review" : "reviews"}`;
  return `<div class="activity-day" data-activity-date="${escapeAttribute(day.date)}" data-level="${day.level}" role="img" aria-label="${escapeAttribute(dateLabel)}: ${reviewLabel}" data-activity-tooltip="${escapeAttribute(dateLabel)} · ${reviewLabel}" tabindex="0"><span class="activity-dot" aria-hidden="true"></span><span aria-hidden="true">${escapeHTML(day.label)}</span></div>`;
}

function renderStudyActivity(snapshot, activity) {
  const streak = snapshot.streak;
  const streakCount = Number.isSafeInteger(streak?.current) && streak.current >= 0 ? streak.current : 0;
  return `<div class="activity-module" data-study-activity="${activity ? "available" : "unavailable"}"${activity ? ` data-activity-as-of="${escapeAttribute(activity.as_of)}" data-activity-zone="${escapeAttribute(activity.time_zone)}" data-history-status="${activity.history.status}"` : ""}>
    <div class="activity-heading">
      <div><span>Study activity</span></div>
      <span class="activity-streak" aria-label="${formatNumber(streakCount)}-day study streak · ${escapeAttribute(streakBasisLabel(streak))}" title="${escapeAttribute(streakBasisLabel(streak))}">${icon("flame")}<strong>${formatNumber(streakCount)}</strong></span>
    </div>
    ${activity ? `
      <div class="activity-strip" aria-label="Recorded reviews over the last seven days in ${escapeAttribute(activity.time_zone)}">${activity.days.map(activityDay).join("")}</div>
    ` : '<p class="activity-unavailable">Activity is temporarily unavailable.</p>'}
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
    const hasArchived = Object.values(snapshot.personalDecks ?? {}).some((deck) => deck.archived);
    return `
      <section class="page page-compact" data-empty-study-home>
        <header class="study-home-heading"><h1>Study</h1></header>
        ${emptyState({
          title: hasArchived ? "No active decks" : "You have no decks yet",
          copy: hasArchived ? "Restore a deck from My Decks or choose a new course from the Library." : "Choose a course from the Library and start studying when you are ready.",
          action: hasArchived
            ? '<div class="empty-actions"><a class="button" href="#decks" data-deck-status="archived">View archived decks</a><a class="button button-primary" href="#library">Browse Library</a></div>'
            : '<a class="button button-primary" href="#library">Browse Library</a>',
        })}
        ${activity?.review_count > 0 ? `<aside class="activity-history-panel" aria-label="Study activity">${renderStudyActivity(snapshot, activity)}</aside>` : ""}
      </section>`;
  }

  const resumableSession = resumableSessionFor(snapshot, availability);
  const active = resumableSession ? snapshot.personalDecks[resumableSession.deckId]
    : decks.find((deck) => canStartAvailable(deckAvailability(availability, deck.id))) ?? decks[0];
  const activeAvailability = deckAvailability(availability, active.id);
  const activeExtraPracticeOnly = !resumableSession && isExtraPracticeOnly(activeAvailability);
  const activeMetrics = metricsForDeck(active);
  const activeMastered = isDeckFullyMastered(activeMetrics);
  const totalDue = (availability?.decks ?? []).reduce((sum, deck) => sum + deck.due_count, 0);
  const dueLabel = !availability ? "check availability" : totalDue === 1 ? "review due" : "reviews due";
  return `
    <section class="page">
      <header class="study-home-heading">
        <h1>Study</h1>
      </header>

      <div class="study-hero">
        <div class="study-hero-main">
          <div>
            <p class="eyebrow">Due now</p>
            <div class="due-number"><strong>${availability ? formatNumber(totalDue) : "—"}</strong><span>${dueLabel}</span></div>
          </div>
          <div class="study-hero-copy">
            <div class="study-title-line${resumableSession ? " has-session-progress" : ""}">
              <h2>${escapeHTML(active.title)}</h2>
              <span class="${activeMastered ? "mastery-chip" : "study-active-mastery"}">${activeMastered ? "✓ 100% mastered" : `${activeMetrics.mastery}% mastered`}</span>
            </div>
            ${resumableSession ? `<p>${resumableSession.cursor} of ${resumableSession.queue.length} complete</p>` : ""}
            <button class="button button-primary study-hero-action" type="button" data-start-deck="${escapeAttribute(active.id)}" ${resumableSession ? `data-resume-session="${escapeAttribute(resumableSession.id)}"` : ""}>
              ${resumableSession ? "Resume studying" : activeExtraPracticeOnly ? "Practice anyway" : "Start studying"} ${icon("arrow")}
            </button>
          </div>
        </div>
        <aside class="study-hero-side" aria-label="Study progress">
          ${renderStudyActivity(snapshot, activity)}
          ${activity ? `<div class="hero-metrics">
            <div class="hero-metric"><span>Reviews this week</span><strong>${formatNumber(activity.review_count)}</strong></div>
          </div>` : ""}
        </aside>
      </div>

      <div class="section-heading"><h2>Choose a deck</h2><a href="#decks">View all decks</a></div>
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
      <div><h3>${escapeHTML(deck.title)}</h3><p>${metrics.mastery}% mastered</p></div>
      <div class="queue-due"><strong>${available ? formatNumber(available.due_count) : "—"}</strong><span>due</span></div>
      <button class="button button-sm" type="button" data-start-deck="${escapeAttribute(deck.id)}">Study</button>
    </article>`;
}

function renderMyDecks(snapshot, availability) {
  const archived = ui.deckStatus === "archived";
  const decks = personalDeckArray(snapshot, { archived, availability });
  const hasArchived = Object.values(snapshot.personalDecks ?? {}).some((deck) => deck.archived);
  return `
    <section class="page">
      <header class="page-heading page-heading-simple">
        <h1>My Decks</h1>
        <a class="button button-primary my-decks-library-button" href="#library" aria-label="Open Library to add decks">Library</a>
      </header>
      <div class="filter-bar">
        <div class="filter-pills" aria-label="Deck status">
          <button class="filter-pill" type="button" data-deck-status="active" aria-pressed="${String(!archived)}">Active</button>
          <button class="filter-pill" type="button" data-deck-status="archived" aria-pressed="${String(archived)}">Archived</button>
        </div>
      </div>
      ${decks.length ? `<div class="card-grid">${decks.map((deck) => personalDeckCard(deck, deckAvailability(availability, deck.id))).join("")}</div>` : emptyState({
        title: archived ? "No archived decks" : hasArchived ? "No active decks" : "You have no decks yet",
        copy: archived ? "When you archive a deck, it stays here until you restore it." : hasArchived ? "Restore a saved deck from Archived or choose a new course from the Library." : "Choose a course from the Library and start studying when you are ready.",
        action: archived ? "" : `<div class="empty-actions">${hasArchived ? '<button class="button" type="button" data-deck-status="archived">View archived</button>' : ""}<a class="button button-primary" href="#library">Browse Library</a></div>`,
        iconName: archived ? "book" : "stack",
      })}
    </section>`;
}

function personalDeckCard(deck, available) {
  const metrics = metricsForDeck(deck);
  const mastered = !deck.archived && isDeckFullyMastered(metrics);
  const confirmingArchive = ui.archiveConfirmDeckId === deck.id;
  const showingDeleteUnavailable = ui.deleteUnavailableDeckId === deck.id;
  const showingCardDialog = confirmingArchive || showingDeleteUnavailable;
  const status = deck.archived ? "Archived" : mastered ? "✓ Mastered" : !available ? ""
    : available.due_count ? `${available.due_count} due` : "";
  return `
    <article class="deck-card subject-${subjectClass(deck.subject)}${mastered ? " is-mastered" : ""}">
      <div class="card-topline">
        <span>${escapeHTML(deck.subject)}</span>
        ${status ? `<span class="status-pill" data-tone="${mastered ? "mastered" : available?.due_count ? "due" : "learn"}">${escapeHTML(status)}</span>` : ""}
      </div>
      <h2>${escapeHTML(deck.title)}</h2>
      ${deck.description ? `<p>${escapeHTML(deck.description)}</p>` : ""}
      <div class="mastery-row">
        <strong>${metrics.mastery}% mastered</strong>
        ${deck.archived ? "<span>Reviews paused</span>" : ""}
      </div>
      <div class="progress-track" role="progressbar" aria-label="${metrics.mastery}% mastered" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${metrics.mastery}"><span style="--progress:${metrics.mastery}%"></span></div>
      <div class="card-facts"><span>${metrics.total} cards</span><span>${formatRelative(metrics.lastStudied)}</span></div>
      <div class="card-actions"${showingCardDialog ? ' inert aria-hidden="true"' : ""}>
        ${deck.archived
          ? `<button class="button button-sm button-primary" type="button" data-archive-deck="${escapeAttribute(deck.id)}" data-archive="false" data-revision="${deck.revision}">${icon("restore")} Restore</button>
             <a class="button button-sm" href="#graph/${escapeAttribute(deck.id)}">${icon("graph")} Graph</a>
             <button class="button button-sm button-danger" type="button" data-delete-unavailable="${escapeAttribute(deck.id)}">Delete</button>`
          : `<button class="button button-sm button-primary" type="button" data-start-deck="${escapeAttribute(deck.id)}">Study</button>
             <a class="button button-sm" href="#graph/${escapeAttribute(deck.id)}">${icon("graph")} Graph</a>
             <button class="button button-sm" type="button" data-request-archive="${escapeAttribute(deck.id)}" aria-label="Archive ${escapeAttribute(deck.title)}">${icon("archive")} Archive</button>`}
      </div>
      ${confirmingArchive ? `
        <div class="archive-confirmation" role="alertdialog" aria-labelledby="archive-title-${escapeAttribute(deck.id)}" aria-describedby="archive-description-${escapeAttribute(deck.id)}">
          <div><strong id="archive-title-${escapeAttribute(deck.id)}">Archive this deck?</strong><span id="archive-description-${escapeAttribute(deck.id)}">You can restore it anytime.</span></div>
          <div>
            <button class="button button-sm archive-cancel-button" type="button" data-cancel-archive>Cancel</button>
            <button class="button button-sm archive-confirm-button" type="button" data-confirm-archive="${escapeAttribute(deck.id)}" data-revision="${deck.revision}">Archive</button>
          </div>
        </div>` : ""}
      ${showingDeleteUnavailable ? `
        <div class="archive-confirmation delete-unavailable" role="alertdialog" aria-labelledby="delete-title-${escapeAttribute(deck.id)}" aria-describedby="delete-description-${escapeAttribute(deck.id)}">
          <div><strong id="delete-title-${escapeAttribute(deck.id)}">Delete unavailable</strong><span id="delete-description-${escapeAttribute(deck.id)}">This deck stays archived. No data was deleted.</span></div>
          <div><button class="button button-sm button-quiet" type="button" data-close-delete-unavailable>Cancel</button></div>
        </div>` : ""}
    </article>`;
}

function libraryEvidenceOptions() {
  return [
    ["All", "All evidence"],
    ["bounded_ready", "Bounded-ready"],
    ["reviewed_c4", "Reviewed through C4"],
    ["structural", "Structurally valid"],
    ["ai_reviewed", "AI-reviewed"],
    ["demo_fixture", "Demo fixtures"],
  ].filter(([key]) => key === "All" || library.some((deck) => evidenceForDeck(deck).key === key));
}

function renderLibraryResults(snapshot, hasEvidenceFilter = libraryEvidenceOptions().length > 2) {
  const selectedEvidence = hasEvidenceFilter ? ui.catalogEvidence : "All";
  const matches = library.filter((deck) => {
    if (ui.catalogSubject !== "All" && deck.subject !== ui.catalogSubject && !deck.crossListedSubjects?.includes(ui.catalogSubject)) return false;
    if (selectedEvidence !== "All" && evidenceForDeck(deck).key !== selectedEvidence) return false;
    return matchesLibraryQuery(deck, ui.catalogQuery);
  });
  const visibleMatches = matches.slice(0, ui.catalogLimit);
  return `
    <p class="sr-only" aria-live="polite">${visibleMatches.length} of ${matches.length} ${matches.length === 1 ? "deck" : "decks"} shown</p>
    ${matches.length ? `
      <div class="card-grid">${visibleMatches.map((deck) => libraryCard(deck, snapshot)).join("")}</div>
      ${visibleMatches.length < matches.length ? `<div class="catalog-more"><button class="button button-quiet" type="button" data-library-more>Show more decks</button></div>` : ""}
    ` : emptyState({
      title: "No decks match",
      copy: "Try another subject or a broader term.",
      action: '<button class="button" type="button" data-clear-library>Clear filters</button>',
    })}`;
}

function renderLibrary(snapshot) {
  const subjects = ["All", ...new Set(library.flatMap((deck) => [deck.subject, ...(deck.crossListedSubjects ?? [])]))];
  const evidenceOptions = libraryEvidenceOptions();
  const hasEvidenceFilter = evidenceOptions.length > 2;
  const selectedEvidence = hasEvidenceFilter ? ui.catalogEvidence : "All";
  return `
    <section class="page">
      <header class="page-heading page-heading-simple">
        <h1>Deck Library</h1>
      </header>
      <div class="filter-bar">
        <label class="search-field">
          ${icon("search")}
          <span class="sr-only">Search the Library</span>
          <input type="search" value="${escapeAttribute(ui.catalogQuery)}" placeholder="Search courses, subjects, or terms" data-library-search autocomplete="off" autocapitalize="none" enterkeyhint="search" spellcheck="false" />
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
      <div data-library-results>${renderLibraryResults(snapshot, hasEvidenceFilter)}</div>
    </section>`;
}

function installedPersonalDeck(catalogId, snapshot, catalogVersion = null) {
  return Object.values(snapshot.personalDecks ?? {}).find((deck) =>
    deck.source?.catalogDeckId === catalogId &&
    (catalogVersion === null || String(deck.source?.catalogVersion) === String(catalogVersion))) ?? null;
}

function libraryCard(deck, snapshot) {
  const installed = installedPersonalDeck(deck.id, snapshot);
  return `
    <article class="library-card subject-${subjectClass(deck.subject)}">
      <div class="card-topline">
        <span>${escapeHTML(deck.subject)}</span>
      </div>
      <h2>${escapeHTML(deck.title)}</h2>
      ${deck.description ? `<p>${escapeHTML(deck.description)}</p>` : ""}
      <div class="library-card-footer">
        <div class="card-facts">
          <span>${deck.cardCount} cards</span>
        </div>
        <div class="card-actions">
          <button class="button button-sm button-quiet" type="button" data-preview-deck="${escapeAttribute(deck.id)}">Preview</button>
          ${installed
            ? installed.archived
              ? `<button class="button button-sm button-added" type="button" data-request-unarchive="${escapeAttribute(deck.id)}" data-catalog-version="${escapeAttribute(installed.source?.catalogVersion ?? "")}" aria-label="Unarchive ${escapeAttribute(deck.title)}">Archived</button>`
              : `<a class="button button-sm button-added" href="#decks" aria-label="Added to My Decks; open My Decks">✓ Added</a>`
            : `<button class="button button-sm button-primary" type="button" data-add-deck="${escapeAttribute(deck.id)}" data-version="${escapeAttribute(deck.version)}">Add</button>`}
        </div>
      </div>
    </article>`;
}

function renderStudySession(snapshot, sessionId, availability) {
  const canonicalSession = snapshot.sessions?.[sessionId];
  if (!canonicalSession) return notFound("That study session is not available.");
  const deck = snapshot.personalDecks?.[canonicalSession.deckId];
  if (!deck) return notFound("The deck for this session is not available.");
  const pendingReveal = pendingStudyRevealFor(snapshot, sessionId);
  const session = pendingReveal ? {
    ...canonicalSession,
    status: "active",
    phase: "answer_committed",
    cursor: Math.max(0, canonicalSession.cursor - 1),
    currentCardId: pendingReveal.cardId,
  } : canonicalSession;
  if (!pendingReveal && session.status === "paused" && !deck.archived) return renderSessionPaused(snapshot, session, deck, availability);
  if (!pendingReveal && ["completed", "finished", "abandoned"].includes(session.status)) return renderSessionComplete(snapshot, session, deck, availability);
  if (session.status !== "active" || deck.archived) return notFound("This study session is no longer active.");
  const card = session.currentCardId ? deck.cards?.[session.currentCardId] : null;
  if (!card || card.archived) return notFound("The current card is not available. Return home to continue.");
  const manualGrading = !pendingReveal && manualGradeMatches(session, card);
  const revealed = session.phase === "answer_committed" || manualGrading;
  const progress = studySessionProgress(session);
  const helpKey = session.id;
  const allowReveal = studyNonAnswerSupported("reveal", snapshot);
  const allowSkip = studyNonAnswerSupported("skip", snapshot);
  const pendingOutcome = pendingReveal ? STUDY_OUTCOME_LABELS[pendingReveal.rating] : null;
  const pendingAdvanceLabel = pendingReveal?.completionState === "completed" ? "Finish session" : "Next card";
  return `
    <section class="session-shell" data-session-id="${escapeAttribute(session.id)}" data-study-help-key="${escapeAttribute(helpKey)}" data-queue-phase="${escapeAttribute(progress.phase)}" ${pendingReveal ? 'data-study-advance-pending="true"' : ""}>
      <header class="session-header">
        <span class="session-deck-name" title="${escapeAttribute(deck.title)}">${escapeHTML(deck.title)}</span>
        <div class="session-progress session-progress-${escapeAttribute(progress.phase)}" aria-label="Study progress: ${escapeAttribute(progress.label)}">
          <strong data-session-progress data-progress-mode="${escapeAttribute(progress.phase)}">${escapeHTML(progress.label)}</strong>
          <div class="progress-track" aria-hidden="true"><span style="--progress:${progress.percent}%"></span></div>
        </div>
        <button class="button button-sm button-quiet session-exit" type="button" data-pause-session="${escapeAttribute(session.id)}">Exit</button>
      </header>
      <div class="study-stage">
        <div class="study-card-stack" data-card-stack data-study-card-phase="${manualGrading ? "manual-grade" : revealed ? "revealed" : "prompt"}" ${pendingReveal ? `data-study-outcome="${escapeAttribute(pendingReveal.rating)}"` : ""}>
          <div class="stack-card" aria-hidden="true"></div>
          <div class="stack-card" aria-hidden="true"></div>
          <div class="study-card-scene ${revealed ? "is-flipped" : ""}" data-study-card-scene data-card-id="${escapeAttribute(card.id)}" ${pendingReveal ? `data-study-outcome="${escapeAttribute(pendingReveal.rating)}"` : ""}>
            <article class="study-card-face study-card-front" aria-hidden="${revealed ? "true" : "false"}" ${revealed ? "inert" : ""}>
              <h1 class="study-term">${escapeHTML(card.term)}</h1>
            </article>
            <article class="study-card-face study-card-back" aria-hidden="${revealed ? "false" : "true"}" ${revealed ? "" : "inert"}>
              <div class="study-definition" data-study-definition></div>
              <footer class="study-card-foot"><span data-study-reviewed-term>${escapeHTML(card.term)}</span></footer>
            </article>
          </div>
          <div class="study-outcome-badge" data-study-outcome-badge aria-hidden="true" ${pendingReveal ? "" : "hidden"}>${pendingOutcome ? escapeHTML(pendingOutcome) : ""}</div>
        </div>
      </div>
      <div class="study-controls">
        <p class="sr-only" data-study-live-status aria-live="polite">${pendingReveal ? `${escapeHTML(pendingOutcome)}. Review the definition, then ${pendingReveal.completionState === "completed" ? "finish the session" : "continue to the next card"}.` : manualGrading ? "Answer revealed. Choose your grade." : revealed ? "Definition revealed. Grade saved." : "Card ready. Define the term in chat."}</p>
        <div class="study-control-actions${manualGrading ? " has-manual-grades" : pendingReveal ? " has-study-next" : ""}" role="group" aria-label="Study actions">
          ${pendingReveal ? `<button class="button button-sm button-primary study-next-action" type="button" data-advance-study-card="true">${pendingAdvanceLabel}</button>` : manualGrading ? manualGradeChoicesMarkup() : `
            ${manualGradeAvailable() ? '<button class="button button-sm button-primary study-manual-grade-action" type="button" data-start-self-grade>Grade myself</button>' : ""}
            ${allowReveal ? '<button class="button button-sm study-reveal-action" type="button" data-reveal-answer>Reveal answer</button>' : ""}
            ${allowSkip ? '<button class="button button-sm button-quiet study-skip-action" type="button" data-skip-card>Skip card</button>' : ""}
            <button class="study-help-button" type="button" data-show-study-help aria-label="How to answer" title="How to answer" aria-controls="study-agent-help" aria-expanded="${ui.studyHelpShown && !ui.studyHelpDismissed ? "true" : "false"}">?</button>
          `}
        </div>
      </div>
    </section>`;
}

function hydrateStudyDefinition(snapshot, sessionId) {
  const canonicalSession = snapshot.sessions?.[sessionId];
  const pendingReveal = pendingStudyRevealFor(snapshot, sessionId);
  const session = pendingReveal ? {
    ...canonicalSession,
    status: "active",
    phase: "answer_committed",
    currentCardId: pendingReveal.cardId,
  } : canonicalSession;
  const deck = snapshot.personalDecks?.[session?.deckId];
  const card = session?.currentCardId ? deck?.cards?.[session.currentCardId] : null;
  if (session?.status !== "active" || (session.phase !== "answer_committed" && !manualGradeMatches(session, card))) return;
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

function prerequisiteGuidance(deck, availability) {
  const page = availability?.blockers;
  if (!page?.items?.length) return "";
  const crossCourseReasons = new Set([
    "PARENT_NOT_INSTALLED",
    "PARENT_DECK_ARCHIVED",
    "PARENT_BASE_CONFLICT",
    "PARENT_AMBIGUOUS",
  ]);
  const localItems = page.items.map((item) => ({
    ...item,
    unmet_prerequisites: item.unmet_prerequisites.filter((parent) =>
      !crossCourseReasons.has(parent.reason)
      && (!parent.owner_deck_id || parent.owner_deck_id === deck.id)),
  })).filter((item) => item.unmet_prerequisites.length);
  if (!localItems.length) return "";
  const reasons = {
    PARENT_MISSING: "The required prerequisite is unavailable.",
    PARENT_UNRESOLVED: "The required prerequisite could not be resolved.",
    PARENT_CARD_ARCHIVED: "The prerequisite card is archived.",
    PARENT_RECALL_REQUIRED: "Review this prerequisite first.",
  };
  return `<div class="study-prerequisites"><h2>Required prerequisites</h2><ul>${localItems.map((item) => `
    <li><strong>${escapeHTML(item.term ?? "Blocked card")}</strong><ul>${item.unmet_prerequisites.slice(0, 5).map((parent) => {
      return `<li>${escapeHTML(parent.term ?? "Required prerequisite")}
        <p class="quiet">${escapeHTML(reasons[parent.reason] ?? "This prerequisite needs attention before the card can be introduced.")}</p>
        </li>`;
    }).join("")}${item.unmet_prerequisites.length > 5 ? `<li>${item.unmet_prerequisites.length - 5} more prerequisites need attention.</li>` : ""}</ul></li>`).join("")}</ul>
    ${page.next_cursor ? `<p class="quiet">Showing ${localItems.length} blocked cards. The graph shows this course's learning order.</p>` : ""}</div>`;
}

function renderStudyNoWork(snapshot, deck, availability, session = null, collectionAvailability = availability) {
  const available = deckAvailability(availability, deck.id);
  const paused = available?.resumable_session;
  const canStart = canStartAvailable(available);
  const extraPracticeOnly = canStart && isExtraPracticeOnly(available);
  const blocked = (available?.blocked_new_count ?? 0) > 0 || paused?.reason === "PREREQUISITE_NOT_SATISFIED";
  const conflict = paused?.reason === "ACTIVE_SESSION_EXISTS";
  const activeElsewhere = snapshot.sessions?.[availability?.active_session?.session_id];
  const returning = activeElsewhere && activeElsewhere.deckId !== deck.id ? activeElsewhere : resumableSessionFor(snapshot, collectionAvailability);
  const canReturn = returning && returning.deckId !== deck.id;
  const alternate = personalDeckArray(snapshot, { availability: collectionAvailability }).find((item) => item.id !== deck.id && canStartAvailable(deckAvailability(collectionAvailability, item.id)));
  const title = !available ? "Study availability unavailable" : extraPracticeOnly ? "No reviews due" : canStart ? "Ready to study" : conflict ? "Another session is active"
    : blocked ? "Prerequisites need attention" : paused?.can_resume === false ? "Paused session needs attention" : "Nothing ready in this deck";
  const pauseMessage = conflict ? " Switch decks to save the active session's place before checking this queue."
    : paused?.reason === "CARD_NOT_FOUND" ? " The paused card is unavailable; your saved queue has not been changed." : "";
  return `<section class="page page-compact" data-study-availability-deck="${escapeAttribute(deck.id)}">
    <header class="page-heading"><div><p class="eyebrow">Study</p><h1>${escapeHTML(deck.title)}</h1></div></header>
    ${emptyState({ title, copy: !available ? "Check again before starting. Your saved place and review history have not changed."
      : `${availabilityLabel(available)}${blocked && available.next_due_at ? ` · ${nextReviewLabel(available.next_due_at)}` : ""}${pauseMessage}${paused || session?.status === "paused" ? " Your paused place is saved." : session?.queue.length === 0 ? " No cards were reviewed in this batch." : ""}`,
      action: `<div class="card-actions">${canStart || conflict ? `<button class="button ${canStart ? "button-primary" : "button-quiet"}" type="button" data-start-deck="${escapeAttribute(deck.id)}">${canStart ? paused ? "Resume studying" : extraPracticeOnly ? "Practice anyway" : "Start studying" : "Switch decks"}</button>` : ""}
        ${canReturn ? `<button class="button" type="button" data-start-deck="${escapeAttribute(returning.deckId)}">Return to ${escapeHTML(snapshot.personalDecks[returning.deckId].title)}</button>`
          : alternate ? `<button class="button" type="button" data-start-deck="${escapeAttribute(alternate.id)}">Study ${escapeHTML(alternate.title)}</button>` : '<a class="button" href="#decks">My Decks</a>'}
        <button class="button button-quiet" type="button" data-back-study>Back home</button></div>`,
    })}
    ${prerequisiteGuidance(deck, availability)}
    <div class="card-actions"><a class="button button-quiet" href="#graph/${escapeAttribute(deck.id)}">View graph</a></div>
  </section>`;
}

function renderSessionComplete(snapshot, session, deck, availability) {
  if (session.queue.length === 0 && session.reviewsApplied === 0) {
    return renderStudyNoWork(snapshot, deck, readStudyAvailability(snapshot, deck.id, 5), session, availability);
  }
  const available = deckAvailability(availability, deck.id);
  const canContinue = canStartAvailable(available);
  const continueLabel = isExtraPracticeOnly(available) ? "Keep practicing" : "Continue studying";
  const mastered = isDeckFullyMastered(metricsForDeck(deck));
  const streak = snapshot.streak;
  const ended = session.status !== "completed";
  const heading = ended ? "Session ended" : "Session complete";
  return `
    <section class="session-shell">
      <header class="session-header"><span class="session-deck-name">${escapeHTML(deck.title)}</span><span></span><a class="button button-sm button-quiet session-exit" href="#study">Done</a></header>
      <div class="session-complete study-session-finale" data-session-completion aria-labelledby="session-completion-title">
        <div>
          <p class="sr-only" role="status">${heading}. ${session.reviewsApplied ? "Your reviewed cards are scheduled." : "No cards were reviewed in this batch."}</p>
          <div class="study-completion-mark" aria-hidden="true"><span>✓</span><i></i><i></i><i></i><i></i></div>
          <p class="eyebrow">${heading}</p>
          <h1 id="session-completion-title">${heading}.</h1>
          <p class="quiet">${session.reviewsApplied ? "Your reviewed cards are scheduled." : "No cards were reviewed in this batch."}</p>
          <p class="quiet" data-study-remaining>${escapeHTML(availabilityLabel(available))}</p>
          ${mastered ? `<div class="mastery-earned" role="status"><span aria-hidden="true">✓</span><div><strong>Deck mastered</strong><small>${hasExampleProgress(deck) ? "Example progress · 100% mastered" : "100% mastery reached. Reviews will keep it strong."}</small></div></div>` : ""}
          <div class="session-summary">
            <div><strong>${session.reviewsApplied}</strong><span>Reviewed</span></div>
            <div><strong>${session.queue.length}</strong><span>Session cards</span></div>
            <div><strong class="summary-streak">${icon("flame")}${streak.current}</strong><span>${escapeHTML(streakBasisLabel(streak))}</span></div>
          </div>
          <div class="card-actions">
            ${canContinue ? `<button class="button button-primary" type="button" data-start-deck="${escapeAttribute(deck.id)}" data-continue-study>${continueLabel}</button>` : ""}
            <a class="button ${canContinue ? "button-quiet" : "button-primary"}" href="#study">Back home</a>
            <a class="button" href="#graph/${escapeAttribute(deck.id)}">View graph</a>
          </div>
          ${!canContinue && (available?.blocked_new_count || available?.resumable_session?.reason === "PREREQUISITE_NOT_SATISFIED") ? `<button class="button button-quiet" type="button" data-start-deck="${escapeAttribute(deck.id)}">View prerequisites</button>` : ""}
        </div>
      </div>
    </section>`;
}

function emptyState({ title, copy, action, iconName = "stack" }) {
  return `
    <div class="empty-state">
      <div class="empty-state-inner">
        <div class="empty-icon">${icon(iconName)}</div>
        <h2>${escapeHTML(title)}</h2>
        <p>${escapeHTML(copy)}</p>
        ${action}
      </div>
    </div>`;
}

function notFound(copy) {
  return `<section class="page page-compact">${emptyState({ title: "Nothing here", copy, action: '<a class="button" href="#study">Return home</a>' })}</section>`;
}

async function showDeckPreview(deckId) {
  const context = captureView();
  const summary = getCatalogDeck(deckId);
  if (!summary || !isViewCurrent(context)) return;
  deckDialogContent.innerHTML = `<div class="deck-dialog-inner"><header class="dialog-header"><div><p class="eyebrow">${escapeHTML(summary.subject)}</p><h2 id="deck-dialog-title">${escapeHTML(summary.title)}</h2></div><button class="icon-button" type="button" data-close-dialog aria-label="Close preview">×</button></header><div class="deck-dialog-loading" role="status">Loading course preview…</div></div>`;
  if (!deckDialog.open) deckDialog.showModal();
  let deck;
  try {
    deck = await loadExactCatalogDeck(deckId, { context });
  } catch (error) {
    if (isViewCurrent(context) && deckDialog.open) {
      deckDialogContent.innerHTML = `<div class="deck-dialog-inner"><header class="dialog-header"><div><h2 id="deck-dialog-title">Preview unavailable</h2></div><button class="icon-button" type="button" data-close-dialog aria-label="Close preview">×</button></header><div class="deck-dialog-loading" role="alert">${escapeHTML(error.message)}</div></div>`;
    }
    return;
  }
  if (!deck || !isViewCurrent(context) || !deckDialog.open) return;
  const snapshot = store.getSnapshot();
  const installed = installedPersonalDeck(deck.id, snapshot);
  deckDialogContent.innerHTML = `
    <div class="deck-dialog-inner">
      <header class="dialog-header">
        <div><p class="eyebrow">${escapeHTML(deck.subject)}</p><h2 id="deck-dialog-title">${escapeHTML(deck.title)}</h2><p class="dialog-deck-count">${formatNumber(deck.cardCount)} cards</p></div>
        <button class="icon-button" type="button" data-close-dialog aria-label="Close preview">×</button>
      </header>
      <div class="deck-dialog-scroll">
        ${deck.coverageSummary ? `<p class="dialog-summary">${escapeHTML(deck.coverageSummary)}</p>` : ""}
        <div class="term-table-wrap" tabindex="0" aria-label="All ${deck.cardCount} terms">
          <table class="term-table">
            <thead><tr><th scope="col">Terms</th></tr></thead>
            <tbody>
              ${deck.cards.map((card) => `<tr><td>${escapeHTML(card.term)}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>
      <div class="dialog-actions">
        <button class="button button-quiet" type="button" data-close-dialog>Close</button>
        <a class="button button-quiet" href="#library-graph/${escapeAttribute(deck.id)}" data-close-dialog>${icon("graph")} Preview graph</a>
        ${installed
          ? installed.archived
            ? `<button class="button button-primary" type="button" data-request-unarchive="${escapeAttribute(deck.id)}" data-catalog-version="${escapeAttribute(installed.source?.catalogVersion ?? "")}">Archived</button>`
            : '<a class="button button-primary" href="#decks" data-close-dialog>Open My Decks</a>'
          : `<button class="button button-primary" type="button" data-add-deck="${escapeAttribute(deck.id)}" data-version="${escapeAttribute(deck.version)}">Add</button>`}
      </div>
    </div>`;
}

function showLibraryUnarchiveConfirmation(catalogId, catalogVersion) {
  const snapshot = store.getSnapshot();
  const installed = installedPersonalDeck(catalogId, snapshot, catalogVersion);
  if (!installed?.archived) {
    toast("This archived course changed. Refresh the Library and try again.");
    return queueRender();
  }
  deckDialogContent.innerHTML = `
    <div class="deck-dialog-inner library-added-dialog library-unarchive-dialog">
      <header class="dialog-header">
        <div><p class="eyebrow">Archived course</p><h2 id="deck-dialog-title">Unarchive?</h2></div>
        <button class="icon-button" type="button" data-close-dialog aria-label="Close unarchive confirmation">×</button>
      </header>
      <div class="deck-dialog-scroll">
        <p class="dialog-summary">Restore ${escapeHTML(installed.title)} to My Decks with its existing progress and review history?</p>
      </div>
      <div class="dialog-actions">
        <button class="button button-quiet" type="button" data-close-dialog>Cancel</button>
        <button class="button button-primary" type="button" data-confirm-library-unarchive="${escapeAttribute(installed.id)}" data-revision="${installed.revision}" data-catalog-id="${escapeAttribute(catalogId)}" data-catalog-version="${escapeAttribute(catalogVersion)}">Unarchive</button>
      </div>
    </div>`;
  if (!deckDialog.open) deckDialog.showModal();
}

function closeStudyNonAnswerConfirmation({ restoreFocus = false } = {}) {
  const warning = view.querySelector("[data-study-nonanswer-warning]");
  if (!warning) return;
  const action = warning.dataset.studyNonanswerAction;
  warning.close?.();
  warning.remove();
  if (restoreFocus) {
    view.querySelector(action === "reveal" ? "[data-reveal-answer]" : "[data-skip-card]")?.focus();
  }
}

function studyNonAnswerRequest(session, card, action) {
  return { dataset: {
    studyNonanswerAction: action,
    sessionId: session.id,
    sessionRevision: String(session.revision),
    cardId: card.id,
  } };
}

function showStudyNonAnswerConfirmation(sessionId, action, context = captureView()) {
  const snapshot = store.getSnapshot();
  const session = snapshot.sessions?.[sessionId];
  const deck = snapshot.personalDecks?.[session?.deckId];
  const card = session?.currentCardId ? deck?.cards?.[session.currentCardId] : null;
  const reveal = action === "reveal";
  if (!reveal && action !== "skip") return;
  if (!studyNonAnswerSupported(action, snapshot) || session?.status !== "active" || session.phase !== "awaiting_answer" || !card) {
    toast(`${reveal ? "Reveal" : "Skip"} is not available for this card.`);
    return;
  }
  const openWarning = view.querySelector("[data-study-nonanswer-warning]");
  if (openWarning) {
    if (openWarning.dataset.studyNonanswerAction === action) {
      openWarning.querySelector("[data-cancel-study-nonanswer]")?.focus();
      return;
    }
    closeStudyNonAnswerConfirmation();
  }
  clearStudyHelp({ preserveKey: true });
  ui.studyHelpShown = false;
  ui.studyHelpDismissed = true;
  const request = studyNonAnswerRequest(session, card, action);
  if (ui.studyNonAnswerAcknowledgedSessions.has(session.id)) {
    return submitNonAnswerCard(request, context);
  }
  const shell = view.querySelector(`[data-session-id="${escapeAttribute(session.id)}"]`);
  const controls = shell?.dataset.sessionId === session.id ? shell.querySelector(".study-controls") : null;
  if (!controls) return;
  const warning = document.createElement("dialog");
  warning.className = `study-nonanswer-warning study-${action}-warning`;
  warning.dataset.studyNonanswerWarning = "true";
  warning.dataset.studyNonanswerAction = action;
  warning.setAttribute("role", "dialog");
  warning.setAttribute("aria-modal", "false");
  warning.setAttribute("aria-labelledby", "study-nonanswer-title");
  warning.setAttribute("aria-describedby", "study-nonanswer-copy");
  warning.innerHTML = `
    <div class="study-nonanswer-warning-copy">
      <strong id="study-nonanswer-title">${reveal ? "Reveal and mark Again?" : "Skip and mark Again?"}</strong>
      <p id="study-nonanswer-copy">${reveal
        ? "You’ll see the definition, and this card will return sooner."
        : "The definition stays hidden, and this card will return sooner."}</p>
      <span>Confirm once and we won’t ask again this session.</span>
    </div>
    <div class="study-nonanswer-warning-actions">
      <button class="button button-sm button-quiet" type="button" data-cancel-study-nonanswer>Cancel</button>
      <button class="button button-sm study-nonanswer-confirm" type="button" data-confirm-study-nonanswer data-study-nonanswer-action="${escapeAttribute(action)}" data-session-id="${escapeAttribute(session.id)}" data-session-revision="${session.revision}" data-card-id="${escapeAttribute(card.id)}">${reveal ? "Reveal answer" : "Skip card"}</button>
    </div>`;
  controls.append(warning);
  warning.show();
  warning.querySelector("[data-cancel-study-nonanswer]")?.focus();
}

async function submitNonAnswerCard(control, context) {
  if (!isViewCurrent(context) || ui.mutationBusy) return;
  const snapshot = store.getSnapshot();
  const action = control.dataset.studyNonanswerAction;
  if (!studyNonAnswerSupported(action, snapshot)) return toast("This action is not available yet.");
  const session = snapshot.sessions?.[control.dataset.sessionId];
  if (session?.status !== "active" || session.phase !== "awaiting_answer" ||
      session.revision !== Number(control.dataset.sessionRevision) ||
      session.currentCardId !== control.dataset.cardId) {
    closeStudyNonAnswerConfirmation();
    toast("This card changed. Open the action again before continuing.");
    return queueRender();
  }
  ui.mutationBusy = true;
  try {
    const current = await store.getStudySession({ session_id: session.id });
    if (!isViewCurrent(context)) return;
    if (current?.session?.session_revision !== session.revision ||
        !current.current_card || localReviewedCard(snapshot.personalDecks?.[session.deckId], current.current_card.card_id)?.id !== session.currentCardId) {
      throw new Error("This card changed. Reload it before continuing.");
    }
    const result = await uiMutation("submitGrade", {
      session_id: session.id,
      expected_session_revision: current.session.session_revision,
      card_id: current.current_card.card_id,
      expected_card_revision: current.current_card.card_revision,
      attempt_kind: action,
      answer_text: null,
      answer_origin: "website",
      rating: "again",
      rubric_evidence: (current.current_card.required_concepts ?? []).map((item) => ({
        rubric_item_id: item.rubric_item_id,
        status: "missed",
        note: action === "reveal" ? "Answer revealed before responding." : "Skipped before answering.",
      })),
      feedback: action === "reveal"
        ? "You revealed this card before answering. Review the definition and try it again."
        : "You skipped this card before answering. It was marked Again.",
      misconceptions: [],
      confidence: 1,
      idempotency_key: actionId(`${action}-card`),
    }, context);
    if (!result || !isViewCurrent(context)) return;
    closeStudyNonAnswerConfirmation();
    await presentStudyGradeCommit({
      type: "study_grade_committed",
      session_id: result.session_id,
      reviewed_card_id: result.card_id,
      reviewed_card: result.reviewed_card,
      session: result.session,
      ...(result.next_card ? { next_card: result.next_card } : {}),
      rating: result.rating,
      attempt_kind: result.attempt_kind ?? action,
      presentation_action: action,
      completion_state: result.session?.status === "completed" ? "completed" : "in_progress",
    }, context, () => !accountMode || context.session.isStudyCurrent());
  } catch (error) {
    if (isViewCurrent(context)) toast(error.message);
  } finally {
    if (isViewCurrent(context)) ui.mutationBusy = false;
  }
}

function startManualGrade(sessionId) {
  if (!manualGradeAvailable() || ui.mutationBusy) return;
  const snapshot = store.getSnapshot();
  const session = snapshot.sessions?.[sessionId];
  const deck = snapshot.personalDecks?.[session?.deckId];
  const card = session?.currentCardId ? deck?.cards?.[session.currentCardId] : null;
  if (session?.status !== "active" || session.phase !== "awaiting_answer" || !card || card.archived) {
    toast("This card changed. Open manual grading again before continuing.");
    return queueRender();
  }
  closeStudyNonAnswerConfirmation();
  clearStudyHelp({ preserveKey: true });
  ui.studyHelpDismissed = true;
  ui.manualGrade = {
    sessionId: session.id,
    sessionRevision: session.revision,
    cardId: card.id,
    idempotencyKey: actionId("self-grade"),
    rating: null,
  };
  const scene = view.querySelector("[data-study-card-scene]");
  const definition = scene?.querySelector("[data-study-definition]");
  const actions = view.querySelector(".study-control-actions");
  const status = view.querySelector("[data-study-live-status]");
  if (!scene || !definition || !actions || scene.dataset.cardId !== card.id) {
    return queueRender();
  }
  renderDefinition(definition, card.definition);
  revealStudyCardFaces(scene);
  scene.classList.add("is-flipped");
  scene.closest("[data-card-stack]")?.setAttribute("data-study-card-phase", "manual-grade");
  actions.classList.add("has-manual-grades");
  actions.innerHTML = manualGradeChoicesMarkup();
  status?.replaceChildren("Answer revealed. Choose your grade.");
  actions.querySelector('[data-submit-self-grade="again"]')?.focus();
}

async function submitManualGrade(control, context) {
  if (!isViewCurrent(context) || ui.mutationBusy) return;
  const rating = control.dataset.submitSelfGrade;
  if (!["again", "hard", "good", "easy"].includes(rating)) return;
  const snapshot = store.getSnapshot();
  const session = snapshot.sessions?.[ui.manualGrade?.sessionId];
  const deck = snapshot.personalDecks?.[session?.deckId];
  const card = session?.currentCardId ? deck?.cards?.[session.currentCardId] : null;
  if (!manualGradeMatches(session, card)) {
    ui.manualGrade = null;
    toast("This card changed. Open manual grading again before continuing.");
    return queueRender();
  }
  if (ui.manualGrade.rating && ui.manualGrade.rating !== rating) return;
  ui.manualGrade.rating = rating;
  const buttons = [...(control.closest("[data-study-manual-grades]")?.querySelectorAll("button") ?? [])];
  buttons.forEach((button) => { button.disabled = true; });
  ui.mutationBusy = true;
  try {
    const current = await store.getStudySession({ session_id: session.id });
    if (!isViewCurrent(context)) return;
    if (current?.session?.session_revision !== session.revision ||
        !current.current_card || localReviewedCard(deck, current.current_card.card_id)?.id !== card.id) {
      throw new Error("This card changed. Reload it before continuing.");
    }
    const result = await uiMutation("submitSelfGrade", {
      session_id: session.id,
      expected_session_revision: current.session.session_revision,
      card_id: current.current_card.card_id,
      expected_card_revision: current.current_card.card_revision,
      rating,
      idempotency_key: ui.manualGrade.idempotencyKey,
    }, context);
    if (!result || !isViewCurrent(context)) return;
    ui.manualGrade = null;
    await presentStudyGradeCommit({
      type: "study_grade_committed",
      session_id: result.session_id,
      reviewed_card_id: result.card_id,
      reviewed_card: result.reviewed_card,
      session: result.session,
      ...(result.next_card ? { next_card: result.next_card } : {}),
      rating: result.rating,
      presentation_action: "answer",
      completion_state: result.session?.status === "completed" ? "completed" : "in_progress",
    }, context, () => !accountMode || context.session.isStudyCurrent());
  } catch (error) {
    if (isViewCurrent(context)) {
      buttons.forEach((button) => {
        button.disabled = button.dataset.submitSelfGrade !== ui.manualGrade?.rating;
      });
      const retryLabel = control.querySelector("span");
      if (retryLabel) retryLabel.textContent = "Try again";
      toast(error.message);
    }
  } finally {
    if (isViewCurrent(context)) ui.mutationBusy = false;
  }
}

function cancelManualGrade() {
  if (!ui.manualGrade || ui.manualGrade.rating || ui.mutationBusy) return;
  ui.manualGrade = null;
  queueRender();
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
  clearTimeout(ui.librarySearchTimer);
  clearTimeout(ui.revealTimer);
  clearTimeout(ui.availabilityTimer);
  ui.librarySearchTimer = null;
  clearStudyHelp();
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
  if (!completesReveal && view.querySelector("[data-study-advance-pending]")) return;
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

function queueLibrarySearch(delay = 80) {
  if (ui.failed) return;
  const context = captureView();
  if (!isViewCurrent(context)) return;
  clearTimeout(ui.librarySearchTimer);
  ui.librarySearchTimer = setTimeout(() => {
    ui.librarySearchTimer = null;
    if (!isViewCurrent(context) || getRoute().name !== "library") return;
    const results = view.querySelector("[data-library-results]");
    if (!results) return queueRender();
    results.innerHTML = renderLibraryResults(store.getSnapshot());
  }, delay);
}

function captureLibrarySearchSelection() {
  const input = view.querySelector("[data-library-search]");
  return captureSearchFieldState(document.activeElement, input);
}

function restoreLibrarySearchSelection(selection) {
  const input = view.querySelector("[data-library-search]");
  return restoreSearchFieldState(input, selection);
}

function closeOverlayDialogs() {
  closeStudyNonAnswerConfirmation();
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
  const librarySearchSelection = route.name === "library" ? captureLibrarySearchSelection() : null;
  if (route.name !== "library") {
    clearTimeout(ui.librarySearchTimer);
    ui.librarySearchTimer = null;
  }
  if (route.name !== "session") {
    clearStudyHelp();
    ui.manualGrade = null;
  }
  if (route.name !== "study") ui.emptyStudyDeckId = null;
  setActiveNav(route);
  const beforeViewSync = store.getSnapshot();
  const selectedDeckId = route.name === "graph" && beforeViewSync.personalDecks?.[route.id]
    ? route.id
    : route.name === "session"
      ? beforeViewSync.sessions?.[route.id]?.deckId
      : undefined;
  store.setView({
    route: route.name === "library-graph" ? "library" : route.name,
    ...(selectedDeckId ? { selectedDeckId } : {}),
  });
  const snapshot = store.getSnapshot();
  const availability = ["study", "decks", "session"].includes(route.name) ? readStudyAvailability(snapshot) : null;
  if (!isViewCurrent(context)) return;
  if (demoMode === "error") throw new Error("This is the intentional error-state preview.");

  if (route.name === "library-graph") {
    const catalogDeck = await loadExactCatalogDeck(route.id, { context });
    if (!isViewCurrent(context)) return;
    if (!catalogDeck) {
      view.innerHTML = notFound("That Library graph is not available.");
    } else {
      const deck = graphForCatalog(catalogDeck, library);
      ui.graphCleanup = mountGraphView(view, {
        deck,
        cardStates: {},
        progressSource: "structure",
        storage: workspace.storage,
        canStudy: false,
        showEntireGraph: true,
        onBack: () => { if (isViewCurrent(context)) location.hash = "library"; },
        backAriaLabel: "Close graph and return to Library",
      });
    }
  } else if (route.name === "graph") {
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
        progressSource: "learner",
        focusCardId: deck.rootCardIds[0] ?? null,
        storage: workspace.storage,
        pulseCardId: activePulse,
        canStudy: true,
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
    const canonicalRenderedSession = snapshot.sessions?.[route.id];
    const pendingReveal = pendingStudyRevealFor(snapshot, route.id);
    const renderedSession = pendingReveal ? {
      ...canonicalRenderedSession,
      status: "active",
      phase: "answer_committed",
      currentCardId: pendingReveal.cardId,
    } : canonicalRenderedSession;
    const renderedDeck = snapshot.personalDecks?.[renderedSession?.deckId];
    const renderedCard = renderedSession?.currentCardId ? renderedDeck?.cards?.[renderedSession.currentCardId] : null;
    if (renderedSession?.status === "active" && renderedCard && !renderedCard.archived) {
      syncStudyHelp(renderedSession, renderedCard,
        renderedSession.phase === "answer_committed" || manualGradeMatches(renderedSession, renderedCard));
    } else {
      clearStudyHelp();
    }
    applyStudySupersededState();
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
  if (!restoreLibrarySearchSelection(librarySearchSelection)) view.focus?.({ preventScroll: true });
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
    if (accountMode) {
      await context.session.beginStudy();
      if (!isViewCurrent(context)) return;
      ui.studySuperseded = false;
    }
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
    if (isViewCurrent(context)) {
      if (accountMode && error?.code === "WRITER_ALREADY_ACTIVE") showRemoteStudyTakeover(deckId);
      else toast(error.message);
      queueRender();
    }
  } finally { if (isViewCurrent(context)) ui.mutationBusy = false; }
}

async function pauseSession(sessionId, context = captureView()) {
  if (!isViewCurrent(context)) return;
  const session = store.getSnapshot().sessions?.[sessionId];
  if (session?.status !== "active") return;
  const result = await uiMutation("finishStudySession", {
    session_id: session.id,
    disposition: "pause",
    expected_session_revision: session.revision,
    idempotency_key: actionId("pause-session"),
  }, context);
  if (result && accountMode && isViewCurrent(context)) {
    await context.session.releaseStudy({ clearBlock: true });
  }
  return result;
}

function localReviewedCard(deck, submittedId) {
  if (!deck || !submittedId) return null;
  if (Object.hasOwn(deck.cards, submittedId)) return deck.cards[submittedId];
  const prefix = `${deck.id}.`;
  if (submittedId.startsWith(prefix)) return deck.cards[submittedId.slice(prefix.length)] ?? null;
  return null;
}

function latestCommittedRating(snapshot, sessionId, reviewedCardId) {
  const session = snapshot.sessions?.[sessionId];
  const localId = reviewedCardId?.startsWith(`${session?.deckId}.`)
    ? reviewedCardId.slice(session.deckId.length + 1)
    : reviewedCardId;
  return [...(session?.history ?? [])].reverse().find((event) =>
    event?.transition === "grade_submitted" &&
    [reviewedCardId, localId].includes(event.cardId) &&
    Object.hasOwn(STUDY_OUTCOME_LABELS, event.rating))?.rating ?? null;
}

function pendingStudyRevealStorageKey() {
  const workspaceKey = accountMode
    ? "account"
    : `local:${workspace?.recordingId || "default"}`;
  return `${STUDY_PENDING_REVEAL_STORAGE_KEY}:${workspaceKey}`;
}

function pendingStudyRevealStorages() {
  const storages = [];
  for (const name of ["sessionStorage", "localStorage"]) {
    try {
      const candidate = globalThis[name];
      if (candidate && typeof candidate.getItem === "function" &&
          typeof candidate.setItem === "function" && typeof candidate.removeItem === "function" &&
          !storages.includes(candidate)) storages.push(candidate);
    } catch { /* A blocked browser store may fall back to the next one. */ }
  }
  return storages;
}

function storedPendingStudyReveal() {
  const key = pendingStudyRevealStorageKey();
  for (const storage of pendingStudyRevealStorages()) {
    try {
      const raw = storage.getItem(key);
      if (raw === null) continue;
      try { return JSON.parse(raw); }
      catch { storage.removeItem(key); }
    } catch { /* Try the next browser store. */ }
  }
  return null;
}

function clearPendingStudyReveal(expectedSessionId = null) {
  const key = pendingStudyRevealStorageKey();
  for (const storage of pendingStudyRevealStorages()) {
    try {
      if (expectedSessionId !== null) {
        const raw = storage.getItem(key);
        if (raw === null) continue;
        let value;
        try { value = JSON.parse(raw); }
        catch { value = null; }
        if (value?.sessionId !== expectedSessionId) continue;
      }
      storage.removeItem(key);
    } catch { /* Presentation cleanup must never block canonical study state. */ }
  }
}

function rememberPendingStudyReveal(snapshot, value, presentationAction) {
  if (!["answer", "reveal"].includes(presentationAction)) return;
  const session = snapshot.sessions?.[value.session_id];
  const deck = snapshot.personalDecks?.[session?.deckId];
  const card = localReviewedCard(deck, value.reviewed_card_id);
  if (!session || !deck || !card) return;
  const event = [...(session.history ?? [])].reverse().find((item) =>
    item?.transition === "grade_submitted" && item.cardId === card.id &&
    Object.hasOwn(STUDY_OUTCOME_LABELS, item.rating));
  if (!event) return;
  const completionState = session.status === "completed" ? "completed" : "in_progress";
  const marker = {
    version: 1,
    sessionId: session.id,
    sessionRevision: session.revision,
    sessionUpdatedAt: session.updatedAt,
    deckId: deck.id,
    cardId: card.id,
    reviewId: event.reviewId ?? null,
    rating: event.rating,
    presentationAction,
    completionState,
  };
  const key = pendingStudyRevealStorageKey();
  for (const storage of pendingStudyRevealStorages()) {
    try {
      storage.setItem(key, JSON.stringify(marker));
      return;
    } catch { /* Try the next browser store. */ }
  }
}

function pendingStudyRevealFor(snapshot, sessionId) {
  const marker = storedPendingStudyReveal();
  if (!marker || marker.version !== 1 || marker.sessionId !== sessionId) return null;
  const session = snapshot.sessions?.[sessionId];
  if (!session || Number(session.revision) < Number(marker.sessionRevision)) return null;
  const invalid = () => {
    clearPendingStudyReveal(sessionId);
    return null;
  };
  if (Number(session.revision) !== Number(marker.sessionRevision) ||
      session.updatedAt !== marker.sessionUpdatedAt || session.deckId !== marker.deckId ||
      !["answer", "reveal"].includes(marker.presentationAction) ||
      !["completed", "in_progress"].includes(marker.completionState) ||
      !Object.hasOwn(STUDY_OUTCOME_LABELS, marker.rating) || Number(session.cursor) <= 0) return invalid();
  const deck = snapshot.personalDecks?.[marker.deckId];
  const card = deck?.cards?.[marker.cardId];
  if (!card || card.archived || session.queue?.[session.cursor - 1] !== marker.cardId) return invalid();
  const event = [...(session.history ?? [])].reverse().find((item) => item?.transition === "grade_submitted");
  if (!event || event.cardId !== marker.cardId || event.rating !== marker.rating ||
      (marker.reviewId !== null && event.reviewId !== marker.reviewId)) return invalid();
  const expectedState = marker.completionState === "completed"
    ? session.status === "completed" && session.phase === "complete" && !session.currentCardId
    : session.status === "active" && session.phase === "awaiting_answer" && Boolean(session.currentCardId);
  if (!expectedState) return invalid();
  return marker;
}

function revealStudyCardFaces(scene) {
  const front = scene.querySelector(".study-card-front");
  const back = scene.querySelector(".study-card-back");
  front?.setAttribute("aria-hidden", "true");
  front?.setAttribute("inert", "");
  back?.setAttribute("aria-hidden", "false");
  back?.removeAttribute("inert");
}

async function presentStudyGradeCommit(value, context, studyIsCurrent = () => true) {
  const snapshot = store.getSnapshot();
  const session = snapshot.sessions?.[value.session_id];
  const deck = snapshot.personalDecks?.[session?.deckId];
  const card = localReviewedCard(deck, value.reviewed_card_id);
  if (card) ui.graphPulse = { deckId: deck.id, cardId: card.id, at: Date.now() };
  const presentationAction = ["reveal", "skip"].includes(value.presentation_action)
    ? value.presentation_action
    : ["reveal", "skip"].includes(value.attempt_kind)
      ? value.attempt_kind
      : "answer";
  rememberPendingStudyReveal(snapshot, value, presentationAction);
  const scene = view.querySelector("[data-study-card-scene]");
  const definition = scene?.querySelector("[data-study-definition]");
  const status = view.querySelector("[data-study-live-status]");
  const shell = scene?.closest("[data-session-id]");
  const actions = shell?.querySelector(".study-control-actions");
  if (!scene || !definition || !actions || !card ||
      shell?.dataset.sessionId !== value.session_id ||
      scene.dataset.cardId !== card.id) {
    view.querySelector("[data-study-advance-pending]")?.removeAttribute("data-study-advance-pending");
    queueRender(0, null, true);
    return;
  }
  // A previously queued metadata refresh must not cut this committed reveal short.
  clearTimeout(ui.renderTimer);
  ui.renderTimer = null;
  closeStudyNonAnswerConfirmation();
  clearStudyHelp({ preserveKey: true });
  ui.studyHelpDismissed = true;
  const rating = Object.hasOwn(STUDY_OUTCOME_LABELS, value.rating)
    ? value.rating
    : latestCommittedRating(snapshot, value.session_id, value.reviewed_card_id) ?? "saved";
  const badge = view.querySelector("[data-study-outcome-badge]");
  const stack = scene.closest("[data-card-stack]");
  scene.dataset.studyOutcome = rating;
  if (stack) stack.dataset.studyOutcome = rating;
  if (badge) {
    badge.hidden = false;
    badge.textContent = STUDY_OUTCOME_LABELS[rating];
  }
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const waitForReveal = (delay) => new Promise((resolve) => setTimeout(resolve, delay));
  if (presentationAction === "skip") {
    status?.replaceChildren(`${STUDY_OUTCOME_LABELS[rating]}. Moving to the next card without revealing the answer.`);
    scene.classList.add("is-skipping");
    ui.revealingUntil = Date.now() + (reducedMotion ? 420 : 900);
    await waitForReveal(reducedMotion ? 420 : 620);
    if (!isViewCurrent(context) || !studyIsCurrent() || !scene.isConnected) return;
    scene.classList.add("is-departing");
    await waitForReveal(reducedMotion ? 0 : 280);
    if (!isViewCurrent(context) || !studyIsCurrent()) return;
    queueRender(0, null, true);
    return;
  }
  renderDefinition(definition, value.reviewed_card?.definition_md ?? card.definition ?? "");
  const crossedDueBoundary = shell?.dataset.queuePhase === "due"
    && value.session?.queue_phase === "continuous";
  const nextLabel = value.completion_state === "completed" ? "Finish session" : "Next card";
  status?.replaceChildren(`${STUDY_OUTCOME_LABELS[rating]}. ${crossedDueBoundary
    ? "Due cards complete. Review the definition, then continue to extra practice."
    : value.completion_state === "completed"
      ? "Review the definition, then finish the session when you are ready."
      : "Review the definition, then choose Next card when you are ready."}`);
  revealStudyCardFaces(scene);
  scene.classList.add("is-flipped");
  ui.revealingUntil = 0;
  shell.setAttribute("data-study-advance-pending", "true");
  const next = document.createElement("button");
  next.type = "button";
  next.className = "button button-sm button-primary study-next-action";
  next.dataset.advanceStudyCard = "true";
  next.textContent = nextLabel;
  actions.replaceChildren(next);
  actions.classList.remove("has-manual-grades");
  actions.classList.add("has-study-next");
}

function advancePresentedStudyCard(advanceStudyCard) {
  const shell = advanceStudyCard?.closest("[data-study-advance-pending]");
  if (!shell || advanceStudyCard.disabled) return false;
  clearPendingStudyReveal(shell.dataset.sessionId);
  shell.removeAttribute("data-study-advance-pending");
  advanceStudyCard.disabled = true;
  shell.querySelector("[data-study-live-status]")?.replaceChildren("Loading the next card.");
  const scene = shell.querySelector("[data-study-card-scene]");
  const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 280;
  scene?.classList.add("is-departing");
  ui.revealingUntil = Date.now() + delay;
  queueRender(delay, null, true);
  return true;
}

async function handleVisibleEffect(effect, metadata = {}) {
  const context = accountMode ? { session: accountSession, ticket: metadata.execution_context } : captureView();
  if (!isViewCurrent(context)) return;
  const value = effect?.visible_effect ?? effect ?? {};
  const hasStudyExecution = accountMode && metadata.study_execution_context !== undefined;
  const studyIsCurrent = () => !hasStudyExecution || context.session.isStudyCurrent(metadata.study_execution_context);
  if (!studyIsCurrent()) return;
  if (accountMode) {
    try { await context.session.refresh(context.ticket); }
    catch {
      if (isViewCurrent(context)) showFatal(new Error("Your grade or deck change was saved. Reconnect to load its confirmed state; do not submit it again."));
      return;
    }
    if (!isViewCurrent(context) || !studyIsCurrent()) return;
  }
  if (value.type === "study_grade_committed") {
    return presentStudyGradeCommit(value, context, studyIsCurrent);
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
  if (target.closest("[data-show-study-help]")) {
    showStudyHelpNow();
    return;
  }
  if (target.closest("[data-dismiss-study-help]")) {
    clearTimeout(ui.studyHelpTimer);
    ui.studyHelpTimer = null;
    ui.studyHelpStartedAt = 0;
    ui.studyHelpShown = false;
    ui.studyHelpDismissed = true;
    view.querySelector("[data-study-agent-help]")?.remove();
    view.querySelector("[data-show-study-help]")?.setAttribute("aria-expanded", "false");
    return;
  }
  if (target.closest("[data-copy-study-link]")) {
    try {
      await navigator.clipboard.writeText(location.href);
      toast("Study page link copied");
    } catch { toast("The page link could not be copied."); }
    return;
  }
  const advanceStudyCard = target.closest("[data-advance-study-card]");
  if (advanceStudyCard) {
    advancePresentedStudyCard(advanceStudyCard);
    return;
  }
  const startSelfGrade = target.closest("[data-start-self-grade]");
  if (startSelfGrade) {
    const shell = startSelfGrade.closest("[data-session-id]");
    if (shell) startManualGrade(shell.dataset.sessionId);
    return;
  }
  if (target.closest("[data-cancel-self-grade]")) {
    cancelManualGrade();
    return;
  }
  const selfGrade = target.closest("[data-submit-self-grade]");
  if (selfGrade) return submitManualGrade(selfGrade, context);
  const revealAnswer = target.closest("[data-reveal-answer]");
  if (revealAnswer) {
    const shell = revealAnswer.closest("[data-session-id]");
    if (shell) return showStudyNonAnswerConfirmation(shell.dataset.sessionId, "reveal", context);
    return;
  }
  const skipCard = target.closest("[data-skip-card]");
  if (skipCard) {
    const shell = skipCard.closest("[data-session-id]");
    if (shell) return showStudyNonAnswerConfirmation(shell.dataset.sessionId, "skip", context);
    return;
  }
  if (target.closest("[data-cancel-study-nonanswer]")) {
    closeStudyNonAnswerConfirmation({ restoreFocus: true });
    return;
  }
  const confirmNonAnswer = target.closest("[data-confirm-study-nonanswer]");
  if (confirmNonAnswer) {
    ui.studyNonAnswerAcknowledgedSessions.add(confirmNonAnswer.dataset.sessionId);
    return submitNonAnswerCard(confirmNonAnswer, context);
  }
  if (target.closest("[data-back-study], [data-nav='study']")) {
    ui.emptyStudyDeckId = null;
    if (target.closest("[data-back-study]")) location.hash = "study";
    queueRender();
    return;
  }
  if (accountMode && target.closest("[data-take-over-study]")) {
    if (ui.mutationBusy) return;
    ui.mutationBusy = true;
    try {
      await context.session.takeOverStudy();
      if (!isViewCurrent(context)) return;
      ui.studySuperseded = false;
      view.querySelector("[data-study-advance-pending]")?.removeAttribute("data-study-advance-pending");
      toast("Study is active in this tab");
      queueRender();
    } catch (error) { if (isViewCurrent(context)) toast(error.message); }
    finally { if (isViewCurrent(context)) ui.mutationBusy = false; }
    return;
  }
  if (accountMode && target.closest("[data-confirm-server-takeover]")) {
    if (ui.mutationBusy) return;
    const deckId = target.closest("[data-confirm-server-takeover]").dataset.confirmServerTakeover;
    ui.mutationBusy = true;
    try {
      await context.session.takeOverStudy();
      if (!isViewCurrent(context)) return;
      ui.studySuperseded = false;
      deckDialog.close();
      ui.mutationBusy = false;
      await startSession(deckId);
    } catch (error) { if (isViewCurrent(context)) toast(error.message); }
    finally { if (isViewCurrent(context)) ui.mutationBusy = false; }
    return;
  }
  if (accountMode && target.closest("[data-preview-local-claim]")) {
    try {
      const preview = await context.session.previewLocalClaim();
      if (!isViewCurrent(context)) return;
      claimPreview = preview;
      settingsDialog.querySelector("[data-claim-confirmation]").innerHTML = `<p class="account-note">Copy ${formatNumber(claimPreview.bytes)} bytes into this signed-in account? This is a one-time copy, including any existing example progress. The browser workspace and exact backup remain unchanged. This will not merge with existing account data.</p><button class="button button-primary" type="button" data-confirm-local-claim>Copy to this account</button><button class="button button-quiet" type="button" data-cancel-local-claim>Cancel</button>`;
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
    if (accountMode) {
      restoreConnectedAccountDialog(accountSession?.accountBinding);
      showAccountSettings();
    }
    return accountDialog?.showModal();
  }
  if (target.closest("[data-open-settings]")) {
    if (accountMode) showAccountSettings();
    accountDialog?.close();
    return settingsDialog?.showModal();
  }
  if (target.closest("[data-close-account]")) return accountDialog?.close();
  if (target.closest("[data-close-settings]")) return settingsDialog?.close();
  const unarchiveRequest = target.closest("[data-request-unarchive]");
  if (unarchiveRequest) {
    return showLibraryUnarchiveConfirmation(
      unarchiveRequest.dataset.requestUnarchive,
      unarchiveRequest.dataset.catalogVersion,
    );
  }
  const unarchiveConfirm = target.closest("[data-confirm-library-unarchive]");
  if (unarchiveConfirm) {
    if (ui.mutationBusy) return;
    const snapshot = store.getSnapshot();
    const deck = snapshot.personalDecks?.[unarchiveConfirm.dataset.confirmLibraryUnarchive];
    const exactMatch = deck?.archived &&
      deck.revision === Number(unarchiveConfirm.dataset.revision) &&
      deck.source?.catalogDeckId === unarchiveConfirm.dataset.catalogId &&
      String(deck.source?.catalogVersion) === String(unarchiveConfirm.dataset.catalogVersion);
    if (!exactMatch) {
      if (deckDialog.open) deckDialog.close();
      toast("This archived course changed. Open it again before restoring.");
      return queueRender();
    }
    ui.mutationBusy = true;
    try {
      const result = await uiMutation("setDeckArchived", {
        deck_id: deck.id,
        archived: false,
        expected_revision: deck.revision,
        client_action_id: actionId("unarchive-library-deck"),
      }, context);
      if (!result || !isViewCurrent(context)) return;
      if (deckDialog.open) deckDialog.close();
      toast(`${result.deck.title} restored with its saved progress`);
      return queueRender();
    } catch (error) {
      if (isViewCurrent(context)) return toast(error.message);
    } finally { if (isViewCurrent(context)) ui.mutationBusy = false; }
  }
  if (target.closest("[data-open-archived]")) {
    if (deckDialog.open) deckDialog.close();
    ui.deckStatus = "archived";
    location.hash = "decks";
    return;
  }
  if (target.closest("[data-close-dialog]")) return deckDialog.close();
  if (target.closest("[data-preview-deck]")) return showDeckPreview(target.closest("[data-preview-deck]").dataset.previewDeck);
  if (target.closest("[data-clear-library]")) {
    clearTimeout(ui.librarySearchTimer);
    ui.librarySearchTimer = null;
    ui.catalogQuery = "";
    ui.catalogSubject = "All";
    ui.catalogEvidence = "All";
    ui.catalogLimit = 24;
    return queueRender(0, () => view.querySelector("[data-library-search]")?.focus({ preventScroll: true }));
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
    ui.archiveConfirmDeckId = null;
    ui.deleteUnavailableDeckId = null;
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
      ui.mutationBusy = false;
      ui.deckStatus = "active";
      queueRender(0, () => toast(`${result.deck.title} added`, {
        actionLabel: "Study",
        duration: 8000,
        onAction: () => startSession(result.deck.id),
      }));
      return;
    } catch (error) {
      if (isViewCurrent(context)) return toast(error.message);
    } finally { if (isViewCurrent(context)) ui.mutationBusy = false; }
  }
  if (accountMode && target.closest("[data-reset-local]")) return;
  const deleteUnavailable = target.closest("[data-delete-unavailable]");
  if (deleteUnavailable) {
    ui.archiveConfirmDeckId = null;
    ui.deleteUnavailableDeckId = deleteUnavailable.dataset.deleteUnavailable;
    return queueRender(0, () => view.querySelector("[data-close-delete-unavailable]")?.focus());
  }
  if (target.closest("[data-close-delete-unavailable]")) {
    const deckId = ui.deleteUnavailableDeckId;
    ui.deleteUnavailableDeckId = null;
    return queueRender(0, () => {
      [...view.querySelectorAll("[data-delete-unavailable]")]
        .find((button) => button.dataset.deleteUnavailable === deckId)
        ?.focus();
    });
  }
  const archiveRequest = target.closest("[data-request-archive]");
  if (archiveRequest) {
    ui.deleteUnavailableDeckId = null;
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
    if (ui.mutationBusy) return;
    ui.mutationBusy = true;
    try {
      const result = await uiMutation("setDeckArchived", {
        deck_id: archiveConfirm.dataset.confirmArchive,
        archived: true,
        expected_revision: Number(archiveConfirm.dataset.revision),
        client_action_id: actionId("archive-deck"),
      }, context);
      if (!result || !isViewCurrent(context)) return;
      ui.archiveConfirmDeckId = null;
      toast(`${result.deck.title} archived`, {
        actionLabel: "Undo",
        duration: 8000,
        onAction: async () => {
          if (ui.mutationBusy) return;
          const undoContext = captureView();
          if (!isViewCurrent(undoContext)) return;
          ui.mutationBusy = true;
          try {
            await uiMutation("setDeckArchived", {
              deck_id: result.deck.id,
              archived: false,
              expected_revision: result.deck.revision,
              client_action_id: actionId("undo-archive"),
            }, undoContext);
            if (!isViewCurrent(undoContext)) return;
            ui.deckStatus = "active";
            queueRender();
          } catch (error) {
            if (isViewCurrent(undoContext)) toast(error.message);
          } finally { if (isViewCurrent(undoContext)) ui.mutationBusy = false; }
        },
      });
      return queueRender();
    } catch (error) {
      if (isViewCurrent(context)) return toast(error.message);
    } finally { if (isViewCurrent(context)) ui.mutationBusy = false; }
  }
  const archive = target.closest("[data-archive-deck]");
  if (archive) {
    if (ui.mutationBusy) return;
    ui.mutationBusy = true;
    try {
      const archived = archive.dataset.archive === "true";
      const result = await uiMutation("setDeckArchived", {
        deck_id: archive.dataset.archiveDeck,
        archived,
        expected_revision: Number(archive.dataset.revision),
        client_action_id: actionId(archived ? "archive-deck" : "restore-deck"),
      }, context);
      if (!result || !isViewCurrent(context)) return;
      toast(archived ? "Deck archived" : "Deck restored");
      return queueRender();
    } catch (error) {
      if (isViewCurrent(context)) return toast(error.message);
    } finally { if (isViewCurrent(context)) ui.mutationBusy = false; }
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
    const message = workspace.recordingId
      ? `Reset this recording workspace ${workspace.recordingId}? This removes its decks, sessions, and review history in this browser.`
      : "Reset study data in this browser? This removes locally saved personal decks, sessions, and review history. Graph layout settings are not cleared by this reset. It does not delete your ChatGPT account or agent conversations.";
    if (confirm(message)) {
      try {
        clearPendingStudyReveal();
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
    queueLibrarySearch();
  }
  if (event.target.matches("[data-library-evidence]")) {
    ui.catalogEvidence = event.target.value;
    ui.catalogLimit = 24;
    queueRender();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) pauseStudyHelpTimer();
  else armStudyHelpTimer();
});

window.addEventListener("pageshow", () => armStudyHelpTimer());
window.addEventListener("focus", () => armStudyHelpTimer());

document.addEventListener("keydown", (event) => {
  const interactiveTarget = event.target?.closest?.("button, a, input, textarea, select, [contenteditable='true']");
  const pendingShell = view.querySelector("[data-study-advance-pending]");
  const pendingAdvance = pendingShell?.querySelector("[data-advance-study-card]");
  if ((event.key === " " || event.code === "Space") && !event.repeat &&
      !event.altKey && !event.ctrlKey && !event.metaKey && pendingAdvance && !interactiveTarget) {
    event.preventDefault();
    advancePresentedStudyCard(pendingAdvance);
    return;
  }
  if (event.key === "Escape") {
    if (ui.manualGrade && !ui.manualGrade.rating && !ui.mutationBusy) {
      event.preventDefault();
      event.stopPropagation();
      cancelManualGrade();
      return;
    }
    if (view.querySelector("[data-study-nonanswer-warning]")) {
      event.preventDefault();
      event.stopPropagation();
      closeStudyNonAnswerConfirmation({ restoreFocus: true });
      return;
    }
    if (deckDialog?.open || accountDialog?.open || settingsDialog?.open) {
      closeOverlayDialogs();
      return;
    }
    if (view.querySelector("[data-study-agent-help]")) {
      ui.studyHelpShown = false;
      ui.studyHelpDismissed = true;
      view.querySelector("[data-study-agent-help]")?.remove();
      view.querySelector("[data-show-study-help]")?.setAttribute("aria-expanded", "false");
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

window.addEventListener("hashchange", async () => {
  const context = captureView();
  if (!isViewCurrent(context)) return;
  closeOverlayDialogs();
  ui.archiveConfirmDeckId = null;
  if (accountMode && getRoute().name !== "session") {
    ui.studySuperseded = false;
    try { await context.session.releaseStudy({ clearBlock: true, cancelPending: true }); }
    catch { /* Browsing remains available; the server still owns the session. */ }
    if (!isViewCurrent(context)) return;
  }
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
      ...(accountMode ? { executionGuard: context.session.executionGuard, requireStudyExecutionGuard: true } : {}) });
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
  accountHydrationPending = true;
  showNeutralLoadingShell({ loading, view });
  try {
    const connected = await accountRuntime.connect();
    if (attempt !== startupSequence || !connected.isCurrent()) return;
    accountSession = connected;
    restoreConnectedAccountDialog(connected.accountBinding);
    store = connected.store;
    // Only view preferences may be ephemeral here; no local business store exists.
    workspace = { storage: createMemoryStorage(), label: "Account-backed", ephemeral: false, seedExamples: false };
    accountHydrationPending = false;
    ui.failed = false;
    showAccountSettings();
    await finishStartup();
  } catch (error) {
    if (attempt === startupSequence) {
      accountHydrationPending = false;
      showFatal(error);
    }
  }
}

export async function initializeWebsite({ accountOptions = null, catalogOptions = null } = {}) {
  if (accountRuntime || store) throw new Error("The website already selected a persistence path.");
  accountMode = accountOptions !== null;
  if (prepareAccountStartupShell({ accountMode, loading, view })) {
    accountHydrationPending = true;
  }
  try {
    if (!accountMode) workspace = createBrowserWorkspace(location.search);
    catalogSettings = catalogOptions ?? await loadWebsiteLibrary({ storedStateJson: workspace?.savedData() });
    library = presentLibrary(catalogSettings.browseCatalog ?? catalogSettings.catalog.catalog ?? catalogSettings.catalog, catalogSettings);
  } catch (error) { showFatal(error); return; }
  if (accountMode) {
    try {
      accountRuntime = createAccountRuntime({ ...accountOptions, onInvalidate: invalidateAccountView,
        onStudySuperseded: freezeStudyPresentation,
        onReplay: ({ execution_context }) => {
          if (accountSession?.isCurrent(execution_context)) queueRender();
        } });
      await reconnectAccount();
    } catch (error) { invalidateAccountView(); showFatal(error); }
    return { reconnect: reconnectAccount, invalidate: () => accountRuntime?.invalidate(), dispose: () => accountRuntime?.dispose() };
  }
  try {
  // Storage access and hydration can both fail. Neither belongs outside recovery.
  store = createWebsiteLocalStore({ catalogSettings, storage: workspace.storage });
  bootstrap();
  syncLocalStorageUI();
  if (demoMode === "loading") setTimeout(() => finishStartup().catch(showFatal), 700);
  else await finishStartup();
} catch (error) {
  if (error instanceof StudyStoreError || error instanceof Error) showFatal(error);
  else showFatal(new Error("The local workspace could not initialize."));
  }
}
