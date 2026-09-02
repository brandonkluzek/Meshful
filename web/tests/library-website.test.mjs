import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CATALOG } from "../data/catalog.js";
import { createMemoryStorage, createStudyStore } from "../js/store.js";
import { prepareLibraryCatalog } from "../js/library-catalog.js";
import { loadWebsiteLibrary } from "../js/library-loader.js";
import { presentLibrary, graphForPersonal } from "../js/library-view.js";
import { buildGraphIndex } from "../js/graph-scope.js";
import { browserFeedFor } from "../scripts/build-library-release.mjs";
import { preparedFixture, catalogId } from "./helpers/library-fixture.mjs";
import { withApp } from "./helpers/app-harness.mjs";

test("bootstrap uses bounded demo fixtures when the release endpoint is unavailable", async () => {
  const loaded = await loadWebsiteLibrary({
    indexUrl: "https://meshful.test/data/library-releases.json",
    fetcher: async () => new Response("missing", { status: 404 }),
  });
  assert.equal(loaded.release, "meshful-existing-demo-fixtures.v1");
  assert.equal(loaded.catalog, CATALOG);
  assert.equal(loaded.seedExamples, true);

  const storedStateJson = JSON.stringify({
    personalDecks: { installed: { deckFields: { libraryBase: { catalogRef: { version: "private-release" } } } } },
  });
  await assert.rejects(loadWebsiteLibrary({
    indexUrl: "https://meshful.test/data/library-releases.json",
    storedStateJson,
    fetcher: async () => new Response("missing", { status: 404 }),
  }), /unavailable/);
});

const KEY = "adaptive-study-lab:web-state:v1";
const sha = (value) => createHash("sha256").update(value).digest("hex");
function releaseFixture(feed, prepared) {
  const encoded = JSON.stringify(browserFeedFor(prepared, feed));
  const digest = sha(encoded);
  const release = { version: feed.catalog_ref.version, path: `library/${feed.catalog_ref.version}/${digest}.json`,
    sha256: digest, catalogDigest: feed.catalog_ref.digest };
  const index = { format: "meshful-website-library-releases.v1", active: release.version, releases: [release] };
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    return new Response(url.endsWith("library-releases.json") ? JSON.stringify(index) : encoded);
  };
  return { index, release, encoded, requests, fetcher, indexUrl: "http://loopback.invalid/study/data/library-releases.json" };
}

const stableJson = (value) => Array.isArray(value) ? `[${value.map(stableJson).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);

async function nextRelease(feed) {
  const next = structuredClone(feed);
  next.catalog_ref.version = "synthetic-reviewed.v2";
  for (const deck of next.catalog) deck.version = next.catalog_ref.version;
  for (const deck of next.runtime_identity_map.decks) deck.catalog_deck_version = next.catalog_ref.version;
  next.catalog_ref.digest = `sha256:${sha(stableJson(next.catalog))}`;
  return releaseFixture(next, await prepareLibraryCatalog(next));
}

test("the generated browser feed retains exact base/content identities without private paths or provenance maps", async () => {
  const { feed, prepared } = await preparedFixture();
  const browser = browserFeedFor(prepared, feed);
  assert.equal(browser.source_reference_map, undefined);
  assert.ok(!JSON.stringify(browser).includes("synthetic-private-source-canary"));
  assert.deepEqual(browser.catalog, feed.catalog);
  assert.deepEqual(browser.dependency_edges, feed.dependency_edges);
  assert.deepEqual((await prepareLibraryCatalog(browser)).library, prepared.library);
});

test("normal bootstrap selects reviewed content and hides retained examples with no seeding", async () => {
  const { feed, prepared } = await preparedFixture();
  const fixture = releaseFixture(feed, prepared);
  const loaded = await loadWebsiteLibrary(fixture);
  assert.deepEqual(loaded.catalog.catalog, prepared.catalog);
  assert.equal(loaded.seedExamples, false);
  assert.deepEqual(loaded.legacyDeckIds, CATALOG.map((deck) => deck.id));
  assert.strictEqual(loaded.retainedCatalogs[0], CATALOG);
  assert.equal(fixture.requests.length, 2);
  assert.ok(fixture.requests.every(({ url, options }) => url.startsWith("http://loopback.invalid/study/data/") && options.redirect === "error"));
});

test("catalog asset mismatch fails closed without falling back to examples", async () => {
  const { feed, prepared } = await preparedFixture();
  const fixture = releaseFixture(feed, prepared);
  await assert.rejects(loadWebsiteLibrary({ ...fixture, fetcher: async (url) => new Response(url.endsWith("library-releases.json")
    ? JSON.stringify(fixture.index) : fixture.encoded + " ") }), /content pin/);
});

for (const path of ["https://remote.invalid/payload.json", "library/../payload.json", "library/v1/../../payload.json"]) {
  test(`untrusted release path rejects before a content fetch: ${path}`, async () => {
    const { feed, prepared } = await preparedFixture();
    const fixture = releaseFixture(feed, prepared);
    fixture.index.releases[0].path = path;
    await assert.rejects(loadWebsiteLibrary(fixture), /invalid identity/);
    assert.equal(fixture.requests.length, 1);
  });
}

test("missing historical release is reported, not silently replaced by current content", async () => {
  const { feed, prepared } = await preparedFixture();
  const fixture = releaseFixture(feed, prepared);
  const storedStateJson = JSON.stringify({ personalDecks: { old: { deckFields: { libraryBase: {
    catalogRef: { version: "retained-old.v1", digest: `sha256:${"0".repeat(64)}` },
  } } } } });
  await assert.rejects(loadWebsiteLibrary({ ...fixture, storedStateJson }), /older release/);
  assert.equal(fixture.requests.length, 1);
});

test("loader retains historical sparse and dense catalog pins even without redundant Library metadata", async () => {
  const { feed, prepared } = await preparedFixture();
  const old = releaseFixture(feed, prepared);
  const current = await nextRelease(feed);
  const index = { ...current.index, releases: [current.release, old.release] };
  const storage = createMemoryStorage();
  const store = createStudyStore({ catalog: prepared, storage });
  store.addLibraryDeck({ library_deck_id: catalogId("alpha"), expected_catalog_version: feed.catalog_ref.version, client_action_id: "old-base" });
  const raw = JSON.parse(storage.getItem(KEY));
  const overlay = Object.values(raw.personalDecks)[0];
  delete overlay.deckFields.libraryBase;
  // This shape is accepted by the settled core with its original catalog.
  storage.setItem(KEY, JSON.stringify(raw));
  assert.equal(Object.keys(createStudyStore({ catalog: prepared, storage }).getSnapshot().personalDecks).length, 1);
  for (const saved of [raw, { personalDecks: { dense: { persistenceCatalogBase: {
    catalogDeckId: overlay.catalogDeckId, catalogVersion: overlay.catalogVersion,
  } } } }]) {
    const storedStateJson = JSON.stringify(saved);
    const requested = [];
    const loaded = await loadWebsiteLibrary({ indexUrl: current.indexUrl, storedStateJson, fetcher: async (url) => {
      requested.push(url);
      return new Response(url.endsWith("library-releases.json") ? JSON.stringify(index)
        : url.endsWith(old.release.path) ? old.encoded : current.encoded);
    } });
    assert.equal(loaded.retainedCatalogs[1].library.catalogRef.version, feed.catalog_ref.version);
    assert.equal(requested.length, 3);
    assert.equal(JSON.stringify(saved), storedStateJson);
  }
});

test("only an exact bundled example ID and version is exempt from release loading", async () => {
  const { feed, prepared } = await preparedFixture();
  const fixture = releaseFixture(feed, prepared);
  const example = CATALOG[0];
  const saved = { personalDecks: { saved: { persistenceKind: "catalog-overlay-v1", catalogDeckId: example.id, catalogVersion: example.version } } };
  await loadWebsiteLibrary({ ...fixture, storedStateJson: JSON.stringify(saved) });
  saved.personalDecks.saved.catalogVersion = "different-version";
  await assert.rejects(loadWebsiteLibrary({ ...fixture, storedStateJson: JSON.stringify(saved) }), /older release/);
});

test("presentation derives all card counts and alias search without altering canonical strings", async () => {
  const { prepared } = await preparedFixture([["alpha", [{ id: "one", term: "Term", definition: "  $x$\r\n  ",
    prerequisite_ids: [], aliases: ["Alternate"], required_concepts: [] }]]]);
  const before = JSON.stringify(prepared.catalog);
  const [view] = presentLibrary(prepared.catalog);
  assert.equal(view.cardCount, 1);
  assert.match(view.searchText, /alternate/);
  assert.equal(view.cards[0].definition, "  $x$\r\n  ");
  assert.equal(JSON.stringify(prepared.catalog), before);
});

test("Library → My Decks → Study → Graph uses a prepared closure with no fabricated history", async () => {
  const { prepared } = await preparedFixture();
  const storage = createMemoryStorage();
  const catalogOptions = { catalog: prepared, seedExamples: false };
  await withApp({ storage, hash: "#library", catalogOptions }, async ({ view, click, flush, navigate, location, errors }) => {
    assert.match(view.textContent, /Showing 4 of 4 decks/);
    assert.doesNotMatch(view.textContent, /Introductory Mechanics|Demo fixture/);
    click(`[data-preview-deck="${catalogId("gamma")}"]`);
    await flush();
    click(`[data-add-deck="${catalogId("gamma")}"]`);
    await flush();
    const state = JSON.parse(storage.getItem(KEY));
    assert.equal(Object.keys(state.personalDecks).length, 4);
    assert.equal(Object.values(state.personalDecks).some((deck) => Object.keys(deck.cardOverlays ?? {}).length), false);
    await navigate("#decks");
    assert.match(view.textContent, /Synthetic gamma/);
    assert.match(view.textContent, /0% mastered/);
    const root = Object.values(state.personalDecks).find((deck) => deck.catalogDeckId === catalogId("alpha")).deckFields.id;
    click(`[data-start-deck="${root}"]`);
    await flush();
    assert.match(location.hash, /^#session\//);
    assert.match(view.textContent, /Answer in chat/);
    assert.doesNotMatch(view.textContent, /Synthetic definition/);
    click("[data-pause-session]");
    await flush();
    const gamma = Object.values(state.personalDecks).find((deck) => deck.catalogDeckId === catalogId("gamma")).deckFields.id;
    await navigate(`#graph/${gamma}`);
    assert.equal(view.querySelectorAll(".graph-node").length, 4);
    assert.deepEqual(errors, []);
  });
  const reloaded = createStudyStore({ catalog: prepared, storage }).getSnapshot();
  assert.equal(Object.keys(reloaded.personalDecks).length, 4);
  assert.equal(reloaded.activity.some((entry) => entry.type.startsWith("demo")), false);
});

test("all 72 entries remain available through pagination without creating personal decks", async () => {
  const definitions = Array.from({ length: 72 }, (_, index) => [`course-${String(index).padStart(2, "0")}`, [{
    id: `term-${index}`, term: `Term ${index}`, definition: "Synthetic pagination fixture.", required_concepts: [], prerequisite_ids: [],
  }]]);
  const { prepared } = await preparedFixture(definitions);
  const storage = createMemoryStorage();
  await withApp({ storage, hash: "#library", catalogOptions: { catalog: prepared, seedExamples: false } }, async ({ view, click, flush }) => {
    assert.match(view.textContent, /Showing 24 of 72/);
    click("[data-library-more]"); await flush();
    assert.match(view.textContent, /Showing 48 of 72/);
    click("[data-library-more]"); await flush();
    assert.match(view.textContent, /Showing 72 of 72/);
    assert.equal(view.querySelectorAll("[data-preview-deck]").length, 72);
    assert.equal(Object.keys(JSON.parse(storage.getItem(KEY)).personalDecks).length, 0);
  });
});

test("Graph uses saved edits and exact external ancestors, not current Library or unrelated cards", async () => {
  const { prepared } = await preparedFixture();
  const store = createStudyStore({ catalog: prepared, storage: createMemoryStorage() });
  const added = store.addLibraryDeck({ library_deck_id: catalogId("gamma"), expected_catalog_version: prepared.library.catalogRef.version, client_action_id: "graph-install" });
  const snapshot = store.getSnapshot();
  const deck = snapshot.personalDecks[added.deck.id];
  deck.cards[deck.cardOrder[0]].term = "Saved personal term";
  const before = JSON.stringify(snapshot);
  const graph = graphForPersonal(deck, snapshot);
  assert.equal(graph.cards.find((card) => card.id === deck.cardOrder[0]).term, "Saved personal term");
  assert.equal(graph.cards.length, 4);
  assert.equal(buildGraphIndex(graph).edges.length, 4);
  assert.equal(graph.cards.filter((card) => card.external).length, 3);
  assert.equal(JSON.stringify(snapshot), before);
  const parent = Object.values(snapshot.personalDecks).find((item) => item.source.catalogDeckId === catalogId("alpha"));
  parent.archived = true;
  const missing = graphForPersonal(deck, snapshot);
  assert.deepEqual(missing.missingPrerequisiteIds, ["alpha.root"]);
  assert.doesNotThrow(() => buildGraphIndex(missing));
});

test("Graph retains edge-only prerequisites and the selected deck's own review state", () => {
  const deck = { id: "saved", title: "Saved", revision: 1, cardOrder: ["a", "b"], cards: {
    a: { id: "a", term: "A", prerequisiteIds: [], review: { reviewCount: 2 } },
    b: { id: "b", term: "B", prerequisiteIds: [], review: { reviewCount: 0 } },
  }, edges: [{ prerequisiteCardId: "a", dependentCardId: "b" }] };
  const unrelated = structuredClone(deck);
  unrelated.id = "unrelated";
  unrelated.cards.a.review.reviewCount = 25;
  const graph = graphForPersonal(deck, { personalDecks: { saved: deck, unrelated } });
  assert.deepEqual(graph.cards.find((card) => card.id === "b").prerequisites, ["a"]);
  assert.equal(graph.cards.find((card) => card.id === "a").review.reviewCount, 2);
  assert.equal(buildGraphIndex(graph).edges.length, 1);
});

test("Study from an external Graph ancestor starts its owning normal deck", async () => {
  const { prepared } = await preparedFixture();
  const storage = createMemoryStorage();
  const store = createStudyStore({ catalog: prepared, storage });
  const installed = store.addLibraryDeck({ library_deck_id: catalogId("gamma"), expected_catalog_version: prepared.library.catalogRef.version, client_action_id: "external-study" });
  const alpha = Object.values(store.getSnapshot().personalDecks).find((deck) => deck.source.catalogDeckId === catalogId("alpha"));
  await withApp({ storage, hash: `#graph/${installed.deck.id}`, catalogOptions: { catalog: prepared, seedExamples: false } }, async ({ view, flush, location, errors }) => {
    const ancestor = view.querySelectorAll(".graph-node").find((node) => node.dataset.nodeId === "alpha.root");
    // The DOM double does not reflect direct dataset assignments to attributes.
    ancestor.setAttribute("data-node-id", ancestor.dataset.nodeId);
    for (const listener of view.listeners.get("click") ?? []) await listener({ target: ancestor, detail: 1 });
    const button = view.querySelector('[data-study-card="alpha.root"]');
    assert.ok(button);
    for (const listener of view.listeners.get("click") ?? []) await listener({ target: button, detail: 1 });
    await flush();
    assert.match(location.hash, /^#session\//);
    const state = JSON.parse(storage.getItem(KEY));
    assert.equal(state.sessions[state.activeSessionId].deckId, alpha.id);
    assert.match(view.textContent, /alpha.root/);
    assert.deepEqual(errors, []);
  });
});
