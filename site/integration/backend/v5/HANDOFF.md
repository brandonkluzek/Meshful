# Website handoff

Use all files in `backend/v5/FILE_MANIFEST.json`. The runtime entry is
`backend/v5/src/index.mjs`. Website should select `createCanonicalEngine` and
`createDurableClient` and `createLearnerHandler` from that entry while retaining
the already-selected v3 learner service, v2 D1 repository, migrations, Accounts
lease and trusted authenticator. The v5 handler retains the owned error map
needed to preserve `DECK_IN_ACTIVE_SESSION` as nonretryable HTTP 409.

Configure the resolver with the public v3 exact-reference index as primary and
the private v1 exact-reference index as retained. Pass `expectedCatalogPins` in
that same `[v3, v1]` constructor order. V5 routes Library browse/preview/install
to v3 and promotes the saved constructor only in a successful install commit;
do not rewrite stored `libraryBase` values or catalog references in Website
code.

The browser should import `backend/v5/src/durable-client.mjs` directly, as it
does for the existing v2 browser client. That module depends only on the frozen
base browser client contracts and v2 request-identity helper. It does not import
the v5 server engine, capacity module, resolver or D1 repository.

No D1 migration is required. Do not add `set_deck_archived` to WebMCP
registration or agent-visible schemas. The UI may call
`client.setDeckArchived({deck_id,archived,expected_revision,client_action_id})`
under the current account lease and execution guard. It must apply the visible
effect only after the durable result is confirmed and the Accounts ticket is
still current.

Before selection, Website should run the focused test against its exact pinned
canonical and Library assets, verify the manifest, and add its UI/account tests
for archive, restore, active-session rejection, stale deck/account revisions,
lost acknowledgement and A/B switching. A new Website selection receipt must
pin these bytes; the current v16 Backend v3 acceptance packet must not be
silently relabeled as v5 evidence.

The public Library v3 change does not block a default-closed browser-local Site
deployment. It does block activating the durable account route until Website
selects these exact bytes and reruns its account composition. This package is
only local compatibility evidence; it does not replace hosted D1 acceptance.

This delivery is local provider-free evidence. It made no Sites, D1, DNS,
identity, provider or deployment mutation.
