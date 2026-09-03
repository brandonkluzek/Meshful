import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const deliveryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(deliveryRoot));
const manifestPath = "backend/v4/FILE_MANIFEST.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const repoPath = (path) => relative(repositoryRoot, path).split(sep).join("/");

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${join(directory, entry.name)}`);
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

const predecessorPath = "backend/v3/FILE_MANIFEST.json";
const predecessorBytes = await readFile(join(repositoryRoot, predecessorPath));
const predecessor = JSON.parse(predecessorBytes);
const paths = (await walk(deliveryRoot)).map(repoPath).filter((path) => path !== manifestPath).sort(compare);
const files = [];
const payload = [];
for (const path of paths) {
  const bytes = await readFile(join(repositoryRoot, path));
  const sha256 = digest(bytes);
  const record = { path, destination: path, bytes: bytes.byteLength, sha256 };
  files.push(record);
  payload.push({ path, sha256 });
}
files.push({ path: manifestPath, destination: manifestPath, bytes: null, sha256: null });
files.sort((left, right) => compare(left.path, right.path));
const payloadSha256 = digest(payload.map((file) => `${file.sha256}  ${file.path}\n`).join(""));
const manifest = {
  schema: "meshful-backend-delivery.v4",
  prepared_on: "2026-09-02",
  state: "local-qualified-not-selected-not-deployed",
  source_root: ".",
  delivery_root: "backend/v4",
  integration_owner: "Dev - Website",
  integration_owner_task: "01a04b75-6f44-7783-a88c-77b03ec4c2a4",
  file_count: files.length,
  payload_file_count: payload.length,
  payload_sha256: payloadSha256,
  fingerprint_recipe: "SHA-256 of each payload SHA-256, two ASCII spaces, full repo-relative path, and one LF byte, concatenated in lexicographic code-unit path order; exclude this manifest.",
  predecessor: {
    path: predecessorPath,
    manifest_sha256: digest(predecessorBytes),
    payload_sha256: predecessor.payload_sha256,
    file_count: predecessor.file_count
  },
  migrations: { added: [], required_existing: ["backend/migrations/0001_learner_data.sql", "backend/v2/migrations/0002_fragmented_storage.sql"] },
  public_webmcp_tool_change: false,
  read_only_dependencies: {
    canonical: {
      root_env: "MESHFUL_CANONICAL_ROOT",
      files: [
        { path: "web/js/library-catalog.js", sha256: "fc2458b63e813f53bd81b231084dcc756963a4ed3625fd38aee5d8ceb024ba95" },
        { path: "web/js/store.js", sha256: "4e288fe72bf248acbf086bdef73eb9bc52a2718afd69f510ce98fccf5607bb76" },
        { path: "web/js/streak.js", sha256: "ef5337ebb320bc1cd96f292164dd57667189ff04eb7150ff4a926e2938e9ead3" },
        { path: "web/js/webmcp.js", sha256: "d25fe626c108341bd82488559b4dae8d103fc85988d58f289023183a282e115d" },
        { path: "web/tests/library-resolver.test.mjs", sha256: "967254b13276d3b92a473c426a2d2aa55ee3809eef8260ca06cc997be465bd44" },
        { path: "web/tests/library-catalog.test.mjs", sha256: "771fcd14c4df4904b808db6ea2c002bf2d312a46804713ac7b003f9bc0603fc1" }
      ]
    },
    public_library: {
      root_env: "MESHFUL_PUBLIC_LIBRARY_ROOT",
      manifest_path: "asset-manifest.json",
      manifest_sha256: "92b9e2b5083d8a45ea11ef6d4793c180c1eed073f56d1577127b17d2fbbd45e7",
      index_path: "runtime/index.json",
      index_sha256: "9638252b82ec483c97e7d40ddee9278aa892db9cc541e47b73c9c7f088efe5a7"
    },
    retained_library: {
      root_env: "MESHFUL_LIBRARY_ASSET_ROOT",
      index_path: "index.json",
      index_sha256: "6daff48b99faae5047a69d56cfbbf7aa6b162367337044ce59e9774bbfc29a00"
    }
  },
  files,
};
const output = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(join(repositoryRoot, manifestPath), output);
process.stdout.write(`Wrote ${manifest.file_count}-file v4 manifest.\nPayload ${payloadSha256}\nManifest ${digest(output)}\n`);
