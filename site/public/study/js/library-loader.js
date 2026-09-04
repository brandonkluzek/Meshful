import { admitLibraryCatalogArtifact, prepareLibraryCatalog, prepareLibraryCatalogResolver } from "./library-catalog.js";
import { CATALOG as LEGACY_EXAMPLES } from "../data/catalog.js";
import { createStudyStore } from "./store.js?release=v59-study-session";

const INDEX_FORMAT = "meshful-website-library-releases.v1";
const LEARNER_STORAGE_KEY = "adaptive-study-lab:web-state:v1";
const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_REF = /^sha256:[a-f0-9]{64}$/;
const RUNTIME_INDEX_PATH = /^library-runtime\/[a-z0-9][a-z0-9.-]*\/index\.json$/;
const RUNTIME_ASSET_KEY = /^(?:index\.json|decks\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.json)$/;
const MAX_FEED_BYTES = 48 * 1024 * 1024;
const MAX_CATALOG_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_RUNTIME_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_ASSET_BYTES = 2 * 1024 * 1024;
const message = (detail) => new Error(`The Library could not open. ${detail} Your saved decks have not been changed.`);
const runCheck = (check) => { if (typeof check === "function") check(); };

async function readBytes(url, { fetcher, maxBytes, digest, cache = "no-cache", check } = {}) {
  runCheck(check);
  const response = await fetcher(url.href, { credentials: "same-origin", redirect: "error", cache });
  runCheck(check);
  if (!response.ok) throw message("The selected catalog release is unavailable.");
  if (Number(response.headers?.get("content-length")) > maxBytes) throw message("The catalog exceeds its size limit.");
  const bytes = await response.arrayBuffer();
  runCheck(check);
  if (bytes.byteLength > maxBytes) throw message("The catalog exceeds its size limit.");
  if (digest) {
    const hashed = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    runCheck(check);
    const actual = [...new Uint8Array(hashed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== digest) throw message("The saved release does not match its content pin.");
  }
  return bytes;
}

async function readJson(url, options) {
  const bytes = await readBytes(url, options);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw message("The selected catalog is not valid JSON."); }
}

function validateRuntime(release) {
  const runtime = release.runtime;
  const budget = runtime?.resolutionBudget;
  if (!runtime || !RUNTIME_INDEX_PATH.test(runtime.indexPath ?? "")
      || !runtime.indexPath.startsWith(`library-runtime/${release.version}/`)
      || !SHA256.test(runtime.indexSha256 ?? "")
      || !SHA256_REF.test(runtime.preparedConstructorDigest ?? "")
      || runtime.normalizationVersion !== "canonical-library-card-identity.v1"
      || runtime.criterionDerivationVersion !== "store-normalizeRubricItems-ordinal.v1"
      || !budget || ![budget.max_decks, budget.max_cards, budget.max_raw_chunk_bytes]
        .every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw message("The release index contains an invalid runtime identity.");
  }
  return runtime;
}

function validateRelease(release) {
  const delivery = release.delivery ?? "feed";
  if (!release.version || !["feed", "resolver", "artifact"].includes(delivery)
      || !SHA256_REF.test(release.constructorDigest ?? "")
      || !SHA256_REF.test(release.catalogDigest ?? "")
      || !SHA256_REF.test(release.dependencyGraphDigest ?? "")
      || !SHA256.test(release.sourceManifestSha256 ?? "")) {
    throw message("The release index contains an invalid identity.");
  }
  if (delivery === "feed" && (!SHA256.test(release.sha256 ?? "")
      || !/^library\/[a-z0-9][a-z0-9.-]*\/[a-f0-9]{64}\.json$/.test(release.path ?? ""))) {
    throw message("The release index contains an invalid feed identity.");
  }
  if (delivery === "artifact" && (!SHA256.test(release.sha256 ?? "")
      || !/^library\/[a-z0-9][a-z0-9.-]*\/[a-f0-9]{64}\.json$/.test(release.path ?? "")
      || release.browser_artifact_contract !== "meshful-library-runtime-artifact.v1")) {
    throw message("The release index contains an invalid catalog artifact identity.");
  }
  validateRuntime(release);
  return delivery;
}

async function readReleaseIndex({ indexUrl, fetcher, check } = {}) {
  const indexLocation = new URL(indexUrl);
  if (!["http:", "https:"].includes(indexLocation.protocol)) throw message("Use the assembled website to load the reviewed Library.");
  const index = await readJson(indexLocation, { fetcher, maxBytes: 512 * 1024, check });
  if (index.format !== INDEX_FORMAT || !Array.isArray(index.releases) || !index.releases.length || index.releases.length > 256) {
    throw message("The release index is invalid.");
  }
  const versions = new Set();
  for (const release of index.releases) {
    if (versions.has(release.version)) {
      throw message("The release index contains an invalid identity.");
    }
    validateRelease(release);
    versions.add(release.version);
  }
  const active = index.releases.find((release) => release.version === index.active);
  if (!active) throw message("No current release was selected.");
  return { indexLocation, index, active };
}

function expectedPins(release) {
  const runtime = validateRuntime(release);
  return {
    constructorRef: { version: release.version, digest: release.constructorDigest },
    preparedConstructorDigest: runtime.preparedConstructorDigest,
    catalogRef: { version: release.version, digest: release.catalogDigest },
    dependencyGraphSha256: release.dependencyGraphDigest,
    sourceManifestSha256: `sha256:${release.sourceManifestSha256}`,
    criterionDerivationVersion: runtime.criterionDerivationVersion,
  };
}

async function runtimeDescriptor(release, indexLocation, fetcher, check) {
  const runtime = validateRuntime(release);
  const runtimeIndexUrl = new URL(runtime.indexPath, indexLocation);
  if (runtimeIndexUrl.origin !== indexLocation.origin) throw message("Catalog files must be served by this website.");
  const runtimeBase = new URL("./", runtimeIndexUrl);
  const indexBytes = await readBytes(runtimeIndexUrl, {
    fetcher,
    maxBytes: MAX_RUNTIME_INDEX_BYTES,
    digest: runtime.indexSha256,
    cache: "force-cache",
    check,
  });
  const transient = () => {
    const error = message("Library storage is temporarily unavailable.");
    error.code = "SERVICE_BUSY";
    return error;
  };
  const readAsset = async (key) => {
    if (typeof key !== "string" || !RUNTIME_ASSET_KEY.test(key)) return null;
    const url = new URL(key, runtimeBase);
    if (url.origin !== runtimeBase.origin || !url.pathname.startsWith(runtimeBase.pathname)) return null;
    let response;
    try {
      response = await fetcher(url.href, { credentials: "same-origin", redirect: "error", cache: "force-cache" });
    } catch {
      throw transient();
    }
    if (response.status === 404) return null;
    if ([408, 425, 429].includes(response.status) || response.status >= 500) throw transient();
    if (!response.ok) return null;
    const advertised = Number(response.headers?.get("content-length"));
    if (Number.isFinite(advertised) && advertised > MAX_RUNTIME_ASSET_BYTES) {
      throw message("The catalog exceeds its size limit.");
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_RUNTIME_ASSET_BYTES) throw message("The catalog exceeds its size limit.");
    return bytes;
  };
  return {
    indexBytes,
    expectedIndexSha256: runtime.indexSha256,
    expectedPins: expectedPins(release),
    readAsset,
  };
}

async function releaseResolver({ indexLocation, index, active, fetcher, check }) {
  const primary = await runtimeDescriptor(active, indexLocation, fetcher, check);
  const retainedIndexes = [];
  for (const release of index.releases) {
    if (release.version !== active.version) {
      retainedIndexes.push(await runtimeDescriptor(release, indexLocation, fetcher, check));
    }
  }
  return prepareLibraryCatalogResolver({
    ...primary,
    retainedIndexes,
    resolutionBudget: validateRuntime(active).resolutionBudget,
  });
}

function browseDeck(summary, pin = null) {
  return {
    id: summary.deck_id,
    version: summary.version,
    title: summary.title,
    description: summary.description,
    coverageSummary: summary.description,
    subject: summary.subject,
    domain: summary.domain,
    level: summary.level,
    tags: summary.tags,
    cardCount: summary.card_count,
    cards: summary.sample_terms.map((term, index) => ({ id: `${summary.deck_id}:sample:${index}`, term })),
    reviewStatus: summary.review_status,
    contentStatus: summary.content_status,
    requiredCatalogDeckIds: Array.isArray(pin?.requiredCatalogDeckIds)
      ? [...pin.requiredCatalogDeckIds]
      : [summary.deck_id],
  };
}

function installedReleaseRefs(raw) {
  if (!raw) return [];
  let state;
  try { state = JSON.parse(raw); }
  catch { throw message("Saved study data needs recovery before the catalog can be selected."); }
  return Object.values(state.personalDecks ?? {}).flatMap((deck) => {
    const fields = deck.deckFields ?? deck;
    const references = fields.libraryBase?.catalogRef ? [fields.libraryBase.catalogRef] : [];
    // A sparse overlay's top-level pin is authoritative even when redundant
    // libraryBase metadata is absent. Its digest is per-deck FNV, not a release
    // SHA256; the store still validates that exact base during hydration.
    const pin = deck.persistenceKind === "catalog-overlay-v1" ? deck
      : fields.persistenceCatalogBase ?? fields.source;
    if (pin?.catalogDeckId && pin.catalogVersion != null) {
      const version = String(pin.catalogVersion);
      const bundledExample = LEGACY_EXAMPLES.some((example) => example.id === pin.catalogDeckId && String(example.version) === version);
      if (!bundledExample && !references.some((reference) => reference.version === version)) references.push({ version });
    }
    return references;
  });
}

// One deployed release index is the build/runtime connection. It lists immutable
// release files; old files stay available for installed bases. Loading has zero
// learner writes and no fallback to examples on missing/mismatched content.
export async function loadWebsiteLibrary({
  indexUrl = new URL("../data/library-releases.json", import.meta.url),
  fetcher = globalThis.fetch,
  storedStateJson = null,
  check = null,
} = {}) {
  const { indexLocation, index, active } = await readReleaseIndex({ indexUrl, fetcher, check });
  if ((active.delivery ?? "feed") === "artifact") {
    const artifactUrl = new URL(active.path, indexLocation);
    if (artifactUrl.origin !== indexLocation.origin) throw message("Catalog files must be served by this website.");
    const artifact = await readJson(artifactUrl, {
      fetcher,
      maxBytes: MAX_CATALOG_ARTIFACT_BYTES,
      digest: active.sha256,
      cache: "force-cache",
      check,
    });
    const admitted = await admitLibraryCatalogArtifact(artifact, {
      expectedConstructorDigest: validateRuntime(active).preparedConstructorDigest,
      expectedCatalogRef: { version: active.version, digest: active.catalogDigest },
      expectedDependencyGraphSha256: active.dependencyGraphDigest,
    });
    runCheck(check);
    const retainedCatalogs = [LEGACY_EXAMPLES];
    const requiredVersions = new Set(installedReleaseRefs(storedStateJson).map((ref) => ref.version));
    for (const version of requiredVersions) {
      if (version === active.version) continue;
      const release = index.releases.find((candidate) => candidate.version === version);
      if (!release) {
        throw message("An installed deck requires an older release that must be restored.");
      }
      const url = new URL(release.path, indexLocation);
      if (url.origin !== indexLocation.origin) throw message("Catalog files must be served by this website.");
      if ((release.delivery ?? "feed") === "artifact") {
        const artifact = await readJson(url, {
          fetcher,
          maxBytes: MAX_CATALOG_ARTIFACT_BYTES,
          digest: release.sha256,
          cache: "force-cache",
          check,
        });
        const admittedRetained = await admitLibraryCatalogArtifact(artifact, {
          expectedConstructorDigest: validateRuntime(release).preparedConstructorDigest,
          expectedCatalogRef: { version: release.version, digest: release.catalogDigest },
          expectedDependencyGraphSha256: release.dependencyGraphDigest,
        });
        retainedCatalogs.push(admittedRetained.prepared);
      } else if ((release.delivery ?? "feed") === "feed") {
        const feed = await readJson(url, {
          fetcher,
          maxBytes: MAX_FEED_BYTES,
          digest: release.sha256,
          cache: "force-cache",
          check,
        });
        retainedCatalogs.push(await prepareLibraryCatalog(feed));
      } else {
        throw message("An installed deck requires an older release that must be restored.");
      }
      runCheck(check);
    }
    return {
      catalog: admitted.prepared,
      retainedCatalogs,
      browseCatalog: admitted.prepared.catalog.map((deck) => ({
        ...deck,
        requiredCatalogDeckIds: Array.isArray(admitted.prepared.library?.decks?.[deck.id]?.requiredCatalogDeckIds)
          ? [...admitted.prepared.library.decks[deck.id].requiredCatalogDeckIds]
          : [deck.id],
      })),
      legacyDeckIds: LEGACY_EXAMPLES.map((deck) => deck.id),
      crossListings: active.crossListings ?? {},
      release: active.version,
      constructorCatalogRef: Object.freeze({ version: active.version, digest: active.constructorDigest }),
      constructorCatalogRefs: Object.freeze(index.releases.map((release) => Object.freeze({
        version: release.version,
        digest: release.constructorDigest,
      }))),
      seedExamples: false,
    };
  }
  if ((active.delivery ?? "feed") === "resolver") {
    const resolver = await releaseResolver({ indexLocation, index, active, fetcher, check });
    const resolveTransaction = ({ stateJson = null, intent, constructorCatalogRef = resolver.constructorCatalogRef } = {}) =>
      resolver.resolveTransaction({ constructorCatalogRef, stateJson, intent });
    const initial = await resolveTransaction({
      stateJson: storedStateJson,
      intent: { kind: "query", operation: "hydrate_confirmed_state", args: {} },
    });
    runCheck(check);
    return {
      catalog: initial.storeCatalogView,
      retainedCatalogs: [LEGACY_EXAMPLES, ...initial.retainedCatalogViews],
      browseCatalog: initial.storeCatalogView.summaries.map((summary) =>
        browseDeck(summary, initial.storeCatalogView.library?.decks?.[summary.deck_id])),
      legacyDeckIds: LEGACY_EXAMPLES.map((deck) => deck.id),
      crossListings: active.crossListings ?? {},
      release: active.version,
      constructorCatalogRef: Object.freeze({ ...resolver.constructorCatalogRef }),
      constructorCatalogRefs: resolver.constructorCatalogRefs,
      resolveTransaction,
      async loadCatalogDeck(deckId, { includeClosure = false } = {}) {
        const args = includeClosure
          ? { library_deck_id: deckId, expected_catalog_version: active.version }
          : { scope: "library", deck_id: deckId };
        const resolved = await resolveTransaction({
          intent: { kind: "query", operation: includeClosure ? "add_library_deck" : "get_deck", args },
        });
        const deck = resolved.storeCatalogView.catalog.find((candidate) => candidate.id === deckId);
        if (!deck) throw message("That exact course is unavailable.");
        return { deck, catalog: resolved.storeCatalogView.catalog };
      },
      seedExamples: false,
    };
  }
  const required = new Map([[active.version, active]]);
  for (const ref of installedReleaseRefs(storedStateJson)) {
    const retained = index.releases.find((release) => release.version === ref.version && (!ref.digest || release.catalogDigest === ref.digest));
    if (!retained) throw message("An installed deck requires an older release that must be restored.");
    required.set(retained.version, retained);
  }
  const prepared = new Map();
  // Sequential bootstrap bounds peak JSON/hash memory. Immutable files use the
  // browser's HTTP cache; the catalog never enters learner localStorage.
  for (const release of required.values()) {
    const url = new URL(release.path, indexLocation);
    if (url.origin !== indexLocation.origin) throw message("Catalog files must be served by this website.");
    const feed = await readJson(url, { fetcher, maxBytes: MAX_FEED_BYTES, digest: release.sha256, cache: "force-cache", check });
    const catalog = await prepareLibraryCatalog(feed);
    runCheck(check);
    if (catalog.library.catalogRef.version !== release.version || catalog.library.catalogRef.digest !== release.catalogDigest) {
      throw message("The release identity differs from its index.");
    }
    prepared.set(release.version, catalog);
  }
  return {
    catalog: prepared.get(active.version),
    retainedCatalogs: [LEGACY_EXAMPLES, ...[...prepared].filter(([version]) => version !== active.version).map(([, catalog]) => catalog)],
    legacyDeckIds: LEGACY_EXAMPLES.map((deck) => deck.id),
    crossListings: active.crossListings ?? {},
    release: active.version,
    constructorCatalogRef: Object.freeze({ version: active.version, digest: active.constructorDigest }),
    seedExamples: false,
  };
}

// A browser-local store stays synchronous for normal reads and study actions.
// Only complete Library reads and installs await exact chunk resolution. The
// stable facade lets WebMCP registrations keep one reference while the verified
// catalog view expands; learner bytes are rechecked before each atomic swap.
export function createWebsiteLocalStore({ catalogSettings, storage, clock, timeZone } = {}) {
  let current = createStudyStore({
    catalog: catalogSettings.catalog,
    retainedCatalogs: catalogSettings.retainedCatalogs ?? [],
    storage,
    ...(clock ? { clock } : {}),
    ...(timeZone ? { timeZone } : {}),
  });
  if (typeof catalogSettings.resolveTransaction !== "function") return current;
  let resolutionQueue = Promise.resolve();
  const resolveAndRun = (operation, args, metadata) => {
    const task = resolutionQueue.then(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const before = storage.getItem(LEARNER_STORAGE_KEY);
        const resolved = await catalogSettings.resolveTransaction({
          stateJson: before,
          intent: { kind: operation === "addLibraryDeck" ? "command" : "query", operation, args },
        });
        if (storage.getItem(LEARNER_STORAGE_KEY) !== before) continue;
        const candidate = createStudyStore({
          catalog: resolved.storeCatalogView,
          retainedCatalogs: [LEGACY_EXAMPLES, ...resolved.retainedCatalogViews],
          storage,
          ...(clock ? { clock } : {}),
          ...(timeZone ? { timeZone } : {}),
        });
        if (storage.getItem(LEARNER_STORAGE_KEY) !== before) continue;
        current = candidate;
        return current[operation](args, metadata);
      }
      const error = message("Study data changed while the exact course was opening. Try again.");
      error.code = "SERVICE_BUSY";
      throw error;
    });
    resolutionQueue = task.then(() => undefined, () => undefined);
    return task;
  };
  return new Proxy({}, {
    get(_target, property) {
      if (property === "addLibraryDeck") return (args, metadata) => resolveAndRun("addLibraryDeck", args, metadata);
      if (property === "getDeck") return (args, metadata) => args?.scope === "library"
        ? resolveAndRun("getDeck", args, metadata)
        : current.getDeck(args, metadata);
      const value = current[property];
      return typeof value === "function" ? value.bind(current) : value;
    },
  });
}

// Account snapshots are sparse overlays produced by the same exact-reference
// resolver used by Backend v3. The visible Library can keep its broad prepared
// browse catalog, but confirmed learner state must hydrate against these exact
// immutable deck chunks or its catalog-base digest will differ. This capability
// contains no learner state and never writes or falls back to demo content.
export async function createWebsiteAccountCatalogLoader({
  indexUrl = new URL("../data/library-releases.json", import.meta.url),
  fetcher = globalThis.fetch,
  check = null,
} = {}) {
  const { indexLocation, index, active } = await readReleaseIndex({ indexUrl, fetcher, check });
  const resolver = await releaseResolver({ indexLocation, index, active, fetcher, check });
  runCheck(check);

  return async function loadAccountCatalog({ storedStateJson = null, constructorCatalogRef, check: stateCheck = null } = {}) {
    runCheck(stateCheck);
    const resolved = await resolver.resolveTransaction({
      constructorCatalogRef,
      stateJson: storedStateJson,
      intent: { kind: "query", operation: "hydrate_confirmed_state", args: {} },
    });
    runCheck(stateCheck);
    return Object.freeze({
      catalog: resolved.storeCatalogView,
      retainedCatalogs: resolved.retainedCatalogViews,
      constructorCatalogRef: resolved.constructorCatalogRef,
    });
  };
}
