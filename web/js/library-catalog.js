const PROJECTION_VERSION = "meshful-library-catalog-input.v1";
const IDENTITY_VERSION = "canonical-library-card-identity.v1";
const RUNTIME_CATALOG_KIND = "meshful-library-runtime-catalog.v1";
const RUNTIME_ARTIFACT_KIND = "meshful-library-runtime-artifact.v1";
const RESOLVER_INDEX_VERSION = "meshful-library-exact-ref-index.v1";
const RESOLVER_CHUNK_VERSION = "meshful-library-exact-ref-deck.v1";
const RESOLVER_KIND = "meshful-library-catalog-resolver.v1";
const RESOLVER_VIEW_KIND = "meshful-library-runtime-catalog-view.v1";
const RELEASE_BOUNDARY_FIELDS = Object.freeze([
  "audience",
  "public_release_approved",
  "rights_status",
  "current_runtime_compatible",
]);
const PRIVATE_LIBRARY_RELEASE_BOUNDARY = Object.freeze({
  audience: "private",
  public_release_approved: false,
  rights_status: "not-cleared",
  current_runtime_compatible: false,
});
const PUBLIC_LIBRARY_RELEASE_BOUNDARY = Object.freeze({
  audience: "public",
  public_release_approved: true,
  rights_status: "cc-by-4.0",
  current_runtime_compatible: true,
});
const PUBLIC_LIBRARY_CATALOG_REF = Object.freeze({
  version: "2026-09-02.public-sanitized-72.v2",
  digest: "sha256:a7ef2efa1d6133879ab8daf6068ff88a17abc23be1590d39932cea82b0ec8642",
});
const PUBLIC_LIBRARY_GRAPH_SHA256 = "sha256:82025162442152929780e8bcf42066361b8ebc1602c899b1f706f621b2257ce0";
export const DEFAULT_LIBRARY_RESOLUTION_BUDGET = Object.freeze({
  max_decks: 42,
  max_cards: 5_500,
  max_raw_chunk_bytes: 7_000_000,
});
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const BARE_SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const INVALID = "INVALID_LIBRARY_CATALOG";
const INTEGRITY = "LIBRARY_CATALOG_INTEGRITY";
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const verifiedPreparedCatalogs = new WeakSet();

// Constructor capability, not a serialized marker. A copied/forged envelope
// must be prepared from its pinned original feed again before store use.
export function isPreparedLibraryCatalog(value) {
  return verifiedPreparedCatalogs.has(value);
}

function requireThat(condition, message, code = INVALID) {
  if (condition) return;
  const error = new Error(message);
  error.name = "LibraryCatalogError";
  error.code = code;
  throw error;
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Do not invoke getters or let non-JSON values acquire a different hashed meaning.
function assertJsonTree(value) {
  const ancestors = new Set();
  let nodes = 0;
  function visit(item, depth) {
    requireThat(++nodes <= 2_000_000 && depth <= 64, "Library input exceeds the JSON validation bound.");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") {
      requireThat(Number.isFinite(item), "Library input contains a non-finite number.");
      return;
    }
    requireThat(Array.isArray(item) || plainObject(item), "Library input must contain only JSON values.");
    requireThat(!ancestors.has(item), "Library input contains a cyclic object.");
    ancestors.add(item);
    const keys = Reflect.ownKeys(item);
    if (Array.isArray(item)) {
      requireThat(keys.length === item.length + 1, "Library arrays must be dense and have no extra properties.");
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        requireThat(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, "value"), "Library arrays must contain ordinary JSON values.");
        visit(descriptor.value, depth + 1);
      }
    } else {
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        requireThat(typeof key === "string" && descriptor.enumerable && Object.hasOwn(descriptor, "value"), "Library objects must contain ordinary enumerable JSON fields.");
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  }
  visit(value, 0);
}

// Independently implements backend-stableJson-sha256.v1. Array order is identity.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function encodedBytes(value, label = "Library bytes") {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  requireThat(false, `${label} must be UTF-8 text or bytes.`);
}

function decodeUtf8(value, label) {
  if (typeof value === "string") return value;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(encodedBytes(value, label));
  } catch {
    requireThat(false, `${label} must be valid UTF-8.`, INTEGRITY);
  }
}

function boundedEncodedCopy(value, label, maximumBytes, code = INVALID) {
  if (typeof value === "string") {
    requireThat(value.length <= maximumBytes, `${label} exceeds its byte bound.`, code);
  } else {
    const view = encodedBytes(value, label);
    requireThat(view.byteLength <= maximumBytes, `${label} exceeds its byte bound.`, code);
  }
  const copy = Uint8Array.from(encodedBytes(value, label));
  requireThat(copy.byteLength <= maximumBytes, `${label} exceeds its byte bound.`, code);
  return copy;
}

async function sha256(encoded) {
  requireThat(typeof globalThis.crypto?.subtle?.digest === "function", "Web Crypto SHA-256 is required to prepare a Library catalog.");
  try {
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", encodedBytes(encoded));
    return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    requireThat(false, "Web Crypto could not verify the Library catalog.");
  }
}

function requireString(value, label, limit = 257) {
  requireThat(typeof value === "string" && value.trim().length > 0 && value.length <= limit, `${label} must be a bounded nonblank string.`);
  return value;
}

function requireId(value, label) {
  requireThat(ID.test(requireString(value, label)), `${label} is not a supported identifier.`);
  return value;
}

function requireDigest(value, label) {
  requireThat(typeof value === "string" && SHA256.test(value), `${label} must be a SHA-256 identity.`);
  return value;
}

function normalizedDigest(value, label) {
  requireThat(typeof value === "string" && (SHA256.test(value) || BARE_SHA256.test(value)), `${label} must be a SHA-256 identity.`);
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function assertCriteria(card, field, usedIds) {
  const items = card[field];
  requireThat(Array.isArray(items) && items.length <= 30, `${field} must be a bounded criterion array.`);
  items.forEach((item, index) => {
    let id;
    if (typeof item === "string") {
      requireString(item, field, 1_000);
      id = `${field.replaceAll("_", "-")}-${index + 1}`;
    } else {
      requireThat(plainObject(item), `${field} contains an invalid criterion.`);
      if (Object.hasOwn(item, "id") && Object.hasOwn(item, "rubric_item_id")) {
        requireThat(item.id === item.rubric_item_id, "Criterion ID aliases disagree.", INTEGRITY);
      }
      id = requireId(item.rubric_item_id ?? item.id, "criterion ID");
      requireString(item.text, "criterion text", 1_000);
    }
    requireThat(!usedIds.has(id), "Criterion IDs must be unique within a card.");
    usedIds.add(id);
  });
}

function edgeKey(parent, child) {
  return `${parent}\u0000${child}`;
}

function edgeComparison(left, right) {
  return compare(left.prerequisite_card_id, right.prerequisite_card_id)
    || compare(left.dependent_card_id, right.dependent_card_id);
}

function deepFreeze(value, seen) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function exactKeys(value, expected, label, code = INVALID) {
  requireThat(plainObject(value), `${label} must be an object.`, code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  requireThat(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    `${label} contains missing or unsupported fields.`, code);
}

function captureResolverReleaseBoundary(value, label) {
  requireThat(plainObject(value), `${label} must be an object.`, INTEGRITY);
  const ownKeys = Reflect.ownKeys(value);
  requireThat(ownKeys.length === RELEASE_BOUNDARY_FIELDS.length
    && ownKeys.every((field) => typeof field === "string" && RELEASE_BOUNDARY_FIELDS.includes(field)),
  `${label} contains missing or unsupported fields.`, INTEGRITY);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const captured = {};
  for (const field of RELEASE_BOUNDARY_FIELDS) {
    const descriptor = descriptors[field];
    requireThat(descriptor?.enumerable && Object.hasOwn(descriptor, "value"),
      `${label} must contain ordinary enumerable JSON fields.`, INTEGRITY);
    captured[field] = descriptor.value;
  }
  const matches = (boundary) => RELEASE_BOUNDARY_FIELDS.every(
    (field) => captured[field] === boundary[field],
  );
  requireThat(matches(PRIVATE_LIBRARY_RELEASE_BOUNDARY)
    || matches(PUBLIC_LIBRARY_RELEASE_BOUNDARY),
  `${label} is not an admitted Library release boundary.`, INTEGRITY);
  return Object.freeze(captured);
}

function requireResolverReleaseBoundaryPins(boundary, catalogRef, graphDigest, label) {
  if (boundary.audience === "private") return boundary;
  requireThat(sameReference(catalogRef, PUBLIC_LIBRARY_CATALOG_REF)
    && graphDigest === PUBLIC_LIBRARY_GRAPH_SHA256,
  `${label} public release boundary does not match the approved catalog and graph pins.`, INTEGRITY);
  return boundary;
}

function sameList(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function idList(value, label) {
  requireThat(Array.isArray(value), `${label} must be an array.`);
  const seen = new Set();
  for (const id of value) {
    requireId(id, label);
    requireThat(!seen.has(id), `${label} must not contain duplicates.`);
    seen.add(id);
  }
  return value;
}

// Runtime artifacts intentionally omit the private source/index maps used to
// construct them. Rebuild every runtime-relevant graph and closure invariant
// from the retained catalog plus thin metadata before granting the module-local
// prepared-catalog capability.
function inspectRuntimeCatalog(prepared) {
  exactKeys(prepared, ["kind", "catalog", "library"], "prepared Library catalog");
  requireThat(prepared.kind === RUNTIME_CATALOG_KIND, "Unsupported prepared Library catalog kind.");
  requireThat(Array.isArray(prepared.catalog) && prepared.catalog.length > 0,
    "A nonempty prepared Library catalog is required.");
  exactKeys(prepared.library,
    ["normalizationVersion", "catalogRef", "dependencyGraphDigest", "decks"], "prepared Library metadata");
  requireThat(prepared.library.normalizationVersion === IDENTITY_VERSION,
    "Unsupported prepared Library identity normalization.");
  exactKeys(prepared.library.catalogRef, ["version", "digest"], "prepared catalog release identity");
  const catalogRef = {
    version: requireString(prepared.library.catalogRef.version, "catalog release version", 128),
    digest: requireDigest(prepared.library.catalogRef.digest, "catalog release digest"),
  };
  const graphDigest = requireDigest(prepared.library.dependencyGraphDigest, "dependency graph digest");
  requireThat(plainObject(prepared.library.decks), "Prepared Library deck metadata is required.");

  const cards = new Map();
  const bySource = new Map();
  const parents = new Map();
  const deckRecords = [];
  let previousDeckId = null;
  for (const deck of prepared.catalog) {
    requireThat(plainObject(deck), "Invalid prepared Library deck.");
    const catalogId = requireId(deck.id, "catalog deck ID");
    requireThat(previousDeckId === null || compare(previousDeckId, catalogId) < 0,
      "Prepared Library decks must retain unique canonical order.", INTEGRITY);
    previousDeckId = catalogId;
    const metadata = Object.hasOwn(prepared.library.decks, catalogId)
      ? prepared.library.decks[catalogId] : null;
    exactKeys(metadata, [
      "sourceDeckId", "catalogDeckId", "catalogVersion", "payloadDigest", "artifactDigest",
      "requiredCatalogDeckIds", "directDependencyCatalogDeckIds",
    ], `prepared metadata for ${catalogId}`);
    const sourceId = requireId(metadata.sourceDeckId, "source deck ID");
    requireThat(!bySource.has(sourceId), "Prepared Library source deck IDs must be unique.", INTEGRITY);
    bySource.set(sourceId, catalogId);
    parents.set(sourceId, new Set());
    requireThat(metadata.catalogDeckId === catalogId && String(deck.version) === metadata.catalogVersion
      && metadata.catalogVersion === catalogRef.version,
    "Prepared Library deck identity or version changed.", INTEGRITY);
    requireDigest(metadata.payloadDigest, "prepared deck payload digest");
    requireDigest(metadata.artifactDigest, "prepared source artifact digest");
    idList(metadata.requiredCatalogDeckIds, "required catalog deck IDs");
    idList(metadata.directDependencyCatalogDeckIds, "direct dependency catalog deck IDs");
    requireThat(Array.isArray(deck.cards) && deck.cards.length > 0 && Array.isArray(deck.edges),
      "Prepared Library decks require cards and local edges.");
    for (const card of deck.cards) {
      requireThat(plainObject(card), "Invalid prepared Library card.");
      const cardId = requireId(card.id, "canonical card ID");
      requireThat(!cards.has(cardId), "Canonical card IDs must be globally unique.");
      requireThat(card.canonical_deck_id === sourceId,
        "Prepared card ownership differs from its deck metadata.", INTEGRITY);
      const criterionIds = new Set();
      assertCriteria(card, "required_concepts", criterionIds);
      assertCriteria(card, "major_error_concepts", criterionIds);
      requireThat(Array.isArray(card.prerequisite_ids), "Every prepared card must retain its prerequisite list.");
      const seenParents = new Set();
      for (const parent of card.prerequisite_ids) {
        requireId(parent, "prerequisite card ID");
        requireThat(parent !== cardId && !seenParents.has(parent),
          "Prerequisites must not repeat or refer to the child itself.");
        seenParents.add(parent);
      }
      cards.set(cardId, { card, catalogId, sourceId });
    }
    deckRecords.push({ deck, metadata, catalogId, sourceId });
  }
  requireThat(Object.keys(prepared.library.decks).length === prepared.catalog.length,
    "Prepared Library deck metadata coverage differs.", INTEGRITY);

  const expectedEdges = new Map();
  const localEdges = new Map(prepared.catalog.map((deck) => [deck.id, new Set()]));
  for (const [child, record] of cards) {
    for (const parent of record.card.prerequisite_ids) {
      const parentRecord = cards.get(parent);
      requireThat(parentRecord, "A prepared prerequisite endpoint is missing.");
      const key = edgeKey(parent, child);
      expectedEdges.set(key, [parent, child]);
      if (parentRecord.catalogId === record.catalogId) localEdges.get(record.catalogId).add(key);
      else parents.get(record.sourceId).add(parentRecord.sourceId);
    }
  }
  for (const { deck, catalogId } of deckRecords) {
    const expected = localEdges.get(catalogId);
    requireThat(deck.edges.length === expected.size,
      "The prepared local required edge projection differs.", INTEGRITY);
    const seen = new Set();
    let previous = null;
    for (const edge of deck.edges) {
      requireThat(plainObject(edge), "Invalid prepared local edge.");
      requireId(edge.prerequisite_card_id, "local prerequisite ID");
      requireId(edge.dependent_card_id, "local dependent ID");
      requireThat(previous === null || edgeComparison(previous, edge) < 0,
        "Prepared local edges changed canonical order.", INTEGRITY);
      previous = edge;
      const key = edgeKey(edge.prerequisite_card_id, edge.dependent_card_id);
      requireThat(expected.has(key) && !seen.has(key),
        "The prepared local edge projection lost, duplicated or changed a requirement.", INTEGRITY);
      seen.add(key);
    }
  }
  assertCardDag(cards, expectedEdges);

  const order = parentFirstDeckOrder(bySource, parents);
  const closures = new Map();
  for (const sourceId of order) {
    const required = new Set([sourceId]);
    for (const parent of parents.get(sourceId)) for (const ancestor of closures.get(parent)) required.add(ancestor);
    closures.set(sourceId, required);
    const metadata = prepared.library.decks[bySource.get(sourceId)];
    const expectedClosure = order.filter((id) => required.has(id)).map((id) => bySource.get(id));
    const expectedDirect = [...parents.get(sourceId)].map((id) => bySource.get(id)).sort();
    requireThat(sameList(metadata.requiredCatalogDeckIds, expectedClosure)
      && sameList(metadata.directDependencyCatalogDeckIds, expectedDirect),
    "Prepared Library dependency closures changed.", INTEGRITY);
  }

  const graph = [...expectedEdges.values()].map(([parent, child]) => ({
    prerequisite_card_id: parent,
    dependent_card_id: child,
    prerequisite_source_deck_id: cards.get(parent).sourceId,
    dependent_source_deck_id: cards.get(child).sourceId,
    requirement: "required",
    gate: "first_introduction",
  })).sort(edgeComparison);
  return { catalogRef, graphDigest, graph, deckRecords };
}

function assertCardDag(cards, expectedEdges) {
  const incoming = new Map([...cards.keys()].map((id) => [id, 0]));
  const outgoing = new Map([...cards.keys()].map((id) => [id, []]));
  for (const [parent, child] of expectedEdges.values()) {
    incoming.set(child, incoming.get(child) + 1);
    outgoing.get(parent).push(child);
  }
  const queue = [...cards.keys()].filter((id) => incoming.get(id) === 0);
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of outgoing.get(queue[index])) {
      incoming.set(child, incoming.get(child) - 1);
      if (incoming.get(child) === 0) queue.push(child);
    }
  }
  requireThat(queue.length === cards.size, "Required card dependencies contain a cycle.");
}

function parentFirstDeckOrder(bySource, parents) {
  const visited = new Set();
  const active = new Set();
  const order = [];
  // This is the candidate's sorted-source DFS order, without recursive stack growth.
  for (const sourceId of [...bySource.keys()].sort()) {
    if (visited.has(sourceId)) continue;
    const stack = [{ id: sourceId, parents: [...parents.get(sourceId)].sort(), cursor: 0 }];
    active.add(sourceId);
    while (stack.length) {
      const frame = stack.at(-1);
      if (frame.cursor === frame.parents.length) {
        stack.pop(); active.delete(frame.id); visited.add(frame.id); order.push(frame.id);
        continue;
      }
      const parent = frame.parents[frame.cursor++];
      requireThat(!active.has(parent), "Required deck dependencies contain a cycle.");
      if (visited.has(parent)) continue;
      active.add(parent);
      stack.push({ id: parent, parents: [...parents.get(parent)].sort(), cursor: 0 });
    }
  }
  return order;
}

/**
 * Bootstrap-only adapter for a feed already admitted by the trusted pinned loader.
 * It verifies runtime-relevant invariants, not signatures, source rights or source
 * file bytes. The same raw catalog is frozen in place; private maps are not retained.
 */
export async function prepareLibraryCatalog(feed) {
  assertJsonTree(feed);
  requireThat(plainObject(feed), "A Library feed object is required.");
  requireThat(feed.projection_schema_version === PROJECTION_VERSION, "Unsupported Library projection schema.");
  requireThat(feed.audience === "private" && feed.public_release_approved === false
    && feed.rights_status === "not-cleared" && feed.current_runtime_compatible === false,
  "Library preparation requires the unchanged private candidate guards.");
  const catalog = feed.catalog;
  requireThat(Array.isArray(catalog) && catalog.length > 0, "A nonempty original Library catalog is required.");
  requireThat(plainObject(feed.catalog_ref), "The catalog release identity is required.");
  const catalogRef = {
    version: requireString(feed.catalog_ref.version, "catalog release version", 128),
    digest: requireDigest(feed.catalog_ref.digest, "catalog release digest"),
  };
  const graphDigest = requireDigest(feed.dependency_graph_sha256, "dependency graph digest");
  requireThat(Array.isArray(feed.dependency_edges), "The full required graph is required.");
  requireThat(plainObject(feed.source_card_index), "The source card index is required.");
  const identities = feed.runtime_identity_map;
  requireThat(plainObject(identities) && identities.normalization_version === IDENTITY_VERSION
    && Array.isArray(identities.decks) && plainObject(identities.cards), "The canonical runtime identity map is required.");

  const mappings = new Map();
  const bySource = new Map();
  for (const mapping of identities.decks) {
    requireThat(plainObject(mapping), "Invalid Library deck mapping.");
    const catalogId = requireId(mapping.catalog_deck_id, "catalog deck ID");
    const sourceId = requireId(mapping.source_deck_id, "source deck ID");
    requireThat(!mappings.has(catalogId) && !bySource.has(sourceId), "Library deck mappings must be one-to-one.");
    requireThat(mapping.personal_deck_id === null && mapping.catalog_deck_version === catalogRef.version,
      "Library deck mapping changed its version or assigned an installation.", INTEGRITY);
    mappings.set(catalogId, mapping); bySource.set(sourceId, catalogId);
  }
  requireThat(mappings.size === catalog.length, "Library deck mapping coverage differs.", INTEGRITY);

  const cards = new Map();
  const decks = Object.create(null);
  const parents = new Map([...bySource.keys()].map((id) => [id, new Set()]));
  let previousDeckId = null;
  for (const deck of catalog) {
    requireThat(plainObject(deck), "Invalid Library catalog deck.");
    const catalogId = requireId(deck.id, "catalog deck ID");
    requireThat(previousDeckId === null || compare(previousDeckId, catalogId) < 0,
      "Original catalog decks must have unique IDs in canonical order.", INTEGRITY);
    previousDeckId = catalogId;
    const mapping = mappings.get(catalogId);
    requireThat(mapping && deck.version === mapping.catalog_deck_version, "Catalog deck version or mapping differs.", INTEGRITY);
    requireThat(Array.isArray(deck.cards) && deck.cards.length > 0 && Array.isArray(deck.edges), "Library decks require cards and local edges.");
    let artifactDigest = null;
    let artifactPath = null;
    deck.cards.forEach((card, index) => {
      requireThat(plainObject(card), "Invalid Library card.");
      const cardId = requireId(card.id, "canonical card ID");
      requireThat(!cards.has(cardId), "Canonical card IDs must be globally unique.");
      const location = feed.source_card_index[cardId];
      const runtime = identities.cards[cardId];
      requireThat(Object.hasOwn(feed.source_card_index, cardId) && plainObject(location)
        && Object.hasOwn(identities.cards, cardId) && plainObject(runtime), "Card identity coverage differs.", INTEGRITY);
      requireThat(card.canonical_deck_id === mapping.source_deck_id
        && location.source_deck_id === mapping.source_deck_id && location.catalog_deck_id === catalogId
        && location.json_pointer === `/cards/${index}`
        && runtime.source_card_id === cardId && runtime.runtime_card_id === cardId
        && runtime.catalog_deck_id === catalogId && runtime.personal_deck_id === null,
      "Canonical card identity, ownership or source order changed.", INTEGRITY);
      const digest = requireDigest(location.artifact_sha256, "source artifact digest");
      const path = requireString(location.artifact_path, "source artifact path", 4_096);
      requireThat(artifactDigest === null || (artifactDigest === digest && artifactPath === path),
        "A Library deck resolves to inconsistent source artifacts.", INTEGRITY);
      artifactDigest = digest; artifactPath = path;
      const criterionIds = new Set();
      assertCriteria(card, "required_concepts", criterionIds);
      assertCriteria(card, "major_error_concepts", criterionIds);
      requireThat(Array.isArray(card.prerequisite_ids), "Every card must retain its full prerequisite list.");
      const seenParents = new Set();
      for (const parent of card.prerequisite_ids) {
        requireId(parent, "prerequisite card ID");
        requireThat(parent !== cardId && !seenParents.has(parent), "Prerequisites must not repeat or refer to the child itself.");
        seenParents.add(parent);
      }
      cards.set(cardId, { card, catalogId, sourceId: mapping.source_deck_id });
    });
    decks[catalogId] = {
      sourceDeckId: mapping.source_deck_id, catalogDeckId: catalogId,
      catalogVersion: deck.version, payloadDigest: null, artifactDigest,
      requiredCatalogDeckIds: [], directDependencyCatalogDeckIds: [],
    };
  }
  requireThat(Object.keys(feed.source_card_index).length === cards.size && Object.keys(identities.cards).length === cards.size,
    "Card identity maps contain missing or extra entries.", INTEGRITY);

  const expectedEdges = new Map();
  const localEdges = new Map(catalog.map((deck) => [deck.id, new Set()]));
  for (const [child, record] of cards) {
    for (const parent of record.card.prerequisite_ids) {
      const parentRecord = cards.get(parent);
      requireThat(parentRecord, "A required prerequisite endpoint is missing.");
      const key = edgeKey(parent, child);
      expectedEdges.set(key, [parent, child]);
      if (parentRecord.catalogId === record.catalogId) localEdges.get(record.catalogId).add(key);
      else parents.get(record.sourceId).add(parentRecord.sourceId);
    }
  }
  requireThat(feed.dependency_edges.length === expectedEdges.size, "The full required graph differs from the card prerequisites.", INTEGRITY);
  let previousEdge = null;
  for (const edge of feed.dependency_edges) {
    requireThat(plainObject(edge), "Invalid required edge.");
    requireId(edge.prerequisite_card_id, "prerequisite card ID");
    requireId(edge.dependent_card_id, "dependent card ID");
    requireThat(previousEdge === null || edgeComparison(previousEdge, edge) < 0,
      "Required edges must be unique and retain canonical order.", INTEGRITY);
    previousEdge = edge;
    const parent = cards.get(edge.prerequisite_card_id);
    const child = cards.get(edge.dependent_card_id);
    requireThat(parent && child, "A required graph endpoint is missing.");
    requireThat(expectedEdges.has(edgeKey(edge.prerequisite_card_id, edge.dependent_card_id))
      && edge.prerequisite_source_deck_id === parent.sourceId && edge.dependent_source_deck_id === child.sourceId
      && edge.requirement === "required" && edge.gate === "first_introduction",
    "Required edge ownership, direction or gating changed.", INTEGRITY);
  }
  for (const deck of catalog) {
    const expected = localEdges.get(deck.id);
    requireThat(deck.edges.length === expected.size, "The local required edge projection differs.", INTEGRITY);
    const seen = new Set();
    let previousLocalEdge = null;
    for (const edge of deck.edges) {
      requireThat(plainObject(edge), "Invalid local edge.");
      requireId(edge.prerequisite_card_id, "local prerequisite ID");
      requireId(edge.dependent_card_id, "local dependent ID");
      requireThat(previousLocalEdge === null || edgeComparison(previousLocalEdge, edge) < 0,
        "The local edge projection changed canonical order.", INTEGRITY);
      previousLocalEdge = edge;
      const key = edgeKey(edge.prerequisite_card_id, edge.dependent_card_id);
      requireThat(expected.has(key) && !seen.has(key), "The local edge projection lost, duplicated or changed a requirement.", INTEGRITY);
      seen.add(key);
    }
  }
  assertCardDag(cards, expectedEdges);
  const order = parentFirstDeckOrder(bySource, parents);
  const closures = new Map();
  for (const sourceId of order) {
    const required = new Set([sourceId]);
    for (const parent of parents.get(sourceId)) for (const ancestor of closures.get(parent)) required.add(ancestor);
    closures.set(sourceId, required);
    const record = decks[bySource.get(sourceId)];
    record.requiredCatalogDeckIds = order.filter((id) => required.has(id)).map((id) => bySource.get(id));
    record.directDependencyCatalogDeckIds = [...parents.get(sourceId)].map((id) => bySource.get(id)).sort();
  }

  // Capture graph bytes and all thin metadata before yielding. Freeze the shared
  // raw catalog before Web Crypto awaits, preventing concurrent catalog mutation.
  const encodedGraph = stableJson(feed.dependency_edges);
  const frozen = new WeakSet();
  deepFreeze(catalog, frozen);
  requireThat(await sha256(stableJson(catalog)) === catalogRef.digest, "Original catalog SHA-256 does not match its release pin.", INTEGRITY);
  requireThat(await sha256(encodedGraph) === graphDigest, "Required graph SHA-256 does not match its pin.", INTEGRITY);
  for (const deck of catalog) decks[deck.id].payloadDigest = await sha256(stableJson(deck));
  const prepared = deepFreeze({
    kind: RUNTIME_CATALOG_KIND,
    catalog,
    library: {
      normalizationVersion: IDENTITY_VERSION,
      catalogRef,
      dependencyGraphDigest: graphDigest,
      decks,
    },
  }, frozen);
  verifiedPreparedCatalogs.add(prepared);
  return prepared;
}

/**
 * Build-time/private compiler. The emitted JSON keeps only the runtime catalog
 * and thin immutable-base metadata; source indexes, paths and reference maps do
 * not cross the runtime boundary.
 */
export async function prepareLibraryCatalogArtifact(feed) {
  const prepared = await prepareLibraryCatalog(feed);
  const artifact = {
    kind: RUNTIME_ARTIFACT_KIND,
    constructor_digest: await sha256(stableJson(prepared)),
    catalog_ref: { ...prepared.library.catalogRef },
    dependency_graph_sha256: prepared.library.dependencyGraphDigest,
    prepared,
  };
  return deepFreeze(artifact, new WeakSet());
}

/**
 * Build-time/private compiler for the Worker-safe exact-reference layout. The
 * trusted source manifest is verified as exact bytes, but only its immutable
 * deck identities enter the runtime index. Private paths and source maps never
 * enter emitted assets.
 */
export async function prepareLibraryCatalogResolverArtifacts({
  feed,
  sourceManifestBytes,
  expectedSourceManifestSha256,
  assetPrefix = "library-runtime",
  outputReleaseBoundary = PRIVATE_LIBRARY_RELEASE_BOUNDARY,
} = {}) {
  // Capture caller-owned release metadata before the first digest await. The
  // private build feed and source manifest remain independently private-only.
  const releaseBoundary = captureResolverReleaseBoundary(
    outputReleaseBoundary,
    "Library resolver output release boundary",
  );
  const manifestBytes = boundedEncodedCopy(
    sourceManifestBytes,
    "Library source manifest",
    2_000_000,
  );
  const sourceManifestDigest = normalizedDigest(
    expectedSourceManifestSha256,
    "expected source manifest SHA-256",
  );
  requireThat(await sha256(manifestBytes) === sourceManifestDigest,
    "Library source manifest bytes differ from their configured pin.", INTEGRITY);
  const manifest = parseJsonText(
    decodeUtf8(manifestBytes, "Library source manifest"),
    "Library source manifest",
    INTEGRITY,
  );
  requireThat(plainObject(manifest)
    && manifest.schema_version === "meshful-private-library-manifest.v1"
    && manifest.projection_schema_version === PROJECTION_VERSION
    && manifest.audience === "private"
    && manifest.public_release_approved === false
    && manifest.rights_status === "not-cleared"
    && manifest.current_runtime_compatible === false,
  "Library source manifest changed its frozen identity or rights boundary.", INTEGRITY);
  const manifestCatalogRef = requireReference(manifest.catalog_ref, "source manifest catalog_ref");
  const manifestGraphDigest = normalizedDigest(
    manifest.dependency_graph_sha256,
    "source manifest dependency graph digest",
  );
  const criterionDerivationVersion = requireString(
    manifest.criterion_id_derivation?.version,
    "source manifest criterion derivation version",
    200,
  );
  requireThat(Array.isArray(manifest.decks) && manifest.decks.length > 0,
    "Library source manifest requires deck identities.", INTEGRITY);

  const wholeArtifact = await prepareLibraryCatalogArtifact(feed);
  const prepared = wholeArtifact.prepared;
  requireThat(sameReference(prepared.library.catalogRef, manifestCatalogRef)
    && prepared.library.dependencyGraphDigest === manifestGraphDigest
    && prepared.catalog.length === manifest.decks.length,
  "Prepared Library catalog differs from the source manifest.", INTEGRITY);
  requireResolverReleaseBoundaryPins(
    releaseBoundary,
    prepared.library.catalogRef,
    prepared.library.dependencyGraphDigest,
    "Library resolver output",
  );

  const manifestDecks = new Map();
  for (const item of manifest.decks) {
    requireThat(plainObject(item), "Source manifest contains an invalid deck identity.", INTEGRITY);
    const catalogDeckId = requireId(item.catalog_deck_id, "source manifest catalog deck ID");
    requireThat(!manifestDecks.has(catalogDeckId), "Source manifest repeats a catalog deck.", INTEGRITY);
    manifestDecks.set(catalogDeckId, item);
  }
  const ownerByCard = new Map();
  for (const deck of prepared.catalog) {
    const metadata = prepared.library.decks[deck.id];
    for (const card of deck.cards) {
      ownerByCard.set(card.id, { catalogDeckId: deck.id, sourceDeckId: metadata.sourceDeckId });
    }
  }

  const records = new Map();
  for (const deck of prepared.catalog) {
    const metadata = prepared.library.decks[deck.id];
    const manifestDeck = manifestDecks.get(deck.id);
    requireThat(manifestDeck
      && manifestDeck.source_deck_id === metadata.sourceDeckId
      && String(manifestDeck.catalog_deck_version) === metadata.catalogVersion
      && normalizedDigest(manifestDeck.projected_payload_sha256, "manifest payload digest") === metadata.payloadDigest
      && normalizedDigest(manifestDeck.artifact_sha256, "manifest artifact digest") === metadata.artifactDigest,
    `Source manifest identity differs for ${deck.id}.`, INTEGRITY);
    const manifestClosure = manifestDeck.required_deck_closure;
    requireThat(Array.isArray(manifestClosure)
      && sameList(manifestClosure.map((item) => item.catalog_deck_id), metadata.requiredCatalogDeckIds)
      && manifestClosure.every((item) => String(item.catalog_deck_version) === metadata.catalogVersion
        && normalizedDigest(item.projected_payload_sha256, "manifest closure payload digest")
          === prepared.library.decks[item.catalog_deck_id]?.payloadDigest),
    `Source manifest closure differs for ${deck.id}.`, INTEGRITY);
    const expectedDirectSources = metadata.directDependencyCatalogDeckIds
      .map((id) => prepared.library.decks[id].sourceDeckId).sort(compare);
    requireThat(sameList(
      [...(manifestDeck.direct_dependency_source_deck_ids ?? [])].sort(compare),
      expectedDirectSources,
    ), `Source manifest direct dependencies differ for ${deck.id}.`, INTEGRITY);

    const dependentEdges = [];
    for (const card of deck.cards) {
      for (const parentId of card.prerequisite_ids) {
        const parent = ownerByCard.get(parentId);
        requireThat(parent, `Compiler cannot resolve prerequisite ${parentId}.`, INTEGRITY);
        dependentEdges.push({
          prerequisite_card_id: parentId,
          dependent_card_id: card.id,
          prerequisite_catalog_deck_id: parent.catalogDeckId,
          dependent_catalog_deck_id: deck.id,
        });
      }
    }
    dependentEdges.sort(edgeComparison);
    const externalPrerequisiteOwners = dependentEdges.filter(
      (edge) => edge.prerequisite_catalog_deck_id !== deck.id,
    );
    const uniqueModules = new Set(deck.cards.flatMap((card) => card.module_ids ?? []));
    const difficultyHints = [...new Set(deck.cards.map((card) => card.difficulty_hint).filter(Boolean))];
    const record = {
      sourceDeckId: metadata.sourceDeckId,
      catalogDeckId: deck.id,
      catalogVersion: metadata.catalogVersion,
      sourceDeckVersion: requireString(
        manifestDeck.source_deck_version,
        `${deck.id} source deck version`,
        128,
      ),
      payloadDigest: metadata.payloadDigest,
      artifactDigest: metadata.artifactDigest,
      chunk: null,
      cardCount: deck.cards.length,
      prerequisiteEdgeCount: dependentEdges.length,
      externalPrerequisiteEdgeCount: externalPrerequisiteOwners.length,
      closureCardCount: metadata.requiredCatalogDeckIds.reduce(
        (sum, id) => sum + prepared.catalog.find((candidate) => candidate.id === id).cards.length,
        0,
      ),
      requiredCatalogDeckIds: [...metadata.requiredCatalogDeckIds],
      directDependencyCatalogDeckIds: [...metadata.directDependencyCatalogDeckIds],
      externalPrerequisiteOwners,
      dependentEdgeDigest: await sha256(stableJson(dependentEdges)),
      closureDigest: null,
      summary: {
        deck_id: deck.id,
        version: metadata.catalogVersion,
        title: requireString(deck.title, `${deck.id} title`, 200),
        description: typeof deck.description === "string" ? deck.description : "",
        subject: requireString(deck.subject, `${deck.id} subject`, 100),
        domain: requireString(deck.domain ?? deck.subject, `${deck.id} domain`, 100),
        level: typeof deck.level === "string" && deck.level.trim() ? deck.level : "Unspecified",
        tags: Array.isArray(deck.tags) ? [...deck.tags] : [],
        module_count: Array.isArray(deck.modules) ? deck.modules.length : uniqueModules.size,
        card_count: deck.cards.length,
        prerequisite_edge_count: deck.edges.length,
        cross_deck_edge_count: externalPrerequisiteOwners.length,
        evidence_tier: requireString(deck.evidence_tier, `${deck.id} evidence tier`, 200),
        rights_status: requireString(deck.rights_status, `${deck.id} rights status`, 200),
        review_status: requireString(deck.review_status, `${deck.id} review status`, 200),
        content_status: requireString(deck.content_status, `${deck.id} content status`, 200),
        sample_terms: deck.cards.slice(0, 20).map((card) => card.term),
        difficulty_hints: difficultyHints.slice(0, 50),
        provenance_summary: { origin: "catalog", source_count: 0, notes: "" },
      },
      deck,
    };
    requireThat(record.prerequisiteEdgeCount === Number(manifestDeck.prerequisite_edge_count)
      && record.externalPrerequisiteEdgeCount === Number(manifestDeck.external_prerequisite_edge_count)
      && record.closureCardCount === Number(manifestDeck.closure_card_count),
    `Source manifest counts differ for ${deck.id}.`, INTEGRITY);
    records.set(deck.id, record);
  }
  for (const record of records.values()) {
    record.closureDigest = await sha256(stableJson(closurePinInput(
      record.requiredCatalogDeckIds,
      records,
    )));
  }
  const constructorRef = {
    version: prepared.library.catalogRef.version,
    digest: await sha256(stableJson(resolverConstructorInput({
      catalogRef: prepared.library.catalogRef,
      graphDigest: prepared.library.dependencyGraphDigest,
      sourceManifestDigest,
      preparedConstructorDigest: wholeArtifact.constructor_digest,
      normalizationVersion: IDENTITY_VERSION,
      criterionDerivationVersion,
      records,
    }))),
  };

  const safePrefix = safeAssetKey(`${assetPrefix}/asset.json`, "resolver asset prefix")
    .slice(0, -"/asset.json".length);
  const chunks = [];
  for (const record of records.values()) {
    const chunk = {
      schema_version: RESOLVER_CHUNK_VERSION,
      constructor_ref: constructorRef,
      catalog_ref: prepared.library.catalogRef,
      dependency_graph_sha256: prepared.library.dependencyGraphDigest,
      catalog_deck_id: record.catalogDeckId,
      catalog_version: record.catalogVersion,
      projected_payload_sha256: record.payloadDigest,
      artifact_sha256: record.artifactDigest,
      deck: record.deck,
    };
    const bytes = stableJson(chunk);
    const key = `${safePrefix}/${record.sourceDeckId}.json`;
    record.chunk = { key, digest: await sha256(bytes), bytes: encodedBytes(bytes).byteLength };
    chunks.push({ key, bytes, sha256: record.chunk.digest, byte_length: record.chunk.bytes });
  }

  const index = {
    schema_version: RESOLVER_INDEX_VERSION,
    projection_schema_version: PROJECTION_VERSION,
    ...releaseBoundary,
    constructor_ref: constructorRef,
    prepared_constructor_digest: wholeArtifact.constructor_digest,
    source_manifest_sha256: sourceManifestDigest,
    catalog_ref: prepared.library.catalogRef,
    dependency_graph_sha256: prepared.library.dependencyGraphDigest,
    normalization_version: IDENTITY_VERSION,
    criterion_derivation_version: criterionDerivationVersion,
    decks: [...records.values()].map((record) => ({
      source_deck_id: record.sourceDeckId,
      catalog_deck_id: record.catalogDeckId,
      catalog_version: record.catalogVersion,
      source_deck_version: record.sourceDeckVersion,
      projected_payload_sha256: record.payloadDigest,
      artifact_sha256: record.artifactDigest,
      chunk: { key: record.chunk.key, sha256: record.chunk.digest, bytes: record.chunk.bytes },
      card_count: record.cardCount,
      prerequisite_edge_count: record.prerequisiteEdgeCount,
      external_prerequisite_edge_count: record.externalPrerequisiteEdgeCount,
      closure_card_count: record.closureCardCount,
      direct_dependency_catalog_deck_ids: record.directDependencyCatalogDeckIds,
      required_catalog_deck_ids: record.requiredCatalogDeckIds,
      external_prerequisite_owners: record.externalPrerequisiteOwners,
      dependent_edge_sha256: record.dependentEdgeDigest,
      closure_sha256: record.closureDigest,
      summary: record.summary,
    })),
  };
  const indexBytes = stableJson(index);
  const indexSha256 = await sha256(indexBytes);
  const expectedPins = {
    constructorRef,
    preparedConstructorDigest: wholeArtifact.constructor_digest,
    catalogRef: prepared.library.catalogRef,
    dependencyGraphSha256: prepared.library.dependencyGraphDigest,
    sourceManifestSha256: sourceManifestDigest,
    criterionDerivationVersion,
  };
  return deepFreeze({
    kind: "meshful-library-resolver-artifacts.v1",
    index: { bytes: indexBytes, sha256: indexSha256 },
    chunks,
    expectedPins,
    counts: {
      decks: records.size,
      cards: [...records.values()].reduce((sum, record) => sum + record.cardCount, 0),
      prerequisite_edges: [...records.values()].reduce((sum, record) => sum + record.prerequisiteEdgeCount, 0),
      external_prerequisite_edges: [...records.values()].reduce(
        (sum, record) => sum + record.externalPrerequisiteEdgeCount,
        0,
      ),
    },
  }, new WeakSet());
}

/**
 * Runtime admission for a serialized build artifact. This is the only path
 * that may restore the module-private prepared-catalog capability without the
 * full private build feed. All independent hash domains remain required.
 */
export async function admitLibraryCatalogArtifact(artifact, {
  expectedConstructorDigest,
  expectedCatalogRef,
  expectedDependencyGraphSha256,
} = {}) {
  assertJsonTree(artifact);
  exactKeys(artifact,
    ["kind", "constructor_digest", "catalog_ref", "dependency_graph_sha256", "prepared"],
    "Library runtime artifact");
  requireThat(artifact.kind === RUNTIME_ARTIFACT_KIND, "Unsupported Library runtime artifact kind.");
  exactKeys(artifact.catalog_ref, ["version", "digest"], "artifact catalog release identity");

  const expectedConstructor = requireDigest(expectedConstructorDigest, "expected constructor digest");
  exactKeys(expectedCatalogRef, ["version", "digest"], "expected catalog release identity");
  const expectedRef = {
    version: requireString(expectedCatalogRef.version, "expected catalog release version", 128),
    digest: requireDigest(expectedCatalogRef.digest, "expected catalog release digest"),
  };
  const expectedGraph = requireDigest(expectedDependencyGraphSha256, "expected dependency graph digest");
  const declaredConstructor = requireDigest(artifact.constructor_digest, "artifact constructor digest");
  const declaredRef = {
    version: requireString(artifact.catalog_ref.version, "artifact catalog release version", 128),
    digest: requireDigest(artifact.catalog_ref.digest, "artifact catalog release digest"),
  };
  const declaredGraph = requireDigest(artifact.dependency_graph_sha256, "artifact dependency graph digest");
  requireThat(declaredConstructor === expectedConstructor
    && declaredRef.version === expectedRef.version && declaredRef.digest === expectedRef.digest
    && declaredGraph === expectedGraph,
  "Library runtime artifact differs from its trusted release pins.", INTEGRITY);

  // Freeze before the first asynchronous digest so another task cannot mutate
  // the parsed artifact between validation and capability admission.
  deepFreeze(artifact, new WeakSet());
  const inspection = inspectRuntimeCatalog(artifact.prepared);
  requireThat(inspection.catalogRef.version === expectedRef.version
    && inspection.catalogRef.digest === expectedRef.digest
    && inspection.graphDigest === expectedGraph,
  "Prepared Library metadata differs from its artifact pins.", INTEGRITY);
  requireThat(await sha256(stableJson(artifact.prepared)) === expectedConstructor,
    "Prepared Library constructor digest differs.", INTEGRITY);
  requireThat(await sha256(stableJson(artifact.prepared.catalog)) === expectedRef.digest,
    "Prepared Library raw catalog digest differs.", INTEGRITY);
  requireThat(await sha256(stableJson(inspection.graph)) === expectedGraph,
    "Prepared Library dependency graph digest differs.", INTEGRITY);
  for (const { deck, metadata } of inspection.deckRecords) {
    requireThat(await sha256(stableJson(deck)) === metadata.payloadDigest,
      `Prepared Library deck payload differs for ${metadata.catalogDeckId}.`, INTEGRITY);
  }

  verifiedPreparedCatalogs.add(artifact.prepared);
  return Object.freeze({
    prepared: artifact.prepared,
    constructorDigest: expectedConstructor,
    catalogRef: artifact.prepared.library.catalogRef,
    dependencyGraphDigest: expectedGraph,
  });
}
function libraryError(code, message, details = null) {
  const error = new Error(message);
  error.name = "LibraryCatalogError";
  error.code = code;
  if (details !== null) error.details = deepFreeze(details, new WeakSet());
  throw error;
}

function requireCount(value, label, { positive = false, maximum = 1_000_000 } = {}) {
  requireThat(Number.isSafeInteger(value) && value >= (positive ? 1 : 0) && value <= maximum,
    `${label} must be a bounded nonnegative integer.`);
  return value;
}

function normalizeResolutionBudget(value) {
  exactKeys(value, ["max_decks", "max_cards", "max_raw_chunk_bytes"], "resolutionBudget");
  return deepFreeze({
    max_decks: requireCount(value.max_decks, "resolutionBudget.max_decks", {
      positive: true,
      maximum: 10_000,
    }),
    max_cards: requireCount(value.max_cards, "resolutionBudget.max_cards", {
      positive: true,
      maximum: 1_000_000,
    }),
    max_raw_chunk_bytes: requireCount(
      value.max_raw_chunk_bytes,
      "resolutionBudget.max_raw_chunk_bytes",
      { positive: true, maximum: 64_000_000 },
    ),
  }, new WeakSet());
}

function requireStringList(value, label, maximum = 10_000) {
  requireThat(Array.isArray(value) && value.length <= maximum, `${label} must be a bounded array.`);
  return value.map((item, index) => requireString(item, `${label}[${index}]`, 1_000));
}

function requireIdList(value, label, maximum = 10_000) {
  requireThat(Array.isArray(value) && value.length <= maximum, `${label} must be a bounded array.`);
  const result = value.map((item, index) => requireId(item, `${label}[${index}]`));
  requireThat(new Set(result).size === result.length, `${label} must not contain duplicates.`);
  return result;
}

function requireReference(value, label) {
  requireThat(plainObject(value), `${label} is required.`);
  exactKeys(value, ["version", "digest"], label);
  return {
    version: requireString(value.version, `${label}.version`, 128),
    digest: normalizedDigest(value.digest, `${label}.digest`),
  };
}

function sameReference(left, right) {
  return Boolean(left && right && left.version === right.version
    && normalizedDigest(left.digest, "reference digest") === normalizedDigest(right.digest, "reference digest"));
}

function parseJsonText(text, label, code = INVALID) {
  try {
    const parsed = JSON.parse(text);
    assertJsonTree(parsed);
    return parsed;
  } catch (error) {
    if (error?.code) throw error;
    libraryError(code, `${label} is not valid JSON.`);
  }
}

function safeAssetKey(value, label) {
  const key = requireString(value, label, 1_000);
  const segments = key.split("/");
  requireThat(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key)
    && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
  `${label} must be an opaque relative asset key.`);
  return key;
}

function normalizeResolverSummary(raw, record) {
  requireThat(plainObject(raw), `Library summary ${record.catalogDeckId} is required.`);
  exactKeys(raw, [
    "deck_id", "version", "title", "description", "subject", "domain", "level", "tags",
    "module_count", "card_count", "prerequisite_edge_count", "cross_deck_edge_count",
    "evidence_tier", "rights_status", "review_status", "content_status", "sample_terms",
    "difficulty_hints", "provenance_summary",
  ], `Library summary ${record.catalogDeckId}`);
  const tags = requireStringList(raw.tags ?? [], "summary.tags", 50);
  const sampleTerms = requireStringList(raw.sample_terms ?? [], "summary.sample_terms", 20);
  const difficultyHints = requireStringList(raw.difficulty_hints ?? [], "summary.difficulty_hints", 50);
  const provenance = raw.provenance_summary ?? {};
  requireThat(plainObject(provenance), "summary.provenance_summary must be an object.");
  exactKeys(provenance, ["origin", "source_count", "notes"], "summary.provenance_summary");
  const summary = {
    deck_id: requireId(raw.deck_id ?? record.catalogDeckId, "summary.deck_id"),
    version: requireString(raw.version ?? record.catalogVersion, "summary.version", 128),
    title: requireString(raw.title, "summary.title", 200),
    description: typeof raw.description === "string" && raw.description.length <= 2_000 ? raw.description : "",
    subject: requireString(raw.subject, "summary.subject", 100),
    domain: requireString(raw.domain ?? raw.subject, "summary.domain", 100),
    level: requireString(raw.level, "summary.level", 100),
    tags,
    module_count: requireCount(raw.module_count, "summary.module_count", { maximum: 10_000 }),
    card_count: requireCount(raw.card_count, "summary.card_count", { positive: true }),
    prerequisite_edge_count: requireCount(raw.prerequisite_edge_count, "summary.prerequisite_edge_count"),
    cross_deck_edge_count: requireCount(raw.cross_deck_edge_count, "summary.cross_deck_edge_count"),
    evidence_tier: requireString(raw.evidence_tier, "summary.evidence_tier", 200),
    rights_status: requireString(raw.rights_status, "summary.rights_status", 200),
    review_status: requireString(raw.review_status ?? "unreviewed", "summary.review_status", 200),
    content_status: requireString(raw.content_status ?? "unspecified", "summary.content_status", 200),
    sample_terms: sampleTerms,
    difficulty_hints: difficultyHints,
    provenance_summary: {
      origin: typeof provenance.origin === "string" && provenance.origin.length <= 200 ? provenance.origin : "catalog",
      source_count: requireCount(provenance.source_count ?? 0, "summary.provenance_summary.source_count"),
      notes: typeof provenance.notes === "string" && provenance.notes.length <= 8_000 ? provenance.notes : "",
    },
  };
  requireThat(summary.deck_id === record.catalogDeckId && summary.version === record.catalogVersion
    && summary.card_count === record.cardCount
    && summary.prerequisite_edge_count === record.prerequisiteEdgeCount - record.externalPrerequisiteEdgeCount
    && summary.cross_deck_edge_count === record.externalPrerequisiteEdgeCount,
  `Library summary counts or identity differ for ${record.catalogDeckId}.`, INTEGRITY);
  return summary;
}

function closurePinInput(ids, records) {
  return ids.map((catalogDeckId) => {
    const record = records.get(catalogDeckId);
    return {
      catalog_deck_id: record.catalogDeckId,
      catalog_version: record.catalogVersion,
      projected_payload_sha256: record.payloadDigest,
      dependent_edge_sha256: record.dependentEdgeDigest,
    };
  });
}

function resolverConstructorInput({
  catalogRef,
  graphDigest,
  sourceManifestDigest,
  preparedConstructorDigest,
  normalizationVersion,
  criterionDerivationVersion,
  records,
}) {
  return {
    schema_version: RESOLVER_INDEX_VERSION,
    prepared_constructor_digest: preparedConstructorDigest,
    catalog_ref: catalogRef,
    dependency_graph_sha256: graphDigest,
    source_manifest_sha256: sourceManifestDigest,
    normalization_version: normalizationVersion,
    criterion_derivation_version: criterionDerivationVersion,
    decks: [...records.values()].map((record) => ({
      source_deck_id: record.sourceDeckId,
      catalog_deck_id: record.catalogDeckId,
      catalog_version: record.catalogVersion,
      source_deck_version: record.sourceDeckVersion,
      projected_payload_sha256: record.payloadDigest,
      artifact_sha256: record.artifactDigest,
      card_count: record.cardCount,
      prerequisite_edge_count: record.prerequisiteEdgeCount,
      external_prerequisite_edge_count: record.externalPrerequisiteEdgeCount,
      closure_card_count: record.closureCardCount,
      direct_dependency_catalog_deck_ids: record.directDependencyCatalogDeckIds,
      required_catalog_deck_ids: record.requiredCatalogDeckIds,
      external_prerequisite_owners: record.externalPrerequisiteOwners,
      dependent_edge_sha256: record.dependentEdgeDigest,
      closure_sha256: record.closureDigest,
      summary: record.summary,
    })),
  };
}

function normalizeExpectedResolverPins(value, label) {
  exactKeys(value, [
    "constructorRef", "preparedConstructorDigest", "catalogRef", "dependencyGraphSha256",
    "sourceManifestSha256", "criterionDerivationVersion",
  ], label);
  return {
    constructorRef: requireReference(value.constructorRef, `${label}.constructorRef`),
    preparedConstructorDigest: normalizedDigest(
      value.preparedConstructorDigest,
      `${label}.preparedConstructorDigest`,
    ),
    catalogRef: requireReference(value.catalogRef, `${label}.catalogRef`),
    dependencyGraphSha256: normalizedDigest(
      value.dependencyGraphSha256,
      `${label}.dependencyGraphSha256`,
    ),
    sourceManifestSha256: normalizedDigest(value.sourceManifestSha256, `${label}.sourceManifestSha256`),
    criterionDerivationVersion: requireString(
      value.criterionDerivationVersion,
      `${label}.criterionDerivationVersion`,
      200,
    ),
  };
}

async function prepareResolverIndex({ indexBytes, expectedIndexSha256, expectedPins, readAsset }, label) {
  requireThat(typeof readAsset === "function", `${label}.readAsset must be a function.`);
  const trustedPins = normalizeExpectedResolverPins(expectedPins, `${label}.expectedPins`);
  // Caller-owned ArrayBuffers remain mutable while Web Crypto yields. Copy the
  // exact bytes before the first await so hashing and parsing observe one value.
  const bytes = boundedEncodedCopy(indexBytes, `${label} bytes`, 2_000_000);
  requireThat(bytes.byteLength > 0, `${label} must not be empty.`);
  const descriptorDigest = await sha256(bytes);
  requireThat(descriptorDigest === normalizedDigest(expectedIndexSha256, `${label} expected SHA-256`),
    `${label} bytes do not match the independently configured SHA-256.`, INTEGRITY);
  const raw = parseJsonText(decodeUtf8(bytes, label), label);
  requireThat(plainObject(raw) && raw.schema_version === RESOLVER_INDEX_VERSION,
    `${label} uses an unsupported exact-reference schema.`);
  exactKeys(raw, [
    "schema_version", "projection_schema_version", "audience", "public_release_approved",
    "rights_status", "current_runtime_compatible", "constructor_ref",
    "prepared_constructor_digest", "source_manifest_sha256", "catalog_ref",
    "dependency_graph_sha256", "normalization_version", "criterion_derivation_version", "decks",
  ], label);
  requireThat(raw.projection_schema_version === PROJECTION_VERSION
    && raw.normalization_version === IDENTITY_VERSION,
  `${label} uses unsupported projection or identity semantics.`);
  const catalogRef = requireReference(raw.catalog_ref, `${label}.catalog_ref`);
  const graphDigest = normalizedDigest(raw.dependency_graph_sha256, `${label}.dependency_graph_sha256`);
  const releaseBoundary = captureResolverReleaseBoundary({
    audience: raw.audience,
    public_release_approved: raw.public_release_approved,
    rights_status: raw.rights_status,
    current_runtime_compatible: raw.current_runtime_compatible,
  }, `${label} release boundary`);
  requireResolverReleaseBoundaryPins(releaseBoundary, catalogRef, graphDigest, label);
  const constructorRef = requireReference(raw.constructor_ref, `${label}.constructor_ref`);
  const preparedConstructorDigest = normalizedDigest(
    raw.prepared_constructor_digest,
    `${label}.prepared_constructor_digest`,
  );
  const sourceManifestDigest = normalizedDigest(raw.source_manifest_sha256, `${label}.source_manifest_sha256`);
  const criterionDerivationVersion = requireString(
    raw.criterion_derivation_version,
    `${label}.criterion_derivation_version`,
    200,
  );
  requireThat(sameReference(constructorRef, trustedPins.constructorRef)
    && preparedConstructorDigest === trustedPins.preparedConstructorDigest
    && sameReference(catalogRef, trustedPins.catalogRef)
    && graphDigest === trustedPins.dependencyGraphSha256
    && sourceManifestDigest === trustedPins.sourceManifestSha256
    && criterionDerivationVersion === trustedPins.criterionDerivationVersion,
  `${label} differs from its independently configured release pins.`, INTEGRITY);
  requireThat(Array.isArray(raw.decks) && raw.decks.length > 0 && raw.decks.length <= 10_000,
    `${label}.decks must be a bounded nonempty array.`);

  const records = new Map();
  const sourceIds = new Set();
  let previousId = null;
  for (const [index, item] of raw.decks.entries()) {
    requireThat(plainObject(item), `${label}.decks[${index}] must be an object.`);
    exactKeys(item, [
      "source_deck_id", "catalog_deck_id", "catalog_version", "source_deck_version",
      "projected_payload_sha256", "artifact_sha256", "chunk", "card_count",
      "prerequisite_edge_count", "external_prerequisite_edge_count", "closure_card_count",
      "direct_dependency_catalog_deck_ids", "required_catalog_deck_ids",
      "external_prerequisite_owners", "dependent_edge_sha256", "closure_sha256", "summary",
    ], `${label}.decks[${index}]`);
    const catalogDeckId = requireId(item.catalog_deck_id, `decks[${index}].catalog_deck_id`);
    requireThat(previousId === null || compare(previousId, catalogDeckId) < 0,
      `${label}.decks must use unique canonical catalog-ID order.`, INTEGRITY);
    previousId = catalogDeckId;
    const sourceDeckId = requireId(item.source_deck_id, `decks[${index}].source_deck_id`);
    requireThat(!sourceIds.has(sourceDeckId), `${label} source deck IDs must be unique.`, INTEGRITY);
    sourceIds.add(sourceDeckId);
    const catalogVersion = requireString(item.catalog_version, `decks[${index}].catalog_version`, 128);
    requireThat(catalogVersion === catalogRef.version, `${catalogDeckId} changed its catalog version.`, INTEGRITY);
    requireThat(plainObject(item.chunk), `${catalogDeckId} requires an exact chunk reference.`);
    exactKeys(item.chunk, ["key", "sha256", "bytes"], `${catalogDeckId}.chunk`);
    const cardCount = requireCount(item.card_count, `${catalogDeckId}.card_count`, { positive: true });
    const prerequisiteEdgeCount = requireCount(item.prerequisite_edge_count, `${catalogDeckId}.prerequisite_edge_count`);
    const externalPrerequisiteEdgeCount = requireCount(
      item.external_prerequisite_edge_count,
      `${catalogDeckId}.external_prerequisite_edge_count`,
    );
    requireThat(externalPrerequisiteEdgeCount <= prerequisiteEdgeCount,
      `${catalogDeckId} has more external edges than total prerequisites.`, INTEGRITY);
    const requiredCatalogDeckIds = requireIdList(
      item.required_catalog_deck_ids,
      `${catalogDeckId}.required_catalog_deck_ids`,
    );
    const directDependencyCatalogDeckIds = requireIdList(
      item.direct_dependency_catalog_deck_ids ?? [],
      `${catalogDeckId}.direct_dependency_catalog_deck_ids`,
    );
    requireThat(requiredCatalogDeckIds.at(-1) === catalogDeckId
      && directDependencyCatalogDeckIds.every((id) => requiredCatalogDeckIds.includes(id) && id !== catalogDeckId),
    `${catalogDeckId} does not retain a parent-first closure.`, INTEGRITY);
    const owners = item.external_prerequisite_owners ?? [];
    requireThat(Array.isArray(owners) && owners.length === externalPrerequisiteEdgeCount,
      `${catalogDeckId} external owner coverage differs.`, INTEGRITY);
    const externalPrerequisiteOwners = owners.map((owner, ownerIndex) => {
      requireThat(plainObject(owner), `${catalogDeckId}.external_prerequisite_owners[${ownerIndex}] must be an object.`);
      exactKeys(owner, [
        "prerequisite_card_id", "dependent_card_id", "prerequisite_catalog_deck_id",
        "dependent_catalog_deck_id",
      ], `${catalogDeckId}.external_prerequisite_owners[${ownerIndex}]`);
      const normalized = {
        prerequisite_card_id: requireId(owner.prerequisite_card_id, "external prerequisite card ID"),
        dependent_card_id: requireId(owner.dependent_card_id, "external dependent card ID"),
        prerequisite_catalog_deck_id: requireId(owner.prerequisite_catalog_deck_id, "external prerequisite deck ID"),
        dependent_catalog_deck_id: requireId(owner.dependent_catalog_deck_id, "external dependent deck ID"),
      };
      requireThat(normalized.dependent_catalog_deck_id === catalogDeckId
        && normalized.prerequisite_catalog_deck_id !== catalogDeckId
        && requiredCatalogDeckIds.includes(normalized.prerequisite_catalog_deck_id),
      `${catalogDeckId} has an invalid external prerequisite owner.`, INTEGRITY);
      return normalized;
    });
    requireThat(new Set(externalPrerequisiteOwners.map((owner) => edgeKey(
      owner.prerequisite_card_id,
      owner.dependent_card_id,
    ))).size === externalPrerequisiteOwners.length,
    `${catalogDeckId} repeats an external prerequisite edge.`, INTEGRITY);
    const record = {
      sourceDeckId,
      catalogDeckId,
      catalogVersion,
      sourceDeckVersion: requireString(item.source_deck_version, `${catalogDeckId}.source_deck_version`, 128),
      payloadDigest: normalizedDigest(item.projected_payload_sha256, `${catalogDeckId}.projected_payload_sha256`),
      artifactDigest: normalizedDigest(item.artifact_sha256, `${catalogDeckId}.artifact_sha256`),
      chunk: {
        key: safeAssetKey(item.chunk.key, `${catalogDeckId}.chunk.key`),
        digest: normalizedDigest(item.chunk.sha256, `${catalogDeckId}.chunk.sha256`),
        bytes: requireCount(item.chunk.bytes, `${catalogDeckId}.chunk.bytes`, { positive: true, maximum: 8_000_000 }),
      },
      cardCount,
      prerequisiteEdgeCount,
      externalPrerequisiteEdgeCount,
      closureCardCount: requireCount(item.closure_card_count, `${catalogDeckId}.closure_card_count`, { positive: true }),
      requiredCatalogDeckIds,
      directDependencyCatalogDeckIds,
      externalPrerequisiteOwners,
      dependentEdgeDigest: normalizedDigest(item.dependent_edge_sha256, `${catalogDeckId}.dependent_edge_sha256`),
      closureDigest: normalizedDigest(item.closure_sha256, `${catalogDeckId}.closure_sha256`),
      summary: null,
    };
    record.summary = normalizeResolverSummary(item.summary, record);
    records.set(catalogDeckId, record);
  }

  for (const record of records.values()) {
    const required = new Set([record.catalogDeckId]);
    const visiting = new Set();
    const visit = (catalogDeckId) => {
      requireThat(records.has(catalogDeckId), `${record.catalogDeckId} references an unknown dependency ${catalogDeckId}.`, INTEGRITY);
      requireThat(!visiting.has(catalogDeckId), "Required deck dependencies contain a cycle.", INTEGRITY);
      if (required.has(catalogDeckId) && catalogDeckId !== record.catalogDeckId) return;
      visiting.add(catalogDeckId);
      required.add(catalogDeckId);
      for (const parent of records.get(catalogDeckId).directDependencyCatalogDeckIds) visit(parent);
      visiting.delete(catalogDeckId);
    };
    for (const parent of record.directDependencyCatalogDeckIds) visit(parent);
    requireThat(required.size === record.requiredCatalogDeckIds.length
      && record.requiredCatalogDeckIds.every((id) => required.has(id)),
    `${record.catalogDeckId} has an incomplete or excessive dependency closure.`, INTEGRITY);
    const positions = new Map(record.requiredCatalogDeckIds.map((id, index) => [id, index]));
    for (const id of record.requiredCatalogDeckIds) {
      for (const parent of records.get(id).directDependencyCatalogDeckIds) {
        requireThat(positions.has(parent) && positions.get(parent) < positions.get(id),
          `${record.catalogDeckId} closure is not parent-first.`, INTEGRITY);
      }
    }
    requireThat(record.closureCardCount === record.requiredCatalogDeckIds.reduce(
      (sum, id) => sum + records.get(id).cardCount,
      0,
    ), `${record.catalogDeckId} closure card count differs.`, INTEGRITY);
    requireThat(await sha256(stableJson(closurePinInput(record.requiredCatalogDeckIds, records))) === record.closureDigest,
      `${record.catalogDeckId} closure digest differs.`, INTEGRITY);
  }

  const constructorDigest = await sha256(stableJson(resolverConstructorInput({
    catalogRef,
    graphDigest,
    sourceManifestDigest,
    preparedConstructorDigest,
    normalizationVersion: IDENTITY_VERSION,
    criterionDerivationVersion,
    records,
  })));
  requireThat(constructorDigest === constructorRef.digest,
    `${label} semantic constructor digest differs.`, INTEGRITY);

  return {
    descriptorBytes: bytes.byteLength,
    descriptorDigest,
    constructorRef,
    catalogRef,
    graphDigest,
    sourceManifestDigest,
    preparedConstructorDigest,
    criterionDerivationVersion,
    normalizationVersion: IDENTITY_VERSION,
    records,
    readAsset,
  };
}

function savedLibraryReferences(stateJson) {
  if (stateJson === undefined || stateJson === null || stateJson === "") return [];
  const parsed = typeof stateJson === "string"
    ? parseJsonText(stateJson, "persisted learner state")
    : stateJson;
  requireThat(plainObject(parsed), "Persisted learner state must be an object.");
  const personalDecks = parsed.personalDecks;
  if (personalDecks === undefined) return [];
  requireThat(plainObject(personalDecks), "Persisted learner decks must be an object.");
  const references = [];
  for (const persisted of Object.values(personalDecks)) {
    if (!plainObject(persisted)) continue;
    const base = persisted.persistenceKind === "catalog-overlay-v1"
      ? persisted.deckFields?.libraryBase
      : persisted.libraryBase;
    if (!plainObject(base)) continue;
    references.push({
      catalogDeckId: requireId(base.catalogDeckId, "saved catalog deck ID"),
      catalogVersion: requireString(base.catalogVersion, "saved catalog version", 128),
      catalogRef: requireReference(base.catalogRef, "saved catalog reference"),
      dependencyGraphDigest: normalizedDigest(base.dependencyGraphDigest, "saved dependency graph digest"),
      normalizationVersion: requireString(base.normalizationVersion, "saved normalization version", 200),
      payloadDigest: normalizedDigest(base.payloadDigest, "saved payload digest"),
      artifactDigest: normalizedDigest(base.artifactDigest, "saved artifact digest"),
    });
  }
  return references;
}

function operationName(intent) {
  if (!plainObject(intent)) return null;
  return typeof intent.operation === "string" ? intent.operation : null;
}

function operationArgs(intent) {
  return plainObject(intent?.args) ? intent.args : {};
}

function normalizeDependentEdges(deck, record) {
  requireThat(plainObject(deck) && deck.id === record.catalogDeckId
    && String(deck.version) === record.catalogVersion,
  `Chunk identity differs for ${record.catalogDeckId}.`, INTEGRITY);
  requireThat(Array.isArray(deck.cards) && deck.cards.length === record.cardCount
    && Array.isArray(deck.edges),
  `Chunk counts differ for ${record.catalogDeckId}.`, INTEGRITY);
  const localIds = new Set();
  for (const [index, card] of deck.cards.entries()) {
    requireThat(plainObject(card), `${record.catalogDeckId} card ${index} is invalid.`, INTEGRITY);
    const cardId = requireId(card.id, `${record.catalogDeckId} card ID`);
    requireThat(!localIds.has(cardId), `${record.catalogDeckId} repeats card ${cardId}.`, INTEGRITY);
    requireThat(card.canonical_deck_id === record.sourceDeckId,
      `${record.catalogDeckId} card ${cardId} changed canonical ownership.`, INTEGRITY);
    localIds.add(cardId);
    requireString(card.term, `${cardId}.term`, 300);
    requireString(card.definition, `${cardId}.definition`, 8_000);
    const criteria = new Set();
    assertCriteria(card, "required_concepts", criteria);
    assertCriteria(card, "major_error_concepts", criteria);
    requireThat(Array.isArray(card.prerequisite_ids), `${cardId} must retain prerequisite_ids.`, INTEGRITY);
  }
  const externalByEdge = new Map(record.externalPrerequisiteOwners.map((owner) => [
    edgeKey(owner.prerequisite_card_id, owner.dependent_card_id),
    owner,
  ]));
  const allEdges = [];
  const localEdgeKeys = new Set();
  for (const card of deck.cards) {
    const parents = requireIdList(card.prerequisite_ids, `${card.id}.prerequisite_ids`, 50);
    requireThat(!parents.includes(card.id), `${card.id} cannot require itself.`, INTEGRITY);
    for (const parentId of parents) {
      const key = edgeKey(parentId, card.id);
      if (localIds.has(parentId)) localEdgeKeys.add(key);
      const external = externalByEdge.get(key);
      const ownerId = localIds.has(parentId) ? record.catalogDeckId : external?.prerequisite_catalog_deck_id;
      requireThat(ownerId, `${record.catalogDeckId} has an unresolved prerequisite ${parentId}.`, INTEGRITY);
      allEdges.push({
        prerequisite_card_id: parentId,
        dependent_card_id: card.id,
        prerequisite_catalog_deck_id: ownerId,
        dependent_catalog_deck_id: record.catalogDeckId,
      });
    }
  }
  requireThat(allEdges.length === record.prerequisiteEdgeCount
    && allEdges.length - localEdgeKeys.size === record.externalPrerequisiteEdgeCount,
  `${record.catalogDeckId} prerequisite counts differ.`, INTEGRITY);
  requireThat(deck.edges.length === localEdgeKeys.size, `${record.catalogDeckId} local edge count differs.`, INTEGRITY);
  const seenLocal = new Set();
  let previousLocal = null;
  for (const edge of deck.edges) {
    requireThat(plainObject(edge), `${record.catalogDeckId} has an invalid local edge.`, INTEGRITY);
    const key = edgeKey(
      requireId(edge.prerequisite_card_id, "local prerequisite card ID"),
      requireId(edge.dependent_card_id, "local dependent card ID"),
    );
    requireThat(previousLocal === null || edgeComparison(previousLocal, edge) < 0,
      `${record.catalogDeckId} local edge order differs.`, INTEGRITY);
    previousLocal = edge;
    requireThat(localEdgeKeys.has(key) && !seenLocal.has(key), `${record.catalogDeckId} local edge projection differs.`, INTEGRITY);
    seenLocal.add(key);
  }
  requireThat([...externalByEdge.keys()].every((key) => allEdges.some((edge) => edgeKey(
    edge.prerequisite_card_id,
    edge.dependent_card_id,
  ) === key)), `${record.catalogDeckId} external owner shard has extra entries.`, INTEGRITY);
  return allEdges.sort(edgeComparison);
}

async function verifyResolverChunk(descriptor, record, rawBytes) {
  const bytes = boundedEncodedCopy(
    rawBytes,
    `${record.catalogDeckId} chunk`,
    record.chunk.bytes,
    INTEGRITY,
  );
  requireThat(bytes.byteLength === record.chunk.bytes, `${record.catalogDeckId} chunk byte count differs.`, INTEGRITY);
  requireThat(await sha256(bytes) === record.chunk.digest, `${record.catalogDeckId} chunk SHA-256 differs.`, INTEGRITY);
  const chunk = parseJsonText(decodeUtf8(bytes, `${record.catalogDeckId} chunk`), `${record.catalogDeckId} chunk`, INTEGRITY);
  requireThat(plainObject(chunk) && chunk.schema_version === RESOLVER_CHUNK_VERSION,
    `${record.catalogDeckId} chunk schema differs.`, INTEGRITY);
  exactKeys(chunk, [
    "schema_version", "constructor_ref", "catalog_ref", "dependency_graph_sha256",
    "catalog_deck_id", "catalog_version", "projected_payload_sha256", "artifact_sha256", "deck",
  ], `${record.catalogDeckId} chunk`, INTEGRITY);
  requireThat(sameReference(chunk.constructor_ref, descriptor.constructorRef)
    && sameReference(chunk.catalog_ref, descriptor.catalogRef)
    && normalizedDigest(chunk.dependency_graph_sha256, "chunk graph digest") === descriptor.graphDigest
    && chunk.catalog_deck_id === record.catalogDeckId
    && String(chunk.catalog_version) === record.catalogVersion
    && normalizedDigest(chunk.projected_payload_sha256, "chunk payload digest") === record.payloadDigest
    && normalizedDigest(chunk.artifact_sha256, "chunk artifact digest") === record.artifactDigest,
  `${record.catalogDeckId} chunk pins differ.`, INTEGRITY);
  requireThat(plainObject(chunk.deck), `${record.catalogDeckId} chunk has no projected deck.`, INTEGRITY);
  requireThat(await sha256(stableJson(chunk.deck)) === record.payloadDigest,
    `${record.catalogDeckId} projected payload SHA-256 differs.`, INTEGRITY);
  const dependentEdges = normalizeDependentEdges(chunk.deck, record);
  requireThat(await sha256(stableJson(dependentEdges)) === record.dependentEdgeDigest,
    `${record.catalogDeckId} dependent-edge digest differs.`, INTEGRITY);
  return deepFreeze({ deck: chunk.deck, dependentEdges, bytes: bytes.byteLength }, new WeakSet());
}

function preparedResolverView(descriptor, loaded, includeAllSummaries) {
  const records = includeAllSummaries
    ? [...descriptor.records.values()]
    : [...loaded.keys()].map((id) => descriptor.records.get(id));
  const deckPins = Object.create(null);
  for (const record of records) {
    deckPins[record.catalogDeckId] = {
      sourceDeckId: record.sourceDeckId,
      catalogDeckId: record.catalogDeckId,
      catalogVersion: record.catalogVersion,
      payloadDigest: record.payloadDigest,
      artifactDigest: record.artifactDigest,
      requiredCatalogDeckIds: [...record.requiredCatalogDeckIds],
      directDependencyCatalogDeckIds: [...record.directDependencyCatalogDeckIds],
      externalPrerequisiteOwners: record.externalPrerequisiteOwners.map((owner) => ({ ...owner })),
      summary: { ...record.summary, tags: [...record.summary.tags], sample_terms: [...record.summary.sample_terms], difficulty_hints: [...record.summary.difficulty_hints], provenance_summary: { ...record.summary.provenance_summary } },
      contentResolved: loaded.has(record.catalogDeckId),
    };
  }
  const view = deepFreeze({
    kind: RESOLVER_VIEW_KIND,
    catalog: [...loaded.values()].map((entry) => entry.deck),
    summaries: records.map((record) => deckPins[record.catalogDeckId].summary),
    library: {
      normalizationVersion: descriptor.normalizationVersion,
      constructorCatalogRef: { ...descriptor.constructorRef },
      catalogRef: { ...descriptor.catalogRef },
      dependencyGraphDigest: descriptor.graphDigest,
      sourceManifestDigest: descriptor.sourceManifestDigest,
      descriptorDigest: descriptor.descriptorDigest,
      criterionDerivationVersion: descriptor.criterionDerivationVersion,
      partial: !includeAllSummaries,
      decks: deckPins,
    },
  }, new WeakSet());
  verifiedPreparedCatalogs.add(view);
  return view;
}

function verifyLoadedClosure(record, loaded) {
  const cards = new Map();
  const owners = new Map();
  const edges = new Map();
  for (const id of record.requiredCatalogDeckIds) {
    const resolved = loaded.get(id);
    requireThat(resolved, `Required Library base ${id} is unavailable.`, INTEGRITY);
    for (const card of resolved.deck.cards) {
      requireThat(!cards.has(card.id), `Closure repeats canonical card ${card.id}.`, INTEGRITY);
      cards.set(card.id, card);
      owners.set(card.id, id);
    }
    for (const edge of resolved.dependentEdges) {
      edges.set(edgeKey(edge.prerequisite_card_id, edge.dependent_card_id), [
        edge.prerequisite_card_id,
        edge.dependent_card_id,
      ]);
    }
  }
  for (const [parent, child] of edges.values()) {
    requireThat(cards.has(parent) && cards.has(child), `Closure has an unresolved required endpoint ${parent} -> ${child}.`, INTEGRITY);
  }
  for (const id of record.requiredCatalogDeckIds) {
    for (const edge of loaded.get(id).dependentEdges) {
      requireThat(owners.get(edge.prerequisite_card_id) === edge.prerequisite_catalog_deck_id
        && owners.get(edge.dependent_card_id) === edge.dependent_catalog_deck_id,
      `Closure prerequisite ownership differs for ${edge.prerequisite_card_id} -> ${edge.dependent_card_id}.`, INTEGRITY);
    }
  }
  assertCardDag(cards, edges);
}

/**
 * Opens a thin, independently pinned exact-reference index. The returned
 * capability performs all asynchronous asset reads and integrity checks before
 * handing a bounded, synchronous catalog view to createStudyStore.
 */
export async function prepareLibraryCatalogResolver({
  indexBytes,
  expectedIndexSha256,
  expectedPins,
  readAsset,
  retainedIndexes = [],
  maxCachedDecks = 16,
  maxCachedBytes = 16_000_000,
  maxConcurrentDecks = 16,
  maxConcurrentBytes = 32_000_000,
  resolutionBudget = DEFAULT_LIBRARY_RESOLUTION_BUDGET,
} = {}) {
  requireThat(Array.isArray(retainedIndexes) && retainedIndexes.length <= 20,
    "retainedIndexes must be a bounded array.");
  requireCount(maxCachedDecks, "maxCachedDecks", { maximum: 10_000 });
  requireCount(maxCachedBytes, "maxCachedBytes", { positive: true, maximum: 32_000_000 });
  requireCount(maxConcurrentDecks, "maxConcurrentDecks", { positive: true, maximum: 128 });
  requireCount(maxConcurrentBytes, "maxConcurrentBytes", { positive: true, maximum: 64_000_000 });
  const transactionBudget = normalizeResolutionBudget(resolutionBudget);
  const primary = await prepareResolverIndex({
    indexBytes, expectedIndexSha256, expectedPins, readAsset,
  }, "Library exact-reference index");
  const retained = [];
  for (const [index, entry] of retainedIndexes.entries()) {
    requireThat(plainObject(entry), `retainedIndexes[${index}] must be an object.`);
    retained.push(await prepareResolverIndex({
      indexBytes: entry.indexBytes,
      expectedIndexSha256: entry.expectedIndexSha256,
      expectedPins: entry.expectedPins,
      readAsset: entry.readAsset ?? readAsset,
    }, `Retained Library exact-reference index ${index}`));
  }
  const descriptors = [primary, ...retained];
  requireThat(descriptors.reduce((sum, descriptor) => sum + descriptor.descriptorBytes, 0) <= 8_000_000,
    "Exact-reference indexes exceed the aggregate runtime byte bound.");
  const descriptorByConstructor = new Map();
  const descriptorsByCatalog = new Map();
  for (const descriptor of descriptors) {
    const constructorKey = stableJson(descriptor.constructorRef);
    requireThat(!descriptorByConstructor.has(constructorKey),
      "Exact-reference indexes repeat a constructor release.", INTEGRITY);
    descriptorByConstructor.set(constructorKey, descriptor);
    const catalogKey = stableJson(descriptor.catalogRef);
    if (!descriptorsByCatalog.has(catalogKey)) descriptorsByCatalog.set(catalogKey, []);
    descriptorsByCatalog.get(catalogKey).push(descriptor);
  }
  const chunkCache = new Map();
  const inFlightChunks = new Map();
  let cachedBytes = 0;
  let concurrentDecks = 0;
  let concurrentBytes = 0;

  function trimChunkCache() {
    while (chunkCache.size > maxCachedDecks || cachedBytes > maxCachedBytes) {
      const oldestKey = chunkCache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = chunkCache.get(oldestKey);
      chunkCache.delete(oldestKey);
      cachedBytes -= oldest.bytes;
    }
  }

  async function loadChunk(descriptor, record, unavailableCode) {
    const cacheKey = stableJson([
      descriptor.constructorRef,
      descriptor.catalogRef,
      record.catalogDeckId,
      record.catalogVersion,
      record.payloadDigest,
      record.chunk.digest,
    ]);
    const cached = chunkCache.get(cacheKey);
    if (cached) {
      chunkCache.delete(cacheKey);
      chunkCache.set(cacheKey, cached);
      return { value: cached.value, cacheHit: true };
    }
    const inFlight = inFlightChunks.get(cacheKey);
    if (inFlight) {
      return { value: await inFlight, cacheHit: true };
    }
    const reservedBytes = Math.max(record.chunk.bytes, record.chunk.bytes * 4);
    if (concurrentDecks + 1 > maxConcurrentDecks || concurrentBytes + reservedBytes > maxConcurrentBytes) {
      libraryError("SERVICE_BUSY", "Library asset verification capacity is busy; retry the same request.");
    }
    concurrentDecks += 1;
    concurrentBytes += reservedBytes;
    const pending = (async () => {
      try {
        let bytes;
        try {
          bytes = await descriptor.readAsset(record.chunk.key);
        } catch (error) {
          if (error?.code === "SERVICE_BUSY") throw error;
          libraryError(unavailableCode, `Exact Library asset ${record.catalogDeckId} is unavailable.`);
        }
        if (bytes === undefined || bytes === null) {
          libraryError(unavailableCode, `Exact Library asset ${record.catalogDeckId} is unavailable.`);
        }
        return await verifyResolverChunk(descriptor, record, bytes);
      } catch (error) {
        throw error;
      } finally {
        concurrentDecks -= 1;
        concurrentBytes -= reservedBytes;
      }
    })();
    inFlightChunks.set(cacheKey, pending);
    try {
      const value = await pending;
      if (inFlightChunks.get(cacheKey) === pending) inFlightChunks.delete(cacheKey);
      chunkCache.set(cacheKey, { value, bytes: reservedBytes });
      cachedBytes += reservedBytes;
      trimChunkCache();
      return { value, cacheHit: false };
    } catch (error) {
      if (inFlightChunks.get(cacheKey) === pending) inFlightChunks.delete(cacheKey);
      throw error;
    }
  }

  async function resolveTransaction({ constructorCatalogRef, stateJson, intent } = {}) {
    const activeDescriptor = descriptorByConstructor.get(stableJson(requireReference(
      constructorCatalogRef,
      "constructor catalog reference",
    )));
    requireThat(activeDescriptor,
      "The requested constructor catalog does not match this resolver.", INTEGRITY);
    const requested = [];
    const requestedKeys = new Set();
    const addRequest = (descriptor, record, unavailableCode) => {
      const key = `${descriptor.descriptorDigest}\u0000${record.catalogDeckId}`;
      if (requestedKeys.has(key)) return;
      requestedKeys.add(key);
      requested.push({ descriptor, record, unavailableCode });
    };
    const requireWithinResolutionBudget = (phase) => {
      const required = requested.reduce((totals, request) => {
        totals.decks += 1;
        totals.cards += request.record.cardCount;
        totals.raw_chunk_bytes += request.record.chunk.bytes;
        requireThat(Number.isSafeInteger(totals.cards) && Number.isSafeInteger(totals.raw_chunk_bytes),
          "Library resolution totals exceed safe integer bounds.", INTEGRITY);
        return totals;
      }, { decks: 0, cards: 0, raw_chunk_bytes: 0 });
      if (required.decks > transactionBudget.max_decks
        || required.cards > transactionBudget.max_cards
        || required.raw_chunk_bytes > transactionBudget.max_raw_chunk_bytes) {
        libraryError(
          "LIBRARY_RESOLUTION_LIMIT_EXCEEDED",
          "This exact Library request exceeds the configured runtime resolution limit.",
          {
            phase,
            required,
            limit: {
              decks: transactionBudget.max_decks,
              cards: transactionBudget.max_cards,
              raw_chunk_bytes: transactionBudget.max_raw_chunk_bytes,
            },
          },
        );
      }
      return required;
    };

    for (const saved of savedLibraryReferences(stateJson)) {
      const candidates = (descriptorsByCatalog.get(stableJson(saved.catalogRef)) ?? []).filter((descriptor) => {
        const record = descriptor.records.get(saved.catalogDeckId);
        return descriptor.graphDigest === saved.dependencyGraphDigest
          && descriptor.normalizationVersion === saved.normalizationVersion
          && record?.catalogVersion === saved.catalogVersion
          && record.payloadDigest === saved.payloadDigest
          && record.artifactDigest === saved.artifactDigest;
      });
      const descriptor = candidates.includes(activeDescriptor)
        ? activeDescriptor
        : candidates.length === 1 ? candidates[0] : null;
      if (!descriptor) libraryError("CATALOG_BASE_UNAVAILABLE", `Saved Library release ${saved.catalogRef.version} is unavailable or ambiguous.`);
      const record = descriptor.records.get(saved.catalogDeckId);
      addRequest(descriptor, record, "CATALOG_BASE_UNAVAILABLE");
    }
    requireWithinResolutionBudget("saved_state");

    const name = operationName(intent);
    const args = operationArgs(intent);
    if (["get_deck", "getDeck", "inspect_deck", "inspectDeck"].includes(name) && args.scope === "library") {
      const deckId = requireId(args.deck_id, "deck_id");
      const record = activeDescriptor.records.get(deckId);
      if (!record) libraryError("CATALOG_DECK_NOT_FOUND", `Unknown catalog deck ${deckId}.`);
      addRequest(activeDescriptor, record, "CATALOG_BASE_UNAVAILABLE");
    }
    let installationRoot = null;
    if (["add_library_deck", "addLibraryDeck"].includes(name)) {
      const deckId = requireId(args.library_deck_id, "library_deck_id");
      installationRoot = activeDescriptor.records.get(deckId);
      if (!installationRoot) libraryError("CATALOG_DECK_NOT_FOUND", `Unknown catalog deck ${deckId}.`);
      if (String(args.expected_catalog_version ?? "") !== installationRoot.catalogVersion) {
        libraryError("STALE_CATALOG_VERSION", `Catalog deck ${deckId} changed version.`);
      }
      for (const requiredId of installationRoot.requiredCatalogDeckIds) {
        const required = activeDescriptor.records.get(requiredId);
        if (!required) libraryError("LIBRARY_DEPENDENCY_MISSING", `Required Library base ${requiredId} is unavailable.`);
        addRequest(activeDescriptor, required, "LIBRARY_DEPENDENCY_MISSING");
      }
    }
    const requiredResolution = requireWithinResolutionBudget("operation");

    const loadedByDescriptor = new Map(descriptors.map((descriptor) => [descriptor, new Map()]));
    let assetReadCount = 0;
    let loadedBytes = 0;
    for (const request of requested) {
      const resolved = await loadChunk(request.descriptor, request.record, request.unavailableCode);
      loadedByDescriptor.get(request.descriptor).set(request.record.catalogDeckId, resolved.value);
      if (!resolved.cacheHit) assetReadCount += 1;
      loadedBytes += resolved.value.bytes;
    }
    if (installationRoot) verifyLoadedClosure(installationRoot, loadedByDescriptor.get(activeDescriptor));

    const storeCatalogView = preparedResolverView(activeDescriptor, loadedByDescriptor.get(activeDescriptor), true);
    const retainedCatalogViews = descriptors
      .filter((descriptor) => descriptor !== activeDescriptor && loadedByDescriptor.get(descriptor).size > 0)
      .map((descriptor) => preparedResolverView(descriptor, loadedByDescriptor.get(descriptor), false));
    const loadedRefs = requested.map(({ descriptor, record }) => ({
      catalog_ref: descriptor.catalogRef,
      catalog_deck_id: record.catalogDeckId,
      catalog_version: record.catalogVersion,
      projected_payload_sha256: record.payloadDigest,
      chunk_sha256: record.chunk.digest,
    }));
    const resolvedViewDigest = await sha256(stableJson({
      constructor_ref: activeDescriptor.constructorRef,
      descriptor_sha256: activeDescriptor.descriptorDigest,
      loaded: loadedRefs,
    }));
    return deepFreeze({
      constructorCatalogRef: { ...activeDescriptor.constructorRef },
      storeCatalogView,
      retainedCatalogViews,
      sourcePins: {
        descriptorDigest: activeDescriptor.descriptorDigest,
        sourceManifestDigest: activeDescriptor.sourceManifestDigest,
        preparedConstructorDigest: activeDescriptor.preparedConstructorDigest,
        rawCatalogRef: { ...activeDescriptor.catalogRef },
        dependencyGraphDigest: activeDescriptor.graphDigest,
        normalizationVersion: activeDescriptor.normalizationVersion,
        criterionDerivationVersion: activeDescriptor.criterionDerivationVersion,
      },
      resolution: {
        loadedCatalogDeckIds: requested.map((item) => item.record.catalogDeckId),
        loadedDeckCount: requested.length,
        loadedCardCount: requested.reduce((sum, item) => sum + item.record.cardCount, 0),
        loadedBytes,
        assetReadCount,
        required: requiredResolution,
        limit: {
          decks: transactionBudget.max_decks,
          cards: transactionBudget.max_cards,
          raw_chunk_bytes: transactionBudget.max_raw_chunk_bytes,
        },
        resolved_view_digest: resolvedViewDigest,
      },
    }, new WeakSet());
  }

  return Object.freeze({
    kind: RESOLVER_KIND,
    constructorCatalogRef: Object.freeze({ ...primary.constructorRef }),
    constructorCatalogRefs: Object.freeze(descriptors.map((descriptor) => Object.freeze({ ...descriptor.constructorRef }))),
    resolutionBudget: transactionBudget,
    resolveTransaction,
  });
}
