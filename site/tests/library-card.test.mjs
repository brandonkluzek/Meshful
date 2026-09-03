import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { COURSE_DESCRIPTIONS, courseDescription } from "../public/study/js/library-descriptions.js";

const [app, css] = await Promise.all([
  readFile(new URL("../public/study/js/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/study/styles.css", import.meta.url), "utf8"),
]);

test("Library browse cards keep the count and actions without crowding the grid with evidence or level", () => {
  const template = app.match(/function libraryCard\(deck, snapshot\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(template, "Library card renderer remains available");
  assert.match(template, /\$\{deck\.cardCount\} cards/);
  assert.doesNotMatch(template, /evidence-row|evidenceForDeck|deck\.level/);
  assert.match(template, /data-preview-deck/);
  assert.match(template, /data-add-deck/);
  assert.match(template, /library-card-footer/);
  assert.match(template, /button-primary/);
  assert.match(template, /button-added/);
  assert.match(template, /✓ Added/);
  assert.doesNotMatch(template, /earlierVersion|New edition|saved version is unchanged/);
  assert.doesNotMatch(template, />Available<|In My Decks|class="status-pill"/);
  assert.match(app, /dialog-deck-count/);
  assert.match(app, /Preview graph/);
  assert.match(app, /#library-graph\//);
  const preview = app.match(/function showDeckPreview\(deckId\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(preview, "Library preview renderer remains available");
  assert.doesNotMatch(preview, /evidence-row-dialog|Edition |Adds .*prerequisite|<th scope="col">Module<\/th>/);
  assert.match(preview, /<th scope="col">Terms<\/th>/);
  assert.match(css, /\.library-card\s*\{\s*min-height:\s*0;/);
  assert.match(css, /\.library-card-footer\s*\{\s*margin-top:\s*auto;\s*padding-top:\s*20px;/);
  assert.match(css, /\.library-card-footer \.card-actions\s*\{\s*margin-top:\s*0;/);
  assert.match(css, /\.library-card \.card-topline\s*\{\s*min-height:\s*16px;/);
  assert.match(css, /\.library-card h2\s*\{\s*margin:\s*8px 0;/);
  assert.match(css, /\.library-card \.card-actions > :last-child\s*\{\s*flex:\s*0 0 104px;\s*white-space:\s*nowrap;/);
  assert.match(css, /\.library-card \.card-actions \.button\s*\{\s*min-height:\s*40px;\s*font-size:\s*14px;/);
  assert.match(css, /\.filter-pills\[aria-label="Library subjects"\]\s*\{\s*margin-bottom:\s*22px;/);
  assert.match(css, /\.filter-pill\s*\{[\s\S]*min-height:\s*36px;[\s\S]*font-size:\s*13px;/);
  assert.match(css, /\.library-evidence-filter\s*\{[^}]*margin-bottom:\s*22px;/s);
  assert.match(css, /\.dialog-actions\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(css, /\.term-table\s*\{[^}]*font-size:\s*14px;/s);
  assert.match(css, /\.term-table th\s*\{[^}]*color:\s*var\(--ink-0\);[^}]*font-size:\s*13px;[^}]*font-weight:\s*750;/s);
  assert.match(css, /\.term-table td\s*\{[^}]*color:\s*var\(--ink-0\);[^}]*line-height:\s*1\.45;/s);
  assert.doesNotMatch(css, /\.term-table td:last-child/);
});

test("every released course has a concise course-specific description", async () => {
  const [runtime, overlay] = await Promise.all([
    readFile(new URL(
      "../public/study/data/library-runtime/2026-09-03.public-sanitized.v4/index.json",
      import.meta.url,
    ), "utf8").then(JSON.parse),
    readFile(new URL(
      "../integration/library-assets/COURSE_DESCRIPTION_OVERLAY_V1.json",
      import.meta.url,
    ), "utf8").then(JSON.parse),
  ]);
  const released = runtime.decks.map(({ summary }) => summary);

  assert.equal(Object.keys(COURSE_DESCRIPTIONS).length, released.length);
  assert.equal(overlay.decks.length, released.length);
  for (const expected of overlay.decks) {
    const summary = released.find(({ deck_id: deckId }) => deckId === expected.catalog_deck_id);
    assert.ok(summary, expected.catalog_deck_id);
    const description = courseDescription(summary);
    assert.ok(description.length >= 60, `${summary.title} has a useful description`);
    assert.ok(description.length <= 180, `${summary.title} description stays concise`);
    assert.doesNotMatch(description, /definition-recall|course deck covering core concepts/i);
    assert.equal(summary.description, expected.description);
    assert.equal(COURSE_DESCRIPTIONS[expected.source_deck_id], expected.description);
    assert.equal(description, expected.description);
  }
});

test("Library Add stays a one-course action without prerequisite closure presentation", () => {
  const card = app.match(/function libraryCard\(deck, snapshot\) \{([\s\S]*?)\n\}/)?.[1];
  const preview = app.match(/async function showDeckPreview\(deckId\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(card && preview);
  assert.match(card, /data-add-deck/);
  assert.match(card, />Add<\/button>/);
  assert.match(preview, /data-add-deck/);
  assert.match(preview, />Add<\/button>/);
  assert.doesNotMatch(card, /prerequisite|requiresConfirmation|Review \$\{|Add \$\{/i);
  assert.doesNotMatch(preview, /Courses included|prerequisite|requiresConfirmation/i);
  assert.doesNotMatch(app, /dialog-install-plan|dialog-install-receipt|includeClosure:\s*true/);
  assert.doesNotMatch(css, /\.dialog-install-plan|\.dialog-install-receipt/);
});

test("Library Add stays in Library and offers Study from a compact toast", () => {
  const clickHandler = app.slice(app.indexOf('const add = target.closest("[data-add-deck]")'), app.indexOf('if (accountMode && target.closest("[data-reset-local]"))'));
  assert.match(clickHandler, /uiMutation\("addLibraryDeck"/);
  assert.doesNotMatch(clickHandler, /pendingLibraryConfirmation/);
  assert.doesNotMatch(clickHandler, /location\.hash = "decks"/);
  assert.match(clickHandler, /toast\(`\$\{result\.deck\.title\} added`/);
  assert.match(clickHandler, /actionLabel:\s*"Study"/);
  assert.match(clickHandler, /onAction:\s*\(\) => startSession\(result\.deck\.id\)/);
  assert.doesNotMatch(clickHandler, /installation\?\.decks|addedCourses|prerequisite/i);

  assert.doesNotMatch(app, /function showLibraryAddedConfirmation/);
  assert.match(app, /data-open-archived/);
  assert.match(app, /ui\.deckStatus = "archived";\s*location\.hash = "decks";/);
});

test("Library treats archived installed courses as an exact unarchive action", () => {
  const card = app.match(/function libraryCard\(deck, snapshot\) \{([\s\S]*?)\n\}/)?.[1];
  const preview = app.match(/async function showDeckPreview\(deckId\) \{([\s\S]*?)\n\}/)?.[1];
  const confirmation = app.match(/function showLibraryUnarchiveConfirmation\(catalogId, catalogVersion\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(card && preview && confirmation, "Library archived lifecycle renderers remain available");
  assert.match(card, /installed\.archived/);
  assert.match(card, /data-request-unarchive/);
  assert.match(card, /data-catalog-version/);
  assert.match(card, />Archived<\/button>/);
  assert.match(preview, /installed\.archived/);
  assert.match(preview, /data-request-unarchive/);
  assert.match(preview, />Archived<\/button>/);
  assert.match(preview, /data-close-dialog>Open My Decks/);
  assert.match(confirmation, /installedPersonalDeck\(catalogId, snapshot, catalogVersion\)/);
  assert.match(confirmation, /installed\?\.archived/);
  assert.match(confirmation, /library-unarchive-dialog/);
  assert.match(confirmation, /<h2 id="deck-dialog-title">Unarchive\?<\/h2>/);
  assert.match(confirmation, /existing progress and review history/);
  assert.match(confirmation, /data-confirm-library-unarchive/);
  assert.match(confirmation, />Cancel<\/button>/);

  const clicks = app.slice(app.indexOf('document.addEventListener("click"'), app.indexOf('document.addEventListener("input"'));
  assert.match(clicks, /data-request-unarchive/);
  assert.match(clicks, /deck\.source\?\.catalogDeckId === unarchiveConfirm\.dataset\.catalogId/);
  assert.match(clicks, /String\(deck\.source\?\.catalogVersion\) === String\(unarchiveConfirm\.dataset\.catalogVersion\)/);
  assert.match(clicks, /deck\.revision === Number\(unarchiveConfirm\.dataset\.revision\)/);
  assert.match(clicks, /uiMutation\("setDeckArchived", \{[\s\S]*archived: false/);
  assert.match(clicks, /client_action_id: actionId\("unarchive-library-deck"\)/);
  assert.doesNotMatch(confirmation, /prerequisite|cascade|dependent course/i);
  assert.match(css, /\.sheet-dialog:has\(\.library-unarchive-dialog\)\s*\{[^}]*width:\s*min\(600px, calc\(100vw - 30px\)\);/s);
  assert.match(css, /\.sheet-dialog:has\(\.library-unarchive-dialog\)::backdrop\s*\{[^}]*background:\s*rgba\(7, 8, 10, 0\.58\);[^}]*backdrop-filter:\s*blur\(8px\);/s);
  assert.match(css, /\.library-unarchive-dialog \.dialog-actions\s*\{[^}]*margin-top:\s*14px;[^}]*padding-top:\s*14px;/s);
});
