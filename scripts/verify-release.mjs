import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifestBytes = await readFile(resolve(root, 'release/file-manifest.json'));
const manifest = JSON.parse(manifestBytes);
const expectedManifestHash = (await readFile(resolve(root, 'release/file-manifest.sha256'), 'utf8')).trim().split(/\s+/)[0];
const actualManifestHash = createHash('sha256').update(manifestBytes).digest('hex');
if (actualManifestHash !== expectedManifestHash) throw new Error('File manifest self-hash mismatch');

const excluded = new Set(manifest.excluded_paths);
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean).sort();
const admitted = tracked.filter((path) => !excluded.has(path));
if (admitted.length !== manifest.file_count) throw new Error(`Tracked file count mismatch: ${admitted.length} != ${manifest.file_count}`);

const entries = new Map(manifest.files.map((entry) => [entry.path, entry]));
const secretPatterns = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const privatePrefix = ['/', 'Users', '/'].join('');
const forbiddenPath = /(^|\/)(node_modules|\.next|\.vinext|dist|out|\.wrangler|outputs|work|coverage)(\/|$)|(^|\/)\.env($|\.)|\.(sqlite|sqlite3|db|pem|key|log)$/;
let totalBytes = 0;
for (const path of admitted) {
  const entry = entries.get(path);
  if (!entry) throw new Error(`Tracked path absent from manifest: ${path}`);
  if (forbiddenPath.test(path)) throw new Error(`Forbidden tracked path: ${path}`);
  const absolute = resolve(root, path);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error(`Symlink not admitted: ${path}`);
  if (!info.isFile()) throw new Error(`Non-file tracked entry not admitted: ${path}`);
  const maxBytes = path.startsWith('site/public/study/data/library/')
    ? 32 * 1024 * 1024
    : 10 * 1024 * 1024;
  if (info.size > maxBytes) throw new Error(`File exceeds reviewed size boundary: ${path}`);
  const bytes = await readFile(absolute);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (entry.bytes !== bytes.length || entry.sha256 !== digest) throw new Error(`Manifest mismatch: ${path}`);
  totalBytes += bytes.length;
  if (/\.(md|json|js|mjs|ts|tsx|css|html|svg|txt|cff|yaml|yml)$/.test(path)) {
    const text = bytes.toString('utf8');
    if (text.includes(privatePrefix)) throw new Error(`Private absolute path found: ${path}`);
    for (const pattern of secretPatterns) if (pattern.test(text)) throw new Error(`Credential-like token found: ${path}`);
  }
}
if (totalBytes !== manifest.total_bytes) throw new Error('Manifest byte total mismatch');
if (entries.size !== admitted.length) throw new Error('Manifest contains untracked or duplicate paths');
console.log(JSON.stringify({ ok: true, tracked_files: tracked.length, admitted_files: admitted.length, total_bytes: totalBytes, manifest_sha256: actualManifestHash }));
