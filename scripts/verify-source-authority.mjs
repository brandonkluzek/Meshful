import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function filesAt(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesAt(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function selection(relativeRoot, { excluded = [] } = {}) {
  const base = resolve(root, relativeRoot);
  const omitted = new Set(excluded);
  const paths = (await filesAt(base))
    .map((path) => relative(base, path).split('\\').join('/'))
    .filter((path) => !omitted.has(path))
    .sort();
  const rows = [];
  let bytes = 0;
  for (const path of paths) {
    const content = await readFile(join(base, path));
    bytes += content.length;
    rows.push(`${digest(content)}  ${path}`);
  }
  return {
    files: paths.length,
    bytes,
    sha256: digest(`${rows.join('\n')}\n`),
  };
}

assert.deepEqual(await selection('backend', { excluded: ['v2/README.md'] }), {
  files: 44,
  bytes: 362586,
  sha256: '7b4720597f71323883f65c3aafdf0627c27698afce166946758e980b8ac5c734',
});
assert.deepEqual(await selection('accounts'), {
  files: 21,
  bytes: 129809,
  sha256: 'b8ea426715fd35cad46d8127cc0d6b1e1c6674efc8e513292d3dfab348591106',
});
assert.deepEqual(await selection('web/integration'), {
  files: 3,
  bytes: 4596,
  sha256: '064254fffefe6f74f8c3887d904c910204efc649ff111088f9b0d3d0a761bfc0',
});

const runtimePins = {
  'web/js/app.js': '907667447ec5f3ca5532a4fc40f72d7f0884b170816d64704c3b20ce4934ed99',
  'web/js/store.js': '8cbde997ee0330f180e1aecd107425c53a7005e5e427dd58c2da9e120ec05dc6',
  'web/js/webmcp.js': '9faa86f447eddf4424b432075129f02ea7d7875eb6b2f1ea78f25181aae440df',
  'web/js/account-runtime.js': '49217272d13ecbb7d755fe02cdbab94f86fbe1b82a08d530529d4e05555990bd',
  'web/js/library-catalog.js': 'fc2458b63e813f53bd81b231084dcc756963a4ed3625fd38aee5d8ceb024ba95',
  'web/js/streak.js': 'ef5337ebb320bc1cd96f292164dd57667189ff04eb7150ff4a926e2938e9ead3',
};
for (const [path, expected] of Object.entries(runtimePins)) {
  assert.equal(digest(await readFile(resolve(root, path))), expected, `Runtime source pin differs: ${path}`);
}

const hosting = JSON.parse(await readFile(resolve(root, 'site/.openai/hosting.json'), 'utf8'));
assert.equal(hosting.d1, 'DB');
assert.equal(hosting.r2, null);

for (const [source, deployment] of [
  ['backend/migrations/0001_learner_data.sql', 'site/drizzle/0001_learner_data.sql'],
  ['backend/v2/migrations/0002_fragmented_storage.sql', 'site/drizzle/0002_fragmented_storage.sql'],
]) {
  assert.equal(
    await readFile(resolve(root, deployment), 'utf8'),
    await readFile(resolve(root, source), 'utf8'),
    `Sites migration differs: ${deployment}`,
  );
}
const migration = await readFile(resolve(root, 'site/drizzle/0002_fragmented_storage.sql'), 'utf8');
assert.equal((migration.match(/CREATE TRIGGER/g) ?? []).length, 23);
assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/);

const libraryManifestBytes = await readFile(resolve(root, 'library/MANIFEST.json'));
const libraryMetadataBytes = await readFile(resolve(root, 'library/public-metadata.json'));
const libraryManifest = JSON.parse(libraryManifestBytes);
const libraryMetadata = JSON.parse(libraryMetadataBytes);
assert.equal(digest(libraryManifestBytes), '3b65e9b04c82f9d6523cad8488203156ae4b5e56ef85480f4eb46c16b5529e85');
assert.equal(digest(libraryMetadataBytes), '51b8ddea29042162702a4f721302435188d5e2bb6281f3ae57f6a4ab7e9ddffe');
assert.equal(libraryManifest.files.length, 75);
assert.equal(libraryMetadata.counts.decks, 72);
assert.equal(libraryMetadata.counts.cards, 9988);
assert.equal(libraryMetadata.public_release_approved, true);
assert.equal(libraryMetadata.browser_catalog_artifact_contract, 'meshful-library-runtime-artifact.v1');
const browserIndex = JSON.parse(await readFile(resolve(root, 'web/data/library-releases.json'), 'utf8'));
const browserArtifact = await readFile(resolve(root,
  'web/data/library/2026-09-02.public-sanitized-72.v2/a035f44a36a088610d78b8499ebe8e55f014e0d35f77d7238972513e3077f5c1.json'));
assert.equal(browserIndex.audience, 'public');
assert.equal(browserIndex.publicReleaseApproved, true);
assert.equal(browserIndex.releases.length, 1);
assert.equal(browserIndex.releases[0].version, '2026-09-02.public-sanitized-72.v2');
assert.equal(digest(browserArtifact), 'a035f44a36a088610d78b8499ebe8e55f014e0d35f77d7238972513e3077f5c1');

for (const forbidden of [
  'backend/v2/test-support/pinned-library.mjs',
  'backend/v2/integration/library-capacity.test.mjs',
  'backend/v2/scripts/verify-delivery.mjs',
]) {
  await assert.rejects(stat(resolve(root, forbidden)), { code: 'ENOENT' });
}

console.log(JSON.stringify({
  ok: true,
  backend_selection_sha256: '7b4720597f71323883f65c3aafdf0627c27698afce166946758e980b8ac5c734',
  accounts_selection_sha256: 'b8ea426715fd35cad46d8127cc0d6b1e1c6674efc8e513292d3dfab348591106',
  website_selection_sha256: '064254fffefe6f74f8c3887d904c910204efc649ff111088f9b0d3d0a761bfc0',
  academic_library_manifest_sha256: digest(libraryManifestBytes),
  academic_library_courses: libraryMetadata.counts.decks,
  browser_library_artifact_sha256: digest(browserArtifact),
  d1_binding: hosting.d1,
  v2_triggers: 23,
}));
