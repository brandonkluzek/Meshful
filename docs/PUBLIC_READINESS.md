# Public repository readiness

This document scopes readiness to the source repository. Deployment, hosted
account activation, demo-video production, and Devpost submission are separate
release gates.

## Established for the repository

- Apache-2.0 covers admitted Meshful software.
- CC0 1.0 Universal covers the generated public example deck content without
  an attribution requirement.
- CC BY 4.0 covers the identified owner-controlled documentation and brand
  assets.
- CC BY 4.0 also covers the exact sanitized academic Deck Library release, with its
  attribution notice and 75-payload SHA-256 manifest retained in `library/`.
- `Copyright 2026 Brandon Kluzek` is recorded in the notice and license map.
- Three public examples contain 18 freshly authored cards and 15 unique HTTPS
  reference URLs. All 15 URLs resolved to the recorded primary sources during
  the 2026-09-02 review.
- The approved Deck Library release contains 72 courses, 9,988 cards, 17,712 prerequisite
  links, and 770 cross-course links. Its metadata records public approval and
  the Website browser-artifact contract.
- The default guest build includes only the approved public-v2 browser artifact
  and a public-only release index. The artifact SHA-256 is
  `a035f44a36a088610d78b8499ebe8e55f014e0d35f77d7238972513e3077f5c1`.
- Private source locators, construction provenance, private-v1 runtime assets,
  build-only tools, learner data, and predecessor corpora are excluded.
- The source manifest, authority hashes, dependency lockfiles, tests, build,
  security policy, and contribution terms are tracked.
- The social preview is an admitted 1200 by 630 owner-controlled asset whose
  metadata matches its actual dimensions.

Run `npm run check` to verify the deterministic repository requirements. Run
the complete clean-clone procedure in `docs/REPRODUCIBILITY.md` before approving
an exact commit for the first push or a visibility change.

## Separate, intentionally unproven claims

The repository does not claim independent semantic review, learner outcomes,
hosted account persistence, public judge access, deployment, video parity, or
Devpost submission. Those omissions do not require private source or placeholder
URLs to be added to the public repository.
