import { projectStreak, recordLocalStreak } from "./streak.js";
import { isPreparedLibraryCatalog } from "./library-catalog.js";

const SCHEMA_VERSION = 1;
const STORAGE_KEY = "adaptive-study-lab:web-state:v1";
const PERSISTENCE_SCHEMA_VERSION = 2;
const PERSISTENCE_FORMAT = "sparse-library-v1";
const CATALOG_OVERLAY_KIND = "catalog-overlay-v1";
const CATALOG_DIGEST_CACHE = new WeakMap();
const PREPARED_CATALOG_CACHE = new WeakMap();
const LIBRARY_CARD_OWNER_CACHE = new WeakMap();
const RETAINED_CATALOG_REGISTRY = new WeakMap();
const DAY_MS = 86_400_000;
const MAX_ACTION_RECEIPTS = 256;
const MAX_ACTIVITY = 200;
const MAX_EPHEMERAL_PREVIEWS = 64;
const PREVIEW_TTL_MS = 15 * 60 * 1_000;
const FSRS6_ALGORITHM_ID = "fsrs-6-default-v1";
const FSRS6_TARGET_RETENTION = 0.9;
const FSRS6_MAXIMUM_INTERVAL_DAYS = 36_500;
const FSRS6_STABILITY_MIN = 0.001;
const FSRS6_DIFFICULTY_MIN = 1;
const FSRS6_DIFFICULTY_MAX = 10;
const STUDY_ELIGIBILITY_POLICY_VERSION = "deck-local-v1";
const SHOWCASE_DEMO_DECKS = Object.freeze([
  Object.freeze({ catalogId: "academic-reviewed-v1:applied-statistics-i", profile: "established", archived: false }),
  Object.freeze({ catalogId: "academic-reviewed-v1:linear-algebra-i", profile: "building", archived: false }),
  Object.freeze({ catalogId: "academic-reviewed-v1:algorithms-i", profile: "started", archived: false }),
  Object.freeze({ catalogId: "academic-reviewed-v1:mechanics-i", profile: "mastered", archived: false }),
  Object.freeze({ catalogId: "academic-reviewed-v1:analytical-chemistry", profile: "established", archived: true }),
]);

// FSRS-6 default parameters published by the Open Spaced Repetition project.
// Formula names and indices below follow the project's algorithm specification
// and py-fsrs reference implementation. Keeping the parameters in this module
// makes the browser scheduler deterministic and dependency-free.
export const FSRS6_DEFAULT_WEIGHTS = Object.freeze([
  0.212,
  1.2931,
  2.3065,
  8.2956,
  6.4133,
  0.8334,
  3.0194,
  0.001,
  1.8722,
  0.1666,
  0.796,
  1.4835,
  0.0614,
  0.2629,
  1.6483,
  0.6014,
  1.8729,
  0.5425,
  0.0912,
  0.0658,
  0.1542,
]);

const FSRS6_DECAY = -FSRS6_DEFAULT_WEIGHTS[20];
const FSRS6_FACTOR = FSRS6_TARGET_RETENTION ** (1 / FSRS6_DECAY) - 1;
const FSRS6_RATING_VALUES = Object.freeze({ again: 1, hard: 2, good: 3, easy: 4 });
const VIEW_ROUTES = Object.freeze(["study", "decks", "library", "graph", "session"]);
const STORE_CAPABILITIES = Object.freeze({
  library: true,
  personal_decks: true,
  dependency_graph: true,
  protected_definition_study: true,
  self_grading: true,
  revealed_attempts: true,
  skipped_attempts: true,
  preview_apply_authoring: true,
  hard_delete: true,
});
export class StudyStoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "StudyStoreError";
    this.code = code;
    if (details !== undefined) this.details = jsonClone(details);
  }
}

export function createMemoryStorage(initial = {}) {
  const values = new Map(
    Object.entries(initial).map(([key, value]) => [key, String(value)]),
  );
  return {
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
    clear() {
      values.clear();
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    get length() {
      return values.size;
    },
    dump() {
      return Object.fromEntries(values);
    },
  };
}

export function createStudyStore({ catalog, retainedCatalogs = [], storage, clock, timeZone } = {}) {
  const catalogDecks = catalogWithRetainedBases(catalog ?? [], retainedCatalogs);
  const storageAdapter = resolveStorage(storage);
  const now = createClock(clock);
  const persistedDeckCache = new Map();
  // A weak, count-only read cache never retains prior snapshots or answer text.
  const studyActivityCache = new WeakMap();
  let state = loadState(storageAdapter, catalogDecks, {
    migrateLegacyAttempt: true,
    deckCache: persistedDeckCache,
  });

  // Preview tokens intentionally live outside persisted learner state. Creating a
  // preview must not change progress, revisions, scheduling, or localStorage.
  const reviewPreviews = new Map();
  const reviewPreviewByCapture = new Map();
  const deckPreviews = new Map();

  function clearEphemeralPreviews() {
    reviewPreviews.clear();
    reviewPreviewByCapture.clear();
    deckPreviews.clear();
  }

  function removeReviewPreview(token) {
    const preview = reviewPreviews.get(token);
    reviewPreviews.delete(token);
    if (preview && reviewPreviewByCapture.get(preview.captureId) === token) {
      reviewPreviewByCapture.delete(preview.captureId);
    }
  }

  function pruneEphemeralPreviews(at = now()) {
    const cutoff = at.valueOf() - PREVIEW_TTL_MS;
    for (const [token, preview] of reviewPreviews) {
      if (new Date(preview.createdAt).valueOf() < cutoff) removeReviewPreview(token);
    }
    for (const [token, preview] of deckPreviews) {
      if (new Date(preview.createdAt).valueOf() < cutoff) deckPreviews.delete(token);
    }
    while (reviewPreviews.size >= MAX_EPHEMERAL_PREVIEWS) {
      removeReviewPreview(reviewPreviews.keys().next().value);
    }
    while (deckPreviews.size >= MAX_EPHEMERAL_PREVIEWS) {
      deckPreviews.delete(deckPreviews.keys().next().value);
    }
  }

  function refreshStateFromStorage() {
    const persistedRevision = readStoredRevision(storageAdapter);
    if (persistedRevision !== state.revision) {
      persistedDeckCache.clear();
      state = loadState(storageAdapter, catalogDecks, { deckCache: persistedDeckCache });
      clearEphemeralPreviews();
    }
    return state;
  }

  function persist(nextState, expectedRevision = state.revision) {
    const persistedRevision = readStoredRevision(storageAdapter);
    if (persistedRevision !== expectedRevision) {
      persistedDeckCache.clear();
      state = loadState(storageAdapter, catalogDecks, { deckCache: persistedDeckCache });
      clearEphemeralPreviews();
      fail("STALE_APP_REVISION", "Browser learner state changed in another context", {
        expected: expectedRevision,
        actual: persistedRevision,
      });
    }
    const nextDeckCache = new Map(persistedDeckCache);
    const serialized = JSON.stringify(
      serializeStateForStorage(nextState, catalogDecks, nextDeckCache),
    );
    // Write before replacing the in-memory snapshot so a quota/storage failure
    // cannot create a partially committed browser state.
    storageAdapter.setItem(STORAGE_KEY, serialized);
    persistedDeckCache.clear();
    for (const [deckId, entry] of nextDeckCache) persistedDeckCache.set(deckId, entry);
    state = nextState;
  }

  function withWrite(operation, rawArgs, mutate) {
    refreshStateFromStorage();
    const args = jsonClone(rawArgs ?? {});
    const actionId = requireActionId(args.client_action_id);
    const fingerprint = stableHash({ operation, args });
    const previous = state.actionReceipts[actionId];
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        fail(
          "IDEMPOTENCY_CONFLICT",
          `client_action_id ${actionId} was already used with different input`,
        );
      }
      if (operation === "capture_answer") {
        const session = state.sessions[args.session_id];
        const sameCommittedCapture =
          session?.status === "active" &&
          session.phase === "answer_committed" &&
          session.capture?.id === previous.result?.capture_id &&
          !protectedPersonalCard(state, session.deckId, session.currentCardId);
        if (!sameCommittedCapture) {
          fail(
            "IDEMPOTENCY_RECEIPT_EXPIRED",
            "This answer-capture receipt no longer belongs to the current committed attempt",
          );
        }
      }
      return jsonClone(previous.result);
    }

    const nextState = jsonClone(state);
    const result = mutate(nextState);
    nextState.revision = state.revision + 1;
    nextState.updatedAt = now().toISOString();
    const safeResult = jsonClone({
      ok: true,
      ...result,
      app_revision: nextState.revision,
      receipt: {
        client_action_id: actionId,
        operation,
        previous_app_revision: state.revision,
        app_revision: nextState.revision,
      },
    });
    nextState.actionReceipts[actionId] = { fingerprint, result: safeResult };
    nextState.actionReceiptOrder.push(actionId);
    while (nextState.actionReceiptOrder.length > MAX_ACTION_RECEIPTS) {
      const expired = nextState.actionReceiptOrder.shift();
      delete nextState.actionReceipts[expired];
    }
    persist(nextState);
    return jsonClone(safeResult);
  }

  function withTargetWrite(operation, rawArgs, mutate) {
    refreshStateFromStorage();
    const args = jsonClone(rawArgs ?? {});
    const idempotencyKey = requiredString(
      args.idempotency_key,
      "idempotency_key",
      128,
    );
    const receiptKey = `webmcp:${idempotencyKey}`;
    const fingerprint = stableHash({ operation, args });
    const previous = state.actionReceipts[receiptKey];
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        fail(
          "IDEMPOTENCY_CONFLICT",
          `idempotency_key ${idempotencyKey} was already used with different input`,
        );
      }
      const replay = jsonClone(previous.result);
      replay.receipt.replayed = true;
      return replay;
    }

    const nextState = jsonClone(state);
    const previousRevision = state.revision;
    const committedAt = now().toISOString();
    const result = mutate(nextState, committedAt);
    nextState.revision = previousRevision + 1;
    nextState.updatedAt = committedAt;
    const receipt = {
      transaction_id: `tx-${stableHash({ operation, idempotencyKey, committedAt, previousRevision })}`,
      operation,
      idempotency_key: idempotencyKey,
      replayed: false,
      committed_at: committedAt,
      previous_app_revision: previousRevision,
      app_revision: nextState.revision,
    };
    const safeResult = jsonClone({ ...result, receipt });
    nextState.actionReceipts[receiptKey] = { fingerprint, result: safeResult };
    nextState.actionReceiptOrder.push(receiptKey);
    while (nextState.actionReceiptOrder.length > MAX_ACTION_RECEIPTS) {
      const expired = nextState.actionReceiptOrder.shift();
      delete nextState.actionReceipts[expired];
    }
    persist(nextState);
    return jsonClone(safeResult);
  }

  function inspectAppState() {
    refreshStateFromStorage();
    const personalDecks = Object.values(state.personalDecks);
    const activeDecks = personalDecks.filter((deck) => !deck.archived);
    const nowDate = now();
    return jsonClone({
      ok: true,
      schema_version: state.schemaVersion,
      app_revision: state.revision,
      route: state.view.route,
      auth_mode: "local_single_user_origin",
      authorization_boundary: "Top-level same-origin page state; no account identity in this local candidate.",
      selected_deck_id: state.view.selectedDeckId,
      active_session_id: state.activeSessionId,
      deck_counts: {
        active: activeDecks.length,
        archived: personalDecks.length - activeDecks.length,
      },
      due_total: activeDecks.reduce(
        (sum, deck) => sum + deckMetrics(deck, nowDate).due_count,
        0,
      ),
      streak: projectStreak(state.streak, now(), { timeZone }),
      recent_activity: state.activity.slice(-20).reverse(),
      scheduler: schedulerMetadata(),
      capabilities: STORE_CAPABILITIES,
    });
  }

  function setView(rawArgs = {}) {
    refreshStateFromStorage();
    const args = objectArgs(rawArgs);
    const route = enumValue(args.route, "route", VIEW_ROUTES);
    let selectedDeckId = state.view.selectedDeckId;
    if (Object.hasOwn(args, "selectedDeckId")) {
      if (args.selectedDeckId === null) {
        selectedDeckId = null;
      } else {
        selectedDeckId = requireId(args.selectedDeckId, "selectedDeckId");
        requirePersonalDeck(state, selectedDeckId, { allowArchived: true });
      }
    }

    if (state.view.route !== route || state.view.selectedDeckId !== selectedDeckId) {
      const nextState = jsonClone(state);
      nextState.view = { route, selectedDeckId };
      // View synchronization is browser navigation state, not a learner
      // transaction. Persist it without consuming an idempotency key or
      // changing the app/deck/session revisions used by preview/apply guards.
      persist(nextState);
    }
    return jsonClone({
      ok: true,
      route,
      selected_deck_id: selectedDeckId,
      app_revision: state.revision,
      learner_revision_changed: false,
    });
  }

  function searchLibrary(rawArgs = {}, context = {}) {
    const args = objectArgs(rawArgs);
    if (context?.source === "webmcp") {
      return searchLibraryTarget(args);
    }
    const query = optionalString(args.query, "query", 200)?.toLowerCase() ?? "";
    const subjects = optionalStringArray(args.subjects, "subjects", 20).map((s) =>
      s.toLowerCase(),
    );
    const levels = optionalStringArray(args.levels, "levels", 20).map((s) =>
      s.toLowerCase(),
    );
    const limit = boundedInteger(args.limit ?? 12, "limit", 1, 20);
    const offset = decodeCursor(args.cursor);

    const matches = [...catalogDecks.values()]
      .filter((deck) => {
        if (subjects.length && !subjects.includes(deck.subject.toLowerCase())) return false;
        if (levels.length && !levels.includes(deck.level.toLowerCase())) return false;
        if (!query) return true;
        const haystack = [
          deck.title,
          deck.description,
          deck.subject,
          deck.level,
          ...(deck.librarySummary?.sample_terms ?? deck.cards.slice(0, 30).map((card) => card.term)),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => a.title.localeCompare(b.title));
    const page = matches.slice(offset, offset + limit);
    return jsonClone({
      ok: true,
      results: page.map((deck) => librarySummary(deck)),
      total: matches.length,
      next_cursor: offset + limit < matches.length ? encodeCursor(offset + limit) : null,
    });
  }

  function inspectDeck(rawArgs = {}) {
    refreshStateFromStorage();
    const args = objectArgs(rawArgs);
    const scope = enumValue(args.scope, "scope", ["library", "personal"]);
    const deckId = requireId(args.deck_id, "deck_id");
    const view = enumValue(args.view ?? "summary", "view", ["summary", "cards"]);

    if (scope === "library") {
      const deck = requireCatalogDeck(catalogDecks, deckId);
      if (view === "summary") {
        return jsonClone({ ok: true, deck: libraryDetail(deck, state) });
      }
      if (deck.contentResolved === false) {
        fail("CATALOG_BASE_UNAVAILABLE", `The exact Library deck ${deckId} was not resolved before its card read`);
      }
      return jsonClone({
        ok: true,
        deck: libraryDetail(deck, state),
        ...pageCards(deck.cards, args, (card) =>
          exposeCatalogCard(deck.id, card, state),
        ),
      });
    }

    const deck = requirePersonalDeck(state, deckId, { allowArchived: true });
    if (view === "summary") {
      return jsonClone({ ok: true, deck: personalDeckSummary(deck, now()) });
    }
    const activeCards = deck.cardOrder
      .map((id) => deck.cards[id])
      .filter(Boolean)
      .filter((card) => !card.archived);
    return jsonClone({
      ok: true,
      deck: personalDeckSummary(deck, now()),
      ...pageCards(activeCards, args, (card) => exposePersonalCard(deck.id, card, state, now())),
    });
  }

  function addLibraryDeck(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    const catalogId = requireId(args.library_deck_id, "library_deck_id");
    const catalogDeck = requireCatalogDeck(catalogDecks, catalogId);
    if (catalogDeck.contentResolved === false) {
      fail("CATALOG_BASE_UNAVAILABLE", `The exact Library course ${catalogId} was not resolved before installation`);
    }
    const expectedVersion = requiredString(
      String(args.expected_catalog_version ?? ""),
      "expected_catalog_version",
      128,
    );
    if (String(catalogDeck.version) !== expectedVersion) {
      fail("STALE_CATALOG_VERSION", "The catalog deck version changed", {
        expected: expectedVersion,
        actual: String(catalogDeck.version),
      });
    }

    return withWrite("add_library_deck", args, (nextState) => {
      if (catalogDeck.libraryBase) {
        return installSelectedLibraryDeck(
          nextState, catalogDeck, now().toISOString(), args.client_action_id,
        );
      }
      const existing = Object.values(nextState.personalDecks).find(
        (deck) => deck.source?.catalogDeckId === catalogId,
      );
      if (existing) {
        if (existing.archived) {
          existing.archived = false;
          existing.revision += 1;
          existing.updatedAt = now().toISOString();
        }
        nextState.view.selectedDeckId = existing.id;
        return {
          deck: personalDeckSummary(existing, now()),
          already_installed: true,
          visible_effect: { type: "deck_added", deck_id: existing.id },
        };
      }

      const installedAt = now().toISOString();
      const personalId = uniqueDeckId(nextState, personalDeckIdBase(catalogDeck));
      const deck = personalDeckFromCatalog(
        catalogDeck,
        personalId,
        installedAt,
        newDeckInstanceId(personalId, installedAt, args.client_action_id, nextState.revision),
      );
      nextState.personalDecks[personalId] = deck;
      nextState.view.selectedDeckId = personalId;
      recordActivity(nextState, {
        type: "deck_added",
        deckId: personalId,
        at: installedAt,
      });
      return {
        deck: personalDeckSummary(deck, now()),
        already_installed: false,
        visible_effect: { type: "deck_added", deck_id: personalId },
      };
    });
  }

  function listMyDecks(rawArgs = {}) {
    refreshStateFromStorage();
    const args = objectArgs(rawArgs);
    const status = enumValue(args.status ?? "active", "status", ["active", "archived", "all"]);
    const sort = enumValue(args.sort ?? "due", "sort", ["due", "recent", "title", "progress"]);
    const limit = boundedInteger(args.limit ?? 20, "limit", 1, 50);
    const offset = decodeCursor(args.cursor);
    const nowDate = now();
    let decks = Object.values(state.personalDecks).filter((deck) => {
      if (status === "all") return true;
      return status === "archived" ? deck.archived : !deck.archived;
    });
    decks.sort((a, b) => compareDecks(a, b, sort, nowDate));
    const page = decks.slice(offset, offset + limit);
    return jsonClone({
      ok: true,
      decks: page.map((deck) => personalDeckSummary(deck, nowDate)),
      total: decks.length,
      next_cursor: offset + limit < decks.length ? encodeCursor(offset + limit) : null,
      global_streak: projectStreak(state.streak, now(), { timeZone }),
    });
  }

  function setDeckArchived(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    const deckId = requireId(args.deck_id, "deck_id");
    const archived = requiredBoolean(args.archived, "archived");
    const expectedRevision = boundedInteger(args.expected_revision, "expected_revision", 1, Number.MAX_SAFE_INTEGER);

    return withWrite("set_deck_archived", args, (nextState) => {
      const deck = requirePersonalDeck(nextState, deckId, { allowArchived: true });
      checkRevision(deck.revision, expectedRevision, "deck");
      const openSession = archived
        ? Object.values(nextState.sessions).find(
            (session) => session.deckId === deckId && session.status === "active",
          )
        : null;
      if (openSession) {
        fail("DECK_IN_ACTIVE_SESSION", "Finish or abandon the active session before archiving this deck", {
          active_session_id: openSession.id,
          active_session_revision: openSession.revision,
        });
      }
      deck.archived = archived;
      deck.revision += 1;
      deck.updatedAt = now().toISOString();
      if (archived && nextState.view.selectedDeckId === deckId) {
        nextState.view.selectedDeckId = null;
      }
      recordActivity(nextState, {
        type: archived ? "deck_archived" : "deck_restored",
        deckId,
        at: now().toISOString(),
      });
      return {
        deck: personalDeckSummary(deck, now()),
        visible_effect: { type: archived ? "deck_archived" : "deck_restored", deck_id: deckId },
      };
    });
  }

  function getDeckDeletionImpact(rawArgs = {}) {
    refreshStateFromStorage();
    const args = objectArgs(rawArgs);
    const deckId = requireId(args.deck_id, "deck_id");
    const deck = requirePersonalDeck(state, deckId, { allowArchived: true });
    const ownedSessions = Object.values(state.sessions).filter((session) => session.deckId === deckId);
    const activeSession = ownedSessions.find((session) => session.status === "active") ?? null;
    const reviewCount = deck.cardOrder.reduce((total, cardId) =>
      total + (Array.isArray(deck.cards[cardId]?.reviewHistory)
        ? deck.cards[cardId].reviewHistory.length
        : 0), 0);
    const impact = {
      deck_id: deck.id,
      deck_instance_id: deck.deckInstanceId,
      deck_revision: deck.revision,
      app_revision: state.revision,
      title: deck.title,
      card_count: deck.cardOrder.filter((cardId) => Boolean(deck.cards[cardId])).length,
      review_count: reviewCount,
      session_count: ownedSessions.length,
      source_kind: deck.source?.kind ?? "unknown",
      library_deck_id: deck.source?.catalogDeckId ?? null,
      archived: deck.archived,
      active_session_id: activeSession?.id ?? null,
    };
    return jsonClone({
      ok: true,
      can_delete: deck.archived && activeSession === null,
      blocker: !deck.archived ? "DECK_NOT_ARCHIVED"
        : activeSession ? "DECK_IN_ACTIVE_SESSION" : null,
      impact_digest: `fnv1a-${stableHash(impact)}`,
      ...impact,
    });
  }

  function deleteDeck(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    if (args.confirm_permanent_deletion !== true) {
      fail("DELETION_CONFIRMATION_REQUIRED", "Confirm permanent deletion after reviewing its exact impact");
    }
    const deckId = requireId(args.deck_id, "deck_id");
    const deckInstanceId = requireId(args.deck_instance_id, "deck_instance_id");
    const expectedRevision = boundedInteger(
      args.expected_revision,
      "expected_revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const expectedAppRevision = boundedInteger(
      args.expected_app_revision,
      "expected_app_revision",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const expectedImpactDigest = requiredString(
      args.expected_impact_digest,
      "expected_impact_digest",
      128,
    );

    const result = withTargetWrite("delete_deck", args, (nextState) => {
      if (state.revision !== expectedAppRevision) {
        fail("STALE_APP_REVISION", "Learner data changed after deletion was reviewed", {
          expected: expectedAppRevision,
          actual: state.revision,
        });
      }
      const deck = requirePersonalDeck(nextState, deckId, { allowArchived: true });
      if (deck.deckInstanceId !== deckInstanceId) {
        fail("DECK_INSTANCE_CHANGED", "This deck was replaced after deletion was reviewed");
      }
      if (!deck.archived) {
        fail("DECK_NOT_ARCHIVED", "Archive this deck before deleting it permanently");
      }
      checkRevision(deck.revision, expectedRevision, "deck");
      const impact = getDeckDeletionImpact({ deck_id: deckId });
      if (impact.impact_digest !== expectedImpactDigest) {
        fail("DELETION_IMPACT_CHANGED", "The deck deletion impact changed; review it again");
      }
      const ownedSessions = Object.values(nextState.sessions)
        .filter((session) => session.deckId === deckId);
      const activeSession = ownedSessions.find((session) => session.status === "active");
      if (activeSession) {
        fail("DECK_IN_ACTIVE_SESSION", "Pause or finish the active session before deleting this deck", {
          active_session_id: activeSession.id,
          active_session_revision: activeSession.revision,
        });
      }

      const sessionIds = new Set(ownedSessions.map((session) => session.id));
      for (const sessionId of sessionIds) delete nextState.sessions[sessionId];
      if (sessionIds.has(nextState.activeSessionId)) nextState.activeSessionId = null;
      nextState.activity = nextState.activity.filter((event) =>
        event?.deckId !== deckId && !sessionIds.has(event?.sessionId));
      delete nextState.personalDecks[deckId];
      if (nextState.view.selectedDeckId === deckId) nextState.view.selectedDeckId = null;
      for (const [receiptId, receipt] of Object.entries(nextState.actionReceipts)) {
        if (resultBelongsToDeck(receipt?.result, deckId, sessionIds)) {
          delete nextState.actionReceipts[receiptId];
        }
      }
      nextState.actionReceiptOrder = nextState.actionReceiptOrder
        .filter((receiptId) => hasOwn(nextState.actionReceipts, receiptId));
      nextState.streak = streakFromRetainedReviews(nextState, timeZone);
      return {
        deleted_deck_id: deckId,
        deleted_deck_instance_id: deckInstanceId,
        app_revision: state.revision + 1,
        visible_effect: { type: "deck_deleted", deck_id: deckId },
      };
    });
    clearEphemeralPreviews();
    return result;
  }

  function inspectDeckGraph(rawArgs = {}) {
    refreshStateFromStorage();
    const args = objectArgs(rawArgs);
    const deckId = requireId(args.deck_id, "deck_id");
    const deck = requirePersonalDeck(state, deckId, { allowArchived: false });
    const scope = enumValue(args.scope ?? "overview", "scope", [
      "overview",
      "neighborhood",
      "dependency_path",
    ]);
    const depth = boundedInteger(args.depth ?? 2, "depth", 1, 4);
    const limit = boundedInteger(args.limit ?? 200, "limit", 1, 1_000);
    const focusId = args.focus_card_id === undefined ? null : requireId(args.focus_card_id, "focus_card_id");
    const targetId = args.target_card_id === undefined ? null : requireId(args.target_card_id, "target_card_id");
    const graph = graphSelection(deck, { scope, depth, focusId, targetId, limit });
    const nowDate = now();
    return jsonClone({
      ok: true,
      deck_id: deck.id,
      scope,
      nodes: graph.nodeIds.map((id) => graphNode(deck.cards[id], nowDate)),
      edges: graph.edges,
      truncated: graph.truncated,
      far_dependencies: farDependencies(deck, 20),
      graph_revision: deck.revision,
    });
  }

  function focusDeckGraph(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    const inspected = inspectDeckGraph(args);
    const fit = args.fit === undefined ? true : requiredBoolean(args.fit, "fit");
    return jsonClone({
      ...inspected,
      visible_effect: {
        type: "graph_focused",
        deck_id: inspected.deck_id,
        scope: inspected.scope,
        node_ids: inspected.nodes.map((node) => node.id),
        focus_card_id: args.focus_card_id ?? null,
        target_card_id: args.target_card_id ?? null,
        fit,
      },
    });
  }

  function startStudySession(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    if (Object.hasOwn(args, "idempotency_key")) {
      return startTargetStudySession(args);
    }
    const deckId = requireId(args.deck_id, "deck_id");
    const mode = enumValue(args.mode ?? "mixed", "mode", ["due", "new", "mixed", "repair"]);
    const limit = boundedInteger(args.limit ?? 20, "limit", 1, 50);
    const focusCardIds = optionalIdArray(args.focus_card_ids, "focus_card_ids", 50);
    if (mode === "repair" && focusCardIds.length === 0) {
      fail("INVALID_ARGUMENT", "repair mode requires focus_card_ids");
    }

    return withWrite("start_study_session", args, (nextState) => {
      if (nextState.activeSessionId) {
        const active = nextState.sessions[nextState.activeSessionId];
        if (active?.status === "active") {
          fail("ACTIVE_SESSION_EXISTS", "Finish or abandon the active session before starting another", {
            active_session_id: active.id,
            active_session_revision: active.revision,
            phase: active.phase,
          });
        }
      }
      const deck = requirePersonalDeck(nextState, deckId, { allowArchived: false });
      const queueBuiltAt = now();
      const queue = buildStudyQueue(deck, mode, limit, focusCardIds, queueBuiltAt, nextState, catalogDecks);
      const dueSegmentCount = dueSegmentCountForQueue(deck, queue, queueBuiltAt);
      const startedAt = queueBuiltAt.toISOString();
      const sessionId = uniqueSessionId(nextState, args.client_action_id, deckId, startedAt);
      const session = {
        id: sessionId,
        deckId,
        mode,
        queue,
        dueSegmentCount,
        cursor: 0,
        currentCardId: queue[0] ?? null,
        phase: queue.length ? "awaiting_answer" : "applied",
        status: queue.length ? "active" : "completed",
        revision: 1,
        startedAt,
        updatedAt: startedAt,
        finishedAt: queue.length ? null : startedAt,
        capture: null,
        reviewsApplied: 0,
        history: [],
      };
      nextState.sessions[sessionId] = session;
      if (session.status === "active") nextState.activeSessionId = sessionId;
      nextState.view.route = "study";
      nextState.view.selectedDeckId = deckId;
      recordActivity(nextState, { type: "study_started", deckId, sessionId, at: startedAt });
      return {
        session: publicSession(session, deck, reviewPreviewByCapture),
        current_card: safeCurrentCard(session, deck),
        visible_effect: session.status === "completed"
          ? {
              type: "study_queue_empty",
              session_id: sessionId,
              deck_id: deckId,
              animation: "none",
            }
          : {
              type: "study_started",
              session_id: sessionId,
              deck_id: deckId,
              animation: "show_card_stack",
            },
      };
    });
  }

  function inspectStudySession(rawArgs = {}) {
    refreshStateFromStorage();
    const args = objectArgs(rawArgs);
    const sessionId = requireId(args.session_id, "session_id");
    const session = requireSession(state, sessionId);
    const deck = requirePersonalDeck(state, session.deckId, { allowArchived: true });
    const result = {
      ok: true,
      session: publicSession(session, deck, reviewPreviewByCapture),
      current_card: safeCurrentCard(session, deck),
    };
    if (
      session.capture &&
      session.phase === "answer_committed" &&
      !protectedPersonalCard(state, session.deckId, session.currentCardId)
    ) {
      const card = deck.cards[session.currentCardId];
      result.revealed_answer = reviewPacket(card);
      result.capture_id = session.capture.id;
    }
    return jsonClone(result);
  }

  function captureAnswer(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    const sessionId = requireId(args.session_id, "session_id");
    const cardId = requireId(args.card_id, "card_id");
    const answer = requiredString(args.answer, "answer", 4_000);
    const expectedRevision = boundedInteger(
      args.expected_session_revision,
      "expected_session_revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );

    return withWrite("capture_answer", args, (nextState) => {
      const session = requireActiveSession(nextState, sessionId);
      checkRevision(session.revision, expectedRevision, "session");
      if (session.phase !== "awaiting_answer") {
        fail("INVALID_SESSION_PHASE", "An answer can only be captured while awaiting_answer", {
          phase: session.phase,
        });
      }
      if (session.currentCardId !== cardId) {
        fail("CARD_MISMATCH", "card_id is not the session's current card");
      }
      const deck = requirePersonalDeck(nextState, session.deckId, { allowArchived: false });
      const card = requireCard(deck, cardId);
      const capturedAt = now().toISOString();
      const captureId = `capture-${stableHash({ sessionId, cardId, answer, capturedAt, action: args.client_action_id })}`;
      session.phase = "answer_committed";
      session.capture = { id: captureId, cardId, answer, capturedAt };
      session.revision += 1;
      session.updatedAt = capturedAt;
      session.history.push({ cardId, transition: "answer_committed", at: capturedAt });
      return {
        session_id: sessionId,
        session_revision: session.revision,
        card_id: cardId,
        capture_id: captureId,
        phase: "answer_committed",
        review_packet: reviewPacket(card),
        visible_effect: {
          type: "answer_revealed",
          session_id: sessionId,
          card_id: cardId,
          animation: "flip_card",
        },
      };
    });
  }

  function previewReview(rawArgs = {}) {
    refreshStateFromStorage();
    pruneEphemeralPreviews();
    const args = objectArgs(rawArgs);
    const sessionId = requireId(args.session_id, "session_id");
    const cardId = requireId(args.card_id, "card_id");
    const captureId = requireId(args.capture_id, "capture_id");
    const assessment = normalizeAssessment(args.assessment);
    const session = requireActiveSession(state, sessionId);
    if (session.phase !== "answer_committed") {
      fail("INVALID_SESSION_PHASE", "A review can only be previewed after answer commitment", {
        phase: session.phase,
      });
    }
    if (session.currentCardId !== cardId || session.capture?.id !== captureId) {
      fail("CAPTURE_MISMATCH", "The capture does not match the current card");
    }
    const deck = requirePersonalDeck(state, session.deckId, { allowArchived: false });
    const card = requireCard(deck, cardId);
    const rating = ratingForAssessment(assessment);
    const scheduledAt = now();
    const beforeSchedule = jsonClone(card.review);
    const afterSchedule = scheduleReview(reviewWithRecallEvidence(card), rating, scheduledAt);
    const token = `review-${stableHash({
      sessionId,
      cardId,
      captureId,
      assessment,
      appRevision: state.revision,
      sessionRevision: session.revision,
      beforeSchedule,
      afterSchedule,
    })}`;
    const preview = {
      token,
      sessionId,
      cardId,
      captureId,
      assessment,
      rating,
      beforeSchedule,
      afterSchedule,
      baseAppRevision: state.revision,
      sessionRevision: session.revision,
      createdAt: scheduledAt.toISOString(),
      scheduledAt: scheduledAt.toISOString(),
    };
    reviewPreviews.set(token, preview);
    reviewPreviewByCapture.set(captureId, token);
    return jsonClone({
      ok: true,
      phase: "review_previewed",
      review_token: token,
      session_id: sessionId,
      session_revision: session.revision,
      card_id: cardId,
      rating,
      assessment,
      schedule: { before: beforeSchedule, after: afterSchedule },
      derived_effect: {
        learnedness_before: deriveLearnedness(beforeSchedule),
        learnedness_after: deriveLearnedness(afterSchedule),
        freshness_before: deriveFreshness(beforeSchedule, scheduledAt),
        freshness_after: deriveFreshness(afterSchedule, scheduledAt),
      },
      visible_effect: {
        type: "review_previewed",
        session_id: sessionId,
        card_id: cardId,
        rating,
      },
      mutation_committed: false,
    });
  }

  function applyReview(rawArgs = {}) {
    pruneEphemeralPreviews();
    const args = objectArgs(rawArgs);
    const token = requiredString(args.review_token, "review_token", 256);
    const expectedRevision = boundedInteger(
      args.expected_session_revision,
      "expected_session_revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );

    const result = withWrite("apply_review", args, (nextState) => {
      const preview = reviewPreviews.get(token);
      if (!preview) fail("INVALID_PREVIEW_TOKEN", "Review preview token is unknown or expired");
      if (preview.baseAppRevision !== state.revision) {
        fail("STALE_PREVIEW", "Learner state changed after this review was previewed", {
          preview_revision: preview.baseAppRevision,
          app_revision: state.revision,
        });
      }
      const session = requireActiveSession(nextState, preview.sessionId);
      checkRevision(session.revision, expectedRevision, "session");
      if (session.revision !== preview.sessionRevision) {
        fail("STALE_PREVIEW", "Session changed after this review was previewed");
      }
      if (
        session.phase !== "answer_committed" ||
        session.currentCardId !== preview.cardId ||
        session.capture?.id !== preview.captureId
      ) {
        fail("INVALID_SESSION_PHASE", "The captured answer is no longer ready for review");
      }

      const deck = requirePersonalDeck(nextState, session.deckId, { allowArchived: false });
      const card = requireCard(deck, preview.cardId);
      card.review = jsonClone(preview.afterSchedule);
      card.updatedAt = preview.scheduledAt;
      deck.revision += 1;
      deck.updatedAt = preview.scheduledAt;

      session.history.push({
        cardId: preview.cardId,
        transition: "review_previewed",
        at: preview.scheduledAt,
        rating: preview.rating,
      });
      session.history.push({
        cardId: preview.cardId,
        transition: "applied",
        at: preview.scheduledAt,
        rating: preview.rating,
        assessment: preview.assessment,
      });
      session.reviewsApplied += 1;
      session.cursor += 1;
      session.currentCardId = session.queue[session.cursor] ?? null;
      session.capture = null;
      session.updatedAt = preview.scheduledAt;
      session.revision += 1;
      for (const receipt of Object.values(nextState.actionReceipts)) {
        if (
          receipt?.result?.receipt?.operation === "capture_answer" &&
          receipt.result.capture_id === preview.captureId
        ) {
          receipt.result = {
            ok: true,
            capture_id: preview.captureId,
            expired: true,
          };
        }
      }
      if (session.currentCardId) {
        session.phase = "awaiting_answer";
      } else {
        session.phase = "applied";
        session.status = "completed";
        session.finishedAt = preview.scheduledAt;
        if (nextState.activeSessionId === session.id) nextState.activeSessionId = null;
      }
      updateStreak(nextState, new Date(preview.scheduledAt), timeZone);
      recordActivity(nextState, {
        type: "review_applied",
        deckId: deck.id,
        sessionId: session.id,
        cardId: preview.cardId,
        rating: preview.rating,
        at: preview.scheduledAt,
      });
      return {
        phase: "applied",
        session: publicSession(session, deck, reviewPreviewByCapture),
        applied_card_id: preview.cardId,
        rating: preview.rating,
        schedule: jsonClone(preview.afterSchedule),
        current_card: safeCurrentCard(session, deck),
        deck_progress: deckMetrics(deck, now()),
        streak: projectStreak(nextState.streak, new Date(preview.scheduledAt), { timeZone }),
        visible_effect: {
          type: "review_applied",
          session_id: session.id,
          card_id: preview.cardId,
          animation: "slide_card",
          next_card_id: session.currentCardId,
          graph_pulse: true,
        },
      };
    });
    reviewPreviews.delete(token);
    for (const [captureId, mappedToken] of reviewPreviewByCapture) {
      if (mappedToken === token) reviewPreviewByCapture.delete(captureId);
    }
    return result;
  }

  function finishStudySession(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    if (Object.hasOwn(args, "idempotency_key")) {
      return finishTargetStudySession(args);
    }
    const sessionId = requireId(args.session_id, "session_id");
    const disposition = enumValue(args.disposition, "disposition", ["complete", "abandon"]);
    const expectedRevision = boundedInteger(
      args.expected_session_revision,
      "expected_session_revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    return withWrite("finish_study_session", args, (nextState) => {
      const session = requireSession(nextState, sessionId);
      checkRevision(session.revision, expectedRevision, "session");
      if (session.status === "completed" && disposition === "complete") {
        return {
          session: publicSession(
            session,
            requirePersonalDeck(nextState, session.deckId, { allowArchived: true }),
            reviewPreviewByCapture,
          ),
          visible_effect: { type: "study_finished", session_id: sessionId },
        };
      }
      if (!new Set(["active", "paused"]).has(session.status)) {
        fail("INVALID_SESSION_STATE", "Session cannot be finished from its current state");
      }
      if (session.capture || session.phase === "answer_committed") {
        fail("REVIEW_NOT_APPLIED", "Apply the committed answer review before leaving this session", {
          phase: session.phase,
          card_id: session.currentCardId,
        });
      }
      if (
        disposition === "complete" &&
        (session.currentCardId || session.cursor < session.queue.length || session.phase !== "applied")
      ) {
        fail("SESSION_NOT_COMPLETE", "A session with remaining cards can only be abandoned", {
          remaining: Math.max(0, session.queue.length - session.cursor),
          phase: session.phase,
        });
      }
      const finishedAt = now().toISOString();
      session.status = disposition === "abandon" ? "abandoned" : "completed";
      session.finishedAt = finishedAt;
      session.updatedAt = finishedAt;
      session.revision += 1;
      if (nextState.activeSessionId === sessionId) nextState.activeSessionId = null;
      recordActivity(nextState, {
        type: disposition === "abandon" ? "study_abandoned" : "study_finished",
        deckId: session.deckId,
        sessionId,
        at: finishedAt,
      });
      const deck = requirePersonalDeck(nextState, session.deckId, { allowArchived: true });
      return {
        session: publicSession(session, deck, reviewPreviewByCapture),
        summary: {
          reviewed: session.reviewsApplied,
          remaining: Math.max(0, session.queue.length - session.cursor),
          disposition,
        },
        visible_effect: {
          type: disposition === "abandon" ? "study_abandoned" : "study_finished",
          session_id: sessionId,
        },
      };
    });
  }

  function previewDeckChanges(rawArgs = {}) {
    refreshStateFromStorage();
    pruneEphemeralPreviews();
    const args = objectArgs(rawArgs);
    const proposal = normalizeDeckProposal(args, state, now());
    const token = `deck-preview-${stableHash({ proposal, appRevision: state.revision })}`;
    const preview = {
      token,
      proposal,
      baseAppRevision: state.revision,
      baseDeckRevision: proposal.baseDeckRevision,
      createdAt: now().toISOString(),
    };
    deckPreviews.set(token, preview);
    return jsonClone({
      ok: true,
      preview_token: token,
      mutation_committed: false,
      target: proposal.target,
      diff: proposal.diff,
      validation: {
        valid: true,
        card_count: proposal.deck.cardOrder.filter((id) => !proposal.deck.cards[id].archived).length,
        edge_count: proposal.deck.edges.length,
        acyclic: true,
        warnings: proposal.warnings,
      },
      expected_base_revision: proposal.baseDeckRevision,
    });
  }

  function applyDeckChanges(rawArgs = {}) {
    pruneEphemeralPreviews();
    const args = objectArgs(rawArgs);
    const token = requiredString(args.preview_token, "preview_token", 256);
    const expectedBaseRevision = boundedInteger(
      args.expected_base_revision,
      "expected_base_revision",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const result = withWrite("apply_deck_changes", args, (nextState) => {
      const preview = deckPreviews.get(token);
      if (!preview) fail("INVALID_PREVIEW_TOKEN", "Deck preview token is unknown or expired");
      if (preview.baseAppRevision !== state.revision) {
        fail("STALE_PREVIEW", "Application state changed after this deck preview was created", {
          preview_revision: preview.baseAppRevision,
          app_revision: state.revision,
        });
      }
      if (expectedBaseRevision !== preview.baseDeckRevision) {
        fail("STALE_REVISION", "expected_base_revision does not match the preview");
      }
      const deck = jsonClone(preview.proposal.deck);
      if (preview.proposal.target.kind === "existing") {
        const current = requirePersonalDeck(nextState, deck.id, { allowArchived: true });
        checkRevision(current.revision, preview.baseDeckRevision, "deck");
        deck.revision = current.revision + 1;
        deck.updatedAt = now().toISOString();
      } else {
        if (nextState.personalDecks[deck.id]) fail("DECK_EXISTS", "The proposed deck id already exists");
        deck.revision = 1;
        deck.createdAt = now().toISOString();
        deck.updatedAt = deck.createdAt;
      }
      nextState.personalDecks[deck.id] = deck;
      nextState.view.selectedDeckId = deck.id;
      recordActivity(nextState, {
        type: preview.proposal.target.kind === "new" ? "deck_created" : "deck_changed",
        deckId: deck.id,
        at: now().toISOString(),
      });
      return {
        deck: personalDeckSummary(deck, now()),
        diff: preview.proposal.diff,
        visible_effect: {
          type: preview.proposal.target.kind === "new" ? "deck_created" : "deck_changed",
          deck_id: deck.id,
          show_diff: true,
        },
      };
    });
    deckPreviews.delete(token);
    return result;
  }

  function getLearningOverview() {
    refreshStateFromStorage();
    const measuredAt = now();
    const activeDecks = Object.values(state.personalDecks).filter((deck) => !deck.archived);
    const activeSession = state.activeSessionId
      ? state.sessions[state.activeSessionId] ?? null
      : Object.values(state.sessions).find((session) => session.status === "paused") ?? null;
    return jsonClone({
      as_of: measuredAt.toISOString(),
      due_total: activeDecks.reduce(
        (total, deck) => total + deckMetrics(deck, measuredAt).due_count,
        0,
      ),
      new_available_total: activeDecks.reduce(
        (total, deck) => total + availableNewCount(deck, measuredAt, state, catalogDecks),
        0,
      ),
      ...(activeSession
        ? {
            active_session: targetSessionSummary(
              activeSession,
              requirePersonalDeck(state, activeSession.deckId, { allowArchived: true }),
            ),
          }
        : {}),
      decks: activeDecks
        .map((deck) => targetPersonalDeckSummary(deck, measuredAt))
        .sort((left, right) => right.due_count - left.due_count || left.title.localeCompare(right.title))
        .slice(0, 50),
      recent_reviews: state.activity
        .filter((event) => event.type === "grade_submitted" || event.type === "review_applied")
        .slice(-20)
        .reverse()
        .map((event) => ({
          review_id: String(event.reviewId ?? `legacy-${stableHash(event)}`),
          deck_id: String(event.deckId),
          card_id: hasOwn(state.personalDecks, event.deckId)
            ? qualifiedCardId(state.personalDecks[event.deckId], event.cardId)
            : String(event.cardId),
          rating: String(event.rating),
          reviewed_at: String(event.at),
        })),
    });
  }

  // Website-only read model. The closed WebMCP tool surface is unchanged.
  // Counts describe a potential new queue, never refill the current one.
  function getStudyAvailability(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    assertClosedFields(args, ["deck_id", "blocked_limit", "blocked_cursor"], "availability");
    const deckId = args.deck_id === undefined ? null : requireId(args.deck_id, "deck_id");
    const blockedLimit = boundedInteger(args.blocked_limit ?? 0, "blocked_limit", 0, 50);
    if ((blockedLimit || args.blocked_cursor !== undefined) && !deckId) {
      fail("INVALID_ARGUMENT", "Blocked-card details require a deck_id");
    }
    if (args.blocked_cursor !== undefined && !blockedLimit) {
      fail("INVALID_ARGUMENT", "A blocked cursor requires a positive blocked_limit");
    }
    refreshStateFromStorage();
    const measuredAt = now();
    const active = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
    const activeSession = active?.status === "active" ? active : null;
    const selected = deckId
      ? [requirePersonalDeck(state, deckId, { allowArchived: true })]
      : Object.values(state.personalDecks).filter(deck => !deck.archived);
    const summaries = [];
    let blockers = null;
    for (const deck of selected) {
      const ready = [];
      const blocked = [];
      let dueCount = 0;
      let practiceCount = 0;
      let nextDue = null;
      for (const id of deck.cardOrder) {
        const card = deck.cards[id];
        if (!card || card.archived || deck.archived) continue;
        if (Number(card.review?.repetitions ?? 0) > 0) {
          const due = new Date(card.review.dueAt).valueOf();
          if (due <= measuredAt.valueOf()) dueCount += 1;
          else if (Number.isFinite(due)) {
            practiceCount += 1;
            if (nextDue === null || due < nextDue) nextDue = due;
          }
        } else if (card.review?.repetitions === 0) {
          if (isStudyCardEligible(deck, card, state, catalogDecks)) ready.push(id);
          else blocked.push(id);
        }
      }
      const paused = latestPausedStudySession(state, deck.id);
      let resumable = null;
      if (paused) {
        let reason = activeSession ? "ACTIVE_SESSION_EXISTS" : deck.archived ? "DECK_ARCHIVED" : null;
        if (!reason && paused.currentCardId) {
          const currentCard = hasOwn(deck.cards, paused.currentCardId) ? deck.cards[paused.currentCardId] : null;
          if (!currentCard || currentCard.archived) reason = "CARD_NOT_FOUND";
          else if (!isStudyCardEligible(deck, currentCard, state, catalogDecks)) reason = "PREREQUISITE_NOT_SATISFIED";
        }
        resumable = { ...targetSessionSummary(paused, deck), can_resume: reason === null, reason };
      }
      summaries.push({
        deck_id: deck.id, deck_revision: deck.revision, archived: Boolean(deck.archived),
        due_count: dueCount, eligible_new_count: ready.length, practice_count: practiceCount,
        blocked_new_count: blocked.length,
        next_due_at: nextDue === null ? null : new Date(nextDue).toISOString(),
        resumable_session: resumable,
      });
      if (blockedLimit) {
        const offset = availabilityCursorOffset(args.blocked_cursor, state.revision, deck.id);
        if (offset > blocked.length) fail("INVALID_CURSOR", "Blocked-card cursor exceeds this deck's results");
        const page = blocked.slice(offset, offset + blockedLimit);
        blockers = {
          deck_id: deck.id, total_blocked_cards: blocked.length,
          items: page.map(id => ({
            card_id: qualifiedCardId(deck, id), term: deck.cards[id].term,
            unmet_prerequisites: explainStudyCardEligibility(deck, deck.cards[id], state, catalogDecks, true).unmet_prerequisites,
          })),
          next_cursor: offset + page.length < blocked.length
            ? `availability-v2:${STUDY_ELIGIBILITY_POLICY_VERSION}:${state.revision}:${encodeURIComponent(deck.id)}:${offset + page.length}` : null,
        };
      }
    }
    return jsonClone({
      as_of: measuredAt.toISOString(), app_revision: state.revision,
      active_session: activeSession
        ? targetSessionSummary(activeSession, requirePersonalDeck(state, activeSession.deckId, { allowArchived: true })) : null,
      decks: summaries,
      blockers,
    });
  }

  // Website-only read model: the recent activity feed is not a review ledger.
  // No persisted counters, scheduling, receipt, or WebMCP contract is changed.
  function getStudyActivity(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    assertClosedFields(args, ["days"], "activity");
    const days = boundedInteger(args.days === undefined ? 7 : args.days, "days", 1, 366);
    refreshStateFromStorage();
    const measuredAt = now();
    if (!studyActivityCache.has(state)) {
      studyActivityCache.set(state, indexStudyActivity(state));
    }
    return projectStudyActivity(studyActivityCache.get(state), measuredAt, days, timeZone, state.revision);
  }

  function searchLibraryTarget(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    const query = optionalString(args.query, "query", 200)?.toLowerCase() ?? "";
    const subjects = optionalStringArray(args.subjects, "subjects", 50).map((value) => value.toLowerCase());
    const domains = optionalStringArray(args.domains, "domains", 50).map((value) => value.toLowerCase());
    const levels = optionalStringArray(args.levels, "levels", 50).map((value) => value.toLowerCase());
    const difficultyHints = optionalStringArray(args.difficulty_hints, "difficulty_hints", 50).map((value) => value.toLowerCase());
    const evidenceTiers = optionalStringArray(args.evidence_tiers, "evidence_tiers", 50).map((value) => value.toLowerCase());
    const rightsStatuses = optionalStringArray(args.rights_statuses, "rights_statuses", 50).map((value) => value.toLowerCase());
    const limit = boundedInteger(args.limit ?? 20, "limit", 1, 50);
    const offset = decodeCursor(args.cursor);
    const matches = [...catalogDecks.values()]
      .filter((deck) => {
        const summary = targetLibraryDeckSummary(deck);
        if (subjects.length && !subjects.includes(summary.subject.toLowerCase())) return false;
        if (domains.length && !domains.includes(summary.domain.toLowerCase())) return false;
        if (levels.length && !levels.includes(summary.level.toLowerCase())) return false;
        if (evidenceTiers.length && !evidenceTiers.includes(summary.evidence_tier.toLowerCase())) return false;
        if (rightsStatuses.length && !rightsStatuses.includes(summary.rights_status.toLowerCase())) return false;
        if (
          difficultyHints.length &&
          !(deck.librarySummary?.difficulty_hints ?? deck.cards
            .map((card) => card.difficultyHint)
            .filter(Boolean))
            .some((hint) => difficultyHints.includes(hint.toLowerCase()))
        ) return false;
        if (!query) return true;
        return [
          summary.title,
          summary.description,
          summary.subject,
          summary.domain,
          summary.level,
          ...summary.tags,
        ].join(" ").toLowerCase().includes(query);
      })
      .sort((left, right) => left.title.localeCompare(right.title));
    return jsonClone({
      items: matches.slice(offset, offset + limit).map(targetLibraryDeckSummary),
      total_matching: matches.length,
      ...(offset + limit < matches.length ? { next_cursor: encodeCursor(offset + limit) } : {}),
    });
  }

  function searchMyDecks(rawArgs = {}) {
    refreshStateFromStorage();
    const args = objectArgs(rawArgs);
    const query = optionalString(args.query, "query", 200)?.toLowerCase() ?? "";
    const status = enumValue(args.status ?? "active", "status", ["active", "archived", "all"]);
    const sort = enumValue(args.sort ?? "due", "sort", ["due", "recent", "title", "progress"]);
    const limit = boundedInteger(args.limit ?? 20, "limit", 1, 50);
    const offset = decodeCursor(args.cursor);
    const measuredAt = now();
    const matches = Object.values(state.personalDecks)
      .filter((deck) => {
        if (status !== "all" && (status === "archived") !== Boolean(deck.archived)) return false;
        if (!query) return true;
        return [deck.title, deck.description, deck.subject, deck.domain ?? "", ...(deck.tags ?? [])]
          .join(" ")
          .toLowerCase()
          .includes(query);
      })
      .sort((left, right) => compareDecks(left, right, sort, measuredAt));
    return jsonClone({
      items: matches.slice(offset, offset + limit).map((deck) => targetPersonalDeckSummary(deck, measuredAt)),
      total_matching: matches.length,
      ...(offset + limit < matches.length ? { next_cursor: encodeCursor(offset + limit) } : {}),
    });
  }

  function getDeck(rawArgs = {}) {
    refreshStateFromStorage();
    const args = objectArgs(rawArgs);
    const scope = enumValue(args.scope, "scope", ["library", "personal"]);
    const deckId = requireId(args.deck_id, "deck_id");
    const deck = scope === "library"
      ? requireCatalogDeck(catalogDecks, deckId)
      : requirePersonalDeck(state, deckId, { allowArchived: true });
    if (scope === "library" && deck.contentResolved === false) {
      fail("CATALOG_BASE_UNAVAILABLE", `The exact Library deck ${deckId} was not resolved before its complete read`);
    }
    const read = targetCompleteDeck(deck, scope, now(), catalogDecks);
    if (read.deck.cards.length !== read.card_count) {
      fail("INCOMPLETE_DECK_READ", "The complete-deck read omitted one or more cards");
    }
    return jsonClone(read);
  }

  function validateDeck(rawArgs = {}) {
    refreshStateFromStorage();
    const args = objectArgs(rawArgs);
    const source = enumValue(args.source, "source", ["stored", "candidate"]);
    if (source === "stored") {
      enumValue(args.scope, "scope", ["personal"]);
      const deck = requirePersonalDeck(state, requireId(args.deck_id, "deck_id"), { allowArchived: true });
      const checked = jsonClone(deck);
      const blockers = [];
      try {
        mergeStoredPrerequisiteEdges(checked);
        rebuildInternalEdges(checked);
      } catch (error) {
        blockers.push(diagnostic(error.code ?? "INVALID_STORED_DECK", "deck", error.message));
      }
      const warnings = blockers.length ? [] : deckWarnings(checked);
      const cardOrder = Array.isArray(deck.cardOrder) ? deck.cardOrder : [];
      return jsonClone({
        status: blockers.length ? "blocked" : warnings.length ? "ready_with_warnings" : "ready",
        ingestible: blockers.length === 0,
        content_digest: targetDeckDigest(deck),
        blockers,
        warnings,
        agent_review_required: semanticReviewObligations({
          sourceRightsReview: deckRequiresSourceRightsReview(deck),
        }),
        scheduling_impact: {
          preserved_card_ids: [...new Set(cardOrder
            .filter((id) => deck.cards?.[id] && !deck.cards[id].archived)
            .map((id) => qualifiedCardId(deck, id)))],
          reset_card_ids: [],
          new_card_ids: [],
          archived_card_ids: [...new Set(cardOrder
            .filter((id) => deck.cards?.[id]?.archived)
            .map((id) => qualifiedCardId(deck, id)))],
        },
      });
    }

    const operation = enumValue(args.operation, "operation", ["create", "replace"]);
    let analysis = analyzeNormalizedDeck(args.deck, now());
    if (operation === "create" && analysis.candidate && hasOwn(state.personalDecks, analysis.candidate.id)) {
      analysis.blockers.push(diagnostic("DECK_EXISTS", "deck.deck_id", "A personal deck already uses this identity."));
    }
    let schedulingImpact = {
      preserved_card_ids: [],
      reset_card_ids: [],
      new_card_ids: analysis.candidate?.cardOrder ?? [],
      archived_card_ids: [],
    };
    let sourceRightsReview = false;
    if (operation === "replace") {
      const targetDeckId = requireId(args.target_deck_id, "target_deck_id");
      const expectedRevision = boundedInteger(args.expected_deck_revision, "expected_deck_revision", 1, Number.MAX_SAFE_INTEGER);
      const target = requirePersonalDeck(state, targetDeckId, { allowArchived: true });
      sourceRightsReview = deckRequiresSourceRightsReview(target);
      checkRevision(target.revision, expectedRevision, "deck");
      if (analysis.candidate && analysis.candidate.id !== targetDeckId) {
        analysis.blockers.push(diagnostic("TARGET_DECK_MISMATCH", "deck.deck_id", "Replacement identity must equal target_deck_id."));
      }
      if (analysis.candidate) {
        const existing = canonicalizedPersonalDeckCardIdentities(target);
        analysis = prepareReplacementAnalysis(existing, analysis, args.deck);
        schedulingImpact = replacementSchedulingImpact(
          existing,
          analysis.candidate,
        );
      }
    }
    return jsonClone(validationResult(analysis, schedulingImpact, { sourceRightsReview }));
  }

  function ingestDeck(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    const operation = enumValue(args.operation, "operation", ["create", "replace"]);
    return withTargetWrite("ingest_deck", args, (nextState, committedAt) => {
      let analysis = analyzeNormalizedDeck(args.deck, new Date(committedAt));
      if (analysis.blockers.length || !analysis.candidate) {
        fail("DECK_VALIDATION_BLOCKED", "The normalized deck has structural blockers", {
          issues: analysis.blockers,
        });
      }
      let previousRevision = null;
      let schedulingImpact;
      let diff;
      let deck;
      if (operation === "create") {
        if (hasOwn(nextState.personalDecks, analysis.candidate.id)) {
          fail("DECK_EXISTS", `Personal deck ${analysis.candidate.id} already exists`);
        }
        deck = jsonClone(analysis.candidate);
        deck.revision = 1;
        deck.createdAt = committedAt;
        deck.updatedAt = committedAt;
        schedulingImpact = {
          preserved_card_ids: [],
          reset_card_ids: [],
          new_card_ids: [...deck.cardOrder],
          archived_card_ids: [],
        };
        diff = {
          added_card_ids: [...deck.cardOrder],
          updated_card_ids: [],
          unchanged_card_ids: [],
          archived_card_ids: [],
        };
      } else {
        const targetDeckId = requireId(args.target_deck_id, "target_deck_id");
        const expectedRevision = boundedInteger(args.expected_deck_revision, "expected_deck_revision", 1, Number.MAX_SAFE_INTEGER);
        const existing = requirePersonalDeck(nextState, targetDeckId, { allowArchived: true });
        checkRevision(existing.revision, expectedRevision, "deck");
        if (analysis.candidate.id !== targetDeckId) {
          fail("TARGET_DECK_MISMATCH", "Replacement deck identity does not match target_deck_id");
        }
        assertNoOpenSession(nextState, targetDeckId);
        previousRevision = existing.revision;
        const canonicalExisting = canonicalizedPersonalDeckCardIdentities(existing);
        analysis = prepareReplacementAnalysis(canonicalExisting, analysis, args.deck);
        const merged = mergeReplacementDeck(
          canonicalExisting,
          analysis.candidate,
          committedAt,
        );
        deck = merged.deck;
        schedulingImpact = merged.schedulingImpact;
        diff = merged.diff;
        deck.revision = existing.revision + 1;
        deck.createdAt = existing.createdAt;
        deck.updatedAt = committedAt;
      }
      nextState.personalDecks[deck.id] = deck;
      recordActivity(nextState, {
        type: operation === "create" ? "deck_ingested" : "deck_replaced",
        deckId: deck.id,
        at: committedAt,
      });
      return {
        deck_id: deck.id,
        previous_deck_revision: previousRevision,
        deck_revision: deck.revision,
        validation_status: analysis.warnings.length ? "ready_with_warnings" : "ready",
        content_digest: analysis.contentDigest,
        added_card_ids: diff.added_card_ids,
        updated_card_ids: diff.updated_card_ids,
        unchanged_card_ids: diff.unchanged_card_ids,
        archived_card_ids: diff.archived_card_ids,
        scheduling_impact: schedulingImpact,
      };
    });
  }

  function updateDeck(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    const deckId = requireId(args.deck_id, "deck_id");
    const expectedRevision = boundedInteger(args.expected_deck_revision, "expected_deck_revision", 1, Number.MAX_SAFE_INTEGER);
    const patch = objectArgs(args.patch);
    const allowed = ["title", "description", "subject", "domain", "level", "tags", "modules", "provenance"];
    const changedKeys = Object.keys(patch);
    if (!changedKeys.length) fail("INVALID_ARGUMENT", "patch must change at least one deck field");
    if (changedKeys.some((key) => !allowed.includes(key))) fail("INVALID_ARGUMENT", "patch contains an unsupported deck field");
    return withTargetWrite("update_deck", args, (nextState, committedAt) => {
      const deck = requirePersonalDeck(nextState, deckId, { allowArchived: true });
      checkRevision(deck.revision, expectedRevision, "deck");
      assertNoOpenSession(nextState, deckId);
      const previousRevision = deck.revision;
      const changedFields = [];
      for (const key of changedKeys) {
        const nextValue = jsonClone(patch[key]);
        if (stableStringify(deck[key]) !== stableStringify(nextValue)) {
          deck[key] = nextValue;
          changedFields.push(key);
        }
      }
      deck.revision += 1;
      deck.updatedAt = committedAt;
      return {
        deck_id: deckId,
        previous_deck_revision: previousRevision,
        deck_revision: deck.revision,
        changed_fields: changedFields,
        warnings: deckWarnings(deck),
      };
    });
  }

  function addCards(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    const deckId = requireId(args.deck_id, "deck_id");
    const expectedRevision = boundedInteger(args.expected_deck_revision, "expected_deck_revision", 1, Number.MAX_SAFE_INTEGER);
    if (!Array.isArray(args.cards) || args.cards.length < 1 || args.cards.length > 100) {
      fail("INVALID_ARGUMENT", "cards must contain 1 to 100 entries");
    }
    return withTargetWrite("add_cards", args, (nextState, committedAt) => {
      let deck = requirePersonalDeck(nextState, deckId, { allowArchived: true });
      checkRevision(deck.revision, expectedRevision, "deck");
      assertNoOpenSession(nextState, deckId);
      deck = canonicalizedPersonalDeckCardIdentities(deck);
      nextState.personalDecks[deckId] = deck;
      const normalized = args.cards.map((card, index) => candidateCardToPersonal(deckId, card, committedAt, `cards[${index}]`));
      ensureUniqueCards(normalized, "added cards");
      for (const card of normalized) {
        const sourceAlias = deck.libraryBase && card.id.startsWith(`${deckId}.`)
          ? card.id.slice(deckId.length + 1) : null;
        if (hasOwn(deck.cards, card.id) || (sourceAlias && hasOwn(deck.cards, sourceAlias))) {
          fail("CARD_EXISTS", `Card ${card.id} already exists`);
        }
      }
      const previousRevision = deck.revision;
      for (const card of normalized) {
        deck.cards[card.id] = card;
        deck.cardOrder.push(card.id);
      }
      rebuildInternalEdges(deck);
      deck.revision += 1;
      deck.updatedAt = committedAt;
      return {
        deck_id: deckId,
        previous_deck_revision: previousRevision,
        deck_revision: deck.revision,
        added_card_ids: normalized.map((card) => card.id),
        scheduling_impact: {
          initialized_card_ids: normalized.map((card) => card.id),
          due_dates_owned_by_site: true,
        },
        warnings: deckWarnings(deck),
      };
    });
  }

  function updateCards(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    const deckId = requireId(args.deck_id, "deck_id");
    const expectedRevision = boundedInteger(args.expected_deck_revision, "expected_deck_revision", 1, Number.MAX_SAFE_INTEGER);
    if (!Array.isArray(args.updates) || args.updates.length < 1 || args.updates.length > 100) {
      fail("INVALID_ARGUMENT", "updates must contain 1 to 100 entries");
    }
    const submittedIds = args.updates.map((update, index) => requireId(update?.card_id, `updates[${index}].card_id`));
    return withTargetWrite("update_cards", args, (nextState, committedAt) => {
      const deck = requirePersonalDeck(nextState, deckId, { allowArchived: true });
      checkRevision(deck.revision, expectedRevision, "deck");
      assertNoOpenSession(nextState, deckId);
      // Catalog decks can store relationships only in edges. Seed those fields
      // before applying patches so an unrelated edit cannot erase the graph.
      mergeStoredPrerequisiteEdges(deck);
      const ids = submittedIds.map((cardId) => resolveSubmittedCardId(deck, cardId));
      if (new Set(ids).size !== ids.length) {
        fail("DUPLICATE_CARD_ID", "updates contains duplicate card IDs");
      }
      const previousRevision = deck.revision;
      const results = [];
      for (const [index, update] of args.updates.entries()) {
        const card = requireCard(deck, ids[index], { allowArchived: true });
        const previousGradingTarget = materialCardFingerprint(card);
        const patch = { ...objectArgs(update.patch) };
        if (hasOwn(patch, "prerequisite_ids")) {
          patch.prerequisite_ids = optionalIdArray(patch.prerequisite_ids, `updates[${index}].patch.prerequisite_ids`, 50)
            .map((id) => resolvePrerequisiteId(deck, id));
        }
        const changedFields = applyCandidateCardPatch(card, patch, committedAt, `updates[${index}].patch`);
        const reset = previousGradingTarget !== materialCardFingerprint(card);
        if (reset) card.review = newReviewState(committedAt);
        if (changedFields.length) card.contentRevision = Number(card.contentRevision ?? 1) + 1;
        card.updatedAt = committedAt;
        results.push({
          card_id: card.id,
          card_revision: Number(card.contentRevision ?? 1),
          changed_fields: changedFields,
          scheduling_result: reset ? "reset" : "preserved",
          scheduling_reason: reset
            ? "The grading target changed."
            : "The grading target is unchanged.",
        });
      }
      rebuildInternalEdges(deck);
      deck.revision += 1;
      deck.updatedAt = committedAt;
      return {
        deck_id: deckId,
        previous_deck_revision: previousRevision,
        deck_revision: deck.revision,
        updates: results,
      };
    });
  }

  function startTargetStudySession(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    const deckId = requireId(args.deck_id, "deck_id");
    const limit = boundedInteger(args.limit ?? 20, "limit", 1, 50);
    return withTargetWrite("start_study_session", args, (nextState, committedAt) => {
      if (nextState.activeSessionId) {
        const active = nextState.sessions[nextState.activeSessionId];
        if (active?.status === "active") {
          fail("ACTIVE_SESSION_EXISTS", "Finish or pause the active session before starting another", {
            active_session_id: active.id,
            active_session_revision: active.revision,
          });
        }
      }
      const deck = requirePersonalDeck(nextState, deckId, { allowArchived: false });
      const pausedSession = latestPausedStudySession(nextState, deckId);
      if (pausedSession) {
        if (pausedSession.currentCardId) assertStudyCardEligible(
          deck, requireCard(deck, pausedSession.currentCardId), nextState, catalogDecks,
        );
        pausedSession.status = "active";
        pausedSession.updatedAt = committedAt;
        pausedSession.finishedAt = null;
        pausedSession.revision += 1;
        nextState.activeSessionId = pausedSession.id;
        recordActivity(nextState, {
          type: "study_resumed",
          deckId,
          sessionId: pausedSession.id,
          at: committedAt,
        });
        return {
          session: targetSessionSummary(pausedSession, deck),
          ...(pausedSession.currentCardId
            ? {
                current_card: agentFacingCard(
                  deck,
                  requireCard(deck, pausedSession.currentCardId),
                  new Date(committedAt),
                ),
              }
            : {}),
        };
      }
      const queueBuiltAt = new Date(committedAt);
      const queue = buildStudyQueue(deck, "continuous", limit, [], queueBuiltAt, nextState, catalogDecks);
      const dueSegmentCount = dueSegmentCountForQueue(deck, queue, queueBuiltAt);
      const sessionId = uniqueSessionId(nextState, args.idempotency_key, deckId, committedAt);
      const session = {
        id: sessionId,
        deckId,
        mode: "continuous",
        queue,
        dueSegmentCount,
        cursor: 0,
        currentCardId: queue[0] ?? null,
        phase: queue.length ? "awaiting_answer" : "complete",
        status: queue.length ? "active" : "completed",
        revision: 1,
        startedAt: committedAt,
        updatedAt: committedAt,
        finishedAt: queue.length ? null : committedAt,
        capture: null,
        reviewsApplied: 0,
        history: [],
      };
      nextState.sessions[sessionId] = session;
      if (session.status === "active") nextState.activeSessionId = sessionId;
      recordActivity(nextState, { type: "study_started", deckId, sessionId, at: committedAt });
      return {
        session: targetSessionSummary(session, deck),
        ...(session.currentCardId
          ? { current_card: agentFacingCard(deck, requireCard(deck, session.currentCardId), new Date(committedAt)) }
          : {}),
      };
    });
  }

  function getStudySession(rawArgs = {}) {
    refreshStateFromStorage();
    const args = objectArgs(rawArgs);
    const session = requireSession(state, requireId(args.session_id, "session_id"));
    const deck = requirePersonalDeck(state, session.deckId, { allowArchived: true });
    const currentCard = session.currentCardId
      ? requireCard(deck, resolveSubmittedCardId(deck, session.currentCardId), {
          allowArchived: !["active", "paused"].includes(session.status),
        })
      : null;
    if (currentCard && ["active", "paused"].includes(session.status)) {
      assertStudyCardEligible(deck, currentCard, state, catalogDecks);
    }
    return jsonClone({
      session: targetSessionSummary(session, deck),
      ...(currentCard
        ? { current_card: agentFacingCard(deck, currentCard, now()) }
        : {}),
    });
  }

  function submitGrade(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    const sessionId = requireId(args.session_id, "session_id");
    const submittedCardId = requireId(args.card_id, "card_id");
    const expectedCardRevision = boundedInteger(args.expected_card_revision, "expected_card_revision", 1, Number.MAX_SAFE_INTEGER);
    const expectedSessionRevision = boundedInteger(args.expected_session_revision, "expected_session_revision", 1, Number.MAX_SAFE_INTEGER);
    const answerText = boundedNonblankString(args.answer_text, "answer_text", 4_000);
    const answerOrigin = enumValue(args.answer_origin, "answer_origin", ["chat", "website"]);
    const rating = enumValue(args.rating, "rating", ["again", "hard", "good", "easy"]);
    const feedback = boundedNonblankString(args.feedback, "feedback", 2_000);
    const misconceptions = optionalBoundedUniqueStrings(args.misconceptions, "misconceptions", 20, 1_000);
    const confidence = boundedNumber(args.confidence, "confidence", 0, 1);
    const rubricEvidence = normalizeRubricEvidence(args.rubric_evidence);
    return withTargetWrite("submit_grade", args, (nextState, committedAt) => {
      const session = requireActiveSession(nextState, sessionId);
      checkRevision(session.revision, expectedSessionRevision, "session");
      if (session.phase !== "awaiting_answer") {
        fail("INVALID_SESSION_PHASE", "A grade can only be submitted for an unanswered current card");
      }
      const deck = requirePersonalDeck(nextState, session.deckId, { allowArchived: false });
      const internalCardId = resolveSubmittedCardId(deck, submittedCardId);
      if (session.currentCardId !== internalCardId) {
        fail("CARD_MISMATCH", "card_id is not the session's current card");
      }
      const card = requireCard(deck, internalCardId);
      const externalCardId = qualifiedCardId(deck, internalCardId);
      const cardRevision = Number(card.contentRevision ?? 1);
      checkRevision(cardRevision, expectedCardRevision, "card");
      assertRubricEvidenceBelongsToCard(card, rubricEvidence);
      assertStudyCardEligible(deck, card, nextState, catalogDecks);
      const before = jsonClone(card.review);
      const after = scheduleReview(reviewWithRecallEvidence(card), rating, new Date(committedAt));
      const reviewId = `review-${stableHash({ sessionId, internalCardId, committedAt, idempotencyKey: args.idempotency_key })}`;
      const assessment = {
        answer_text: answerText,
        answer_origin: answerOrigin,
        rating,
        rubric_evidence: rubricEvidence,
        feedback,
        misconceptions,
        confidence,
      };
      card.review = after;
      card.reviewHistory = [...(card.reviewHistory ?? []), {
        reviewId,
        cardRevision,
        submittedAt: committedAt,
        ...jsonClone(assessment),
        scheduleBefore: before,
        scheduleAfter: after,
      }];
      card.updatedAt = committedAt;
      deck.revision += 1;
      deck.updatedAt = committedAt;
      session.history.push({
        cardId: internalCardId,
        cardRevision,
        transition: "grade_submitted",
        reviewId,
        at: committedAt,
        ...jsonClone(assessment),
      });
      session.reviewsApplied += 1;
      session.cursor += 1;
      // Another deck may have changed since this queue was built. Defer any
      // newly blocked cards without undoing the valid grade just submitted.
      session.queue = [
        ...session.queue.slice(0, session.cursor),
        ...session.queue.slice(session.cursor).filter(id =>
          isStudyCardEligible(deck, deck.cards[id], nextState, catalogDecks)),
      ];
      session.currentCardId = session.queue[session.cursor] ?? null;
      session.updatedAt = committedAt;
      session.revision += 1;
      if (session.currentCardId) {
        session.phase = "awaiting_answer";
      } else {
        session.phase = "complete";
        session.status = "completed";
        session.finishedAt = committedAt;
        if (nextState.activeSessionId === session.id) nextState.activeSessionId = null;
      }
      updateStreak(nextState, new Date(committedAt), timeZone);
      recordActivity(nextState, {
        type: "grade_submitted",
        reviewId,
        deckId: deck.id,
        sessionId: session.id,
        cardId: externalCardId,
        rating,
        at: committedAt,
      });
      return {
        review_id: reviewId,
        answer_id: `answer-${stableHash({ reviewId, answerText })}`,
        session_id: session.id,
        card_id: externalCardId,
        card_revision: cardRevision,
        rating,
        answer_text: answerText,
        answer_origin: answerOrigin,
        rubric_evidence: rubricEvidence,
        feedback,
        misconceptions,
        confidence,
        schedule: {
          previous: targetScheduleSummary(before, new Date(committedAt)),
          next: targetScheduleSummary(after, new Date(committedAt)),
        },
        reviewed_card: agentFacingCard(deck, card, new Date(committedAt)),
        session: targetSessionSummary(session, deck),
        ...(session.currentCardId
          ? { next_card: agentFacingCard(deck, requireCard(deck, session.currentCardId), new Date(committedAt)) }
          : {}),
      };
    });
  }

  // Private Website operation for an explicitly confirmed Reveal or Skip.
  // Both are non-answer attempts and therefore take one fixed Again transition
  // without manufacturing learner text, rubric evidence, tutor feedback or
  // model confidence.
  function submitNonAnswerGrade(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    assertClosedFields(args, [
      "session_id",
      "expected_session_revision",
      "card_id",
      "expected_card_revision",
      "attempt_kind",
      "idempotency_key",
    ], "non-answer grade");
    const sessionId = requireId(args.session_id, "session_id");
    const submittedCardId = requireId(args.card_id, "card_id");
    const expectedCardRevision = boundedInteger(args.expected_card_revision, "expected_card_revision", 1, Number.MAX_SAFE_INTEGER);
    const expectedSessionRevision = boundedInteger(args.expected_session_revision, "expected_session_revision", 1, Number.MAX_SAFE_INTEGER);
    const attemptKind = enumValue(args.attempt_kind, "attempt_kind", ["reveal", "skip"]);
    const rating = "again";
    const answerRevealed = attemptKind === "reveal";
    return withTargetWrite("submit_non_answer_grade", args, (nextState, committedAt) => {
      const session = requireActiveSession(nextState, sessionId);
      checkRevision(session.revision, expectedSessionRevision, "session");
      if (session.phase !== "awaiting_answer") {
        fail("INVALID_SESSION_PHASE", "A non-answer grade can only be submitted for an unanswered current card");
      }
      const deck = requirePersonalDeck(nextState, session.deckId, { allowArchived: false });
      const internalCardId = resolveSubmittedCardId(deck, submittedCardId);
      if (session.currentCardId !== internalCardId) {
        fail("CARD_MISMATCH", "card_id is not the session's current card");
      }
      const card = requireCard(deck, internalCardId);
      const externalCardId = qualifiedCardId(deck, internalCardId);
      const cardRevision = Number(card.contentRevision ?? 1);
      checkRevision(cardRevision, expectedCardRevision, "card");
      assertStudyCardEligible(deck, card, nextState, catalogDecks);
      const before = jsonClone(card.review);
      const after = scheduleReview(reviewWithRecallEvidence(card), rating, new Date(committedAt));
      const reviewId = `review-${stableHash({ sessionId, internalCardId, committedAt, idempotencyKey: args.idempotency_key })}`;
      const assessment = {
        attempt_kind: attemptKind,
        answer_revealed: answerRevealed,
        rating,
      };
      card.review = after;
      card.reviewHistory = [...(card.reviewHistory ?? []), {
        reviewId,
        cardRevision,
        submittedAt: committedAt,
        ...jsonClone(assessment),
        scheduleBefore: before,
        scheduleAfter: after,
      }];
      card.updatedAt = committedAt;
      deck.revision += 1;
      deck.updatedAt = committedAt;
      session.history.push({
        cardId: internalCardId,
        cardRevision,
        transition: "grade_submitted",
        reviewId,
        at: committedAt,
        ...jsonClone(assessment),
      });
      session.reviewsApplied += 1;
      session.cursor += 1;
      session.queue = [
        ...session.queue.slice(0, session.cursor),
        ...session.queue.slice(session.cursor).filter(id =>
          isStudyCardEligible(deck, deck.cards[id], nextState, catalogDecks)),
      ];
      session.currentCardId = session.queue[session.cursor] ?? null;
      session.updatedAt = committedAt;
      session.revision += 1;
      if (session.currentCardId) {
        session.phase = "awaiting_answer";
      } else {
        session.phase = "complete";
        session.status = "completed";
        session.finishedAt = committedAt;
        if (nextState.activeSessionId === session.id) nextState.activeSessionId = null;
      }
      updateStreak(nextState, new Date(committedAt), timeZone);
      recordActivity(nextState, {
        type: "grade_submitted",
        reviewId,
        deckId: deck.id,
        sessionId: session.id,
        cardId: externalCardId,
        attemptKind,
        answerRevealed,
        rating,
        at: committedAt,
      });
      return {
        review_id: reviewId,
        session_id: session.id,
        card_id: externalCardId,
        card_revision: cardRevision,
        attempt_kind: attemptKind,
        answer_revealed: answerRevealed,
        rating,
        schedule: {
          previous: targetScheduleSummary(before, new Date(committedAt)),
          next: targetScheduleSummary(after, new Date(committedAt)),
        },
        ...(attemptKind === "reveal"
          ? { reviewed_card: agentFacingCard(deck, card, new Date(committedAt)) }
          : {}),
        session: targetSessionSummary(session, deck),
        ...(session.currentCardId
          ? { next_card: agentFacingCard(deck, requireCard(deck, session.currentCardId), new Date(committedAt)) }
          : {}),
      };
    });
  }

  // Private Website operation for a learner who reveals the definition and
  // chooses an FSRS bucket directly. This intentionally does not manufacture
  // an answer, rubric evidence, tutor feedback or model confidence.
  function submitSelfGrade(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    const sessionId = requireId(args.session_id, "session_id");
    const submittedCardId = requireId(args.card_id, "card_id");
    const expectedCardRevision = boundedInteger(args.expected_card_revision, "expected_card_revision", 1, Number.MAX_SAFE_INTEGER);
    const expectedSessionRevision = boundedInteger(args.expected_session_revision, "expected_session_revision", 1, Number.MAX_SAFE_INTEGER);
    const rating = enumValue(args.rating, "rating", ["again", "hard", "good", "easy"]);
    return withTargetWrite("submit_self_grade", args, (nextState, committedAt) => {
      const session = requireActiveSession(nextState, sessionId);
      checkRevision(session.revision, expectedSessionRevision, "session");
      if (session.phase !== "awaiting_answer") {
        fail("INVALID_SESSION_PHASE", "A self-grade can only be submitted for an unanswered current card");
      }
      const deck = requirePersonalDeck(nextState, session.deckId, { allowArchived: false });
      const internalCardId = resolveSubmittedCardId(deck, submittedCardId);
      if (session.currentCardId !== internalCardId) {
        fail("CARD_MISMATCH", "card_id is not the session's current card");
      }
      const card = requireCard(deck, internalCardId);
      const externalCardId = qualifiedCardId(deck, internalCardId);
      const cardRevision = Number(card.contentRevision ?? 1);
      checkRevision(cardRevision, expectedCardRevision, "card");
      assertStudyCardEligible(deck, card, nextState, catalogDecks);
      const before = jsonClone(card.review);
      const after = scheduleReview(reviewWithRecallEvidence(card), rating, new Date(committedAt));
      const reviewId = `review-${stableHash({ sessionId, internalCardId, committedAt, idempotencyKey: args.idempotency_key })}`;
      const assessment = {
        grading_mode: "self",
        answer_revealed: true,
        rating,
      };
      card.review = after;
      card.reviewHistory = [...(card.reviewHistory ?? []), {
        reviewId,
        cardRevision,
        submittedAt: committedAt,
        ...jsonClone(assessment),
        scheduleBefore: before,
        scheduleAfter: after,
      }];
      card.updatedAt = committedAt;
      deck.revision += 1;
      deck.updatedAt = committedAt;
      session.history.push({
        cardId: internalCardId,
        cardRevision,
        transition: "grade_submitted",
        reviewId,
        at: committedAt,
        ...jsonClone(assessment),
      });
      session.reviewsApplied += 1;
      session.cursor += 1;
      session.queue = [
        ...session.queue.slice(0, session.cursor),
        ...session.queue.slice(session.cursor).filter(id =>
          isStudyCardEligible(deck, deck.cards[id], nextState, catalogDecks)),
      ];
      session.currentCardId = session.queue[session.cursor] ?? null;
      session.updatedAt = committedAt;
      session.revision += 1;
      if (session.currentCardId) {
        session.phase = "awaiting_answer";
      } else {
        session.phase = "complete";
        session.status = "completed";
        session.finishedAt = committedAt;
        if (nextState.activeSessionId === session.id) nextState.activeSessionId = null;
      }
      updateStreak(nextState, new Date(committedAt), timeZone);
      recordActivity(nextState, {
        type: "grade_submitted",
        gradingMode: "self",
        reviewId,
        deckId: deck.id,
        sessionId: session.id,
        cardId: externalCardId,
        rating,
        at: committedAt,
      });
      return {
        review_id: reviewId,
        session_id: session.id,
        card_id: externalCardId,
        card_revision: cardRevision,
        grading_mode: "self",
        answer_revealed: true,
        rating,
        schedule: {
          previous: targetScheduleSummary(before, new Date(committedAt)),
          next: targetScheduleSummary(after, new Date(committedAt)),
        },
        reviewed_card: agentFacingCard(deck, card, new Date(committedAt)),
        session: targetSessionSummary(session, deck),
        ...(session.currentCardId
          ? { next_card: agentFacingCard(deck, requireCard(deck, session.currentCardId), new Date(committedAt)) }
          : {}),
      };
    });
  }

  function finishTargetStudySession(rawArgs = {}) {
    const args = objectArgs(rawArgs);
    const sessionId = requireId(args.session_id, "session_id");
    const disposition = enumValue(args.disposition, "disposition", ["pause", "end"]);
    const expectedRevision = boundedInteger(args.expected_session_revision, "expected_session_revision", 1, Number.MAX_SAFE_INTEGER);
    return withTargetWrite("finish_study_session", args, (nextState, committedAt) => {
      const session = requireSession(nextState, sessionId);
      checkRevision(session.revision, expectedRevision, "session");
      if (!new Set(["active", "paused"]).has(session.status)) {
        fail("INVALID_SESSION_STATE", "Only an active or paused session can be paused or ended early");
      }
      session.status = disposition === "pause" ? "paused" : "finished";
      session.updatedAt = committedAt;
      session.revision += 1;
      if (disposition === "end") session.finishedAt = committedAt;
      if (nextState.activeSessionId === sessionId) nextState.activeSessionId = null;
      recordActivity(nextState, {
        type: disposition === "pause" ? "study_paused" : "study_finished",
        deckId: session.deckId,
        sessionId,
        at: committedAt,
      });
      return {
        session_id: sessionId,
        status: disposition === "pause" ? "paused" : "finished",
        summary: targetSessionSummaryData(session),
      };
    });
  }

  function seedDemoState(deckId) {
    const normalizedDeckId = requireId(deckId, "deck_id");
    const args = {
      deck_id: normalizedDeckId,
      client_action_id: `seed-demo-state:${normalizedDeckId}`,
    };
    return withWrite("seed_demo_state", args, (nextState) => {
      const deck = requirePersonalDeck(nextState, normalizedDeckId, { allowArchived: false });
      const hasLearnerHistory =
        Object.keys(nextState.personalDecks).length !== 1 ||
        Object.keys(nextState.sessions).length > 0 ||
        Object.values(nextState.personalDecks).some((candidate) =>
          candidate.cardOrder.some((id) => candidate.cards[id]?.review?.repetitions > 0),
        ) ||
        nextState.activity.some((event) => event.type !== "deck_added");
      if (hasLearnerHistory) {
        fail(
          "DEMO_SEED_NOT_EMPTY",
          "Deterministic demo history can only be seeded before any learner activity exists",
        );
      }
      const seededAt = now();
      const activeCards = deck.cardOrder
        .map((id) => deck.cards[id])
        .filter((card) => card && !card.archived);
      const patterns = [
        // Established and fresh.
        { repetitions: 6, lapses: 0, stabilityDays: 21, difficulty: 3.2, intervalDays: 21, elapsedDays: 1, rating: "easy" },
        // Established, but due now.
        { repetitions: 4, lapses: 1, stabilityDays: 7, difficulty: 5.4, intervalDays: 7, elapsedDays: 8, rating: "good" },
        // Still learning and due soon.
        { repetitions: 2, lapses: 0, stabilityDays: 3, difficulty: 5.8, intervalDays: 3, elapsedDays: 2, rating: "hard" },
        // Fragile recall and overdue.
        { repetitions: 1, lapses: 1, stabilityDays: 1, difficulty: 7.1, intervalDays: 1, elapsedDays: 3, rating: "again" },
      ];
      let seededReviews = 0;
      activeCards.forEach((card, index) => {
        // Keep every fifth card genuinely new so the demo contains both coverage
        // and active-review states. The pattern is deterministic for screenshots
        // and local tests; it is never represented as real learner evidence.
        if (index % 5 === 4) return;
        const pattern = patterns[index % patterns.length];
        const lastReviewed = new Date(seededAt.getTime() - pattern.elapsedDays * DAY_MS);
        const dueAt = new Date(lastReviewed.getTime() + pattern.intervalDays * DAY_MS);
        card.review = {
          algorithm: FSRS6_ALGORITHM_ID,
          exactFsrs: false,
          coreFormulaExact: true,
          demoSeeded: true,
          repetitions: pattern.repetitions,
          lapses: pattern.lapses,
          stabilityDays: pattern.stabilityDays,
          difficulty: pattern.difficulty,
          intervalDays: pattern.intervalDays,
          dueAt: dueAt.toISOString(),
          lastReviewedAt: lastReviewed.toISOString(),
          lastRating: pattern.rating,
        };
        card.updatedAt = seededAt.toISOString();
        seededReviews += 1;
      });
      deck.revision += 1;
      deck.updatedAt = seededAt.toISOString();
      nextState.streak = {
        current: 6,
        longest: Math.max(nextState.streak.longest, 6),
        lastActivityDate: seededAt.toISOString().slice(0, 10),
      };
      // A varied persisted demo week exercises every activity intensity while
      // the separated older day keeps the displayed current streak at six.
      for (const [offset, reviewCount] of [[7, 1], [5, 1], [4, 2], [3, 4], [2, 7], [1, 3], [0, 1]]) {
        recordActivity(nextState, {
          type: "demo_review_activity",
          deckId: deck.id,
          demo: true,
          reviewCount,
          at: new Date(seededAt.getTime() - offset * DAY_MS).toISOString(),
        });
      }
      nextState.activity.sort((left, right) => String(left.at).localeCompare(String(right.at)));
      nextState.view.selectedDeckId = deck.id;
      return {
        deck: personalDeckSummary(deck, seededAt),
        seeded_reviews: seededReviews,
        demo_state: true,
        visible_effect: { type: "demo_state_seeded", deck_id: deck.id },
      };
    });
  }

  function seedShowcaseDemo() {
    const args = { client_action_id: "seed-showcase-demo:v2" };
    return withWrite("seed_showcase_demo", args, (nextState) => {
      const decks = SHOWCASE_DEMO_DECKS.map((spec) => {
        const deck = Object.values(nextState.personalDecks).find(
          (candidate) => candidate.source?.catalogDeckId === spec.catalogId,
        );
        return { ...spec, deck };
      });
      if (decks.some(({ deck }) => !deck)) {
        fail("DEMO_DECKS_MISSING", "The complete demo course set must be installed before its history is created");
      }
      const hasLearnerHistory =
        Object.keys(nextState.sessions).length > 0 ||
        Object.values(nextState.personalDecks).some((deck) =>
          deck.cardOrder.some((id) => deck.cards[id]?.review?.repetitions > 0),
        ) ||
        nextState.activity.some((event) => event.type !== "deck_added");
      if (hasLearnerHistory) {
        fail("DEMO_SEED_NOT_EMPTY", "Demo history can only be created in a new isolated demo workspace");
      }

      const seededAt = now();
      const profiles = {
        mastered: { introducedRatio: 1, dueRatio: 0, repetitions: 24, stabilityDays: 180, difficulty: 1, intervalDays: 180 },
        established: { introducedRatio: 0.9, dueRatio: 0.03, repetitions: 8, stabilityDays: 45, difficulty: 2.8, intervalDays: 30 },
        building: { introducedRatio: 0.72, dueRatio: 0.06, repetitions: 5, stabilityDays: 18, difficulty: 4.2, intervalDays: 14 },
        started: { introducedRatio: 0.55, dueRatio: 0.09, repetitions: 4, stabilityDays: 12, difficulty: 4.8, intervalDays: 7 },
      };
      const summaries = [];
      for (const { deck, profile: profileName, archived } of decks) {
        const profile = profiles[profileName];
        const activeCards = deck.cardOrder.map((id) => deck.cards[id]).filter((card) => card && !card.archived);
        let seededReviews = 0;
        activeCards.forEach((card, index) => {
          const sample = Number.parseInt(stableHash({ demo: deck.id, card: card.id }), 36) / 0xffffffff;
          if (sample >= profile.introducedRatio) return;
          const mastered = profileName === "mastered";
          const repetitions = mastered ? profile.repetitions : Math.max(1, profile.repetitions - (index % 3));
          const intervalDays = mastered ? profile.intervalDays : Math.max(1, profile.intervalDays - (index % 4));
          const dueSample = Number.parseInt(stableHash({ demo_due: deck.id, card: card.id }), 36) / 0xffffffff;
          const dueNow = !mastered && dueSample < profile.dueRatio;
          const elapsedDays = mastered
            ? 3
            : dueNow
              ? intervalDays + 1 + (index % 3)
              : Math.max(1, intervalDays - 1 - (index % Math.max(1, Math.min(3, intervalDays - 1))));
          const lastReviewedAt = new Date(seededAt.getTime() - elapsedDays * DAY_MS);
          const dueAt = new Date(lastReviewedAt.getTime() + intervalDays * DAY_MS);
          card.review = {
            algorithm: FSRS6_ALGORITHM_ID,
            exactFsrs: false,
            coreFormulaExact: true,
            showcaseSeeded: true,
            repetitions,
            lapses: mastered ? 0 : index % 9 === 0 ? 1 : 0,
            stabilityDays: mastered ? profile.stabilityDays : Math.max(1, profile.stabilityDays - (index % 5)),
            difficulty: mastered ? profile.difficulty : Math.min(9.5, profile.difficulty + (index % 4) * 0.35),
            intervalDays,
            dueAt: dueAt.toISOString(),
            lastReviewedAt: lastReviewedAt.toISOString(),
            lastRating: mastered ? "easy" : index % 7 === 0 ? "hard" : "good",
          };
          card.updatedAt = seededAt.toISOString();
          seededReviews += 1;
        });
        deck.archived = archived;
        deck.revision += 1;
        deck.updatedAt = seededAt.toISOString();
        summaries.push({ deck_id: deck.id, profile: profileName, archived, seeded_cards: seededReviews });
      }

      nextState.sessions = {};
      nextState.activeSessionId = null;
      nextState.activity = [];
      nextState.streak = {
        current: 24,
        longest: 35,
        lastActivityDate: seededAt.toISOString().slice(0, 10),
      };
      for (const [offset, reviewCount] of [[6, 12], [5, 18], [4, 11], [3, 24], [2, 15], [1, 21], [0, 17]]) {
        recordActivity(nextState, {
          type: "showcase_review_activity",
          deckId: decks[offset % decks.length].deck.id,
          demo: true,
          reviewCount,
          at: new Date(seededAt.getTime() - offset * DAY_MS).toISOString(),
        });
      }
      nextState.view.selectedDeckId = decks[0].deck.id;
      return {
        demo_state: true,
        decks: summaries,
        review_count: 118,
        streak: 24,
        visible_effect: { type: "showcase_demo_seeded", deck_id: decks[0].deck.id },
      };
    });
  }

  // Only extend the existing challenge-demo workspace. This never grades a
  // learner answer, overwrites an installed deck, or restores a removed sample.
  function seedMasteredDemoDeck() {
    const catalogId = "introductory-mechanics";
    const personalId = `deck-${catalogId}`;
    const catalogDeck = catalogDecks.get(catalogId);
    const canSeed = (snapshot) => {
      if (catalogDeck?.provenance !== "challenge_demo" || !catalogDeck.cards.length) return false;
      const decks = Object.values(snapshot.personalDecks);
      if (decks.some((deck) => deck.id === personalId || deck.source?.catalogDeckId === catalogId)) return false;
      return decks.some((deck) =>
        deck.source?.catalogDeckId === "linear-algebra-i" &&
        deck.source?.provenance === "challenge_demo" &&
        Object.values(deck.cards).some((card) => card.review?.demoSeeded === true),
      );
    };
    refreshStateFromStorage();
    if (!canSeed(state)) return { ok: true, added: false };
    return withWrite("seed_mastered_demo_deck", {
      client_action_id: "first-run:add-mastered-introductory-mechanics",
    }, (nextState) => {
      if (!canSeed(nextState)) return { added: false };
      const seededAt = now();
      const installedAt = seededAt.toISOString();
      const deck = personalDeckFromCatalog(
        catalogDeck,
        personalId,
        installedAt,
        newDeckInstanceId(personalId, installedAt, "mastered-demo", nextState.revision),
      );
      const lastReviewedAt = new Date(seededAt.getTime() - 3 * DAY_MS).toISOString();
      const dueAt = new Date(seededAt.getTime() + 177 * DAY_MS).toISOString();
      for (const card of Object.values(deck.cards)) {
        card.review = {
          ...card.review,
          demoSeeded: true,
          repetitions: 24,
          lapses: 0,
          stabilityDays: 180,
          difficulty: 1,
          intervalDays: 180,
          lastReviewedAt,
          dueAt,
          lastRating: "easy",
        };
      }
      nextState.personalDecks[personalId] = deck;
      // A supplemental sample must not evict existing learner activity.
      if (nextState.activity.length < MAX_ACTIVITY) {
        recordActivity(nextState, {
          type: "demo_deck_seeded",
          deckId: personalId,
          demo: true,
          at: installedAt,
        });
      }
      return {
        added: true,
        demo_state: true,
        deck: personalDeckSummary(deck, seededAt),
      };
    });
  }

  return Object.freeze({
    getLearningOverview,
    getStudyAvailability,
    getStudyActivity,
    inspectAppState,
    setView,
    searchLibrary,
    searchMyDecks,
    getDeck,
    validateDeck,
    ingestDeck,
    updateDeck,
    addCards,
    updateCards,
    inspectDeck,
    addLibraryDeck,
    listMyDecks,
    setDeckArchived,
    getDeckDeletionImpact,
    deleteDeck,
    inspectDeckGraph,
    focusDeckGraph,
    startStudySession,
    getStudySession,
    submitGrade,
    submitNonAnswerGrade,
    submitSelfGrade,
    inspectStudySession,
    captureAnswer,
    previewReview,
    applyReview,
    finishStudySession,
    previewDeckChanges,
    applyDeckChanges,
    seedDemoState,
    seedShowcaseDemo,
    seedMasteredDemoDeck,
    getSnapshot: () => {
      refreshStateFromStorage();
      return {
        ...jsonClone(state),
        streak: projectStreak(state.streak, now(), { timeZone }),
        capabilities: jsonClone(STORE_CAPABILITIES),
      };
    },
    getCatalogSnapshot: () => jsonClone([...catalogDecks.values()]),
    schedulerMetadata,
  });
}

// Only retained committed review rows establish recorded work. Session/card
// copies are reconciled as multisets; a 32-bit reviewId is a correlation hint,
// not a globally unique event ID. Legacy applied rows keep their row identity.
function indexStudyActivity(state) {
  const issues = new Map();
  const groups = new Map();
  const cards = new Map();
  const reviews = new Map();
  const examples = new Map();
  const accepted = new Set();
  let legacyTimestampCount = 0;
  let exampleTotal = 0;
  const issue = (code, count = 1) => issues.set(code, (issues.get(code) ?? 0) + count);
  const addReview = (context, at, rating, reviewId, count = 1) => {
    if (!count) return;
    reviews.set(at, (reviews.get(at) ?? 0) + count);
    const owner = cards.get(context);
    if (owner) {
      owner.recorded += count;
      if (owner.lastReviewedAt === at) owner.lastReviewRecorded = true;
    }
    else issue("UNRESOLVED_REVIEW_OWNER", count);
    accepted.add(JSON.stringify([context, reviewId, at, rating]));
  };
  const addModern = (context, record, origin, timestampField) => {
    const at = studyActivityTimestamp(record?.[timestampField]);
    const revision = record?.cardRevision === undefined ? 0 : record.cardRevision;
    if (!isPlainObject(record) || typeof record.reviewId !== "string" || !record.reviewId
      || at === null || !hasOwn(FSRS6_RATING_VALUES, record.rating)
      || !Number.isSafeInteger(revision) || revision < (record.cardRevision === undefined ? 0 : 1)) {
      issue(origin === "card" ? "INVALID_CARD_REVIEW" : "INVALID_SESSION_REVIEW");
      return;
    }
    const anchor = JSON.stringify([context, record.reviewId]);
    if (!groups.has(anchor)) groups.set(anchor, { context, reviewId: record.reviewId, profiles: new Map() });
    const group = groups.get(anchor);
    const signature = JSON.stringify([at, record.rating]);
    if (!group.profiles.has(signature)) {
      group.profiles.set(signature, { at, rating: record.rating, card: new Map(), session: new Map() });
    }
    const counts = group.profiles.get(signature)[origin];
    counts.set(revision, (counts.get(revision) ?? 0) + 1);
  };

  for (const [deckId, deck] of Object.entries(state.personalDecks)) {
    if (!isPlainObject(deck?.cards)) { issue("INVALID_CARD_COLLECTION"); continue; }
    for (const [cardId, card] of Object.entries(deck.cards)) {
      const context = studyActivityCardContext(state, deckId, cardId);
      if (!isPlainObject(card) || !context) { issue("INVALID_CARD_HISTORY"); continue; }
      if (cards.has(context)) issue("AMBIGUOUS_CARD_IDENTITY");
      const owner = {
        recorded: 0, repetitions: card.review?.repetitions,
        seeded: card.review?.demoSeeded === true || card.review?.showcaseSeeded === true,
        currentDemo: card.review?.demoSeeded === true || card.review?.showcaseSeeded === true,
        lastReviewedAt: studyActivityTimestamp(card.review?.lastReviewedAt), lastReviewRecorded: false,
      };
      // Validity diagnostics count retained entries, not canonical owners: a
      // later recovered alias must not hide an earlier invalid counter.
      if (owner.repetitions !== undefined
        && (!Number.isSafeInteger(owner.repetitions) || owner.repetitions < 0)) issue("INVALID_CARD_PROGRESS");
      cards.set(context, owner);
      if (!Array.isArray(card.reviewHistory)) {
        if (card.reviewHistory !== undefined) issue("INVALID_CARD_HISTORY");
        continue;
      }
      for (const record of card.reviewHistory) {
        // A real grade may follow illustrative scheduling progress. That seed
        // cannot become real work, nor prove a missing real-history count.
        if (record?.scheduleBefore?.demoSeeded === true) owner.seeded = true;
        addModern(context, record, "card", "submittedAt");
      }
    }
  }

  for (const session of Object.values(state.sessions)) {
    if (!isPlainObject(session)) { issue("INVALID_SESSION_HISTORY"); continue; }
    let committedRows = 0;
    if (!Array.isArray(session.history)) {
      if (session.history !== undefined || Number(session.reviewsApplied) > 0) {
        issue("INVALID_SESSION_HISTORY");
      }
    } else {
      for (const record of session.history) {
        if (!isPlainObject(record)) { issue("INVALID_SESSION_REVIEW"); continue; }
        if (!["grade_submitted", "applied"].includes(record.transition)) continue;
        committedRows += 1;
        const context = studyActivityCardContext(state, session.deckId, record.cardId);
        if (!context) { issue("INVALID_SESSION_REVIEW"); continue; }
        if (record.transition === "grade_submitted") {
          addModern(context, record, "session", "at");
        } else {
          const at = studyActivityTimestamp(record.at);
          if (at === null || !hasOwn(FSRS6_RATING_VALUES, record.rating)) {
            issue("INVALID_SESSION_REVIEW"); continue;
          }
          // Each ID-less applied row is its own retained event, even at the
          // same timestamp/rating. Its at is preview time, NOT Apply time.
          legacyTimestampCount += 1;
          addReview(context, at, record.rating, null);
        }
      }
    }
    if (session.reviewsApplied !== undefined
      && (!Number.isSafeInteger(session.reviewsApplied) || session.reviewsApplied < 0
        || session.reviewsApplied !== committedRows)) issue("SESSION_COUNT_MISMATCH");
  }

  for (const group of groups.values()) {
    const remaining = [];
    let cardRemainder = 0;
    let sessionRemainder = 0;
    for (const profile of group.profiles.values()) {
      const { card, session } = profile;
      let matched = 0;
      const pair = (left, right) => {
        const count = Math.min(card.get(left) ?? 0, session.get(right) ?? 0);
        if (!count) return;
        card.set(left, card.get(left) - count);
        session.set(right, session.get(right) - count);
        matched += count;
      };
      // Prefer explicit revision matches before the absent-revision wildcard.
      for (const revision of card.keys()) if (revision !== 0) pair(revision, revision);
      for (const revision of card.keys()) if (revision !== 0) pair(revision, 0);
      for (const revision of session.keys()) if (revision !== 0) pair(0, revision);
      pair(0, 0);
      addReview(group.context, profile.at, profile.rating, group.reviewId, matched);
      const fromCard = [...card.values()].reduce((sum, count) => sum + count, 0);
      const fromSession = [...session.values()].reduce((sum, count) => sum + count, 0);
      cardRemainder += fromCard;
      sessionRemainder += fromSession;
      remaining.push({ ...profile, count: fromCard + fromSession });
    }
    if (cardRemainder && sessionRemainder) {
      // Unmatched opposite copies disagree. Keep independent matched events,
      // but do not turn contradictory copies into two invented reviews.
      issue("CONFLICTING_REVIEW_COPIES");
    } else {
      for (const record of remaining) {
        addReview(group.context, record.at, record.rating, group.reviewId, record.count);
      }
    }
  }

  for (const owner of cards.values()) {
    if (owner.repetitions !== undefined
      && (!Number.isSafeInteger(owner.repetitions) || owner.repetitions < 0)) continue;
    if ((!owner.seeded && owner.repetitions > owner.recorded)
      || (owner.repetitions > 0 && !owner.currentDemo && !owner.lastReviewRecorded)) {
      // Lifetime rows can predate a material scheduling reset. A saved last
      // review with no retained event flags a gap, but never creates a count.
      issue("UNDATED_CARD_PROGRESS");
    }
  }
  if (!Array.isArray(state.activity)) issue("INVALID_RECENT_ACTIVITY");
  else for (const event of state.activity) {
    if (event?.type === "showcase_review_activity") {
      const at = studyActivityTimestamp(event.at);
      if (at === null || !Number.isSafeInteger(event.reviewCount) || event.reviewCount < 0) {
        issue("INVALID_SHOWCASE_EVENT"); continue;
      }
      reviews.set(at, (reviews.get(at) ?? 0) + event.reviewCount);
    } else if (event?.type === "demo_review_activity") {
      const at = studyActivityTimestamp(event.at);
      if (at === null || !Number.isSafeInteger(event.reviewCount) || event.reviewCount < 0
        || !Number.isSafeInteger(exampleTotal + event.reviewCount)) {
        issue("INVALID_EXAMPLE_EVENT"); continue;
      }
      exampleTotal += event.reviewCount;
      examples.set(at, (examples.get(at) ?? 0) + event.reviewCount);
    } else if (["grade_submitted", "review_applied"].includes(event?.type)) {
      const context = studyActivityCardContext(state, event.deckId, event.cardId);
      const at = studyActivityTimestamp(event.at);
      const key = JSON.stringify([context, event.type === "review_applied" ? null : event.reviewId, at, event.rating]);
      // Recent events can flag missing evidence, but never add or date work.
      if (!accepted.has(key)) issue("UNMATCHED_REVIEW_ACTIVITY");
    }
  }
  const times = (values) => [...values].map(([at, count]) => ({ at, count })).sort((a, b) => a.at - b.at);
  return { reviews: times(reviews), examples: times(examples), legacyTimestampCount, issues: [...issues] };
}

function resultBelongsToDeck(result, deckId, sessionIds) {
  if (!isPlainObject(result)) return false;
  const deckReferences = [
    result.deck_id,
    result.deleted_deck_id,
    result.deck?.id,
    result.session?.deck_id,
    result.visible_effect?.deck_id,
  ];
  if (deckReferences.includes(deckId)) return true;
  const sessionReferences = [
    result.session_id,
    result.active_session_id,
    result.session?.id,
    result.visible_effect?.session_id,
  ];
  return sessionReferences.some((sessionId) => sessionIds.has(sessionId));
}

function streakFromRetainedReviews(state, timeZone) {
  let streak = { current: 0, longest: 0, lastActivityDate: null };
  for (const review of indexStudyActivity(state).reviews) {
    if (review.count > 0) {
      streak = recordLocalStreak(streak, new Date(review.at), { timeZone });
    }
  }
  return streak;
}

function studyActivityCardContext(state, deckId, cardId) {
  if (typeof deckId !== "string" || !deckId || typeof cardId !== "string" || !cardId) return null;
  const deck = hasOwn(state.personalDecks, deckId) ? state.personalDecks[deckId] : null;
  return JSON.stringify([deckId, deck ? qualifiedCardId(deck, cardId) : cardId]);
}

function studyActivityTimestamp(value) {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59) return null;
  const date = new Date(`${parts[1]}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== parts[1]) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function projectStudyActivity(index, at, count, timeZone, appRevision) {
  if (timeZone !== undefined
    && (typeof timeZone !== "string" || !timeZone || /^[+-]/.test(timeZone))) {
    throw new RangeError("timeZone must name an IANA time zone");
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, calendar: "gregory", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit", era: "short",
  });
  const dateKey = (instant) => {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
    if (parts.era !== "AD" || parts.year.length > 4) throw new RangeError("Unsupported activity civil year");
    return `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`;
  };
  const today = dateKey(at);
  const firstDate = Date.parse(`${today}T00:00:00.000Z`) - (count - 1) * DAY_MS;
  // Date arithmetic here is over civil labels, never 24-hour local intervals.
  const days = Array.from({ length: count }, (_, offset) => ({
    date: new Date(firstDate + offset * DAY_MS).toISOString().slice(0, 10),
    review_count: 0, example_review_count: 0,
  }));
  const byDate = new Map(days.map(day => [day.date, day]));
  const issues = new Map(index.issues);
  for (const [records, field, futureCode] of [
    [index.reviews, "review_count", "FUTURE_REVIEW_RECORD"],
    [index.examples, "example_review_count", "FUTURE_EXAMPLE_REVIEW"],
  ]) {
    for (const record of records) {
      if (record.at > at.getTime()) {
        if (record.count) issues.set(futureCode, (issues.get(futureCode) ?? 0) + record.count);
      } else if (record.at >= firstDate - 2 * DAY_MS) {
        const day = byDate.get(dateKey(record.at));
        if (day) day[field] += record.count;
      }
    }
  }
  return {
    as_of: at.toISOString(), app_revision: appRevision,
    time_zone: formatter.resolvedOptions().timeZone, days,
    review_count: days.reduce((sum, day) => sum + day.review_count, 0),
    example_review_count: days.reduce((sum, day) => sum + day.example_review_count, 0),
    history: {
      basis: "retained-review-records", scope: "all-retained-history",
      status: issues.size ? "partial" : "consistent", lifetime_completeness: "unknown",
      legacy_timestamp_count: index.legacyTimestampCount,
      issues: [...issues].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([code, value]) => ({ code, count: value })),
    },
  };
}

function initialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    updatedAt: null,
    personalDecks: {},
    sessions: {},
    activeSessionId: null,
    streak: { current: 0, longest: 0, lastActivityDate: null },
    activity: [],
    view: { route: "study", selectedDeckId: null },
    actionReceipts: {},
    actionReceiptOrder: [],
  };
}

function resolveStorage(storage) {
  const candidate = storage ?? globalThis.localStorage ?? createMemoryStorage();
  for (const method of ["getItem", "setItem", "removeItem"]) {
    if (typeof candidate?.[method] !== "function") {
      fail("INVALID_STORAGE", `storage must implement ${method}()`);
    }
  }
  return candidate;
}

function serializeStateForStorage(state, catalogDecks, deckCache = null) {
  const { personalDecks: ignoredPersonalDecks, ...stateFields } = state;
  const persisted = jsonClone(stateFields);
  persisted.schemaVersion = PERSISTENCE_SCHEMA_VERSION;
  persisted.persistenceFormat = PERSISTENCE_FORMAT;
  persisted.personalDecks = Object.fromEntries(
    Object.entries(state.personalDecks).map(([deckId, deck]) => {
      const cacheKey = persistedDeckCacheKey(deck);
      const cached = deckCache?.get(deckId);
      if (cached?.key === cacheKey) return [deckId, cached.value];
      const value = serializePersonalDeckForStorage(deck, catalogDecks);
      deckCache?.set(deckId, { key: cacheKey, value });
      return [deckId, value];
    }),
  );
  return persisted;
}

function persistedDeckCacheKey(deck) {
  return `${Number(deck.revision ?? 0)}\u0000${String(deck.updatedAt ?? "")}\u0000${String(catalogPersistenceReference(deck)?.catalogVersion ?? "")}`;
}

function catalogPersistenceReference(deck) {
  if (isPlainObject(deck.persistenceCatalogBase)) return deck.persistenceCatalogBase;
  if (!deck.source?.catalogDeckId) return null;
  return {
    catalogDeckId: deck.source.catalogDeckId,
    catalogVersion: String(deck.source.catalogVersion),
  };
}

function serializePersonalDeckForStorage(deck, catalogDecks) {
  const reference = catalogPersistenceReference(deck);
  const catalogDeckId = reference?.catalogDeckId;
  const catalogDeck = resolveCatalogBase(catalogDecks, reference);
  if (!catalogDeck || String(catalogDeck.version) !== String(reference?.catalogVersion)) {
    return jsonClone(deck);
  }

  const baseline = personalDeckFromCatalog(catalogDeck, deck.id, deck.createdAt);
  const { cards: ignoredCards, cardOrder: ignoredCardOrder, edges: ignoredEdges, ...deckFields } = deck;
  const baselineByExternalId = new Map(
    baseline.cardOrder.map((cardId) => [qualifiedCardId(deck, cardId), cardId]),
  );
  const currentExternalIds = new Set();
  const cardOverlays = {};

  for (const cardId of deck.cardOrder) {
    const card = deck.cards[cardId];
    if (!card) continue;
    const externalId = qualifiedCardId(deck, cardId);
    if (currentExternalIds.has(externalId)) {
      fail("CARD_IDENTITY_COLLISION", `Personal deck ${deck.id} contains duplicate external card identity ${externalId}`);
    }
    currentExternalIds.add(externalId);
    const baseCardId = baselineByExternalId.get(externalId);
    if (!baseCardId) {
      cardOverlays[cardId] = { kind: "added", card: jsonClone(card) };
      continue;
    }
    const patch = objectDelta(baseline.cards[baseCardId], card, new Set(["id"]));
    if (cardId !== baseCardId || Object.keys(patch).length) {
      cardOverlays[cardId] = {
        kind: "base",
        baseCardId,
        patch,
      };
    }
  }

  const removedBaseCardIds = baseline.cardOrder.filter(
    (cardId) => !currentExternalIds.has(qualifiedCardId(deck, cardId)),
  );
  const persistedDeck = {
    persistenceKind: CATALOG_OVERLAY_KIND,
    catalogDeckId,
    catalogVersion: String(catalogDeck.version),
    catalogDigest: catalogBaseDigest(catalogDeck),
    deckFields: jsonClone(deckFields),
    cardOverlays,
    removedBaseCardIds,
  };
  if (stableStringify(deck.cardOrder) !== stableStringify(baseline.cardOrder)) {
    persistedDeck.cardOrder = jsonClone(deck.cardOrder);
  }
  if (stableStringify(deck.edges) !== stableStringify(baseline.edges)) {
    persistedDeck.edges = jsonClone(deck.edges);
  }
  return persistedDeck;
}

function objectDelta(baseline, current, ignoredKeys = new Set()) {
  const patch = {};
  const keys = new Set([...Object.keys(baseline ?? {}), ...Object.keys(current ?? {})]);
  for (const key of keys) {
    if (ignoredKeys.has(key)) continue;
    if (stableStringify(baseline?.[key]) !== stableStringify(current?.[key])) {
      patch[key] = jsonClone(current?.[key]);
    }
  }
  return patch;
}

function hydrateStateFromStorage(parsed, catalogDecks) {
  const state = jsonClone(parsed);
  state.schemaVersion = SCHEMA_VERSION;
  delete state.persistenceFormat;
  state.personalDecks = Object.fromEntries(
    Object.entries(parsed.personalDecks).map(([deckId, persistedDeck]) => [
      deckId,
      persistedDeck?.persistenceKind === CATALOG_OVERLAY_KIND
        ? hydrateCatalogOverlayDeck(persistedDeck, catalogDecks)
        : jsonClone(persistedDeck),
    ]),
  );
  return state;
}

function hydrateCatalogOverlayDeck(persistedDeck, catalogDecks) {
  if (!isPlainObject(persistedDeck.deckFields)) {
    fail("CORRUPT_STORAGE", "Sparse Library deck is missing deck fields");
  }
  const catalogDeck = resolveCatalogBase(catalogDecks, persistedDeck);
  if (!catalogDeck
    || String(catalogDeck.version) !== String(persistedDeck.catalogVersion)
    || catalogBaseDigest(catalogDeck) !== persistedDeck.catalogDigest) {
    fail(
      "CATALOG_BASE_UNAVAILABLE",
      `Stored deck requires Library ${persistedDeck.catalogDeckId} version ${persistedDeck.catalogVersion}`,
    );
  }
  const deckId = requireId(persistedDeck.deckFields.id, "persisted deck id");
  const createdAt = requiredString(persistedDeck.deckFields.createdAt, "persisted deck createdAt", 100);
  const deck = personalDeckFromCatalog(catalogDeck, deckId, createdAt);
  Object.assign(deck, jsonClone(persistedDeck.deckFields));

  for (const cardId of persistedDeck.removedBaseCardIds ?? []) {
    delete deck.cards[cardId];
  }
  if (!isPlainObject(persistedDeck.cardOverlays)) {
    fail("CORRUPT_STORAGE", "Sparse Library deck is missing card overlays");
  }
  for (const [storedCardId, overlay] of Object.entries(persistedDeck.cardOverlays)) {
    if (!isPlainObject(overlay)) fail("CORRUPT_STORAGE", "Sparse Library card overlay is invalid");
    if (overlay.kind === "added") {
      if (!isPlainObject(overlay.card)) fail("CORRUPT_STORAGE", "Sparse added card is invalid");
      deck.cards[storedCardId] = jsonClone(overlay.card);
      continue;
    }
    if (overlay.kind !== "base" || !isPlainObject(overlay.patch)) {
      fail("CORRUPT_STORAGE", "Sparse base-card overlay is invalid");
    }
    const baseCard = hasOwn(deck.cards, overlay.baseCardId) ? deck.cards[overlay.baseCardId] : null;
    if (!baseCard) {
      fail("CATALOG_BASE_UNAVAILABLE", `Stored card requires Library card ${overlay.baseCardId}`);
    }
    delete deck.cards[overlay.baseCardId];
    deck.cards[storedCardId] = {
      ...baseCard,
      ...jsonClone(overlay.patch),
      id: storedCardId,
    };
  }
  deck.cardOrder = Array.isArray(persistedDeck.cardOrder)
    ? jsonClone(persistedDeck.cardOrder)
    : deck.cardOrder.filter((cardId) => deck.cards[cardId]);
  deck.edges = Array.isArray(persistedDeck.edges)
    ? jsonClone(persistedDeck.edges)
    : deck.edges;
  return deck;
}

function catalogBaseDigest(catalogDeck) {
  if (!CATALOG_DIGEST_CACHE.has(catalogDeck)) {
    CATALOG_DIGEST_CACHE.set(catalogDeck, `fnv1a-${stableHash(catalogDeck)}`);
  }
  return CATALOG_DIGEST_CACHE.get(catalogDeck);
}

function readStoredRevision(storage) {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return 0;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StudyStoreError("CORRUPT_STORAGE", "Stored study state is not valid JSON", {
      cause: String(error?.message ?? error),
    });
  }
  assertPersistedSchema(parsed);
  if (!Number.isInteger(parsed.revision)) {
    fail("CORRUPT_STORAGE", "Stored study state has an invalid revision envelope");
  }
  return parsed.revision;
}

function assertPersistedSchema(parsed) {
  if (![SCHEMA_VERSION, PERSISTENCE_SCHEMA_VERSION].includes(parsed?.schemaVersion)) {
    fail("UNSUPPORTED_SCHEMA_VERSION", "Stored study state uses an unsupported schema version", {
      expected: PERSISTENCE_SCHEMA_VERSION,
      actual: parsed?.schemaVersion,
    });
  }
  if (parsed.schemaVersion === PERSISTENCE_SCHEMA_VERSION && parsed.persistenceFormat !== PERSISTENCE_FORMAT) {
    fail("UNSUPPORTED_PERSISTENCE_FORMAT", "Stored study state uses an unsupported persistence format");
  }
}

function loadState(storage, catalogDecks, { migrateLegacyAttempt = false, deckCache = null } = {}) {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return initialState();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StudyStoreError("CORRUPT_STORAGE", "Stored study state is not valid JSON", {
      cause: String(error?.message ?? error),
    });
  }
  assertPersistedSchema(parsed);
  if (
    !isPlainObject(parsed.personalDecks) ||
    !isPlainObject(parsed.sessions) ||
    !isPlainObject(parsed.actionReceipts) ||
    !Array.isArray(parsed.actionReceiptOrder)
  ) {
    fail("CORRUPT_STORAGE", "Stored study state is missing required collections");
  }
  const state = hydrateStateFromStorage(parsed, catalogDecks);
  const migratedDeckInstances = ensureDeckInstanceIds(state);
  // Also guard dense/recovered states: immutable Library authority cannot be
  // reconstructed from mutable source labels or silently replaced on reload.
  for (const deck of Object.values(state.personalDecks)) {
    if (!deck.libraryBase) continue;
    const base = resolveCatalogBase(catalogDecks, deck.libraryBase);
    if (!base || !sameLibraryBase(deck.libraryBase, base.libraryBase)) {
      fail("CATALOG_BASE_UNAVAILABLE", "Stored canonical Library identity requires its exact prepared release");
    }
  }
  if (deckCache && parsed.persistenceFormat === PERSISTENCE_FORMAT) {
    for (const [deckId, persistedDeck] of Object.entries(parsed.personalDecks)) {
      if (persistedDeck?.persistenceKind !== CATALOG_OVERLAY_KIND) continue;
      deckCache.set(deckId, {
        key: persistedDeckCacheKey(state.personalDecks[deckId]),
        value: jsonClone(persistedDeck),
      });
    }
  }
  if (migrateLegacyAttempt && (resetLegacyCommittedAttempt(state) || migratedDeckInstances)) {
    storage.setItem(STORAGE_KEY, JSON.stringify(serializeStateForStorage(state, catalogDecks)));
  }
  return jsonClone(state);
}

function ensureDeckInstanceIds(state) {
  let changed = false;
  for (const deck of Object.values(state.personalDecks ?? {})) {
    if (typeof deck.deckInstanceId === "string" && deck.deckInstanceId.length > 0) continue;
    deck.deckInstanceId = newDeckInstanceId(
      deck.id,
      deck.createdAt,
      `legacy:${stableHash({ source: deck.source ?? null, createdAt: deck.createdAt })}`,
      0,
    );
    changed = true;
  }
  return changed;
}

function resetLegacyCommittedAttempt(state) {
  const sessionId = state.activeSessionId;
  const session = sessionId ? state.sessions[sessionId] : null;
  if (session?.status !== "active" || session.phase !== "answer_committed") {
    return false;
  }

  const migratedAt = state.updatedAt ?? session.updatedAt ?? session.startedAt ?? null;
  session.phase = "awaiting_answer";
  session.capture = null;
  session.revision = Math.max(1, Number(session.revision) || 1) + 1;
  session.updatedAt = migratedAt;
  session.history = Array.isArray(session.history) ? session.history : [];
  session.history.push({
    cardId: session.currentCardId,
    transition: "legacy_answer_reset",
    at: migratedAt,
  });

  const retiredOperations = new Set(["capture_answer", "preview_review", "apply_review"]);
  const removedReceiptKeys = new Set();
  for (const [key, receipt] of Object.entries(state.actionReceipts)) {
    const result = receipt?.result;
    if (
      result?.session_id === sessionId &&
      retiredOperations.has(result?.receipt?.operation)
    ) {
      delete state.actionReceipts[key];
      removedReceiptKeys.add(key);
    }
  }
  if (removedReceiptKeys.size) {
    state.actionReceiptOrder = state.actionReceiptOrder.filter(
      (key) => !removedReceiptKeys.has(key),
    );
  }
  state.revision = Math.max(0, Number(state.revision) || 0) + 1;
  return true;
}

function createClock(clock) {
  const read =
    typeof clock === "function"
      ? clock
      : clock && typeof clock.now === "function"
        ? () => clock.now()
        : () => new Date();
  return () => {
    const value = read();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) fail("INVALID_CLOCK", "clock returned an invalid date");
    return date;
  };
}

// The active map alone serves Library reads and installation. Historical maps
// are bootstrap capabilities used only to resolve already-saved exact bases.
// Never attach per-store retention to the shared prepared-normalization cache.
function catalogWithRetainedBases(input, retainedCatalogs) {
  if (!Array.isArray(retainedCatalogs)) fail("INVALID_CATALOG", "retainedCatalogs must be an array of catalogs");
  const active = normalizeCatalog(input);
  if (!retainedCatalogs.length) return active;
  const catalogDecks = new Map(active);
  const bases = new Map();
  const releases = new Map();
  for (const catalog of [catalogDecks, ...retainedCatalogs.map(normalizeCatalog)]) {
    for (const deck of catalog.values()) {
      const key = JSON.stringify([deck.id, String(deck.version)]);
      const existing = bases.get(key);
      bases.set(key, mergeImmutableCatalogBase(existing, deck));
      if (deck.libraryBase) {
        const releaseKey = stableStringify(deck.libraryBase.catalogRef);
        if (!releases.has(releaseKey)) releases.set(releaseKey, new Map());
        const release = releases.get(releaseKey);
        release.set(deck.id, mergeImmutableCatalogBase(release.get(deck.id), deck));
      }
    }
  }
  RETAINED_CATALOG_REGISTRY.set(catalogDecks, { bases, releases });
  return catalogDecks;
}

function mergeImmutableCatalogBase(existing, candidate) {
  if (!existing) return candidate;
  if (existing.libraryBase || candidate.libraryBase) {
    if (!sameLibraryBase(existing.libraryBase, candidate.libraryBase)) {
      fail("INVALID_CATALOG", `Conflicting immutable catalog base ${candidate.id} version ${candidate.version}`);
    }
    const existingResolved = existing.contentResolved !== false;
    const candidateResolved = candidate.contentResolved !== false;
    if (existingResolved && candidateResolved && stableStringify(existing) !== stableStringify(candidate)) {
      fail("INVALID_CATALOG", `Conflicting immutable catalog base ${candidate.id} version ${candidate.version}`);
    }
    return candidateResolved ? candidate : existing;
  }
  if (stableStringify(existing) !== stableStringify(candidate)) {
    fail("INVALID_CATALOG", `Conflicting immutable catalog base ${candidate.id} version ${candidate.version}`);
  }
  return existing;
}

function resolveCatalogBase(catalogDecks, reference) {
  if (!reference?.catalogDeckId) return null;
  const registry = RETAINED_CATALOG_REGISTRY.get(catalogDecks);
  const base = registry
    ? registry.bases.get(JSON.stringify([reference.catalogDeckId, String(reference.catalogVersion)]))
    : catalogDecks.get(reference.catalogDeckId);
  return base && base.contentResolved !== false && String(base.version) === String(reference.catalogVersion) ? base : null;
}

function normalizeCatalog(input) {
  const preparedLegacy = input?.kind === "meshful-library-runtime-catalog.v1";
  const preparedView = input?.kind === "meshful-library-runtime-catalog-view.v1";
  const prepared = preparedLegacy || preparedView;
  if (prepared && PREPARED_CATALOG_CACHE.has(input)) return PREPARED_CATALOG_CACHE.get(input);
  const library = prepared ? input.library : null;
  if (prepared && (!isPreparedLibraryCatalog(input) || !Object.isFrozen(input) || !Array.isArray(input.catalog)
    || !isPlainObject(library?.decks)
    || library.normalizationVersion !== "canonical-library-card-identity.v1")) {
    fail("INVALID_LIBRARY_CATALOG", "Use the frozen prepareLibraryCatalog result at bootstrap");
  }
  let rawDecks = [];
  let resolvedViewIds = null;
  if (preparedView) {
    if (!Array.isArray(input.summaries)) {
      fail("INVALID_LIBRARY_CATALOG", "Prepared catalog views require pinned summaries");
    }
    const loaded = new Map();
    for (const raw of input.catalog) {
      if (!isPlainObject(raw)) fail("INVALID_LIBRARY_CATALOG", "Prepared catalog view contains an invalid resolved deck");
      const id = requireId(raw.id ?? raw.deck_id, "resolved catalog deck id");
      if (loaded.has(id)) fail("INVALID_LIBRARY_CATALOG", `Prepared catalog view repeats ${id}`);
      loaded.set(id, raw);
    }
    resolvedViewIds = new Set(loaded.keys());
    rawDecks = input.summaries.map((summary) => loaded.get(summary.deck_id) ?? {
      id: summary.deck_id,
      version: summary.version,
      title: summary.title,
      description: summary.description,
      subject: summary.subject,
      domain: summary.domain,
      level: summary.level,
      tags: summary.tags,
      review_status: summary.review_status,
      content_status: summary.content_status,
      evidence_tier: summary.evidence_tier,
      rights_status: summary.rights_status,
      cards: [],
      edges: [],
      modules: [],
    });
    if (resolvedViewIds.size !== input.catalog.length) {
      fail("INVALID_LIBRARY_CATALOG", "Prepared catalog view resolved-deck coverage differs");
    }
  } else if (preparedLegacy) rawDecks = input.catalog;
  else if (Array.isArray(input)) rawDecks = input;
  else if (Array.isArray(input?.decks)) rawDecks = input.decks;
  else if (isPlainObject(input?.decks)) rawDecks = Object.values(input.decks);
  else if (isPlainObject(input)) rawDecks = Object.values(input);
  const decks = new Map();
  rawDecks.forEach((raw, index) => {
    if (!isPlainObject(raw)) fail("INVALID_CATALOG", `catalog deck ${index} must be an object`);
    const title = requiredString(raw.title ?? raw.name, `catalog[${index}].title`, 200);
    const id = requireId(raw.id ?? raw.deck_id ?? raw.slug ?? slug(title), `catalog[${index}].id`);
    if (decks.has(id)) fail("INVALID_CATALOG", `duplicate catalog deck id ${id}`);
    const rawCards = Array.isArray(raw.cards)
      ? raw.cards
      : isPlainObject(raw.cards)
        ? Object.values(raw.cards)
        : [];
    const cards = rawCards.map((card, cardIndex) => normalizeCatalogCard(card, cardIndex, prepared));
    ensureUniqueCards(cards, `catalog deck ${id}`);
    const cardIds = new Set(cards.map((card) => card.id));
    const edges = normalizeEdges(raw.edges ?? [], cards);
    for (const card of cards) {
      const prerequisites = card._prerequisites;
      delete card._prerequisites;
      card.prerequisiteIds = jsonClone(prerequisites);
      for (const prerequisite of prerequisites) {
        if (cardIds.has(prerequisite)) {
          edges.push(normalizeEdge({ prerequisite_card_id: prerequisite, dependent_card_id: card.id }));
        }
      }
    }
    const dedupedEdges = dedupeEdges(edges);
    validateEdges(cardIds, dedupedEdges);
    assertAcyclic(cardIds, dedupedEdges);
    const normalized = {
      id,
      title,
      subject: optionalString(raw.subject, "subject", 100) ?? "General",
      domain: optionalString(raw.domain, "domain", 100) ?? optionalString(raw.subject, "subject", 100) ?? "General",
      level: optionalString(raw.level, "level", 100) ?? "Unspecified",
      description: optionalString(raw.description, "description", 2_000) ?? "",
      version: String(raw.version ?? "1"),
      cards,
      edges: dedupedEdges,
      provenance: jsonClone(raw.provenance ?? null),
      license: jsonClone(raw.license ?? raw.licenseStatus ?? null),
      reviewStatus: String(raw.review_status ?? raw.reviewStatus ?? "unreviewed"),
      contentStatus: String(raw.content_status ?? raw.contentStatus ?? "unspecified"),
      tags: optionalStringArray(raw.tags, "tags", 50),
      modules: normalizeCatalogModules(raw.modules, cards),
      evidenceTier: String(raw.evidence_tier ?? raw.evidenceTier ?? raw.review_status ?? raw.reviewStatus ?? "unclassified"),
      rightsStatus: String(raw.rights_status ?? raw.rightsStatus ?? raw.license_status ?? raw.licenseStatus ?? "unclassified"),
    };
    if (prepared) {
      const pin = hasOwn(library.decks, id) ? library.decks[id] : null;
      if (!pin || pin.catalogDeckId !== id || pin.catalogVersion !== normalized.version
        || !Array.isArray(pin.requiredCatalogDeckIds) || pin.requiredCatalogDeckIds.at(-1) !== id) {
        fail("INVALID_LIBRARY_CATALOG", `Missing or inconsistent prepared base for ${id}`);
      }
      const contentResolved = preparedLegacy || resolvedViewIds.has(id);
      if (preparedView && Boolean(pin.contentResolved) !== contentResolved) {
        fail("INVALID_LIBRARY_CATALOG", `Prepared content resolution differs for ${id}`);
      }
      if (preparedView && contentResolved && (
        cards.length !== pin.summary.card_count
        || dedupedEdges.length !== pin.summary.prerequisite_edge_count
      )) {
        fail("INVALID_LIBRARY_CATALOG", `Resolved catalog counts differ for ${id}`);
      }
      normalized.libraryBase = {
        normalizationVersion: library.normalizationVersion,
        catalogRef: jsonClone(library.catalogRef),
        dependencyGraphDigest: library.dependencyGraphDigest,
        sourceDeckId: pin.sourceDeckId,
        catalogDeckId: id,
        catalogVersion: pin.catalogVersion,
        payloadDigest: pin.payloadDigest,
        artifactDigest: pin.artifactDigest,
      };
      normalized.requiredCatalogDeckIds = jsonClone(pin.requiredCatalogDeckIds);
      normalized.contentResolved = contentResolved;
      if (preparedView) {
        normalized.librarySummary = jsonClone(pin.summary);
        const owners = Object.create(null);
        for (const owner of pin.externalPrerequisiteOwners ?? []) {
          const existing = owners[owner.prerequisite_card_id];
          if (existing && existing !== owner.prerequisite_catalog_deck_id) {
            fail("INVALID_LIBRARY_CATALOG", `External owner differs for ${owner.prerequisite_card_id}`);
          }
          owners[owner.prerequisite_card_id] = owner.prerequisite_catalog_deck_id;
        }
        normalized.externalPrerequisiteOwners = owners;
      }
      freezeCatalogValue(normalized);
    }
    decks.set(id, normalized);
  });
  if (prepared) {
    if (Object.keys(library.decks).length !== decks.size) {
      fail("INVALID_LIBRARY_CATALOG", "Prepared catalog base coverage differs");
    }
    libraryCardOwners(decks);
    PREPARED_CATALOG_CACHE.set(input, decks);
  }
  return decks;
}

function freezeCatalogValue(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeCatalogValue(child);
  return Object.freeze(value);
}

function normalizeCatalogCard(raw, index, preserveStrings = false) {
  if (!isPlainObject(raw)) fail("INVALID_CATALOG", `catalog card ${index} must be an object`);
  const string = preserveStrings ? boundedNonblankString : requiredString;
  const strings = (value, name, max) => preserveStrings
    ? catalogStrings(value, name, max)
    : optionalStringArray(value, name, max);
  const term = string(raw.term ?? raw.front ?? raw.name, `card[${index}].term`, 300);
  const definition = string(
    raw.definition ?? raw.back ?? raw.answer,
    `card[${index}].definition`,
    8_000,
  );
  const id = requireId(raw.id ?? raw.card_id ?? slug(term), `card[${index}].id`);
  return {
    id,
    term,
    definition,
    prompt: preserveStrings && raw.prompt !== null && raw.prompt !== undefined
      ? string(raw.prompt, "prompt", 1_000)
      : optionalString(raw.prompt, "prompt", 1_000) ?? null,
    aliases: strings(raw.aliases, "aliases", 20),
    acceptedPoints: optionalStringArray(raw.accepted_points ?? raw.acceptedPoints, "accepted_points", 30),
    requiredConcepts: normalizeRubricItems(raw.required_concepts ?? raw.requiredConcepts, "required_concepts"),
    acceptedVariants: strings(raw.accepted_variants ?? raw.acceptedVariants, "accepted_variants", 30),
    majorErrorConcepts: normalizeRubricItems(raw.major_error_concepts ?? raw.majorErrorConcepts, "major_error_concepts"),
    confusions: optionalStringArray(raw.confusions, "confusions", 30),
    misconceptions: normalizeMisconceptions(raw.misconceptions),
    tags: strings(raw.tags, "tags", 50),
    sourceRefs: strings(raw.source_refs ?? raw.sourceRefs, "source_refs", 50),
    moduleIds: strings(
      raw.module_ids ?? (raw.module ? [slug(raw.module)] : []),
      "module_ids",
      50,
    ),
    difficultyHint: preserveStrings && raw.difficulty_hint !== null && raw.difficulty_hint !== undefined
      ? string(raw.difficulty_hint, "difficulty_hint", 100)
      : optionalString(raw.difficulty_hint, "difficulty_hint", 100) ?? null,
    provenance: jsonClone(raw.provenance ?? null),
    _prerequisites: optionalIdArray(
      raw.prerequisites ?? raw.prerequisite_ids ?? raw.direct_prerequisite_ids,
      "prerequisites",
      50,
    ),
  };
}

function catalogStrings(value, name, maxItems) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) fail("INVALID_CATALOG", `${name} must be a bounded string array`);
  return value.map((item, index) => boundedNonblankString(item, `${name}[${index}]`, 1_000));
}

function normalizeEdges(rawEdges, cards) {
  if (!Array.isArray(rawEdges)) fail("INVALID_CATALOG", "edges must be an array");
  return rawEdges.map(normalizeEdge);
}

function normalizeEdge(raw, index = 0) {
  if (!isPlainObject(raw)) fail("INVALID_EDGE", `edge ${index} must be an object`);
  const from = requireId(
    raw.prerequisite_card_id ?? raw.prerequisiteId ?? raw.from ?? raw.source,
    `edge[${index}].prerequisite_card_id`,
  );
  const to = requireId(
    raw.dependent_card_id ?? raw.dependentId ?? raw.to ?? raw.target,
    `edge[${index}].dependent_card_id`,
  );
  const id = requireId(raw.id ?? compactEdgeId(from, to), `edge[${index}].id`);
  return { id, prerequisiteCardId: from, dependentCardId: to };
}

function compactEdgeId(from, to) {
  // Full canonical card IDs can each approach the 128-character store limit,
  // so concatenating both IDs creates an edge ID that the store then rejects.
  // Two independently ordered 32-bit hashes keep the derived identity stable
  // and compact while the edge still retains both full endpoint IDs.
  return `edge:${stableHash({ from, to })}:${stableHash({ to, from })}`;
}

function personalDeckFromCatalog(catalogDeck, personalId, installedAt, deckInstanceId = null) {
  const cards = {};
  const cardOrder = [];
  for (const sourceCard of catalogDeck.cards) {
    const card = personalCard(sourceCard, installedAt);
    cards[card.id] = card;
    cardOrder.push(card.id);
  }
  return {
    id: personalId,
    deckInstanceId: deckInstanceId ?? newDeckInstanceId(
      personalId, installedAt, `catalog:${catalogDeck.id}:${catalogDeck.version}`, 0,
    ),
    title: catalogDeck.title,
    subject: catalogDeck.subject,
    domain: catalogDeck.domain,
    level: catalogDeck.level,
    description: catalogDeck.description,
    tags: jsonClone(catalogDeck.tags),
    modules: jsonClone(catalogDeck.modules ?? []),
    provenance: targetProvenanceFromCatalog(catalogDeck),
    cards,
    cardOrder,
    edges: jsonClone(catalogDeck.edges),
    ...(catalogDeck.libraryBase ? { libraryBase: jsonClone(catalogDeck.libraryBase) } : {}),
    source: {
      kind: "library",
      catalogDeckId: catalogDeck.id,
      catalogVersion: catalogDeck.version,
      provenance: jsonClone(catalogDeck.provenance),
      license: jsonClone(catalogDeck.license),
    reviewStatus: catalogDeck.reviewStatus,
    contentStatus: catalogDeck.contentStatus,
    },
    archived: false,
    revision: 1,
    createdAt: installedAt,
    updatedAt: installedAt,
  };
}

function personalDeckIdBase(catalogDeck) {
  // Catalog IDs can carry an immutable release namespace. That provenance
  // belongs in libraryBase/source, not in the learner's personal deck identity.
  const stableCourseId = catalogDeck.libraryBase?.sourceDeckId ?? catalogDeck.id;
  return `deck-${slug(stableCourseId)}`;
}

function sameLibraryBase(actual, expected) {
  return Boolean(actual && expected && stableStringify(actual) === stableStringify(expected));
}

function libraryCardOwners(catalogDecks, savedDeck = null) {
  if (!catalogDecks) return new Map();
  if (savedDeck?.libraryBase) {
    catalogDecks = RETAINED_CATALOG_REGISTRY.get(catalogDecks)?.releases
      .get(stableStringify(savedDeck.libraryBase.catalogRef)) ?? catalogDecks;
    if (!sameLibraryBase(resolveCatalogBase(catalogDecks, savedDeck.libraryBase)?.libraryBase, savedDeck.libraryBase)) {
      fail("CATALOG_BASE_UNAVAILABLE", "Saved prerequisites require their exact prepared Library release");
    }
  }
  if (!LIBRARY_CARD_OWNER_CACHE.has(catalogDecks)) {
    const owners = new Map();
    for (const deck of catalogDecks.values()) {
      if (!deck.libraryBase || deck.contentResolved === false) continue;
      for (const card of deck.cards) {
        if (owners.has(card.id)) fail("INVALID_LIBRARY_CATALOG", `Ambiguous canonical Library card ${card.id}`);
        owners.set(card.id, { deck, card });
      }
    }
    LIBRARY_CARD_OWNER_CACHE.set(catalogDecks, owners);
  }
  return LIBRARY_CARD_OWNER_CACHE.get(catalogDecks);
}

function libraryPrerequisiteOwner(catalogDecks, savedDeck, parentId) {
  const owners = libraryCardOwners(catalogDecks, savedDeck);
  if (owners.has(parentId)) return owners.get(parentId);
  if (!savedDeck?.libraryBase) return null;
  const release = RETAINED_CATALOG_REGISTRY.get(catalogDecks)?.releases
    .get(stableStringify(savedDeck.libraryBase.catalogRef)) ?? catalogDecks;
  const dependentBase = resolveCatalogBase(release, savedDeck.libraryBase);
  const ownerDeckId = dependentBase?.externalPrerequisiteOwners?.[parentId];
  if (!ownerDeckId) return null;
  const ownerDeck = release.get(ownerDeckId);
  if (!ownerDeck?.libraryBase) return null;
  const card = ownerDeck.contentResolved === false
    ? null
    : ownerDeck.cards.find((candidate) => candidate.id === parentId) ?? null;
  return { deck: ownerDeck, card };
}

function matchingLibraryInstallations(state, catalogId, expectedBase = null) {
  return Object.values(state?.personalDecks ?? {}).filter(deck =>
    (deck.libraryBase?.catalogDeckId === catalogId || deck.source?.catalogDeckId === catalogId)
    && (!expectedBase || sameLibraryBase(deck.libraryBase, expectedBase)));
}

function installSelectedLibraryDeck(state, root, installedAt, actionId) {
  const matches = matchingLibraryInstallations(state, root.id);
  if (matches.length > 1 || (matches.length && !sameLibraryBase(matches[0].libraryBase, root.libraryBase))) {
    fail("CATALOG_BASE_UNAVAILABLE", `Library course ${root.id} conflicts with an existing saved edition`);
  }
  const existing = matches[0] ?? null;
  if (existing?.archived) {
    fail("INVALID_ARGUMENT", `Library course ${root.id} is archived; restore it explicitly`);
  }
  const personalId = existing?.id ?? uniqueDeckId(state, personalDeckIdBase(root));
  const deck = existing ?? personalDeckFromCatalog(
    root, personalId, installedAt,
    newDeckInstanceId(personalId, installedAt, actionId, state.revision),
  );
  if (!existing) state.personalDecks[deck.id] = deck;
  const record = {
    catalog_deck_id: root.id,
    catalog_version: root.version,
    deck_id: deck.id,
    payload_sha256: root.libraryBase.payloadDigest,
    normalized_digest: catalogBaseDigest(root),
    already_installed: Boolean(existing),
  };
  state.view.selectedDeckId = deck.id;
  if (!existing) {
    recordActivity(state, {
      type: "deck_added", deckId: deck.id, at: installedAt,
      installedDeckIds: [deck.id],
    });
  }
  return {
    deck: personalDeckSummary(deck, new Date(installedAt)),
    already_installed: Boolean(existing),
    visible_effect: { type: "deck_added", deck_id: deck.id },
    installation: {
      catalog_ref: jsonClone(root.libraryBase.catalogRef),
      dependency_graph_sha256: root.libraryBase.dependencyGraphDigest,
      decks: [record],
    },
  };
}

function personalCard(sourceCard, at) {
  return {
    id: sourceCard.id,
    term: sourceCard.term,
    definition: sourceCard.definition,
    prompt: sourceCard.prompt ?? null,
    aliases: jsonClone(sourceCard.aliases ?? []),
    acceptedPoints: jsonClone(sourceCard.acceptedPoints ?? []),
    requiredConcepts: jsonClone(sourceCard.requiredConcepts ?? sourceCard.acceptedPoints?.map((text, index) => ({ rubricItemId: `required-${index + 1}`, text })) ?? []),
    acceptedVariants: jsonClone(sourceCard.acceptedVariants ?? []),
    majorErrorConcepts: jsonClone(sourceCard.majorErrorConcepts ?? []),
    confusions: jsonClone(sourceCard.confusions ?? []),
    misconceptions: jsonClone(sourceCard.misconceptions ?? []),
    tags: jsonClone(sourceCard.tags ?? []),
    sourceRefs: jsonClone(sourceCard.sourceRefs ?? []),
    prerequisiteIds: jsonClone(sourceCard.prerequisiteIds ?? []),
    moduleIds: jsonClone(sourceCard.moduleIds ?? []),
    difficultyHint: sourceCard.difficultyHint ?? null,
    provenance: jsonClone(sourceCard.provenance ?? null),
    contentRevision: Number(sourceCard.contentRevision ?? 1),
    reviewHistory: [],
    archived: false,
    review: newReviewState(at),
    createdAt: at,
    updatedAt: at,
  };
}

function newReviewState(at) {
  return {
    algorithm: FSRS6_ALGORITHM_ID,
    exactFsrs: false,
    coreFormulaExact: true,
    repetitions: 0,
    lapses: 0,
    stabilityDays: null,
    difficulty: null,
    intervalDays: 0,
    dueAt: at,
    lastReviewedAt: null,
    lastRating: null,
    hasSuccessfulRecall: false,
  };
}

function normalizeRubricItems(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 30) {
    fail("INVALID_ARGUMENT", `${name} must be an array with at most 30 entries`);
  }
  return value.map((item, index) => {
    if (typeof item === "string") {
      return { rubricItemId: `${slug(name)}-${index + 1}`, text: boundedNonblankString(item, `${name}[${index}]`, 1_000) };
    }
    if (!isPlainObject(item)) fail("INVALID_ARGUMENT", `${name}[${index}] must be an object`);
    return {
      rubricItemId: requireId(item.rubric_item_id ?? item.id, `${name}[${index}].id`),
      text: boundedNonblankString(item.text, `${name}[${index}].text`, 1_000),
    };
  });
}

function normalizeMisconceptions(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 30) {
    fail("INVALID_ARGUMENT", "misconceptions must be an array with at most 30 entries");
  }
  return value.map((item, index) => {
    if (typeof item === "string") {
      return {
        id: `misconception-${index + 1}`,
        belief: requiredString(item, `misconceptions[${index}]`, 1_000),
        correction: "",
      };
    }
    if (!isPlainObject(item)) fail("INVALID_ARGUMENT", `misconceptions[${index}] must be an object`);
    return {
      id: requireId(item.id, `misconceptions[${index}].id`),
      belief: requiredString(item.belief, `misconceptions[${index}].belief`, 1_000),
      correction: requiredString(item.correction, `misconceptions[${index}].correction`, 1_000),
    };
  });
}

function normalizeCatalogModules(rawModules, cards) {
  if (Array.isArray(rawModules)) {
    return rawModules.map((raw, index) => {
      if (!isPlainObject(raw)) fail("INVALID_CATALOG", `module ${index} must be an object`);
      return {
        module_id: requireId(raw.module_id ?? raw.id, `modules[${index}].module_id`),
        title: requiredString(raw.title ?? raw.name, `modules[${index}].title`, 200),
        description: optionalString(raw.description, `modules[${index}].description`, 1_000) ?? "",
        position: boundedInteger(raw.position ?? index, `modules[${index}].position`, 0, 10_000),
      };
    });
  }
  const ids = [...new Set(cards.flatMap((card) => card.moduleIds ?? []))];
  return ids.map((moduleId, index) => ({
    module_id: moduleId,
    title: String(moduleId).replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    description: "",
    position: index,
  }));
}

function targetProvenanceFromCatalog(deck) {
  const raw = isPlainObject(deck.provenance) ? deck.provenance : {};
  const sourceRecords = Array.isArray(raw.source_records)
    ? raw.source_records
    : [];
  return {
    origin: String(raw.origin ?? raw.source ?? "catalog"),
    source_outline: String(raw.source_outline ?? ""),
    source_records: sourceRecords.map((record, index) => ({
      source_id: String(record.source_id ?? record.id ?? `source-${index + 1}`),
      title: String(record.title ?? "Untitled source"),
      uri: String(record.uri ?? ""),
      locator: String(record.locator ?? ""),
      license: String(record.license ?? ""),
    })),
    evidence_tier: String(deck.evidenceTier ?? deck.reviewStatus ?? "unclassified"),
    rights_status: String(deck.rightsStatus ?? deck.license?.name ?? deck.license ?? "unclassified"),
    notes: String(raw.notes ?? ""),
  };
}

function diagnostic(code, path, message) {
  return { code, path, message };
}

function semanticReviewObligations({ sourceRightsReview = false } = {}) {
  const obligations = [
    diagnostic("FACTUAL_ACCURACY_REVIEW", "deck.cards", "Agent review must establish factual accuracy."),
    diagnostic("SCOPE_AND_PEDAGOGY_REVIEW", "deck", "Agent review must assess scope, atomicity, criteria, and prerequisite directness."),
    diagnostic("MARKDOWN_AND_MATH_REVIEW", "deck.cards", "Agent review must check definition Markdown and math for clarity and balanced delimiters."),
  ];
  if (sourceRightsReview) {
    obligations.push(diagnostic(
      "SOURCE_RIGHTS_REVIEW",
      "deck.provenance",
      "Agent review must confirm that stored source-bearing content may be used and redistributed.",
    ));
  }
  return obligations;
}

function deckRequiresSourceRightsReview(deck) {
  if (deck.source?.rightsReviewRequired === true) return true;
  if (deck.source?.kind === "library") return true;
  const provenance = targetProvenanceForPersonal(deck);
  if (provenance.source_records.length > 0) return true;
  return deck.cardOrder.some((id) => (deck.cards[id]?.sourceRefs ?? []).length > 0);
}

function targetLibraryDeckSummary(deck) {
  if (deck.librarySummary) return jsonClone({
    deck_id: deck.librarySummary.deck_id,
    version: deck.librarySummary.version,
    title: deck.librarySummary.title,
    description: deck.librarySummary.description,
    subject: deck.librarySummary.subject,
    domain: deck.librarySummary.domain,
    level: deck.librarySummary.level,
    tags: deck.librarySummary.tags,
    module_count: deck.librarySummary.module_count,
    card_count: deck.librarySummary.card_count,
    prerequisite_edge_count: deck.librarySummary.prerequisite_edge_count,
    cross_deck_edge_count: 0,
    evidence_tier: deck.librarySummary.evidence_tier,
    rights_status: deck.librarySummary.rights_status,
    provenance_summary: deck.librarySummary.provenance_summary,
  });
  const provenance = targetProvenanceFromCatalog(deck);
  return {
    deck_id: deck.id,
    version: String(deck.version),
    title: deck.title,
    description: deck.description,
    subject: deck.subject,
    domain: deck.domain ?? deck.subject,
    level: deck.level,
    tags: jsonClone(deck.tags ?? []),
    module_count: (deck.modules ?? []).length,
    card_count: deck.cards.length,
    prerequisite_edge_count: deck.edges.length,
    cross_deck_edge_count: 0,
    evidence_tier: provenance.evidence_tier,
    rights_status: provenance.rights_status,
    provenance_summary: {
      origin: provenance.origin,
      source_count: provenance.source_records.length,
      notes: provenance.notes,
    },
  };
}

function targetPersonalDeckSummary(deck, at) {
  const metrics = deckMetrics(deck, at);
  const provenance = targetProvenanceForPersonal(deck);
  return {
    deck_id: deck.id,
    deck_revision: deck.revision,
    content_revision: Number(deck.contentRevision ?? deck.revision),
    title: deck.title,
    subject: deck.subject,
    domain: deck.domain ?? deck.subject,
    level: deck.level,
    archived: Boolean(deck.archived),
    card_count: metrics.total_cards,
    archived_card_count: deck.cardOrder.filter((id) => deck.cards[id]?.archived).length,
    due_count: metrics.due_count,
    new_count: metrics.new_count,
    progress: metrics.total_cards ? round(metrics.reviewed_count / metrics.total_cards, 4) : 0,
    last_activity_at: metrics.last_studied_at,
    evidence_tier: provenance.evidence_tier,
    rights_status: provenance.rights_status,
    warning_count: deckWarnings(deck).length,
  };
}

function targetProvenanceForPersonal(deck) {
  if (isPlainObject(deck.provenance)) return normalizeStoredProvenance(deck.provenance);
  const source = isPlainObject(deck.source) ? deck.source : {};
  if (source.kind === "agent_authored" && !isPlainObject(source.provenance)) {
    return normalizeStoredProvenance({});
  }
  const catalogLike = {
    provenance: source.provenance,
    evidenceTier: source.reviewStatus,
    rightsStatus: source.license?.name ?? source.license,
    reviewStatus: source.reviewStatus,
  };
  return targetProvenanceFromCatalog(catalogLike);
}

function normalizeStoredProvenance(raw) {
  return {
    origin: String(raw.origin ?? "unclassified"),
    source_outline: String(raw.source_outline ?? ""),
    source_records: Array.isArray(raw.source_records)
      ? raw.source_records.map((record, index) => ({
          source_id: String(record.source_id ?? `source-${index + 1}`),
          title: String(record.title ?? "Untitled source"),
          uri: String(record.uri ?? ""),
          locator: String(record.locator ?? ""),
          license: String(record.license ?? ""),
        }))
      : [],
    evidence_tier: String(raw.evidence_tier ?? "unclassified"),
    rights_status: String(raw.rights_status ?? "unclassified"),
    notes: String(raw.notes ?? ""),
  };
}

function externalPrerequisitesForCatalog(deck) {
  const localIds = new Set(deck.cards.map((card) => card.id));
  return deck.cards.flatMap((card) =>
    (card.prerequisiteIds ?? []).filter((id) => !localIds.has(id)),
  );
}

function externalPrerequisitesForPersonal(deck) {
  const localIds = new Set(deck.cardOrder.filter((id) => deck.cards[id]));
  return deck.cardOrder.flatMap((id) =>
    (deck.cards[id]?.prerequisiteIds ?? []).filter((prerequisiteId) => !localIds.has(prerequisiteId)),
  );
}

function qualifiedCardId(deck, cardId) {
  const value = String(cardId);
  if (deck.libraryBase) return value;
  return value.startsWith(`${deck.id}.`) ? value : `${deck.id}.${value}`;
}

function qualifyPrerequisite(deck, prerequisiteId) {
  const value = String(prerequisiteId);
  if (deck.libraryBase) return value;
  if (value.includes(".")) return value;
  return qualifiedCardId(deck, value);
}

function richRubricItem(item, index, prefix) {
  if (typeof item === "string") return { rubric_item_id: `${prefix}-${index + 1}`, text: item };
  return {
    rubric_item_id: String(item.rubricItemId ?? item.rubric_item_id ?? item.id ?? `${prefix}-${index + 1}`),
    text: String(item.text ?? ""),
  };
}

function agentFacingCard(deck, card, at) {
  const required = card.requiredConcepts?.length
    ? card.requiredConcepts
    : (card.acceptedPoints ?? []).map((text, index) => ({ rubricItemId: `required-${index + 1}`, text }));
  const prerequisiteIds = [
    ...new Set([
      ...(card.prerequisiteIds ?? []),
      ...prerequisitesForCard(deck, card.id),
    ]),
  ].filter((id) => isDeckLocalStudyPrerequisite(deck, id));
  return {
    card_id: qualifiedCardId(deck, card.id),
    card_revision: Number(card.contentRevision ?? 1),
    term: card.term,
    prompt: card.prompt ?? null,
    definition_md: card.definition,
    aliases: jsonClone(card.aliases ?? []),
    required_concepts: required.map((item, index) => richRubricItem(item, index, "required")),
    accepted_variants: jsonClone(card.acceptedVariants ?? []),
    major_error_concepts: (card.majorErrorConcepts ?? []).map((item, index) => richRubricItem(item, index, "major-error")),
    prerequisite_ids: prerequisiteIds.map((id) => qualifyPrerequisite(deck, id)),
    tags: jsonClone(card.tags ?? []),
    source_refs: jsonClone(card.sourceRefs ?? []).map((ref) => typeof ref === "string" ? ref : String(ref.source_id ?? "")),
    difficulty_hint: card.difficultyHint ?? null,
    module_ids: jsonClone(card.moduleIds ?? []),
    provenance: card.provenance ? normalizeStoredProvenance(card.provenance) : null,
    archived: Boolean(card.archived),
    scheduling: targetScheduleSummary(card.review, at),
  };
}

function prerequisitesForCard(deck, cardId) {
  return deck.edges
    .filter((edge) => edge.dependentCardId === cardId)
    .map((edge) => edge.prerequisiteCardId);
}

function targetCompleteDeck(deck, scope, at, catalogDecks) {
  const cards = scope === "library"
    ? deck.cards.map((card) => catalogCardForRead(deck, card, at))
    : deck.cardOrder.map((id) => deck.cards[id]).filter(Boolean).map((card) => agentFacingCard(deck, card, at));
  const provenance = scope === "library" ? targetProvenanceFromCatalog(deck) : targetProvenanceForPersonal(deck);
  const storedDeck = {
    deck_id: deck.id,
    deck_revision: scope === "personal" ? deck.revision : 0,
    content_revision: scope === "personal" ? Number(deck.contentRevision ?? deck.revision) : 0,
    version: scope === "library" ? String(deck.version) : "personal",
    title: deck.title,
    description: deck.description,
    subject: deck.subject,
    domain: deck.domain ?? deck.subject,
    level: deck.level,
    tags: jsonClone(deck.tags ?? []),
    modules: jsonClone(deck.modules ?? []),
    provenance,
    archived: scope === "personal" ? Boolean(deck.archived) : false,
    cards,
  };
  return {
    complete: true,
    scope,
    deck: storedDeck,
    card_count: cards.length,
    archived_card_count: cards.filter((card) => card.archived).length,
    prerequisite_edge_count: scope === "library" ? deck.edges.length : deck.edges.length,
    cross_deck_edge_count: 0,
    external_prerequisite_deck_ids: [],
    content_digest: targetDeckDigest(storedDeck),
  };
}

function catalogCardForRead(deck, card, at) {
  const personalLike = {
    ...jsonClone(card),
    review: newReviewState(at.toISOString()),
    archived: false,
    contentRevision: Number(card.contentRevision ?? 1),
  };
  return agentFacingCard(deck, personalLike, at);
}

function targetDeckDigest(value) {
  return `fnv1a-${stableHash(value)}`;
}

function targetScheduleSummary(review, at) {
  return {
    state: Number(review?.repetitions ?? 0) > 0 ? "review" : "new",
    repetitions: Number(review?.repetitions ?? 0),
    due_at: Number(review?.repetitions ?? 0) > 0 ? String(review.dueAt) : null,
    last_reviewed_at: review?.lastReviewedAt ? String(review.lastReviewedAt) : null,
    last_rating: review?.lastRating ? String(review.lastRating) : null,
    learnedness: deriveLearnedness(review ?? {}),
    recency: deriveFreshness(review ?? {}, at),
  };
}

function targetSessionSummary(session, deck) {
  const queueProgress = sessionQueueProgress(session);
  return {
    session_id: session.id,
    deck_id: deck.id,
    deck_title: deck.title,
    status: session.status,
    phase: session.phase,
    session_revision: session.revision,
    total: session.queue.length,
    reviewed: session.reviewsApplied,
    remaining: Math.max(0, session.queue.length - session.cursor),
    due_segment_total: queueProgress.dueSegmentTotal,
    queue_phase: queueProgress.phase,
    queue_phase_position: queueProgress.position,
    current_card_id: session.currentCardId ? qualifiedCardId(deck, session.currentCardId) : null,
    started_at: session.startedAt,
    updated_at: session.updatedAt,
    finished_at: session.finishedAt,
  };
}

function targetSessionSummaryData(session) {
  const ratings = { again: 0, hard: 0, good: 0, easy: 0 };
  for (const event of session.history ?? []) {
    if (event.transition === "grade_submitted" && Object.hasOwn(ratings, event.rating)) {
      ratings[event.rating] += 1;
    }
  }
  return {
    reviewed_count: session.reviewsApplied,
    rating_counts: ratings,
    started_at: session.startedAt,
    finished_at: session.finishedAt,
  };
}

function availableNewCount(deck, at, state, catalogDecks) {
  return buildStudyQueue(deck, "new", Math.max(1, deck.cardOrder.length), [], at, state, catalogDecks).length;
}

function latestPausedStudySession(state, deckId) {
  return Object.values(state.sessions)
    .filter(session => session.deckId === deckId && session.status === "paused")
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))
      || String(right.id).localeCompare(String(left.id)))[0] ?? null;
}

function availabilityCursorOffset(raw, revision, deckId) {
  if (raw === undefined) return 0;
  // Legacy IDs permit 257 ASCII characters, including ':' which URI-encodes
  // threefold. Allow the emitted ID plus revision/offset and version prefix.
  const value = requiredString(raw, "blocked_cursor", 1_024);
  if (value.startsWith("availability-v1:")) {
    fail("STALE_AVAILABILITY_CURSOR", "Study eligibility policy changed; reread this deck's availability");
  }
  const match = /^availability-v2:([^:]+):(\d+):([^:]+):(\d+)$/.exec(value);
  if (!match) fail("INVALID_CURSOR", "Invalid blocked-card cursor");
  let cursorDeckId;
  try { cursorDeckId = decodeURIComponent(match[3]); }
  catch { fail("INVALID_CURSOR", "Invalid blocked-card cursor identity"); }
  const cursorPolicy = match[1];
  const cursorRevision = Number(match[2]);
  const offset = Number(match[4]);
  if (cursorDeckId !== deckId || !Number.isSafeInteger(offset) || !Number.isSafeInteger(cursorRevision)) {
    fail("INVALID_CURSOR", "Blocked-card cursor does not match this request");
  }
  if (cursorPolicy !== STUDY_ELIGIBILITY_POLICY_VERSION) {
    fail("STALE_AVAILABILITY_CURSOR", "Study eligibility policy changed; reread this deck's availability");
  }
  if (cursorRevision !== revision) {
    fail("STALE_AVAILABILITY_CURSOR", "Learner state changed; reread this deck's availability");
  }
  return offset;
}

function deckWarnings(deck) {
  const warnings = [];
  const active = deck.cardOrder.filter((id) => deck.cards[id] && !deck.cards[id].archived);
  if (active.length > 1 && deck.edges.length === 0) {
    warnings.push(diagnostic("NO_PREREQUISITE_STRUCTURE", "deck.cards", "The deck has multiple cards but no internal prerequisite edges."));
  }
  if (active.some((id) => !deck.cards[id].requiredConcepts?.length && !deck.cards[id].acceptedPoints?.length)) {
    warnings.push(diagnostic("SPARSE_REQUIRED_RUBRIC", "deck.cards", "One or more cards have no explicit required concepts."));
  }
  if (active.length > 50) {
    warnings.push(diagnostic("LARGE_DECK", "deck.cards", "This deck is larger than the normalized v2 build envelope."));
  }
  return warnings;
}

function validationResult(analysis, schedulingImpact, { sourceRightsReview = false } = {}) {
  return {
    status: analysis.blockers.length
      ? "blocked"
      : analysis.warnings.length
        ? "ready_with_warnings"
        : "ready",
    ingestible: analysis.blockers.length === 0,
    content_digest: analysis.contentDigest,
    blockers: analysis.blockers,
    warnings: analysis.warnings,
    agent_review_required: semanticReviewObligations({ sourceRightsReview }),
    scheduling_impact: schedulingImpact,
  };
}

function analyzeNormalizedDeck(raw, at) {
  const blockers = [];
  if (!isPlainObject(raw)) {
    return {
      candidate: null,
      contentDigest: targetDeckDigest(raw ?? null),
      blockers: [diagnostic("INVALID_NORMALIZED_DECK", "deck", "Deck must be an object.")],
      warnings: [],
    };
  }
  const contentDigest = targetDeckDigest(raw);
  try {
    assertClosedFields(raw, ["schema_version", "deck_id", "title", "cards", "edges"], "deck");
    if (raw.schema_version !== "normalized-definition-deck.v2") {
      blockers.push(diagnostic("UNSUPPORTED_DECK_SCHEMA", "deck.schema_version", "Expected normalized-definition-deck.v2."));
    }
    const deckId = requireNormalizedLocalId(raw.deck_id, "deck.deck_id");
    const title = requiredString(raw.title, "deck.title", 200);
    if (!Array.isArray(raw.cards) || raw.cards.length < 1 || raw.cards.length > 50) {
      blockers.push(diagnostic("INVALID_CARD_COUNT", "deck.cards", "Deck must contain 1 to 50 cards."));
    }
    if (!Array.isArray(raw.edges) || raw.edges.length > 250) {
      blockers.push(diagnostic("INVALID_EDGE_COUNT", "deck.edges", "Deck edges must be an array with at most 250 entries."));
    }
    const cards = (Array.isArray(raw.cards) ? raw.cards : []).map((card, index) => normalizedV2Card(deckId, card, at, index));
    const cardIds = new Set(cards.map((card) => card.id));
    if (cardIds.size !== cards.length) blockers.push(diagnostic("DUPLICATE_CARD_ID", "deck.cards", "Card IDs must be unique."));
    const normalizedTerms = cards.map((card) => card.term.trim().toLocaleLowerCase());
    if (new Set(normalizedTerms).size !== normalizedTerms.length) {
      blockers.push(diagnostic("DUPLICATE_TERM", "deck.cards", "Card terms must be unique without regard to case."));
    }
    const localCardIds = new Set(cards.map((card) => card.id.slice(deckId.length + 1)));
    const edgePairs = new Set();
    for (const [index, rawEdge] of (Array.isArray(raw.edges) ? raw.edges : []).entries()) {
      if (!isPlainObject(rawEdge)) fail("INVALID_ARGUMENT", `deck.edges[${index}] must be an object`);
      assertClosedFields(rawEdge, ["from", "to"], `deck.edges[${index}]`);
      const from = requireNormalizedLocalId(rawEdge.from, `deck.edges[${index}].from`);
      const to = requireNormalizedLocalId(rawEdge.to, `deck.edges[${index}].to`);
      const pair = `${from}\u0000${to}`;
      if (edgePairs.has(pair)) blockers.push(diagnostic("DUPLICATE_EDGE", `deck.edges[${index}]`, `Edge ${from} -> ${to} is repeated.`));
      edgePairs.add(pair);
      if (from === to) blockers.push(diagnostic("SELF_PREREQUISITE", `deck.edges[${index}]`, "An edge cannot connect a card to itself."));
      if (!localCardIds.has(from)) blockers.push(diagnostic("UNRESOLVED_EDGE_ENDPOINT", `deck.edges[${index}].from`, `Unknown card ${from}.`));
      if (!localCardIds.has(to)) blockers.push(diagnostic("UNRESOLVED_EDGE_ENDPOINT", `deck.edges[${index}].to`, `Unknown card ${to}.`));
      const dependent = cards.find((card) => card.id === `${deckId}.${to}`);
      if (dependent && localCardIds.has(from) && from !== to && !dependent.prerequisiteIds.includes(`${deckId}.${from}`)) {
        dependent.prerequisiteIds.push(`${deckId}.${from}`);
      }
    }
    const candidate = {
      id: deckId,
      title,
      description: "",
      subject: "General",
      domain: "General",
      level: "Unspecified",
      tags: [],
      modules: [],
      provenance: null,
      cards: Object.fromEntries(cards.map((card) => [card.id, card])),
      cardOrder: cards.map((card) => card.id),
      edges: [],
      source: { kind: "agent_authored", normalizedSchema: "normalized-definition-deck.v2" },
      archived: false,
      revision: 0,
      contentRevision: 1,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
    };
    rebuildInternalEdges(candidate);
    try {
      assertAcyclic(new Set(candidate.cardOrder), candidate.edges);
    } catch (error) {
      blockers.push(diagnostic(error.code ?? "DECK_CYCLE", "deck.cards", error.message));
    }
    const warnings = deckWarnings(candidate);
    if (cards.some((card) => card.definition.length > 2_000)) warnings.push(diagnostic("BROAD_DEFINITION", "deck.cards", "One or more definitions are unusually long for atomic recall."));
    if (cards.some((card) => card.requiredConcepts.length > 8)) warnings.push(diagnostic("MANY_CRITERIA", "deck.cards", "One or more cards have more than eight answer criteria."));
    return { candidate, contentDigest, blockers, warnings };
  } catch (error) {
    blockers.push(diagnostic(error.code ?? "INVALID_NORMALIZED_DECK", "deck", error.message));
    return { candidate: null, contentDigest, blockers, warnings: [] };
  }
}

function normalizedV2Card(deckId, raw, at, index) {
  if (!isPlainObject(raw)) fail("INVALID_ARGUMENT", `deck.cards[${index}] must be an object`);
  assertClosedFields(raw, ["id", "term", "definition", "criteria", "tags"], `deck.cards[${index}]`);
  const localId = requireNormalizedLocalId(raw.id, `deck.cards[${index}].id`);
  if (!Array.isArray(raw.criteria) || raw.criteria.length < 1 || raw.criteria.length > 12) {
    fail("INVALID_ARGUMENT", `deck.cards[${index}].criteria must contain 1 to 12 entries`);
  }
  const criteria = raw.criteria.map((criterion, criterionIndex) =>
    boundedNonblankString(criterion, `deck.cards[${index}].criteria[${criterionIndex}]`, 500));
  if (new Set(criteria).size !== criteria.length) fail("INVALID_ARGUMENT", `deck.cards[${index}].criteria must be unique`);
  const tags = optionalBoundedUniqueStrings(raw.tags, `deck.cards[${index}].tags`, 5, 100);
  return {
    id: `${deckId}.${localId}`,
    term: requiredString(raw.term, `deck.cards[${index}].term`, 300),
    definition: boundedNonblankString(raw.definition, `deck.cards[${index}].definition`, 8_000),
    prompt: null,
    aliases: [],
    acceptedPoints: [...criteria],
    requiredConcepts: criteria.map((text, criterionIndex) => ({ rubricItemId: `required-${criterionIndex + 1}`, text })),
    acceptedVariants: [],
    majorErrorConcepts: [],
    confusions: [],
    misconceptions: [],
    tags,
    sourceRefs: [],
    sourceRefRecords: [],
    prerequisiteIds: [],
    moduleIds: [],
    difficultyHint: null,
    provenance: null,
    archived: false,
    contentRevision: 1,
    review: newReviewState(at.toISOString()),
    reviewHistory: [],
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
  };
}

function prepareReplacementAnalysis(existing, analysis, raw) {
  const candidate = jsonClone(analysis.candidate);
  if (existing.libraryBase) {
    // v2 IDs are deck-local, but an installed immutable Library card retains
    // its exact source ID. A read-back source ID explicitly names that same
    // card here; never perform this prefix interpretation in runtime lookup.
    candidate.libraryBase = jsonClone(existing.libraryBase);
    const identities = new Map(candidate.cardOrder.map((id, index) => [
      id, hasOwn(existing.cards, raw.cards[index].id) ? raw.cards[index].id : id,
    ]));
    if (new Set(identities.values()).size !== identities.size) {
      fail("CARD_IDENTITY_COLLISION", "Replacement cards resolve to the same canonical Library identity");
    }
    candidate.cards = Object.fromEntries(candidate.cardOrder.map((id) => {
      const card = candidate.cards[id];
      card.id = identities.get(id);
      card.prerequisiteIds = card.prerequisiteIds.map(parent => identities.get(parent) ?? parent);
      return [card.id, card];
    }));
    candidate.cardOrder = candidate.cardOrder.map(id => identities.get(id));
    candidate.edges = candidate.edges.map(edge => ({
      ...edge,
      prerequisiteCardId: identities.get(edge.prerequisiteCardId) ?? edge.prerequisiteCardId,
      dependentCardId: identities.get(edge.dependentCardId) ?? edge.dependentCardId,
    }));
  }
  // Lean v2 replaces the card set and its internal edges. Fields that v2 cannot
  // express remain editable through update_deck/update_cards, not erased here.
  for (const key of ["description", "subject", "domain", "level", "tags", "modules", "provenance"]) {
    if (hasOwn(existing, key)) candidate[key] = jsonClone(existing[key]);
  }
  candidate.source = { ...jsonClone(existing.source ?? {}), ...candidate.source };
  const rawCards = new Map(candidate.cardOrder.map((id, index) => [id, raw.cards[index]]));
  for (const id of candidate.cardOrder) {
    const prior = existing.cards[id];
    if (!prior) continue;
    const card = candidate.cards[id];
    for (const key of [
      "prompt", "aliases", "acceptedVariants", "majorErrorConcepts", "confusions",
      "misconceptions", "sourceRefs", "sourceRefRecords", "difficultyHint", "moduleIds", "provenance",
    ]) {
      if (hasOwn(prior, key)) card[key] = jsonClone(prior[key]);
    }
    if (!hasOwn(rawCards.get(id), "tags")) card.tags = jsonClone(prior.tags ?? []);
    if (prior.requiredConcepts?.length
      && stableStringify(prior.requiredConcepts.map((item) => item.text))
        === stableStringify(card.requiredConcepts.map((item) => item.text))) {
      card.requiredConcepts = jsonClone(prior.requiredConcepts);
    }
    const external = (prior.prerequisiteIds ?? []).filter((prerequisiteId) =>
      !findSubmittedCardId(existing, prerequisiteId)
        && (existing.libraryBase || (!prerequisiteId.startsWith(`${existing.id}.`)
          && prerequisiteId.includes("."))));
    card.prerequisiteIds = [...new Set([...card.prerequisiteIds, ...external])];
    if (existing.libraryBase) {
      const required = new Set(card.prerequisiteIds);
      card.prerequisiteIds = [...new Set([
        ...(prior.prerequisiteIds ?? []).filter(id => required.has(id)),
        ...card.prerequisiteIds,
      ])];
    }
  }
  const warnings = [...analysis.warnings];
  for (const warning of deckWarnings(candidate)) {
    if (!warnings.some((item) => item.code === warning.code && item.path === warning.path)) warnings.push(warning);
  }
  return { ...analysis, candidate, warnings };
}

function replacementSchedulingImpact(existing, candidate) {
  const newIds = candidate.cardOrder.filter((id) => !existing.cards[id]);
  const archivedIds = existing.cardOrder.filter((id) => !candidate.cards[id]);
  const preserved = [];
  const reset = [];
  for (const id of candidate.cardOrder) {
    if (!existing.cards[id]) continue;
    if (materialCardFingerprint(existing.cards[id]) === materialCardFingerprint(candidate.cards[id])) preserved.push(id);
    else reset.push(id);
  }
  return {
    preserved_card_ids: preserved,
    reset_card_ids: reset,
    new_card_ids: newIds,
    archived_card_ids: archivedIds,
  };
}

function canonicalizedPersonalDeckCardIdentities(sourceDeck) {
  assertPersonalCardIdentities(sourceDeck);
  const deck = jsonClone(sourceDeck);
  const internalToCanonical = new Map();
  const canonicalToInternal = new Map();

  for (const internalId of deck.cardOrder) {
    const card = deck.cards[internalId];
    if (!card) continue;
    const canonicalId = qualifiedCardId(deck, internalId);
    const collision = canonicalToInternal.get(canonicalId);
    if (collision && collision !== internalId) {
      fail(
        "CARD_IDENTITY_COLLISION",
        `Cards ${collision} and ${internalId} resolve to the same external identity ${canonicalId}`,
      );
    }
    internalToCanonical.set(internalId, canonicalId);
    canonicalToInternal.set(canonicalId, internalId);
  }

  const canonicalEndpoint = (rawId) => {
    const id = String(rawId);
    if (internalToCanonical.has(id)) return internalToCanonical.get(id);
    if (canonicalToInternal.has(id)) return id;
    if (deck.libraryBase) return id;
    const prefix = `${deck.id}.`;
    if (id.startsWith(prefix)) {
      const localId = id.slice(prefix.length);
      if (internalToCanonical.has(localId)) return internalToCanonical.get(localId);
    }
    return id;
  };

  const prerequisitesByCard = new Map();
  for (const [internalId, canonicalId] of internalToCanonical) {
    prerequisitesByCard.set(
      canonicalId,
      (deck.cards[internalId].prerequisiteIds ?? []).map(canonicalEndpoint),
    );
  }
  for (const edge of deck.edges ?? []) {
    const dependentId = canonicalEndpoint(edge.dependentCardId);
    if (!prerequisitesByCard.has(dependentId)) continue;
    prerequisitesByCard.get(dependentId).push(canonicalEndpoint(edge.prerequisiteCardId));
  }

  const cards = {};
  const cardOrder = [];
  for (const [internalId, canonicalId] of internalToCanonical) {
    const card = jsonClone(deck.cards[internalId]);
    card.id = canonicalId;
    card.prerequisiteIds = [...new Set(prerequisitesByCard.get(canonicalId) ?? [])];
    cards[canonicalId] = card;
    cardOrder.push(canonicalId);
  }
  deck.cards = cards;
  deck.cardOrder = cardOrder;
  deck.edges = (deck.edges ?? []).map((edge) => ({
    ...edge,
    prerequisiteCardId: canonicalEndpoint(edge.prerequisiteCardId),
    dependentCardId: canonicalEndpoint(edge.dependentCardId),
  }));
  // Validate the completed add/replace result, not this intermediate identity
  // migration: a corrected candidate may repair a legacy graph defect.
  return deck;
}

function mergeReplacementDeck(existing, candidate, committedAt) {
  const schedulingImpact = replacementSchedulingImpact(existing, candidate);
  const deck = jsonClone(candidate);
  if (existing.libraryBase) deck.libraryBase = jsonClone(existing.libraryBase);
  const persistenceBase = catalogPersistenceReference(existing);
  if (persistenceBase) deck.persistenceCatalogBase = jsonClone(persistenceBase);
  if (deckRequiresSourceRightsReview(existing)) {
    deck.provenance = jsonClone(existing.provenance ?? targetProvenanceForPersonal(existing));
    deck.source = {
      ...deck.source,
      rightsReviewRequired: true,
      priorSourceKind: String(existing.source?.kind ?? "source_bearing"),
    };
  }
  for (const id of deck.cardOrder) {
    const prior = existing.cards[id];
    if (!prior) continue;
    const preserve = schedulingImpact.preserved_card_ids.includes(id);
    deck.cards[id].review = preserve ? jsonClone(prior.review) : newReviewState(committedAt);
    deck.cards[id].reviewHistory = jsonClone(prior.reviewHistory ?? []);
    deck.cards[id].contentRevision = Number(prior.contentRevision ?? 1) + (preserve ? 0 : 1);
    deck.cards[id].createdAt = prior.createdAt;
    deck.cards[id].updatedAt = committedAt;
  }
  for (const id of schedulingImpact.archived_card_ids) {
    const archived = jsonClone(existing.cards[id]);
    archived.archived = true;
    archived.updatedAt = committedAt;
    deck.cards[id] = archived;
    deck.cardOrder.push(id);
  }
  deck.contentRevision = Number(existing.contentRevision ?? existing.revision) + 1;
  rebuildInternalEdges(deck);
  return {
    deck,
    schedulingImpact,
    diff: {
      added_card_ids: schedulingImpact.new_card_ids,
      updated_card_ids: schedulingImpact.reset_card_ids,
      unchanged_card_ids: schedulingImpact.preserved_card_ids,
      archived_card_ids: schedulingImpact.archived_card_ids,
    },
  };
}

function materialCardFingerprint(card) {
  const requiredConcepts = card.requiredConcepts?.length
    ? card.requiredConcepts
    : (card.acceptedPoints ?? []).map((text, index) => ({
        rubricItemId: `required-${index + 1}`,
        text,
      }));
  return stableHash({
    term: card.term,
    prompt: card.prompt ?? null,
    definition: card.definition,
    aliases: card.aliases ?? [],
    requiredConcepts: requiredConcepts.map((item) =>
      typeof item === "string" ? item : String(item.text ?? "")),
    acceptedVariants: card.acceptedVariants ?? [],
    majorErrorConcepts: (card.majorErrorConcepts ?? []).map((item) =>
      typeof item === "string" ? item : String(item.text ?? "")),
  });
}

function assertNoOpenSession(state, deckId) {
  const open = Object.values(state.sessions).find(
    (session) => session.deckId === deckId && (session.status === "active" || session.status === "paused"),
  );
  if (open) fail("DECK_IN_ACTIVE_SESSION", "Finish the open study session before changing this deck", { session_id: open.id });
}

function candidateCardToPersonal(deckId, raw, at, path) {
  if (!isPlainObject(raw)) fail("INVALID_ARGUMENT", `${path} must be an object`);
  const id = requireId(raw.card_id, `${path}.card_id`);
  if (!id.startsWith(`${deckId}.`)) fail("CARD_PREFIX_MISMATCH", `${path}.card_id must start with ${deckId}.`);
  const required = normalizeRubricItems(raw.required_concepts, `${path}.required_concepts`);
  return {
    id,
    term: requiredString(raw.term, `${path}.term`, 300),
    definition: boundedNonblankString(raw.definition_md, `${path}.definition_md`, 8_000),
    prompt: raw.prompt === null ? null : optionalString(raw.prompt, `${path}.prompt`, 1_000) ?? null,
    aliases: optionalStringArray(raw.aliases, `${path}.aliases`, 20),
    acceptedPoints: required.map((item) => item.text),
    requiredConcepts: required,
    acceptedVariants: optionalStringArray(raw.accepted_variants, `${path}.accepted_variants`, 30),
    majorErrorConcepts: normalizeRubricItems(raw.major_error_concepts, `${path}.major_error_concepts`),
    confusions: [],
    misconceptions: [],
    tags: optionalStringArray(raw.tags, `${path}.tags`, 50),
    sourceRefs: optionalStringArray(raw.source_refs, `${path}.source_refs`, 50),
    prerequisiteIds: optionalIdArray(raw.prerequisite_ids, `${path}.prerequisite_ids`, 50),
    moduleIds: optionalStringArray(raw.module_ids, `${path}.module_ids`, 50),
    difficultyHint: raw.difficulty_hint === null ? null : optionalString(raw.difficulty_hint, `${path}.difficulty_hint`, 100) ?? null,
    provenance: raw.provenance === null ? null : jsonClone(raw.provenance ?? null),
    archived: Boolean(raw.archived),
    contentRevision: 1,
    review: newReviewState(at),
    reviewHistory: [],
    createdAt: at,
    updatedAt: at,
  };
}

function mergeStoredPrerequisiteEdges(deck) {
  for (const id of deck.cardOrder) {
    const card = hasOwn(deck.cards, id) ? deck.cards[id] : null;
    if (!card) fail("INVALID_CARD_ID", `Card order references missing card ${id}`);
    card.prerequisiteIds = (card.prerequisiteIds ?? []).map((prerequisiteId) =>
      findSubmittedCardId(deck, prerequisiteId) ?? prerequisiteId);
  }
  for (const edge of deck.edges) {
    const dependentId = findSubmittedCardId(deck, edge.dependentCardId);
    if (!dependentId) fail("INVALID_EDGE", `Edge ${edge.id} references a missing dependent card`);
    const prerequisiteId = findSubmittedCardId(deck, edge.prerequisiteCardId) ?? edge.prerequisiteCardId;
    const prerequisites = deck.cards[dependentId].prerequisiteIds;
    if (!prerequisites.includes(prerequisiteId)) prerequisites.push(prerequisiteId);
  }
}

function assertPersonalCardIdentities(deck) {
  const internalIds = new Set();
  const externalIds = new Set();
  for (const id of deck.cardOrder) {
    const card = hasOwn(deck.cards, id) ? deck.cards[id] : null;
    if (!card || card.id !== id) fail("INVALID_CARD_ID", `Card order and stored identity disagree for ${id}`);
    if (internalIds.has(id)) fail("DUPLICATE_CARD_ID", `Card order repeats ${id}`);
    internalIds.add(id);
    const externalId = qualifiedCardId(deck, id);
    if (externalIds.has(externalId)) fail("CARD_IDENTITY_COLLISION", `Multiple cards resolve to ${externalId}`);
    externalIds.add(externalId);
  }
  if (Object.keys(deck.cards).some((id) => !internalIds.has(id))) {
    fail("INVALID_CARD_ID", "Stored cards are missing from card order");
  }
}

function assertPersonalCardStructure(deck) {
  assertPersonalCardIdentities(deck);
  requiredString(deck.title, "deck.title", 200);
  const terms = new Set();
  let activeCount = 0;
  for (const id of deck.cardOrder) {
    const card = deck.cards[id];
    requiredString(card.term, `cards.${id}.term`, 300);
    requiredString(card.definition, `cards.${id}.definition`, 8_000);
    if (card.archived) continue;
    activeCount += 1;
    const term = card.term.trim().toLowerCase();
    if (terms.has(term)) fail("DUPLICATE_TERM", `Active cards repeat term ${card.term}`);
    terms.add(term);
    const required = card.requiredConcepts?.length
      ? card.requiredConcepts
      : (card.acceptedPoints ?? []).map((text, index) => ({ rubricItemId: `required-${index + 1}`, text }));
    const criteria = [
      ...required.map((item, index) => richRubricItem(item, index, "required")),
      ...(card.majorErrorConcepts ?? []).map((item, index) => richRubricItem(item, index, "major-error")),
    ];
    const criterionIds = new Set();
    for (const item of criteria) {
      const criterionId = requireId(item.rubric_item_id, `cards.${id}.criterion_id`);
      boundedNonblankString(item.text, `cards.${id}.criteria.${criterionId}`, 1_000);
      if (criterionIds.has(criterionId)) fail("DUPLICATE_CRITERION_ID", `Card ${id} repeats grading criterion ${criterionId}`);
      criterionIds.add(criterionId);
    }
  }
  if (!activeCount && !deck.archived) fail("EMPTY_DECK", "A deck must contain at least one active card");
}

function resolvePrerequisiteId(deck, rawId) {
  const id = requireId(rawId, "prerequisite_id");
  const internalId = findSubmittedCardId(deck, id);
  if (internalId) return internalId;
  if (deck.libraryBase) return id;
  if (!id.includes(".") || id.startsWith(`${deck.id}.`)) {
    fail("UNRESOLVED_PREREQUISITE", `Unknown prerequisite ${id} in deck ${deck.id}`);
  }
  return id;
}

function rebuildInternalEdges(deck) {
  assertPersonalCardStructure(deck);
  const allIds = new Set(deck.cardOrder);
  const activeIds = new Set(deck.cardOrder.filter((id) => deck.cards[id] && !deck.cards[id].archived));
  const edges = [];
  for (const id of deck.cardOrder) {
    const card = deck.cards[id];
    if (!card || card.archived) continue;
    card.prerequisiteIds = (card.prerequisiteIds ?? []).map((rawId) => resolvePrerequisiteId(deck, rawId));
    const seen = new Set();
    for (const prerequisite of card.prerequisiteIds ?? []) {
      if (seen.has(prerequisite)) fail("DUPLICATE_PREREQUISITE", `Card ${id} repeats prerequisite ${prerequisite}`);
      seen.add(prerequisite);
      if (prerequisite === id) fail("SELF_PREREQUISITE", `Card ${id} cannot require itself`);
      if (allIds.has(prerequisite)) {
        if (!activeIds.has(prerequisite)) fail("ARCHIVED_PREREQUISITE", `Active card ${id} depends on archived card ${prerequisite}`);
        edges.push({
          id: `edge:${prerequisite}:${id}`,
          prerequisiteCardId: prerequisite,
          dependentCardId: id,
        });
      }
    }
  }
  deck.edges = dedupeEdges(edges);
  validateEdges(activeIds, deck.edges);
  assertAcyclic(activeIds, deck.edges);
}

function applyCandidateCardPatch(card, patch, at, path) {
  const allowed = new Set([
    "term", "prompt", "definition_md", "aliases", "required_concepts", "accepted_variants",
    "major_error_concepts", "prerequisite_ids", "tags", "source_refs", "difficulty_hint",
    "module_ids", "provenance", "archived",
  ]);
  const keys = Object.keys(patch);
  if (!keys.length) fail("INVALID_ARGUMENT", `${path} must change at least one field`);
  if (keys.some((key) => !allowed.has(key))) fail("INVALID_ARGUMENT", `${path} contains an unsupported field`);
  const mapping = {
    term: "term",
    prompt: "prompt",
    definition_md: "definition",
    aliases: "aliases",
    required_concepts: "requiredConcepts",
    accepted_variants: "acceptedVariants",
    major_error_concepts: "majorErrorConcepts",
    prerequisite_ids: "prerequisiteIds",
    tags: "tags",
    source_refs: "sourceRefs",
    difficulty_hint: "difficultyHint",
    module_ids: "moduleIds",
    provenance: "provenance",
    archived: "archived",
  };
  const changed = [];
  for (const key of keys) {
    let value = patch[key];
    if (key === "term") value = requiredString(value, `${path}.term`, 300);
    else if (key === "definition_md") value = boundedNonblankString(value, `${path}.definition_md`, 8_000);
    else if (key === "prompt") value = value === null ? null : requiredString(value, `${path}.prompt`, 1_000);
    else if (key === "required_concepts" || key === "major_error_concepts") value = normalizeRubricItems(value, `${path}.${key}`);
    else if (["aliases", "accepted_variants", "prerequisite_ids", "tags", "source_refs", "module_ids"].includes(key)) value = optionalStringArray(value, `${path}.${key}`, 50);
    else if (key === "difficulty_hint") value = value === null ? null : requiredString(value, `${path}.difficulty_hint`, 100);
    else if (key === "archived") value = requiredBoolean(value, `${path}.archived`);
    else value = value === null ? null : jsonClone(value);
    const internal = mapping[key];
    if (stableStringify(card[internal]) !== stableStringify(value)) {
      card[internal] = jsonClone(value);
      if (key === "required_concepts") card.acceptedPoints = value.map((item) => item.text);
      changed.push(key);
    }
  }
  card.updatedAt = at;
  return changed;
}

function normalizeRubricEvidence(value) {
  if (!Array.isArray(value) || value.length > 40) fail("INVALID_ARGUMENT", "rubric_evidence must be an array with at most 40 entries");
  const ids = new Set();
  return value.map((raw, index) => {
    if (!isPlainObject(raw)) fail("INVALID_ARGUMENT", `rubric_evidence[${index}] must be an object`);
    const rubricItemId = requireId(raw.rubric_item_id, `rubric_evidence[${index}].rubric_item_id`);
    if (ids.has(rubricItemId)) fail("DUPLICATE_RUBRIC_EVIDENCE", `rubric_evidence repeats ${rubricItemId}`);
    ids.add(rubricItemId);
    return {
      rubric_item_id: rubricItemId,
      status: enumValue(raw.status, `rubric_evidence[${index}].status`, ["met", "partial", "missed", "contradicted"]),
      note: boundedNonblankString(raw.note, `rubric_evidence[${index}].note`, 1_000),
    };
  });
}

function assertRubricEvidenceBelongsToCard(card, evidence) {
  const required = card.requiredConcepts?.length
    ? card.requiredConcepts
    : (card.acceptedPoints ?? []).map((text, index) => ({ rubricItemId: `required-${index + 1}`, text }));
  const allowedIds = new Set([
    ...required.map((item, index) => richRubricItem(item, index, "required").rubric_item_id),
    ...(card.majorErrorConcepts ?? []).map((item, index) => richRubricItem(item, index, "major-error").rubric_item_id),
  ]);
  for (const [index, item] of evidence.entries()) {
    if (!allowedIds.has(item.rubric_item_id)) {
      fail(
        "RUBRIC_EVIDENCE_MISMATCH",
        `rubric_evidence references an item outside the active card: ${item.rubric_item_id}`,
        {
          issues: [diagnostic(
            "RUBRIC_EVIDENCE_MISMATCH",
            `rubric_evidence[${index}].rubric_item_id`,
            "The rubric item does not belong to the active card.",
          )],
        },
      );
    }
  }
}

function findSubmittedCardId(deck, submittedCardId) {
  if (hasOwn(deck.cards, submittedCardId)) return submittedCardId;
  if (deck.libraryBase) return null;
  const prefix = `${deck.id}.`;
  if (submittedCardId.startsWith(prefix)) {
    const suffix = submittedCardId.slice(prefix.length);
    if (hasOwn(deck.cards, suffix)) return suffix;
  }
  const qualifiedId = qualifiedCardId(deck, submittedCardId);
  return hasOwn(deck.cards, qualifiedId) ? qualifiedId : null;
}

function resolveSubmittedCardId(deck, submittedCardId) {
  const id = findSubmittedCardId(deck, submittedCardId);
  if (id) return id;
  fail("CARD_NOT_FOUND", `Unknown card ${submittedCardId}`);
}

function schedulerMetadata() {
  return {
    id: FSRS6_ALGORITHM_ID,
    exact_fsrs: false,
    core_formula_exact: true,
    desired_retention: FSRS6_TARGET_RETENTION,
    default_weights: [...FSRS6_DEFAULT_WEIGHTS],
    maximum_interval_days: FSRS6_MAXIMUM_INTERVAL_DAYS,
    interval_fuzzing: false,
    learning_steps: [],
    relearning_steps: [],
    description:
      "The FSRS-6 memory-state formulas with the published 21 default weights and 0.9 target retention, run deterministically in the browser.",
    boundary:
      "This profile omits intraday learning/relearning steps and interval fuzzing, and maps an agent assessment to a rating; it is therefore not a full drop-in py-fsrs state machine.",
    sources: {
      specification: "https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm#fsrs-6",
      reference_implementation:
        "https://github.com/open-spaced-repetition/py-fsrs/blob/v6.3.2/fsrs/scheduler.py",
    },
    ratings: ["again", "hard", "good", "easy"],
  };
}

export function previewFsrsSchedule(previous, rating, at = new Date()) {
  const scheduledAt = at instanceof Date ? new Date(at.getTime()) : new Date(at);
  if (Number.isNaN(scheduledAt.getTime())) {
    fail("INVALID_ARGUMENT", "at must be a valid date");
  }
  const review = previous && typeof previous === "object"
    ? previous
    : newReviewState(scheduledAt.toISOString());
  return jsonClone(scheduleReview(review, rating, scheduledAt));
}

export function fsrsFreshnessForReview(review, at = new Date()) {
  const measuredAt = at instanceof Date ? new Date(at.getTime()) : new Date(at);
  if (Number.isNaN(measuredAt.getTime())) {
    fail("INVALID_ARGUMENT", "at must be a valid date");
  }
  return deriveFreshness(review, measuredAt);
}

export function learnednessForReview(review) {
  return deriveLearnedness(review);
}

function scheduleReview(previous, rating, at) {
  const ratingValue = FSRS6_RATING_VALUES[rating];
  if (!ratingValue) fail("INVALID_RATING", `Unknown FSRS rating ${rating}`);
  const next = jsonClone(previous);
  const repetitions = Math.max(0, Number(previous.repetitions) || 0) + 1;
  const isInitial = repetitions === 1 || !isFinitePositive(previous.stabilityDays);
  let stability;
  let difficulty;

  if (isInitial) {
    stability = fsrsInitialStability(ratingValue);
    difficulty = fsrsInitialDifficulty(ratingValue);
  } else {
    const previousStability = fsrsClampStability(previous.stabilityDays);
    const previousDifficulty = fsrsClampDifficulty(previous.difficulty);
    const elapsedDays = fsrsElapsedDays(previous.lastReviewedAt, at);
    const retrievability = fsrsRetrievability(previousStability, elapsedDays);
    if (elapsedDays < 1) {
      stability = fsrsSameDayStability(previousStability, ratingValue);
    } else if (rating === "again") {
      stability = fsrsForgetStability(
        previousDifficulty,
        previousStability,
        retrievability,
      );
    } else {
      stability = fsrsRecallStability(
        previousDifficulty,
        previousStability,
        retrievability,
        ratingValue,
      );
    }
    difficulty = fsrsNextDifficulty(previousDifficulty, ratingValue);
  }
  stability = fsrsClampStability(stability);
  difficulty = fsrsClampDifficulty(difficulty);
  const intervalDays = fsrsNextInterval(stability);
  const dueAt = new Date(at.getTime() + intervalDays * DAY_MS);
  next.algorithm = FSRS6_ALGORITHM_ID;
  next.exactFsrs = false;
  next.coreFormulaExact = true;
  delete next.demoSeeded;
  next.repetitions = repetitions;
  if (rating === "again") next.lapses = Math.max(0, Number(previous.lapses) || 0) + 1;
  else next.lapses = Math.max(0, Number(previous.lapses) || 0);
  next.stabilityDays = stability;
  next.difficulty = difficulty;
  next.intervalDays = intervalDays;
  next.dueAt = dueAt.toISOString();
  next.lastReviewedAt = at.toISOString();
  next.lastRating = rating;
  next.hasSuccessfulRecall = previous.hasSuccessfulRecall === true
    || ["good", "easy"].includes(previous.lastRating)
    || ["good", "easy"].includes(rating);
  return next;
}

function fsrsInitialStability(rating) {
  return fsrsClampStability(FSRS6_DEFAULT_WEIGHTS[rating - 1]);
}

function fsrsInitialDifficulty(rating, shouldClamp = true) {
  const difficulty =
    FSRS6_DEFAULT_WEIGHTS[4] - Math.exp(FSRS6_DEFAULT_WEIGHTS[5] * (rating - 1)) + 1;
  return shouldClamp ? fsrsClampDifficulty(difficulty) : difficulty;
}

function fsrsRetrievability(stability, elapsedDays) {
  const safeStability = fsrsClampStability(stability);
  const safeElapsedDays = Math.max(0, Number(elapsedDays) || 0);
  return (1 + (FSRS6_FACTOR * safeElapsedDays) / safeStability) ** FSRS6_DECAY;
}

function fsrsNextDifficulty(difficulty, rating) {
  const currentDifficulty = fsrsClampDifficulty(difficulty);
  const deltaDifficulty = -(FSRS6_DEFAULT_WEIGHTS[6] * (rating - 3));
  const dampedDelta =
    ((FSRS6_DIFFICULTY_MAX - currentDifficulty) * deltaDifficulty) / 9;
  const reverted =
    FSRS6_DEFAULT_WEIGHTS[7] * fsrsInitialDifficulty(4, false) +
    (1 - FSRS6_DEFAULT_WEIGHTS[7]) * (currentDifficulty + dampedDelta);
  return fsrsClampDifficulty(reverted);
}

function fsrsSameDayStability(stability, rating) {
  let increase =
    Math.exp(FSRS6_DEFAULT_WEIGHTS[17] * (rating - 3 + FSRS6_DEFAULT_WEIGHTS[18])) *
    stability ** -FSRS6_DEFAULT_WEIGHTS[19];
  // FSRS-6 requires successful same-day reviews (Hard/Good/Easy) not to
  // decrease stability. py-fsrs 6.3.2 fixed the Hard floor explicitly.
  if (rating >= 2) increase = Math.max(increase, 1);
  return fsrsClampStability(stability * increase);
}

function fsrsForgetStability(difficulty, stability, retrievability) {
  const longTerm =
    FSRS6_DEFAULT_WEIGHTS[11] *
    difficulty ** -FSRS6_DEFAULT_WEIGHTS[12] *
    ((stability + 1) ** FSRS6_DEFAULT_WEIGHTS[13] - 1) *
    Math.exp((1 - retrievability) * FSRS6_DEFAULT_WEIGHTS[14]);
  const sameDayCap =
    stability /
    Math.exp(FSRS6_DEFAULT_WEIGHTS[17] * FSRS6_DEFAULT_WEIGHTS[18]);
  return fsrsClampStability(Math.min(longTerm, sameDayCap));
}

function fsrsRecallStability(difficulty, stability, retrievability, rating) {
  const hardPenalty = rating === 2 ? FSRS6_DEFAULT_WEIGHTS[15] : 1;
  const easyBonus = rating === 4 ? FSRS6_DEFAULT_WEIGHTS[16] : 1;
  return fsrsClampStability(
    stability *
      (1 +
        Math.exp(FSRS6_DEFAULT_WEIGHTS[8]) *
          (11 - difficulty) *
          stability ** -FSRS6_DEFAULT_WEIGHTS[9] *
          (Math.exp((1 - retrievability) * FSRS6_DEFAULT_WEIGHTS[10]) - 1) *
          hardPenalty *
          easyBonus),
  );
}

function fsrsNextInterval(stability) {
  const interval =
    (fsrsClampStability(stability) / FSRS6_FACTOR) *
    (FSRS6_TARGET_RETENTION ** (1 / FSRS6_DECAY) - 1);
  return clamp(Math.round(interval), 1, FSRS6_MAXIMUM_INTERVAL_DAYS);
}

function fsrsElapsedDays(lastReviewedAt, at) {
  const lastReviewed = new Date(lastReviewedAt);
  if (Number.isNaN(lastReviewed.getTime())) return 0;
  return Math.max(0, Math.floor((at.getTime() - lastReviewed.getTime()) / DAY_MS));
}

function fsrsClampStability(stability) {
  const numeric = Number(stability);
  return Math.max(Number.isFinite(numeric) ? numeric : FSRS6_STABILITY_MIN, FSRS6_STABILITY_MIN);
}

function fsrsClampDifficulty(difficulty) {
  const numeric = Number(difficulty);
  return clamp(
    Number.isFinite(numeric) ? numeric : FSRS6_DIFFICULTY_MAX,
    FSRS6_DIFFICULTY_MIN,
    FSRS6_DIFFICULTY_MAX,
  );
}

function isFinitePositive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function deriveLearnedness(review) {
  if (!review || review.repetitions <= 0) return 0;
  const exposure = 1 - Math.exp(-review.repetitions / 3);
  const stability = 1 - Math.exp(-Math.max(0, Number(review.stabilityDays) || 0) / 18);
  const difficultyPenalty = (fsrsClampDifficulty(review.difficulty) - 1) / 18;
  const lapsePenalty = Math.min(0.35, review.lapses * 0.06);
  return round(clamp(exposure * 0.65 + stability * 0.35 - difficultyPenalty - lapsePenalty, 0, 1), 4);
}

function deriveFreshness(review, at) {
  if (!review?.lastReviewedAt || !isFinitePositive(review.stabilityDays)) return 0;
  const elapsedDays = fsrsElapsedDays(review.lastReviewedAt, at);
  return round(clamp(fsrsRetrievability(review.stabilityDays, elapsedDays), 0, 1), 4);
}

function deckMetrics(deck, at) {
  const cards = deck.cardOrder.map((id) => deck.cards[id]).filter((card) => card && !card.archived);
  // New coverage is intentionally separate from scheduled review debt. A new
  // card can be available for a mixed/new session without inflating due_count.
  const due = cards.filter(
    (card) =>
      card.review.repetitions > 0 && new Date(card.review.dueAt).getTime() <= at.getTime(),
  );
  const introduced = cards.filter((card) => card.review.repetitions > 0);
  const learnedness = cards.map((card) => deriveLearnedness(card.review));
  // Freshness is recall probability among introduced cards only. New-card
  // coverage is reported separately and must not masquerade as stale memory.
  const freshness = introduced.map((card) => deriveFreshness(card.review, at));
  return {
    total_cards: cards.length,
    due_count: due.length,
    new_count: cards.filter((card) => card.review.repetitions === 0).length,
    reviewed_count: introduced.length,
    learned_count: learnedness.filter((value) => value >= 0.6).length,
    average_learnedness: round(average(learnedness), 4),
    average_freshness: round(average(freshness), 4),
    last_studied_at:
      cards
        .map((card) => card.review.lastReviewedAt)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null,
  };
}

function personalDeckSummary(deck, at) {
  return {
    id: deck.id,
    deck_instance_id: deck.deckInstanceId,
    title: deck.title,
    subject: deck.subject,
    level: deck.level,
    description: deck.description,
    archived: deck.archived,
    revision: deck.revision,
    source: jsonClone(deck.source),
    progress: deckMetrics(deck, at),
    updated_at: deck.updatedAt,
  };
}

function librarySummary(deck) {
  if (deck.librarySummary) return {
    id: deck.librarySummary.deck_id,
    title: deck.librarySummary.title,
    subject: deck.librarySummary.subject,
    level: deck.librarySummary.level,
    description: deck.librarySummary.description,
    version: deck.librarySummary.version,
    card_count: deck.librarySummary.card_count,
    edge_count: deck.librarySummary.prerequisite_edge_count,
    review_status: deck.librarySummary.review_status,
    content_status: deck.librarySummary.content_status,
    provenance: jsonClone(deck.librarySummary.provenance_summary),
    license: null,
  };
  return {
    id: deck.id,
    title: deck.title,
    subject: deck.subject,
    level: deck.level,
    description: deck.description,
    version: deck.version,
    card_count: deck.cards.length,
    edge_count: deck.edges.length,
    review_status: deck.reviewStatus,
    content_status: deck.contentStatus,
    provenance: jsonClone(deck.provenance),
    license: jsonClone(deck.license),
  };
}

function libraryDetail(deck, state) {
  const installed = Object.values(state.personalDecks).find(
    (candidate) => candidate.source?.catalogDeckId === deck.id,
  );
  return {
    ...librarySummary(deck),
    tags: jsonClone(deck.tags),
    sample_terms: jsonClone(deck.librarySummary?.sample_terms ?? deck.cards.slice(0, 8).map((card) => card.term)),
    graph: {
      acyclic: true,
      max_depth: deck.contentResolved === false ? null : graphMaxDepth(deck.cards.map((card) => card.id), deck.edges),
    },
    installed_personal_deck_id: installed?.id ?? null,
    installed_version: installed?.source?.catalogVersion ?? null,
  };
}

function exposeCatalogCard(deckId, card, state) {
  const protectedCard = protectedCatalogCard(state, deckId, card.id);
  return {
    id: card.id,
    term: card.term,
    ...(protectedCard
      ? { definition_hidden: true }
      : {
          definition: card.definition,
          tags: jsonClone(card.tags),
          source_refs: jsonClone(card.sourceRefs),
        }),
  };
}

function exposePersonalCard(deckId, card, state, at) {
  const protectedCard = protectedPersonalCard(state, deckId, card.id);
  return {
    id: card.id,
    term: card.term,
    ...(protectedCard
      ? { definition_hidden: true }
      : {
          definition: card.definition,
          tags: jsonClone(card.tags),
          source_refs: jsonClone(card.sourceRefs),
        }),
    review: {
      repetitions: card.review.repetitions,
      due_at: card.review.repetitions > 0 ? card.review.dueAt : null,
      last_reviewed_at: card.review.lastReviewedAt,
      learnedness: deriveLearnedness(card.review),
      freshness: deriveFreshness(card.review, at),
    },
  };
}

function protectedPersonalCard(state, deckId, cardId) {
  return Object.values(state.sessions).some(
    (session) =>
      (session.status === "active" || session.status === "paused") &&
      session.phase === "awaiting_answer" &&
      session.deckId === deckId &&
      session.currentCardId === cardId,
  );
}

function protectedCatalogCard(state, catalogDeckId, cardId) {
  return Object.values(state.sessions).some((session) => {
    if (
      (session.status !== "active" && session.status !== "paused") ||
      session.phase !== "awaiting_answer" ||
      session.currentCardId !== cardId
    ) {
      return false;
    }
    const personal = state.personalDecks[session.deckId];
    return personal?.source?.catalogDeckId === catalogDeckId;
  });
}

function pageCards(cards, args, expose) {
  const requestedIds = optionalIdArray(args.card_ids, "card_ids", 50);
  const query = optionalString(args.query, "query", 200)?.toLowerCase() ?? "";
  const limit = boundedInteger(args.limit ?? 25, "limit", 1, 50);
  const offset = decodeCursor(args.cursor);
  let filtered = cards;
  if (requestedIds.length) {
    const wanted = new Set(requestedIds);
    filtered = filtered.filter((card) => wanted.has(card.id));
  }
  if (query) {
    filtered = filtered.filter((card) => card.term.toLowerCase().includes(query));
  }
  const page = filtered.slice(offset, offset + limit);
  return {
    cards: page.map(expose),
    total_cards: filtered.length,
    next_cursor: offset + limit < filtered.length ? encodeCursor(offset + limit) : null,
  };
}

function graphNode(card, at) {
  return {
    id: card.id,
    term: card.term,
    learnedness: deriveLearnedness(card.review),
    freshness: deriveFreshness(card.review, at),
    last_reviewed_at: card.review.lastReviewedAt,
    due_at: card.review.repetitions > 0 ? card.review.dueAt : null,
    review_count: card.review.repetitions,
  };
}

function graphSelection(deck, { scope, depth, focusId, targetId, limit }) {
  const activeIds = deck.cardOrder.filter((id) => deck.cards[id] && !deck.cards[id].archived);
  const activeSet = new Set(activeIds);
  const edges = deck.edges.filter(
    (edge) => activeSet.has(edge.prerequisiteCardId) && activeSet.has(edge.dependentCardId),
  );
  let selected;
  if (scope === "overview") {
    selected = activeIds;
  } else if (scope === "neighborhood") {
    if (!focusId) fail("INVALID_ARGUMENT", "neighborhood scope requires focus_card_id");
    if (!activeSet.has(focusId)) fail("CARD_NOT_FOUND", `Unknown active card ${focusId}`);
    selected = neighborhood(focusId, edges, depth);
  } else {
    if (!focusId || !targetId) {
      fail("INVALID_ARGUMENT", "dependency_path requires focus_card_id and target_card_id");
    }
    if (!activeSet.has(focusId)) fail("CARD_NOT_FOUND", `Unknown active card ${focusId}`);
    if (!activeSet.has(targetId)) fail("CARD_NOT_FOUND", `Unknown active card ${targetId}`);
    const path = findPath(focusId, targetId, edges);
    if (!path) fail("PATH_NOT_FOUND", "No prerequisite path connects the selected cards");
    selected = path;
  }
  const truncated = selected.length > limit;
  const nodeIds = selected.slice(0, limit);
  const selectedSet = new Set(nodeIds);
  return {
    nodeIds,
    edges: edges
      .filter(
        (edge) => selectedSet.has(edge.prerequisiteCardId) && selectedSet.has(edge.dependentCardId),
      )
      .map((edge) => ({
        id: edge.id,
        prerequisite_card_id: edge.prerequisiteCardId,
        dependent_card_id: edge.dependentCardId,
      })),
    truncated,
  };
}

function neighborhood(focusId, edges, depth) {
  const adjacent = new Map();
  for (const edge of edges) {
    if (!adjacent.has(edge.prerequisiteCardId)) adjacent.set(edge.prerequisiteCardId, new Set());
    if (!adjacent.has(edge.dependentCardId)) adjacent.set(edge.dependentCardId, new Set());
    adjacent.get(edge.prerequisiteCardId).add(edge.dependentCardId);
    adjacent.get(edge.dependentCardId).add(edge.prerequisiteCardId);
  }
  const seen = new Set([focusId]);
  let frontier = [focusId];
  for (let level = 0; level < depth; level += 1) {
    const next = [];
    for (const id of frontier) {
      for (const neighbor of adjacent.get(id) ?? []) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}

function findPath(start, target, edges) {
  const outgoing = adjacency(edges, "prerequisiteCardId", "dependentCardId");
  const queue = [[start]];
  const seen = new Set([start]);
  while (queue.length) {
    const path = queue.shift();
    const current = path.at(-1);
    if (current === target) return path;
    for (const next of outgoing.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push([...path, next]);
      }
    }
  }
  return null;
}

function farDependencies(deck, limit) {
  const active = new Set(deck.cardOrder.filter((id) => deck.cards[id] && !deck.cards[id].archived));
  const edges = deck.edges.filter(
    (edge) => active.has(edge.prerequisiteCardId) && active.has(edge.dependentCardId),
  );
  const incoming = adjacency(edges, "dependentCardId", "prerequisiteCardId");
  const results = [];
  for (const target of active) {
    const queue = [{ id: target, distance: 0 }];
    const seen = new Set([target]);
    while (queue.length) {
      const { id, distance } = queue.shift();
      for (const prerequisite of incoming.get(id) ?? []) {
        if (seen.has(prerequisite)) continue;
        seen.add(prerequisite);
        const nextDistance = distance + 1;
        if (nextDistance >= 3) {
          results.push({
            prerequisite_card_id: prerequisite,
            dependent_card_id: target,
            distance: nextDistance,
          });
        }
        queue.push({ id: prerequisite, distance: nextDistance });
      }
    }
  }
  return results.sort((a, b) => b.distance - a.distance).slice(0, limit);
}

function hasSuccessfulRecall(card) {
  const review = card?.review;
  const count = Number(review?.repetitions ?? 0);
  if (count <= 0) return false;
  if (review.hasSuccessfulRecall === true || ["good", "easy"].includes(review.lastRating)) return true;
  // Old sparse/dense states predate the explicit marker. Only the current
  // scheduling epoch's trailing reviews can contribute: a material edit resets
  // repetitions, while a tag-only edit must not invalidate prior good recall.
  if (Object.hasOwn(review, "hasSuccessfulRecall")) return false;
  return (card.reviewHistory ?? []).slice(-count).some(event => ["good", "easy"].includes(event.rating));
}

function reviewWithRecallEvidence(card) {
  return { ...card.review, hasSuccessfulRecall: hasSuccessfulRecall(card) };
}

function unmetStudyPrerequisite(deck, parentId, state, catalogDecks) {
  const internalId = findSubmittedCardId(deck, parentId);
  let ownerDeck = internalId ? deck : null;
  let parent = internalId ? deck.cards[internalId] : null;
  let catalogOwner = null;
  let reason = null;
  if (!parent && deck.libraryBase) {
    catalogOwner = libraryPrerequisiteOwner(catalogDecks, deck, parentId);
    if (!catalogOwner) reason = "PARENT_UNRESOLVED";
    else {
      const installed = matchingLibraryInstallations(state, catalogOwner.deck.id, catalogOwner.deck.libraryBase);
      if (installed.length > 1) reason = "PARENT_AMBIGUOUS";
      else if (!installed.length) {
        reason = matchingLibraryInstallations(state, catalogOwner.deck.id).length
          ? "PARENT_BASE_CONFLICT" : "PARENT_NOT_INSTALLED";
      } else {
        ownerDeck = installed[0];
        if (ownerDeck.archived) reason = "PARENT_DECK_ARCHIVED";
        parent = hasOwn(ownerDeck.cards, parentId) ? ownerDeck.cards[parentId] : null;
        if (!reason && !parent) reason = "PARENT_MISSING";
      }
    }
  } else if (!parent && state) {
    // Match actual card identities, never infer ownership by splitting an ID.
    const matchesFor = archived => Object.values(state.personalDecks).filter(other => Boolean(other.archived) === archived)
      .flatMap(other => other.cardOrder.filter(id => qualifiedCardId(other, id) === parentId)
        .map(id => ({ deck: other, card: other.cards[id] })));
    const matches = matchesFor(false);
    if (matches.length > 1) reason = "PARENT_AMBIGUOUS";
    else if (matches.length === 1) { ownerDeck = matches[0].deck; parent = matches[0].card; }
    else {
      const archived = matchesFor(true);
      if (archived.length === 1) {
        ownerDeck = archived[0].deck;
        parent = archived[0].card;
        reason = "PARENT_DECK_ARCHIVED";
      } else reason = archived.length > 1 ? "PARENT_AMBIGUOUS" : "PARENT_UNRESOLVED";
    }
  }
  if (!reason) reason = !parent ? "PARENT_MISSING" : parent.archived
    ? "PARENT_CARD_ARCHIVED" : !hasSuccessfulRecall(parent) ? "PARENT_RECALL_REQUIRED" : null;
  if (!reason) return null;
  const base = catalogOwner?.deck.libraryBase ?? ownerDeck?.libraryBase;
  return {
    card_id: parent && ownerDeck ? qualifiedCardId(ownerDeck, parent.id) : parentId,
    term: parent?.term ?? catalogOwner?.card?.term ?? null,
    owner_deck_id: ownerDeck?.id ?? null,
    owner_deck_title: ownerDeck?.title ?? catalogOwner?.deck.title ?? null,
    catalog_deck_id: base?.catalogDeckId ?? ownerDeck?.source?.catalogDeckId ?? null,
    catalog_version: base?.catalogVersion ?? ownerDeck?.source?.catalogVersion ?? null,
    reason,
  };
}

function explainStudyCardEligibility(deck, card, state, catalogDecks, includeReasons = false) {
  if (!card || card.archived || deck.archived) return { eligible: false, unmet_prerequisites: [] };
  // Introduction is historical. A later parent lapse must not relock this card.
  if (Number(card.review?.repetitions ?? 0) > 0) return { eligible: true, unmet_prerequisites: [] };
  const parents = [...new Set([...(card.prerequisiteIds ?? []), ...prerequisitesForCard(deck, card.id)])]
    .filter((parentId) => isDeckLocalStudyPrerequisite(deck, parentId, catalogDecks));
  const unmet = [];
  for (const parentId of parents) {
    const issue = unmetStudyPrerequisite(deck, parentId, state, catalogDecks);
    if (!issue) continue;
    if (!includeReasons) return { eligible: false, unmet_prerequisites: [] };
    unmet.push(issue);
  }
  return { eligible: unmet.length === 0, unmet_prerequisites: unmet };
}

function isDeckLocalStudyPrerequisite(deck, parentId, catalogDecks) {
  if (Array.isArray(deck.cards)) {
    return deck.cards.some((card) => card.id === parentId);
  }
  return Boolean(findSubmittedCardId(deck, parentId));
}

function isStudyCardEligible(deck, card, state, catalogDecks) {
  return explainStudyCardEligibility(deck, card, state, catalogDecks).eligible;
}

function assertStudyCardEligible(deck, card, state, catalogDecks) {
  if (!isStudyCardEligible(deck, card, state, catalogDecks)) {
    fail("PREREQUISITE_NOT_SATISFIED", "The current card cannot be introduced until every required parent has prior Good/Easy recall", {
      deck_id: deck.id, card_id: card.id,
    });
  }
}

function buildStudyQueue(deck, mode, limit, focusCardIds, at, state, catalogDecks) {
  const activeCards = deck.cardOrder.map((id) => deck.cards[id]).filter((card) => card && !card.archived);
  const due = activeCards
    .filter((card) => card.review.repetitions > 0 && new Date(card.review.dueAt).getTime() <= at.getTime())
    .sort((a, b) => new Date(a.review.dueAt) - new Date(b.review.dueAt));
  const fresh = activeCards.filter(
    (card) =>
      card.review.repetitions === 0 &&
      isStudyCardEligible(deck, card, state, catalogDecks),
  );
  const practice = activeCards
    .filter((card) => card.review.repetitions > 0 && new Date(card.review.dueAt).getTime() > at.getTime())
    .sort((a, b) => new Date(a.review.dueAt) - new Date(b.review.dueAt));
  let cards;
  if (mode === "due") cards = due;
  else if (mode === "new") cards = fresh;
  else if (mode === "mixed") cards = [...due, ...fresh];
  else if (mode === "continuous") cards = [...due, ...fresh, ...practice];
  else cards = repairQueue(deck, focusCardIds).filter(card => isStudyCardEligible(deck, card, state, catalogDecks));
  return [...new Set(cards.map((card) => card.id))].slice(0, limit);
}

function dueSegmentCountForQueue(deck, queue, at) {
  let count = 0;
  for (const cardId of queue) {
    const card = deck.cards[cardId];
    const dueAt = new Date(card?.review?.dueAt).getTime();
    if (Number(card?.review?.repetitions ?? 0) <= 0 || !Number.isFinite(dueAt) || dueAt > at.getTime()) break;
    count += 1;
  }
  return count;
}

function sessionQueueProgress(session) {
  // Sessions created before this field existed remain valid and enter the
  // continuous phase immediately; new sessions retain the exact due prefix
  // captured at queue construction even after those reviews are rescheduled.
  const storedDueCount = Number.isInteger(session.dueSegmentCount) ? session.dueSegmentCount : 0;
  const dueSegmentTotal = Math.max(0, Math.min(storedDueCount, session.queue.length));
  if (!session.currentCardId || session.cursor >= session.queue.length) {
    return { dueSegmentTotal, phase: "complete", position: null };
  }
  if (session.cursor < dueSegmentTotal) {
    return { dueSegmentTotal, phase: "due", position: session.cursor + 1 };
  }
  return { dueSegmentTotal, phase: "continuous", position: session.cursor - dueSegmentTotal + 1 };
}

function repairQueue(deck, focusCardIds) {
  const active = new Set(deck.cardOrder.filter((id) => deck.cards[id] && !deck.cards[id].archived));
  for (const id of focusCardIds) {
    if (!active.has(id)) fail("CARD_NOT_FOUND", `Unknown active repair card ${id}`);
  }
  const incoming = adjacency(deck.edges, "dependentCardId", "prerequisiteCardId");
  const closure = new Set();
  const visit = (id) => {
    if (closure.has(id)) return;
    for (const prerequisite of incoming.get(id) ?? []) visit(prerequisite);
    closure.add(id);
  };
  focusCardIds.forEach(visit);
  const ordered = topologicalOrder([...active], deck.edges).filter((id) => closure.has(id));
  return ordered.map((id) => deck.cards[id]);
}

function publicSession(session, deck, previewByCapture) {
  const previewed = session.capture && previewByCapture.has(session.capture.id);
  const queueProgress = sessionQueueProgress(session);
  return {
    id: session.id,
    deck_id: session.deckId,
    deck_title: deck.title,
    mode: session.mode,
    status: session.status,
    phase: previewed ? "review_previewed" : session.phase,
    revision: session.revision,
    total: session.queue.length,
    completed: session.cursor,
    remaining: Math.max(0, session.queue.length - session.cursor),
    due_segment_total: queueProgress.dueSegmentTotal,
    queue_phase: queueProgress.phase,
    queue_phase_position: queueProgress.position,
    current_card_id: session.currentCardId,
    started_at: session.startedAt,
    updated_at: session.updatedAt,
    finished_at: session.finishedAt,
  };
}

function safeCurrentCard(session, deck) {
  if (!session.currentCardId) return null;
  const card = requireCard(deck, session.currentCardId);
  return { id: card.id, term: card.term };
}

function reviewPacket(card) {
  return {
    card_id: card.id,
    term: card.term,
    canonical_definition: card.definition,
    accepted_points: jsonClone(card.acceptedPoints),
    common_confusions: jsonClone(card.confusions),
    source_refs: jsonClone(card.sourceRefs),
  };
}

function normalizeAssessment(raw) {
  if (!isPlainObject(raw)) fail("INVALID_ARGUMENT", "assessment must be an object");
  const verdict = enumValue(raw.verdict, "assessment.verdict", ["correct", "partial", "incorrect"]);
  const confidence = boundedNumber(raw.confidence, "assessment.confidence", 0, 1);
  const feedback = requiredString(raw.feedback, "assessment.feedback", 2_000);
  const misconceptions = optionalStringArray(raw.misconceptions, "assessment.misconceptions", 20);
  return { verdict, confidence, feedback, misconceptions };
}

function ratingForAssessment(assessment) {
  if (assessment.verdict === "incorrect") return "again";
  if (assessment.verdict === "partial") return "hard";
  return assessment.confidence >= 0.95 ? "easy" : "good";
}

function normalizeDeckProposal(args, state, at) {
  const target = args.target;
  if (!isPlainObject(target)) fail("INVALID_ARGUMENT", "target must be an object");
  const kind = enumValue(target.kind, "target.kind", ["new", "existing"]);
  let deck;
  let baseDeckRevision;
  if (kind === "existing") {
    const deckId = requireId(target.deck_id, "target.deck_id");
    const openSession = Object.values(state.sessions).find(
      (session) =>
        session.deckId === deckId && (session.status === "active" || session.status === "paused"),
    );
    if (openSession) {
      fail(
        "DECK_IN_ACTIVE_SESSION",
        "Finish or abandon the open study session before changing this deck",
      );
    }
    const expectedRevision = boundedInteger(
      target.expected_revision,
      "target.expected_revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const existing = requirePersonalDeck(state, deckId, { allowArchived: true });
    checkRevision(existing.revision, expectedRevision, "deck");
    deck = jsonClone(existing);
    baseDeckRevision = existing.revision;
  } else {
    const title = requiredString(target.title, "target.title", 200);
    const requestedId = target.deck_id ?? `deck-${slug(title)}`;
    const id = requireId(requestedId, "target.deck_id");
    if (state.personalDecks[id]) fail("DECK_EXISTS", `Personal deck ${id} already exists`);
    const createdAt = at.toISOString();
    deck = {
      id,
      deckInstanceId: newDeckInstanceId(id, createdAt, args.client_action_id, state.revision),
      title,
      subject: optionalString(target.subject, "target.subject", 100) ?? "General",
      level: optionalString(target.level, "target.level", 100) ?? "Unspecified",
      description: optionalString(target.description, "target.description", 2_000) ?? "",
      tags: optionalStringArray(target.tags, "target.tags", 50),
      cards: {},
      cardOrder: [],
      edges: [],
      source: { kind: "agent_authored" },
      archived: false,
      revision: 0,
      createdAt,
      updatedAt: createdAt,
    };
    baseDeckRevision = 0;
  }

  const cardsUpsert = args.cards_upsert ?? [];
  const edgesUpsert = args.edges_upsert ?? [];
  const cardIdsArchive = optionalIdArray(args.card_ids_archive, "card_ids_archive", 50);
  const edgeIdsRemove = optionalIdArray(args.edge_ids_remove, "edge_ids_remove", 100);
  if (!Array.isArray(cardsUpsert) || cardsUpsert.length > 50) {
    fail("INVALID_ARGUMENT", "cards_upsert must be an array with at most 50 entries");
  }
  if (!Array.isArray(edgesUpsert) || edgesUpsert.length > 100) {
    fail("INVALID_ARGUMENT", "edges_upsert must be an array with at most 100 entries");
  }

  const diff = {
    cards_added: [],
    cards_updated: [],
    cards_archived: [],
    reviews_reset: [],
    edges_added: [],
    edges_removed: [],
  };
  for (const [index, raw] of cardsUpsert.entries()) {
    if (!isPlainObject(raw)) fail("INVALID_ARGUMENT", `cards_upsert[${index}] must be an object`);
    const term = requiredString(raw.term, `cards_upsert[${index}].term`, 300);
    const definition = requiredString(raw.definition, `cards_upsert[${index}].definition`, 8_000);
    const id = requireId(raw.id ?? uniqueCardId(deck, slug(term)), `cards_upsert[${index}].id`);
    const existing = deck.cards[id];
    const contentChanged = Boolean(
      existing && (existing.term !== term || existing.definition !== definition),
    );
    const preservedArray = (key, previous, label, maximum) =>
      Object.hasOwn(raw, key)
        ? optionalStringArray(raw[key], label, maximum)
        : jsonClone(previous ?? []);
    const card = existing
      ? {
          ...existing,
          term,
          definition,
          acceptedPoints: preservedArray("accepted_points", existing.acceptedPoints, "accepted_points", 30),
          confusions: preservedArray("confusions", existing.confusions, "confusions", 30),
          tags: preservedArray("tags", existing.tags, "tags", 50),
          sourceRefs: preservedArray("source_refs", existing.sourceRefs, "source_refs", 50),
          review: contentChanged ? newReviewState(at.toISOString()) : existing.review,
          archived: false,
          updatedAt: at.toISOString(),
        }
      : personalCard(
          {
            id,
            term,
            definition,
            acceptedPoints: optionalStringArray(raw.accepted_points, "accepted_points", 30),
            confusions: optionalStringArray(raw.confusions, "confusions", 30),
            tags: optionalStringArray(raw.tags, "tags", 50),
            sourceRefs: optionalStringArray(raw.source_refs, "source_refs", 50),
          },
          at.toISOString(),
        );
    deck.cards[id] = card;
    if (!existing) deck.cardOrder.push(id);
    diff[existing ? "cards_updated" : "cards_added"].push(id);
    if (contentChanged && Number(existing.review?.repetitions ?? 0) > 0) diff.reviews_reset.push(id);
  }

  for (const id of cardIdsArchive) {
    const card = requireCard(deck, id);
    card.archived = true;
    card.updatedAt = at.toISOString();
    diff.cards_archived.push(id);
  }

  const removeSet = new Set(edgeIdsRemove);
  for (const id of removeSet) {
    if (!deck.edges.some((edge) => edge.id === id)) {
      fail("EDGE_NOT_FOUND", `Unknown prerequisite edge ${id}`);
    }
  }
  const archivedSet = new Set(cardIdsArchive);
  deck.edges = deck.edges.filter((edge) => {
    const remove =
      removeSet.has(edge.id) ||
      archivedSet.has(edge.prerequisiteCardId) ||
      archivedSet.has(edge.dependentCardId);
    if (remove) diff.edges_removed.push(edge.id);
    return !remove;
  });
  for (const [index, raw] of edgesUpsert.entries()) {
    const edge = normalizeEdge(raw, index);
    const existing = deck.edges.find((candidate) => candidate.id === edge.id);
    const existingPair = deck.edges.find(
      (candidate) =>
        candidate.prerequisiteCardId === edge.prerequisiteCardId &&
        candidate.dependentCardId === edge.dependentCardId,
    );
    if (
      existing &&
      (existing.prerequisiteCardId !== edge.prerequisiteCardId ||
        existing.dependentCardId !== edge.dependentCardId)
    ) {
      fail("EDGE_ID_CONFLICT", `Edge id ${edge.id} already identifies a different relationship`);
    }
    if (existingPair && existingPair.id !== edge.id) {
      fail("EDGE_PAIR_EXISTS", "That prerequisite relationship already exists under another edge id", {
        existing_edge_id: existingPair.id,
      });
    }
    if (!existing) {
      deck.edges.push(edge);
      diff.edges_added.push(edge.id);
    }
  }
  deck.edges = dedupeEdges(deck.edges);
  ensureUniqueCards(deck.cardOrder.map((id) => deck.cards[id]).filter((card) => !card.archived), "proposed deck");
  const activeIds = new Set(deck.cardOrder.filter((id) => deck.cards[id] && !deck.cards[id].archived));
  validateEdges(activeIds, deck.edges);
  assertAcyclic(activeIds, deck.edges);
  if (activeIds.size === 0) fail("INVALID_DECK", "A deck must contain at least one active card");

  const sourceNotes = optionalString(args.source_notes, "source_notes", 4_000);
  const hasLocalChanges = Object.values(diff).some((entries) => entries.length > 0) || Boolean(sourceNotes);
  if (kind === "existing" && hasLocalChanges) {
    deck.source = {
      ...deck.source,
      kind: deck.source?.catalogDeckId ? "library_derived" : deck.source?.kind ?? "agent_authored",
      locallyModified: true,
      localRevision: baseDeckRevision + 1,
      locallyModifiedAt: at.toISOString(),
      ...(sourceNotes ? { authoringNotes: sourceNotes } : {}),
    };
  } else if (sourceNotes) {
    deck.source = { ...deck.source, authoringNotes: sourceNotes };
  }
  const warnings = [];
  if (deck.edges.length === 0 && activeIds.size > 1) warnings.push("Deck has multiple cards but no prerequisite edges.");
  return {
    target: kind === "existing" ? { kind, deck_id: deck.id } : { kind, deck_id: deck.id },
    baseDeckRevision,
    deck,
    diff,
    warnings,
  };
}

function updateStreak(state, at, timeZone) {
  state.streak = recordLocalStreak(state.streak, at, { timeZone });
}

function recordActivity(state, event) {
  state.activity.push(jsonClone(event));
  if (state.activity.length > MAX_ACTIVITY) state.activity.splice(0, state.activity.length - MAX_ACTIVITY);
}

function compareDecks(a, b, sort, at) {
  if (sort === "title") return a.title.localeCompare(b.title);
  const aMetrics = deckMetrics(a, at);
  const bMetrics = deckMetrics(b, at);
  if (sort === "progress") return bMetrics.average_learnedness - aMetrics.average_learnedness;
  if (sort === "recent") {
    return String(bMetrics.last_studied_at ?? "").localeCompare(String(aMetrics.last_studied_at ?? ""));
  }
  return bMetrics.due_count - aMetrics.due_count || a.title.localeCompare(b.title);
}

function topologicalOrder(nodeIds, edges) {
  const active = new Set(nodeIds);
  const indegree = new Map(nodeIds.map((id) => [id, 0]));
  const outgoing = new Map(nodeIds.map((id) => [id, []]));
  for (const edge of edges) {
    if (!active.has(edge.prerequisiteCardId) || !active.has(edge.dependentCardId)) continue;
    outgoing.get(edge.prerequisiteCardId).push(edge.dependentCardId);
    indegree.set(edge.dependentCardId, indegree.get(edge.dependentCardId) + 1);
  }
  const queue = nodeIds.filter((id) => indegree.get(id) === 0);
  const ordered = [];
  while (queue.length) {
    const id = queue.shift();
    ordered.push(id);
    for (const target of outgoing.get(id)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }
  if (ordered.length !== nodeIds.length) fail("DAG_CYCLE", "Prerequisite edges must form a DAG");
  return ordered;
}

function graphMaxDepth(nodeIds, edges) {
  const ordered = topologicalOrder(nodeIds, edges);
  const depth = new Map(nodeIds.map((id) => [id, 0]));
  const outgoing = adjacency(edges, "prerequisiteCardId", "dependentCardId");
  for (const id of ordered) {
    for (const target of outgoing.get(id) ?? []) {
      depth.set(target, Math.max(depth.get(target) ?? 0, (depth.get(id) ?? 0) + 1));
    }
  }
  return Math.max(0, ...depth.values());
}

function assertAcyclic(cardIds, edges) {
  topologicalOrder([...cardIds], edges);
}

function validateEdges(cardIds, edges) {
  for (const edge of edges) {
    if (!cardIds.has(edge.prerequisiteCardId) || !cardIds.has(edge.dependentCardId)) {
      fail("INVALID_EDGE", `Edge ${edge.id} references a missing or archived card`);
    }
    if (edge.prerequisiteCardId === edge.dependentCardId) {
      fail("INVALID_EDGE", `Edge ${edge.id} cannot connect a card to itself`);
    }
  }
}

function dedupeEdges(edges) {
  const seenIds = new Set();
  const seenPairs = new Set();
  const result = [];
  for (const edge of edges) {
    const pair = `${edge.prerequisiteCardId}\u0000${edge.dependentCardId}`;
    if (seenIds.has(edge.id) || seenPairs.has(pair)) continue;
    seenIds.add(edge.id);
    seenPairs.add(pair);
    result.push(edge);
  }
  return result;
}

function adjacency(edges, fromKey, toKey) {
  const result = new Map();
  for (const edge of edges) {
    if (!result.has(edge[fromKey])) result.set(edge[fromKey], []);
    result.get(edge[fromKey]).push(edge[toKey]);
  }
  return result;
}

function ensureUniqueCards(cards, label) {
  const ids = new Set();
  const terms = new Set();
  for (const card of cards) {
    if (ids.has(card.id)) fail("DUPLICATE_CARD", `${label} has duplicate card id ${card.id}`);
    const normalizedTerm = card.term.trim().toLowerCase();
    if (terms.has(normalizedTerm)) fail("DUPLICATE_CARD", `${label} has duplicate term ${card.term}`);
    ids.add(card.id);
    terms.add(normalizedTerm);
  }
}

function requireCatalogDeck(catalog, id) {
  const deck = catalog.get(id);
  if (!deck) fail("CATALOG_DECK_NOT_FOUND", `Unknown catalog deck ${id}`);
  return deck;
}

function requirePersonalDeck(state, id, { allowArchived }) {
  const deck = hasOwn(state.personalDecks, id) ? state.personalDecks[id] : null;
  if (!deck) fail("DECK_NOT_FOUND", `Unknown personal deck ${id}`);
  if (deck.archived && !allowArchived) fail("DECK_ARCHIVED", `Deck ${id} is archived`);
  return deck;
}

function requireCard(deck, id, { allowArchived = false } = {}) {
  const card = hasOwn(deck.cards, id) ? deck.cards[id] : null;
  if (!card || (card.archived && !allowArchived)) fail("CARD_NOT_FOUND", `Unknown ${allowArchived ? "" : "active "}card ${id}`);
  return card;
}

function requireSession(state, id) {
  const session = hasOwn(state.sessions, id) ? state.sessions[id] : null;
  if (!session) fail("SESSION_NOT_FOUND", `Unknown session ${id}`);
  return session;
}

function requireActiveSession(state, id) {
  const session = requireSession(state, id);
  if (session.status !== "active" || state.activeSessionId !== id) {
    fail("SESSION_NOT_ACTIVE", `Session ${id} is not active`);
  }
  return session;
}

function checkRevision(actual, expected, resource) {
  if (actual !== expected) {
    fail("STALE_REVISION", `${resource} revision changed`, { expected, actual });
  }
}

function uniqueDeckId(state, base) {
  let candidate = base;
  let suffix = 2;
  while (hasOwn(state.personalDecks, candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function uniqueCardId(deck, base) {
  let candidate = base || "card";
  let suffix = 2;
  while (deck.cards[candidate]) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function uniqueSessionId(state, actionId, deckId, at) {
  const base = `session-${stableHash({ actionId, deckId, at })}`;
  let candidate = base;
  let suffix = 2;
  while (state.sessions[candidate]) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function requireActionId(value) {
  return requiredString(value, "client_action_id", 128);
}

function requireId(value, name) {
  const id = requiredString(value, name, 257);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    fail("INVALID_ID", `${name} contains unsupported characters`);
  }
  return id;
}

function requireNormalizedLocalId(value, name) {
  const id = boundedNonblankString(value, name, 128);
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,127})$/.test(id)) {
    fail("INVALID_ID", `${name} must be a lowercase deck-local identifier`);
  }
  return id;
}

function assertClosedFields(value, allowedFields, path) {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length) {
    fail("UNKNOWN_FIELD", `${path} contains unsupported field ${unknown[0]}`);
  }
}

function boundedNonblankString(value, name, maxLength) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("INVALID_ARGUMENT", `${name} must be a non-empty string`);
  }
  if (value.length > maxLength) fail("INVALID_ARGUMENT", `${name} exceeds ${maxLength} characters`);
  return value;
}

function optionalBoundedUniqueStrings(value, name, maxItems, maxLength) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    fail("INVALID_ARGUMENT", `${name} must be an array with at most ${maxItems} entries`);
  }
  const strings = value.map((entry, index) => boundedNonblankString(entry, `${name}[${index}]`, maxLength));
  if (new Set(strings).size !== strings.length) fail("INVALID_ARGUMENT", `${name} must contain unique entries`);
  return strings;
}

function optionalIdArray(value, name, max) {
  return optionalStringArray(value, name, max).map((entry, index) =>
    requireId(entry, `${name}[${index}]`),
  );
}

function requiredString(value, name, maxLength) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("INVALID_ARGUMENT", `${name} must be a non-empty string`);
  }
  if (value.length > maxLength) fail("INVALID_ARGUMENT", `${name} exceeds ${maxLength} characters`);
  return value.trim();
}

function optionalString(value, name, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, name, maxLength);
}

function optionalStringArray(value, name, maxItems) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    fail("INVALID_ARGUMENT", `${name} must be an array with at most ${maxItems} entries`);
  }
  return value.map((entry, index) => requiredString(entry, `${name}[${index}]`, 1_000));
}

function enumValue(value, name, allowed) {
  if (!allowed.includes(value)) fail("INVALID_ARGUMENT", `${name} must be one of ${allowed.join(", ")}`);
  return value;
}

function boundedInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail("INVALID_ARGUMENT", `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function boundedNumber(value, name, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail("INVALID_ARGUMENT", `${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

function requiredBoolean(value, name) {
  if (typeof value !== "boolean") fail("INVALID_ARGUMENT", `${name} must be a boolean`);
  return value;
}

function objectArgs(value) {
  if (!isPlainObject(value)) fail("INVALID_ARGUMENT", "Tool input must be an object");
  return value;
}

function encodeCursor(offset) {
  return `offset:${offset}`;
}

function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  const value = requiredString(cursor, "cursor", 64);
  const match = /^offset:(\d+)$/.exec(value);
  if (!match) fail("INVALID_CURSOR", "cursor is malformed");
  return Number(match[1]);
}

function jsonClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function stableHash(value) {
  const input = stableStringify(value);
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function newDeckInstanceId(deckId, createdAt, actionId, previousAppRevision) {
  const seed = { deckId, createdAt, actionId, previousAppRevision };
  return `deck-instance-${stableHash(seed)}-${stableHash({ seed, reverse: true })}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function slug(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "item";
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(code, message, details) {
  throw new StudyStoreError(code, message, details);
}
