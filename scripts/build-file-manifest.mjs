import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const excluded = new Set(['release/file-manifest.json', 'release/file-manifest.sha256']);
const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean)
  .filter((path) => !excluded.has(path)).sort();
const files = [];
for (const path of paths) {
  const bytes = await readFile(resolve(root, path));
  files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const manifest = { schema_version: 'meshful.file-manifest.v1', algorithm: 'sha256', excluded_paths: [...excluded].sort(), file_count: files.length, total_bytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
const output = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(resolve(root, 'release/file-manifest.json'), output);
const digest = createHash('sha256').update(output).digest('hex');
await writeFile(resolve(root, 'release/file-manifest.sha256'), `${digest}  release/file-manifest.json\n`);
console.log(JSON.stringify({ ok: true, file_count: files.length, total_bytes: manifest.total_bytes, manifest_sha256: digest }));
