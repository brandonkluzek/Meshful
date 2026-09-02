# Meshful Academic Library

This directory contains the course content behind Meshful's definition-recall
Library. It includes 72 college-level courses across Mathematics, Statistics,
Physics, Economics, Chemistry, Biology, and Computer Science and Software.

The release contains 9,988 concept cards and 17,712 required prerequisite
links, including 770 links between courses. Course installation follows those
dependencies; studying a prerequisite course does not automatically mark it as
mastered.

## Files

- `public-metadata.json` contains the browse taxonomy, display ordering,
  descriptions, counts, sample terms, and dependency closures.
- `content/decks/*.json` contains the course cards and same-course graph edges.
- Cross-course prerequisites remain on each card in `prerequisite_ids`; they
  are not removed from source decks to make the files standalone.

Canonical deck, card, and criterion identities are stable release data. Do not
rename identifiers when changing titles or display metadata.

The content was AI-authored and received a full-card AI quality review followed
by second-reader repairs. It has not been certified by human subject-matter
experts and should not be presented as professional, clinical, or legal advice.

See `CONTENT-LICENSE-NOTICE.md` for the proposed CC BY 4.0 release terms. The
Website software uses its separate repository-level software license.

## Using the Library data

This repository is the inspectable curriculum package, not a standalone copy
of the Meshful Website.

1. Read `public-metadata.json` for shelf order, catalog identity, summaries,
   dependency closures, and file-independent browse data.
2. Load only the required files under `content/decks/`. A card's
   `prerequisite_ids` may refer to a canonical card in another deck, so a
   consumer must resolve the full required deck closure before installation.
3. Preserve every deck, card, and criterion ID exactly. Titles are display
   metadata and must never be used as identities.
4. Treat every prerequisite as required and directed from prerequisite to
   dependent. Installing a prerequisite does not mark it learned.
5. Install a requested deck and its closure atomically. Missing or conflicting
   dependency versions must fail without partial learner state.

`MANIFEST.json` binds the exact 75 payload files by byte length and SHA-256.
Before using or redistributing a checkout, verify each listed target path
against that record. The manifest intentionally does not hash itself.

The release is data-only and needs no dependency installation or build step.
All files are UTF-8 JSON or Markdown. A Website integration must additionally
pin the catalog digest and dependency-graph digest in `public-metadata.json`
and repeat the complete browse, install, study, graph, and reload acceptance
for its exact deployed build.
