import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  StudyStoreError,
  createMemoryStorage,
  createStudyStore,
} from "../js/store.js";

const NOW = "2026-08-29T12:00:00.000Z";
const STORAGE_KEY = "adaptive-study-lab:web-state:v1";

function smallCatalog() {
  return [{
    id: "sparse-library",
    title: "Sparse Library",
    subject: "testing",
    level: "introductory",
    version: "1",
    description: "A persistence fixture.",
    cards: [
      {
        id: "alpha",
        term: "Alpha",
        definition: "IMMUTABLE-CATALOG-ALPHA is the first canonical definition.",
        accepted_points: ["State alpha."],
      },
      {
        id: "beta",
        term: "Beta",
        definition: "IMMUTABLE-CATALOG-BETA is the second canonical definition.",
        accepted_points: ["State beta."],
      },
      {
        id: "gamma",
        term: "Gamma",
        definition: "IMMUTABLE-CATALOG-GAMMA is the third canonical definition.",
        accepted_points: ["State gamma."],
      },
    ],
    edges: [
      { prerequisite_card_id: "alpha", dependent_card_id: "beta" },
      { prerequisite_card_id: "beta", dependent_card_id: "gamma" },
    ],
    provenance: { origin: "test-fixture" },
    license: { name: "test-only" },
  }];
}

function createSmallStore(storage = createMemoryStorage()) {
  return createStudyStore({
    catalog: smallCatalog(),
    storage,
    clock: () => new Date(NOW),
  });
}

function installSmall(store, action = "install-sparse-library") {
  return store.addLibraryDeck({
    library_deck_id: "sparse-library",
    expected_catalog_version: "1",
    client_action_id: action,
  }).deck;
}

function completeAddedCard(deckId) {
  return {
    card_id: `${deckId}.delta`,
    term: "Delta",
    prompt: null,
    definition_md: "A locally added fourth definition.",
    aliases: [],
    required_concepts: [{ rubric_item_id: "required-1", text: "State delta." }],
    accepted_variants: [],
    major_error_concepts: [],
    prerequisite_ids: [`${deckId}.alpha`],
    tags: ["local"],
    source_refs: [],
    difficulty_hint: null,
    module_ids: [],
    provenance: null,
    archived: false,
  };
}

test("Library installation persists a version-pinned sparse overlay and reloads synchronously", () => {
  const storage = createMemoryStorage();
  const store = createSmallStore(storage);
  const installed = installSmall(store);
  const rawText = storage.getItem(STORAGE_KEY);
  const raw = JSON.parse(rawText);
  const persistedDeck = raw.personalDecks[installed.id];

  assert.equal(raw.schemaVersion, 2);
  assert.equal(raw.persistenceFormat, "sparse-library-v1");
  assert.equal(persistedDeck.persistenceKind, "catalog-overlay-v1");
  assert.equal(persistedDeck.catalogDeckId, "sparse-library");
  assert.equal(persistedDeck.catalogVersion, "1");
  assert.deepEqual(persistedDeck.cardOverlays, {});
  assert.equal("cardOrder" in persistedDeck, false);
  assert.equal("edges" in persistedDeck, false);
  assert.equal(rawText.includes("IMMUTABLE-CATALOG-ALPHA"), false);

  const reloaded = createSmallStore(storage);
  const read = reloaded.getDeck({ scope: "personal", deck_id: installed.id });
  assert.equal(read.complete, true);
  assert.equal(read.card_count, 3);
  assert.equal(read.prerequisite_edge_count, 2);
  assert.equal(read.deck.cards[0].definition_md, smallCatalog()[0].cards[0].definition);
});

test("sparse overlays preserve metadata edits, card edits, identity migration, additions, reviews, and history", () => {
  const storage = createMemoryStorage();
  const store = createSmallStore(storage);
  const installed = installSmall(store, "overlay:install");
  const deckId = installed.id;

  const metadata = store.updateDeck({
    deck_id: deckId,
    expected_deck_revision: installed.revision,
    patch: { title: "Edited Sparse Library" },
    idempotency_key: "overlay:metadata",
  });
  const edited = store.updateCards({
    deck_id: deckId,
    expected_deck_revision: metadata.deck_revision,
    updates: [{
      card_id: `${deckId}.alpha`,
      patch: {
        definition_md: "A locally corrected alpha definition.",
        tags: ["corrected"],
      },
    }],
    idempotency_key: "overlay:edit-card",
  });
  const added = store.addCards({
    deck_id: deckId,
    expected_deck_revision: edited.deck_revision,
    cards: [completeAddedCard(deckId)],
    idempotency_key: "overlay:add-card",
  });
  const started = store.startStudySession({
    deck_id: deckId,
    limit: 1,
    idempotency_key: "overlay:start",
  });
  const graded = store.submitGrade({
    session_id: started.session.session_id,
    card_id: started.current_card.card_id,
    expected_card_revision: started.current_card.card_revision,
    expected_session_revision: started.session.session_revision,
    answer_text: "Alpha is the first definition.",
    answer_origin: "chat",
    rating: "good",
    rubric_evidence: [{
      rubric_item_id: "required-1",
      status: "met",
      note: "The defining point was present.",
    }],
    feedback: "Correct.",
    misconceptions: [],
    confidence: 0.95,
    idempotency_key: "overlay:grade",
  });
  assert.equal(graded.session.status, "completed");

  const raw = JSON.parse(storage.getItem(STORAGE_KEY));
  const persistedDeck = raw.personalDecks[deckId];
  assert.equal(persistedDeck.persistenceKind, "catalog-overlay-v1");
  assert.ok(Object.keys(persistedDeck.cardOverlays).length >= 4);
  assert.equal(persistedDeck.cardOverlays[`${deckId}.delta`].kind, "added");
  assert.equal(storage.getItem(STORAGE_KEY).includes("IMMUTABLE-CATALOG-BETA"), false);

  const reloaded = createSmallStore(storage);
  const snapshot = reloaded.getSnapshot();
  const deck = snapshot.personalDecks[deckId];
  assert.equal(deck.title, "Edited Sparse Library");
  assert.deepEqual(deck.cardOrder, [
    `${deckId}.alpha`,
    `${deckId}.beta`,
    `${deckId}.gamma`,
    `${deckId}.delta`,
  ]);
  assert.equal(deck.cards[`${deckId}.alpha`].definition, "A locally corrected alpha definition.");
  assert.deepEqual(deck.cards[`${deckId}.alpha`].tags, ["corrected"]);
  assert.equal(deck.cards[`${deckId}.alpha`].review.repetitions, 1);
  assert.equal(deck.cards[`${deckId}.alpha`].reviewHistory.length, 1);
  assert.deepEqual(deck.cards[`${deckId}.delta`].prerequisiteIds, [`${deckId}.alpha`]);
  assert.equal(deck.cards[`${deckId}.delta`].definition, "A locally added fourth definition.");
  assert.ok(deck.edges.some((edge) =>
    edge.prerequisiteCardId === `${deckId}.alpha`
      && edge.dependentCardId === `${deckId}.delta`));
  assert.equal(reloaded.getStudySession({ session_id: started.session.session_id }).session.status, "completed");
  assert.equal(reloaded.getSnapshot().revision, graded.receipt.app_revision);
  assert.equal(added.deck_revision + 1, deck.revision);
});

test("dense v1 learner state loads unchanged and compacts on the next persistence event", () => {
  const storage = createMemoryStorage();
  const store = createSmallStore(storage);
  const installed = installSmall(store, "dense-migration:install");
  const denseSnapshot = store.getSnapshot();
  assert.equal(denseSnapshot.schemaVersion, 1);
  storage.setItem(STORAGE_KEY, JSON.stringify(denseSnapshot));

  const legacyReload = createSmallStore(storage);
  assert.equal(
    legacyReload.getDeck({ scope: "personal", deck_id: installed.id }).deck.cards[0].definition_md,
    smallCatalog()[0].cards[0].definition,
  );
  legacyReload.setView({ route: "decks", selectedDeckId: installed.id });
  const compacted = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(compacted.schemaVersion, 2);
  assert.equal(compacted.persistenceFormat, "sparse-library-v1");
  assert.equal(compacted.personalDecks[installed.id].persistenceKind, "catalog-overlay-v1");
  assert.equal(storage.getItem(STORAGE_KEY).includes("IMMUTABLE-CATALOG-ALPHA"), false);
});

test("v2 replacement retains the sparse Library base across qualified identity migration and reload", () => {
  const storage = createMemoryStorage();
  const store = createSmallStore(storage);
  const installed = installSmall(store, "replace-overlay:install");
  const replacement = {
    schema_version: "normalized-definition-deck.v2",
    deck_id: installed.id,
    title: "Replaced Library Deck",
    cards: smallCatalog()[0].cards.map((card) => ({
      id: card.id,
      term: card.term,
      definition: card.definition,
      criteria: card.accepted_points,
      tags: [],
    })),
    edges: [{ from: "alpha", to: "beta" }, { from: "beta", to: "gamma" }],
  };
  const replaced = store.ingestDeck({
    operation: "replace",
    target_deck_id: installed.id,
    expected_deck_revision: installed.revision,
    deck: replacement,
    idempotency_key: "replace-overlay:replace",
  });
  assert.deepEqual(replaced.scheduling_impact.new_card_ids, []);
  assert.deepEqual(replaced.scheduling_impact.archived_card_ids, []);
  const persistedDeck = JSON.parse(storage.getItem(STORAGE_KEY)).personalDecks[installed.id];
  assert.equal(persistedDeck.persistenceKind, "catalog-overlay-v1");
  assert.equal(storage.getItem(STORAGE_KEY).includes("IMMUTABLE-CATALOG-ALPHA"), false);

  const reloaded = createSmallStore(storage);
  const read = reloaded.getDeck({ scope: "personal", deck_id: installed.id });
  assert.equal(read.deck.title, "Replaced Library Deck");
  assert.equal(read.card_count, 3);
  assert.equal(new Set(read.deck.cards.map((card) => card.card_id)).size, 3);
  assert.equal(read.deck.cards[0].card_id, `${installed.id}.alpha`);
  assert.equal(read.deck.cards[0].definition_md, replacement.cards[0].definition);
});

test("sparse state fails closed when its exact catalog base is unavailable", () => {
  const storage = createMemoryStorage();
  const store = createSmallStore(storage);
  const installed = installSmall(store, "missing-base:install");
  const raw = JSON.parse(storage.getItem(STORAGE_KEY));
  raw.personalDecks[installed.id].catalogVersion = "missing-version";
  storage.setItem(STORAGE_KEY, JSON.stringify(raw));
  assert.throws(
    () => createSmallStore(storage),
    (error) => error instanceof StudyStoreError && error.code === "CATALOG_BASE_UNAVAILABLE",
  );
});

test("same-version catalog content drift cannot silently change a sparse learner deck", () => {
  const storage = createMemoryStorage();
  installSmall(createSmallStore(storage), "catalog-drift:install");
  const changedCatalog = smallCatalog();
  changedCatalog[0].cards[0].definition = "Changed content without a version bump.";
  assert.throws(
    () => createStudyStore({ catalog: changedCatalog, storage, clock: () => new Date(NOW) }),
    (error) => error instanceof StudyStoreError && error.code === "CATALOG_BASE_UNAVAILABLE",
  );
});

test("a failed storage commit cannot poison the sparse deck cache for a later same-revision write", () => {
  const backing = createMemoryStorage();
  let failNextWrite = false;
  const storage = {
    getItem: backing.getItem,
    removeItem: backing.removeItem,
    setItem(key, value) {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("simulated quota failure");
      }
      backing.setItem(key, value);
    },
  };
  const store = createSmallStore(storage);
  const installed = installSmall(store, "cache-failure:install");
  const before = store.getSnapshot();
  failNextWrite = true;
  assert.throws(() => store.updateDeck({
    deck_id: installed.id,
    expected_deck_revision: installed.revision,
    patch: { title: "Must not persist" },
    idempotency_key: "cache-failure:failed",
  }), /simulated quota failure/);
  assert.deepEqual(store.getSnapshot(), before);

  store.updateDeck({
    deck_id: installed.id,
    expected_deck_revision: installed.revision,
    patch: { title: "Successful later title" },
    idempotency_key: "cache-failure:success",
  });
  const reloaded = createSmallStore(storage);
  assert.equal(reloaded.getSnapshot().personalDecks[installed.id].title, "Successful later title");
});

function exactScaleCatalog() {
  const deckCount = 83;
  const cardTotal = 12_877;
  const internalEdgeTotal = 15_478;
  const crossEdgeTotal = 425;
  const baseCards = Math.floor(cardTotal / deckCount);
  const extraCards = cardTotal % deckCount;
  let remainingExtraEdges = internalEdgeTotal - (cardTotal - deckCount);
  let remainingCrossEdges = crossEdgeTotal;
  const decks = [];

  for (let deckIndex = 0; deckIndex < deckCount; deckIndex += 1) {
    const deckId = `scale-${String(deckIndex).padStart(3, "0")}`;
    const cardCount = baseCards + (deckIndex < extraCards ? 1 : 0);
    const cards = Array.from({ length: cardCount }, (_, cardIndex) => {
      const cardId = `card-${String(cardIndex).padStart(3, "0")}`;
      const prerequisites = [];
      if (deckIndex > 0 && remainingCrossEdges > 0 && cardIndex < 6) {
        prerequisites.push(`scale-${String(deckIndex - 1).padStart(3, "0")}.card-000`);
        remainingCrossEdges -= 1;
      }
      return {
        id: cardId,
        term: `Scale term ${deckIndex}-${cardIndex}`,
        definition: `CATALOG-BYTES-${deckIndex}-${cardIndex} ${"definition ".repeat(70)}`,
        accepted_points: [`State scale term ${deckIndex}-${cardIndex}.`],
        prerequisites,
      };
    });
    const edges = [];
    for (let cardIndex = 1; cardIndex < cardCount; cardIndex += 1) {
      edges.push({
        prerequisite_card_id: `card-${String(cardIndex - 1).padStart(3, "0")}`,
        dependent_card_id: `card-${String(cardIndex).padStart(3, "0")}`,
      });
    }
    for (let gap = 2; gap < cardCount && remainingExtraEdges > 0; gap += 1) {
      for (let cardIndex = gap; cardIndex < cardCount && remainingExtraEdges > 0; cardIndex += 1) {
        edges.push({
          prerequisite_card_id: `card-${String(cardIndex - gap).padStart(3, "0")}`,
          dependent_card_id: `card-${String(cardIndex).padStart(3, "0")}`,
        });
        remainingExtraEdges -= 1;
      }
    }
    decks.push({
      id: deckId,
      title: `Scale Deck ${deckIndex}`,
      subject: `subject-${deckIndex % 8}`,
      level: "definition",
      version: "1",
      cards,
      edges,
    });
  }
  assert.equal(remainingExtraEdges, 0);
  assert.equal(remainingCrossEdges, 0);
  assert.equal(decks.reduce((sum, deck) => sum + deck.cards.length, 0), cardTotal);
  assert.equal(decks.reduce((sum, deck) => sum + deck.edges.length, 0), internalEdgeTotal);
  assert.equal(
    decks.reduce((sum, deck) => sum + deck.cards.reduce((count, card) => count + card.prerequisites.length, 0), 0),
    crossEdgeTotal,
  );
  return decks;
}

test("exact 83-deck scale keeps immutable catalog bytes out of learner storage and reloads bounded overlays", { timeout: 60_000 }, () => {
  const catalog = exactScaleCatalog();
  const catalogBytes = Buffer.byteLength(JSON.stringify(catalog));
  const storage = createMemoryStorage();
  const initializeStarted = performance.now();
  const store = createStudyStore({ catalog, storage, clock: () => new Date(NOW) });
  const initializeMs = performance.now() - initializeStarted;

  const installStarted = performance.now();
  for (const deck of catalog) {
    store.addLibraryDeck({
      library_deck_id: deck.id,
      expected_catalog_version: "1",
      client_action_id: `scale:install:${deck.id}`,
    });
  }
  const installMs = performance.now() - installStarted;
  const rawText = storage.getItem(STORAGE_KEY);
  const learnerBytes = Buffer.byteLength(rawText);
  const raw = JSON.parse(rawText);
  const denseSnapshotBytes = Buffer.byteLength(JSON.stringify(store.getSnapshot()));

  assert.equal(Object.keys(raw.personalDecks).length, 83);
  assert.ok(Object.values(raw.personalDecks).every((deck) => deck.persistenceKind === "catalog-overlay-v1"));
  assert.equal(rawText.includes("CATALOG-BYTES-0-0"), false);
  assert.ok(learnerBytes < catalogBytes * 0.1, `${learnerBytes} learner bytes should be below 10% of ${catalogBytes}`);
  assert.ok(learnerBytes < denseSnapshotBytes * 0.1);
  assert.ok(initializeMs < 5_000, `initialization took ${initializeMs.toFixed(1)} ms`);
  assert.ok(installMs < 30_000, `install took ${installMs.toFixed(1)} ms`);

  const reloadStarted = performance.now();
  const reloaded = createStudyStore({ catalog, storage, clock: () => new Date(NOW) });
  const reloadMs = performance.now() - reloadStarted;
  const snapshot = reloaded.getSnapshot();
  assert.equal(Object.keys(snapshot.personalDecks).length, 83);
  assert.equal(
    Object.values(snapshot.personalDecks).reduce((sum, deck) => sum + deck.cardOrder.length, 0),
    12_877,
  );
  assert.ok(reloadMs < 5_000, `reload took ${reloadMs.toFixed(1)} ms`);

  const deckId = "deck-scale-000";
  const startAt = performance.now();
  const started = reloaded.startStudySession({
    deck_id: deckId,
    limit: 1,
    idempotency_key: "scale:start",
  });
  const startMs = performance.now() - startAt;
  const gradeAt = performance.now();
  const graded = reloaded.submitGrade({
    session_id: started.session.session_id,
    card_id: started.current_card.card_id,
    expected_card_revision: started.current_card.card_revision,
    expected_session_revision: started.session.session_revision,
    answer_text: "Scale definition answer.",
    answer_origin: "chat",
    rating: "good",
    rubric_evidence: [{ rubric_item_id: "required-1", status: "met", note: "Definition present." }],
    feedback: "Correct.",
    misconceptions: [],
    confidence: 0.95,
    idempotency_key: "scale:grade",
  });
  const gradeMs = performance.now() - gradeAt;
  assert.equal(graded.session.status, "completed");
  assert.ok(startMs < 5_000, `start took ${startMs.toFixed(1)} ms`);
  assert.ok(gradeMs < 5_000, `grade took ${gradeMs.toFixed(1)} ms`);
  const reviewedReload = createStudyStore({ catalog, storage, clock: () => new Date(NOW) });
  const reviewedCard = reviewedReload.getSnapshot().personalDecks[deckId].cards["card-000"];
  assert.equal(reviewedCard.review.repetitions, 1);
  assert.equal(reviewedCard.reviewHistory.length, 1);

  // Expose exact measurements in the test receipt without creating an artifact.
  console.log(JSON.stringify({
    exact_scale: { decks: 83, cards: 12_877, prerequisite_edges: 15_903, cross_deck_edges: 425 },
    catalog_bytes: catalogBytes,
    dense_snapshot_bytes: denseSnapshotBytes,
    sparse_learner_bytes: learnerBytes,
    sparse_to_catalog_ratio: Number((learnerBytes / catalogBytes).toFixed(4)),
    initialize_ms: Number(initializeMs.toFixed(1)),
    install_all_ms: Number(installMs.toFixed(1)),
    reload_ms: Number(reloadMs.toFixed(1)),
    start_ms: Number(startMs.toFixed(1)),
    submit_grade_ms: Number(gradeMs.toFixed(1)),
  }));
});
