# Release and source-parity process

The public repository serves two related purposes without conflating them:

1. `site/` is an exact snapshot of the deployed application source.
2. Root documentation, licenses, governance, CI, and release tooling make that
   snapshot understandable and independently verifiable.

Repository-level files may improve without changing the live product. A change
under `site/` is not promoted merely because it builds locally.

## Current deployed boundary

The current public product snapshot is Sites v42:

- public repository mirror commit: `985a40d71565d2a73a1e3255449ae295af0e8c44`
- Website source commit: `dd578874933241eb8d679f10e3d5726c2ad6b855`
- Website source tree: `c6bddcda6f3224b9c76163d0f1b8f9367b68e934`
- deployment and live-asset receipt: [`release/deployed-v42.json`](../release/deployed-v42.json)

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
