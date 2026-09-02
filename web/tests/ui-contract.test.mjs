import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [html, app, graph, css] = await Promise.all([
  readFile(resolve(root, "index.html"), "utf8"),
  readFile(resolve(root, "js/app.js"), "utf8"),
  readFile(resolve(root, "js/graph-view.js"), "utf8"),
  readFile(resolve(root, "styles.css"), "utf8"),
]);

test("Study is the default and My Decks, Library, and Graph remain distinct", () => {
  assert.match(app, /\|\| "study"/);
  assert.match(html, />Study<\/a>/);
  assert.match(html, />My Decks<\/a>/);
  assert.match(html, />Library<\/a>/);
  assert.match(app, /route\.name === "graph"/);
  assert.doesNotMatch(html, /data-nav="cards"/i);
});

test("page hierarchy stays literal and free of preview or marketing headers", () => {
  assert.doesNotMatch(html, /brand-beta|>preview</i);
  assert.doesNotMatch(html, /Lattice/i);
  assert.match(html, /<title>Meshful<\/title>/);
  assert.match(html, /<strong>Meshful<\/strong>/);
  assert.match(html, /aria-label="Meshful home"/);
  assert.match(html, /Connect terms\. Build understanding\./);
  assert.doesNotMatch(html, /<small>Connect terms\. Build understanding\.<\/small>/);
  assert.doesNotMatch(html, /placeholder Meshful mark|TODO\(brand\)/);
  assert.doesNotMatch(html, /Adaptive Study|TermMesh/);
  assert.match(app, /<h1>Study<\/h1>/);
  assert.doesNotMatch(app, /Good morning|Good afternoon|Good evening|Keep the thread alive/);
  assert.match(app, /page-heading page-heading-simple[^]*<h1>My Decks<\/h1>/);
  assert.doesNotMatch(app, /Your learning collection|Coverage and freshness stay separate/);
  assert.doesNotMatch(html, />Local<|>Preview</i);
  assert.match(html, /Sign in with ChatGPT for your account and settings/);
});

test("study activity uses recorded history, separates examples, and renders a circular intensity tracker", () => {
  assert.match(app, /store\.getStudyActivity\(\{ days: 7 \}\)/);
  assert.doesNotMatch(app, /legacyDemoWeights|legacyDemoEvents|function activityForWeek/);
  assert.match(app, /Recorded reviews over the last seven days/);
  assert.match(app, /class="activity-dot"/);
  assert.match(app, /data-activity-tooltip="\$\{reviewLabel\}\$\{exampleLabel\}" tabindex="0"/);
  assert.doesNotMatch(app, /class="activity-day"[^>]* title=/);
  assert.match(css, /\.activity-day \.activity-dot[^}]*border-radius:\s*50%/s);
  assert.match(css, /activity-day\[data-level="4"\]/);
  assert.match(css, /\.activity-day:hover::after/);
  assert.match(css, /\.activity-day:focus-visible::after/);
});

test("deck chrome keeps provenance compact and library previews expose every term", () => {
  assert.doesNotMatch(app, /<span>Source<\/span>/);
  assert.doesNotMatch(app, /Updated \$\{formatDate/);
  assert.doesNotMatch(app, /\$\{modules\.(?:length|size)\}[^<]*<\/strong><span>Modules/i);
  assert.doesNotMatch(app, /Sample terms|<p class="eyebrow">Outline/);
  assert.match(app, /deck\.cards\.map\(\(card\) =>/);
  assert.match(app, /class="deck-dialog-scroll"/);
  assert.match(app, /class="term-table"/);
  assert.match(css, /\.deck-dialog-scroll[^}]*overflow-y:\s*auto/s);
});

test("Library browse cards keep the count and actions without crowding the grid with evidence or level", () => {
  const template = app.match(/function libraryCard\(deck, snapshot\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(template, "Library card renderer remains available");
  assert.match(template, /\$\{deck\.cardCount\} cards/);
  assert.doesNotMatch(template, /evidence-row|evidenceForDeck|deck\.level/);
  assert.match(template, /data-preview-deck/);
  assert.match(template, /data-add-deck/);
  assert.match(template, /Open deck/);
  assert.match(template, /In My Decks/);
  assert.match(app, /evidence-row-dialog/);
  assert.match(css, /\.library-card\s*\{\s*min-height:\s*0;/);
});

test("deck removal is explicit and a single evidence tier does not create a redundant filter", () => {
  assert.match(app, /aria-label="Remove \$\{escapeAttribute\(deck\.title\)\}"/);
  assert.match(app, /data-request-archive="\$\{escapeAttribute\(deck\.id\)\}"[^>]*>\$\{icon\("archive"\)\} Remove<\/button>/);
  assert.match(app, />Remove<\/button>/);
  assert.match(app, /You can restore it later with its review history intact\./);
  assert.match(app, /const hasEvidenceFilter = evidenceOptions\.length > 2;/);
  assert.match(app, /\$\{hasEvidenceFilter \? `<div class="library-evidence-filter">/);
  assert.match(app, /const selectedEvidence = hasEvidenceFilter \? ui\.catalogEvidence : "All";/);
  assert.match(app, /view\.querySelector\("\[data-cancel-archive\]"\)\?\.focus\(\)/);
  assert.match(app, /actionLabel: "Undo"/);
});

test("fully mastered decks get an earned state without conflating mastery and recency", () => {
  assert.match(app, /createBrowserWorkspace\(location\.search\)/);
  assert.match(app, /store\.seedMasteredDemoDeck\(\)/);
  assert.doesNotMatch(app, /previewMastered|appearance-preview|data-mastery-preview|Mastered deck preview/);
  assert.doesNotMatch(css, /\.appearance-preview/);
  assert.match(app, /isDeckFullyMastered\(metrics\)/);
  assert.match(app, /data-tone="\$\{mastered \? "mastered"/);
  assert.match(app, /✓ Mastered/);
  assert.match(app, /100% mastery reached\. Reviews will keep it strong\./);
  assert.match(css, /\.deck-card\.is-mastered\s*\{[^}]*border-color:\s*#c6a65b/s);
  assert.match(css, /\.deck-card\.is-mastered \.progress-track span\s*\{[^}]*#c6a65b/s);
  assert.match(css, /\.status-pill\[data-tone="mastered"\]/);
});

test("dialogs close predictably and primary navigation has no hidden letter shortcuts", () => {
  assert.match(app, /if \(deckDialog\?\.open\) deckDialog\.close\(\)/);
  assert.match(app, /if \(accountDialog\?\.open\) accountDialog\.close\(\)/);
  assert.match(app, /if \(settingsDialog\?\.open\) settingsDialog\.close\(\)/);
  assert.match(app, /window\.addEventListener\("hashchange", \(\) => \{[^]*closeOverlayDialogs\(\);/);
  assert.doesNotMatch(app, /event\.key\.toLowerCase\(\) === "[sdl]"/);
});

test("definition study is chat-first while preserving learner-facing answer protection", () => {
  assert.match(app, /Answer in chat/);
  assert.match(app, /Define the term in your own words/);
  assert.match(app, /Continue in chat for feedback\./);
  assert.doesNotMatch(app, /Your feedback will appear there next\./);
  assert.match(app, /session\.phase === "answer_committed"/);
  assert.match(app, /value\.type === "study_grade_committed"/);
  assert.match(app, /value\.reviewed_card\?\.definition_md/);
  assert.match(app, /import \{ renderDefinition \} from "\.\/definition-renderer\.js"/);
  assert.match(app, /<div class="study-definition" data-study-definition><\/div>/);
  assert.match(app, /hydrateStudyDefinition\(snapshot, route\.id\)/);
  assert.match(app, /renderDefinition\(definition, value\.reviewed_card\?\.definition_md \?\? ""\)/);
  assert.match(app, /value\.type === "webmcp_state_committed"[^]*queueRender\(\)/);
  assert.doesNotMatch(app, /definition\.textContent\s*=\s*value\.reviewed_card/);
  assert.doesNotMatch(app, /escapeHTML\(card\.definition\)/);
  assert.match(app, /scene\.classList\.add\("is-flipped"\)/);
  assert.match(app, /scene\.classList\.add\("is-departing"\)/);
  assert.match(app, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(app, /data-rating=/);
  assert.match(css, /\.study-card-stack[^}]*perspective/s);
  assert.match(css, /\.is-departing/);
  assert.doesNotMatch(app, /intervalLabel|previewFsrsSchedule/);
  assert.match(css, /\.rating-button\[data-rating="again"\]/);
  assert.match(css, /\.rating-button\[data-rating="easy"\]/);
  assert.match(css, /\.session-shell[^}]*width:\s*min\(760px/s);
  assert.match(css, /\.study-definition[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.definition-math-display[^}]*overflow-x:\s*auto/s);
});

test("graph is an interactive, readable prerequisite canvas rather than a score map", () => {
  for (const behavior of ["wheel", "pointerdown", "pointermove", "pointerup"]) {
    assert.match(graph, new RegExp(`on\\([^\\n]+["']${behavior}["']`));
  }
  assert.match(graph, /data-graph-search/);
  assert.match(graph, /graphProjectionForDeck/);
  assert.match(graph, /data-graph-scope/);
  assert.match(graph, /data-graph-legend/);
  assert.doesNotMatch(graph, /data-graph-mode/);
  assert.doesNotMatch(graph, /button\.dataset\.mode/);
  assert.match(graph, /Learning: \$\{titleCase\(state\.learning\)\}\. Recency:/);
  assert.match(graph, /class="node-recency"/);
  assert.match(graph, /Border: learning/);
  assert.match(graph, /Dot: recency/);
  assert.match(graph, /NARROW_MIN_READABLE_SCALE = 0\.78/);
  assert.match(graph, /minScale: narrow \? NARROW_MIN_READABLE_SCALE : MIN_SCALE/);
  assert.match(graph, /narrow \? "readable-scope" : "full-graph"/);
  assert.match(css, /\.graph-node\s*\{[^}]*width:\s*170px[^}]*min-height:\s*58px/s);
  assert.match(css, /\.graph-node\[data-learning="learning"\][^}]*border-color/s);
  assert.match(css, /\.graph-node\[data-freshness="due"\] \.node-recency/);
  assert.doesNotMatch(css, /\.graph-world\[data-layer=/);
  assert.match(css, /body\[data-route="graph"\] \.graph-page \{\s*position: fixed;\s*inset: 0;\s*height: 100dvh;[^}]*grid-template-rows: auto auto minmax\(0, 1fr\);/s);
  assert.match(css, /\.graph-search \{\s*position: static;\s*grid-row: 2;/s);
  assert.match(css, /\.graph-workspace \{ grid-row: 3; \}/);
  assert.match(graph, /data-graph-action="reset"/);
  assert.match(graph, /closest\("\[data-node-id\]"\)/);
  assert.match(graph, /on\(window, "pointermove", \(event\) => \{\s*if \(!dragging\) return;/s);
  assert.match(graph, /traceUpstream/);
  assert.match(graph, /traceDownstream/);
  assert.match(graph, /dataset\.learning = state\.learning/);
  assert.match(graph, /dataset\.freshness = state\.freshness/);
  assert.doesNotMatch(graph, /foundation|charted|landmark|route score/i);
});

test("narrow study keeps the session count visible beside exit", () => {
  assert.match(css, /\.session-header \{\s*grid-template-columns: minmax\(0, 1fr\) auto auto;/s);
  assert.match(css, /\.session-progress \{\s*display: block;/s);
  assert.match(app, /\$\{session\.cursor \+ 1\} \/ \$\{session\.queue\.length\}/);
});

test("visual system includes keyboard focus and reduced-motion fallbacks", () => {
  assert.match(html, /class="skip-link"/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /repeating-linear-gradient/i);
});

test("runtime has no bundled chatbot or remote asset dependency", () => {
  assert.doesNotMatch(html, /chatbot|assistant panel|agent panel/i);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//i);
  assert.doesNotMatch(app, /fetch\s*\(/);
});
