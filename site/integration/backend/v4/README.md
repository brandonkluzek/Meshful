# Meshful Backend v4: durable Archive/Restore

This bounded successor adds one Website-only durable command,
`set_deck_archived`, to Backend v3. It reuses the canonical store's existing
`setDeckArchived` transaction and the same owner-scoped D1 service, conditional
revision, receipt, outbox and recovery path.

It also defines the bounded v1-to-public-v2 Library promotion policy needed by
the Website release: current Library browsing and new installs use the active
v2 resolver release; retained v1 bases remain exact; only a successful
compatible install promotes the account constructor reference.

It does not add a WebMCP tool, change any of the existing 13 tool schemas,
change scheduling or grading, or require a D1 migration. Backend v3 and its
hosted-acceptance preparation remain frozen evidence. V4 is not selected,
deployed or hosted-accepted until Website creates a new exact selection.

Run the focused local proof with the same authorized canonical and private
Library asset roots used for Backend v3:

```sh
MESHFUL_CANONICAL_ROOT=/path/to/canonical \
MESHFUL_LIBRARY_ASSET_ROOT=/path/to/reviewed-library-runtime \
MESHFUL_PUBLIC_LIBRARY_ROOT=/path/to/public-library-candidate \
env -u NODE_COMPILE_CACHE -u NODE_OPTIONS node --test backend/v4/tests/*.test.mjs
```
