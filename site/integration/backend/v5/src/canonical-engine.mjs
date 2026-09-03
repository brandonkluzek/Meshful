import {
  assertJson, catalogRef, checkSchema, clone, exactKeys, object, requireThat, sha256, stableJson, text, validateSchema,
} from "../../src/contracts.mjs";
import { validateLocalSnapshot } from "../../src/local-state-validation.mjs";
import {
  READ_METHODS as V3_READ_METHODS,
  WRITE_METHODS as V3_WRITE_METHODS,
  STORAGE_KEY,
} from "../../src/canonical-engine.mjs";
import { capacityForSchemas, MAX_HYDRATED_NODES } from "../../v2/src/capacity.mjs";
import { assertJsonTextBudget } from "../../v2/src/json-budget.mjs";

export const READ_METHODS = V3_READ_METHODS;
export const WRITE_METHODS = Object.freeze({
  ...V3_WRITE_METHODS,
  set_deck_archived: "setDeckArchived",
});
export { STORAGE_KEY };

const RESOLVER_KIND = "meshful-library-catalog-resolver.v1";
const RESOLVED_VIEW_KIND = "meshful-library-runtime-catalog-view.v1";
const INSTALL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    library_deck_id: { type: "string", minLength: 1, maxLength: 160 },
    expected_catalog_version: { type: "string", minLength: 1, maxLength: 128 },
    client_action_id: { type: "string", minLength: 1, maxLength: 128 },
  },
  required: ["library_deck_id", "expected_catalog_version", "client_action_id"],
};
const ARCHIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    deck_id: { type: "string", minLength: 1, maxLength: 160 },
    archived: { type: "boolean" },
    expected_revision: { type: "integer", minimum: 1 },
    client_action_id: { type: "string", minLength: 1, maxLength: 128 },
  },
  required: ["deck_id", "archived", "expected_revision", "client_action_id"],
};

function inputSchema(operation, schemas) {
  if (operation === "add_library_deck") return INSTALL_SCHEMA;
  if (operation === "set_deck_archived") return ARCHIVE_SCHEMA;
  return schemas[operation].input;
}

function actionIdentity(operation, args) {
  return ["add_library_deck", "set_deck_archived"].includes(operation)
    ? args.client_action_id
    : args.idempotency_key;
}

function validateArchiveResult(result, args) {
  assertJson(result);
  exactKeys(result, ["ok", "deck", "visible_effect", "app_revision", "receipt"], undefined, "archive result");
  requireThat(result.ok === true, "ENGINE_INVARIANT", "Archive did not return a successful canonical result", 503);
  exactKeys(result.visible_effect, ["type", "deck_id"], undefined, "archive visible effect");
  requireThat(result.visible_effect.type === (args.archived ? "deck_archived" : "deck_restored")
    && result.visible_effect.deck_id === args.deck_id,
  "ENGINE_INVARIANT", "Archive visible effect differs from the committed intent", 503);
  requireThat(result.deck?.id === args.deck_id && result.deck.archived === args.archived
    && Number.isSafeInteger(result.deck.revision) && result.deck.revision === args.expected_revision + 1,
  "ENGINE_INVARIANT", "Archive result differs from the committed deck revision", 503);
  exactKeys(result.receipt,
    ["client_action_id", "operation", "previous_app_revision", "app_revision"], undefined, "archive receipt");
  requireThat(result.receipt.client_action_id === args.client_action_id
    && result.receipt.operation === "set_deck_archived"
    && Number.isSafeInteger(result.app_revision)
    && result.receipt.app_revision === result.app_revision
    && Number.isSafeInteger(result.receipt.previous_app_revision)
    && result.receipt.previous_app_revision + 1 === result.app_revision,
  "ENGINE_INVARIANT", "Archive receipt differs from the committed canonical action", 503);
}

function sameReference(left, right) {
  return stableJson(left) === stableJson(right);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

function frozenClone(value) {
  return deepFreeze(clone(value));
}

function digest(value, label) {
  requireThat(typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value),
    "CATALOG_PIN_INVALID", `${label} must be an exact SHA-256 pin`, 503);
  return value;
}

function validatedExpectedPins(value) {
  requireThat(Array.isArray(value) && value.length >= 1 && value.length <= 21,
    "CATALOG_PIN_INVALID", "expectedCatalogPins must contain 1..21 exact releases", 503);
  const releases = value.map((entry, index) => {
    exactKeys(entry, ["constructorCatalogRef", "sourcePins"], undefined, `expectedCatalogPins[${index}]`);
    catalogRef(entry.constructorCatalogRef);
    exactKeys(entry.sourcePins, [
      "descriptorDigest", "sourceManifestDigest", "preparedConstructorDigest", "rawCatalogRef", "dependencyGraphDigest",
    "normalizationVersion", "criterionDerivationVersion",
    ], undefined, `expectedCatalogPins[${index}].sourcePins`);
    digest(entry.sourcePins.descriptorDigest, "descriptorDigest");
    digest(entry.sourcePins.sourceManifestDigest, "sourceManifestDigest");
    digest(entry.sourcePins.preparedConstructorDigest, "preparedConstructorDigest");
    catalogRef(entry.sourcePins.rawCatalogRef);
    digest(entry.sourcePins.dependencyGraphDigest, "dependencyGraphDigest");
    text(entry.sourcePins.normalizationVersion, "normalizationVersion", 128);
    text(entry.sourcePins.criterionDerivationVersion, "criterionDerivationVersion", 128);
    return clone(entry);
  });
  const keys = releases.map((entry) => stableJson(entry.constructorCatalogRef));
  requireThat(new Set(keys).size === keys.length,
    "CATALOG_PIN_INVALID", "expectedCatalogPins repeats a constructor release", 503);
  return releases;
}

function validatedResolutionBudget(value) {
  exactKeys(value, ["max_decks", "max_cards", "max_raw_chunk_bytes"], undefined,
    "expectedResolutionBudget");
  for (const [name, maximum] of [["max_decks", 10_000], ["max_cards", 1_000_000], ["max_raw_chunk_bytes", 64_000_000]]) {
    requireThat(Number.isSafeInteger(value[name]) && value[name] >= 1 && value[name] <= maximum,
      "CATALOG_CAPACITY_INVALID", `expectedResolutionBudget.${name} is outside the reviewed bound`, 503);
  }
  return frozenClone(value);
}

function resolutionLimit(value) {
  return {
    decks: value.max_decks,
    cards: value.max_cards,
    raw_chunk_bytes: value.max_raw_chunk_bytes,
  };
}

function validatedResolver(value, expectedReleases, expectedBudget) {
  requireThat(value?.kind === RESOLVER_KIND
    && typeof value.resolveTransaction === "function"
    && Object.isFrozen(value)
    && Object.isFrozen(value.constructorCatalogRef)
    && Object.isFrozen(value.resolutionBudget),
  "CATALOG_RESOLVER_UNAVAILABLE", "A frozen verified Library resolver is required", 503);
  catalogRef(value.constructorCatalogRef);
  const refs = value.constructorCatalogRefs ?? [value.constructorCatalogRef];
  requireThat(Array.isArray(refs) && refs.every((ref) => {
    try { catalogRef(ref); return true; } catch { return false; }
  }) && stableJson(refs) === stableJson(expectedReleases.map((entry) => entry.constructorCatalogRef))
    && sameReference(value.constructorCatalogRef, refs[0]),
  "CATALOG_PIN_MISMATCH", "Library resolver releases differ from deployment configuration", 503);
  requireThat(sameReference(value.resolutionBudget, expectedBudget),
    "CATALOG_CAPACITY_MISMATCH", "Library resolver capacity differs from deployment configuration", 503);
  return value;
}

function validateCatalogView(view, expectedPins, partial) {
  const library = view?.library;
  requireThat(view?.kind === RESOLVED_VIEW_KIND && Object.isFrozen(view)
    && library && Object.isFrozen(library)
    && library.partial === partial
    && sameReference(library.constructorCatalogRef, expectedPins.constructorCatalogRef)
    && sameReference(library.catalogRef, expectedPins.sourcePins.rawCatalogRef)
    && library.dependencyGraphDigest === expectedPins.sourcePins.dependencyGraphDigest
    && library.sourceManifestDigest === expectedPins.sourcePins.sourceManifestDigest
    && library.descriptorDigest === expectedPins.sourcePins.descriptorDigest
    && library.normalizationVersion === expectedPins.sourcePins.normalizationVersion
    && library.criterionDerivationVersion === expectedPins.sourcePins.criterionDerivationVersion,
  "CATALOG_PIN_MISMATCH", "Resolved Library view pins differ from deployment configuration", 503);
}

function validatedResolution(value, expectedPins, releaseByConstructor, expectedBudget) {
  const expectedRef = expectedPins.constructorCatalogRef;
  requireThat(value && value.storeCatalogView?.kind === RESOLVED_VIEW_KIND
    && Array.isArray(value.retainedCatalogViews)
    && sameReference(value.constructorCatalogRef, expectedRef),
  "CATALOG_RESOLVER_INVALID", "The Library resolver returned an invalid exact catalog view", 503);
  requireThat(Object.isFrozen(value) && Object.isFrozen(value.storeCatalogView)
    && value.retainedCatalogViews.every((catalog) => Object.isFrozen(catalog)),
  "CATALOG_RESOLVER_INVALID", "Resolved Library views must retain verified frozen identity", 503);
  requireThat(sameReference(value.sourcePins, expectedPins.sourcePins),
    "CATALOG_PIN_MISMATCH", "Resolved Library source pins differ from deployment configuration", 503);
  requireThat(Object.isFrozen(value.resolution)
    && sameReference(value.resolution.limit, resolutionLimit(expectedBudget)),
  "CATALOG_CAPACITY_MISMATCH", "Resolved Library capacity differs from deployment configuration", 503);
  const required = value.resolution.required;
  requireThat(required && ["decks", "cards", "raw_chunk_bytes"].every((name) =>
    Number.isSafeInteger(required[name]) && required[name] >= 0 && required[name] <= expectedBudget[`max_${name}`]),
  "CATALOG_RESOLVER_INVALID", "Resolved Library working-set measurement is invalid", 503);
  validateCatalogView(value.storeCatalogView, expectedPins, false);
  const seen = new Set([stableJson(expectedRef)]);
  for (const view of value.retainedCatalogViews) {
    const key = stableJson(view?.library?.constructorCatalogRef);
    const retained = releaseByConstructor.get(key);
    requireThat(retained && !seen.has(key),
      "CATALOG_PIN_MISMATCH", "Resolved retained Library release is absent or repeated", 503);
    validateCatalogView(view, retained, true);
    seen.add(key);
  }
  return value;
}

function resolverIntent(kind, operation, args) {
  let projected = {};
  if (operation === "get_deck" && args?.scope === "library") {
    projected = { scope: "library", deck_id: args.deck_id };
  } else if (operation === "add_library_deck") {
    projected = {
      library_deck_id: args.library_deck_id,
      expected_catalog_version: args.expected_catalog_version,
    };
  }
  return { kind, operation, args: projected };
}

function usesCurrentLibraryRelease(operation, args) {
  return operation === "search_library"
    || operation === "add_library_deck"
    || (operation === "get_deck" && args?.scope === "library");
}

// This adapter owns only async resolution, storage and dispatch. Scheduling,
// prerequisite decisions, Library normalization and card identity remain in
// the injected shared core and its verified resolver.
export async function createCanonicalEngine({
  createStudyStore,
  createMemoryStorage,
  toolSchemas,
  catalogResolver,
  expectedCatalogPins,
  expectedResolutionBudget,
  timeZone,
}) {
  requireThat(typeof createStudyStore === "function" && typeof createMemoryStorage === "function",
    "ENGINE_UNAVAILABLE", "Canonical store exports are required", 503);
  const releases = frozenClone(validatedExpectedPins(expectedCatalogPins));
  const resolutionBudget = validatedResolutionBudget(expectedResolutionBudget);
  const releaseByConstructor = new Map(releases.map((entry) => [stableJson(entry.constructorCatalogRef), entry]));
  const resolver = validatedResolver(catalogResolver, releases, resolutionBudget);
  const defaultCatalogRef = frozenClone(resolver.constructorCatalogRef);
  const schemas = clone(toolSchemas);
  for (const name of [...Object.keys(READ_METHODS), ...Object.keys(WRITE_METHODS)]) {
    if (["add_library_deck", "set_deck_archived"].includes(name)) continue;
    requireThat(schemas[name]?.input && schemas[name]?.output,
      "CONTRACT_UNSUPPORTED", `Missing canonical schema: ${name}`, 503);
    checkSchema(schemas[name].input);
    checkSchema(schemas[name].output);
  }
  const capacity = capacityForSchemas(schemas);

  function validate(operation, args, writing) {
    const methods = writing ? WRITE_METHODS : READ_METHODS;
    requireThat(Object.hasOwn(methods, operation),
      "OPERATION_NOT_ALLOWED", "Operation is not available on this endpoint");
    assertJson(args, { maxNodes: capacity.maxCommandNodes });
    validateSchema(inputSchema(operation, schemas), args);
    return methods[operation];
  }

  async function open(record, now, intent) {
    const recordedConstructorCatalogRef = clone(record?.catalogRef ?? defaultCatalogRef);
    catalogRef(recordedConstructorCatalogRef);
    // Library browse/preview and a new install target the deployment's current
    // release. The resolver still hydrates every saved immutable base from the
    // recorded/retained release. Other reads and writes stay on the account's
    // recorded constructor until an install commits the promotion atomically.
    const constructorCatalogRef = clone(usesCurrentLibraryRelease(intent.operation, intent.args)
      ? defaultCatalogRef
      : recordedConstructorCatalogRef);
    catalogRef(constructorCatalogRef);
    const pins = releaseByConstructor.get(stableJson(constructorCatalogRef));
    requireThat(pins,
      "CATALOG_UNAVAILABLE", "Restore this account's exact constructor catalog before using learner state", 409);
    if (record?.stateJson) assertJsonTextBudget(record.stateJson, { maxNodes: capacity.maxStateNodes });
    const resolved = validatedResolution(await resolver.resolveTransaction({
      constructorCatalogRef,
      stateJson: record?.stateJson ?? null,
      intent: resolverIntent(intent.kind, intent.operation, intent.args),
    }), pins, releaseByConstructor, resolutionBudget);
    const storage = createMemoryStorage(record?.stateJson ? { [STORAGE_KEY]: record.stateJson } : {});
    const options = {
      catalog: resolved.storeCatalogView,
      retainedCatalogs: resolved.retainedCatalogViews,
      storage,
      clock: () => new Date(now),
    };
    // A remote learner timezone must come from a separately authenticated
    // settings contract. Undefined preserves the shared core's current gate.
    if (timeZone !== undefined) options.timeZone = timeZone;
    let store;
    try {
      store = createStudyStore(options);
    } catch (error) {
      // Claims contain untrusted preserved browser state. Canonical hydration
      // failures describe that snapshot, while resolver/catalog failures still
      // describe server capabilities needed to recover it and must retain their
      // exact fail-closed code.
      if (intent.kind !== "claim"
        || error?.code === "CATALOG_BASE_UNAVAILABLE"
        || error?.code === "CATALOG_UNAVAILABLE"
        || error?.code === "LIBRARY_RESOLUTION_LIMIT_EXCEEDED"
        || error?.code === "SERVICE_BUSY"
        || error?.code === "INPUT_TOO_LARGE") throw error;
      requireThat(false, "INVALID_LOCAL_STATE",
        "Local state failed canonical hydration; preserve the original bytes for recovery");
    }
    return { resolved, storage, store, constructorCatalogRef };
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
    return {
      deckId: deck.id,
      source: deck.source ?? null,
      libraryBase: deck.libraryBase ?? null,
      cardId: card.id,
      cardRevision: card.contentRevision ?? 1,
      content,
      historyLength: reviewHistory?.length ?? 0,
    };
  }

  function reviewAfter(store, before) {
    const card = store.getSnapshot().personalDecks[before.deckId].cards[before.cardId];
    return { history: card.reviewHistory.at(-1), count: card.reviewHistory.length };
  }

  function reviewRelease(resolved, before, accountConstructorCatalogRef) {
    if (!before.libraryBase) {
      const release = releaseByConstructor.get(stableJson(accountConstructorCatalogRef));
      return {
        constructorCatalogRef: accountConstructorCatalogRef,
        sourcePins: release.sourcePins,
      };
    }
    const base = before.libraryBase;
    const matchingViews = [resolved.storeCatalogView, ...resolved.retainedCatalogViews].filter((view) => {
      const library = view.library;
      const pin = library.decks?.[base.catalogDeckId];
      return sameReference(library.catalogRef, base.catalogRef)
        && library.dependencyGraphDigest === base.dependencyGraphDigest
        && library.normalizationVersion === base.normalizationVersion
        && pin?.catalogVersion === base.catalogVersion
        && pin.payloadDigest === base.payloadDigest
        && pin.artifactDigest === base.artifactDigest;
    });
    requireThat(matchingViews.length === 1,
      "CATALOG_PIN_MISMATCH", "The reviewed deck does not have one exact resolved Library release", 503);
    const constructorCatalogRef = matchingViews[0].library.constructorCatalogRef;
    const release = releaseByConstructor.get(stableJson(constructorCatalogRef));
    requireThat(release,
      "CATALOG_PIN_MISMATCH", "The reviewed Library release is absent from deployment pins", 503);
    return { constructorCatalogRef, sourcePins: release.sourcePins };
  }

  return Object.freeze({
    capacity,
    resolutionBudget: frozenClone(resolutionBudget),
    defaultCatalogRef: frozenClone(defaultCatalogRef),
    catalogSourcePins: frozenClone(releases),
    validateCommand(operation, args, requestId) {
      validate(operation, args, true);
      requireThat(actionIdentity(operation, args) === requestId,
        "REQUEST_ID_MISMATCH", "request_id must equal the canonical action identity");
    },
    async query(record, { operation, args, now }) {
      const method = validate(operation, args, false);
      const { store, storage } = await open(record, now, { kind: "query", operation, args: clone(args) });
      requireThat(!record?.stateJson || storage.getItem(STORAGE_KEY) === record.stateJson,
        "STATE_MIGRATION_REQUIRED", "Claim/migrate the preserved state before querying", 409);
      const result = store[method](clone(args), { source: "webmcp", tool_name: operation });
      validateSchema(schemas[operation].output, result, "result");
      return result;
    },
    async transition(record, { operation, args, requestId, now }) {
      const method = validate(operation, args, true);
      const { resolved, store, storage, constructorCatalogRef } = await open(record, now, {
        kind: "transition", operation, args: clone(args),
      });
      const before = operation === "submit_grade" ? reviewBefore(store, args) : null;
      const priorJson = storage.getItem(STORAGE_KEY);
      const result = operation === "add_library_deck"
        ? store[method](clone(args))
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
        const actualCatalogRef = before.libraryBase?.catalogRef ?? constructorCatalogRef;
        catalogRef(actualCatalogRef);
        const reviewedRelease = reviewRelease(resolved, before, constructorCatalogRef);
        events.push({
          eventId: await sha256(stableJson({
            kind: "meshful-review-event-v1", request_id: requestId,
          })),
          deckId: before.deckId,
          cardId: result.card_id,
          payloadJson: JSON.stringify({
            schema_version: 2,
            request_id: requestId,
            session_id: args.session_id,
            constructor_catalog_ref: constructorCatalogRef,
            reviewed_constructor_catalog_ref: reviewedRelease.constructorCatalogRef,
            reviewed_source_pins: reviewedRelease.sourcePins,
            catalog_ref: actualCatalogRef,
            library_base: before.libraryBase,
            deck_source: before.source,
            card_version: before.content,
            card_revision: before.cardRevision,
            review: after.history,
            provenance: "canonical-durable-commit",
          }),
        });
      }
      if (operation === "set_deck_archived") validateArchiveResult(result, args);
      if (["add_library_deck", "set_deck_archived"].includes(operation)) {
        result.receipt = {
          ...result.receipt,
          transaction_id: operation === "add_library_deck"
            ? `durable-install:${requestId}`
            : `durable-archive:${requestId}`,
          idempotency_key: requestId,
          replayed: false,
          committed_at: now,
        };
      } else {
        validateSchema(schemas[operation].output, result, "result");
      }
      return { stateJson, catalogRef: constructorCatalogRef, result, events };
    },
    async importLocal(rawJson, ref, { now }) {
      const parsed = assertJson(JSON.parse(rawJson), { maxNodes: capacity.maxStateNodes });
      object(parsed, "local state");
      requireThat([1, 2].includes(parsed.schemaVersion)
        && Number.isSafeInteger(parsed.revision) && parsed.revision >= 0,
      "INVALID_LOCAL_STATE", "Only canonical schema1/schema2 local state may be claimed");
      for (const field of ["personalDecks", "sessions", "actionReceipts"]) {
        object(parsed[field], `local state.${field}`);
      }
      requireThat(Array.isArray(parsed.actionReceiptOrder),
        "INVALID_LOCAL_STATE", "Missing local action receipt order");
      const { store, storage, constructorCatalogRef } = await open({ stateJson: rawJson, catalogRef: ref }, now, {
        kind: "claim", operation: "claim_local_state", args: {},
      });
      const hydrated = store.getSnapshot();
      assertJson(hydrated, { maxNodes: MAX_HYDRATED_NODES });
      validateLocalSnapshot(hydrated, store);
      const stateJson = storage.getItem(STORAGE_KEY);
      requireThat(stateJson !== null,
        "INVALID_LOCAL_STATE", "Canonical importer discarded the supplied state");
      return {
        stateJson,
        catalogRef: constructorCatalogRef,
        events: [],
        result: {
          imported: true,
          legacy_schema: parsed.schemaVersion,
          app_revision: hydrated.revision,
          migrated: stateJson !== rawJson,
          legacy_history_provenance: "Preserved as supplied; missing historical card/source versions cannot be reconstructed.",
        },
      };
    },
  });
}
