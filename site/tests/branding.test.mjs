import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [layout, page, styles, headerMark, favicon, favicon16, favicon32, appleTouch, socialCard, legacySocialCard] = await Promise.all([
  readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../app/page.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../public/study/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../public/meshful-header-mark.svg', import.meta.url)),
  readFile(new URL('../public/favicon.svg', import.meta.url)),
  readFile(new URL('../public/favicon-16.png', import.meta.url)),
  readFile(new URL('../public/favicon-32.png', import.meta.url)),
  readFile(new URL('../public/apple-touch-icon.png', import.meta.url)),
  readFile(new URL('../public/meshful-social-card-1200x630.png', import.meta.url)),
  readFile(new URL('../public/og.png', import.meta.url)),
]);

const digest = (value) => createHash('sha256').update(value).digest('hex');

test('Meshful uses the approved matched-arcs M without adding a header tagline', () => {
  assert.match(page, /<strong>Meshful<\/strong>/);
  assert.match(page, /aria-label="Meshful home"/);
  assert.match(page, /<span class="brand-mark" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(page, /TODO\(brand\)/);
  assert.match(styles, /mask: url\("\/meshful-header-mark\.svg\?release=v40-learner-graph"\)/);
  assert.match(styles, /\.brand-copy strong \{[\s\S]*?font-size: 20px;/);
  assert.match(styles, /\.brand-mark \{[\s\S]*?width: 42px;[\s\S]*?height: 42px;[\s\S]*?flex: 0 0 42px;/);
  assert.doesNotMatch(page, /TermMesh/);
  assert.doesNotMatch(page, /<small>Connect terms\. Build understanding\.<\/small>/);
});

test('browser identity assets match the owner-approved visual kit', () => {
  assert.equal(digest(headerMark), '131cad4f63e7712cbcfe66db8e48cefed7f20d223e2603cb55f0e565eecde5c8');
  assert.equal(digest(favicon), '31ba7ddf82870914719c747cbea81208afa253fb58eefb09c77b93b48003c846');
  assert.equal(digest(favicon16), '28fa37a4d0d3302c53a9913b053a0a8ef732b89b4c36f8af96d09c562fef8b4e');
  assert.equal(digest(favicon32), '9bc198c5d70edc64a1a40eeb57093221e8fcc4a366cec7272d0b3ec3a82a6fb6');
  assert.equal(digest(appleTouch), '81b2abcf09cdb09e594c5988186816fd64ef9d4d6a6c7f4b7b6e28d99522b15b');
  assert.equal(digest(socialCard), '0e03372a3f9a538d18ac0e5e5e1a06bb84eb85f3900d72d70541a9d93563dd8d');
  assert.equal(digest(legacySocialCard), digest(socialCard));
  const mark = headerMark.toString('utf8');
  assert.equal([...mark.matchAll(/<use href="#arrow"/g)].length, 2);
  assert.equal([...mark.matchAll(/<circle /g)].length, 3);
});

test('document and social metadata consistently use Meshful', () => {
  assert.equal([...layout.matchAll(/title: 'Meshful'/g)].length, 3);
  assert.doesNotMatch(layout, /TermMesh/);
  assert.equal([...layout.matchAll(/Study tools for your AI agent\./g)].length, 3);
  assert.match(layout, /process\.env\.SITE_ORIGIN \?\? 'https:\/\/meshful\.ai'/);
  assert.equal([...layout.matchAll(/versionedAsset\('\/meshful-social-card-1200x630\.png'\)/g)].length, 2);
  assert.match(layout, /const assetRevision = 'v40-learner-graph'/);
  assert.match(layout, /href=\{versionedAsset\('\/favicon-32\.png'\)\} sizes="32x32"/);
  assert.match(layout, /href=\{versionedAsset\('\/favicon-16\.png'\)\} sizes="16x16"/);
  assert.match(layout, /href=\{versionedAsset\('\/apple-touch-icon\.png'\)\} sizes="180x180"/);
  assert.match(layout, /href=\{versionedAsset\('\/study\/styles\.css'\)\}/);
});
