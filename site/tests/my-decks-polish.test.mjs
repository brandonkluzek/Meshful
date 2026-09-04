import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { calendarRelativeLabel } from "../public/study/js/view-clock.js";

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

test("My Decks keeps scheduling jargon out of prominent deck cards", () => {
  const card = sourceBetween("function personalDeckCard", "function renderLibrary");

  assert.match(card, /available\.due_count \? `\$\{available\.due_count\} due` : ""/);
  assert.match(card, /\$\{status \? `<span class="status-pill"/);
  assert.doesNotMatch(card, /eligible_new_count|new ready|Prerequisites|Scheduled/);
  assert.doesNotMatch(card, /availabilityLabel\(available/);
  assert.match(card, /deck\.archived \? "<span>Reviews paused<\/span>" : ""/);
  assert.match(card, /formatRelative\(metrics\.lastStudied\)/);
  assert.doesNotMatch(card, /Example progress|Saved example/);
  assert.match(card, /<a class="button button-sm" href="#graph\//);
  assert.doesNotMatch(card, /button button-sm button-quiet" href="#graph\//);
  assert.match(css, /\.mastery-row span\s*\{[\s\S]*color:\s*var\(--ink-1\);[\s\S]*font-size:\s*14px;/);
  assert.match(css, /\.card-facts\s*\{[\s\S]*color:\s*var\(--ink-1\);[\s\S]*font-size:\s*14px;/);
});

test("My Decks bottom-aligns metadata and gives Graph and Archive one bright secondary surface", () => {
  const card = sourceBetween("function personalDeckCard", "function renderLibrary");

  assert.match(card, /button button-sm button-primary[^>]*data-start-deck/);
  assert.match(card, /href="#graph\//);
  assert.match(card, /button button-sm" type="button" data-request-archive/);
  assert.match(css, /\.deck-card > \.mastery-row\s*\{[^}]*margin-top:\s*auto;[^}]*padding-top:\s*24px;[^}]*flex-wrap:\s*wrap;[^}]*gap:\s*6px 12px;/s);
  assert.match(css, /\.deck-card \.card-actions\s*\{[^}]*margin-top:\s*0;/s);
  assert.match(css, /\.deck-card \.card-actions \.button:not\(\.button-primary\):not\(\.button-danger\)\s*\{[^}]*color:\s*#f6f7f8;[^}]*background:\s*#2b2f35;[^}]*border-color:\s*#7e8691;/s);
  assert.match(css, /\.deck-card \.card-actions \.button\.button-primary\s*\{[^}]*color:\s*var\(--paper-ink\);[^}]*background:\s*var\(--paper\);[^}]*border-color:\s*var\(--paper\);/s);
  assert.doesNotMatch(css, /\.deck-card \.card-actions a\[href\^="#graph\/"\]/);
});

test("archived empty state uses deck imagery and direct restore copy", () => {
  const myDecks = sourceBetween("function renderMyDecks", "function personalDeckCard");
  const empty = sourceBetween("function emptyState", "function notFound");
  const icons = sourceBetween("function icon", "function getRoute");

  assert.match(myDecks, /copy: archived \? "When you archive a deck, it stays here until you restore it\." :/);
  assert.match(myDecks, /iconName: archived \? "book" : "stack"/);
  assert.match(empty, /iconName = "stack"/);
  assert.match(empty, /\$\{icon\(iconName\)\}/);
  assert.match(icons, /<svg viewBox="0 0 20 20" aria-hidden="true">/);
});

test("My Decks keeps the Library action comfortably sized", () => {
  const myDecks = sourceBetween("function renderMyDecks", "function personalDeckCard");
  assert.match(myDecks, /button button-primary my-decks-library-button/);
  assert.match(css, /\.page-heading-simple \.my-decks-library-button\s*\{[^}]*min-height:\s*46px;[^}]*padding:\s*0 20px;[^}]*font-size:\s*14px;/s);
});

test("My Decks labels the reversible action as Archive and sends it through confirmed mutation handling", () => {
  const card = sourceBetween("function personalDeckCard", "function renderLibrary");
  const clicks = sourceBetween('document.addEventListener("click"', 'document.addEventListener("input"');

  assert.match(card, /aria-label="Archive \$\{escapeAttribute\(deck\.title\)\}"/);
  assert.match(card, /\$\{icon\("archive"\)\} Archive/);
  assert.match(card, /button button-sm" type="button" data-request-archive/);
  assert.match(card, />Archive this deck\?<\/strong>/);
  assert.match(card, /You can restore it anytime\./);
  assert.doesNotMatch(card, /Remove|not yet supported for account-backed decks/);
  assert.match(card, /class="card-actions"\$\{showingCardDialog \? ' inert aria-hidden="true"'/);
  assert.match(card, /aria-describedby="archive-description-\$\{escapeAttribute\(deck\.id\)\}"/);
  assert.doesNotMatch(clicks, /accountMode && target\.closest\("\[data-request-archive\]/);
  assert.equal([...clicks.matchAll(/uiMutation\("setDeckArchived"/g)].length, 4);
});

test("a confirmed Archive leaves the redundant account refresh off the visible response path", () => {
  const mutation = sourceBetween("async function uiMutation", "function escapeHTML");
  const decks = sourceBetween("function presentedPersonalDecks", "function metricsForDeck");
  const clicks = sourceBetween('document.addEventListener("click"', 'document.addEventListener("input"');
  const archive = clicks.slice(clicks.indexOf('const archiveConfirm = target.closest("[data-confirm-archive]")'),
    clicks.indexOf('const archive = target.closest("[data-archive-deck]")'));

  assert.match(mutation, /\{ deferAccountRefresh = false \} = \{\}/);
  assert.match(mutation, /accountMode && !deferAccountRefresh/);
  assert.match(mutation, /ui\.confirmedArchivePresentations\.set\(deckId/);
  assert.match(mutation, /context\.session\.refresh\(context\.ticket\)\.then/);
  assert.match(mutation, /ui\.confirmedArchivePresentations\.delete\(deckId\)/);
  assert.match(decks, /presentedPersonalDecks\(snapshot\)/);
  assert.match(decks, /confirmed \? \{ \.\.\.deck, archived: confirmed\.archived, revision: confirmed\.revision \} : deck/);
  assert.match(archive, /archiveConfirm\.disabled = true/);
  assert.match(archive, /archiveConfirm\.textContent = "Archiving…"/);
  assert.match(archive, /\{ deferAccountRefresh: true \}/);
  assert.match(archive, /presentConfirmedArchive\(result, context\)/);
  assert.ok(archive.indexOf("presentConfirmedArchive(result, context)") < archive.indexOf("toast(`${result.deck.title} archived`"));
});

test("archived cards expose Restore and Graph without deck deletion controls", () => {
  const card = sourceBetween("function personalDeckCard", "function renderLibrary");
  const clicks = sourceBetween('document.addEventListener("click"', 'document.addEventListener("input"');

  assert.match(card, /deck\.archived[\s\S]*button button-sm button-primary[\s\S]*Restore/);
  assert.match(card, /deck\.archived[\s\S]*href="#graph\//);
  assert.doesNotMatch(card, /data-request-delete|>Delete<\/button>/);
  assert.match(clicks, /uiMutation\("deleteDeck"/);
  assert.match(css, /\.deck-card \.card-actions \.button\.button-primary[\s\S]*background:\s*var\(--paper\)/);
  assert.match(css, /\.deck-card \.card-actions \.button\.button-danger[\s\S]*background:\s*#2b1e1b/);
  assert.match(css, /\.archive-confirmation \.archive-cancel-button[\s\S]*background:\s*#15171c/);
  assert.match(css, /\.archive-confirmation\s*\{[\s\S]*background:\s*#202329;[\s\S]*border-top:\s*1px solid #4a505b/);
  assert.match(css, /\.archive-confirmation \.archive-confirm-button[\s\S]*background:\s*#343943;[\s\S]*border-color:\s*#68707d/);
  assert.match(css, /\.archive-confirmation\.delete-confirmation[\s\S]*min-height:\s*0;[\s\S]*flex-direction:\s*row;[\s\S]*padding:\s*11px 14px;[\s\S]*background:\s*#2b1919;/);
  assert.match(css, /\.archive-confirmation\s*\{[\s\S]*min-height:\s*128px;[\s\S]*align-items:\s*stretch;[\s\S]*flex-direction:\s*column;[\s\S]*padding:\s*18px 20px 20px;/);
  assert.match(css, /\.archive-confirmation > div:last-child\s*\{[\s\S]*justify-content:\s*flex-end;/);
  assert.match(css, /\.toast-region\s*\{[\s\S]*bottom:\s*34px;[\s\S]*left:\s*50%;[\s\S]*width:\s*min\(460px, calc\(100vw - 40px\)\);[\s\S]*transform:\s*translateX\(-50%\);/);
  assert.match(css, /\.toast\s*\{[\s\S]*min-height:\s*58px;[\s\S]*font-size:\s*14px;/);
  assert.match(css, /\.toast-action\s*\{[\s\S]*min-height:\s*40px;[\s\S]*padding:\s*0 16px;[\s\S]*font-size:\s*14px;/);
  assert.match(css, /\.toast-action\s*\{\s*min-height:\s*44px;\s*\}/);
  assert.doesNotMatch(css, /\.archive-confirmation\s*\{[^}]*align-items:\s*flex-start;/s);
});

test("last-studied labels stay human and calendar-relative", () => {
  const now = new Date("2026-09-02T16:00:00-05:00");
  assert.equal(calendarRelativeLabel(null, now), "Not studied yet");
  assert.equal(calendarRelativeLabel("invalid", now), "Not studied yet");
  assert.equal(calendarRelativeLabel("2026-09-02T15:57:00-05:00", now), "Last studied just now");
  assert.equal(calendarRelativeLabel("2026-09-02T09:00:00-05:00", now), "Last studied today");
  assert.equal(calendarRelativeLabel("2026-09-01T23:50:00-05:00", now), "Last studied yesterday");
  assert.equal(calendarRelativeLabel("2026-08-29T09:00:00-05:00", now), "Last studied 4 days ago");
  assert.equal(calendarRelativeLabel("2026-08-25T09:00:00-05:00", now), "Last studied a week ago");
  assert.equal(calendarRelativeLabel("2026-08-12T09:00:00-05:00", now), "Last studied 3 weeks ago");
  assert.equal(calendarRelativeLabel("2026-07-29T09:00:00-05:00", now), "Last studied a month ago");
  assert.equal(calendarRelativeLabel("2026-06-04T09:00:00-05:00", now), "Last studied 3 months ago");
  assert.equal(calendarRelativeLabel("2025-09-02T09:00:00-05:00", now), "Last studied a year ago");
  assert.equal(calendarRelativeLabel("2026-09-02T16:01:00-05:00", now), "Last studied time unavailable");
  assert.equal(calendarRelativeLabel("2026-09-03T09:00:00-05:00", now), "Last studied time unavailable");
});
