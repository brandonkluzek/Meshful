import {
  assertJson, catalogRef, checkSchema, clone, object, requireThat, sha256, stableJson, text, validateSchema,
} from "../../src/contracts.mjs";
import { validateLocalSnapshot } from "../../src/local-state-validation.mjs";
import { READ_METHODS, WRITE_METHODS, STORAGE_KEY } from "../../src/canonical-engine.mjs";
import { capacityForSchemas, MAX_CATALOG_NODES, MAX_HYDRATED_NODES } from "./capacity.mjs";
import { assertJsonTextBudget } from "./json-budget.mjs";

export { READ_METHODS, WRITE_METHODS, STORAGE_KEY };
const INSTALL_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    library_deck_id: { type: "string", minLength: 1, maxLength: 160 },
    expected_catalog_version: { type: "string", minLength: 1, maxLength: 128 },
    client_action_id: { type: "string", minLength: 1, maxLength: 128 },
  }, required: ["library_deck_id", "expected_catalog_version", "client_action_id"],
};

function deepFrozen(value) {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}
function freezeJson(value) {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeJson);
    Object.freeze(value);
  }
  return value;
}

// Only storage/dispatch changes live here. Every mutation and prerequisite /
// scheduling decision executes in the injected, owner-maintained shared core.
export async function createCanonicalEngine({ createStudyStore, createMemoryStorage, toolSchemas, catalogs, defaultCatalogVersion }) {
  requireThat(typeof createStudyStore === "function" && typeof createMemoryStorage === "function",
    "ENGINE_UNAVAILABLE", "Canonical store exports are required", 503);
  const schemas = clone(toolSchemas);
  for (const name of [...Object.keys(READ_METHODS), ...Object.keys(WRITE_METHODS)]) {
    if (name === "add_library_deck") continue;
    requireThat(schemas[name]?.input && schemas[name]?.output, "CONTRACT_UNSUPPORTED", `Missing canonical schema: ${name}`, 503);
    checkSchema(schemas[name].input); checkSchema(schemas[name].output);
  }
  const capacity = capacityForSchemas(schemas);
  const registry = new Map();
  for (const entry of catalogs ?? []) {
    text(entry.version, "catalog version");
    requireThat(!registry.has(entry.version), "CATALOG_CONFLICT", "Duplicate catalog release", 503);
    assertJson(entry.catalog, { maxNodes: MAX_CATALOG_NODES });
    const prepared = entry.catalog?.kind === "meshful-library-runtime-catalog.v1";
    // prepareLibraryCatalog belongs to WebMCP. Preserve its exact frozen object
    // identity so shared-core normalization can be reused across transactions.
    requireThat(!prepared || deepFrozen(entry.catalog), "CATALOG_NOT_PREPARED",
      "The host must supply WebMCP's verified frozen Library input", 503);
    const raw = prepared ? entry.catalog : freezeJson(clone(entry.catalog));
    const digest = await sha256(stableJson(raw, { maxNodes: MAX_CATALOG_NODES }));
    requireThat(!entry.digest || entry.digest === digest, "CATALOG_CONFLICT", "Catalog constructor-input digest mismatch", 503);
    registry.set(entry.version, { ref: { version: entry.version, digest }, raw });
  }
  requireThat(registry.has(defaultCatalogVersion), "CATALOG_UNAVAILABLE", "Default catalog is missing", 503);

  function catalogFor(ref) {
    if (!ref) return registry.get(defaultCatalogVersion);
    catalogRef(ref);
    const entry = registry.get(ref.version);
    requireThat(entry?.ref.digest === ref.digest, "CATALOG_UNAVAILABLE",
      "Restore this exact pinned constructor input before using the learner state", 409);
    return entry;
  }
  function open(record, now) {
    const catalog = catalogFor(record?.catalogRef);
    if (record?.stateJson) assertJsonTextBudget(record.stateJson, { maxNodes: capacity.maxStateNodes });
    const storage = createMemoryStorage(record?.stateJson ? { [STORAGE_KEY]: record.stateJson } : {});
    const store = createStudyStore({ catalog: catalog.raw, storage, clock: () => new Date(now) });
    return { catalog, storage, store };
  }
  function validate(operation, args, writing) {
    const methods = writing ? WRITE_METHODS : READ_METHODS;
    requireThat(Object.hasOwn(methods, operation), "OPERATION_NOT_ALLOWED", "Operation is not available on this endpoint");
    assertJson(args, { maxNodes: capacity.maxCommandNodes });
    validateSchema(operation === "add_library_deck" ? INSTALL_SCHEMA : schemas[operation].input, args);
    return methods[operation];
  }
  function reviewBefore(store, args) {
    const snapshot = store.getSnapshot();
    const session = snapshot.sessions[args.session_id];
    // Invalid commands still get their exact error from the canonical method.
    if (!session) return null;
    const deck = snapshot.personalDecks[session.deckId];
    const card = deck?.cards[session.currentCardId];
    if (!card) return null;
    const { review: _schedule, reviewHistory, ...content } = card;
    return { deckId: deck.id, source: deck.source ?? null, cardId: card.id,
      cardRevision: card.contentRevision ?? 1, content, historyLength: reviewHistory?.length ?? 0 };
  }
  function reviewAfter(store, before) {
    const card = store.getSnapshot().personalDecks[before.deckId].cards[before.cardId];
    return { history: card.reviewHistory.at(-1), count: card.reviewHistory.length };
  }

  return Object.freeze({
    capacity,
    defaultCatalogRef: clone(registry.get(defaultCatalogVersion).ref),
    validateCommand(operation, args, requestId) {
      validate(operation, args, true);
      requireThat((operation === "add_library_deck" ? args.client_action_id : args.idempotency_key) === requestId,
        "REQUEST_ID_MISMATCH", "request_id must equal the canonical action identity");
    },
    async query(record, { operation, args, now }) {
      const method = validate(operation, args, false);
      const { store, storage } = open(record, now);
      requireThat(!record?.stateJson || storage.getItem(STORAGE_KEY) === record.stateJson,
        "STATE_MIGRATION_REQUIRED", "Claim/migrate the preserved state before querying", 409);
      const result = store[method](clone(args), { source: "webmcp", tool_name: operation });
      validateSchema(schemas[operation].output, result, "result");
      return result;
    },
    async transition(record, { operation, args, requestId, now }) {
      const method = validate(operation, args, true);
      const { store, storage, catalog } = open(record, now);
      // Non-grade operations need no full before/after snapshot. Grades retain
      // only the affected original content and append count between snapshots.
      const before = operation === "submit_grade" ? reviewBefore(store, args) : null;
      const priorJson = storage.getItem(STORAGE_KEY);
      const result = operation === "add_library_deck" ? store[method](clone(args))
        : store[method](clone(args), { source: "webmcp", tool_name: operation });
      const stateJson = storage.getItem(STORAGE_KEY);
      requireThat(stateJson !== null && stateJson !== priorJson && result.receipt?.replayed !== true,
        "LEGACY_REQUEST_REQUIRES_REFRESH", "This browser receipt has no durable request proof; recover without grading again", 409);
      const events = [];
      if (operation === "submit_grade") {
        requireThat(before, "ENGINE_INVARIANT", "Canonical grade has no original card", 503);
        const after = reviewAfter(store, before);
        requireThat(after.history?.reviewId === result.review_id && after.count === before.historyLength + 1,
          "ENGINE_INVARIANT", "Canonical grade did not append exactly one review", 503);
        events.push({
          eventId: await sha256(stableJson({ kind: "meshful-review-event-v1", request_id: requestId })),
          deckId: before.deckId, cardId: result.card_id,
          payloadJson: JSON.stringify({ schema_version: 1, request_id: requestId, session_id: args.session_id,
            catalog_ref: catalog.ref, deck_source: before.source, card_version: before.content,
            card_revision: before.cardRevision, review: after.history, provenance: "canonical-durable-commit" }),
        });
      }
      if (operation === "add_library_deck") {
        result.receipt = { ...result.receipt, transaction_id: `durable-install:${requestId}`,
          idempotency_key: requestId, replayed: false, committed_at: now };
      } else validateSchema(schemas[operation].output, result, "result");
      return { stateJson, catalogRef: clone(catalog.ref), result, events };
    },
    async importLocal(rawJson, ref, { now }) {
      const parsed = assertJson(JSON.parse(rawJson), { maxNodes: capacity.maxStateNodes });
      object(parsed, "local state");
      requireThat([1, 2].includes(parsed.schemaVersion) && Number.isSafeInteger(parsed.revision) && parsed.revision >= 0,
        "INVALID_LOCAL_STATE", "Only canonical schema1/schema2 local state may be claimed");
      for (const field of ["personalDecks", "sessions", "actionReceipts"]) object(parsed[field], `local state.${field}`);
      requireThat(Array.isArray(parsed.actionReceiptOrder), "INVALID_LOCAL_STATE", "Missing local action receipt order");
      const { store, storage, catalog } = open({ stateJson: rawJson, catalogRef: ref }, now);
      const hydrated = store.getSnapshot();
      assertJson(hydrated, { maxNodes: MAX_HYDRATED_NODES });
      validateLocalSnapshot(hydrated, store);
      const stateJson = storage.getItem(STORAGE_KEY);
      requireThat(stateJson !== null, "INVALID_LOCAL_STATE", "Canonical importer discarded the supplied state");
      return { stateJson, catalogRef: clone(catalog.ref), events: [], result: {
        imported: true, legacy_schema: parsed.schemaVersion, app_revision: hydrated.revision, migrated: stateJson !== rawJson,
        legacy_history_provenance: "Preserved as supplied; missing historical card/source versions cannot be reconstructed.",
      } };
    },
  });
}
