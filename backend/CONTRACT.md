# Learner data/API contract v1

The agent authors decks and grades answers in chat. The canonical store computes
card/session transitions and scheduling. This service owns durable transactions
and learner-data authorization. Accounts verifies callers; Website owns all
wrapper/UI/Sites integration. It reuses the 13 existing WebMCP field schemas;
the additional service byte limits below narrow the admitted payload capacity.

## Trusted principal

`authenticate(request)` is supplied by Accounts and returns this server-created
context, never deserialized from HTTP input:

```js
{
  principalId,
  identity: { provider, issuer, subject },
  transport: "sites-browser", // or the separately gated "remote-mcp"
  scopes: ["learner:read", "learner:write"]
}
```

Sites uses `provider: "sites-chatgpt"`, the exact configured
`issuer: "urn:meshful:sites:<project_id>"`, and the exact verified dispatcher user
ID as subject. The real configured Site namespace is
`urn:meshful:sites:appgprj_6a9334b99f20819195ece80ebe97016b`. Domain names, email,
display name, body/URL user IDs, and ordinary headers never establish ownership.
Remote OAuth identities must already have an exact verified binding; no remote
provisioning, email matching, cross-provider linking, or token verification lives
in this backend.

Accounts calls two **server-only** Backend hooks:

```text
findPrincipalByIdentity({provider, issuer, subject}) -> Promise<{principalId} | null>
provisionPrincipalForVerifiedIdentity(identity) -> Promise<{principalId}>
```

Provisioning is idempotent under races, generates an opaque random principal,
and creates no orphan principals. Accounts may call it only after verified Sites
authentication and explicit server configuration. Neither hook has an HTTP route.
Every service read/write checks scope and rechecks the exact identity binding.
All learner SQL predicates and composite child keys include that principal.

`GET state` returns an opaque `account_binding`. `X-Meshful-Account` must match
the authenticated principal on POST. It is only an account-change assertion:
it never chooses the SQL owner or replaces authentication. Saved requests must
retain their original binding, even after another user signs in.
GET requests that supply this assertion must also match. The client supplies it
for receipt recovery; initial state bootstrap may omit it.

## Data representation

| Table | Durable data and ownership |
| --- | --- |
| `meshful_principals` | Opaque principal and creation time; no email/profile |
| `meshful_identity_bindings` | Exact unique `(provider, issuer, subject)` binding |
| `meshful_learner_state` | One owner-scoped canonical schema1/schema2 JSON snapshot, durable revision, immutable catalog release reference |
| `meshful_request_receipts` | Owner/request ID, SHA-256 input fingerprint, original response, durable revision; no 256-entry eviction |
| `meshful_review_events` | Owner-scoped immutable review, exact answer/feedback/evidence, before/after schedule, card version and source/catalog pins |
| `meshful_import_archives` | Exact original local JSON and SHA-256; globally unique opaque local-source lineage prevents reassignment to another account |

The canonical snapshot retains decks/installations, sessions, all prior review
history, current mastery/scheduling, archived cards, and prerequisite references.
Schema2 remains the existing sparse catalog-overlay format. The snapshot is the
smallest transaction boundary that preserves the present store without splitting
its private queue/scheduler helpers into a competing implementation.

Catalog releases are trusted **original input objects** registered by the host,
identified by version plus SHA-256 of deterministic JSON. Refeeding
`getCatalogSnapshot()` is incorrect: canonical normalization is not an idempotent
round trip. Each learner remains on its stored release; every referenced release
must remain available. Same-version drift or a missing release fails closed.
Canonical overlay version/FNV checks remain in addition to the SHA-256 release
pin. A source or catalog update is not silently adopted.

Cross-deck prerequisite IDs retain their exact qualified references. Existing
semantics treat external prerequisites as unverified metadata; they do not require
installed targets or gate scheduling. Internal prerequisites use the canonical
queue rules. This service does not strengthen or weaken either rule.
Preservation of qualified card references does not qualify every Library graph
input: WebMCP reports required Library external edges still fail the current
shared core. That limitation is retained, not repaired by a second scheduler.

## Routes

Mount only after Website/Accounts establish trusted ingress. All routes below
are under `/api/learner/v1`; no CORS permissions are added, responses are private
and `no-store`, and browser POSTs require a configured exact Origin plus the
account-change assertion. `authenticate` failures use the injected Accounts
`authFailureResponse`, preserving its sanitized 401/403/503 status.

| Method/path | Request and result |
| --- | --- |
| `GET /state` | Account binding, durable revision, catalog reference, parsed snapshot and exact JSON; `null` snapshot for a fresh principal |
| `POST /queries` | `{operation,args}`; the six canonical read operations, with their injected input/output schemas |
| `POST /commands` | `{request_id,expected_revision,operation,args}`; seven canonical mutations plus Website's `add_library_deck` |
| `POST /claims` | `{request_id,expected_revision,source_id,catalog_ref,raw_state_json}`; explicit first claim into an empty durable account |
| `GET /receipts/:request_id` | Original owner-scoped durable response with `receipt.replayed:true`; recovery for an uncertain acknowledgement |
| `GET /reviews?after_revision=0&limit=100` | Paginated immutable **new durable** grades; at most one event per revision |
| `GET /imports/:source_id` | Owner-only exact original JSON, digest, and claim revision |

Success is `{ok:true,data:...}`. Mutation `data` is
`{schema_version:1,durable_revision,catalog_ref,result}`, where `result` matches the
canonical tool output. Installation is the Website-only legacy action: it takes
`client_action_id` and the adapter adds a target-style replay/transaction receipt.
It does not add a fourteenth WebMCP tool. `request_id` must equal the canonical
`idempotency_key` or installation `client_action_id`.

Read operations are `get_learning_overview`, `search_library`, `list_my_decks`,
`get_deck`, `validate_deck`, and `get_study_session`. Mutations are `ingest_deck`,
`update_deck`, `add_cards`, `update_cards`, `start_study_session`, `submit_grade`,
`finish_study_session`, and Website-only `add_library_deck`. No client snapshot
replacement, grading preview/apply, demonstration seeding, or arbitrary SQL route
is exposed.

`submit_grade` retains exactly the existing fields:
`session_id`, `card_id`, `expected_card_revision`, `expected_session_revision`,
`answer_text`, `answer_origin`, `rating`, `rubric_evidence`, `feedback`,
`misconceptions`, `confidence`, `idempotency_key`. There is no `verdict` field or
new grading rule. Card/session stale checks and rubric-ID validation run in the
canonical engine. Exact Unicode, whitespace and line endings are preserved.

## Atomicity, replay, and concurrent edits

1. Authenticate and verify the binding/scope. Validate the closed envelope and
   canonical schema. Look up the owner/request receipt **before** stale checks.
2. Exact replay compares SHA-256 of the full original operation, args, expected
   durable revision, and contract version. It returns the original result with
   only `replayed:true`. Same ID with changed input returns 409.
3. Read the owner's snapshot and expected durable revision. Run the canonical
   operation against an isolated synchronous memory adapter with a server clock.
   This is a proposed transition, not a durable success or visible reveal.
4. One D1 `batch` conditionally inserts the receipt at the expected revision,
   then updates the snapshot and inserts the immutable review/import records.
   Every child statement is guarded by that attempt's unique receipt token.
   Stale admission writes nothing; any statement failure rolls back all of it.
5. Return success only after the awaited batch. Ambiguous acknowledgement is
   resolved by exact receipt lookup/retry, never a new grading action.

The durable revision is distinct from canonical app/card/session revisions.
Imports may begin at any preserved canonical app revision. Per-learner CAS
deliberately serializes all edits, including edits on different decks. A second
device must reload and make a new intentional action after a conflict; it must
not silently rebase/regrade the old answer with a new key.

The client exposes recovery through the same tool and exact arguments. Matching
pending intents retry their saved envelope; concurrent identical callers share
one request and followers receive `replayed:true`. After an acknowledged action
or reload, a definite `IDEMPOTENCY_CONFLICT` can locate the owner's existing
receipt and recover its original expected revision (`durable_revision - 1`).
The client then resends the operation, exact arguments and original account for
the full server fingerprint check. Receipt lookup alone never returns a tool
success. Different input still conflicts. Network errors and stale writes never
use this revision-recovery path or silently become new grades.

Each client belongs to one authentication epoch and its first accepted principal.
Superseded loads and snapshots older than a known durable revision are rejected;
a different principal retires the instance. Website supplies a synchronous outbox
with a fixed account namespace and an exclusive cross-tab lease, valid at every
mutation including delayed cleanup. Match/readback checks preserve a different
saved draft but are **not** atomic cross-tab locking. Ordinary localStorage
read-then-write does not satisfy the lease requirement. Accounts' external epoch
fence remains necessary, including logout followed by the same principal.

The backend uses primary D1 binding reads, not unconstrained read-replica sessions.
Cloudflare documents ordered atomic rollback for D1 batches and the consistency
options for sessions. [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

## Claim and recovery

A local browser snapshot is not authenticated ownership evidence. Claiming is an
explicit action while signed in to the intended account, not automatic email
linking or a replacement guest product. Website retains the original local key,
creates an opaque source lineage ID, and saves a separate backup before sending.
The server accepts only a still-empty revision-zero account, checks the complete
hydrated structure and canonical reader compatibility, and stores the original
bytes alongside the resulting state in the same transaction.

Canonical schema1 is accepted without inventing a new migrator; a later canonical
write compacts it. Schema2 must resolve its exact original catalog. An old
`answer_committed` attempt is reset by the canonical migration inside the proposed
claim; the original answer remains recoverable in the archive. Existing local
history is retained as supplied. Missing old card/source versions are explicitly
unknown. Imported browser receipts lack collision-resistant request proof: their
old keys fail with `LEGACY_REQUEST_REQUIRES_REFRESH` rather than grading again.

On a conflict, corruption, missing catalog, oversized state, failed write, or
changed account, retain local bytes and the pending request. Do not clear,
truncate, overwrite, relabel, or merge histories. Existing durable data continues
to be available through raw state/receipt/import recovery even if its catalog
cannot be hydrated. Restore the pinned release to resume normal operations.
Account switching never reassigns a source lineage or pending outbox.

No delete endpoint, automatic retention period, production backup guarantee,
full bulk account export, or account linking is claimed. Future export/deletion
coverage must include snapshot histories, receipt bodies, immutable review events,
original import archives, identity bindings, pending device drafts and local
backups. Accounts owns that future policy; this slice does not create it.

## Bounds

JSON depth/node budgets, strict input schemas, bounded POST bodies and parameterized
SQL apply before commit. One state/receipt/event/import is limited to 1,000,000
UTF-8 bytes; command/query args to 200,000 bytes; request bodies to 2,000,000 bytes.
Capacity failure returns a non-success without changing prior state. D1's current
maximum row/string/BLOB size is 2,000,000 bytes; this aggregate limit deliberately
leaves room for metadata. Large or long-lived accounts need a reviewed storage
extension before enabling them. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

All-13 operation/result parity is qualified on tested payloads, not the entire
accepted canonical-schema capacity. WebMCP reproduced a locally ingestible,
schema-valid v2 deck with 50 cards and 3,999-character definitions whose arguments
are 205,026 UTF-8 bytes: this service rejects it with `INPUT_TOO_LARGE` and leaves
durable revision zero. Website/WebMCP must explicitly align or disclose the
service limits before release. Do not silently trim content, split an atomic
action, increase caps, or imply that a valid local deck necessarily fits this
bounded service.
