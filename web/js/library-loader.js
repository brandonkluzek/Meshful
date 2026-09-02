import { admitLibraryCatalogArtifact, prepareLibraryCatalog } from "./library-catalog.js";
import { CATALOG as LEGACY_EXAMPLES } from "../data/catalog.js";

const INDEX_FORMAT = "meshful-website-library-releases.v1";
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FEED_BYTES = 48 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const message = (detail) => new Error(`The Library could not open. ${detail} Your saved decks have not been changed.`);

async function readJson(url, { fetcher, maxBytes, digest, cache = "no-cache" }) {
  const response = await fetcher(url.href, { credentials: "same-origin", redirect: "error", cache });
  if (!response.ok) throw message("The selected catalog release is unavailable.");
  if (Number(response.headers?.get("content-length")) > maxBytes) throw message("The catalog exceeds its size limit.");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw message("The catalog exceeds its size limit.");
  if (digest) {
    const hashed = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const actual = [...new Uint8Array(hashed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== digest) throw message("The saved release does not match its content pin.");
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw message("The selected catalog is not valid JSON."); }
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

function demoCatalogSettings() {
  return {
    catalog: LEGACY_EXAMPLES,
    retainedCatalogs: [],
    legacyDeckIds: LEGACY_EXAMPLES.map((deck) => deck.id),
    crossListings: {},
    release: "meshful-existing-demo-fixtures.v1",
    seedExamples: true,
  };
}

// One deployed release index is the build/runtime connection. It lists immutable
// release files; old files stay available for installed bases. Loading has zero
// learner writes and no fallback to examples on missing/mismatched content.
export async function loadWebsiteLibrary({
  indexUrl = new URL("../data/library-releases.json", import.meta.url),
  fetcher = globalThis.fetch,
  storedStateJson = null,
} = {}) {
  const indexLocation = new URL(indexUrl);
  if (!["http:", "https:"].includes(indexLocation.protocol)) throw message("Use the assembled website to load the reviewed Library.");
  let index;
  try {
    index = await readJson(indexLocation, { fetcher, maxBytes: 512 * 1024 });
  } catch (error) {
    // The public release intentionally ships only the three bounded
    // public examples. Existing versioned catalog installs still fail closed;
    // never hydrate them against unrelated example bytes.
    if (installedReleaseRefs(storedStateJson).length) throw error;
    return demoCatalogSettings();
  }
  if (index.format !== INDEX_FORMAT || !Array.isArray(index.releases) || !index.releases.length || index.releases.length > 256) {
    throw message("The release index is invalid.");
  }
  const versions = new Set();
  for (const release of index.releases) {
    if (!release.version || versions.has(release.version) || !SHA256.test(release.sha256 ?? "") ||
        !/^library\/[a-z0-9][a-z0-9.-]*\/[a-f0-9]{64}\.json$/.test(release.path ?? "") ||
        !/^sha256:[a-f0-9]{64}$/.test(release.catalogDigest ?? "")) throw message("The release index contains an invalid identity.");
    if (release.delivery === "artifact" &&
        (release.browser_artifact_contract !== "meshful-library-runtime-artifact.v1" ||
         !/^sha256:[a-f0-9]{64}$/.test(release.runtime?.preparedConstructorDigest ?? "") ||
         !/^sha256:[a-f0-9]{64}$/.test(release.dependencyGraphDigest ?? ""))) {
      throw message("The release index contains an invalid catalog artifact identity.");
    }
    versions.add(release.version);
  }
  const active = index.releases.find((release) => release.version === index.active);
  if (!active) throw message("No current release was selected.");
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
    const feed = await readJson(url, { fetcher,
      maxBytes: release.delivery === "artifact" ? MAX_ARTIFACT_BYTES : MAX_FEED_BYTES,
      digest: release.sha256, cache: "force-cache" });
    const admitted = release.delivery === "artifact"
      ? await admitLibraryCatalogArtifact(feed, {
          expectedConstructorDigest: release.runtime.preparedConstructorDigest,
          expectedCatalogRef: { version: release.version, digest: release.catalogDigest },
          expectedDependencyGraphSha256: release.dependencyGraphDigest,
        })
      : await prepareLibraryCatalog(feed);
    const catalog = release.delivery === "artifact" ? admitted.prepared : admitted;
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
    seedExamples: false,
  };
}
