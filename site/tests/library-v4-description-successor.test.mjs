import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { admitLibraryCatalogArtifact } from "../public/study/js/library-catalog.js";
import { loadWebsiteLibrary } from "../public/study/js/library-loader.js";
import { createMemoryStorage, createStudyStore } from "../public/study/js/store.js";

const root = new URL("../", import.meta.url);
const activeRelease = "2026-09-03.public-sanitized.v4";
const previousRelease = "2026-09-02.public-sanitized.v3";
const activeRuntime = new URL(`public/study/data/library-runtime/${activeRelease}/`, root);
const previousRuntime = new URL(`public/study/data/library-runtime/${previousRelease}/`, root);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));

async function siteFetcher(input) {
  const url = new URL(input);
  const marker = "/study/data/";
  if (url.origin !== "https://meshful.test" || !url.pathname.startsWith(marker)) {
    return new Response("", { status: 404 });
  }
  try {
    const bytes = await readFile(new URL(`public/study/data/${url.pathname.slice(marker.length)}`, root));
    return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  } catch {
    return new Response("", { status: 404 });
  }
}

test("v4 is a fully pinned 72-description successor while immutable v3 remains present", async () => {
  const [manifestBytes, metadataBytes, receiptBytes, overlayBytes, releases] = await Promise.all([
    readFile(new URL("integration/library-assets/PUBLIC_LIBRARY_V4_ASSET_MANIFEST.json", root)),
    readFile(new URL("integration/library-assets/PUBLIC_LIBRARY_V4_METADATA.json", root)),
    readFile(new URL("integration/library-assets/PUBLIC_LIBRARY_V4_VERIFICATION_RECEIPT.json", root)),
    readFile(new URL("integration/library-assets/COURSE_DESCRIPTION_OVERLAY_V1.json", root)),
    readJson(new URL("public/study/data/library-releases.json", root)),
  ]);
  assert.equal(sha256(manifestBytes), "e41e2f866c943456a1f7fe2eff3fa8f2a9989f68fc1ea992119e726565f3c985");
  assert.equal(sha256(metadataBytes), "b0bbb20dc4fa641d00143208d94cfc4ef80e0e779b92642cdd75b339d53aff0e");
  assert.equal(sha256(receiptBytes), "8095eb18e610477664aecbe721eafe33855c0ccbbbf10a535ccc77b4ede1ff46");
  assert.equal(sha256(overlayBytes), "221a8ce11bcc52cbb81814baf27599b7081b6b7d79460c70006971f914f140ee");

  const manifest = JSON.parse(manifestBytes);
  const metadata = JSON.parse(metadataBytes);
  const receipt = JSON.parse(receiptBytes);
  const overlay = JSON.parse(overlayBytes);
  assert.equal(manifest.release, activeRelease);
  assert.equal(metadata.catalog_release_version, activeRelease);
  assert.equal(receipt.release.version, activeRelease);
  assert.equal(receipt.release.digest, "sha256:e37e6bccacf4d77ea3858793247e9cc36a10e95c86db723c74b2dcbf29dc3276");
  assert.deepEqual(manifest.description_successor, {
    schema_version: "meshful-course-description-overlay.v1",
    overlay_sha256: "sha256:221a8ce11bcc52cbb81814baf27599b7081b6b7d79460c70006971f914f140ee",
    base_public_metadata_sha256: "sha256:b73810e51aedffbe0062e3d4bb0e0c982e4b6f792eb236ea13d4fe6982b7f8be",
    base_browser_catalog_artifact_sha256: "sha256:fd26b03178e8ffa0db631814cc7771aae1966f9b087499378ddfa1c78b98a332",
    description_changes: 72,
    non_description_changes: 0,
  });
  assert.deepEqual(manifest.counts, {
    decks: 72,
    cards: 9988,
    prerequisite_edges: 17712,
    external_prerequisite_edges: 770,
  });
  assert.equal(overlay.decks.length, 72);
  assert.equal(new Set(overlay.decks.map(({ description }) => description)).size, 72);
  assert.equal(releases.active, activeRelease);
  assert.deepEqual(releases.releases.map(({ version }) => version), [
    activeRelease,
    previousRelease,
    "2026-08-30.reviewed-72.v1",
  ]);

  assert.equal(sha256(await readFile(new URL(
    "integration/library-assets/PUBLIC_LIBRARY_V3_ASSET_MANIFEST.json", root,
  ))), "ea6e86ee82962fb29b8e862d744be0399f0ea093b0dd908df6f32e43fe4c0a05");
  assert.equal(sha256(await readFile(new URL(
    `public/study/data/library/${previousRelease}/fd26b03178e8ffa0db631814cc7771aae1966f9b087499378ddfa1c78b98a332.json`, root,
  ))), "fd26b03178e8ffa0db631814cc7771aae1966f9b087499378ddfa1c78b98a332");
  assert.equal(sha256(await readFile(new URL("index.json", previousRuntime))),
    "b4f523e60ea1b3d6251af0193696db1eb78061ea207d13b1e1393388046c0e0e");
});

test("all v4 deck chunks change only release-bound description metadata from v3", async () => {
  const [activeIndex, previousIndex, overlay] = await Promise.all([
    readJson(new URL("index.json", activeRuntime)),
    readJson(new URL("index.json", previousRuntime)),
    readJson(new URL("integration/library-assets/COURSE_DESCRIPTION_OVERLAY_V1.json", root)),
  ]);
  const expectedDescriptions = new Map(overlay.decks.map((deck) => [deck.catalog_deck_id, deck.description]));
  const activeById = new Map(activeIndex.decks.map((deck) => [deck.catalog_deck_id, deck]));
  const previousById = new Map(previousIndex.decks.map((deck) => [deck.catalog_deck_id, deck]));
  assert.deepEqual([...activeById.keys()], [...previousById.keys()]);

  const chunkNames = (await readdir(new URL("decks/", activeRuntime))).sort();
  assert.equal(chunkNames.length, 72);
  for (const name of chunkNames) {
    assert.equal(path.extname(name), ".json");
    const [active, previous] = await Promise.all([
      readJson(new URL(`decks/${name}`, activeRuntime)),
      readJson(new URL(`decks/${name}`, previousRuntime)),
    ]);
    assert.equal(active.catalog_deck_id, previous.catalog_deck_id);
    assert.equal(active.catalog_version, activeRelease);
    assert.equal(previous.catalog_version, previousRelease);
    assert.equal(active.deck.description, expectedDescriptions.get(active.catalog_deck_id));
    assert.equal(active.deck.version, activeRelease);
    assert.equal(previous.deck.version, previousRelease);

    const activeDeck = structuredClone(active.deck);
    const previousDeck = structuredClone(previous.deck);
    delete activeDeck.description;
    delete activeDeck.version;
    delete previousDeck.description;
    delete previousDeck.version;
    assert.deepEqual(activeDeck, previousDeck, `${name}: IDs, cards, edges and content remain unchanged`);
  }
});

test("every emitted v4 runtime asset matches its manifest byte and SHA pin", async () => {
  const manifest = await readJson(new URL(
    "integration/library-assets/PUBLIC_LIBRARY_V4_ASSET_MANIFEST.json", root,
  ));
  assert.equal(manifest.runtime_assets.length, 74);
  for (const asset of manifest.runtime_assets) {
    const url = asset.path === "runtime/catalog-artifact.json"
      ? new URL(`public/study/data/${manifest.website_release_entry.path}`, root)
      : new URL(`public/study/data/library-runtime/${activeRelease}/${asset.path.replace(/^runtime\//, "")}`, root);
    const bytes = await readFile(url);
    assert.equal(bytes.length, asset.bytes, asset.path);
    assert.equal(`sha256:${sha256(bytes)}`, asset.sha256, asset.path);
  }
});

test("a browser-local v3 install hydrates against retained immutable v3 after v4 activation", async () => {
  const releaseIndex = await readJson(new URL("public/study/data/library-releases.json", root));
  const previous = releaseIndex.releases.find(({ version }) => version === previousRelease);
  const artifact = await readJson(new URL(`public/study/data/${previous.path}`, root));
  const admitted = await admitLibraryCatalogArtifact(artifact, {
    expectedConstructorDigest: previous.runtime.preparedConstructorDigest,
    expectedCatalogRef: { version: previous.version, digest: previous.catalogDigest },
    expectedDependencyGraphSha256: previous.dependencyGraphDigest,
  });
  const storage = createMemoryStorage();
  const oldStore = createStudyStore({
    catalog: admitted.prepared,
    storage,
    clock: () => new Date("2026-09-03T12:00:00.000Z"),
  });
  oldStore.addLibraryDeck({
    library_deck_id: "academic-reviewed-v1:algorithms-i",
    expected_catalog_version: previousRelease,
    client_action_id: "v3-retention:add-algorithms",
  });
  const storedStateJson = Object.values(storage.dump())[0];

  const settings = await loadWebsiteLibrary({
    indexUrl: new URL("https://meshful.test/study/data/library-releases.json"),
    fetcher: siteFetcher,
    storedStateJson,
  });
  assert.equal(settings.release, activeRelease);
  assert.equal(settings.retainedCatalogs.some((catalog) =>
    catalog.library?.catalogRef?.version === previousRelease), true);
  const hydrated = createStudyStore({
    catalog: settings.catalog,
    retainedCatalogs: settings.retainedCatalogs,
    storage: createMemoryStorage({ "adaptive-study-lab:web-state:v1": storedStateJson }),
    clock: () => new Date("2026-09-03T12:00:00.000Z"),
  }).getSnapshot();
  assert.equal(Object.values(hydrated.personalDecks)[0].source.catalogVersion, previousRelease);
});
