import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createMemoryStorage } from "../public/study/js/store.js";
import { createWebsiteLocalStore, loadWebsiteLibrary } from "../public/study/js/library-loader.js";
import {
  graphForCatalog,
  graphForPersonal,
  matchesLibraryQuery,
  presentLibrary,
} from "../public/study/js/library-view.js";

const RELEASE = "2026-09-03.public-sanitized.v4";
const NOW = "2026-09-02T18:00:00.000Z";
const LINEAR_ALGEBRA = "academic-reviewed-v1:linear-algebra-i";
const PHYSIOLOGY = "academic-reviewed-v1:physiology";
const INDEX_URL = new URL("https://meshful.test/study/data/library-releases.json");
const publicRoot = new URL("../public/", import.meta.url);

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

function countedStorage(initial = {}) {
  const memory = createMemoryStorage(initial);
  let writes = 0;
  return {
    storage: {
      getItem: (key) => memory.getItem(key),
      setItem(key, value) { writes += 1; memory.setItem(key, value); },
      removeItem: (key) => memory.removeItem(key),
      clear: () => memory.clear(),
      dump: () => memory.dump(),
    },
    writes: () => writes,
  };
}

function stateJson(storage) {
  const values = Object.values(storage.dump());
  assert.equal(values.length, 1, "one learner-state record is retained");
  return values[0];
}

function gradeCurrent(store, started, idempotencyKey) {
  const card = started.current_card;
  return store.submitGrade({
    session_id: started.session.session_id,
    card_id: card.card_id,
    expected_card_revision: card.card_revision,
    expected_session_revision: started.session.session_revision,
    answer_text: "A concise synthetic answer used only to verify the deterministic saved transaction.",
    answer_origin: "chat",
    rating: "good",
    rubric_evidence: card.required_concepts.map((item) => ({
      rubric_item_id: item.rubric_item_id,
      status: "met",
      note: "Mechanics-only Website integration check.",
    })),
    feedback: "Mechanics-only Website integration check.",
    misconceptions: [],
    confidence: 1,
    idempotency_key: idempotencyKey,
  });
}

const catalogSettings = await loadWebsiteLibrary({ indexUrl: INDEX_URL, fetcher: siteFetcher });

test("the assembled Website admits and searches all 72 sanitized courses with exact graph counts", () => {
  assert.equal(catalogSettings.release, RELEASE);
  assert.equal(catalogSettings.seedExamples, false);
  const catalog = catalogSettings.browseCatalog;
  assert.equal(catalog.length, 72);
  assert.equal(catalog.reduce((total, deck) => total + deck.cards.length, 0), 9988);
  assert.equal(catalog.find((deck) => deck.id === "academic-reviewed-v1:algorithms-i")
    .requiredCatalogDeckIds.length, 3);
  assert.equal(catalog.find((deck) => deck.id === PHYSIOLOGY)
    .requiredCatalogDeckIds.length, 14);

  const owners = new Map(catalog.flatMap((deck) => deck.cards.map((card) => [card.id, deck.id])));
  let prerequisiteEdges = 0;
  let crossDeckEdges = 0;
  for (const deck of catalog) {
    for (const card of deck.cards) {
      prerequisiteEdges += card.prerequisite_ids.length;
      crossDeckEdges += card.prerequisite_ids.filter((parent) => owners.get(parent) !== deck.id).length;
    }
  }
  assert.equal(prerequisiteEdges, 17712);
  assert.equal(crossDeckEdges, 770);

  const visible = presentLibrary(catalog, catalogSettings);
  const matches = visible.filter((deck) => deck.searchText.includes("coefficient and augmented matrices"));
  const linearAlgebra = matches.find((deck) => deck.id === LINEAR_ALGEBRA);
  assert.equal(linearAlgebra.title, "Linear Algebra I");
  assert.equal(linearAlgebra.cardCount, 142);
  assert.equal(matchesLibraryQuery(linearAlgebra, "linear algebra"), true, "course title");
  assert.equal(matchesLibraryQuery(linearAlgebra, "mathematics"), true, "subject");
  assert.equal(matchesLibraryQuery(linearAlgebra, "orthogonality least squares"), true, "course description");
  assert.equal(matchesLibraryQuery(linearAlgebra, "coefficient augmented matrices"), true, "card term");
  assert.equal(matchesLibraryQuery(linearAlgebra, "mathematics eigenvalues"), true, "tokens across fields");
  assert.equal(matchesLibraryQuery(linearAlgebra, "organic spectroscopy"), false, "unrelated metadata");
  const previewGraph = graphForCatalog(linearAlgebra, visible);
  assert.equal(previewGraph.rootCardIds.length, 142);
  assert.equal(previewGraph.missingPrerequisiteIds.length, 0);
});

test("Linear Algebra I completes Library to My Decks to Study to grade to Graph and same-storage reload", async () => {
  const counted = countedStorage();
  const store = createWebsiteLocalStore({
    catalogSettings,
    storage: counted.storage,
    clock: () => new Date(NOW),
  });
  const beforeInstallWrites = counted.writes();
  const installed = await store.addLibraryDeck({
    library_deck_id: LINEAR_ALGEBRA,
    expected_catalog_version: RELEASE,
    client_action_id: "website-v3:add-linear-algebra",
  });
  assert.equal(counted.writes() - beforeInstallWrites, 1);
  assert.equal(installed.installation.decks.length, 1);
  assert.equal(store.listMyDecks({ status: "active", limit: 50 }).total, 1);
  assert.equal(store.getDeck({ scope: "personal", deck_id: installed.deck.id }).card_count, 142);

  const started = store.startStudySession({
    deck_id: installed.deck.id,
    limit: 20,
    idempotency_key: "website-v3:study-linear-algebra",
  });
  assert.equal(started.current_card.card_id,
    "linear-algebra-i.la1-m0-coefficient-and-augmented-matrices");
  const graded = gradeCurrent(store, started, "website-v3:grade-linear-algebra");
  assert.equal(graded.next_card.card_id, "linear-algebra-i.la1-m0-matrix-shape-and-equality");

  const snapshot = store.getSnapshot();
  const graph = graphForPersonal(snapshot.personalDecks[installed.deck.id], snapshot);
  assert.ok(graph.cards.some((card) => card.id === started.current_card.card_id));

  const saved = stateJson(counted.storage);
  const reloadedSettings = await loadWebsiteLibrary({
    indexUrl: INDEX_URL,
    fetcher: siteFetcher,
    storedStateJson: saved,
  });
  const reloaded = createWebsiteLocalStore({
    catalogSettings: reloadedSettings,
    storage: counted.storage,
    clock: () => new Date(NOW),
  });
  assert.equal(reloaded.getDeck({ scope: "personal", deck_id: installed.deck.id }).card_count, 142);
  assert.equal(reloaded.getLearningOverview().recent_reviews[0].card_id, started.current_card.card_id);
});

test("Library provenance never becomes the learner's personal deck identity or title", async () => {
  const store = createWebsiteLocalStore({
    catalogSettings,
    storage: createMemoryStorage(),
    clock: () => new Date(NOW),
  });
  const installed = await store.addLibraryDeck({
    library_deck_id: "academic-reviewed-v1:algorithms-i",
    expected_catalog_version: RELEASE,
    client_action_id: "website-v3:identity-separation",
  });

  assert.equal(installed.deck.id, "deck-algorithms-i");
  assert.equal(installed.deck.title, "Algorithms I");
  assert.deepEqual(installed.installation.decks.map((deck) => deck.deck_id), [
    "deck-algorithms-i",
  ]);
  assert.ok(installed.installation.decks.every((deck) =>
    deck.catalog_deck_id.startsWith("academic-reviewed-v1:")
    && !deck.deck_id.includes("academic-reviewed-v1"),
  ));

  const listed = store.listMyDecks({ status: "active", sort: "title", limit: 50 });
  assert.ok(listed.decks.every((deck) => !deck.id.includes("academic-reviewed-v1")));
  assert.ok(listed.decks.some((deck) => deck.id === "deck-algorithms-i"
    && deck.title === "Algorithms I"));
  const personal = store.getDeck({ scope: "personal", deck_id: installed.deck.id });
  const catalog = store.getDeck({
    scope: "library",
    deck_id: "academic-reviewed-v1:algorithms-i",
  });
  assert.equal(personal.deck.version, "personal");
  assert.equal(personal.deck.deck_revision, 1);
  assert.equal(catalog.deck.version, RELEASE);
  assert.equal(catalog.deck.deck_id, "academic-reviewed-v1:algorithms-i");
});

test("Physiology installs only its selected 160-card course and reloads the grade", async () => {
  const counted = countedStorage();
  const store = createWebsiteLocalStore({
    catalogSettings,
    storage: counted.storage,
    clock: () => new Date(NOW),
  });
  const beforeInstallWrites = counted.writes();
  const installed = await store.addLibraryDeck({
    library_deck_id: PHYSIOLOGY,
    expected_catalog_version: RELEASE,
    client_action_id: "website-v3:add-physiology",
  });
  assert.equal(counted.writes() - beforeInstallWrites, 1);
  assert.equal(installed.installation.decks.length, 1);
  assert.equal(installed.installation.decks.reduce((total, item) => total
    + store.getDeck({ scope: "personal", deck_id: item.deck_id }).card_count, 0), 160);

  const started = store.startStudySession({
    deck_id: installed.deck.id,
    limit: 20,
    idempotency_key: "website-v3:study-physiology",
  });
  assert.ok(started.current_card, "external course references do not block the selected course");
  const graded = gradeCurrent(store, started, "website-v3:grade-physiology");
  assert.equal(graded.reviewed_card.card_id, started.current_card.card_id);

  const snapshot = store.getSnapshot();
  const graph = graphForPersonal(snapshot.personalDecks[installed.deck.id], snapshot);
  assert.ok(graph.cards.length > 0);

  const saved = stateJson(counted.storage);
  const reloadedSettings = await loadWebsiteLibrary({
    indexUrl: INDEX_URL,
    fetcher: siteFetcher,
    storedStateJson: saved,
  });
  const reloaded = createWebsiteLocalStore({
    catalogSettings: reloadedSettings,
    storage: counted.storage,
    clock: () => new Date(NOW),
  });
  assert.equal(reloaded.listMyDecks({ status: "active", limit: 50 }).total, 1);
  assert.equal(reloaded.getLearningOverview().recent_reviews.length, 1);
});
