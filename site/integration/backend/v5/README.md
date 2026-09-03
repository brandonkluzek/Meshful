# Meshful Backend v5: public Library v3 qualification

This bounded successor keeps Backend v4's Website-only durable Archive/Restore
command and qualifies its generic multi-release engine against the Website's
public Library v3 plus the exact retained private v1 base.

Current Library browsing and new installs use the active public v3 resolver
release; retained v1 bases remain exact; only a successful
compatible install promotes the account constructor reference.

It does not add a WebMCP tool, change any of the existing 13 tool schemas,
change scheduling or grading, or require a D1 migration. Backend v4 remains
frozen evidence. V5 is not selected, deployed or hosted-accepted until Website
creates a new exact selection.

Run the focused local proof with the same authorized canonical and private
Library asset roots used for Backend v3:

```sh
MESHFUL_CANONICAL_ROOT=/path/to/canonical \
MESHFUL_LIBRARY_ASSET_ROOT=/path/to/reviewed-library-runtime \
MESHFUL_PUBLIC_LIBRARY_ROOT=/path/to/public-library-candidate \
env -u NODE_COMPILE_CACHE -u NODE_OPTIONS node --test backend/v5/tests/*.test.mjs
```
