# Contributing to Meshful

Meshful welcomes focused bug reports and contributions that preserve the
product's deterministic state, privacy, rights, and reproducibility boundaries.

Before proposing a change:

1. use the matching issue form to describe the behavior and intended result;
2. keep learner data, credentials, private course material, provider output,
   and construction-workspace artifacts out of the repository;
3. record provenance and redistribution rights for every proposed example or
   asset; and
4. run the complete verification commands in `README.md`.

## Development workflow

Create a focused branch from current `main`, install the exact application
dependencies, and verify the repository before opening a pull request:

```bash
npm --prefix site ci
npm --prefix site run lint
npm run verify
```

Keep one pull request centered on one reviewable outcome. Explain the user
impact, list the commands and results, and call out any change to data handling,
tool schemas, state transitions, licensing, or public claims. CI repeats the
integrity, lint, test, focused WebMCP, and production-build gates.

## Product-source boundary

The `site/` directory mirrors an exact deployed Website source. A local change
there is not automatically live and must not be described as deployed. The
maintainer promotes product changes through the receipt-bound process in
[`docs/RELEASES.md`](docs/RELEASES.md).

State-changing code should include focused coverage for success, retry,
conflict, validation, and identity-boundary behavior where applicable. Preserve
the rule that the site owns canonical state and scheduling while the agent
grades, tutors, and submits bounded proposals.

## Content and assets

Software contributions are submitted under Apache-2.0. Original documentation
and artwork are submitted under CC BY 4.0. New public example content in
`site/public/study/data/catalog.js` is submitted under CC0 1.0 Universal,
without an attribution requirement. Changes to the versioned academic catalog
in `site/public/study/data/library-runtime/**` are submitted under CC BY 4.0 and
must preserve the exact-release integrity process. Submit only material you
created or have authority to release on those terms. Third-party material must
retain its own license and notice.

Public examples must remain small and explicitly labeled. A passing structural
check does not establish human expert review or learning outcomes. Library
changes require a new manifest-bound release and an explicit review label.

## Review expectations

A maintainer may ask for a narrower change, stronger evidence, provenance
records, or a successor deployment before merging. Participation follows the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), and support and security reports
should use the routes in [`SUPPORT.md`](SUPPORT.md).
