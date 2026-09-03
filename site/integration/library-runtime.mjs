import { prepareLibraryCatalogResolver } from "./core/js/library-catalog.js";

export const LIBRARY_RELEASE = "2026-09-03.public-sanitized.v4";
export const LIBRARY_ASSET_BASE_PATH = `/study/data/library-runtime/${LIBRARY_RELEASE}/`;
export const LIBRARY_INDEX_SHA256 = "sha256:2e70c4f08117cf0645cfb9d61c3333abf96ce36e90b3274f5980921eef8e3e4a";
export const PREVIOUS_LIBRARY_RELEASE = "2026-09-02.public-sanitized.v3";
export const PREVIOUS_LIBRARY_ASSET_BASE_PATH = `/study/data/library-runtime/${PREVIOUS_LIBRARY_RELEASE}/`;
export const PREVIOUS_LIBRARY_INDEX_SHA256 = "sha256:b4f523e60ea1b3d6251af0193696db1eb78061ea207d13b1e1393388046c0e0e";
export const RETAINED_LIBRARY_RELEASE = "2026-08-30.reviewed-72.v1";
export const RETAINED_LIBRARY_ASSET_BASE_PATH = `/study/data/library-runtime/${RETAINED_LIBRARY_RELEASE}/`;
export const RETAINED_LIBRARY_INDEX_SHA256 = "sha256:6daff48b99faae5047a69d56cfbbf7aa6b162367337044ce59e9774bbfc29a00";

export const LIBRARY_RESOLUTION_BUDGET = Object.freeze({
  max_decks: 42,
  max_cards: 5_500,
  max_raw_chunk_bytes: 7_000_000,
});

export const LIBRARY_EXPECTED_PINS = Object.freeze({
  constructorRef: Object.freeze({
    version: LIBRARY_RELEASE,
    digest: "sha256:ce0589f4055dd2cf45a07601eaec0ec71107c62683289e1b0a54417d9480e859",
  }),
  preparedConstructorDigest: "sha256:22902e9efe9dfb08a1c8cfa23215fedbd54de71916888652382f0190462e38e0",
  catalogRef: Object.freeze({
    version: LIBRARY_RELEASE,
    digest: "sha256:e37e6bccacf4d77ea3858793247e9cc36a10e95c86db723c74b2dcbf29dc3276",
  }),
  dependencyGraphSha256: "sha256:82025162442152929780e8bcf42066361b8ebc1602c899b1f706f621b2257ce0",
  sourceManifestSha256: "sha256:66922285f28b47e3c18d391473f935a69fd2f926b7d25c00360b757f73fbd936",
  criterionDerivationVersion: "store-normalizeRubricItems-ordinal.v1",
});

export const PREVIOUS_LIBRARY_EXPECTED_PINS = Object.freeze({
  constructorRef: Object.freeze({
    version: PREVIOUS_LIBRARY_RELEASE,
    digest: "sha256:93529fe0fc172b6ff58391a08230b15fcc82a5c9bd5e2fa2d85679f2f0573495",
  }),
  preparedConstructorDigest: "sha256:43af55b6108bd0901723ff4977c28469c84ee07bccafd4c307a172e2c7f49c2f",
  catalogRef: Object.freeze({
    version: PREVIOUS_LIBRARY_RELEASE,
    digest: "sha256:ce5945142785ae528532f057eb09c44966c2ecca10844ec638aa793e74cea3bc",
  }),
  dependencyGraphSha256: "sha256:82025162442152929780e8bcf42066361b8ebc1602c899b1f706f621b2257ce0",
  sourceManifestSha256: "sha256:c6672c69df5159fdcf68f76cc27e42b2160d4d0725fc9998756b793a1fe2a4be",
  criterionDerivationVersion: "store-normalizeRubricItems-ordinal.v1",
});

export const RETAINED_LIBRARY_EXPECTED_PINS = Object.freeze({
  constructorRef: Object.freeze({
    version: RETAINED_LIBRARY_RELEASE,
    digest: "sha256:e3d0daad45310fa3d7e1cf473156d09d9700fd504fc41b1b770989cadab816b7",
  }),
  preparedConstructorDigest: "sha256:e26951ad5070be6546561f2769659dda87715fb6dc6d061b5ee6ed3b1b17f461",
  catalogRef: Object.freeze({
    version: RETAINED_LIBRARY_RELEASE,
    digest: "sha256:908e28f0a7a43ec53715a6811d0cc09c59f627fb3f74de01fc8fbceb7fbe84bb",
  }),
  dependencyGraphSha256: "sha256:82025162442152929780e8bcf42066361b8ebc1602c899b1f706f621b2257ce0",
  sourceManifestSha256: "sha256:172e079349252368559beeddcd540b34f02c769f66fa5e8bfd6092f49f6ad8b8",
  criterionDerivationVersion: "store-normalizeRubricItems-ordinal.v1",
});

export const BACKEND_EXPECTED_CATALOG_PINS = Object.freeze([
  Object.freeze({
    constructorCatalogRef: LIBRARY_EXPECTED_PINS.constructorRef,
    sourcePins: Object.freeze({
      descriptorDigest: LIBRARY_INDEX_SHA256,
      sourceManifestDigest: LIBRARY_EXPECTED_PINS.sourceManifestSha256,
      preparedConstructorDigest: LIBRARY_EXPECTED_PINS.preparedConstructorDigest,
      rawCatalogRef: LIBRARY_EXPECTED_PINS.catalogRef,
      dependencyGraphDigest: LIBRARY_EXPECTED_PINS.dependencyGraphSha256,
      normalizationVersion: "canonical-library-card-identity.v1",
      criterionDerivationVersion: LIBRARY_EXPECTED_PINS.criterionDerivationVersion,
    }),
  }),
  Object.freeze({
    constructorCatalogRef: PREVIOUS_LIBRARY_EXPECTED_PINS.constructorRef,
    sourcePins: Object.freeze({
      descriptorDigest: PREVIOUS_LIBRARY_INDEX_SHA256,
      sourceManifestDigest: PREVIOUS_LIBRARY_EXPECTED_PINS.sourceManifestSha256,
      preparedConstructorDigest: PREVIOUS_LIBRARY_EXPECTED_PINS.preparedConstructorDigest,
      rawCatalogRef: PREVIOUS_LIBRARY_EXPECTED_PINS.catalogRef,
      dependencyGraphDigest: PREVIOUS_LIBRARY_EXPECTED_PINS.dependencyGraphSha256,
      normalizationVersion: "canonical-library-card-identity.v1",
      criterionDerivationVersion: PREVIOUS_LIBRARY_EXPECTED_PINS.criterionDerivationVersion,
    }),
  }),
  Object.freeze({
    constructorCatalogRef: RETAINED_LIBRARY_EXPECTED_PINS.constructorRef,
    sourcePins: Object.freeze({
      descriptorDigest: RETAINED_LIBRARY_INDEX_SHA256,
      sourceManifestDigest: RETAINED_LIBRARY_EXPECTED_PINS.sourceManifestSha256,
      preparedConstructorDigest: RETAINED_LIBRARY_EXPECTED_PINS.preparedConstructorDigest,
      rawCatalogRef: RETAINED_LIBRARY_EXPECTED_PINS.catalogRef,
      dependencyGraphDigest: RETAINED_LIBRARY_EXPECTED_PINS.dependencyGraphSha256,
      normalizationVersion: "canonical-library-card-identity.v1",
      criterionDerivationVersion: RETAINED_LIBRARY_EXPECTED_PINS.criterionDerivationVersion,
    }),
  }),
]);

const SAFE_ASSET_KEY = /^(?:index\.json|decks\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.json)$/;
const MAX_ASSET_BYTES = 2_000_000;

function serviceBusy() {
  const error = new Error("Library storage is temporarily unavailable.");
  error.code = "SERVICE_BUSY";
  return error;
}

export function createLibraryAssetReader(assets, { basePath = LIBRARY_ASSET_BASE_PATH } = {}) {
  if (!assets || typeof assets.fetch !== "function") {
    throw new TypeError("The private Sites asset binding is required.");
  }
  return async function readAsset(key) {
    if (typeof key !== "string" || !SAFE_ASSET_KEY.test(key)) return null;
    const url = new URL(`${basePath}${key}`, "https://meshful.ai");
    let response;
    try {
      response = await assets.fetch(new Request(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      }));
    } catch {
      throw serviceBusy();
    }
    if (response.status === 404) return null;
    if ([408, 425, 429].includes(response.status) || response.status >= 500) throw serviceBusy();
    if (!response.ok) return null;
    const advertised = Number(response.headers.get("content-length"));
    if (Number.isFinite(advertised) && advertised > MAX_ASSET_BYTES) {
      throw new Error("Library asset exceeds its verified byte bound.");
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw new Error("Library asset exceeds its verified byte bound.");
    }
    return bytes;
  };
}

export async function createReviewedLibraryResolver(assets) {
  const readAsset = createLibraryAssetReader(assets);
  const previousReadAsset = createLibraryAssetReader(assets, { basePath: PREVIOUS_LIBRARY_ASSET_BASE_PATH });
  const retainedReadAsset = createLibraryAssetReader(assets, { basePath: RETAINED_LIBRARY_ASSET_BASE_PATH });
  const indexBytes = await readAsset("index.json");
  const previousIndexBytes = await previousReadAsset("index.json");
  const retainedIndexBytes = await retainedReadAsset("index.json");
  if (!indexBytes) throw new Error("The exact reviewed Library index is unavailable.");
  if (!previousIndexBytes) throw new Error("The previous public Library index is unavailable.");
  if (!retainedIndexBytes) throw new Error("The retained reviewed Library index is unavailable.");
  return prepareLibraryCatalogResolver({
    indexBytes,
    expectedIndexSha256: LIBRARY_INDEX_SHA256,
    expectedPins: LIBRARY_EXPECTED_PINS,
    readAsset,
    retainedIndexes: [
      {
        indexBytes: previousIndexBytes,
        expectedIndexSha256: PREVIOUS_LIBRARY_INDEX_SHA256,
        expectedPins: PREVIOUS_LIBRARY_EXPECTED_PINS,
        readAsset: previousReadAsset,
      },
      {
        indexBytes: retainedIndexBytes,
        expectedIndexSha256: RETAINED_LIBRARY_INDEX_SHA256,
        expectedPins: RETAINED_LIBRARY_EXPECTED_PINS,
        readAsset: retainedReadAsset,
      },
    ],
    maxCachedDecks: 16,
    maxCachedBytes: 16_000_000,
    maxConcurrentDecks: 16,
    maxConcurrentBytes: 32_000_000,
    resolutionBudget: LIBRARY_RESOLUTION_BUDGET,
  });
}
