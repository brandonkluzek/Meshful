# Changelog

Notable public-repository and product-source changes are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
version numbers follow the package version until tagged releases begin.

## Unreleased

### Added

- GitHub CI, structured issue forms, a pull request template, and code ownership
- Citation, support, conduct, architecture, and release-process documentation
- A visual project header and public-release status in the README

## 0.1.2 - 2026-09-03

### Changed

- Reveal and Skip now record their distinct non-answer semantics atomically in
  both guest and signed-in study sessions
- Account-backed grading preserves the same retry-safe scheduling and receipt
  boundary for answer, reveal, skip, and manual self-grading actions
- The public source mirror now matches the exact deployed Sites v42 tree

## 0.1.1 - 2026-09-03

### Added

- An atomic manual self-grading path for studying without an agent
- Learner-specific progress states and retained review history in course graphs

### Changed

- Deck Library naming and course descriptions are clearer throughout the app
- Account synchronization handles new and empty durable snapshots more safely
- Committed card reveals survive a reload until the learner advances
- Study, archive, graph, and mobile controls have focused usability refinements
- The public source mirror now matches the exact deployed Sites v41 tree

## 0.1.0 - 2026-09-03

### Added

- Public Meshful source repository with Apache-2.0 software licensing
- CC BY 4.0 licensing for owner-controlled documentation, artwork, and the
  versioned academic Deck Library
- CC0 licensing for the three generated example decks
- Exact deployed Sites v39 source under `site/`
- Thirteen page-owned WebMCP tools for deck, study, and progress workflows
- A 72-course Deck Library containing 9,988 cards and 17,712 prerequisite links
- Manifest-bound release verification and deployed-source receipts
