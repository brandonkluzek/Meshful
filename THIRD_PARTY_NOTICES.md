# Third-party notices

| Component | Version | Included paths | Source | License | Retained license |
|---|---:|---|---|---|---|
| KaTeX | 0.18.4 | `site/public/study/vendor/katex/**` | `katex@0.18.4` from the npm registry | MIT | `site/public/study/vendor/katex/LICENSE` |

The retained KaTeX README records the source-package SHA-256 and explains the
local filename treatment. Runtime fonts, stylesheet, and module are bundled so
math rendering does not require a CDN.

Install-time dependencies are resolved by the committed `site/package-lock.json`.
Those dependencies retain their package licenses and are not relicensed by
Meshful. `node_modules/` and generated `site/dist/` output are not committed.
Hosted packaging must preserve any notices and source links required by the
generated output.
