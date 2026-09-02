import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('wrapper selects local guest and durable signed-in entries on the server', async () => {
  const page = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /user\s*\? '\/study\/integration\/account-start\.js'\s*:\s*'\/study\/js\/start\.js'/s);
  assert.match(page, /copied only after explicit confirmation into an empty account/);
  const hosting = JSON.parse(await readFile(new URL('../.openai/hosting.json', import.meta.url), 'utf8'));
  assert.equal(hosting.d1, 'DB');
  assert.equal(hosting.r2, null);
});

test('site metadata matches the admitted social-preview asset', async () => {
  const layout = await readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8');
  const image = await readFile(new URL('../public/og.png', import.meta.url));
  assert.equal(image.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(image.readUInt32BE(16), 1200);
  assert.equal(image.readUInt32BE(20), 630);
  assert.match(layout, /width:\s*1200/);
  assert.match(layout, /height:\s*630/);
  assert.doesNotMatch(layout, /placeholder/i);
});

test('account endpoint stays disabled without every activation input', async () => {
  const { createSiteRequestHandler } = await import('../integration/site-runtime.mjs');
  for (const options of [
    {},
    { database: {} },
    { database: {}, accountActivation: 'enabled' },
    { database: {}, accountActivation: 'enabled', allowedOrigin: 'http://meshful.test' },
  ]) {
    const handler = createSiteRequestHandler(options);
    assert.equal(handler.active, false);
    const response = await handler.handle(new Request('https://meshful.test/api/learner/v2/state'));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'ACCOUNT_SYNC_DISABLED');
  }
});

test('D1 activation is explicit and runtime provenance is request-object bound', async () => {
  const { createSiteRequestHandler } = await import('../integration/site-runtime.mjs');
  const handler = createSiteRequestHandler({
    database: {}, accountActivation: 'enabled', allowedOrigin: 'https://meshful.test',
  });
  assert.equal(handler.active, true);
  const response = await handler.handle(new Request('https://meshful.test/api/learner/v2/state'));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'ACCOUNT_SYNC_DISABLED');
});

test('Sites migration copies are exact and retain the v2 safety triggers', async () => {
  const pairs = [
    ['../drizzle/0001_learner_data.sql', '../../backend/migrations/0001_learner_data.sql'],
    ['../drizzle/0002_fragmented_storage.sql', '../../backend/v2/migrations/0002_fragmented_storage.sql'],
  ];
  for (const [sitePath, sourcePath] of pairs) {
    assert.equal(
      await readFile(new URL(sitePath, import.meta.url), 'utf8'),
      await readFile(new URL(sourcePath, import.meta.url), 'utf8'),
    );
  }
  const v2 = await readFile(new URL('../drizzle/0002_fragmented_storage.sql', import.meta.url), 'utf8');
  assert.equal((v2.match(/CREATE TRIGGER/g) ?? []).length, 23);
  assert.match(v2, /DEFERRABLE INITIALLY DEFERRED/);
});

test('normal development and build commands cannot skip canonical mirror generation', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.predev, 'npm run sync:study');
  assert.equal(pkg.scripts.prebuild, 'npm run sync:study');
  assert.equal(pkg.scripts.pretest, 'npm run sync:study');
  assert.equal(pkg.scripts['sync:check'], 'node scripts/sync-study.mjs --check');
});
