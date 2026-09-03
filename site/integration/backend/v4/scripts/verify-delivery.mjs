import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const deliveryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(deliveryRoot));
const manifestPath = "backend/v4/FILE_MANIFEST.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

async function walk(relative) {
  const found = [];
  for (const entry of await readdir(join(repositoryRoot, relative), { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, `Symlink is not allowed: ${relative}/${entry.name}`);
    if (entry.isDirectory()) found.push(...await walk(`${relative}/${entry.name}`));
    else if (entry.isFile()) found.push(`${relative}/${entry.name}`);
  }
  return found;
}

const manifestBytes = await readFile(join(repositoryRoot, manifestPath));
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.schema, "meshful-backend-delivery.v4");
assert.equal(manifest.state, "local-qualified-not-selected-not-deployed");
assert.equal(manifest.payload_file_count, manifest.file_count - 1);
const predecessorBytes = await readFile(join(repositoryRoot, manifest.predecessor.path));
assert.equal(digest(predecessorBytes), manifest.predecessor.manifest_sha256);
const predecessor = JSON.parse(predecessorBytes);
assert.equal(predecessor.payload_sha256, manifest.predecessor.payload_sha256);

const declared = new Set();
const payload = [];
for (const file of manifest.files) {
  assert.ok(file.path.startsWith("backend/v4/"));
  assert.equal(file.destination, file.path);
  assert.equal(declared.has(file.path), false, `Duplicate ${file.path}`);
  declared.add(file.path);
  if (file.path === manifestPath) {
    assert.equal(file.bytes, null);
    assert.equal(file.sha256, null);
    continue;
  }
  const bytes = await readFile(join(repositoryRoot, file.path));
  assert.equal(bytes.byteLength, file.bytes, `Byte count changed: ${file.path}`);
  assert.equal(digest(bytes), file.sha256, `Digest changed: ${file.path}`);
  payload.push(file);
}
assert.deepEqual((await walk("backend/v4")).sort(compare), [...declared].sort(compare));
payload.sort((left, right) => compare(left.path, right.path));
assert.equal(digest(payload.map((file) => `${file.sha256}  ${file.path}\n`).join("")), manifest.payload_sha256);
if (process.argv.includes("--external")) {
  for (const dependency of ["canonical", "public_library", "retained_library"]) {
    const spec = manifest.read_only_dependencies[dependency];
    const root = process.env[spec.root_env];
    assert.ok(root, `Set ${spec.root_env}`);
    if (spec.files) {
      for (const file of spec.files) {
        assert.equal(digest(await readFile(join(root, file.path))), file.sha256,
          `${dependency} changed: ${file.path}`);
      }
    }
    for (const kind of ["manifest", "index"]) {
      if (!spec[`${kind}_path`]) continue;
      assert.equal(digest(await readFile(join(root, spec[`${kind}_path`]))), spec[`${kind}_sha256`],
        `${dependency} ${kind} changed`);
    }
  }
  process.stdout.write("Current canonical, public v2 and retained v1 release pins verified.\n");
}
process.stdout.write(`Verified ${manifest.file_count} v4 files and frozen v3 predecessor.\n`);
process.stdout.write(`Payload ${manifest.payload_sha256}\nManifest ${digest(manifestBytes)}\n`);
