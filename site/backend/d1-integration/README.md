# Sites D1 integration successor

This is the smallest Backend-owned successor for putting the accepted v2
learner service behind a real Sites D1 binding. It adds no storage engine,
identity provider, scheduler, corpus or deployment. The frozen v1/v2 deliveries
remain byte-for-byte inputs. Website still owns the Site checkout, generated
migration journal, resource, build and deployment; Accounts still owns trusted
authentication and browser leases.

## What is ready

- `backend/v2/src/index.mjs` exposes the D1 repository, canonical engine,
  learner service and HTTP handler factories.
- `backend/v2/src/durable-client.mjs` is the one async browser client and retry
  path. There is no second local writer in account mode.
- `0001_learner_data.sql` followed by `0002_fragmented_storage.sql` creates the
  exact 13-table schema, all 23 safety triggers and the deferred response
  document foreign key required by receipt-first atomic batches.
- Scope checks, exact identity-binding rechecks, owner predicates, atomic grade
  and history commits, replay, stale-revision rejection, rollback, catalog pins,
  explicit empty-account claims and recovery are already provider-free tested.
- The supported envelope includes the 205,026-byte regression, one atomic
  14-deck/1,892-card Library closure, 512-review claim/reload and the documented
  v2 byte/node/depth ceilings. It is not an unlimited-storage claim.

Run the deterministic Backend checks from the repository root:

```sh
env -u NODE_COMPILE_CACHE -u NODE_OPTIONS node backend/v2/scripts/verify-delivery.mjs
env -u NODE_COMPILE_CACHE -u NODE_OPTIONS node backend/migration-base/rehearse.mjs
env -u NODE_COMPILE_CACHE -u NODE_OPTIONS node backend/d1-integration/verify.mjs
env -u NODE_COMPILE_CACHE -u NODE_OPTIONS node --test backend/d1-integration/tests/*.test.mjs
```

These commands make no network call and touch no hosted database.

## Exact Website adoption

Use the latest Website-owned Site source. Do not edit the canonical mirror from
this Backend lane.

1. Set `.openai/hosting.json` to the exact three-field object in the contract:
   the existing project ID, logical `d1: "DB"`, and `r2: null`. The verifier
   rejects extra capabilities or an R2 binding because neither is approved in
   this delivery. No Cloudflare database ID or credential belongs in this file.
2. Generate the exact custom Sites migration package into the Site checkout:

   ```sh
   env -u NODE_COMPILE_CACHE -u NODE_OPTIONS node backend/d1-integration/pack-sites-migrations.mjs \
     --target /absolute/path/to/site
   ```

   The packager verifies the authored v1/v2 source hashes, inserts Drizzle's
   `--> statement-breakpoint` only between complete top-level statements, and
   writes the pinned SQLite journal. It emits 10 statements for `0000` and 32
   for `0001`; all 23 trigger bodies remain whole. Do not copy the raw authored
   SQL directly: it has no breakpoints, so a Drizzle runner could execute only
   the first statement. Do not generate a typed replacement for `0001`: the
   typed declaration cannot express its deferred FK or safety-trigger bodies.
   The command accepts byte-identical reruns and refuses to overwrite a
   different migration or journal. Future schema work appends a new reviewed
   tag/artifact; it never rewrites these two applied entries.
3. Build with the existing Sites plugin. Confirm `dist/server/index.js` exists
   as a regular file and the source `drizzle/**` tree is copied to
   `dist/.openai/drizzle/**`, then run:

   ```sh
   env -u NODE_COMPILE_CACHE -u NODE_OPTIONS node backend/d1-integration/verify.mjs \
     --site-root /absolute/path/to/site
   ```

4. In the Website-owned server route, import the supported runtime environment
   and construct the existing endpoint with `database: env.DB`. Do not expose a
   query, cookie, flag or alternate route that selects account mode.
5. Keep activation `closed` while provisioning/applying and attesting the
   database. Invoke `inspectAppliedD1(env.DB)` only from an owner acceptance path
   or test harness; never expose raw `sqlite_schema` or an inspection endpoint to
   ordinary clients. Its receipt returns no learner data rows, but its integrity
   pragmas can scan stored records/pages and incur D1 reads. Then deploy
   `private_acceptance`, using the same production route and a server-only cohort
   of exact verified identities or opaque principals. No request field, email,
   header, Host or client flag can join that cohort. Return to `closed` on any
   failure without deleting rows. `released` is a separate owner decision after
   the pinned private receipt passes.
6. Replace the dormant `meshful-existing-demo-fixtures.v1` engine input with the
   genuine prepared 72-course/9,988-card catalog object from the same admitted
   adapter module instance. Retain every release required by stored catalog/base
   pins. This is a constructor change, not a database migration.

`env.DB` is the complete database injection seam required by Backend. The
audited Website predecessor had `d1:null`, constructed the endpoint with
`database:null`, and used the seven demo fixtures for its dormant account
engine. Its visible full Library did not cure that server mismatch. Website may
now adopt this handoff in a newer private candidate without changing Backend's
repository interface.

## Exact Accounts composition

The trusted request context remains exactly:

```js
{ principalId, identity: { provider, issuer, subject }, transport, scopes }
```

For this Site, use provider `sites-chatgpt`, issuer
`urn:meshful:sites:appgprj_6a9334b99f20819195ece80ebe97016b`, the exact verified
subject, transport `sites-browser`, and scopes `learner:read` and
`learner:write`. Website injects Accounts' `createSitesAuthenticator` and
`authFailureResponse`; Backend rechecks the exact binding for every operation.
Email, names, Host, request JSON and client-supplied user IDs never select data.

ChatGPT/Sites sign-in proves who made the request; it does not store Meshful
decks or progress. Accounts resolves the exact verified identity through
`findPrincipalByIdentity(identity)` and, only for an admitted verified Sites
request under explicit server configuration, may call
`provisionPrincipalForVerifiedIdentity(identity)`. The resulting opaque
`principalId` owns D1 rows. Unknown remote identities remain denied, and no
email-based or automatic cross-provider account merge exists.

Adopt the Accounts v3 delivery from its final manifest (SHA-256
`262c0a425a5e6dc8f94e67fc9f792dead2fe2070a4a5b0b8adef70b06dfee8ad`), including
`browser-state.mjs`, `browser-storage.mjs` and `browser-storage-records.mjs`.
Create one client per authentication epoch under its native per-account lease.
Pass its outbox and execution guard unchanged. An A response may finish after
logout, but it must never render under B or clear B's draft.

Production `isTrustedIngress(request)` must prove dispatcher-only provenance,
spoofed identity-header stripping and no direct-origin bypass. Header or Host
presence is not proof. Unknown identity remains denied, and provisioning is
enabled only for a verified Sites identity under an explicit server setting.

## Guest browser progress

The only import path is the existing explicit `POST /api/learner/v2/claims`.
Website first reads revision zero with null state, preserves the original local
key and exact `raw_state_json`, shows a concrete user confirmation, then sends
the saved claim envelope. There is no automatic import or merge. A lost response
retries the identical original account/request/source envelope. A nonempty
destination, changed source or globally claimed source rejects without mutation.

## Hosted acceptance

Website supplies one adapter backed by two independently signed-in browser/device
contexts for learner A and one for learner B. The adapter returns only bounded
summary evidence; it must not return cookies, identity subjects, account IDs,
answers, feedback or state JSON. Run:

```sh
env -u NODE_COMPILE_CACHE -u NODE_OPTIONS node backend/d1-integration/run-hosted-acceptance.mjs \
  --adapter-manifest /absolute/adapter/HOSTED_ADAPTER_MANIFEST.json \
  --base-url https://meshful.ai
```

`HOSTED_ACCEPTANCE.json` covers the exact applied schema definitions, active
trusted-ingress attacks, same account on two devices, lost acknowledgement and
replay, stale concurrency and rollback, A/B isolation, both logout race
branches, confirmed guest claim, the real 14-deck/1,892-card closure and the
maximum native/history/recovery capacity profile. The runner's receipt is explicitly
Website-adapter-attested and says `independent_network_proof:false`; pair it with
the exact Website source manifest and payload, saved-version/deployment receipt,
reviewed adapter entry, browser/network trace and owner D1 observation before
calling it hosted acceptance. The entry hash is provenance for those bytes; it
does not prove a transitive JavaScript dependency closure or sandbox the adapter.
This delivery's runner validates adapter-returned digest formats but does not
yet load and canonicalize the referenced network, D1 and resource manifests.
Its receipt is a harness result, not the final hosted acceptance authority. The
machine receipt keeps `paired_artifacts_verified`, `provider_limits_verified`
and `hosted_acceptance_complete` false and labels its totals as harness totals.
Those fields cannot become true in this runner. The
final gate requires an executable paired-artifact verifier that cross-links
every scenario, challenge, trace and observation. Effective CPU, request, query
and storage limits must also be bound to an owner account or deployment-config
receipt; adapter-reported integers alone are not provider-limit evidence.

## Public repository boundary

This Backend code, schema, migrations, tests and contracts contain no learner
rows, real identities, cookies, credentials or D1 resource IDs and can accompany
a reviewed public code release. The live D1 database never enters Git. The
72-course corpus has its own redistribution/publication gate; making the code
public neither grants nor requires publishing private corpus source data.

## Gates that remain closed

- No hosted D1 resource or migration has been observed by Backend.
- No production trusted-ingress proof has been supplied.
- No real hosted two-device acceptance receipt exists yet.
- The paired hosted-evidence verifier and provider-limit configuration receipt
  are not implemented; the current runner cannot close hosted acceptance.
- The dormant account engine still needs the full prepared catalog and retained
  releases.
- Learner timezone authority, full account export/delete and retention policy
  remain explicit release limitations; the database must not silently invent
  them.

Until the first four hosted gates pass, all learner endpoints remain
default-denied. A failed rollout preserves D1 rows, receipts, archives, recovery
documents and original browser drafts; it never deletes or resets them.
