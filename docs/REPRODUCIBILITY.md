# Reproducibility and verification

## Environment

- Node.js 22.13 or newer with `node:sqlite`.
- npm matching the selected Node distribution.
- macOS or Linux shell.
- No provider credential is needed or used.

The browser app and Backend have no package dependencies. Accounts and the
Sites wrapper retain lockfiles.

## Fresh-clone procedure

```bash
git clone <approved-public-url> meshful
cd meshful
git checkout <approved-final-sha>
test -z "$(git status --porcelain=v1)"

npm --prefix accounts ci
npm --prefix site ci
npm run check
npm test
npm run verify:webmcp
npm run build
test -z "$(git status --porcelain=v1)"
```

`npm run check` verifies the tracked allowlist manifest, byte hashes, size and
symlink boundaries, common credential patterns, private absolute paths, source
selection, D1 declaration, exact migration copies, licensing surfaces,
public-example scope, exact Library payload hashes, social-preview dimensions,
the public-only browser artifact/index, and repository governance. `npm test`
exercises the browser, Accounts, Backend
v1/v2, Website integration, and wrapper seams.

The admitted v1 `backend/integration/canonical.test.mjs` file is retained
byte-for-byte as source-authority history, but is not a release gate: two of its
expectations predate the pinned browser runtime's stricter corrupt-state error
surface and current treatment of unresolved cross-deck prerequisites. The
current durable-account path is covered by the v1 Accounts integration, v2 unit
and storage/capacity integrations, browser account-runtime tests, and Sites D1
composition tests.

## What local checks establish

- admitted source parses and selected provider-free tests pass;
- WebMCP schemas and tested transactional behavior remain intact;
- Accounts/Backend integration uses this repository's admitted bytes;
- both D1 migrations and all 23 v2 triggers are retained exactly;
- signed-in account mode cannot silently fall back to local state;
- the generated Sites browser mirror matches canonical source; and
- the wrapper installs and builds from a clean checkout.

## What remains separate

Local checks do not establish hosted migration application, trusted production
ingress, cross-device durability, public judge access, source/live parity,
independent semantic review, semantic grading quality, learner outcomes, video
parity, or Devpost submission. Those gates are listed in
[Hosted acceptance](HOSTED_ACCEPTANCE.md).
