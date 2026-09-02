# Meshful learner persistence — first delivery

This isolated service persists the existing learner state in D1-compatible SQL.
It reuses the canonical definition-card, prerequisite, grade, and scheduler code;
it does not implement sign-in, semantic grading, a new scheduler, or a second
product experience. Only `backend/**` is part of this delivery.

The runtime uses prepared D1 queries and one atomic batch per write. Provider-free
tests run the same repository against a real local SQLite file. A synthetic
canonical grade survives reload, replays once, rejects stale concurrent writes,
and remains inaccessible to a second learner. These are local receipts, not
hosted or cross-device acceptance.

**Deployment boundary:** no Sites calls, credentials, resources, shared runtime
edits, commits, or deployments were made. Accounts and Website have not established
the production trusted-ingress condition. Keep account endpoints unwired/default
denied; header presence, Host, and a configuration flag are not substitutes.

- [Data and API contract](CONTRACT.md)
- [Exact Website/WebMCP integration and hosted test handoff](HANDOFF.md)
- [Current scope and validation](STATUS.md)
- [Delivery file manifest](FILE_MANIFEST.md)

Run with Node 22.13 or newer; no package installation is needed for these tests:

```sh
cd backend
npm test
npm run check
MESHFUL_CANONICAL_ROOT=/path/to/authorized/competition-checkout npm run test:canonical
MESHFUL_CANONICAL_ROOT=/path/to/authorized/competition-checkout \
  MESHFUL_ACCOUNTS_ROOT=/path/to/authorized/accounts-worktree npm run test:accounts
```

The integration commands deliberately require external, authorized source roots.
They import those modules read-only and print source digests; they neither copy
private history nor silently skip when the source is missing. Fixtures contain
original synthetic definitions and invented identities only.

This first slice caps one learner snapshot, receipt, event, and original import
at 1,000,000 UTF-8 bytes each; commands at 200,000 bytes. Oversized data is rejected
before a commit, with recovery copies preserved. It is not an unbounded history
platform, a data-deletion implementation, or a timed-retention promise.
The byte caps can reject otherwise schema-valid local tool inputs. All-13-tool
parity covers tested payloads, not full schema capacity; release limit alignment
and the existing required Library external-edge limitation remain owner gates.
