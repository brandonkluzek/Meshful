# Sites D1 CASE-parentheses packaging successor

The first owner-only Sites deployment of the frozen D1 package failed before a
binding or table became visible with `incomplete input: SQLITE_ERROR`. The exact
same package passes Wrangler 4.92.0's local D1 migration engine. Cloudflare's D1
issue 4727 documents the matching remote splitter defect: an unparenthesized
`CASE ... END` inside `CREATE TRIGGER` can be mistaken for the trigger's `END`.

This successor leaves both authored Backend migrations unchanged. During
packaging it directly parenthesizes exactly three CASE expressions inside
`meshful_v2_head_complete_insert` and
`meshful_v2_head_complete_update`. No table, key, trigger condition, error,
scheduler rule, repository transaction or learner behavior changes. All trigger
bodies remain LF-only and use uppercase `BEGIN`, covering the other currently
reported remote D1 splitter constraints.

Run locally:

```sh
env -u NODE_COMPILE_CACHE -u NODE_OPTIONS node backend/d1-sites-case-fix/verify.mjs
env -u NODE_COMPILE_CACHE -u NODE_OPTIONS node --test backend/d1-sites-case-fix/tests/*.test.mjs
```

Website adopts the generated `drizzle/**` tree in a fresh private candidate:

```sh
env -u NODE_COMPILE_CACHE -u NODE_OPTIONS node backend/d1-sites-case-fix/pack-case-fixed.mjs \
  --target /absolute/path/to/fresh/site
```

The command accepts an absent or exact three-file `drizzle/**` tree. It rejects
different bytes, extra files, symlinks and non-regular entries before writing.
Keep activation `closed`. The retained Website receipt proves only that the
failed deployment exposed zero D1 bindings and tables when recorded. Website
must re-query the failed deployment, current owner-only Site, and complete D1
overview immediately before retry. Stop on any binding, selected binding,
table, omitted/truncated field, project mismatch, live-version change or
ambiguous response. These are unapplied migration bytes only while that fresh
preflight remains clean.

After owner-only deployment, attest the new canonical schema hash
`643dd073a167c4520494bbc9290f461a8607f2c6115efbe0303660c23db2aa2e`
with `inspectCaseFixedD1(env.DB)`. The canonical form removes provider storage
comments and normalizes external whitespace while retaining every SQL token,
literal and workaround parenthesis. Success still proves only provisioning and
schema. It does not activate account routes or close trusted-ingress,
cross-device, catalog, capacity or public-release acceptance.

`evidence/WEBSITE_V12_FAILURE_RECEIPT.json` is a byte-exact Website-owned
historical observation, not current provider truth.
`evidence/LOCAL_WRANGLER_4_92_RECEIPT.json` records the exact local-only
11-command plus 33-command Wrangler control; it is not hosted acceptance.

Primary defect evidence:
https://github.com/cloudflare/workers-sdk/issues/4727
