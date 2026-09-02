# Third-party notices

| Component | Version | Included paths | Source | License | Retained license |
|---|---:|---|---|---|---|
| KaTeX | 0.18.4 | `web/vendor/katex/**` | `katex@0.18.4` from the npm registry | MIT | `web/vendor/katex/LICENSE` |

The retained KaTeX README records the source-package SHA-256 and explains the
local filename treatment. Runtime fonts, stylesheet, and module are bundled so
math rendering does not require a CDN.

Accounts and Sites install-time dependencies are resolved by the committed
`accounts/package-lock.json` and `site/package-lock.json`. Those dependencies
retain their package licenses and are not relicensed by Meshful. `node_modules/`
and generated `site/dist/` output are not committed or admitted to the source
manifest. Exact resolutions are recorded in the committed lockfiles, and
production-audit results are recorded in `release/validation.json`. Hosted
packaging must continue to preserve any notices and source links required by
the generated output.
