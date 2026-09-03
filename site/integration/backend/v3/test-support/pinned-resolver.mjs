import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PRIVATE_MANIFEST_SHA256 = "sha256:172e079349252368559beeddcd540b34f02c769f66fa5e8bfd6092f49f6ad8b8";
export const RESOLUTION_BUDGET = Object.freeze({
  max_decks: 42,
  max_cards: 5_500,
  max_raw_chunk_bytes: 7_000_000,
});
export const RUNTIME_SOURCE_SHA256 = Object.freeze({
  "web/js/library-catalog.js": "16a3a2ef5dc924e39dba07189d6f7c2c633808b8c3c5e539e12f993956711bd1",
  "web/js/store.js": "4e288fe72bf248acbf086bdef73eb9bc52a2718afd69f510ce98fccf5607bb76",
  "web/js/webmcp.js": "9faa86f447eddf4424b432075129f02ea7d7875eb6b2f1ea78f25181aae440df",
  "web/js/streak.js": "ef5337ebb320bc1cd96f292164dd57667189ff04eb7150ff4a926e2938e9ead3",
  "web/tests/library-resolver.test.mjs": "3d3714b0b77da949571e0fa87530a60cd20ad0de517d138a1d3dbc57a0543a23",
  "web/tests/library-catalog.test.mjs": "771fcd14c4df4904b808db6ea2c002bf2d312a46804713ac7b003f9bc0603fc1",
});
export const ASSET_MANIFEST_SHA256 = "f3a02d02441f8d7ba9a5e19e3e3c89c1e66501a796bdf80750419ed8a0272bba";
export const INDEX_SHA256 = "sha256:6daff48b99faae5047a69d56cfbbf7aa6b162367337044ce59e9774bbfc29a00";
export const ASSET_ENTRIES_SHA256 = "sha256:c9633fa60352ae81406e8f58f800e19df535bc76c25c6cce6f4d9e8c66e43248";
const EXPECTED_PINS = Object.freeze({
  constructorRef: Object.freeze({
    version: "2026-08-30.reviewed-72.v1",
    digest: "sha256:e3d0daad45310fa3d7e1cf473156d09d9700fd504fc41b1b770989cadab816b7",
  }),
  preparedConstructorDigest: "sha256:e26951ad5070be6546561f2769659dda87715fb6dc6d061b5ee6ed3b1b17f461",
  catalogRef: Object.freeze({
    version: "2026-08-30.reviewed-72.v1",
    digest: "sha256:908e28f0a7a43ec53715a6811d0cc09c59f627fb3f74de01fc8fbceb7fbe84bb",
  }),
  dependencyGraphSha256: "sha256:82025162442152929780e8bcf42066361b8ebc1602c899b1f706f621b2257ce0",
  sourceManifestSha256: PRIVATE_MANIFEST_SHA256,
  criterionDerivationVersion: "store-normalizeRubricItems-ordinal.v1",
});
let libraryPromise;

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const codeUnitCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

// Authorized private runtime-artifact input. This helper validates the reviewed
// manifest and exact generated assets in memory; it never reads the raw feed or
// writes catalog, card, source-map or chunk bytes.
export function loadPinnedResolverLibrary() {
  libraryPromise ??= load().catch((error) => {
    const code = /^[A-Z0-9_]+$/.test(error?.code ?? "")
      ? error.code : "PRIVATE_RESOLVER_ARTIFACT_PREPARATION_FAILED";
    const safe = new Error(code);
    safe.code = code;
    throw safe;
  });
  return libraryPromise;
}

async function load() {
  assert.ok(process.env.MESHFUL_CANONICAL_ROOT,
    "Supply the authorized canonical source root");
  assert.ok(process.env.MESHFUL_LIBRARY_ASSET_ROOT,
    "Supply the authorized reviewed Library asset root");
  const canonicalRoot = resolve(process.env.MESHFUL_CANONICAL_ROOT);
  const assetRoot = resolve(process.env.MESHFUL_LIBRARY_ASSET_ROOT);
  for (const [path, expected] of Object.entries(RUNTIME_SOURCE_SHA256)) {
    assert.equal(sha256(await readFile(join(canonicalRoot, path))), `sha256:${expected}`,
      `Canonical source pin differs: ${path}`);
  }
  const manifestBytes = await readFile(join(
    canonicalRoot, "docs/challenge/WEBMCP_LIBRARY_RESOLVER_ASSET_MANIFEST.json",
  ));
  assert.equal(sha256(manifestBytes), `sha256:${ASSET_MANIFEST_SHA256}`,
    "Resolver asset manifest pin differs");
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schema_version, "meshful-library-resolver-asset-manifest.v1");
  assert.equal(manifest.private_candidate, true);
  assert.equal(manifest.public_release_approved, false);
  assert.equal(manifest.rights_status, "not-cleared");
  assert.deepEqual(manifest.resolution_budget, RESOLUTION_BUDGET);
  assert.equal(manifest.index.byte_length, 368_126);
  assert.equal(manifest.index.sha256, INDEX_SHA256);
  assert.equal(manifest.asset_entries_sha256, ASSET_ENTRIES_SHA256);
  assert.equal(manifest.runtime_source.library_catalog_sha256,
    RUNTIME_SOURCE_SHA256["web/js/library-catalog.js"]);
  assert.equal(manifest.runtime_source.paired_store_sha256,
    RUNTIME_SOURCE_SHA256["web/js/store.js"]);
  assert.equal(manifest.runtime_source.resolver_test_sha256,
    RUNTIME_SOURCE_SHA256["web/tests/library-resolver.test.mjs"]);
  assert.equal(manifest.assets.length, 72);
  const entries = manifest.assets.map((entry) => ({
    key: entry.key,
    byte_length: entry.byte_length,
    sha256: entry.sha256,
  }));
  assert.deepEqual(entries.map((entry) => entry.key),
    [...entries].sort((left, right) => codeUnitCompare(left.key, right.key)).map((entry) => entry.key));
  assert.equal(sha256(JSON.stringify(entries)), ASSET_ENTRIES_SHA256);

  const indexFileBytes = await readFile(join(assetRoot, manifest.index.key));
  assert.equal(indexFileBytes.byteLength, manifest.index.byte_length);
  assert.equal(sha256(indexFileBytes), INDEX_SHA256);
  const indexBytes = indexFileBytes.toString("utf8");
  const index = JSON.parse(indexBytes);
  assert.deepEqual(index.constructor_ref, EXPECTED_PINS.constructorRef);
  assert.equal(index.prepared_constructor_digest, EXPECTED_PINS.preparedConstructorDigest);
  assert.deepEqual(index.catalog_ref, EXPECTED_PINS.catalogRef);
  assert.equal(index.dependency_graph_sha256, EXPECTED_PINS.dependencyGraphSha256);
  assert.equal(index.source_manifest_sha256, EXPECTED_PINS.sourceManifestSha256);
  assert.equal(index.criterion_derivation_version, EXPECTED_PINS.criterionDerivationVersion);
  assert.equal(index.decks.length, 72);

  const chunks = [];
  for (const entry of entries) {
    assert.match(entry.key, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
    assert.equal(entry.key.split("/").some((part) => part === "." || part === ".."), false);
    const fileBytes = await readFile(join(assetRoot, entry.key));
    assert.equal(fileBytes.byteLength, entry.byte_length);
    assert.equal(sha256(fileBytes), entry.sha256);
    chunks.push({ key: entry.key, bytes: fileBytes.toString("utf8"), byte_length: entry.byte_length, sha256: entry.sha256 });
  }
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.byte_length, 0), 12_906_713);
  const deckById = new Map(index.decks.map((deck) => [deck.catalog_deck_id, deck]));
  const closureCards = (deck) => deck.required_catalog_deck_ids
    .reduce((sum, id) => sum + deckById.get(id).card_count, 0);
  const root = index.decks.reduce((largest, deck) =>
    closureCards(deck) > closureCards(largest) ? deck : largest);
  assert.equal(root.required_catalog_deck_ids.length, 14);
  assert.equal(closureCards(root), 1_892);
  const counts = Object.freeze({
    decks: 72,
    cards: index.decks.reduce((sum, deck) => sum + deck.card_count, 0),
    prerequisite_edges: index.decks.reduce((sum, deck) => sum + deck.prerequisite_edge_count, 0),
    external_prerequisite_edges: index.decks.reduce((sum, deck) => sum + deck.external_prerequisite_edge_count, 0),
  });
  assert.deepEqual(counts, {
    decks: 72, cards: 9_988, prerequisite_edges: 17_712, external_prerequisite_edges: 770,
  });
  const libraryCatalog = await import(pathToFileURL(join(canonicalRoot, "web/js/library-catalog.js")));
  const chunkMap = new Map(chunks.map((chunk) => [chunk.key, chunk.bytes]));
  const artifacts = Object.freeze({
    index: Object.freeze({ key: manifest.index.key, bytes: indexBytes, sha256: INDEX_SHA256 }),
    chunks: Object.freeze(chunks),
    expectedPins: EXPECTED_PINS,
    counts,
  });
  const expectedCatalogPins = Object.freeze([Object.freeze({
    constructorCatalogRef: EXPECTED_PINS.constructorRef,
    sourcePins: Object.freeze({
      descriptorDigest: INDEX_SHA256,
      sourceManifestDigest: EXPECTED_PINS.sourceManifestSha256,
      preparedConstructorDigest: EXPECTED_PINS.preparedConstructorDigest,
      rawCatalogRef: EXPECTED_PINS.catalogRef,
      dependencyGraphDigest: EXPECTED_PINS.dependencyGraphSha256,
      normalizationVersion: index.normalization_version,
      criterionDerivationVersion: EXPECTED_PINS.criterionDerivationVersion,
    }),
  })]);
  return Object.freeze({
    artifacts,
    expectedCatalogPins,
    root: Object.freeze({
      catalogDeckId: root.catalog_deck_id,
      catalogVersion: root.catalog_version,
      closureDecks: root.required_catalog_deck_ids.length,
      closureCards: closureCards(root),
    }),
    counts,
    sizes: Object.freeze({
      indexBytes: manifest.index.byte_length,
      totalChunkBytes: chunks.reduce((sum, chunk) => sum + chunk.byte_length, 0),
      maxChunkBytes: Math.max(...chunks.map((chunk) => chunk.byte_length)),
    }),
    async createResolver({ failReads = false } = {}) {
      let reads = 0;
      const resolver = await libraryCatalog.prepareLibraryCatalogResolver({
        indexBytes,
        expectedIndexSha256: INDEX_SHA256,
        expectedPins: EXPECTED_PINS,
        resolutionBudget: RESOLUTION_BUDGET,
        readAsset: async (key) => {
          reads += 1;
          if (failReads || !chunkMap.has(key)) {
            throw Object.assign(new Error("Exact Library asset unavailable"), { code: "ENOENT" });
          }
          return chunkMap.get(key);
        },
      });
      return Object.freeze({ resolver, readCount: () => reads });
    },
  });
}
