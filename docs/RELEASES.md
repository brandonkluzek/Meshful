# Release and source-parity process

The public repository serves two related purposes without conflating them:

1. `site/` is an exact snapshot of the deployed application source.
2. Root documentation, licenses, governance, CI, and release tooling make that
   snapshot understandable and independently verifiable.

Repository-level files may improve without changing the live product. A change
under `site/` is not promoted merely because it builds locally.

## Current deployed boundary

The current public product snapshot is v72, deployed as Sites version 72:

- public repository mirror commit: `f211a9d31ddef43cfb74f9392337e043f6d6d242`
- Website source commit: `3c8c19de1eba096f3825b6b4ce4132df3a9504b7`
- Website source tree: `f71eb56045c05f9af822ed0d0f0d4994ba30c870`
- deployment and live-asset receipt: [`release/deployed-v72.json`](../release/deployed-v72.json)

The repository manifest records the SHA-256 and byte length of every admitted
tracked file. Generated output, environment files, databases, logs, private
learner material, provider output, and construction workspaces are excluded.

## Promoting a product successor

1. Select an exact Website source commit and clean tree.
2. Run its provider-free tests, focused WebMCP checks, lint, and production
   build.
3. Deploy that exact source and retain the deployment identifier.
4. Verify the live URL, public access, identity boundary, and selected runtime
   asset hashes.
5. Copy the exact deployed tree into `site/` without incorporating unrelated
   workspace changes.
6. Update the deployed-source receipt and README claims only from observed
   evidence.
7. Rebuild the repository file manifest.
8. Run `npm run verify` from a clean clone and confirm no tracked changes.
9. Review the public diff for credentials, personal paths, learner data,
   unsupported claims, and licensing changes.
10. Fast-forward `main` only after every required receipt agrees.

If any identity, hash, validation, or access result disagrees, stop the
promotion and keep the last verified public commit.

## Contributor changes to `site/`

Pull requests may propose product improvements, but the maintainer must select,
validate, and deploy the accepted Website source before the public mirror can
claim live parity. CI on a pull request proves only the checked-out source. It
does not prove that the change is deployed, publicly reachable, or semantically
correct.

Application dependency updates follow the same path. Dependabot version updates
are therefore limited to GitHub Actions in this repository; npm updates begin in
the Website source and arrive here only with a successor deployment receipt.
