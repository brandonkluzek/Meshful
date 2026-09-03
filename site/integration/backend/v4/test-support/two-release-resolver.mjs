import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { RESOLUTION_BUDGET } from "../../v3/test-support/pinned-resolver.mjs";

const V2_MANIFEST_SHA256 = "92b9e2b5083d8a45ea11ef6d4793c180c1eed073f56d1577127b17d2fbbd45e7";
const V2_INDEX_SHA256 = "sha256:9638252b82ec483c97e7d40ddee9278aa892db9cc541e47b73c9c7f088efe5a7";
const V1_INDEX_SHA256 = "sha256:6daff48b99faae5047a69d56cfbbf7aa6b162367337044ce59e9774bbfc29a00";
const V2_PINS = Object.freeze({
  constructorRef: Object.freeze({
    version: "2026-09-02.public-sanitized-72.v2",
    digest: "sha256:d24dd2be1b5c03a367defeeb13746701b61c990c9575c110b8e854ba365cbca6",
  }),
  preparedConstructorDigest: "sha256:579338ef3aae223d7a1c2900bfc69bd70d55f94dc8cd472a7882bcee1c883295",
  catalogRef: Object.freeze({
    version: "2026-09-02.public-sanitized-72.v2",
    digest: "sha256:a7ef2efa1d6133879ab8daf6068ff88a17abc23be1590d39932cea82b0ec8642",
  }),
  dependencyGraphSha256: "sha256:82025162442152929780e8bcf42066361b8ebc1602c899b1f706f621b2257ce0",
  sourceManifestSha256: "sha256:599cfb3977a8e95d60c3e0980ff2b3d4b110b121a8e6a62f46518f882d272a55",
  criterionDerivationVersion: "store-normalizeRubricItems-ordinal.v1",
});
const V1_PINS = Object.freeze({
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
  sourceManifestSha256: "sha256:172e079349252368559beeddcd540b34f02c769f66fa5e8bfd6092f49f6ad8b8",
  criterionDerivationVersion: "store-normalizeRubricItems-ordinal.v1",
});

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function enginePin(pins, index, indexDigest) {
  return Object.freeze({
    constructorCatalogRef: pins.constructorRef,
    sourcePins: Object.freeze({
      descriptorDigest: indexDigest,
      sourceManifestDigest: pins.sourceManifestSha256,
      preparedConstructorDigest: pins.preparedConstructorDigest,
      rawCatalogRef: pins.catalogRef,
      dependencyGraphDigest: pins.dependencyGraphSha256,
      normalizationVersion: index.normalization_version,
      criterionDerivationVersion: pins.criterionDerivationVersion,
    }),
  });
}

export async function loadRetainedResolver() {
  assert.ok(process.env.MESHFUL_CANONICAL_ROOT && process.env.MESHFUL_LIBRARY_ASSET_ROOT,
    "Supply canonical and retained v1 Library roots");
  const canonicalRoot = resolve(process.env.MESHFUL_CANONICAL_ROOT);
  const retainedRoot = resolve(process.env.MESHFUL_LIBRARY_ASSET_ROOT);
  const indexBytes = await readFile(join(retainedRoot, "index.json"));
  assert.equal(digest(indexBytes), V1_INDEX_SHA256);
  const index = JSON.parse(indexBytes);
  const catalog = await import(pathToFileURL(join(canonicalRoot, "web/js/library-catalog.js")));
  const resolver = await catalog.prepareLibraryCatalogResolver({
    indexBytes,
    expectedIndexSha256: V1_INDEX_SHA256,
    expectedPins: V1_PINS,
    readAsset: (key) => readFile(join(retainedRoot, key)),
    resolutionBudget: RESOLUTION_BUDGET,
  });
  const physiology = index.decks.find((deck) => deck.catalog_deck_id === "academic-reviewed-v1:physiology");
  assert.ok(physiology);
  return Object.freeze({
    resolver,
    expectedCatalogPins: Object.freeze([enginePin(V1_PINS, index, V1_INDEX_SHA256)]),
    root: Object.freeze({
      catalogDeckId: physiology.catalog_deck_id,
      catalogVersion: physiology.catalog_version,
    }),
  });
}

export async function loadTwoReleaseResolver() {
  assert.ok(process.env.MESHFUL_CANONICAL_ROOT && process.env.MESHFUL_LIBRARY_ASSET_ROOT
    && process.env.MESHFUL_PUBLIC_LIBRARY_ROOT,
  "Supply canonical, retained v1 and public v2 Library roots");
  const canonicalRoot = resolve(process.env.MESHFUL_CANONICAL_ROOT);
  const retainedRoot = resolve(process.env.MESHFUL_LIBRARY_ASSET_ROOT);
  const publicRoot = resolve(process.env.MESHFUL_PUBLIC_LIBRARY_ROOT);
  const manifestBytes = await readFile(join(publicRoot, "asset-manifest.json"));
  assert.equal(digest(manifestBytes), `sha256:${V2_MANIFEST_SHA256}`);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.public_release_approved, true);
  assert.equal(manifest.content_license, "CC-BY-4.0");
  assert.deepEqual(manifest.counts, {
    decks: 72, cards: 9_988, prerequisite_edges: 17_712, external_prerequisite_edges: 770,
  });
  const publicIndexBytes = await readFile(join(publicRoot, "runtime/index.json"));
  const retainedIndexBytes = await readFile(join(retainedRoot, "index.json"));
  assert.equal(digest(publicIndexBytes), V2_INDEX_SHA256);
  assert.equal(digest(retainedIndexBytes), V1_INDEX_SHA256);
  const publicIndex = JSON.parse(publicIndexBytes);
  const retainedIndex = JSON.parse(retainedIndexBytes);
  const catalog = await import(pathToFileURL(join(canonicalRoot, "web/js/library-catalog.js")));
  const resolver = await catalog.prepareLibraryCatalogResolver({
    indexBytes: publicIndexBytes,
    expectedIndexSha256: V2_INDEX_SHA256,
    expectedPins: V2_PINS,
    readAsset: (key) => readFile(join(publicRoot, "runtime", key)),
    retainedIndexes: [{
      indexBytes: retainedIndexBytes,
      expectedIndexSha256: V1_INDEX_SHA256,
      expectedPins: V1_PINS,
      readAsset: (key) => readFile(join(retainedRoot, key)),
    }],
    resolutionBudget: RESOLUTION_BUDGET,
  });
  return Object.freeze({
    resolver,
    expectedCatalogPins: Object.freeze([
      enginePin(V2_PINS, publicIndex, V2_INDEX_SHA256),
      enginePin(V1_PINS, retainedIndex, V1_INDEX_SHA256),
    ]),
    current: Object.freeze({
      constructorRef: V2_PINS.constructorRef,
      catalogRef: V2_PINS.catalogRef,
      version: V2_PINS.catalogRef.version,
      physiologyId: "academic-reviewed-v1:physiology",
    }),
    retained: Object.freeze({
      constructorRef: V1_PINS.constructorRef,
      catalogRef: V1_PINS.catalogRef,
      version: V1_PINS.catalogRef.version,
      linearAlgebraId: "academic-reviewed-v1:linear-algebra-i",
    }),
    async createRetainedResolver() {
      return loadRetainedResolver();
    },
  });
}
