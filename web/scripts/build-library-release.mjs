// Deterministic PRIVATE build input. Reads the Library owner's pinned loader;
// never regenerates decks, copies source provenance, deploys, or touches users.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, realpath, lstat, access } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareLibraryCatalog } from "../js/library-catalog.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const noPrefix = (value) => String(value).replace(/^sha256:/, "");
const relativePath = (value) => typeof value === "string" && value.length > 0 && !value.startsWith("/") &&
  !value.includes("\\") && value.split("/").every((part) => part && part !== "." && part !== "..");

export function browserFeedFor(prepared, feed) {
  assert.equal(prepared.library.catalogRef.digest, feed.catalog_ref.digest);
  const sourceCardIndex = Object.fromEntries(Object.entries(feed.source_card_index).map(([id, item]) => [id, {
    source_deck_id: item.source_deck_id,
    catalog_deck_id: item.catalog_deck_id,
    artifact_sha256: item.artifact_sha256,
    // The original local path and complete source-reference map stay on disk.
    // Preparation needs a consistent artifact identity, not a readable path.
    artifact_path: `artifact:${item.artifact_sha256}`,
    json_pointer: item.json_pointer,
  }]));
  return {
    projection_schema_version: feed.projection_schema_version,
    audience: feed.audience, public_release_approved: feed.public_release_approved,
    rights_status: feed.rights_status, current_runtime_compatible: feed.current_runtime_compatible,
    catalog: feed.catalog, dependency_edges: feed.dependency_edges,
    source_card_index: sourceCardIndex,
    runtime_identity_map: {
      normalization_version: feed.runtime_identity_map.normalization_version,
      decks: feed.runtime_identity_map.decks,
      cards: feed.runtime_identity_map.cards,
    },
    catalog_ref: feed.catalog_ref,
    dependency_graph_sha256: feed.dependency_graph_sha256,
  };
}

async function pinnedFile(root, path, digest) {
  assert.ok(relativePath(path), "Source paths must stay beneath the trusted source root");
  const absolute = resolve(root, path);
  assert.equal(await realpath(absolute), absolute, "Source symlinks are not admitted");
  assert.ok((await lstat(absolute)).isFile(), "Expected a regular pinned source file");
  const bytes = await readFile(absolute);
  assert.equal(sha(bytes), noPrefix(digest), `Source pin changed: ${path}`);
  return bytes;
}

async function writeImmutable(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, bytes, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert.equal(sha(await readFile(path)), sha(bytes), "Refusing to replace immutable release bytes");
  }
}

export async function buildLibraryRelease({ sourceRoot, selectionPath, outputDirectory }) {
  const root = await realpath(sourceRoot);
  const output = resolve(outputDirectory);
  // Refuse to mutate any frozen predecessor, including its nested public tree.
  for (let parent = output; parent !== dirname(parent); parent = dirname(parent)) {
    const frozen = await access(resolve(parent, "FROZEN.json")).then(() => true, () => false);
    assert.ok(!frozen, "Create a successor; this candidate is frozen");
  }
  const selectionBytes = await readFile(selectionPath);
  const selection = JSON.parse(selectionBytes);
  assert.equal(selection.format, "meshful-private-library-build-selection.v1");
  assert.equal(selection.audience, "private");
  assert.equal(selection.publicReleaseApproved, false);
  assert.ok(selection.releases.length > 0 && selection.releases.length <= 256);
  const oldIndex = await readFile(resolve(output, "library-releases.json"), "utf8").then(JSON.parse, (error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  const releases = [];
  const receipts = [];
  for (const selected of selection.releases) {
    assert.match(selected.version, /^[a-z0-9][a-z0-9.-]{0,127}$/);
    const manifestBytes = await pinnedFile(root, selected.manifestPath, selected.manifestSha256);
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.catalog_release_version, selected.version);
    assert.equal(manifest.audience, "private");
    assert.equal(manifest.public_release_approved, false);
    for (const module of [manifest.loader, ...manifest.loader_dependencies]) await pinnedFile(root, module.path, module.sha256);
    const { loadCandidate } = await import(pathToFileURL(resolve(root, manifest.loader.path)));
    const feed = loadCandidate({ sourceRoots: { [manifest.source_root_key]: root }, expectedManifestSha256: `sha256:${noPrefix(selected.manifestSha256)}` });
    const prepared = await prepareLibraryCatalog(feed);
    const browserFeed = browserFeedFor(prepared, feed);
    const browserPrepared = await prepareLibraryCatalog(browserFeed);
    assert.deepEqual(browserPrepared.library, prepared.library, "Browser projection changed authoritative base identities");
    assert.deepEqual(browserPrepared.catalog, prepared.catalog, "Browser projection changed cards or order");
    const encoded = JSON.stringify(browserFeed) + "\n";
    const bytes = Buffer.from(encoded);
    assert.ok(bytes.length < 25 * 1024 * 1024, "A release must fit the private build's per-asset budget; split the runtime projection explicitly if needed");
    const digest = sha(bytes);
    const path = `library/${selected.version}/${digest}.json`;
    const entry = {
      version: selected.version, path, sha256: digest, bytes: bytes.length,
      catalogDigest: prepared.library.catalogRef.digest,
      dependencyGraphDigest: prepared.library.dependencyGraphDigest,
      sourceManifestSha256: noPrefix(selected.manifestSha256),
      counts: manifest.counts,
      crossListings: Object.fromEntries(manifest.decks.filter((deck) => deck.proposed_public_metadata.cross_listed_fields.length)
        .map((deck) => [deck.catalog_deck_id, deck.proposed_public_metadata.cross_listed_fields])),
    };
    const old = oldIndex?.releases.find((release) => release.version === entry.version);
    if (old) assert.deepEqual(entry, old, "A published version may not be repinned in place");
    await writeImmutable(resolve(output, path), bytes);
    releases.push(entry);
    receipts.push({ version: entry.version, source_manifest_sha256: entry.sourceManifestSha256,
      loader_sha256: noPrefix(manifest.loader.sha256), browser_feed_sha256: digest,
      browser_bytes: bytes.length, counts: entry.counts,
      private_source_paths_in_browser: false, source_reference_map_in_browser: false,
      exact_prepared_base_and_content_equality: true });
  }
  assert.equal(new Set(releases.map((entry) => entry.version)).size, releases.length);
  assert.ok(releases.some((entry) => entry.version === selection.active));
  for (const retained of oldIndex?.releases ?? []) {
    assert.ok(releases.some((entry) => entry.version === retained.version && entry.sha256 === retained.sha256), "Retain old releases before updating the normal catalog");
  }
  const index = { format: "meshful-website-library-releases.v1", active: selection.active, audience: "private", publicReleaseApproved: false, releases };
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "library-releases.json"), JSON.stringify(index, null, 2) + "\n");
  return { format: "meshful-private-library-build-receipt.v1", selection_sha256: sha(selectionBytes),
    index_sha256: sha(await readFile(resolve(output, "library-releases.json"))),
    active: index.active, releases: receipts, source_corpus_copied: false, deployed: false,
    generated_index: relative(root, resolve(output, "library-releases.json")) };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const values = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [value, all[index + 1]]], []));
  const receipt = await buildLibraryRelease({ sourceRoot: values["--source-root"], selectionPath: values["--selection"], outputDirectory: values["--output"] });
  console.log(JSON.stringify(receipt, null, 2));
}
