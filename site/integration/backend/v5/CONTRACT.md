# Durable archive contract

`set_deck_archived` is an authenticated Website command on the existing
`POST /api/learner/v2/commands` endpoint. It is deliberately absent from the
13 WebMCP registrations.

The full command is:

```json
{
  "request_id": "archive-action-1",
  "expected_revision": 7,
  "operation": "set_deck_archived",
  "args": {
    "deck_id": "deck-id",
    "archived": true,
    "expected_revision": 3,
    "client_action_id": "archive-action-1"
  }
}
```

The outer `expected_revision` is the account's durable revision. The inner
`args.expected_revision` is the deck revision. `request_id` must exactly equal
`args.client_action_id`. The authenticated server context supplies ownership;
no owner, user, email, principal or identity field is admitted in the body.

The canonical store remains authoritative for archive behavior. It increments
the deck and application revisions, excludes an archived deck from normal
active listing and scheduling, preserves cards and history, and rejects an
archive while that deck has an active session. The HTTP boundary preserves that
canonical `DECK_IN_ACTIVE_SESSION` rejection as nonretryable status 409 rather
than masking it as a storage failure. Restore uses the same operation with
`archived:false`.

Backend converts the canonical browser receipt to the durable receipt shape:
`{transaction_id,idempotency_key,replayed,committed_at}`. Exact replay checks
the full original command envelope before stale-revision evaluation. A changed
archive flag, deck revision, deck ID, durable revision, action ID or account is
not a replay. Failed canonical validation or an active-session rejection writes
no state and no receipt.

Before clearing a successful Archive draft, the browser binds the response to
the requested deck ID, archive flag, next deck revision, visible effect,
application revision and canonical archive receipt. A mismatched or misrouted
200 fails with `INVALID_SERVER_RESPONSE` and preserves the exact draft for
receipt-safe recovery.

For `set_deck_archived`, the terminal confirmed no-commit set is exactly
`INVALID_TOOL_INPUT`, `REQUEST_ID_MISMATCH`, `DECK_NOT_FOUND`,
`STALE_REVISION` and `DECK_IN_ACTIVE_SESSION`, each with a 4xx response. The
browser clears only that exact matching account-scoped draft before exposing
the rejection, so a corrected Archive or Finish command can proceed.

`STALE_DURABLE_REVISION` first performs an account-scoped receipt lookup. A
fully validated matching Archive receipt becomes replay success. Confirmed
`NOT_FOUND` means the original stale command did not commit, so its matching
draft clears and the original rejection is returned. An unavailable, malformed
or auth/account-changed lookup preserves the draft. Authentication failures,
`ACCOUNT_CHANGED`, `FORBIDDEN`, origin rejection, catalog/capacity errors and
`IDEMPOTENCY_CONFLICT` also remain preserved. If guarded clearing fails, the
draft remains blocking. Network failures, 5xx responses, lost acknowledgements,
storage failures and receipt ambiguity keep the existing recovery behavior.

The browser client persists the original account binding and exact command in
the Accounts-owned exclusive outbox before sending. Lost acknowledgement uses
the existing receipt recovery path. The client exposes `setDeckArchived(args)`
and the generic `command("set_deck_archived", args)` only; it does not implement
archive rules locally.

## Public v3 catalog promotion

The resolver's first constructor is public release
`2026-09-02.public-sanitized.v3`.
`search_library`, Library-scope `get_deck`, and `add_library_deck` resolve
against that current release even when the learner record still names a
retained constructor. Personal reads, grades and Archive remain on the recorded
constructor until a promotion commits.

A successful current-release `add_library_deck` hydrates existing immutable
bases from retained releases, installs the complete current parent-first
closure in one canonical transaction, and commits the current constructor as
the account `catalog_ref` in that same D1 transaction. A failure leaves state,
durable revision and `catalog_ref` unchanged. Exact replay returns the original
receipt and cannot retarget to a later release.

Promotion does not update installed decks. An old same-ID deck or parent with a
different pin still raises `LIBRARY_DEPENDENCY_CONFLICT` and rolls back. After
promotion, old decks continue to hydrate and grade from their full retained
`libraryBase`; review sidecars name both the current account constructor and
the actual reviewed constructor/source pins. Missing or ambiguous retained
bases fail closed. No D1 schema or public WebMCP tool changes are required.
