import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  BACKEND_EXPECTED_CATALOG_PINS,
  LIBRARY_ASSET_BASE_PATH,
  LIBRARY_EXPECTED_PINS,
  LIBRARY_INDEX_SHA256,
  LIBRARY_RELEASE,
  LIBRARY_RESOLUTION_BUDGET,
  PREVIOUS_LIBRARY_ASSET_BASE_PATH,
  PREVIOUS_LIBRARY_EXPECTED_PINS,
  PREVIOUS_LIBRARY_INDEX_SHA256,
  PREVIOUS_LIBRARY_RELEASE,
  RETAINED_LIBRARY_ASSET_BASE_PATH,
  RETAINED_LIBRARY_EXPECTED_PINS,
  RETAINED_LIBRARY_INDEX_SHA256,
  RETAINED_LIBRARY_RELEASE,
  createLibraryAssetReader,
  createReviewedLibraryResolver,
} from "../integration/library-runtime.mjs";

const root = new URL(`../public/study/data/library-runtime/${LIBRARY_RELEASE}/`, import.meta.url);
const previousRoot = new URL(`../public/study/data/library-runtime/${PREVIOUS_LIBRARY_RELEASE}/`, import.meta.url);
const retainedRoot = new URL(`../public/study/data/library-runtime/${RETAINED_LIBRARY_RELEASE}/`, import.meta.url);
const manifestUrl = new URL("../integration/library-assets/PUBLIC_LIBRARY_V4_ASSET_MANIFEST.json", import.meta.url);
const sha256 = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");

function fileAssets({ statusFor = null } = {}) {
  const reads = [];
  return {
    reads,
    async fetch(request) {
      const url = new URL(request.url);
      reads.push(url.pathname);
      const release = [
        [LIBRARY_ASSET_BASE_PATH, root],
        [PREVIOUS_LIBRARY_ASSET_BASE_PATH, previousRoot],
        [RETAINED_LIBRARY_ASSET_BASE_PATH, retainedRoot],
      ].find(([basePath]) => url.pathname.startsWith(basePath));
      if (!release) return new Response("", { status: 404 });
      const [basePath, assetRoot] = release;
      const key = url.pathname.slice(basePath.length);
      const forced = statusFor?.(key);
      if (forced) return new Response("", { status: forced });
      try {
        const bytes = await readFile(new URL(key, assetRoot));
        return new Response(bytes, { headers: { "content-type": "application/json", "content-length": String(bytes.length) } });
      } catch {
        return new Response("", { status: 404 });
      }
    },
  };
}

test("the packaged public runtime is exactly the selected catalog asset manifest", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.equal(manifest.release, LIBRARY_RELEASE);
  assert.deepEqual(manifest.counts, { decks: 72, cards: 9988, prerequisite_edges: 17712, external_prerequisite_edges: 770 });
  const index = await readFile(new URL("index.json", root));
  assert.equal(index.length, manifest.runtime_index.bytes);
  assert.equal(sha256(index), LIBRARY_INDEX_SHA256);
  const resolverAssets = manifest.runtime_assets.filter((entry) => entry.path !== "runtime/catalog-artifact.json");
  assert.equal(resolverAssets.length, 73);
  for (const entry of resolverAssets) {
    const key = entry.path.replace(/^runtime\//, "");
    const bytes = await readFile(new URL(key, root));
    assert.equal(bytes.length, entry.bytes, key);
    assert.equal(sha256(bytes), entry.sha256, key);
  }
});

test("reviewed resolver bootstrap reads active, previous and retained indexes while summary search reads zero deck chunks", async () => {
  const assets = fileAssets();
  const resolver = await createReviewedLibraryResolver(assets);
  assert.equal(resolver.kind, "meshful-library-catalog-resolver.v1");
  assert.deepEqual(resolver.constructorCatalogRef, LIBRARY_EXPECTED_PINS.constructorRef);
  assert.deepEqual(resolver.resolutionBudget, LIBRARY_RESOLUTION_BUDGET);
  assert.equal(assets.reads.length, 3);
  assert.equal(assets.reads[0], `${LIBRARY_ASSET_BASE_PATH}index.json`);
  assert.equal(assets.reads[1], `${PREVIOUS_LIBRARY_ASSET_BASE_PATH}index.json`);
  assert.equal(assets.reads[2], `${RETAINED_LIBRARY_ASSET_BASE_PATH}index.json`);
  const resolved = await resolver.resolveTransaction({
    constructorCatalogRef: LIBRARY_EXPECTED_PINS.constructorRef,
    stateJson: null,
    intent: { kind: "query", operation: "search_library", args: { query: "linear algebra" } },
  });
  assert.equal(resolved.storeCatalogView.summaries.length, 72);
  assert.equal(resolved.resolution.assetReadCount, 0);
  assert.equal(assets.reads.length, 3);
});

test("one exact Library deck query resolves one verified chunk", async () => {
  const assets = fileAssets();
  const resolver = await createReviewedLibraryResolver(assets);
  const resolved = await resolver.resolveTransaction({
    constructorCatalogRef: LIBRARY_EXPECTED_PINS.constructorRef,
    stateJson: null,
    intent: { kind: "query", operation: "get_deck", args: { scope: "library", deck_id: "academic-reviewed-v1:linear-algebra-i" } },
  });
  assert.equal(resolved.resolution.assetReadCount, 1);
  assert.deepEqual(resolved.resolution.loadedCatalogDeckIds, ["academic-reviewed-v1:linear-algebra-i"]);
  assert.equal(assets.reads.at(-1), `${LIBRARY_ASSET_BASE_PATH}decks/linear-algebra-i.json`);
});

test("asset reader allows only fixed opaque keys and maps transient storage failure to SERVICE_BUSY", async () => {
  const assets = fileAssets({ statusFor: (key) => key === "decks/linear-algebra-i.json" ? 503 : null });
  const readAsset = createLibraryAssetReader(assets);
  assert.equal(await readAsset("../index.json"), null);
  assert.equal(await readAsset("decks/%2e%2e.json"), null);
  assert.equal(assets.reads.length, 0);
  await assert.rejects(readAsset("decks/linear-algebra-i.json"), (error) => error?.code === "SERVICE_BUSY");
  assert.equal(await readAsset("decks/not-present.json"), null);
});

test("Backend pins are the resolver pins without a second identity translation", () => {
  assert.equal(BACKEND_EXPECTED_CATALOG_PINS.length, 3);
  const selected = BACKEND_EXPECTED_CATALOG_PINS[0];
  assert.deepEqual(selected.constructorCatalogRef, LIBRARY_EXPECTED_PINS.constructorRef);
  assert.deepEqual(selected.sourcePins.rawCatalogRef, LIBRARY_EXPECTED_PINS.catalogRef);
  assert.equal(selected.sourcePins.descriptorDigest, LIBRARY_INDEX_SHA256);
  assert.equal(selected.sourcePins.normalizationVersion, "canonical-library-card-identity.v1");
  const previous = BACKEND_EXPECTED_CATALOG_PINS[1];
  assert.deepEqual(previous.constructorCatalogRef, PREVIOUS_LIBRARY_EXPECTED_PINS.constructorRef);
  assert.deepEqual(previous.sourcePins.rawCatalogRef, PREVIOUS_LIBRARY_EXPECTED_PINS.catalogRef);
  assert.equal(previous.sourcePins.descriptorDigest, PREVIOUS_LIBRARY_INDEX_SHA256);
  const retained = BACKEND_EXPECTED_CATALOG_PINS[2];
  assert.deepEqual(retained.constructorCatalogRef, RETAINED_LIBRARY_EXPECTED_PINS.constructorRef);
  assert.deepEqual(retained.sourcePins.rawCatalogRef, RETAINED_LIBRARY_EXPECTED_PINS.catalogRef);
  assert.equal(retained.sourcePins.descriptorDigest, RETAINED_LIBRARY_INDEX_SHA256);
});
