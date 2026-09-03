import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [app, css] = await Promise.all([
  readFile(new URL("../public/study/js/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/study/styles.css", import.meta.url), "utf8"),
]);

function sourceBetween(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return app.slice(from, to);
}

test("Study activity keeps the useful signal without visible audit copy", () => {
  const activityDay = sourceBetween("function activityDay", "function renderStudyActivity");
  const activityPanel = sourceBetween("function renderStudyActivity", "function renderStudyHome");

  assert.match(activityPanel, />Study activity</);
  assert.match(activityPanel, /const streakCount = Number\.isSafeInteger\(streak\?\.current\)/);
  assert.match(activityPanel, /class="activity-streak"[\s\S]*formatNumber\(streakCount\)/);
  assert.doesNotMatch(activityPanel, /streak\.current \?/);
  assert.match(activityPanel, /activity-strip/);
  assert.match(activityPanel, /Activity is temporarily unavailable\./);
  assert.doesNotMatch(activityPanel, /counted separately|Last 7 days|Lifetime completeness|retained review records|legacy entries|data-activity-examples|data-activity-legacy/i);
  assert.doesNotMatch(activityDay, /example_review_count|example reviews|counted separately/i);
  assert.match(activityDay, /const dateLabel = formatDate\(day\.date, day\.date\)/);
  assert.match(activityDay, /data-activity-tooltip="\$\{escapeAttribute\(dateLabel\)\} · \$\{reviewLabel\}"/);
  assert.match(css, /\.activity-heading div > span\s*\{\s*font-size:\s*17px;/);
  assert.match(css, /\.activity-streak svg\s*\{[\s\S]*width:\s*26px;[\s\S]*height:\s*26px;/);
  assert.match(css, /\.activity-heading \.activity-streak strong\s*\{[\s\S]*font-size:\s*24px;/);
  assert.match(css, /\.activity-day \.activity-dot\s*\{[\s\S]*width:\s*min\(34px, 100%\)/);
  assert.match(css, /\.activity-day span:last-child\s*\{\s*color:\s*var\(--ink-2\);\s*font-size:\s*12px;/);
  assert.doesNotMatch(css, /\.activity-examples/);
});

test("Study hero leads with due reviews and weekly activity without readiness jargon", () => {
  const home = sourceBetween("function renderStudyHome", "function queueRow");

  assert.match(home, /const totalDue = .*\.reduce\(\(sum, deck\) => sum \+ deck\.due_count, 0\)/);
  assert.match(home, /<p class="eyebrow">Due now<\/p>/);
  assert.match(home, /formatNumber\(totalDue\)/);
  assert.match(home, /totalDue === 1 \? "review due" : "reviews due"/);
  assert.doesNotMatch(home, /const totalNew|totalDue \|\| totalNew|new card(?:s)? ready/i);
  assert.doesNotMatch(home, /awaiting prerequisites/i);
  assert.doesNotMatch(home, /availabilityLabel\(activeAvailability/);
  assert.match(home, /study-title-line\$\{resumableSession \? " has-session-progress" : ""\}/);
  assert.match(home, /activeMastered \? "✓ 100% mastered" : `\$\{activeMetrics\.mastery\}% mastered`/);
  assert.match(css, /\.study-active-mastery\s*\{[\s\S]*color:\s*var\(--ink-1\);[\s\S]*font-size:\s*14px;/);
  assert.match(home, /resumableSession \? `<p>\$\{resumableSession\.cursor\} of \$\{resumableSession\.queue\.length\} complete<\/p>` : ""/);
  assert.match(home, />Reviews this week</);
  assert.match(home, /\$\{activity \? `<div class="hero-metrics">/);
  assert.match(home, /<strong>\$\{formatNumber\(activity\.review_count\)\}<\/strong>/);
  assert.doesNotMatch(home, /activity \? formatNumber\(activity\.review_count\) : "—"/);
  assert.doesNotMatch(home, /<div class="hero-metric"><span>Mastered<\/span>/);
  assert.doesNotMatch(home, /<div class="hero-metric"><span>New ready<\/span>/);
  assert.match(css, /\.study-hero-copy h2\s*\{[\s\S]*font-size:\s*clamp\(25px, 3vw, 32px\);/);
  assert.match(css, /\.study-title-line\s*\{[\s\S]*margin-bottom:\s*18px;/);
  assert.match(css, /\.study-title-line\.has-session-progress\s*\{[\s\S]*margin-bottom:\s*7px;/);
  assert.match(home, /<h2>Choose a deck<\/h2>/);
  assert.doesNotMatch(home, /<h2>Your queue<\/h2>/);
  assert.match(css, /\.section-heading h2\s*\{[\s\S]*font-size:\s*20px;/);
  assert.match(css, /\.section-heading a\s*\{[\s\S]*min-height:\s*44px;[\s\S]*font-size:\s*15px;/);
  assert.doesNotMatch(app, /new ready|awaiting prerequisites|No new cards ready/i);
});

test("fresh and fully archived learners get one clear Library path without starting a session", () => {
  const home = sourceBetween("function renderStudyHome", "function queueRow");
  const emptyBranch = home.slice(home.indexOf("if (!decks.length)"), home.indexOf("const resumableSession"));

  assert.match(emptyBranch, /data-empty-study-home/);
  assert.match(emptyBranch, /title: hasArchived \? "No active decks" : "You have no decks yet"/);
  assert.match(emptyBranch, /start studying when you are ready/);
  assert.match(emptyBranch, /course from the Library/);
  assert.match(emptyBranch, /href="#library">Browse Library</);
  assert.match(emptyBranch, /hasArchived[\s\S]*href="#decks" data-deck-status="archived">View archived decks/);
  assert.match(emptyBranch, /activity\?\.review_count > 0/);
  assert.doesNotMatch(emptyBranch, /data-start-deck|startStudySession|seedDemoState|seedMasteredDemoDeck/);
  assert.match(css, /\[data-empty-study-home\] \.empty-state/);
  assert.match(css, /\.empty-actions\s*\{[\s\S]*display:\s*flex;[\s\S]*flex-wrap:\s*wrap;[\s\S]*gap:\s*10px;/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.empty-actions\s*\{[\s\S]*flex-direction:\s*column;/);
});

test("the catalog uses the concise user-facing Library name", () => {
  const libraryView = sourceBetween("function renderLibrary", "function installedPersonalDeck");
  const myDecksView = sourceBetween("function renderMyDecks", "function personalDeckCard");

  assert.match(libraryView, /<h1>Library<\/h1>/);
  assert.match(libraryView, /Search the Library/);
  assert.match(libraryView, /placeholder="Search courses, subjects, or terms"/);
  assert.match(libraryView, /type="search"[\s\S]*autocapitalize="none"[\s\S]*enterkeyhint="search"[\s\S]*spellcheck="false"/);
  assert.match(libraryView, /data-library-results/);
  assert.match(libraryView, /aria-label="Library subjects"/);
  assert.match(libraryView, /class="sr-only" aria-live="polite"/);
  assert.doesNotMatch(libraryView, /library-result-count|Showing \$\{visibleMatches\.length\}/);
  assert.match(myDecksView, /aria-label="Open Library to add decks">Library/);
  assert.doesNotMatch(app, /Find prerequisite in Library/);
  assert.match(app, /Close graph and return to Library/);
  assert.doesNotMatch(app, /Deck Library/);
});

test("Library search updates results without replacing the focused input", () => {
  const resultRender = sourceBetween("function renderLibraryResults", "function renderLibrary");
  const searchQueue = sourceBetween("function queueLibrarySearch", "function captureLibrarySearchSelection");
  const fullRender = sourceBetween("async function render()", "async function startSession");
  const inputHandler = sourceBetween('document.addEventListener("input"', 'document.addEventListener("visibilitychange"');

  assert.match(resultRender, /matchesLibraryQuery\(deck, ui\.catalogQuery\)/);
  assert.match(resultRender, /No decks match/);
  assert.match(searchQueue, /view\.querySelector\("\[data-library-results\]"\)/);
  assert.match(searchQueue, /results\.innerHTML = renderLibraryResults\(store\.getSnapshot\(\)\)/);
  assert.doesNotMatch(searchQueue, /view\.innerHTML/);
  assert.match(inputHandler, /ui\.catalogQuery = event\.target\.value/);
  assert.match(inputHandler, /queueLibrarySearch\(\)/);
  assert.doesNotMatch(inputHandler, /queueRender\(80\)/);
  assert.match(fullRender, /captureLibrarySearchSelection\(\)/);
  assert.match(fullRender, /restoreLibrarySearchSelection\(librarySearchSelection\)/);
});

test("Study deck rows stay concise, show truthful due counts, and reward mastery", () => {
  const queue = sourceBetween("function queueRow", "function renderMyDecks");

  assert.match(queue, /\$\{metrics\.mastery\}% mastered/);
  assert.match(queue, /class="queue-due"/);
  assert.match(queue, /formatNumber\(available\.due_count\)/);
  assert.match(queue, /<span>due<\/span>/);
  assert.doesNotMatch(queue, /available\.due_count \|\| available\.eligible_new_count|new ready/);
  assert.doesNotMatch(queue, /Example progress|Saved example|formatRelative|availabilityLabel|mastery-inline/);
  assert.match(css, /\.queue-due\s*\{[\s\S]*display:\s*inline-flex;[\s\S]*white-space:\s*nowrap;/);
  assert.match(css, /\.queue-due span\s*\{[\s\S]*color:\s*var\(--ink-1\);[\s\S]*font-size:\s*13px;[\s\S]*text-transform:\s*none;/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.queue-due\s*\{[\s\S]*justify-self:\s*end;/);
  assert.doesNotMatch(css, /\.queue-due\s*\{\s*display:\s*none;/);
  assert.match(css, /\.queue-row\.is-mastered\s*\{[\s\S]*position:\s*relative;[\s\S]*border-width:\s*2px;[\s\S]*border-color:\s*#c6a65b;/);
  assert.match(css, /\.deck-card\.is-mastered\s*\{[\s\S]*position:\s*relative;[\s\S]*border-width:\s*2px;[\s\S]*border-color:\s*#c6a65b;/);
  assert.doesNotMatch(css, /mastered-shine|animation:\s*mastered-shine/);
  assert.match(css, /\.queue-row\.is-mastered::after,[\s\S]*\.deck-card\.is-mastered::after\s*\{[\s\S]*inset:\s*-2px;[\s\S]*padding:\s*3px;[\s\S]*conic-gradient\([\s\S]*pointer-events:\s*none;[\s\S]*mask-composite:\s*exclude;[\s\S]*animation:\s*mastered-border-travel 4\.2s linear infinite;/);
  assert.match(css, /@keyframes mastered-border-travel\s*\{[\s\S]*--mastery-border-angle:\s*360deg;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.queue-row\.is-mastered::after,[\s\S]*\.deck-card\.is-mastered::after\s*\{[\s\S]*--mastery-border-angle:\s*32deg;[\s\S]*animation:\s*none !important;/);
  assert.match(css, /\.queue-row\.is-mastered:hover,[\s\S]*\.queue-row\.is-mastered:focus-within/);
  assert.match(css, /\.queue-row\.is-mastered:focus-within,[\s\S]*\.deck-card\.is-mastered:focus-within\s*\{[\s\S]*outline:\s*2px solid/);
});

test("account invalidation preserves a bounded generic user icon", () => {
  const invalidation = sourceBetween("function invalidateAccountView", "function queueRender");
  const icons = sourceBetween("function icon", "function getRoute");

  assert.match(invalidation, /accountTrigger\.setAttribute\("aria-label", "Open account"\)/);
  assert.match(invalidation, /accountTrigger\.innerHTML = icon\("user"\)/);
  assert.doesNotMatch(invalidation, /replaceChildren\("Account"\)/);
  assert.match(icons, /user:\s*'<circle cx="10" cy="7" r="3" \/><path d="M4\.5 16c\.8-3 2\.7-4\.5 5\.5-4\.5s4\.7 1\.5 5\.5 4\.5" \/>'/);
  assert.match(css, /\.account-trigger\s*\{[\s\S]*flex-shrink:\s*0;[\s\S]*overflow:\s*hidden;[\s\S]*font-size:\s*0;[\s\S]*line-height:\s*0;[\s\S]*white-space:\s*nowrap;/);
  assert.match(css, /\.account-trigger\s*\{[\s\S]*width:\s*46px;[\s\S]*height:\s*46px;/);
  assert.match(css, /\.account-trigger svg\s*\{[\s\S]*width:\s*20px;[\s\S]*height:\s*20px;/);
  assert.match(css, /\.account-avatar\s*\{[\s\S]*font-size:\s*11px;[\s\S]*line-height:\s*1;/);
});

test("a confirmed account reconnect restores the cleared account dialog safely", () => {
  const restore = sourceBetween("function restoreConnectedAccountDialog", "function showAccountSettings");
  const reconnect = sourceBetween("async function reconnectAccount", "export async function initializeWebsite");
  const accountClick = sourceBetween("if (target.closest(\"[data-action='open-account']\"))", "if (target.closest(\"[data-open-settings]\"))");

  assert.match(app, /const trustedAccountDialogContent = accountDialog[\s\S]*node\.cloneNode\(true\)/);
  assert.match(restore, /if \(trustedAccountBinding === null\) trustedAccountBinding = accountBinding;/);
  assert.match(restore, /if \(accountDialog\?\.childElementCount\) return;/);
  assert.match(restore, /if \(accountBinding !== trustedAccountBinding\) return;/);
  assert.match(restore, /accountDialog\.replaceChildren\(\.\.\.trustedAccountDialogContent\.map\(\(node\) => node\.cloneNode\(true\)\)\);/);
  assert.match(restore, /const fallback = document\.createElement\("template"\);/);
  assert.match(restore, /Signed in with ChatGPT/);
  assert.match(restore, /Synced to your account/);
  assert.match(restore, /accountDialog\.replaceChildren\(fallback\.content\.cloneNode\(true\)\);/);
  assert.doesNotMatch(restore, /accountDialog\.innerHTML/);
  assert.match(reconnect, /accountSession = connected;\s*restoreConnectedAccountDialog\(connected\.accountBinding\);\s*store = connected\.store;/);
  assert.match(accountClick, /restoreConnectedAccountDialog\(accountSession\?\.accountBinding\);\s*showAccountSettings\(\);/);
});

test("initial account hydration keeps the neutral loading shell instead of flashing reconnect", () => {
  const invalidation = sourceBetween("function invalidateAccountView", "function applyStudySupersededState");
  const reconnect = sourceBetween("async function reconnectAccount", "export async function initializeWebsite");
  assert.match(invalidation, /const keepLoading = accountMode && accountHydrationPending/);
  assert.match(invalidation, /if \(keepLoading\) \{[\s\S]*showNeutralLoadingShell\(\{ loading, view, clearView: true \}\);[\s\S]*return;/);
  assert.match(reconnect, /accountHydrationPending = true;[\s\S]*showNeutralLoadingShell\(\{ loading, view \}\);/);
  assert.match(reconnect, /await accountRuntime\.connect\(\)[\s\S]*accountHydrationPending = false;[\s\S]*await finishStartup\(\)/);
});
