import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const here = fileURLToPath(new URL("./", import.meta.url));
const prefix = "backend/d1-sites-case-fix/";
const manifestPath = `${prefix}FILE_MANIFEST.json`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function walk(relative = "") {
  const files = [];
  for (const entry of await readdir(join(here, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    const status = await lstat(join(here, path));
    assert.ok(!status.isSymbolicLink(), `Delivery contains a symlink: ${path}`);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
    else assert.fail(`Delivery contains a non-regular entry: ${path}`);
  }
  return files;
}

function role(path) {
  if (path.includes("/drizzle/")) return path.endsWith("_journal.json") ? "sites_migration_journal" : "sites_migration";
  if (path.endsWith("/evidence/WEBSITE_V12_FAILURE_RECEIPT.json")) return "website_failure_evidence";
  if (path.endsWith("/evidence/LOCAL_WRANGLER_4_92_RECEIPT.json")) return "local_wrangler_evidence";
  if (path.includes("/tests/")) return "provider_free_test";
  if (path.endsWith("CONTRACT.json")) return "provider_workaround_contract";
  if (path.endsWith("README.md")) return "integration_handoff";
  if (path.endsWith("inspect-case-fixed-schema.mjs")) return "worker_schema_attestation";
  if (path.endsWith("pack-case-fixed.mjs")) return "site_packager";
  if (path.endsWith("build-case-fixed-package.mjs")) return "deterministic_transform";
  if (path.endsWith("verify.mjs")) return "delivery_verifier";
  if (path.endsWith("generate-manifest.mjs")) return "manifest_generator";
  if (path.endsWith("package.json")) return "package_metadata";
  return "delivery_manifest";
}

const relativeFiles = (await walk()).sort(compare);
assert.ok(relativeFiles.includes("FILE_MANIFEST.json") || !relativeFiles.some((path) => path === "FILE_MANIFEST.json"));
const payload = [];
const files = [];
for (const relative of relativeFiles.filter((path) => path !== "FILE_MANIFEST.json")) {
  const bytes = await readFile(join(here, relative));
  const path = `${prefix}${relative}`;
  const record = { path, destination: path, role: role(path), bytes: bytes.byteLength, sha256: sha256(bytes) };
  files.push(record);
  payload.push(record);
}
files.push({ path: manifestPath, destination: manifestPath, role: "delivery_manifest", bytes: null, sha256: null });
files.sort((a, b) => compare(a.path, b.path));
payload.sort((a, b) => compare(a.path, b.path));
const manifest = {
  schema: "meshful-sites-d1-case-fix-delivery.v1",
  delivery_root: "backend/d1-sites-case-fix",
  prepared_on: "2026-09-01",
  status: "provider-workaround-ready-default-denied-not-hosted",
  predecessor: {
    manifest: "backend/d1-integration/FILE_MANIFEST.json",
    manifest_sha256: "47bb451e2ed8c6a0c2e43833e8183652d65334a60a6cdcef2904a26bdea9bba4",
    payload_sha256: "8cc9db06ebe71a300a32f873ca5d89c2995ceaa51cbededfa6cdc1f60ad68d93"
  },
  provider_failure_receipt_sha256: "df81189b80e6fb0a80cc02aa19f9cee0f04a1fdd881b61db86a78df7d298d2aa",
  file_count: files.length,
  payload_sha256: sha256(payload.map((file) => `${file.sha256}  ${file.path}\n`).join("")),
  files,
  boundary: "No provider mutation is proven by this delivery. Website owns the next owner-only Sites deployment; learner activation remains closed."
};
await writeFile(join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ manifest: manifestPath, file_count: files.length,
  payload_sha256: manifest.payload_sha256 })}\n`);
