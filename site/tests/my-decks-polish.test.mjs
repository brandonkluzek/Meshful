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
  assert.match(css, /\.deck-card \.card-actions \.button\s*\{[\s\S]*color:\s*var\(--ink-0\);[\s\S]*background:\s*var\(--surface-2\);[\s\S]*border-color:\s*var\(--line-strong\);[\s\S]*opacity:\s*1;/);
  assert.match(css, /\.mastery-row span\s*\{[\s\S]*color:\s*var\(--ink-1\);[\s\S]*font-size:\s*14px;/);
  assert.match(css, /\.card-facts\s*\{[\s\S]*color:\s*var\(--ink-1\);[\s\S]*font-size:\s*14px;/);
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
  assert.match(card, />You can restore it anytime\.<\/span>/);
  assert.doesNotMatch(card, /Remove|not yet supported for account-backed decks/);
  assert.match(card, /class="card-actions"\$\{showingCardDialog \? ' inert aria-hidden="true"'/);
  assert.match(card, /aria-describedby="archive-description-\$\{escapeAttribute\(deck\.id\)\}"/);
  assert.doesNotMatch(clicks, /accountMode && target\.closest\("\[data-request-archive\]/);
  assert.equal([...clicks.matchAll(/uiMutation\("setDeckArchived"/g)].length, 4);
});

test("archived cards expose Restore, Graph, and an honest unavailable Delete action", () => {
  const card = sourceBetween("function personalDeckCard", "function renderLibrary");
  const clicks = sourceBetween('document.addEventListener("click"', 'document.addEventListener("input"');

  assert.match(card, /deck\.archived[\s\S]*button button-sm button-primary[\s\S]*Restore/);
  assert.match(card, /deck\.archived[\s\S]*href="#graph\//);
  assert.match(card, /button button-sm button-danger[\s\S]*data-delete-unavailable[\s\S]*>Delete<\/button>/);
  assert.doesNotMatch(card, /aria-label="Delete .* permanently"/);
  assert.match(card, /Delete unavailable/);
  assert.match(card, /This deck stays archived\. No data was deleted\./);
  assert.match(card, /data-close-delete-unavailable>Cancel<\/button>/);
  assert.match(clicks, /data-delete-unavailable[\s\S]*ui\.deleteUnavailableDeckId/);
  assert.doesNotMatch(clicks, /uiMutation\("(?:delete|hardDelete|deleteDeck)/);
  assert.match(css, /\.deck-card \.card-actions \.button\.button-primary[\s\S]*background:\s*var\(--paper\)/);
  assert.match(css, /\.deck-card \.card-actions \.button\.button-danger[\s\S]*background:\s*#2b1e1b/);
  assert.match(css, /\.archive-confirmation \.archive-cancel-button[\s\S]*background:\s*#15171c/);
  assert.match(css, /\.archive-confirmation\s*\{[\s\S]*background:\s*#202329;[\s\S]*border-top:\s*1px solid #4a505b/);
  assert.match(css, /\.archive-confirmation \.archive-confirm-button[\s\S]*background:\s*#343943;[\s\S]*border-color:\s*#68707d/);
  assert.match(css, /\.archive-confirmation\.delete-unavailable[\s\S]*background:\s*#2b1919;[\s\S]*border-top-color:\s*#713d3a/);
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
