import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, css] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../public/study/styles.css", import.meta.url), "utf8"),
]);

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test("the shared desktop header can shrink without pushing controls offscreen", () => {
  const topbar = sourceBetween(css, ".topbar {", ".brand {");
  const brand = sourceBetween(css, ".brand {", ".brand-copy {");
  const primaryNav = sourceBetween(css, ".primary-nav {", ".primary-nav a {");
  const primaryLink = sourceBetween(css, ".primary-nav a {", ".primary-nav a:hover");
  const actions = sourceBetween(css, ".topbar-actions {", ".sync-state {");

  assert.match(topbar, /grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\);/);
  assert.match(topbar, /width:\s*100%;/);
  assert.match(topbar, /max-width:\s*100%;/);
  assert.match(brand, /min-width:\s*0;/);
  assert.match(brand, /max-width:\s*100%;/);
  assert.match(primaryNav, /justify-self:\s*center;/);
  assert.match(primaryNav, /min-width:\s*0;/);
  assert.match(primaryNav, /max-width:\s*100%;/);
  assert.match(primaryLink, /white-space:\s*nowrap;/);
  assert.match(actions, /min-width:\s*0;/);
  assert.doesNotMatch(topbar, /minmax\(210px, 1fr\)/);
});

test("the compact navigation takes over before the desktop header becomes cramped", () => {
  const compactShell = sourceBetween(
    css,
    "@media (max-width: 760px) {\n  :root {",
    "@media (max-width: 420px)",
  );
  assert.match(compactShell, /\.topbar\s*\{[\s\S]*?grid-template-columns:\s*1fr auto;/);
  assert.match(compactShell, /\.primary-nav,[\s\S]*?display:\s*none;/);
  assert.match(compactShell, /\.mobile-nav\s*\{[\s\S]*?display:\s*grid;/);
  assert.match(compactShell, /body\s*\{[\s\S]*?padding-bottom:\s*calc\(62px \+ env\(safe-area-inset-bottom\)\);/);
});

test("every primary route is available in both desktop and compact navigation", () => {
  const desktopNav = sourceBetween(page, '<nav class="primary-nav"', "</nav>");
  const mobileNav = sourceBetween(page, '<nav class="mobile-nav"', "</nav>");

  for (const route of ["study", "decks", "library"]) {
    assert.match(desktopNav, new RegExp(`href="#${route}"`));
    assert.match(mobileNav, new RegExp(`href="#${route}"`));
  }
  assert.match(desktopNav, />Deck Library<\/a>/);
  assert.match(mobileNav, /<span>Deck Library<\/span>/);
  assert.match(page, /class="account-trigger"/);
});
