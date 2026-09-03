# All-deck graph validation receipt

Run at `2026-09-03T16:03:36Z` against the rebased, isolated, undeployed next-release candidate.

## Gate

```bash
node --check tests/graph-catalog-validation.test.mjs
node --check tests/helpers/graph-catalog-validation-worker.mjs
node --test tests/graph-catalog-validation.test.mjs
```

Result: `1/1` passed in `64,671 ms` test-process time.

- Active public release: `2026-09-03.public-sanitized.v4`
- Unique, active-namespace deck IDs: `72/72`
- Cards preserved: `9,988/9,988`
- Internal prerequisite edges preserved: `16,942/16,942`
- Node collisions: `0` in every deck
- Every route finite and exactly one SVG `M` plus one cubic `C`
- Every route has exactly one simple interior inflection
- Byte-stable geometry verified on Algorithms I, Biology I, Linear Algebra I, and Programming I
- Full diagnostic totals: `2,914` edge crossings and `24,348` edge-card intersections
- Summed worker layout time: `319,972.2 ms`; summed worker diagnostic time: `22,999.4 ms`; six-worker wall time: `64,625.9 ms`

The gate emits one line per deck with nodes, edges, crossings, edge-card intersections, layout time, and diagnostic time. Crossings and edge-card intersections are quality diagnostics, not semantic-integrity failures. The largest diagnostic counts in this run were Programming I (`61` crossings, `881` edge-card intersections), Physiology (`103`, `817`), Immunology (`108`, `786`), Microbiology (`88`, `741`), and Molecular Biology (`78`, `738`).

Timing is a parallel Node test measurement, not a claim about browser interaction latency. The runtime work remains deterministic and is cached by the product view; these numbers identify where future optimizer work should concentrate.

## Installed-deck corroboration

```bash
node --test tests/library-single-course-boundary.test.mjs tests/library-v3-website-flow.test.mjs
```

Result: `44/44` focused graph, personal-deck parity, and Library-to-Graph checks passed in `41,864 ms`. This includes installing each of the 72 reviewed courses alone and proving that its personal graph preserves every active card and every internal prerequisite edge.

## Exact validated inputs

```text
4c61dc7e6ff9701e1eeb21adae59f9fc9ee262cd0df7597fab8da385e222c832  tests/graph-catalog-validation.test.mjs
6d62a3c9aa92a36b7193d641bf5b3f2d1878aa6e6647a302e31a08f7eb39c658  tests/helpers/graph-catalog-validation-worker.mjs
997570f1228ea04eb245f75df042857315ab6c76b3cbc0358384c96f1d3491c3  public/study/js/graph-engine.js
642994cece8a62c6b3992fcfd6d564f04f6beeca6763f8f6a720ddfd4abf91e0  public/study/js/graph-view.js
39cc5a9c108619baecfdab80e122425d9196f74355e9bbdd073df1af89cbe11d  public/study/js/graph-progress-state.js
```

If either runtime hash changes, rerun the gate and replace this receipt before freezing a successor handoff.
