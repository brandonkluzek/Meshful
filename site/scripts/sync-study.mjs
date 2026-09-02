import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(siteRoot, '..');
const target = join(siteRoot, 'public', 'study');
const check = process.argv.includes('--check');
const sources = [
  ['web/data', 'data'],
  ['web/js', 'js'],
  ['web/vendor', 'vendor'],
  ['web/styles.css', 'styles.css'],
  ['web/integration/account-entry.js', 'integration/account-entry.js'],
  ['site/integration/account-start.js', 'integration/account-start.js'],
  ['site/integration/catalog-release.mjs', 'integration/catalog-release.mjs'],
  ['backend/src', 'backend/src'],
  ['backend/v2/src', 'backend/v2/src'],
  ['accounts/browser-state.mjs', 'accounts/browser-state.mjs'],
  ['accounts/browser-storage-records.mjs', 'accounts/browser-storage-records.mjs'],
  ['accounts/browser-storage.mjs', 'accounts/browser-storage.mjs'],
];

async function filesAt(base, prefix = '') {
  const info = await stat(base);
  if (info.isFile()) return [[prefix, base]];
  const output = [];
  for (const entry of (await readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Symlink not admitted: ${join(base, entry.name)}`);
    if (!entry.isFile() && !entry.isDirectory()) throw new Error(`Unsupported source entry: ${join(base, entry.name)}`);
    output.push(...await filesAt(join(base, entry.name), join(prefix, entry.name)));
  }
  return output;
}

const expected = [];
for (const [sourcePath, targetPath] of sources) {
  const absolute = join(root, sourcePath);
  for (const [nested, source] of await filesAt(absolute, targetPath)) expected.push([nested.split(sep).join('/'), source]);
}

if (!check) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const [path, source] of expected) {
    const destination = join(target, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { force: false, errorOnExist: true });
  }
}

const actual = await filesAt(target);
const actualMap = new Map(actual.map(([path, file]) => [path.split(sep).join('/'), file]));
if (actualMap.size !== expected.length) throw new Error(`Study mirror file count differs: ${actualMap.size} != ${expected.length}`);
for (const [path, source] of expected) {
  const destination = actualMap.get(path);
  if (!destination) throw new Error(`Missing study mirror path: ${path}`);
  const [left, right] = await Promise.all([readFile(source), readFile(destination)]);
  if (!left.equals(right)) throw new Error(`Stale study mirror path: ${path}`);
}

const digest = createHash('sha256');
for (const [path, source] of expected) {
  digest.update(path); digest.update('\0'); digest.update(await readFile(source)); digest.update('\0');
}
console.log(JSON.stringify({ ok: true, mode: check ? 'check' : 'write', files: expected.length, digest: `sha256:${digest.digest('hex')}` }));
