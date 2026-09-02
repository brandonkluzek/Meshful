# Capacity successor contract

This supplements the unchanged [first contract](../CONTRACT.md). The agent
still authors and grades; canonical `createStudyStore` owns card definitions,
prerequisites, session state, scheduling and exact history. The backend never
applies a second scheduler, partial grade, alternative verdict or local write
while a durable command is pending.

## Trusted caller and ownership

The server-only Accounts envelope remains exactly:

```js
{ principalId, identity: { provider, issuer, subject }, transport, scopes }
```

Every service query/mutation checks the required `learner:read` or
`learner:write` scope and resolves the exact identity binding again. Every data
query, including fragments, receipts, reviews, archives and recovery pages,
filters by that authenticated principal. The binding/provisioning hooks are
unchanged; there are no new identity tables or account-linking methods.

Sites uses provider `sites-chatgpt`, issuer
`urn:meshful:sites:appgprj_6a9334b99f20819195ece80ebe97016b`, exact verified
subject and transport `sites-browser`. Neither an email, a client owner ID,
Host nor header presence proves that identity. `X-Meshful-Account` is a
compare-only guard required on POST and checked when asserted on GET. It never
selects the data owner. An old A request authenticated as A may finish after
local logout; its response must never become B's view or B's recovery draft.

Accounts' sanitizer is injected as `authenticationFailureResponse` and used
only for exceptions from the trusted `authenticate(request)` boundary. Storage
or canonical exceptions cannot impersonate an auth error via arbitrary status
or message fields. Do not log raw requests, definitions, answers, feedback or
receipt bodies.

## One canonical transition and one durable commit

For a new command the service verifies the strong fingerprint and expected
durable revision, loads the exact owner state, executes the canonical method
against memory storage, and stages its exact output. No result is exposed as
committed until one awaited `D1Database.batch()` succeeds. Staging has no
database effects.

The batch conditionally admits a receipt at `expected_revision + 1`, inserts
all required fragments/manifests/review or claim metadata, then advances the
head. Every write is guarded by a fresh admission token. Composite foreign
keys and final-head completeness triggers reject missing parts. Failure rolls
back receipt, state, all fourteen Library installations and any review/archive
together. No multi-request upload or partial command is used.

The fingerprint contracts remain `meshful-command-v1` and
`meshful-local-claim-v1`, including the original expected revision and entire
input. Identical replay returns the original result with `receipt.replayed`
true; different input under the same request ID is a conflict. CAS rejects
concurrent stale writers without committing their fragments. Card/session
revisions and prerequisite failures still come from the shared core.

The v2 browser wrapper retains the frozen v1 retry/outbox implementation. It
adds only compact-state decoding, opaque-key URL transport and deterministic
Unicode admission. The same pending intent retries through the same tool;
acknowledged intent recovery uses the exact receipt and original envelope,
including after reload. Followers of one in-flight call receive replayed
results so only the leader may cause a visible effect. Changed args or original
account binding never become an equivalent retry.

## Storage representation

| Table | Data and identity |
| --- | --- |
| `meshful_v2_objects` | Immutable UTF-8 fragment text, SHA-256 and byte count; key is `(principal_id,digest)` |
| `meshful_v2_documents` | Immutable exact-document SHA, size, kind and revision |
| `meshful_v2_parts` | Ordered owner/document-to-object references, byte counts and ordinals |
| `meshful_v2_heads` | Current canonical state document, durable revision and constructor catalog pin |
| `meshful_v2_receipts` | Full-envelope fingerprint, request identity and exact response document |
| `meshful_v2_review_events` | New durable grade sidecar linked to its immutable review document |
| `meshful_v2_import_archives` | Exact original local JSON document and globally exclusive source claim |

The codec preserves exact text, whitespace, escape spelling and Unicode. It
has no knowledge of learner fields. Content-defined boundaries range from
8 KiB to 64 KiB, except a final short part and a boundary shortened by up to
three bytes to keep UTF-8 intact. SHA-256 verifies every assembled document
and each recovery page's fragments. A rolling marker chooses boundaries; it
is not an integrity hash.

Known fragments from the same owner and expected revision may be referenced
without resending their bodies. Content is never deduplicated across owners.
All prior documents/fragments remain immutable. This is not constant-size
append storage: exact snapshots and receipts still grow, and their changed
fragments are retained. There is no garbage collection, purge, timed retention
or unlimited database capacity claim.

## HTTP delta

All endpoints are under `/api/learner/v2`; successful responses remain
`{ok:true,data:...}` and failures remain sanitized `{ok:false,error:...}`.

| Method/path | Change or retained meaning |
| --- | --- |
| `GET /state` | `{schema_version:2,snapshot_encoding:'canonical-json.v1',account_binding,durable_revision,catalog_ref,state_json}`; no duplicate parsed `state` on the wire |
| `POST /commands` | Same `{request_id,expected_revision,operation,args}`; same 13-tool writes plus Website-only `add_library_deck` |
| `POST /queries` | Same `{operation,args}` and six canonical read methods |
| `POST /claims` | Same explicit `{request_id,expected_revision,source_id,catalog_ref,raw_state_json}`; no automatic merge/import |
| `GET /receipts?request_id=...` | Exact opaque request key; avoids URL normalization of `.`/`..` |
| `GET /imports?source_id=...` | Original local archive by opaque source key |
| `GET /reviews?after_revision=...&limit=...` | Exact new durable sidecars; page can be shorter than requested; advance by `next_after_revision` |
| `GET /recovery` | Original account, head/document SHA/size/part count, catalog ref and capacity; no canonical hydration |
| `GET /documents/:id?after_part=-1&limit=16` | Immutable owner-pinned pages of at most 16 parts; returns `nextAfterPart` and `done` |

The client reconstructs `state` from `state_json` in the browser, retaining the
original v1 client return shape for Website. Fresh revision zero may have null
state/catalog. It does not hydrate a second local mutation store or render UI.
Legacy simple receipt/import paths remain available; new callers use the query
form with `encodeURIComponent`. Request/source IDs must be well-formed Unicode
of at most 128 UTF-16 units. NUL and valid surrogate pairs remain valid; lone
surrogate identities reject before outbox creation or SQL. Learner text with
JSON-escaped lone surrogates remains exact.

One handler request may be active per module/isolate, through response encoding.
Excess work receives retryable `SERVICE_BUSY` before its body is read; callers
retain the original intent. This is a memory-admission guard, not global
serialization or a throughput promise. Multiple isolates still use database
CAS. Byte/node/depth limits apply before body/state JSON allocation where
possible; see [CAPACITY_RECEIPT.md](CAPACITY_RECEIPT.md). Over-capacity commands
fail before durable writes and retain their original outbox payload.

## Pins, claims and migration

The shared `prepareLibraryCatalog(feed)` must produce the genuine frozen
constructor object in the same ESM module instance as `createStudyStore`.
Retain that reference for engine lifetime; never clone, deserialize or replace
it with a marker-bearing lookalike. The backend hashes the thin constructor
input separately from the original catalog SHA and dependency-graph SHA.
Individual installation payload/artifact/version pins and normalized digests
remain distinct and unchanged. Missing exact catalog/base content is a
recoverable conflict, never permission to use the latest catalog silently.

Canonical `addLibraryDeck` installs the complete pinned parent-first closure
in one write and returns its additive installation receipt with actual personal
IDs. Canonical dotted/colon Library identities stay exact. Targeted edits use
the shared core's supported methods; a lean-v2 full replacement that cannot
represent those IDs fails without mutation.

Apply authored `0002` after unchanged `0001`. Until a principal's first v2
commit, reads use its v1 row and old receipts. First takeover atomically checks
that old revision and adds the v2 head; original v1 rows remain untouched.
Subsequent old-server writes are blocked by triggers. Receipts, sidecars and
exclusive local-source claims cannot be shadowed across the two formats.
Disabling v2 later does not make the old writer safe: preserve both formats and
restore a forward-compatible reader/writer. Do not delete the head or reset a
revision to roll back software.

Local schema1/2 claims remain explicit and only target an empty durable account.
Preserve the source browser key and the exact raw archive before claiming. No
claim merges accounts, deduplicates by email or relabels a queued payload. A
lost claim acknowledgement retries the same source/request/account envelope.
Historical reviews retain supplied provenance; missing old card versions or
source evidence are not reconstructed as newly verified facts.

For a missing catalog or a state exceeding the current materialization budget,
read `/recovery` first. A `storageVersion:2` head has an immutable document ID:
hold it, fetch parts in order and verify each part and the complete document
SHA/length before reconstructing JSON. A newer head does not change those
pages. Before the first takeover, `storageVersion:1` instead returns its bounded
legacy `stateJson` inline, with catalog/revision and null document fields;
preserve those exact bytes and metadata, without requesting nonexistent pages.
Missing/corrupt v2 data fails closed without falling back to the v1 shadow.
This is a state/document
recovery surface, not a complete account export or deletion API. Eventual
account export/delete must cover old and new state, every snapshot/part,
receipt body, card/session history, immutable sidecars and original import
archives, plus browser outbox/cache/claim copies.
