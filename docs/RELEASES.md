# Release and source-parity process

The public repository serves two related purposes without conflating them:

1. `site/` is an exact snapshot of the deployed application source.
2. Root documentation, licenses, governance, CI, and release tooling make that
   snapshot understandable and independently verifiable.

Repository-level files may improve without changing the live product. A change
under `site/` is not promoted merely because it builds locally.

## Current deployed boundary

The current public product snapshot is Sites v41:

- public repository mirror commit: `e0fdc27546aba38a43bf5f0eb04291b6d4e4321f`
- Website source commit: `7e1e443d4a3e92b156c591443b36f3ad35dd325c`
- Website source tree: `37669128d41bf03ba7a1db64ef4d6ba27518d8a6`
- deployment and live-asset receipt: [`release/deployed-v41.json`](../release/deployed-v41.json)

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
