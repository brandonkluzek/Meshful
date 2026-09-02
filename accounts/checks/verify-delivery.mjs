#!/usr/bin/env node
// Read-only byte/manifest check; not a signature or independent provenance proof.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifestPath = 'docs/accounts-privacy/FILE_MANIFEST.json';
const excluded = new Set(['accounts/node_modules', 'accounts/.npm-cache', manifestPath]);

async function listFiles(relative) {
  if (excluded.has(relative)) return [];
  const info = await lstat(join(root, relative));
  assert.ok(!info.isSymbolicLink(), `Delivery symlink is not allowed: ${relative}`);
  if (info.isFile()) return [relative];
  assert.ok(info.isDirectory(), `Unexpected delivery object: ${relative}`);
  const children = await readdir(join(root, relative));
  return (await Promise.all(children.map((name) => listFiles(`${relative}/${name}`)))).flat();
}

try {
  const manifestInfo = await lstat(join(root, manifestPath));
  assert.ok(manifestInfo.isFile() && !manifestInfo.isSymbolicLink(), 'Manifest must be a regular file.');
  const manifest = JSON.parse(await readFile(join(root, manifestPath), 'utf8'));
  assert.equal(manifest.schema_version, 1);
  assert.ok(Array.isArray(manifest.files));
  const declared = manifest.files.map(({ path, sha256 }) => {
    assert.ok(typeof path === 'string' &&
      /^(accounts|docs\/accounts-privacy)\/[A-Za-z0-9_./-]+$/.test(path) &&
      !path.split('/').some((part) => part === '.' || part === '..' || part === '') &&
      !excluded.has(path), 'Unsafe or excluded manifest path.');
    assert.match(sha256, /^[0-9a-f]{64}$/);
    return path;
  });
  assert.equal(new Set(declared).size, declared.length, 'Manifest paths must be unique.');
  const actual = [...await listFiles('accounts'), ...await listFiles('docs/accounts-privacy')];
  assert.deepEqual(actual.sort(), [...declared].sort(), 'All-and-only delivery file list differs.');
  for (const row of manifest.files) {
    const bytes = await readFile(join(root, row.path));
    assert.equal(bytes.length, row.bytes, `Size mismatch: ${row.path}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256,
      `Digest mismatch: ${row.path}`);
  }
  console.log(JSON.stringify({
    ok: true, checked_files: manifest.files.length, algorithm: 'sha256',
    manifest_self_digest: false,
    boundary: 'Byte equality only; excludes installed dependencies/cache and manifest self-hash.',
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Delivery verification failed.');
  process.exitCode = 1;
}
