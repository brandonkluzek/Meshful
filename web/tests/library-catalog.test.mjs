import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { prepareLibraryCatalog } from "../js/library-catalog.js";

const VERSION = "synthetic-reviewed.v1";
const CATALOG = (sourceId) => `academic-reviewed-v1:${sourceId}`;
const INVALID = "INVALID_LIBRARY_CATALOG";
const INTEGRITY = "LIBRARY_CATALOG_INTEGRITY";
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

// Independent fixture encoding/hash; never imports the adapter's implementation.
function fixtureJson(value) {
  if (Array.isArray(value)) return `[${value.map(fixtureJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${fixtureJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(fixtureJson(value), "utf8").digest("hex")}`;
}

function fixtureCard(sourceId, id, prerequisites = []) {
  return {
    id,
    canonical_deck_id: sourceId,
    term: `Concept ${id}`,
    prompt: "  Define α.\r\n",
    definition: "  α is a synthetic concept.\r\nPreserve this whitespace.  ",
    required_concepts: ["  First concept.  ", { id: "explicit-required", text: "Second concept." }],
    accepted_variants: ["Alternative β", "Alternative α"],
    major_error_concepts: [{ rubric_item_id: "explicit-error", text: "A synthetic contradiction." }],
    prerequisite_ids: prerequisites,
    source_refs: ["private-source-sha256:synthetic-opaque-reference"],
    tags: [],
  };
}

function rebuildGraph(feed) {
  const owners = new Map(feed.catalog.flatMap((deck) => deck.cards.map((card) => [card.id, card.canonical_deck_id])));
  feed.dependency_edges = feed.catalog.flatMap((deck) => deck.cards.flatMap((card) => card.prerequisite_ids.map((parent) => ({
    prerequisite_card_id: parent,
    dependent_card_id: card.id,
    prerequisite_source_deck_id: owners.get(parent) ?? "missing-owner",
    dependent_source_deck_id: card.canonical_deck_id,
    requirement: "required",
    gate: "first_introduction",
  })))).sort((left, right) => compare(left.prerequisite_card_id, right.prerequisite_card_id)
    || compare(left.dependent_card_id, right.dependent_card_id));
  for (const deck of feed.catalog) {
    const sourceId = deck.cards[0].canonical_deck_id;
    deck.edges = feed.dependency_edges.filter((edge) => edge.prerequisite_source_deck_id === sourceId && edge.dependent_source_deck_id === sourceId)
      .map(({ prerequisite_card_id, dependent_card_id }) => ({ prerequisite_card_id, dependent_card_id }));
  }
  return rehash(feed);
}

function rehash(feed) {
  feed.catalog_ref.digest = digest(feed.catalog);
  feed.dependency_graph_sha256 = digest(feed.dependency_edges);
  return feed;
}

function fixtureFeed() {
  const definitions = [
    ["alpha", [fixtureCard("alpha", "opaque.z"), fixtureCard("alpha", "opaque.a", ["opaque.z"]), fixtureCard("alpha", "opaque.branch", ["opaque.z"])]],
    ["beta", [fixtureCard("beta", "other.parent", ["opaque.a"])]],
    // Deliberately not lexical prerequisite order: source list order must survive.
    ["gamma", [fixtureCard("gamma", "final.child", ["other.parent", "opaque.z"])]],
    ["omega", [fixtureCard("omega", "unrelated.card")]],
  ];
  const catalog = definitions.map(([sourceId, cards]) => ({
    id: CATALOG(sourceId), version: VERSION, title: `Synthetic ${sourceId}`,
    subject: "Synthetic", domain: "Synthetic", review_status: "ai-reviewed-local-candidate",
    content_status: "private-candidate-not-admitted", evidence_tier: "synthetic-test-only",
    rights_status: "not-cleared", license: null, cards, edges: [],
  }));
  const feed = {
    projection_schema_version: "meshful-library-catalog-input.v1",
    audience: "private", public_release_approved: false, rights_status: "not-cleared",
    current_runtime_compatible: false,
    catalog,
    dependency_edges: [],
    source_card_index: {},
    runtime_identity_map: {
      normalization_version: "canonical-library-card-identity.v1",
      rule: "Canonical IDs stay unchanged.",
      decks: [], cards: {},
    },
    source_reference_map: { private_record: { artifact_path: "private/never-return-this-map.json" } },
    catalog_ref: { version: VERSION, digest: "" },
    dependency_graph_sha256: "",
  };
  for (const [sourceId, cards] of definitions) {
    feed.runtime_identity_map.decks.push({
      source_deck_id: sourceId, catalog_deck_id: CATALOG(sourceId),
      catalog_deck_version: VERSION, personal_deck_id: null,
    });
    cards.forEach((card, index) => {
      feed.source_card_index[card.id] = {
        source_deck_id: sourceId, catalog_deck_id: CATALOG(sourceId),
        artifact_sha256: digest({ synthetic_source: sourceId }),
        artifact_path: `private/sources/${sourceId}.json`, json_pointer: `/cards/${index}`,
      };
      feed.runtime_identity_map.cards[card.id] = {
        source_card_id: card.id, runtime_card_id: card.id,
        catalog_deck_id: CATALOG(sourceId), personal_deck_id: null,
      };
    });
  }
  return rebuildGraph(feed);
}

async function rejects(feed, code = INTEGRITY, message) {
  await assert.rejects(prepareLibraryCatalog(feed), (error) => {
    assert.equal(error.name, "LibraryCatalogError");
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("prepares the exact thin constructor input without copying or normalizing raw cards", async () => {
  const feed = fixtureFeed();
  const originalJson = JSON.stringify(feed.catalog);
  const rawCard = feed.catalog[0].cards[0];
  const result = await prepareLibraryCatalog(feed);

  assert.deepEqual(Object.keys(result), ["kind", "catalog", "library"]);
  assert.equal(result.kind, "meshful-library-runtime-catalog.v1");
  assert.equal(result.catalog, feed.catalog);
  assert.equal(result.catalog[0].cards[0], rawCard);
  assert.equal(JSON.stringify(result.catalog), originalJson);
  assert.equal(result.library.normalizationVersion, "canonical-library-card-identity.v1");
  assert.deepEqual(result.library.catalogRef, feed.catalog_ref);
  assert.equal(result.library.dependencyGraphDigest, feed.dependency_graph_sha256);
  assert.deepEqual(Object.keys(result.library).sort(), ["catalogRef", "decks", "dependencyGraphDigest", "normalizationVersion"]);
  for (const deck of result.catalog) {
    const metadata = result.library.decks[deck.id];
    assert.deepEqual(Object.keys(metadata).sort(), [
      "artifactDigest", "catalogDeckId", "catalogVersion", "directDependencyCatalogDeckIds",
      "payloadDigest", "requiredCatalogDeckIds", "sourceDeckId",
    ]);
    assert.equal(metadata.payloadDigest, digest(deck));
    assert.equal(metadata.artifactDigest, digest({ synthetic_source: metadata.sourceDeckId }));
    assert.equal(metadata.catalogVersion, VERSION);
  }
  assert.equal(rawCard.required_concepts[0], "  First concept.  ");
  assert.equal(rawCard.required_concepts[1].id, "explicit-required");
  assert.equal(rawCard.major_error_concepts[0].rubric_item_id, "explicit-error");
  assert.deepEqual(result.catalog[2].cards[0].prerequisite_ids, ["other.parent", "opaque.z"]);
});

test("returns a recursively frozen catalog and thin metadata without private maps or paths", async () => {
  const feed = fixtureFeed();
  const result = await prepareLibraryCatalog(feed);
  const checkFrozen = (value) => {
    if (!value || typeof value !== "object") return;
    assert.ok(Object.isFrozen(value));
    Object.values(value).forEach(checkFrozen);
  };
  checkFrozen(result);
  assert.throws(() => { result.catalog[0].cards[0].term = "mutated"; }, TypeError);
  assert.throws(() => { result.library.decks[CATALOG("gamma")].requiredCatalogDeckIds.push("bad"); }, TypeError);
  assert.equal(Object.isFrozen(feed.source_card_index), false);
  assert.equal(Object.isFrozen(feed.source_reference_map), false);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes("private/sources/"), false);
  assert.equal(encoded.includes("never-return-this-map"), false);
  assert.equal(encoded.includes("json_pointer"), false);
});

test("derives complete parent-first closures and sorted direct parents from explicit ownership", async () => {
  const result = await prepareLibraryCatalog(fixtureFeed());
  const decks = result.library.decks;
  assert.deepEqual(decks[CATALOG("gamma")].requiredCatalogDeckIds, [CATALOG("alpha"), CATALOG("beta"), CATALOG("gamma")]);
  assert.deepEqual(decks[CATALOG("gamma")].directDependencyCatalogDeckIds, [CATALOG("alpha"), CATALOG("beta")]);
  assert.deepEqual(decks[CATALOG("beta")].requiredCatalogDeckIds, [CATALOG("alpha"), CATALOG("beta")]);
  assert.deepEqual(decks[CATALOG("alpha")].requiredCatalogDeckIds, [CATALOG("alpha")]);
  assert.deepEqual(decks[CATALOG("omega")].requiredCatalogDeckIds, [CATALOG("omega")]);
  assert.deepEqual(decks[CATALOG("omega")].directDependencyCatalogDeckIds, []);
  assert.equal(decks[CATALOG("alpha")].sourceDeckId, "alpha");
  assert.equal(result.catalog[0].cards[0].id, "opaque.z");
});

test("object key insertion order does not change the stable JSON hash", async () => {
  const feed = fixtureFeed();
  const oldDigest = feed.catalog_ref.digest;
  feed.catalog[0].cards[0] = Object.fromEntries(Object.entries(feed.catalog[0].cards[0]).reverse());
  const result = await prepareLibraryCatalog(feed);
  assert.equal(result.library.catalogRef.digest, oldDigest);
});

test("an already prepared frozen raw catalog can be independently prepared again", async () => {
  const feed = fixtureFeed();
  const first = await prepareLibraryCatalog(feed);
  const second = await prepareLibraryCatalog(feed);
  assert.equal(first.catalog, second.catalog);
  assert.deepEqual(first.library, second.library);
});

test("captures metadata and freezes raw objects before the first asynchronous hash", async () => {
  const feed = fixtureFeed();
  const originalCatalog = feed.catalog;
  const originalRef = { ...feed.catalog_ref };
  const graphDigest = feed.dependency_graph_sha256;
  const pending = prepareLibraryCatalog(feed);
  assert.ok(Object.isFrozen(originalCatalog));
  assert.throws(() => { originalCatalog[0].cards[0].term = "changed during bootstrap"; }, TypeError);
  feed.catalog = [];
  feed.catalog_ref.digest = `sha256:${"0".repeat(64)}`;
  feed.dependency_edges.length = 0;
  const result = await pending;
  assert.equal(result.catalog, originalCatalog);
  assert.deepEqual(result.library.catalogRef, originalRef);
  assert.equal(result.library.dependencyGraphDigest, graphDigest);
});

for (const [label, mutate] of [
  ["catalog release hash drift", (feed) => { feed.catalog_ref.digest = `sha256:${"0".repeat(64)}`; }],
  ["required graph hash drift", (feed) => { feed.dependency_graph_sha256 = `sha256:${"0".repeat(64)}`; }],
  ["definition byte drift", (feed) => { feed.catalog[0].cards[0].definition += " changed"; }],
  ["criterion order drift", (feed) => { feed.catalog[0].cards[0].required_concepts.reverse(); }],
  ["criterion ID drift", (feed) => { feed.catalog[0].cards[0].required_concepts[1].id = "changed-id"; }],
  ["required parent order drift", (feed) => { feed.catalog[2].cards[0].prerequisite_ids.reverse(); }],
]) {
  test(`rejects ${label}`, async () => {
    const feed = fixtureFeed(); mutate(feed); await rejects(feed);
  });
}

test("rejects reordered catalog decks even when a replacement hash is supplied", async () => {
  const feed = fixtureFeed(); feed.catalog.reverse(); rehash(feed); await rejects(feed);
});

test("rejects reordered source cards through their unchanged exact JSON pointers", async () => {
  const feed = fixtureFeed(); feed.catalog[0].cards.reverse(); rehash(feed); await rejects(feed);
});

test("rejects reordered required edges even when a replacement hash is supplied", async () => {
  const feed = fixtureFeed(); feed.dependency_edges.reverse(); rehash(feed); await rejects(feed);
});

test("rejects a dropped global required edge", async () => {
  const feed = fixtureFeed(); feed.dependency_edges.pop(); rehash(feed); await rejects(feed);
});

test("rejects a dropped card prerequisite even if the raw catalog hash is recomputed", async () => {
  const feed = fixtureFeed(); feed.catalog[2].cards[0].prerequisite_ids.pop(); rehash(feed); await rejects(feed);
});

test("rejects duplicated required edges", async () => {
  const feed = fixtureFeed(); feed.dependency_edges[1] = { ...feed.dependency_edges[0] }; rehash(feed); await rejects(feed);
});

test("rejects a local edge projection that omits an internal prerequisite", async () => {
  const feed = fixtureFeed(); feed.catalog[0].edges.length = 0; rehash(feed); await rejects(feed);
});

test("rejects reordered local required edges even when a replacement catalog hash is supplied", async () => {
  const feed = fixtureFeed(); feed.catalog[0].edges.reverse(); rehash(feed); await rejects(feed);
});

for (const [label, mutate] of [
  ["edge owner change", (feed) => { feed.dependency_edges[0].prerequisite_source_deck_id = "omega"; }],
  ["advisory downgrade", (feed) => { feed.dependency_edges[0].requirement = "advisory"; }],
  ["different introduction gate", (feed) => { feed.dependency_edges[0].gate = "all_reviews"; }],
  ["direction reversal", (feed) => {
    const edge = feed.dependency_edges[0];
    [edge.prerequisite_card_id, edge.dependent_card_id] = [edge.dependent_card_id, edge.prerequisite_card_id];
    feed.dependency_edges.sort((left, right) => compare(left.prerequisite_card_id, right.prerequisite_card_id)
      || compare(left.dependent_card_id, right.dependent_card_id));
  }],
]) {
  test(`rejects ${label}`, async () => {
    const feed = fixtureFeed(); mutate(feed); rehash(feed); await rejects(feed);
  });
}

test("rejects unresolved required endpoints", async () => {
  const feed = fixtureFeed(); feed.catalog[2].cards[0].prerequisite_ids.push("missing.parent");
  rebuildGraph(feed); await rejects(feed, INVALID, /endpoint is missing/);
});

test("rejects card cycles even when all hashes and owner maps agree", async () => {
  const feed = fixtureFeed(); feed.catalog[0].cards[0].prerequisite_ids.push("opaque.a");
  rebuildGraph(feed); await rejects(feed, INVALID, /card dependencies contain a cycle/);
});

test("rejects deck dependency cycles even when the global card graph is acyclic", async () => {
  const feed = fixtureFeed();
  feed.catalog[0].cards[1].prerequisite_ids = ["other.parent"];
  feed.catalog[1].cards[0].prerequisite_ids = ["opaque.z"];
  rebuildGraph(feed); await rejects(feed, INVALID, /deck dependencies contain a cycle/);
});

for (const [label, mutate] of [
  ["prefixed runtime card ID", (feed) => { feed.runtime_identity_map.cards["opaque.z"].runtime_card_id = "deck-alpha.opaque.z"; }],
  ["source ID alias", (feed) => { feed.runtime_identity_map.cards["opaque.z"].source_card_id = "another.source"; }],
  ["card source owner mismatch", (feed) => { feed.catalog[0].cards[0].canonical_deck_id = "beta"; }],
  ["source index owner mismatch", (feed) => { feed.source_card_index["opaque.z"].source_deck_id = "beta"; }],
  ["runtime catalog owner mismatch", (feed) => { feed.runtime_identity_map.cards["opaque.z"].catalog_deck_id = CATALOG("beta"); }],
  ["source catalog owner mismatch", (feed) => { feed.source_card_index["opaque.z"].catalog_deck_id = CATALOG("beta"); }],
  ["source pointer order mismatch", (feed) => { feed.source_card_index["opaque.z"].json_pointer = "/cards/1"; }],
  ["already assigned card installation", (feed) => { feed.runtime_identity_map.cards["opaque.z"].personal_deck_id = "deck-alpha"; }],
  ["already assigned deck installation", (feed) => { feed.runtime_identity_map.decks[0].personal_deck_id = "deck-alpha"; }],
  ["wrong deck version", (feed) => { feed.catalog[0].version = "another-release"; }],
  ["wrong mapped deck version", (feed) => { feed.runtime_identity_map.decks[0].catalog_deck_version = "another-release"; }],
  ["missing source identity", (feed) => { delete feed.source_card_index["opaque.z"]; }],
  ["missing runtime identity", (feed) => { delete feed.runtime_identity_map.cards["opaque.z"]; }],
  ["extra source identity", (feed) => { feed.source_card_index.extra = { ...feed.source_card_index["opaque.z"] }; }],
  ["extra runtime identity", (feed) => { feed.runtime_identity_map.cards.extra = { ...feed.runtime_identity_map.cards["opaque.z"] }; }],
  ["inconsistent source artifact digest", (feed) => { feed.source_card_index["opaque.a"].artifact_sha256 = digest("different-source"); }],
  ["ambiguous source artifact path", (feed) => { feed.source_card_index["opaque.a"].artifact_path = "private/sources/another.json"; }],
]) {
  test(`rejects ${label}`, async () => {
    const feed = fixtureFeed(); mutate(feed); await rejects(feed);
  });
}

test("rejects duplicate canonical card IDs", async () => {
  const feed = fixtureFeed(); feed.catalog[0].cards[1].id = "opaque.z"; await rejects(feed, INVALID);
});

test("rejects duplicate source-deck mappings", async () => {
  const feed = fixtureFeed(); feed.runtime_identity_map.decks[1].source_deck_id = "alpha"; await rejects(feed, INVALID);
});

test("rejects duplicate catalog-deck mappings", async () => {
  const feed = fixtureFeed(); feed.runtime_identity_map.decks[1].catalog_deck_id = CATALOG("alpha"); await rejects(feed, INVALID);
});

test("rejects duplicate prerequisite IDs", async () => {
  const feed = fixtureFeed(); feed.catalog[2].cards[0].prerequisite_ids.push("opaque.z"); await rejects(feed, INVALID);
});

test("rejects self prerequisites", async () => {
  const feed = fixtureFeed(); feed.catalog[0].cards[0].prerequisite_ids.push("opaque.z"); await rejects(feed, INVALID);
});

test("rejects a missing or malformed artifact pin", async () => {
  const feed = fixtureFeed(); delete feed.source_card_index["opaque.z"].artifact_sha256; await rejects(feed, INVALID);
});

test("rejects criterion ID collisions, including derived ordinal IDs", async () => {
  const feed = fixtureFeed();
  feed.catalog[0].cards[0].major_error_concepts[0].rubric_item_id = "required-concepts-1";
  await rejects(feed, INVALID);
});

test("rejects conflicting explicit criterion aliases", async () => {
  const feed = fixtureFeed();
  feed.catalog[0].cards[0].required_concepts[1].rubric_item_id = "different-explicit-id";
  await rejects(feed);
});

for (const [field, value] of [
  ["audience", "public"], ["public_release_approved", true],
  ["rights_status", "cleared"], ["current_runtime_compatible", true],
  ["projection_schema_version", "normalized-definition-deck.v2"],
]) {
  test(`rejects changed private guard ${field}`, async () => {
    const feed = fixtureFeed(); feed[field] = value; await rejects(feed, INVALID);
  });
}

test("rejects unsupported identity normalization", async () => {
  const feed = fixtureFeed(); feed.runtime_identity_map.normalization_version = "unknown"; await rejects(feed, INVALID);
});

for (const [label, value] of [
  ["undefined", undefined], ["nonfinite", Number.NaN], ["bigint", 1n],
  ["date", new Date("2026-01-01T00:00:00Z")], ["function", () => null],
]) {
  test(`rejects non-JSON ${label} without producing a constructor input`, async () => {
    const feed = fixtureFeed(); feed.invalid_value = value; await rejects(feed, INVALID);
  });
}

test("rejects cyclic input data", async () => {
  const feed = fixtureFeed(); feed.self = feed; await rejects(feed, INVALID);
});

test("rejects getters without invoking them", async () => {
  const feed = fixtureFeed();
  let invoked = false;
  Object.defineProperty(feed, "unsafe", { enumerable: true, get() { invoked = true; return "unsafe"; } });
  await rejects(feed, INVALID);
  assert.equal(invoked, false);
});

test("rejects sparse arrays instead of hashing their holes as a different value", async () => {
  const feed = fixtureFeed(); delete feed.catalog[0].cards[0].required_concepts[0]; await rejects(feed, INVALID);
});

test("rejects symbol and hidden object properties", async () => {
  const symbolFeed = fixtureFeed(); symbolFeed[Symbol("hidden")] = true; await rejects(symbolFeed, INVALID);
  const hiddenFeed = fixtureFeed(); Object.defineProperty(hiddenFeed, "hidden", { value: true }); await rejects(hiddenFeed, INVALID);
});

test("rejects an empty catalog rather than inventing artifact identities", async () => {
  const feed = fixtureFeed(); feed.catalog = []; await rejects(feed, INVALID);
});
