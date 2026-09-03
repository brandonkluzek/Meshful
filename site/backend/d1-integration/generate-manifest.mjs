import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const integrationRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(integrationRoot, "../..");
const deliveryRoot = "backend/d1-integration";
const manifestRelative = `${deliveryRoot}/FILE_MANIFEST.json`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function walk(root, relative = "") {
  const files = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), `Delivery contains a symlink: ${relative}/${entry.name}`);
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(root, path));
    else if (entry.isFile()) files.push(path);
    else assert.fail(`Delivery contains a non-regular filesystem entry: ${path}`);
  }
  return files;
}

function role(path) {
  if (path.endsWith("SITES_D1_CONTRACT.json")) return "integration-contract";
  if (path.endsWith("HOSTED_ACCEPTANCE.json")) return "hosted-acceptance-contract";
  if (path.endsWith("HOSTED_EVIDENCE_CONTRACT.json")) return "hosted-evidence-contract";
  if (path.endsWith("HOSTED_ADAPTER.md")) return "website-handoff-documentation";
  if (path.endsWith("README.md")) return "handoff-documentation";
  if (path.includes("/drizzle/") && path.endsWith(".sql")) return "sites-migration-artifact";
  if (path.endsWith("/drizzle/meta/_journal.json")) return "sites-migration-journal";
  if (path.includes("/tests/")) return "provider-free-verification";
  if (path.endsWith("inspect-applied-schema.mjs")) return "owner-only-schema-attestation";
  if (path.endsWith("pack-sites-migrations.mjs")) return "sites-migration-packager";
  if (path.endsWith("run-hosted-acceptance.mjs")) return "hosted-acceptance-runner";
  if (path.endsWith("generate-manifest.mjs")) return "deterministic-manifest-generator";
  if (path.endsWith("verify.mjs")) return "source-and-package-verifier";
  if (path.endsWith("package.json")) return "local-tooling";
  throw new Error(`Unclassified delivery file: ${path}`);
}

const payloadPaths = (await walk(integrationRoot))
  .filter((path) => path !== "FILE_MANIFEST.json")
  .map((path) => `${deliveryRoot}/${path}`)
  .sort(compare);
const payloadFiles = [];
for (const path of payloadPaths) {
  const bytes = await readFile(join(repositoryRoot, path));
  payloadFiles.push({
    path,
    destination: path,
    role: role(path),
    bytes: bytes.byteLength,
    sha256: digest(bytes),
  });
}
const payloadSha256 = digest(payloadFiles.map((file) => `${file.sha256}  ${file.path}\n`).join(""));
const self = { path: manifestRelative, destination: manifestRelative,
  role: "manifest-self-excluded", bytes: null, sha256: null };
const files = [...payloadFiles, self].sort((a, b) => compare(a.path, b.path));
const manifest = {
  schema: "meshful-d1-integration-delivery.v1",
  prepared_on: "2026-09-01",
  state: "local-qualified-default-denied-not-hosted",
  delivery_root: deliveryRoot,
  integration_owner: "Dev - Website",
  integration_owner_task: "01a04b75-6f44-7783-a88c-77b03ec4c2a4",
  file_count: files.length,
  payload_file_count: payloadFiles.length,
  payload_sha256: payloadSha256,
  fingerprint_recipe: "SHA-256 of each payload SHA-256, two ASCII spaces, full repo-relative path, and one LF byte (0x0A), concatenated in lexicographic code-unit path order. Paths begin backend/d1-integration/. Exclude this manifest; do not use localeCompare.",
  predecessors: [
    { delivery: "backend-v1", manifest: "backend/FILE_MANIFEST.md",
      manifest_sha256: "6c4ca3ccb5681cca26f082ba3782c0990e53962d95280ddab4ab2597cd308de1",
      payload_sha256: "4a38303cc21f4693706246e8a0ceace7f0200e0c5c7203a2a9db149b9ccf023a" },
    { delivery: "backend-v2-capacity-successor", manifest: "backend/v2/FILE_MANIFEST.json",
      manifest_sha256: "0a24e7c6e8084942b4f4a76eb3f2bc183c1817a20f07b3eff361184631080a39",
      payload_sha256: "304e2981eb9974247ce11c79cf5039e46d81151844545cecb2bf49a0c7468e1a" },
    { delivery: "d1-base-migration-rehearsal", manifest: "backend/migration-base/FILE_MANIFEST.json",
      manifest_sha256: "05db45d5e1ccf2a034c4df1695c74c496d7a7de1f8eed3ca64f1a129afd7dc9c",
      payload_sha256: "1a6517b935e39af15b3c7ecea1326a7b2b1df305984bacec42a82dd227620172" },
  ],
  files,
  boundary: "Backend-owned configuration, verification and hosted-acceptance handoff only. It contains no Site mutation, D1 resource, credential, identity, learner row, private Library corpus, deployment or endpoint activation.",
};
await writeFile(join(repositoryRoot, manifestRelative), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ manifest: manifestRelative, file_count: files.length,
  payload_sha256: payloadSha256 })}\n`);
