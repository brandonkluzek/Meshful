import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { CATALOG } from '../web/data/catalog.js';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(resolve(root, path), 'utf8');
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};

const [license, licenseMap, contentLicense, deckDedication, notice, readme, contributing,
  security, publicReadiness, sourceAuthorityText, hostingText, socialImage,
  libraryManifestText, libraryMetadataText, libraryNotice, browserIndexText,
  browserArtifact,
] = await Promise.all([
  read('LICENSE'),
  read('LICENSES/README.md'),
  read('LICENSES/CC-BY-4.0.md'),
  read('LICENSES/CC0-1.0.md'),
  read('NOTICE'),
  read('README.md'),
  read('CONTRIBUTING.md'),
  read('SECURITY.md'),
  read('docs/PUBLIC_READINESS.md'),
  read('release/source-authority.json'),
  read('site/.openai/hosting.json'),
  readFile(resolve(root, 'site/public/og.png')),
  read('library/MANIFEST.json'),
  read('library/public-metadata.json'),
  read('library/CONTENT-LICENSE-NOTICE.md'),
  read('web/data/library-releases.json'),
  readFile(resolve(root, 'web/data/library/2026-09-02.public-sanitized-72.v2/a035f44a36a088610d78b8499ebe8e55f014e0d35f77d7238972513e3077f5c1.json')),
]);

requireValue(license.includes('Apache License') && license.includes('Version 2.0'),
  'Root Apache-2.0 license is missing or unrecognized');
for (const text of [licenseMap, contentLicense, notice]) {
  requireValue(text.includes('Copyright 2026 Brandon Kluzek'),
    'Copyright notice is missing from a licensing surface');
}
requireValue(contentLicense.includes('creativecommons.org/licenses/by/4.0/legalcode'),
  'CC BY 4.0 legal-code link is missing');
requireValue(deckDedication.includes('CC0 1.0 Universal') &&
  deckDedication.includes('creativecommons.org/publicdomain/zero/1.0/legalcode') &&
  /Reuse\s+does not require attribution/.test(deckDedication),
  'CC0 deck-content dedication is incomplete');
requireValue(licenseMap.includes('web/data/catalog.js') && licenseMap.includes('CC0 1.0 Universal'),
  'License map does not assign generated deck content to CC0');
requireValue(licenseMap.includes('library/**') && licenseMap.includes('CC BY 4.0'),
  'License map does not assign the academic Library to CC BY 4.0');
requireValue(libraryNotice.includes('CC BY 4.0') && libraryNotice.includes('Brandon'),
  'Academic Library content notice is incomplete');
for (const [name, text] of [['README', readme], ['NOTICE', notice]]) {
  requireValue(text.includes('Apache') && text.includes('CC BY 4.0') &&
    text.includes('CC0 1.0 Universal'),
  `${name} does not state the software, documentation/art, and deck-content split`);
}
for (const heading of ['## Run locally', '## WebMCP implementation map', '## Challenge delta']) {
  requireValue(readme.includes(heading), `README section is missing: ${heading}`);
}
requireValue(readme.includes('https://github.com/brandonkluzek/Meshful'),
  'Canonical repository URL is missing');
requireValue(!readme.includes('(private during final review)'),
  'README contains visibility-specific text that becomes stale when public');
requireValue(contributing.includes('Apache-2.0') && contributing.includes('CC BY 4.0') &&
  contributing.includes('CC0 1.0 Universal'),
  'Contribution licensing boundary is incomplete');
requireValue(security.includes('/security/advisories/new'),
  'Private vulnerability-reporting path is missing');
requireValue(publicReadiness.includes('repository'),
  'Repository-scoped public-readiness document is missing');

const sourceAuthority = JSON.parse(sourceAuthorityText);
requireValue(sourceAuthority.included_public_library?.courses === 72 &&
  sourceAuthority.included_public_library?.cards === 9988,
  'Public academic Library receipt is missing or drifted');
const hosting = JSON.parse(hostingText);
requireValue(hosting.d1 === 'DB' && hosting.r2 === null,
  'Sites storage declaration is not the reviewed DB-only shape');

const cardCount = CATALOG.reduce((total, deck) => total + deck.cards.length, 0);
const sourceRefs = new Set();
requireValue(CATALOG.length === 3 && cardCount === 18,
  'Public example count drifted from the approved scope');
for (const deck of CATALOG) {
  requireValue(deck.provenance === 'owner_commissioned_public_example' &&
    deck.contentStatus === 'original_public_example' &&
    deck.licenseStatus === 'cc0-1.0' &&
    deck.reviewStatus === 'not_independently_reviewed',
  `Public example metadata is incomplete: ${deck.id}`);
  for (const card of deck.cards) {
    requireValue(card.sourceRefs.length > 0, `Card has no source reference: ${card.id}`);
    for (const ref of card.sourceRefs) {
      const url = new URL(ref);
      requireValue(url.protocol === 'https:', `Card source is not HTTPS: ${card.id}`);
      sourceRefs.add(url.href);
    }
  }
}
requireValue(sourceRefs.size === 15, 'Public example source-reference count drifted');

const libraryManifest = JSON.parse(libraryManifestText);
const libraryMetadata = JSON.parse(libraryMetadataText);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
requireValue(sha256(libraryManifestText) === '3b65e9b04c82f9d6523cad8488203156ae4b5e56ef85480f4eb46c16b5529e85',
  'Academic Library manifest digest drifted');
requireValue(sha256(libraryMetadataText) === '51b8ddea29042162702a4f721302435188d5e2bb6281f3ae57f6a4ab7e9ddffe',
  'Academic Library metadata digest drifted');
requireValue(libraryManifest.files.length === 75 && libraryManifest.counts.decks === 72 &&
  libraryManifest.counts.cards === 9988 && libraryManifest.counts.prerequisite_edges === 17712 &&
  libraryManifest.counts.external_prerequisite_edges === 770,
  'Academic Library manifest counts drifted');
requireValue(libraryMetadata.public_release_approved === true &&
  libraryMetadata.current_runtime_compatible === true &&
  libraryMetadata.browser_catalog_artifact_contract === 'meshful-library-runtime-artifact.v1',
  'Academic Library public/runtime approval metadata is incomplete');
for (const entry of libraryManifest.files) {
  const bytes = await readFile(resolve(root, entry.target));
  requireValue(bytes.length === entry.bytes && `sha256:${sha256(bytes)}` === entry.sha256,
    `Academic Library payload differs: ${entry.target}`);
}
const browserIndex = JSON.parse(browserIndexText);
const browserCatalog = JSON.parse(browserArtifact);
requireValue(browserIndex.audience === 'public' && browserIndex.publicReleaseApproved === true &&
  browserIndex.active === libraryMetadata.catalog_release_version && browserIndex.releases.length === 1,
  'Browser Library index is not the public-only approved release');
requireValue(!browserIndexText.includes('2026-08-30.reviewed-72.v1') && !browserIndexText.includes('"private"'),
  'Browser Library index retains a private release');
requireValue(browserIndex.releases[0].sha256 === 'a035f44a36a088610d78b8499ebe8e55f014e0d35f77d7238972513e3077f5c1' &&
  browserIndex.releases[0].bytes === 12033408 &&
  sha256(browserArtifact) === browserIndex.releases[0].sha256,
  'Browser Library artifact pin differs');
requireValue(browserCatalog.kind === 'meshful-library-runtime-artifact.v1' &&
  browserCatalog.catalog_ref.digest === libraryMetadata.catalog_ref.digest &&
  browserCatalog.prepared.catalog.length === 72 &&
  browserCatalog.prepared.catalog.reduce((sum, deck) => sum + deck.cards.length, 0) === 9988,
  'Browser Library artifact content differs');
requireValue(socialImage.subarray(1, 4).toString('ascii') === 'PNG' &&
  socialImage.readUInt32BE(16) === 1200 && socialImage.readUInt32BE(20) === 630,
  'Social-preview asset is not the reviewed 1200x630 PNG');

console.log(JSON.stringify({
  ok: true,
  public_examples: CATALOG.length,
  public_cards: cardCount,
  academic_library_courses: libraryManifest.counts.decks,
  academic_library_cards: libraryManifest.counts.cards,
  academic_library_manifest_sha256: sha256(libraryManifestText),
  browser_library_artifact_sha256: sha256(browserArtifact),
  unique_https_source_refs: sourceRefs.size,
  social_preview: '1200x630',
}));
