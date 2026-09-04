# Meshful deletion and privacy v44 handoff

## Authority and boundary

- Candidate branch: `codex/deletion-privacy-slice-v44`
- Predecessor source: `23f73b3e39839a36296e8bd3f254ff79612e7a40`
- Selected-input receipt: `post_v35_successors.deletion_privacy_slice_v44` in `integration/SELECTED_INPUTS.json`
- This is a source-only candidate. It has not been deployed, published, or used to change account-access policy.
- The immutable 72-course Deck Library is read-only catalog authority and is never a deletion target.

## Delivered contract

- Archive and restore remain reversible state changes.
- Permanent deck deletion requires an archived deck, no active session, an exact deck-instance ID, current deck and app revisions, an impact digest, an explicit boolean confirmation, a one-use server token, and an idempotency key.
- A deleted deck is removed from current state, sessions, reviews, activity, relevant receipts, browser presentation state, and old account recovery snapshots. Other current decks and progress remain.
- A same-ID reinstall has a new instance ID. Replaying the old deletion receipt cannot delete it.
- Browser-local `Delete my data` clears only the selected normal or recording workspace plus its graph pins. It verifies deletion and rolls every key back if any removal fails.
- Account `Delete my data` is scoped to the trusted principal. It removes learner state, personal decks, reviews, sessions, saved actions, recovery documents, imports, and writer state from D1; it then clears only that principal's browser namespace.
- Account deletion preserves the immutable Deck Library, the minimal principal and verified sign-in binding needed to reconnect, and one content-free retry receipt. It does not delete the ChatGPT account or agent conversations.
- Deck and account deletion are idempotent and retry-safe across an uncertain response. Destructive receipts are checked before ordinary receipts or stale-revision checks.

## Website Release handoff

1. Consume the candidate commit only after the validation below is still green.
2. Treat `drizzle/0003_meshful_privacy_deletion.sql` and its journal entry as required. Do not activate the new runtime against the previous D1 schema.
3. Run signed-out browser-local checks and signed-in D1 checks, including reload after deletion, account switch, and retry after an interrupted response.
4. Confirm the visible impact copy and success screen on desktop and mobile.
5. Deployment, domain, publication, and public account-access decisions remain with Website Release.

## Backend handoff

- Review the conditional delete guards and internal one-transaction authorization in migration 0003.
- Run a remote D1 smoke before release. Confirm target content is absent after reload, another principal is byte-for-byte unchanged, a failed batch rolls back, and the same request can retry.
- Keep the minimal destructive receipt free of deleted learner content.

## Accounts and Privacy handoff

- Review the retained-data copy: sign-in binding, immutable Library, and one content-free retry receipt remain.
- Verify that current-principal browser cleanup cannot touch another account namespace and that partial browser-storage failure restores every removed key.
- Approve or revise the user-facing privacy wording before public account access is enabled.

## WebMCP handoff

- The 13 public tools are unchanged. Deletion is intentionally available only through the human-confirmed website flow and authenticated deletion endpoints in this candidate.
- Any future WebMCP deletion tool must preserve the two-step preview/confirm contract, opaque one-use token, exact principal and instance binding, and visible human confirmation. Do not expose a single-call destructive tool.

## Validation

- Focused deletion, D1, account-browser, durable-client, release-selection, and UI-source tests: pass.
- Full `node --test --test-reporter=dot tests/*.test.mjs`: pass.
- `npm run build`: pass using the predecessor checkout's lockfile-matching installed dependencies.
- `npm run lint`: pass using the same installed dependencies.
- `git diff --check`: pass.
- Migration SHA-256: `f18026e861bc96ce45ad81827845b276e6a75ca1b9cf412481ccc89b9c026d51`.
- Journal SHA-256: `b5d720c49b033bee6cda8a09cd0ecc8eff889f2414c0c5174ca8bf225668aa18`.
