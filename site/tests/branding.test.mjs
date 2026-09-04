import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [layout, page, styles, headerLogo, favicon16, favicon32, appleTouch, socialCard, legacySocialCard] = await Promise.all([
  readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../app/page.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../public/study/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../public/meshful-logo-grid-512.png', import.meta.url)),
  readFile(new URL('../public/favicon-16.png', import.meta.url)),
  readFile(new URL('../public/favicon-32.png', import.meta.url)),
  readFile(new URL('../public/apple-touch-icon.png', import.meta.url)),
  readFile(new URL('../public/meshful-social-card-1200x630.png', import.meta.url)),
  readFile(new URL('../public/og.png', import.meta.url)),
]);

const digest = (value) => createHash('sha256').update(value).digest('hex');

test('Meshful uses the approved five-node graph logo without adding a header tagline', () => {
  assert.match(page, /<strong>Meshful<\/strong>/);
  assert.match(page, /aria-label="Meshful home"/);
  assert.match(page, /<span class="brand-mark" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(page, /TODO\(brand\)/);
  assert.match(styles, /background: url\("\/meshful-logo-grid-512\.png"\) center \/ contain no-repeat/);
  assert.match(styles, /\.brand-copy strong \{[\s\S]*?font-size: 20px;/);
  assert.match(styles, /\.brand-mark \{[\s\S]*?width: 42px;[\s\S]*?height: 42px;[\s\S]*?flex: 0 0 42px;/);
  assert.doesNotMatch(styles, /mask: url\("\/meshful-header-mark\.svg"\)/);
  assert.doesNotMatch(page, /TermMesh/);
  assert.doesNotMatch(page, /<small>Connect terms\. Build understanding\.<\/small>/);
});

test('browser identity assets match the owner-approved visual kit', () => {
  assert.equal(digest(headerLogo), 'acf6847b53399160ff5bddc1d210829fe38daffe93f393688256ef0bd4d571f7');
  assert.equal(digest(favicon16), '0319998321056b74822f337d93afb482f95d542ca6889a78b1fc263fda219ce0');
  assert.equal(digest(favicon32), '554d5e49fe47a5d5655dd703d93de59105f7e24a23299e04bbfa9944fcc15383');
  assert.equal(digest(appleTouch), '1adcaef36e82be43c400a23fcea7a2990b0ad3347c659f6292144910cefc37f2');
  assert.equal(digest(socialCard), '0e03372a3f9a538d18ac0e5e5e1a06bb84eb85f3900d72d70541a9d93563dd8d');
  assert.equal(digest(legacySocialCard), digest(socialCard));
});

test('document and social metadata consistently use Meshful', () => {
  assert.equal([...layout.matchAll(/title: 'Meshful'/g)].length, 3);
  assert.doesNotMatch(layout, /TermMesh/);
  assert.equal([...layout.matchAll(/Study tools for your AI agent\./g)].length, 3);
  assert.match(layout, /process\.env\.SITE_ORIGIN \?\? 'https:\/\/meshful\.ai'/);
  assert.equal([...layout.matchAll(/versionedAsset\('\/meshful-social-card-1200x630\.png'\)/g)].length, 2);
  assert.match(layout, /const assetRevision = 'v72-guest-study-reset'/);
  assert.match(layout, /href=\{versionedAsset\('\/favicon-32\.png'\)\} sizes="32x32"/);
  assert.match(layout, /href=\{versionedAsset\('\/favicon-16\.png'\)\} sizes="16x16"/);
  assert.match(layout, /href=\{versionedAsset\('\/apple-touch-icon\.png'\)\} sizes="180x180"/);
  assert.match(layout, /href=\{versionedAsset\('\/study\/styles\.css'\)\}/);
  assert.doesNotMatch(layout, /versionedAsset\('\/favicon\.svg'\)/);
});
