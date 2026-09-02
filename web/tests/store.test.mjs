import test from "node:test";
import assert from "node:assert/strict";

import {
  FSRS6_DEFAULT_WEIGHTS,
  StudyStoreError,
  createMemoryStorage,
  createStudyStore,
  fsrsFreshnessForReview,
  previewFsrsSchedule,
} from "../js/store.js";

const NOW = "2026-08-29T12:00:00.000Z";

function catalog() {
  return [
    {
      id: "linear-algebra-i",
      title: "Linear Algebra I",
      subject: "mathematics",
      level: "introductory",
      version: "2026.1",
      description: "Definition-first foundations of finite-dimensional linear algebra.",
      provenance: { source: "demo fixture" },
      license: { name: "CC-BY-4.0" },
      review_status: "example_only",
      cards: [
        {
          id: "vector-space",
          term: "vector space",
          definition: "A set with vector addition and scalar multiplication satisfying the vector-space axioms.",
          accepted_points: ["set", "addition", "scalar multiplication", "axioms"],
        },
        {
          id: "linear-combination",
          term: "linear combination",
          definition: "A finite sum of scalar multiples of vectors.",
        },
        {
          id: "span",
          term: "span",
          definition: "The set of all finite linear combinations of a collection of vectors.",
        },
        {
          id: "linear-independence",
          term: "linear independence",
          definition: "A collection whose only linear combination equal to zero has all coefficients zero.",
        },
        {
          id: "basis",
          term: "basis",
          definition: "A linearly independent spanning collection for a vector space.",
        },
        {
          id: "dimension",
          term: "dimension",
          definition: "The cardinality of any basis of a finite-dimensional vector space.",
        },
      ],
      edges: [
        { prerequisite_card_id: "vector-space", dependent_card_id: "linear-combination" },
        { prerequisite_card_id: "linear-combination", dependent_card_id: "span" },
        { prerequisite_card_id: "span", dependent_card_id: "basis" },
        { prerequisite_card_id: "linear-independence", dependent_card_id: "basis" },
        { prerequisite_card_id: "basis", dependent_card_id: "dimension" },
      ],
    },
    {
      id: "mechanics-i",
      title: "Mechanics I",
      subject: "physics",
      level: "introductory",
      version: "1",
      cards: [
        { id: "force", term: "force", definition: "An interaction that changes momentum." },
      ],
      edges: [],
    },
  ];
}

function makeStore(storage = createMemoryStorage()) {
  let current = new Date(NOW);
  return {
    storage,
    store: createStudyStore({ catalog: catalog(), storage, clock: () => current }),
    setTime(value) {
      current = new Date(value);
    },
  };
}

function install(store, action = "install-linear-algebra") {
  return store.addLibraryDeck({
    library_deck_id: "linear-algebra-i",
    expected_catalog_version: "2026.1",
    client_action_id: action,
  });
}

function assertCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof StudyStoreError);
    assert.equal(error.code, code);
    return true;
  });
}

const FSRS_ASSESSMENTS = Object.freeze({
  again: { verdict: "incorrect", confidence: 1, feedback: "The definition was not recalled.", misconceptions: [] },
  hard: { verdict: "partial", confidence: 0.8, feedback: "The definition was only partly recalled.", misconceptions: [] },
  good: { verdict: "correct", confidence: 0.9, feedback: "The definition was recalled.", misconceptions: [] },
  easy: { verdict: "correct", confidence: 0.99, feedback: "The definition was recalled fluently.", misconceptions: [] },
});

test("public FSRS preview matches the deterministic first-review intervals", () => {
  const review = {
    repetitions: 0,
    lapses: 0,
    stabilityDays: null,
    difficulty: null,
    lastReviewedAt: null,
  };
  const intervals = Object.fromEntries(
    ["again", "hard", "good", "easy"].map((rating) => [
      rating,
      previewFsrsSchedule(review, rating, NOW).intervalDays,
    ]),
  );
  assert.deepEqual(intervals, { again: 1, hard: 1, good: 2, easy: 8 });
  const scheduled = previewFsrsSchedule(review, "good", NOW);
  assert.equal(fsrsFreshnessForReview(scheduled, NOW), 1);
  assert.throws(
    () => previewFsrsSchedule(review, "good", "not-a-date"),
    (error) => error instanceof StudyStoreError && error.code === "INVALID_ARGUMENT",
  );
});

test("corrupt persisted state fails closed with a recoverable error code", () => {
  const storage = createMemoryStorage({
    "adaptive-study-lab:web-state:v1": "{not valid JSON",
  });
  assert.throws(
    () => createStudyStore({ catalog: catalog(), storage }),
    (error) => error instanceof StudyStoreError && error.code === "CORRUPT_STORAGE",
  );
});

function previewRating(store, deckId, rating, prefix, mode = "repair") {
  const started = store.startStudySession({
    deck_id: deckId,
    mode,
    limit: 1,
    ...(mode === "repair" ? { focus_card_ids: ["vector-space"] } : {}),
    client_action_id: `${prefix}-start`,
  });
  const captured = store.captureAnswer({
    session_id: started.session.id,
    card_id: started.current_card.id,
    answer: "A set with addition and scalar multiplication satisfying the axioms.",
    expected_session_revision: started.session.revision,
    client_action_id: `${prefix}-capture`,
  });
  const preview = store.previewReview({
    session_id: started.session.id,
    card_id: started.current_card.id,
    capture_id: captured.capture_id,
    assessment: FSRS_ASSESSMENTS[rating],
  });
  return { started, captured, preview };
}

function applyRating(store, deckId, rating, prefix, mode = "repair") {
  const result = previewRating(store, deckId, rating, prefix, mode);
  const applied = store.applyReview({
    review_token: result.preview.review_token,
    expected_session_revision: result.preview.session_revision,
    client_action_id: `${prefix}-apply`,
  });
  return { ...result, applied };
}

function assertApprox(actual, expected, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

function fsrsInitialDifficulty(rating) {
  return Math.min(
    10,
    Math.max(
      1,
      FSRS6_DEFAULT_WEIGHTS[4] -
        Math.exp(FSRS6_DEFAULT_WEIGHTS[5] * (rating - 1)) +
        1,
    ),
  );
}

function fsrsRetrievability(stability, elapsedDays) {
  const decay = -FSRS6_DEFAULT_WEIGHTS[20];
  const factor = 0.9 ** (1 / decay) - 1;
  return (1 + (factor * elapsedDays) / stability) ** decay;
}

function fsrsInterval(stability) {
  const decay = -FSRS6_DEFAULT_WEIGHTS[20];
  const factor = 0.9 ** (1 / decay) - 1;
  return Math.max(
    1,
    Math.min(
      36_500,
      Math.round((stability / factor) * (0.9 ** (1 / decay) - 1)),
    ),
  );
}

test("catalog install is version-pinned, persistent, and idempotent", () => {
  const { store, storage } = makeStore();
  assert.equal(store.searchLibrary({ query: "linear", subjects: ["mathematics"] }).total, 1);
  assertCode(
    () =>
      store.addLibraryDeck({
        library_deck_id: "linear-algebra-i",
        expected_catalog_version: "old",
        client_action_id: "wrong-version",
      }),
    "STALE_CATALOG_VERSION",
  );

  const installed = install(store);
  assert.equal(installed.deck.source.catalogDeckId, "linear-algebra-i");
  assert.equal(installed.deck.source.catalogVersion, "2026.1");
  assert.equal(installed.deck.progress.total_cards, 6);
  const revision = store.getSnapshot().revision;

  const replay = install(store);
  assert.deepEqual(replay, installed);
  assert.equal(store.getSnapshot().revision, revision);
  assertCode(
    () =>
      store.addLibraryDeck({
        library_deck_id: "mechanics-i",
        expected_catalog_version: "1",
        client_action_id: "install-linear-algebra",
      }),
    "IDEMPOTENCY_CONFLICT",
  );

  const reloaded = createStudyStore({ catalog: catalog(), storage, clock: () => new Date(NOW) });
  assert.equal(reloaded.listMyDecks({ status: "active", sort: "title", limit: 20 }).total, 1);
  assert.equal(reloaded.getSnapshot().revision, revision);
});

test("sequential writes and navigation from two browser contexts preserve newer learner state", () => {
  const storage = createMemoryStorage();
  const first = createStudyStore({ catalog: catalog(), storage, clock: () => new Date(NOW) });
  const second = createStudyStore({ catalog: catalog(), storage, clock: () => new Date(NOW) });

  const linear = install(first, "context-a-install").deck;
  second.addLibraryDeck({
    library_deck_id: "mechanics-i",
    expected_catalog_version: "1",
    client_action_id: "context-b-install",
  });
  first.setView({ route: "graph", selectedDeckId: linear.id });

  const reloaded = createStudyStore({ catalog: catalog(), storage, clock: () => new Date(NOW) });
  const snapshot = reloaded.getSnapshot();
  assert.equal(Object.keys(snapshot.personalDecks).length, 2);
  assert.equal(snapshot.revision, 2);
  assert.equal(snapshot.view.route, "graph");
  assert.equal(snapshot.view.selectedDeckId, linear.id);
});

test("unintroduced cards never appear due through deck or graph reads", () => {
  const { store } = makeStore();
  const deckId = install(store, "install-new-not-due").deck.id;
  const deck = store.inspectDeck({
    scope: "personal",
    deck_id: deckId,
    view: "cards",
    card_ids: ["vector-space"],
  });
  const graph = store.inspectDeckGraph({ deck_id: deckId, scope: "overview" });
  assert.equal(deck.cards[0].review.repetitions, 0);
  assert.equal(deck.cards[0].review.due_at, null);
  assert.equal(graph.nodes.find((node) => node.id === "vector-space").due_at, null);
  assert.equal(store.listMyDecks({}).decks[0].progress.due_count, 0);
});

test("graph focus effects preserve the requested concept instead of an arbitrary path endpoint", () => {
  const { store } = makeStore();
  const deckId = install(store, "install-graph-focus").deck.id;
  const focused = store.focusDeckGraph({
    deck_id: deckId,
    scope: "neighborhood",
    focus_card_id: "basis",
    depth: 2,
    fit: true,
  });
  assert.equal(focused.visible_effect.focus_card_id, "basis");
  assert.equal(focused.visible_effect.target_card_id, null);
  assert.ok(focused.visible_effect.node_ids.includes("basis"));
});

test("dependency paths fail with a specific card error for unknown endpoints", () => {
  const { store } = makeStore();
  const deckId = install(store, "install-path-card-guard").deck.id;
  assertCode(
    () => store.inspectDeckGraph({
      deck_id: deckId,
      scope: "dependency_path",
      focus_card_id: "missing-card",
      target_card_id: "missing-card",
    }),
    "CARD_NOT_FOUND",
  );
});

test("archive and restore are reversible and revision guarded", () => {
  const { store } = makeStore();
  const installed = install(store);
  const deckId = installed.deck.id;
  assertCode(
    () =>
      store.setDeckArchived({
        deck_id: deckId,
        archived: true,
        expected_revision: 99,
        client_action_id: "archive-stale",
      }),
    "STALE_REVISION",
  );
  const archived = store.setDeckArchived({
    deck_id: deckId,
    archived: true,
    expected_revision: installed.deck.revision,
    client_action_id: "archive",
  });
  assert.equal(archived.deck.archived, true);
  assert.equal(store.listMyDecks({ status: "archived", sort: "title", limit: 20 }).total, 1);
  const restored = store.setDeckArchived({
    deck_id: deckId,
    archived: false,
    expected_revision: archived.deck.revision,
    client_action_id: "restore",
  });
  assert.equal(restored.deck.archived, false);
});

test("archive fails closed while the deck has an active session", () => {
  const { store } = makeStore();
  const installed = install(store, "install-archive-session-guard").deck;
  const session = store.startStudySession({
    deck_id: installed.id,
    mode: "new",
    limit: 1,
    client_action_id: "start-archive-session-guard",
  });
  assertCode(
    () => store.setDeckArchived({
      deck_id: installed.id,
      archived: true,
      expected_revision: installed.revision,
      client_action_id: "archive-active-session",
    }),
    "DECK_IN_ACTIVE_SESSION",
  );
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.personalDecks[installed.id].archived, false);
  assert.equal(snapshot.sessions[session.session.id].status, "active");
});

test("view synchronization persists without changing learner revision", () => {
  const { store, storage } = makeStore();
  const deckId = install(store).deck.id;
  const before = store.getSnapshot();
  const changed = store.setView({ route: "graph", selectedDeckId: deckId });
  assert.deepEqual(changed, {
    ok: true,
    route: "graph",
    selected_deck_id: deckId,
    app_revision: before.revision,
    learner_revision_changed: false,
  });
  assert.equal(store.getSnapshot().revision, before.revision);
  assert.equal(store.inspectAppState().route, "graph");
  assert.equal(store.inspectAppState().selected_deck_id, deckId);

  const reloaded = createStudyStore({ catalog: catalog(), storage, clock: () => new Date(NOW) });
  assert.equal(reloaded.inspectAppState().route, "graph");
  assert.equal(reloaded.getSnapshot().revision, before.revision);
  assertCode(() => store.setView({ route: "cards", selectedDeckId: deckId }), "INVALID_ARGUMENT");
  assertCode(() => store.setView({ route: "library", selectedDeckId: "missing" }), "DECK_NOT_FOUND");
});

test("the active canonical definition is protected until answer commitment", () => {
  const { store } = makeStore();
  const deckId = install(store).deck.id;
  const started = store.startStudySession({
    deck_id: deckId,
    mode: "new",
    limit: 3,
    client_action_id: "start",
  });
  assert.deepEqual(started.current_card, { id: "vector-space", term: "vector space" });
  assert.equal("definition" in started.current_card, false);

  const inspected = store.inspectStudySession({ session_id: started.session.id });
  assert.equal(inspected.session.phase, "awaiting_answer");
  assert.equal("revealed_answer" in inspected, false);
  assert.equal(JSON.stringify(inspected).includes("vector-space axioms"), false);

  const personal = store.inspectDeck({
    scope: "personal",
    deck_id: deckId,
    view: "cards",
    card_ids: ["vector-space"],
  });
  assert.equal(personal.cards[0].definition_hidden, true);
  assert.equal("definition" in personal.cards[0], false);
  assert.equal("tags" in personal.cards[0], false);
  assert.equal("source_refs" in personal.cards[0], false);
  const library = store.inspectDeck({
    scope: "library",
    deck_id: "linear-algebra-i",
    view: "cards",
    card_ids: ["vector-space"],
  });
  assert.equal(library.cards[0].definition_hidden, true);
  assert.equal("definition" in library.cards[0], false);
  assert.equal("tags" in library.cards[0], false);
  assert.equal("source_refs" in library.cards[0], false);
  const graph = store.inspectDeckGraph({ deck_id: deckId, scope: "overview" });
  assert.equal(graph.nodes.some((node) => "definition" in node), false);

  const captured = store.captureAnswer({
    session_id: started.session.id,
    card_id: started.current_card.id,
    answer: "A set closed under addition and scalar multiplication.",
    expected_session_revision: started.session.revision,
    client_action_id: "capture",
  });
  assert.match(captured.review_packet.canonical_definition, /vector-space axioms/);
  const after = store.inspectStudySession({ session_id: started.session.id });
  assert.equal(after.session.phase, "answer_committed");
  assert.match(after.revealed_answer.canonical_definition, /vector-space axioms/);
  const nowVisible = store.inspectDeck({
    scope: "personal",
    deck_id: deckId,
    view: "cards",
    card_ids: ["vector-space"],
  });
  assert.match(nowVisible.cards[0].definition, /vector-space axioms/);
  assertCode(
    () =>
      store.captureAnswer({
        session_id: started.session.id,
        card_id: started.current_card.id,
        answer: "A second answer",
        expected_session_revision: captured.session_revision,
        client_action_id: "capture-again",
      }),
    "INVALID_SESSION_PHASE",
  );
});

test("a legacy committed active attempt resets to the atomic grading path on reload", () => {
  const { store, storage } = makeStore();
  const deckId = install(store, "install-legacy-session-reset").deck.id;
  const started = store.startStudySession({
    deck_id: deckId,
    mode: "new",
    limit: 1,
    client_action_id: "legacy-session-start",
  });
  const captured = store.captureAnswer({
    session_id: started.session.id,
    card_id: started.current_card.id,
    answer: "A set with addition and scalar multiplication satisfying the axioms.",
    expected_session_revision: started.session.revision,
    client_action_id: "legacy-session-capture",
  });
  const before = JSON.parse(storage.getItem("adaptive-study-lab:web-state:v1"));
  assert.equal(before.sessions[started.session.id].phase, "answer_committed");
  assert.ok(before.actionReceipts["legacy-session-capture"]);

  const reloaded = createStudyStore({
    catalog: catalog(),
    storage,
    clock: () => new Date(NOW),
  });
  const migrated = reloaded.getSnapshot();
  const migratedSession = migrated.sessions[started.session.id];
  assert.equal(migrated.revision, before.revision + 1);
  assert.equal(migratedSession.phase, "awaiting_answer");
  assert.equal(migratedSession.capture, null);
  assert.equal(migratedSession.revision, captured.session_revision + 1);
  assert.equal(migratedSession.history.at(-1).transition, "legacy_answer_reset");
  assert.equal("legacy-session-capture" in migrated.actionReceipts, false);
  assert.equal(
    "revealed_answer" in reloaded.inspectStudySession({ session_id: started.session.id }),
    false,
  );

  const target = reloaded.getStudySession({ session_id: started.session.id });
  const graded = reloaded.submitGrade({
    session_id: started.session.id,
    card_id: target.current_card.card_id,
    expected_card_revision: target.current_card.card_revision,
    expected_session_revision: target.session.session_revision,
    answer_text: "A set with addition and scalar multiplication satisfying the axioms.",
    answer_origin: "chat",
    rating: "good",
    rubric_evidence: [],
    feedback: "The defining operations and axioms were recalled.",
    misconceptions: [],
    confidence: 0.9,
    idempotency_key: "legacy-session-atomic-grade",
  });
  assert.equal(graded.session.status, "completed");
  assert.equal(graded.session.reviewed, 1);
  assert.equal(reloaded.getSnapshot().personalDecks[deckId].cards["vector-space"].reviewHistory.length, 1);
});

test("abandoning an unanswered session ends the attempt and a new attempt restores protection", () => {
  const { store } = makeStore();
  const deckId = install(store).deck.id;
  const started = store.startStudySession({
    deck_id: deckId,
    mode: "new",
    limit: 1,
    client_action_id: "start-then-abandon",
  });
  assertCode(
    () => store.finishStudySession({
      session_id: started.session.id,
      disposition: "abandon",
      expected_session_revision: started.session.revision + 1,
      client_action_id: "abandon-stale-session",
    }),
    "STALE_REVISION",
  );
  const abandoned = store.finishStudySession({
    session_id: started.session.id,
    disposition: "abandon",
    expected_session_revision: started.session.revision,
    client_action_id: "abandon-before-answer",
  });
  assert.equal(abandoned.session.status, "abandoned");
  assert.equal("revealed_answer" in store.inspectStudySession({ session_id: started.session.id }), false);
  store.startStudySession({
    deck_id: deckId,
    mode: "new",
    limit: 1,
    client_action_id: "restart-after-abandon",
  });
  const personal = store.inspectDeck({
    scope: "personal",
    deck_id: deckId,
    view: "cards",
    card_ids: [started.current_card.id],
  });
  const library = store.inspectDeck({
    scope: "library",
    deck_id: "linear-algebra-i",
    view: "cards",
    card_ids: [started.current_card.id],
  });
  assert.equal(personal.cards[0].definition_hidden, true);
  assert.equal(library.cards[0].definition_hidden, true);
  assert.equal("definition" in personal.cards[0], false);
  assert.equal("definition" in library.cards[0], false);
});

test("an unanswered queue cannot be marked complete to bypass definition protection", () => {
  const { store } = makeStore();
  const deckId = install(store, "install-completion-guard").deck.id;
  const started = store.startStudySession({
    deck_id: deckId,
    mode: "new",
    limit: 1,
    client_action_id: "start-completion-guard",
  });

  assertCode(
    () => store.finishStudySession({
      session_id: started.session.id,
      disposition: "complete",
      expected_session_revision: started.session.revision,
      client_action_id: "force-completion",
    }),
    "SESSION_NOT_COMPLETE",
  );
  const card = store.inspectDeck({
    scope: "personal",
    deck_id: deckId,
    view: "cards",
    card_ids: [started.current_card.id],
  }).cards[0];
  assert.equal(card.definition_hidden, true);
  assert.equal("definition" in card, false);
});

test("a committed answer must be reviewed before session transitions", () => {
  const { store } = makeStore();
  const deckId = install(store, "install-transition-guard").deck.id;
  const started = store.startStudySession({
    deck_id: deckId,
    mode: "new",
    limit: 1,
    client_action_id: "start-transition-guard",
  });
  store.captureAnswer({
    session_id: started.session.id,
    card_id: started.current_card.id,
    answer: "A set with addition and scalar multiplication satisfying the axioms.",
    expected_session_revision: started.session.revision,
    client_action_id: "capture-transition-guard",
  });

  assertCode(
    () => store.finishStudySession({
      session_id: started.session.id,
      disposition: "abandon",
      expected_session_revision: started.session.revision + 1,
      client_action_id: "abandon-with-pending-review",
    }),
    "REVIEW_NOT_APPLIED",
  );
  assertCode(
    () => store.startStudySession({
      deck_id: deckId,
      mode: "new",
      limit: 1,
      client_action_id: "start-over-pending-review",
    }),
    "ACTIVE_SESSION_EXISTS",
  );
});

test("definition-bearing capture receipts expire after their review is applied", () => {
  const { store, storage } = makeStore();
  const deckId = install(store, "install-receipt-expiry").deck.id;
  const started = store.startStudySession({
    deck_id: deckId,
    mode: "new",
    limit: 1,
    client_action_id: "start-receipt-expiry",
  });
  const captureArgs = {
    session_id: started.session.id,
    card_id: started.current_card.id,
    answer: "A set with addition and scalar multiplication satisfying the axioms.",
    expected_session_revision: started.session.revision,
    client_action_id: "capture-receipt-expiry",
  };
  const captured = store.captureAnswer(captureArgs);
  const preview = store.previewReview({
    session_id: started.session.id,
    card_id: started.current_card.id,
    capture_id: captured.capture_id,
    assessment: FSRS_ASSESSMENTS.good,
  });
  store.applyReview({
    review_token: preview.review_token,
    expected_session_revision: preview.session_revision,
    client_action_id: "apply-receipt-expiry",
  });

  assertCode(() => store.captureAnswer(captureArgs), "IDEMPOTENCY_RECEIPT_EXPIRED");
  const persisted = JSON.parse(storage.dump()["adaptive-study-lab:web-state:v1"]);
  assert.equal(persisted.actionReceipts["capture-receipt-expiry"].result.expired, true);
  assert.equal("review_packet" in persisted.actionReceipts["capture-receipt-expiry"].result, false);
});

test("a historical committed session cannot reveal an answer protected by a current attempt", () => {
  const { store, storage } = makeStore();
  const deckId = install(store, "install-historical-reveal-guard").deck.id;
  const started = store.startStudySession({
    deck_id: deckId,
    mode: "new",
    limit: 1,
    client_action_id: "start-historical-reveal-guard",
  });
  store.captureAnswer({
    session_id: started.session.id,
    card_id: started.current_card.id,
    answer: "A set with addition and scalar multiplication satisfying the axioms.",
    expected_session_revision: started.session.revision,
    client_action_id: "capture-historical-reveal-guard",
  });

  const key = "adaptive-study-lab:web-state:v1";
  const persisted = JSON.parse(storage.getItem(key));
  const historical = persisted.sessions[started.session.id];
  historical.status = "paused";
  const currentId = "session-current-protected-attempt";
  persisted.sessions[currentId] = {
    ...structuredClone(historical),
    id: currentId,
    status: "active",
    phase: "awaiting_answer",
    revision: 1,
    capture: null,
    history: [],
  };
  persisted.activeSessionId = currentId;
  persisted.revision += 1;
  storage.setItem(key, JSON.stringify(persisted));

  const reloaded = createStudyStore({ catalog: catalog(), storage, clock: () => new Date(NOW) });
  const inspected = reloaded.inspectStudySession({ session_id: started.session.id });
  assert.equal("revealed_answer" in inspected, false);
  const protectedCard = reloaded.inspectDeck({
    scope: "personal",
    deck_id: deckId,
    view: "cards",
    card_ids: [started.current_card.id],
  }).cards[0];
  assert.equal(protectedCard.definition_hidden, true);
});

test("review preview is non-mutating and apply follows the protected sequence", () => {
  const { store } = makeStore();
  const deckId = install(store).deck.id;
  const started = store.startStudySession({
    deck_id: deckId,
    mode: "new",
    limit: 2,
    client_action_id: "start-review",
  });
  assertCode(
    () =>
      store.previewReview({
        session_id: started.session.id,
        card_id: started.current_card.id,
        capture_id: "capture-missing",
        assessment: { verdict: "correct", confidence: 0.9, feedback: "Good.", misconceptions: [] },
      }),
    "INVALID_SESSION_PHASE",
  );
  const captured = store.captureAnswer({
    session_id: started.session.id,
    card_id: started.current_card.id,
    answer: "A set with addition and scalar multiplication satisfying axioms.",
    expected_session_revision: started.session.revision,
    client_action_id: "capture-review",
  });
  const beforePreview = store.getSnapshot();
  const preview = store.previewReview({
    session_id: started.session.id,
    card_id: started.current_card.id,
    capture_id: captured.capture_id,
    assessment: {
      verdict: "correct",
      confidence: 0.9,
      feedback: "The essential operations and axioms are present.",
      misconceptions: [],
    },
  });
  assert.equal(preview.phase, "review_previewed");
  assert.equal(preview.mutation_committed, false);
  assert.deepEqual(store.getSnapshot(), beforePreview);
  assert.equal(store.inspectStudySession({ session_id: started.session.id }).session.phase, "review_previewed");

  assertCode(
    () =>
      store.applyReview({
        review_token: preview.review_token,
        expected_session_revision: preview.session_revision - 1,
        client_action_id: "apply-wrong-revision",
      }),
    "STALE_REVISION",
  );
  const applied = store.applyReview({
    review_token: preview.review_token,
    expected_session_revision: preview.session_revision,
    client_action_id: "apply-review",
  });
  assert.equal(applied.phase, "applied");
  assert.equal(applied.rating, "good");
  assert.equal(applied.current_card.id, "linear-independence");
  assert.equal("definition" in applied.current_card, false);
  assert.equal(applied.streak.current, 1);
  const raw = store.getSnapshot();
  assert.deepEqual(
    raw.sessions[started.session.id].history.map((entry) => entry.transition),
    ["answer_committed", "review_previewed", "applied"],
  );
  assert.equal(raw.personalDecks[deckId].cards["vector-space"].review.repetitions, 1);
  assert.equal(raw.personalDecks[deckId].cards["vector-space"].review.algorithm, "fsrs-6-default-v1");
  assert.equal(raw.personalDecks[deckId].cards["vector-space"].review.exactFsrs, false);
  assert.equal(raw.personalDecks[deckId].cards["vector-space"].review.coreFormulaExact, true);

  const replay = store.applyReview({
    review_token: preview.review_token,
    expected_session_revision: preview.session_revision,
    client_action_id: "apply-review",
  });
  assert.deepEqual(replay, applied);
});

test("applying the last queued review produces a truthful completed session", () => {
  const { store } = makeStore();
  const deckId = install(store, "install-completion").deck.id;
  const { started, applied } = applyRating(store, deckId, "good", "completion", "new");
  const inspected = store.inspectStudySession({ session_id: started.session.id });
  assert.equal(applied.session.status, "completed");
  assert.equal(applied.session.completed, 1);
  assert.equal(applied.current_card, null);
  assert.equal(inspected.session.status, "completed");
  assert.equal(inspected.current_card, null);
  assert.equal(store.inspectAppState().active_session_id, null);
  assert.equal(store.listMyDecks({}).decks[0].progress.average_freshness, 1);
});

test("FSRS-6 defaults produce exact initial memory states and ordered first intervals", () => {
  const metadata = makeStore().store.schedulerMetadata();
  assert.equal(metadata.id, "fsrs-6-default-v1");
  assert.equal(metadata.exact_fsrs, false);
  assert.equal(metadata.core_formula_exact, true);
  assert.equal(metadata.desired_retention, 0.9);
  assert.deepEqual(metadata.default_weights, [...FSRS6_DEFAULT_WEIGHTS]);
  assert.equal(metadata.default_weights.length, 21);
  assert.equal(metadata.interval_fuzzing, false);
  assert.deepEqual(metadata.learning_steps, []);
  assert.deepEqual(metadata.relearning_steps, []);

  const results = [];
  for (const [index, rating] of ["again", "hard", "good", "easy"].entries()) {
    const { store } = makeStore();
    const deckId = install(store, `install-initial-${rating}`).deck.id;
    const { preview } = previewRating(store, deckId, rating, `initial-${rating}`, "new");
    const after = preview.schedule.after;
    assert.equal(after.stabilityDays, FSRS6_DEFAULT_WEIGHTS[index]);
    assertApprox(after.difficulty, fsrsInitialDifficulty(index + 1));
    assert.equal(after.repetitions, 1);
    assert.equal(after.lapses, rating === "again" ? 1 : 0);
    assert.equal(after.intervalDays, fsrsInterval(after.stabilityDays));
    results.push(after.intervalDays);
  }
  assert.deepEqual(results, [1, 1, 2, 8]);
  assert.ok(results[0] <= results[1] && results[1] < results[2] && results[2] < results[3]);
});

test("FSRS-6 same-day stability and damped mean-reverting difficulty match the formulas", () => {
  const { store } = makeStore();
  const deckId = install(store, "install-same-day").deck.id;
  const first = applyRating(store, deckId, "good", "same-day-first", "new");
  const previous = first.applied.schedule;
  const { preview } = previewRating(store, deckId, "hard", "same-day-second");
  const after = preview.schedule.after;
  const rating = 2;
  const increase =
    Math.exp(
      FSRS6_DEFAULT_WEIGHTS[17] *
        (rating - 3 + FSRS6_DEFAULT_WEIGHTS[18]),
    ) * previous.stabilityDays ** -FSRS6_DEFAULT_WEIGHTS[19];
  const expectedStability = Math.max(
    0.001,
    previous.stabilityDays * Math.max(increase, 1),
  );
  const delta = -(FSRS6_DEFAULT_WEIGHTS[6] * (rating - 3));
  const dampedDelta = ((10 - previous.difficulty) * delta) / 9;
  const easyInitialUnclamped =
    FSRS6_DEFAULT_WEIGHTS[4] - Math.exp(FSRS6_DEFAULT_WEIGHTS[5] * 3) + 1;
  const expectedDifficulty = Math.min(
    10,
    Math.max(
      1,
      FSRS6_DEFAULT_WEIGHTS[7] * easyInitialUnclamped +
        (1 - FSRS6_DEFAULT_WEIGHTS[7]) * (previous.difficulty + dampedDelta),
    ),
  );
  assertApprox(after.stabilityDays, expectedStability);
  assertApprox(after.difficulty, expectedDifficulty);
  assert.equal(after.intervalDays, fsrsInterval(expectedStability));
});

test("FSRS-6 retrievability and successful-recall stability match the formulas", () => {
  const fixture = makeStore();
  const { store, setTime } = fixture;
  const deckId = install(store, "install-recall").deck.id;
  const first = applyRating(store, deckId, "good", "recall-first", "new");
  const previous = first.applied.schedule;
  setTime("2026-08-31T12:00:00.000Z");
  const retrievability = fsrsRetrievability(previous.stabilityDays, 2);
  const graph = store.inspectDeckGraph({ deck_id: deckId, scope: "overview" });
  assert.equal(
    graph.nodes.find((node) => node.id === "vector-space").freshness,
    Math.round(retrievability * 10_000) / 10_000,
  );

  const { preview } = previewRating(store, deckId, "good", "recall-second");
  const after = preview.schedule.after;
  const expectedStability =
    previous.stabilityDays *
    (1 +
      Math.exp(FSRS6_DEFAULT_WEIGHTS[8]) *
        (11 - previous.difficulty) *
        previous.stabilityDays ** -FSRS6_DEFAULT_WEIGHTS[9] *
        (Math.exp((1 - retrievability) * FSRS6_DEFAULT_WEIGHTS[10]) - 1));
  assertApprox(after.stabilityDays, expectedStability);
  assert.equal(after.intervalDays, fsrsInterval(expectedStability));
  assert.ok(after.stabilityDays > previous.stabilityDays);
});

test("FSRS-6 Again uses post-lapse stability, increments lapses, and schedules safely", () => {
  const fixture = makeStore();
  const { store, setTime } = fixture;
  const deckId = install(store, "install-lapse").deck.id;
  const first = applyRating(store, deckId, "good", "lapse-first", "new");
  const previous = first.applied.schedule;
  setTime("2026-08-31T12:00:00.000Z");
  const retrievability = fsrsRetrievability(previous.stabilityDays, 2);
  const longTerm =
    FSRS6_DEFAULT_WEIGHTS[11] *
    previous.difficulty ** -FSRS6_DEFAULT_WEIGHTS[12] *
    ((previous.stabilityDays + 1) ** FSRS6_DEFAULT_WEIGHTS[13] - 1) *
    Math.exp((1 - retrievability) * FSRS6_DEFAULT_WEIGHTS[14]);
  const sameDayCap =
    previous.stabilityDays /
    Math.exp(FSRS6_DEFAULT_WEIGHTS[17] * FSRS6_DEFAULT_WEIGHTS[18]);
  const expectedStability = Math.max(0.001, Math.min(longTerm, sameDayCap));
  const { preview } = previewRating(store, deckId, "again", "lapse-second");
  const after = preview.schedule.after;
  assertApprox(after.stabilityDays, expectedStability);
  assert.equal(after.lapses, previous.lapses + 1);
  assert.equal(after.lastRating, "again");
  assert.equal(after.intervalDays, fsrsInterval(expectedStability));
  assert.ok(new Date(after.dueAt).getTime() > new Date(after.lastReviewedAt).getTime());
});

test("review tokens expire when any durable app state changes", () => {
  const { store } = makeStore();
  const deckId = install(store).deck.id;
  const started = store.startStudySession({
    deck_id: deckId,
    mode: "new",
    limit: 1,
    client_action_id: "stale-start",
  });
  const captured = store.captureAnswer({
    session_id: started.session.id,
    card_id: started.current_card.id,
    answer: "Answer",
    expected_session_revision: started.session.revision,
    client_action_id: "stale-capture",
  });
  const preview = store.previewReview({
    session_id: started.session.id,
    card_id: started.current_card.id,
    capture_id: captured.capture_id,
    assessment: { verdict: "incorrect", confidence: 1, feedback: "Missing the axioms.", misconceptions: [] },
  });
  store.addLibraryDeck({
    library_deck_id: "mechanics-i",
    expected_catalog_version: "1",
    client_action_id: "unrelated-write",
  });
  assertCode(
    () =>
      store.applyReview({
        review_token: preview.review_token,
        expected_session_revision: preview.session_revision,
        client_action_id: "stale-apply",
      }),
    "STALE_PREVIEW",
  );
  assertCode(
    () =>
      store.applyReview({
        review_token: "review-does-not-exist",
        expected_session_revision: preview.session_revision,
        client_action_id: "bad-token",
      }),
    "INVALID_PREVIEW_TOKEN",
  );
});

test("review previews expire after fifteen minutes and remain bounded", () => {
  const context = makeStore();
  const { store } = context;
  const deckId = install(store, "install-preview-ttl").deck.id;
  const started = store.startStudySession({
    deck_id: deckId,
    mode: "new",
    limit: 1,
    client_action_id: "start-preview-ttl",
  });
  const captured = store.captureAnswer({
    session_id: started.session.id,
    card_id: started.current_card.id,
    answer: "A set with addition and scalar multiplication satisfying the axioms.",
    expected_session_revision: started.session.revision,
    client_action_id: "capture-preview-ttl",
  });
  const previews = Array.from({ length: 65 }, (_, index) => store.previewReview({
    session_id: started.session.id,
    card_id: started.current_card.id,
    capture_id: captured.capture_id,
    assessment: {
      ...FSRS_ASSESSMENTS.good,
      feedback: `Accurate definition preview ${index}.`,
    },
  }));
  assertCode(
    () => store.applyReview({
      review_token: previews[0].review_token,
      expected_session_revision: previews[0].session_revision,
      client_action_id: "apply-evicted-preview",
    }),
    "INVALID_PREVIEW_TOKEN",
  );

  context.setTime("2026-08-29T12:16:00.000Z");
  assertCode(
    () => store.applyReview({
      review_token: previews.at(-1).review_token,
      expected_session_revision: previews.at(-1).session_revision,
      client_action_id: "apply-expired-preview",
    }),
    "INVALID_PREVIEW_TOKEN",
  );
});

test("legacy repair sessions retain topological order without bypassing required first-introduction gates", () => {
  const { store } = makeStore();
  const deckId = install(store).deck.id;
  const repair = store.startStudySession({
    deck_id: deckId,
    mode: "repair",
    limit: 10,
    focus_card_ids: ["dimension"],
    client_action_id: "repair",
  });
  assert.deepEqual(store.getSnapshot().sessions[repair.session.id].queue, [
    "vector-space",
    "linear-independence",
  ]);
  const abandoned = store.finishStudySession({
    session_id: repair.session.id,
    disposition: "abandon",
    expected_session_revision: repair.session.revision,
    client_action_id: "abandon-repair",
  });
  assert.equal(abandoned.session.status, "abandoned");
  assert.equal(abandoned.summary.reviewed, 0);
  assert.equal(store.inspectAppState().active_session_id, null);
});

test("new and mixed sessions do not introduce children before prerequisite Good/Easy recall", () => {
  const { store } = makeStore();
  const deckId = install(store, "install-prerequisite-gate").deck.id;
  const first = store.startStudySession({
    deck_id: deckId,
    mode: "new",
    limit: 20,
    client_action_id: "start-prerequisite-gate",
  });
  assert.ok(first.session.total >= 1);
  const firstQueue = store.getSnapshot().sessions[first.session.id].queue;
  assert.ok(firstQueue.includes("vector-space"));
  assert.ok(firstQueue.includes("linear-independence"));
  assert.equal(firstQueue.includes("linear-combination"), false);
  assert.equal(firstQueue.includes("basis"), false);
});

test("an empty due queue returns a distinct no-animation result", () => {
  const { store } = makeStore();
  const deckId = install(store, "install-empty-due").deck.id;
  const started = store.startStudySession({
    deck_id: deckId,
    mode: "due",
    limit: 20,
    client_action_id: "start-empty-due",
  });
  assert.equal(started.session.status, "completed");
  assert.equal(started.current_card, null);
  assert.equal(started.visible_effect.type, "study_queue_empty");
  assert.equal(started.visible_effect.animation, "none");
});

test("starting a second session is rejected while one remains active", () => {
  const { store } = makeStore();
  const deckId = install(store).deck.id;
  const first = store.startStudySession({
    deck_id: deckId,
    mode: "new",
    limit: 1,
    client_action_id: "first-session",
  });
  assertCode(
    () => store.startStudySession({
      deck_id: deckId,
      mode: "new",
      limit: 1,
      client_action_id: "second-session",
    }),
    "ACTIVE_SESSION_EXISTS",
  );
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.sessions[first.session.id].status, "active");
  assert.equal(snapshot.activeSessionId, first.session.id);
});

test("authoring uses a non-mutating DAG-validated preview and exact apply token", () => {
  const { store } = makeStore();
  const before = store.getSnapshot();
  const preview = store.previewDeckChanges({
    target: { kind: "new", deck_id: "tiny-economics", title: "Tiny Economics", subject: "economics" },
    cards_upsert: [
      { id: "scarcity", term: "scarcity", definition: "Finite resources relative to wants." },
      { id: "opportunity-cost", term: "opportunity cost", definition: "The value of the best forgone alternative." },
    ],
    edges_upsert: [
      { prerequisite_card_id: "scarcity", dependent_card_id: "opportunity-cost" },
    ],
    card_ids_archive: [],
    edge_ids_remove: [],
  });
  assert.equal(preview.validation.acyclic, true);
  assert.equal(preview.mutation_committed, false);
  assert.deepEqual(store.getSnapshot(), before);
  const applied = store.applyDeckChanges({
    preview_token: preview.preview_token,
    expected_base_revision: 0,
    client_action_id: "apply-new-deck",
  });
  assert.equal(applied.deck.id, "tiny-economics");
  assert.equal(store.listMyDecks({ status: "active", sort: "title", limit: 20 }).total, 1);

  assertCode(
    () =>
      store.previewDeckChanges({
        target: { kind: "existing", deck_id: "tiny-economics", expected_revision: applied.deck.revision },
        cards_upsert: [],
        edges_upsert: [
          { prerequisite_card_id: "opportunity-cost", dependent_card_id: "scarcity" },
        ],
        card_ids_archive: [],
        edge_ids_remove: [],
      }),
    "DAG_CYCLE",
  );
  assertCode(
    () =>
      store.applyDeckChanges({
        preview_token: "deck-preview-missing",
        expected_base_revision: 0,
        client_action_id: "missing-preview",
      }),
    "INVALID_PREVIEW_TOKEN",
  );
});

test("authoring preserves omitted metadata, resets changed-content review state, and marks derived provenance", () => {
  const { store } = makeStore();
  const deckId = install(store, "install-content-edit").deck.id;
  applyRating(store, deckId, "good", "learn-before-edit", "repair");
  const before = store.getSnapshot().personalDecks[deckId];
  assert.equal(before.cards["vector-space"].review.repetitions, 1);
  assert.deepEqual(before.cards["vector-space"].acceptedPoints, [
    "set",
    "addition",
    "scalar multiplication",
    "axioms",
  ]);

  const preview = store.previewDeckChanges({
    target: { kind: "existing", deck_id: deckId, expected_revision: before.revision },
    cards_upsert: [{
      id: "vector-space",
      term: "real vector space",
      definition: "A vector space whose scalar field is the real numbers.",
    }],
    edges_upsert: [],
    card_ids_archive: [],
    edge_ids_remove: [],
  });
  assert.deepEqual(preview.diff.reviews_reset, ["vector-space"]);
  const applied = store.applyDeckChanges({
    preview_token: preview.preview_token,
    expected_base_revision: before.revision,
    client_action_id: "apply-content-edit",
  });
  const after = store.getSnapshot().personalDecks[deckId];
  assert.equal(applied.deck.source.kind, "library_derived");
  assert.equal(after.source.catalogVersion, "2026.1");
  assert.equal(after.source.locallyModified, true);
  assert.equal(after.cards["vector-space"].review.repetitions, 0);
  assert.deepEqual(after.cards["vector-space"].acceptedPoints, before.cards["vector-space"].acceptedPoints);
});

test("authoring rejects duplicate prerequisite pairs instead of overstating the preview diff", () => {
  const { store } = makeStore();
  const installed = install(store, "install-edge-pair-guard").deck;
  assertCode(
    () => store.previewDeckChanges({
      target: { kind: "existing", deck_id: installed.id, expected_revision: installed.revision },
      cards_upsert: [],
      edges_upsert: [{
        id: "alternate-edge-id",
        prerequisite_card_id: "vector-space",
        dependent_card_id: "linear-combination",
      }],
      card_ids_archive: [],
      edge_ids_remove: [],
    }),
    "EDGE_PAIR_EXISTS",
  );
});

test("authoring cannot invalidate the deck under an active study session", () => {
  const { store } = makeStore();
  const installed = install(store);
  store.startStudySession({
    deck_id: installed.deck.id,
    mode: "new",
    limit: 1,
    client_action_id: "authoring-lock-session",
  });
  assertCode(
    () =>
      store.previewDeckChanges({
        target: {
          kind: "existing",
          deck_id: installed.deck.id,
          expected_revision: installed.deck.revision,
        },
        cards_upsert: [],
        edges_upsert: [],
        card_ids_archive: [],
        edge_ids_remove: [],
      }),
    "DECK_IN_ACTIVE_SESSION",
  );
});

test("explicit first-run demo seeding is deterministic, varied, and blocked after learner history", () => {
  const { store } = makeStore();
  const deckId = install(store).deck.id;
  const seeded = store.seedDemoState(deckId);
  assert.equal(seeded.demo_state, true);
  assert.equal(seeded.seeded_reviews, 5);
  assert.equal(seeded.deck.progress.new_count, 1);
  assert.ok(seeded.deck.progress.due_count > 0);
  assert.ok(seeded.deck.progress.average_learnedness > 0);
  assert.equal(store.inspectAppState().streak.current, 6);
  const demoActivity = store.getSnapshot().activity.filter(
    (event) => event.type === "demo_review_activity",
  );
  assert.equal(demoActivity.length, 7);
  assert.deepEqual(demoActivity.map((event) => event.reviewCount), [1, 1, 2, 4, 7, 3, 1]);
  const seededReviews = Object.values(store.getSnapshot().personalDecks[deckId].cards)
    .map((card) => card.review)
    .filter((review) => review.repetitions > 0);
  assert.ok(seededReviews.every((review) => review.algorithm === "fsrs-6-default-v1"));
  assert.ok(seededReviews.every((review) => review.coreFormulaExact === true));
  assert.ok(seededReviews.every((review) => review.demoSeeded === true));
  assert.deepEqual(store.seedDemoState(deckId), seeded);

  const other = makeStore().store;
  const otherDeckId = install(other).deck.id;
  const session = other.startStudySession({
    deck_id: otherDeckId,
    mode: "new",
    limit: 1,
    client_action_id: "real-activity",
  });
  assert.ok(session.session.id);
  assertCode(() => other.seedDemoState(otherDeckId), "DEMO_SEED_NOT_EMPTY");
});
