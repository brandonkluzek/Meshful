import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createBrowserWorkspace, LEARNER_STORAGE_KEY } from "../public/study/js/browser-workspace.js";
import { cardStatesForDeck } from "../public/study/js/graph-progress-state.js";
import { createWebsiteLocalStore, loadWebsiteLibrary } from "../public/study/js/library-loader.js";
import { isDeckFullyMastered } from "../public/study/js/mastery.js";
import { createMemoryStorage, learnednessForReview } from "../public/study/js/store.js";

const NOW = "2026-09-03T18:00:00.000Z";
const INDEX_URL = new URL("https://meshful.test/study/data/library-releases.json");
const publicRoot = new URL("../public/", import.meta.url);
const DEMO_CATALOG_IDS = [
  "academic-reviewed-v1:applied-statistics-i",
  "academic-reviewed-v1:linear-algebra-i",
  "academic-reviewed-v1:algorithms-i",
  "academic-reviewed-v1:mechanics-i",
  "academic-reviewed-v1:analytical-chemistry",
];

async function siteFetcher(input) {
  const url = new URL(input);
  const relative = url.pathname.replace(/^\/+/, "");
  if (url.origin !== INDEX_URL.origin || !relative.startsWith("study/data/") || relative.includes("..")) {
    return new Response("", { status: 404 });
  }
  try {
    const bytes = await readFile(new URL(relative, publicRoot));
    return new Response(bytes, {
      headers: { "content-type": "application/json", "content-length": String(bytes.length) },
    });
  } catch {
    return new Response("", { status: 404 });
  }
}

function mastery(deck) {
  const cards = deck.cardOrder.map((id) => deck.cards[id]).filter((card) => card && !card.archived);
  const learnedness = cards.map((card) => learnednessForReview(card.review));
  return Math.round(learnedness.reduce((sum, value) => sum + value, 0) / cards.length * 100);
}

test("demo workspace is temporary and cannot read or overwrite normal browser study data", () => {
  const browserStorage = createMemoryStorage({ [LEARNER_STORAGE_KEY]: "real learner bytes" });
  const normal = createBrowserWorkspace("", () => browserStorage);
  assert.equal(normal.showcase, false);
  assert.equal(normal.seedExamples, false);
  assert.equal(normal.savedData(), "real learner bytes");

  const demo = createBrowserWorkspace("?demo=showcase", () => browserStorage);
  assert.equal(demo.showcase, true);
  assert.equal(demo.ephemeral, true);
  assert.equal(demo.seedExamples, true);
  assert.equal(demo.savedData(), null);
  demo.storage.setItem(LEARNER_STORAGE_KEY, "artificial demo bytes");
  assert.equal(demo.savedData(), "artificial demo bytes");
  assert.equal(browserStorage.getItem(LEARNER_STORAGE_KEY), "real learner bytes");
});

test("showcase demo supplies varied progress, a mastered deck, activity, streak, and reversible archive state", async () => {
  const catalogSettings = await loadWebsiteLibrary({ indexUrl: INDEX_URL, fetcher: siteFetcher });
  const storage = createMemoryStorage();
  const store = createWebsiteLocalStore({
    catalogSettings,
    storage,
    clock: () => new Date(NOW),
    timeZone: "America/Chicago",
  });

  for (const catalogId of DEMO_CATALOG_IDS) {
    const deck = catalogSettings.browseCatalog.find((candidate) => candidate.id === catalogId);
    assert.ok(deck, `missing demo deck ${catalogId}`);
    await store.addLibraryDeck({
      library_deck_id: catalogId,
      expected_catalog_version: deck.version,
      client_action_id: `test-demo:add:${catalogId}`,
    });
  }

  const seeded = store.seedShowcaseDemo();
  assert.equal(seeded.demo_state, true);
  assert.equal(seeded.review_count, 118);
  assert.equal(seeded.streak, 24);

  const snapshot = store.getSnapshot();
  const decks = Object.values(snapshot.personalDecks);
  assert.equal(decks.length, 5);
  assert.equal(decks.filter((deck) => deck.archived).length, 1);
  assert.ok(decks.every((deck) => Object.values(deck.cards).every((card) => card.reviewHistory.length === 0)));

  const mechanics = decks.find((deck) => deck.source.catalogDeckId.endsWith(":mechanics-i"));
  assert.ok(mechanics);
  assert.equal(isDeckFullyMastered({
    total: mechanics.cardOrder.length,
    newCount: 0,
    mastery: mastery(mechanics),
  }), true);
  const graphStates = cardStatesForDeck(mechanics);
  assert.ok(Object.values(graphStates).every((card) => card.learnedness > 0));
  assert.ok(Object.values(graphStates).every((card) => card.reviewCount > 0));
  assert.ok(Object.values(graphStates).every((card) => card.reviewHistory.length === 0));

  const activeMastery = decks.filter((deck) => !deck.archived).map(mastery);
  assert.ok(new Set(activeMastery).size >= 4, "active decks show distinct progress levels");
  assert.ok(activeMastery.some((value) => value > 0 && value < 35));
  assert.ok(activeMastery.some((value) => value >= 35 && value < 80));

  const algorithms = decks.find((deck) => deck.source.catalogDeckId.endsWith(":algorithms-i"));
  assert.ok(algorithms);
  assert.ok(mastery(algorithms) >= 10, "the started deck shows believable early progress");
  assert.ok(mastery(algorithms) <= 30, "the started deck does not overstate mastery");

  const availability = store.getStudyAvailability();
  const totalDue = availability.decks.reduce((sum, deck) => sum + deck.due_count, 0);
  assert.ok(totalDue >= 10 && totalDue <= 30, `expected a believable due workload, received ${totalDue}`);

  const activity = store.getStudyActivity({ days: 7 });
  assert.equal(activity.review_count, 118);
  assert.equal(activity.days.length, 7);
  assert.ok(activity.days.every((day) => day.review_count > 0));
  assert.equal(store.inspectAppState().streak.current, 24);

  const archived = decks.find((deck) => deck.archived);
  const restored = store.setDeckArchived({
    deck_id: archived.id,
    archived: false,
    expected_revision: archived.revision,
    client_action_id: "test-demo:restore",
  });
  assert.equal(restored.deck.archived, false);
});

test("demo mode is visibly labeled and can return to untouched study data", async () => {
  const [page, app, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/study/js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/study/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /account-menu-row[^>]*data-demo-enter[^>]*>Demo mode/);
  assert.doesNotMatch(page, /topbar-actions[\s\S]*demo-mode-toggle/);
  assert.match(page, /data-demo-status[\s\S]*data-demo-exit[^>]*>Exit Demo<\/a>/);
  assert.doesNotMatch(page, /demo-mode-status-copy/);
  assert.doesNotMatch(page, /data-demo-banner/);
  assert.match(app, /demoMode === "showcase"/);
  assert.match(app, /accountOptions !== null && !showcaseDemo/);
  assert.match(app, /Artificial progress is temporary\. Your real study data is untouched\./);
  assert.match(app, /mountRouteDemoModeStatus\(\)/);
  assert.match(app, /view\.querySelector\("\.graph-title"\)/);
  assert.match(app, /view\.querySelector\("\.session-header"\)/);
  assert.match(app, /data-demo-route-status/);
  assert.match(app, /data-demo-exit[^>]*>Exit Demo<\/a>/);
  assert.doesNotMatch(app, /demo-mode-status-copy/);
  assert.match(css, /\.demo-mode-status\s*\{[^}]*min-height:\s*0;[^}]*padding:\s*0;[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*gap:\s*0;/s);
  assert.doesNotMatch(css, /\.demo-mode-status-copy/);
  assert.doesNotMatch(css, /\.demo-mode-banner/);
  assert.doesNotMatch(css, /\.demo-mode-status[^}]*#(?:ead|fff0|c6a6|e1c1)/);
  assert.doesNotMatch(css, /\.demo-mode-toggle/);
  assert.match(css, /\.demo-mode-exit\s*\{[^}]*color: var\(--paper-ink\);[^}]*background: var\(--paper\);[^}]*border: 1px solid var\(--paper\);/s);
});
