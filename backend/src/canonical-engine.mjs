import {
  BackendError, assertJson, catalogRef, checkSchema, clone, object,
  requireThat, sha256, stableJson, text, validateSchema,
} from "./contracts.mjs";
import { validateLocalSnapshot } from "./local-state-validation.mjs";

export const STORAGE_KEY = "adaptive-study-lab:web-state:v1";
export const READ_METHODS = Object.freeze({
  get_learning_overview: "getLearningOverview",
  search_library: "searchLibrary",
  list_my_decks: "searchMyDecks",
  get_deck: "getDeck",
  validate_deck: "validateDeck",
  get_study_session: "getStudySession",
});
export const WRITE_METHODS = Object.freeze({
  ingest_deck: "ingestDeck",
  update_deck: "updateDeck",
  add_cards: "addCards",
  update_cards: "updateCards",
  start_study_session: "startStudySession",
  submit_grade: "submitGrade",
  finish_study_session: "finishStudySession",
  add_library_deck: "addLibraryDeck",
});
const INSTALL_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    library_deck_id: { type: "string", minLength: 1, maxLength: 160 },
    expected_catalog_version: { type: "string", minLength: 1, maxLength: 128 },
    client_action_id: { type: "string", minLength: 1, maxLength: 128 },
  },
  required: ["library_deck_id", "expected_catalog_version", "client_action_id"],
};

// The host supplies the canonical exports and immutable ORIGINAL catalog
// inputs. No canonical source or private construction history is copied here.
export async function createCanonicalEngine({
  createStudyStore, createMemoryStorage, toolSchemas, catalogs, defaultCatalogVersion,
}) {
  requireThat(typeof createStudyStore === "function" && typeof createMemoryStorage === "function",
    "ENGINE_UNAVAILABLE", "Canonical store exports are required", 503);
  const schemas = clone(toolSchemas);
  for (const name of [...Object.keys(READ_METHODS), ...Object.keys(WRITE_METHODS)]) {
    if (name === "add_library_deck") continue;
    requireThat(schemas[name]?.input && schemas[name]?.output,
      "CONTRACT_UNSUPPORTED", `Missing canonical schema: ${name}`, 503);
    checkSchema(schemas[name].input);
    checkSchema(schemas[name].output);
  }
  const registry = new Map();
  for (const entry of catalogs ?? []) {
    text(entry.version, "catalog version");
    requireThat(!registry.has(entry.version), "CATALOG_CONFLICT", "Duplicate catalog release", 503);
    const raw = clone(assertJson(entry.catalog, { maxNodes: 2_000_000 }));
    const digest = await sha256(stableJson(raw, { maxNodes: 2_000_000 }));
    requireThat(!entry.digest || entry.digest === digest,
      "CATALOG_CONFLICT", "Catalog release digest does not match its input", 503);
    registry.set(entry.version, { ref: { version: entry.version, digest }, raw });
  }
  requireThat(registry.has(defaultCatalogVersion), "CATALOG_UNAVAILABLE", "Default catalog is missing", 503);

  function catalogFor(ref) {
    if (!ref) return registry.get(defaultCatalogVersion);
    catalogRef(ref);
    const entry = registry.get(ref.version);
    requireThat(entry?.ref.digest === ref.digest, "CATALOG_UNAVAILABLE",
      "The pinned catalog release must be restored before this state can be used", 409);
    return entry;
  }

  function open(record, now) {
    const catalog = catalogFor(record?.catalogRef);
    const storage = createMemoryStorage(record?.stateJson ? { [STORAGE_KEY]: record.stateJson } : {});
    const store = createStudyStore({ catalog: catalog.raw, storage, clock: () => new Date(now) });
    return { store, storage, catalog };
  }

  function validate(operation, args, writing) {
    const methods = writing ? WRITE_METHODS : READ_METHODS;
    requireThat(Object.hasOwn(methods, operation), "OPERATION_NOT_ALLOWED", "Operation is not available on this endpoint");
    assertJson(args);
    validateSchema(operation === "add_library_deck" ? INSTALL_SCHEMA : schemas[operation].input, args);
    return methods[operation];
  }

  return Object.freeze({
    defaultCatalogRef: clone(registry.get(defaultCatalogVersion).ref),
    validateCommand(operation, args, requestId) {
      validate(operation, args, true);
      const engineId = operation === "add_library_deck" ? args.client_action_id : args.idempotency_key;
      requireThat(engineId === requestId, "REQUEST_ID_MISMATCH", "request_id must equal the canonical action identity");
    },
    async query(record, { operation, args, now }) {
      const method = validate(operation, args, false);
      const { store, storage } = open(record, now);
      // Legacy attempt repair is a write and cannot be hidden inside GET/query.
      requireThat(!record?.stateJson || storage.getItem(STORAGE_KEY) === record.stateJson,
        "STATE_MIGRATION_REQUIRED", "Import/migrate the preserved state before querying", 409);
      // The registered tools supply this trusted context. Some canonical
      // methods retain a distinct legacy Website shape without it.
      const result = store[method](clone(args), { source: "webmcp", tool_name: operation });
      validateSchema(schemas[operation].output, result, "result");
      return result;
    },
    async transition(record, { operation, args, requestId, now }) {
      const method = validate(operation, args, true);
      const { store, storage, catalog } = open(record, now);
      const before = store.getSnapshot();
      const priorJson = storage.getItem(STORAGE_KEY);
      const result = operation === "add_library_deck"
        ? store[method](clone(args))
        : store[method](clone(args), { source: "webmcp", tool_name: operation });
      const stateJson = storage.getItem(STORAGE_KEY);
      requireThat(stateJson !== null && stateJson !== priorJson && result.receipt?.replayed !== true,
        "LEGACY_REQUEST_REQUIRES_REFRESH",
        "This imported browser receipt has no durable request proof; recover it without grading again", 409);
      const after = store.getSnapshot();
      let events = [];
      if (operation === "submit_grade") {
        const oldSession = before.sessions[args.session_id];
        const oldDeck = before.personalDecks[oldSession.deckId];
        const cardId = oldSession.currentCardId;
        const oldCard = oldDeck.cards[cardId];
        const newCard = after.personalDecks[oldSession.deckId].cards[cardId];
        const history = newCard.reviewHistory.at(-1);
        requireThat(history?.reviewId === result.review_id &&
          newCard.reviewHistory.length === (oldCard.reviewHistory?.length ?? 0) + 1,
        "ENGINE_INVARIANT", "Canonical grade did not append exactly one review", 503);
        const { review: _review, reviewHistory: _history, ...content } = oldCard;
        events = [{
          // The canonical review ID stays in the exact history payload. The
          // durable sidecar key does not inherit its 32-bit collision bound.
          eventId: await sha256(stableJson({ kind: "meshful-review-event-v1", request_id: requestId })),
          deckId: oldDeck.id, cardId: result.card_id,
          payloadJson: JSON.stringify({
            schema_version: 1, request_id: requestId, session_id: args.session_id,
            catalog_ref: catalog.ref, deck_source: oldDeck.source ?? null,
            card_version: content, card_revision: oldCard.contentRevision ?? 1,
            review: history, provenance: "canonical-durable-commit",
          }),
        }];
      }
      if (operation === "add_library_deck") {
        // Installation is a Website-owned legacy action, outside the 13 tools.
        result.receipt = {
          ...result.receipt, transaction_id: `durable-install:${requestId}`,
          idempotency_key: requestId, replayed: false, committed_at: now,
        };
      } else validateSchema(schemas[operation].output, result, "result");
      return { stateJson, catalogRef: clone(catalog.ref), result, events };
    },
    async importLocal(rawJson, ref, { now }) {
      const parsed = assertJson(JSON.parse(rawJson));
      object(parsed, "local state");
      requireThat([1, 2].includes(parsed.schemaVersion) && Number.isSafeInteger(parsed.revision) && parsed.revision >= 0,
        "INVALID_LOCAL_STATE", "Only canonical schema1/schema2 local state may be claimed");
      for (const field of ["personalDecks", "sessions", "actionReceipts"]) object(parsed[field], `local state.${field}`);
      requireThat(Array.isArray(parsed.actionReceiptOrder), "INVALID_LOCAL_STATE", "Missing local action receipt order");
      const { store, storage, catalog } = open({ stateJson: rawJson, catalogRef: ref }, now);
      const hydrated = store.getSnapshot();
      // Force traversal now so failures preserve both database and local bytes.
      assertJson(hydrated);
      validateLocalSnapshot(hydrated, store);
      const stateJson = storage.getItem(STORAGE_KEY);
      requireThat(stateJson !== null, "INVALID_LOCAL_STATE", "Canonical importer discarded the supplied state");
      return {
        stateJson, catalogRef: clone(catalog.ref), events: [],
        result: {
          imported: true, legacy_schema: parsed.schemaVersion,
          app_revision: hydrated.revision, migrated: stateJson !== rawJson,
          legacy_history_provenance: "Preserved as supplied; missing historical card/source versions cannot be reconstructed.",
        },
      };
    },
  });
}
