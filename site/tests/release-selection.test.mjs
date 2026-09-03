import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WEBMCP_TOOL_SCHEMAS } from "../integration/core/js/webmcp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bytes = (relative) => readFile(path.join(root, relative));
const text = async (relative) => (await bytes(relative)).toString("utf8");
const digest = async (relative) => createHash("sha256").update(await bytes(relative)).digest("hex");
const selection = JSON.parse(await text("integration/SELECTED_INPUTS.json"));
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function applyOverrides(base, overrides) {
  const baseByPath = new Map(base.map((item) => [item.path, item]));
  assert.equal(baseByPath.size, base.length, "predecessor selection contains duplicate paths");
  const overrideByPath = new Map();
  for (const item of overrides) {
    assert.equal(overrideByPath.has(item.path), false, `duplicate successor override: ${item.path}`);
    const predecessor = baseByPath.get(item.path);
    assert.ok(predecessor, `successor path is absent from predecessor: ${item.path}`);
    assert.equal(item.predecessor_sha256, predecessor.sha256, `${item.path}: predecessor hash`);
    overrideByPath.set(item.path, item);
  }
  return base.map((item) => {
    const override = overrideByPath.get(item.path);
    return override ? { path: item.path, sha256: override.sha256 } : item;
  });
}

function effectiveV7RuntimeFiles() {
  return applyOverrides(
    selection.backend_v7_writer_successor.runtime_selected_files,
    selection.post_v35_successors.backend_v7_account_command_recovery.runtime_file_overrides,
  );
}

function effectiveV7BrowserFiles() {
  return applyOverrides(
    selection.backend_v7_writer_successor.browser_files,
    selection.post_v35_successors.backend_v7_account_command_recovery.browser_file_overrides,
  );
}

async function filesBelow(relative) {
  const base = path.join(root, relative);
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else output.push(path.relative(root, absolute));
    }
  }
  await visit(base);
  return output.sort(compareText);
}

test("the source allowlist retains exact Accounts and Backend successor bytes", async () => {
  assert.equal(selection.schema, "meshful-sites-selected-inputs.v1");
  assert.equal(selection.accounts_v4.source_manifest_sha256,
    "bd05466bcff38498bc7e297f89e67ae8909c54b23842d3ac950fdb8cd2c4de39");
  assert.equal(selection.backend_v3.source_manifest_sha256,
    "8ea8096550a100c78177160858bc43f4b7e15ad26a656173e1fb61c967f374cb");
  assert.equal(selection.backend_v3.source_payload_sha256,
    "f238f6fc8a66d6a24164730a2c8987356187799624e6196fce499ba94123f39a");
  assert.equal(selection.backend_v4_archive_successor.source_manifest_sha256,
    "a8c48bb05652665da99c58e29b3530049d59902287676999c3190d4a98ffce00");
  assert.equal(selection.backend_v4_archive_successor.source_payload_sha256,
    "2b06191616208dceefb0fab4ac66f16f52bc914c950e09d4662814fc94b824b0");
  assert.equal(selection.backend_v4_archive_successor.upstream_manifest_sha256,
    "2b48efedfd92c66f1ae75fc85ca1ab0f9960a6d4b3ebd5f1b26c465a2509bd51");
  assert.equal(selection.backend_v4_archive_successor.upstream_payload_sha256,
    "99add73b49e97000da6ad762147b787035e7f91d2df0deeada0710f6ac828f56");
  assert.equal(selection.backend_v5_catalog_successor.source_manifest_sha256,
    "f9d4a86ffb5cabc3e80f88b2f6958d33cd0dbe0dd3cd15419081addc36527243");
  assert.equal(selection.backend_v5_catalog_successor.source_payload_sha256,
    "68029d33c49116d9b90edafd6905bfbe5f9bd2fad4c606fee91b1f3c4c5ee732");
  assert.equal(selection.backend_v5_catalog_successor.upstream_manifest_sha256,
    "ddbb4ed04aca6990fd9543255ce64af39ff913f6595000bc2e07419ee7a2a7ce");
  assert.equal(selection.backend_v5_catalog_successor.upstream_payload_sha256,
    "e40fc3762592c6f0c7d44087bc034a480a8a6e34470f5d4adc972d76521ccc65");
  assert.equal(selection.backend_v7_writer_successor.source_manifest_sha256,
    "f2eddbc8c577c214513bb341f10849ef65e2d39aaf56ccee37f42a8515ff0a6d");
  assert.equal(selection.backend_v7_writer_successor.source_payload_sha256,
    "7f1978ce77ca218fe7467477fc4911ca7220e26d1ea656fd09cb65f695315522");
  const recoverySuccessor = selection.post_v35_successors.backend_v7_account_command_recovery;
  assert.equal(recoverySuccessor.predecessor_selection, "backend_v7_writer_successor");
  assert.equal(recoverySuccessor.predecessor_source_manifest_sha256,
    selection.backend_v7_writer_successor.source_manifest_sha256);
  assert.equal(recoverySuccessor.predecessor_source_payload_sha256,
    selection.backend_v7_writer_successor.source_payload_sha256);
  assert.equal(recoverySuccessor.d1_migration_change, false);
  assert.equal(recoverySuccessor.public_webmcp_tool_change, false);
  assert.deepEqual(selection.post_v35_successors.browser_account_recovery.files.map((item) => ({
    path: item.path,
    predecessor_sha256: item.predecessor_sha256,
  })), [
    {
      path: "public/study/js/account-runtime.js",
      predecessor_sha256: "e7945a35f5afa32afac364e29edf7588bf280579492e69c19b01c6b86e5b694e",
    },
    {
      path: "public/study/accounts/browser-study-session.mjs",
      predecessor_sha256: "ed3d75a1220c6d36d580564865daf77a7c6efcb0984d410e6262f9cc8aa28741",
    },
  ]);
  const effectiveRuntime = effectiveV7RuntimeFiles();
  const effectiveBrowser = effectiveV7BrowserFiles();
  for (const item of [
    ...selection.accounts_v4.selected_files,
    ...selection.backend_v3.selected_files,
    ...selection.backend_v4_archive_successor.selected_files,
    ...selection.backend_v4_archive_successor.selected_verification_files,
    selection.backend_v4_archive_successor.browser_file,
    ...selection.backend_v4_archive_successor.selected_verification_dependencies,
    ...selection.backend_v5_catalog_successor.selected_files,
    ...selection.backend_v5_catalog_successor.selected_verification_files,
    selection.backend_v5_catalog_successor.browser_file,
    ...selection.backend_v5_catalog_successor.selected_verification_dependencies,
    ...effectiveRuntime,
    ...effectiveBrowser,
    selection.backend_v7_writer_successor.packaged_migration,
    ...selection.post_v35_successors.browser_account_recovery.files,
  ]) {
    assert.equal(await digest(item.path), item.sha256, item.path);
  }
  const selectedV3Verification = selection.backend_v4_archive_successor.selected_verification_dependencies
    .filter(({ path: selectedPath }) => selectedPath.startsWith("integration/backend/v3/"));
  assert.deepEqual(await filesBelow("integration/backend/v3"), [
    ...selection.backend_v3.selected_files,
    ...selectedV3Verification,
  ].map(({ path: selectedPath }) => selectedPath).sort(compareText));
  assert.deepEqual(await filesBelow("integration/backend/v4"), [
    ...selection.backend_v4_archive_successor.selected_files,
    ...selection.backend_v4_archive_successor.selected_verification_files,
  ].map(({ path: selectedPath }) => selectedPath).sort(compareText));
  assert.deepEqual(await filesBelow("integration/backend/v5"), [
    ...selection.backend_v5_catalog_successor.selected_files,
    ...selection.backend_v5_catalog_successor.selected_verification_files,
  ].map(({ path: selectedPath }) => selectedPath).sort(compareText));
  assert.deepEqual(await filesBelow("integration/backend/v7"),
    effectiveRuntime
      .map(({ path: selectedPath }) => selectedPath).sort(compareText));
  assert.equal(await digest("integration/backend/v7/src/durable-client.mjs"),
    await digest("public/study/backend/v7/src/durable-client.mjs"));
  const predecessorManifest = JSON.parse(await text("integration/backend/v3/FILE_MANIFEST.json"));
  assert.equal(predecessorManifest.payload_sha256, selection.backend_v3.source_payload_sha256);
  const selectedV4Manifest = JSON.parse(await text("integration/backend/v4/FILE_MANIFEST.json"));
  assert.equal(selectedV4Manifest.payload_sha256,
    selection.backend_v4_archive_successor.source_payload_sha256);
  assert.deepEqual(selectedV4Manifest.migrations.required_existing, [
    "backend/migrations/0001_learner_data.sql",
    "backend/v2/migrations/0002_fragmented_storage.sql",
  ]);
  const selectedV5Manifest = JSON.parse(await text("integration/backend/v5/FILE_MANIFEST.json"));
  assert.equal(selectedV5Manifest.payload_sha256,
    selection.backend_v5_catalog_successor.source_payload_sha256);
  assert.equal(selectedV5Manifest.predecessor.manifest_sha256,
    selection.backend_v4_archive_successor.source_manifest_sha256);
  assert.equal(selectedV5Manifest.predecessor.payload_sha256,
    selection.backend_v4_archive_successor.source_payload_sha256);
  assert.deepEqual(selectedV5Manifest.migrations.required_existing, [
    "backend/migrations/0001_learner_data.sql",
    "backend/v2/migrations/0002_fragmented_storage.sql",
  ]);
  assert.equal(selectedV4Manifest.read_only_dependencies.canonical.files
    .find(({ path: dependencyPath }) => dependencyPath === "web/js/webmcp.js")?.sha256,
  selection.canonical_runtime.webmcp_predecessor_sha256);
});

test("every selected Backend runtime and browser import resolves inside the candidate", async () => {
  for (const item of [
    ...selection.backend_v3.selected_files,
    ...selection.backend_v4_archive_successor.selected_files,
    ...selection.backend_v4_archive_successor.selected_verification_files
      .filter(({ path: selectedPath }) => selectedPath.endsWith(".mjs")),
    selection.backend_v4_archive_successor.browser_file,
    ...selection.backend_v4_archive_successor.selected_verification_dependencies
      .filter(({ path: selectedPath }) => selectedPath.endsWith(".mjs")),
    ...selection.backend_v5_catalog_successor.selected_files,
    ...selection.backend_v5_catalog_successor.selected_verification_files
      .filter(({ path: selectedPath }) => selectedPath.endsWith(".mjs")),
    selection.backend_v5_catalog_successor.browser_file,
    ...selection.backend_v5_catalog_successor.selected_verification_dependencies
      .filter(({ path: selectedPath }) => selectedPath.endsWith(".mjs")),
    ...effectiveV7RuntimeFiles(),
    ...effectiveV7BrowserFiles(),
    ...selection.post_v35_successors.browser_account_recovery.files,
  ]) {
    const source = await text(item.path);
    for (const match of source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
      const dependency = path.resolve(path.dirname(path.join(root, item.path)), match[1]);
      assert.equal(dependency.startsWith(`${root}${path.sep}`), true, match[1]);
      await access(dependency);
    }
  }
});

test("canonical mirrors, asset identity, budget, and 13 WebMCP schemas are frozen", async () => {
  const pins = selection.canonical_runtime;
  const webmcpSuccessor = selection.post_v35_successors.canonical_webmcp_copy;
  for (const relative of ["integration/core/js/library-catalog.js", "public/study/js/library-catalog.js"])
    assert.equal(await digest(relative), pins.library_catalog_sha256, relative);
  for (const relative of ["integration/core/js/store.js", "public/study/js/store.js"])
    assert.equal(await digest(relative), pins.store_sha256, relative);
  for (const relative of ["integration/core/js/streak.js", "public/study/js/streak.js"])
    assert.equal(await digest(relative), pins.streak_sha256, relative);
  assert.equal(pins.webmcp_sha256,
    "27f5cee39858f07846dd63a1b7deb6929fa486c93da5e1cd918603f98a545f30");
  assert.equal(webmcpSuccessor.predecessor_sha256, pins.webmcp_sha256);
  for (const relative of webmcpSuccessor.mirror_paths)
    assert.equal(await digest(relative), webmcpSuccessor.sha256, relative);
  for (const relative of ["integration/core/js/deck-build-guide.js", "public/study/js/deck-build-guide.js"])
    assert.equal(await digest(relative), pins.deck_build_guide_sha256, relative);
  assert.equal(pins.deck_build_guide_version, "deck-generation-guide.v1.9");
  assert.deepEqual(selection.post_v35_successors.deck_generation_guide_v1_9, {
    source_handoff_sha256: "f047274e7b22ab494d40708b69bba4465e856e23c5746a14f92abf9744e305f0",
    source_validation_sha256: "c91d99d2b567c10b18259002e5e9227f50ec4995b32a7c9cd36cf5482cf291a5",
    guide_freeze_sha256: "aaeb78829e92313616da381e065b6d995ba2930579217a08b9f7db5fdd96bc3b",
    metadata_stripped_constraints_sha256: "785f469eabd147981e9c857a59b0353927d4b12a0fc067a0cb39741c22d4a074",
    registration_metadata_sha256: "f572b85db872946adf7db7ba4ba01a300e0734a27570a7f5957197e8f6599ec4",
    registration_metadata_bytes: 44_587,
    public_webmcp_tool_change: false,
  });
  assert.equal(Object.keys(WEBMCP_TOOL_SCHEMAS).length, 13);
  assert.equal(webmcpSuccessor.webmcp_tool_count, 13);
  assert.equal(webmcpSuccessor.public_webmcp_tool_change, false);
  assert.equal(await digest(selection.library_assets.manifest_path),
    selection.library_assets.manifest_sha256);
  assert.equal(await digest(selection.library_assets.public_metadata_path),
    selection.library_assets.public_metadata_sha256);
  assert.equal(await digest(selection.library_assets.verification_receipt_path),
    selection.library_assets.verification_receipt_sha256);
  assert.equal(await digest(selection.library_assets.description_successor.overlay_path),
    selection.library_assets.description_successor.overlay_sha256);
  for (const retained of selection.library_assets.retained_releases) {
    assert.equal(await digest(retained.manifest_path), retained.manifest_sha256);
  }
  assert.equal(await digest(selection.library_assets.retained_release.manifest_path),
    selection.library_assets.retained_release.manifest_sha256);
  assert.equal(selection.library_assets.release, "2026-09-03.public-sanitized.v4");
  assert.deepEqual(selection.library_assets.retained_releases.map(({ release }) => release), [
    "2026-09-02.public-sanitized.v3",
    "2026-08-30.reviewed-72.v1",
  ]);
  assert.equal(selection.library_assets.retained_release.release, "2026-08-30.reviewed-72.v1");
  assert.equal(selection.library_assets.browser_catalog_artifact_sha256,
    "sha256:ffcd11b6409fcc7c5fb500e097e41c829d94601614b6fe5ae37ebf23dafb28a1");
  assert.deepEqual(selection.library_assets.description_successor, {
    overlay_path: "integration/library-assets/COURSE_DESCRIPTION_OVERLAY_V1.json",
    overlay_sha256: "221a8ce11bcc52cbb81814baf27599b7081b6b7d79460c70006971f914f140ee",
    base_public_metadata_sha256: "b73810e51aedffbe0062e3d4bb0e0c982e4b6f792eb236ea13d4fe6982b7f8be",
    base_browser_catalog_artifact_sha256: "fd26b03178e8ffa0db631814cc7771aae1966f9b087499378ddfa1c78b98a332",
    description_changes: 72,
    non_description_changes: 0,
  });
  assert.deepEqual(selection.library_assets.resolution_budget,
    { max_decks: 42, max_cards: 5500, max_raw_chunk_bytes: 7000000 });
});

test("tracked source contains no owner path or symlink escape", async () => {
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root })
    .toString("utf8").split("\0").filter(Boolean);
  const index = execFileSync("git", ["ls-files", "-s"], { cwd: root }).toString("utf8");
  assert.doesNotMatch(index, /^120000\s/m);
  assert.equal(tracked.some((entry) => entry === "node_modules" || entry.startsWith("node_modules/")), false);
  const home = homedir();
  const forbidden = [
    `${home}${path.sep}`,
    path.basename(home),
    path.join("Documents", "GitHub"),
    [".", "tmp", path.sep].join(""),
  ].map((value) => value.toLowerCase());
  for (const relative of tracked) {
    let status;
    try { status = await lstat(path.join(root, relative)); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    assert.equal(status.isSymbolicLink(), false, relative);
    const content = await bytes(relative);
    const source = content.toString("utf8").toLowerCase();
    for (const needle of forbidden) {
      const selectedOverlayProvenance = relative === selection.library_assets.description_successor.overlay_path
        && needle === [".", "tmp/"].join("");
      if (!selectedOverlayProvenance) assert.equal(source.includes(needle), false, `${relative}: ${needle}`);
    }
  }
  assert.deepEqual(selection.source_boundary, {
    selected_files_only: true,
    local_verification_harness_in_source: true,
    raw_library_construction_inputs_in_source: false,
    absolute_owner_paths_in_source: false,
    tracked_symlinks: false,
  });
});
