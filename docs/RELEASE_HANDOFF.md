# Release handoff

Status: public-source successor assembled and locally verified; exact private
push, public visibility, deployment, and hosted acceptance remain external
gates.

## Identity tuple

```text
final_source_commit=<owner-approved public commit>
final_tree=<git tree for that commit>
file_manifest_sha256=<release/file-manifest.sha256>
hosted_source_revision=<must equal final_source_commit>
live_url=<owner-approved public judge URL>
video_url=<public under-three-minute YouTube URL>
devpost_url=<submitted project URL>
```

All values must describe one frozen experience. The existing private v10 host
cannot fill this tuple because it differs in source, content, access, and D1
activation.

## Prepared repository path

The publication target is `https://github.com/brandonkluzek/Meshful`, retained
private for final review. Its current remote commit predates the admitted Deck
Library release, which currently contains 72 courses. After authentication,
replace remote `main` with the exact
single-root locally verified commit without importing construction branches.
Public visibility, deployment, and submission remain separate actions.

## Remaining gates

- hosted account runtime values and both applied migrations;
- every item in `HOSTED_ACCEPTANCE.md`;
- exact commit/tree/manifest approval;
- exact private push, then separately approved public visibility and judge access;
- final video and Devpost submission.
