# Meshful

Meshful is an agent-ready study workspace. Learners study through conversation,
answer in their own words, receive one atomic grade, and return on an FSRS
schedule. The website owns deterministic learner state while agents grade,
tutor, and make bounded deck proposals through thirteen page-owned WebMCP
tools.

## Release boundary

This clean-history source tree is the release candidate for
`brandonkluzek/Meshful`. Software is licensed under Apache-2.0.
Owner-controlled documentation and brand artwork are licensed under CC BY 4.0.
Generated public example deck content is dedicated under CC0 1.0 Universal, so
reuse does not require attribution. The sanitized academic Deck Library is licensed
under CC BY 4.0 with the attribution notice retained in `library/`. See
[the license map](LICENSES/README.md).

The repository includes the approved academic Deck Library. Its current public
release contains 72 courses, 9,988 cards, and 17,712 prerequisite links, plus
three small source-recorded examples totaling 18 cards. The Deck Library received full-card AI review and second-reader
repairs, but it has not been certified by human subject-matter experts. Neither
the Deck Library nor the examples are evidence of learning outcomes. Learner data,
credentials, provider outputs, private source locators, build-only helpers, and
construction history are not included.

The default guest build ships a public-only, hash-pinned browser projection of
that same Deck Library release. A clean clone opens all 72 current courses without private
construction inputs or provider access.

## Product behavior

- Signed-out visitors use a same-origin browser-local guest workspace.
- Signed-in visitors use the durable account entry selected by the server.
- Guest state is never merged automatically. It can be copied only after
  explicit confirmation into an empty account, while the local original stays
  available.
- Account mode requires the Sites `DB` binding, exact HTTPS origin, trusted
  identity ingress, and explicit activation. Missing configuration fails closed
  without falling back to signed-in local storage.
- `submit_grade` is one revision-guarded, idempotent transaction that records
  the answer and assessment, schedules once, reveals once, and advances once.

## Run locally

Requirements: Node.js 22.13 or newer. Guest browser development has no package
dependencies:

```bash
npm --prefix web run check
npm --prefix web test
npm --prefix web run dev
```

Complete source and package verification:

```bash
npm --prefix accounts ci
npm --prefix site ci
npm run check
npm test
npm run verify:webmcp
npm run build
```

`npm run check` includes the repository-scoped licensing, provenance, public
example, Library-manifest, social-preview, and governance checks in
[the public-readiness contract](docs/PUBLIC_READINESS.md).

`site/prebuild` regenerates the ignored `site/public/study/` mirror from the
canonical admitted sources. Both authored D1 migrations remain in
`site/drizzle/` for Sites packaging.

## WebMCP implementation map

| Product surface | Read tools | State-changing tools |
|---|---|---|
| Overview and collections | `get_learning_overview`, `search_library`, `list_my_decks`, `get_deck` | None |
| Deck authoring | None | `validate_deck`, `ingest_deck`, `update_deck`, `add_cards`, `update_cards` |
| Study | `get_study_session` | `start_study_session`, `submit_grade`, `finish_study_session` |

- `web/js/webmcp.js` defines the thirteen closed schemas, registers the tools,
  validates outputs, and guards delivery across account epochs.
- `web/js/store.js` owns deterministic deck, session, revision, receipt, and
  FSRS scheduling mutations.
- `web/js/app.js` renders the same page-owned state and visible effects used by
  tools. The agent has no shadow learner-state copy.
- `accounts/` provides the identity, lease, outbox, browser-storage, and privacy
  boundary.
- `backend/v2/` provides D1 persistence and capacity enforcement.
- `site/` packages the canonical browser app, D1 migrations, guest entry, and
  fail-closed account route.

Provider-free tests cover schemas, transaction replay and conflicts, visible
effects, Accounts storage, D1 persistence, and Sites composition. Hosted access,
trusted identity, source/live parity, and semantic grading quality require
separate evidence.

## Challenge delta

The pre-challenge baseline is
`62b65cc841d01f3f5144bc6aac0cbb6887f530d9`. Challenge-period work added the
browser study experience, thirteen WebMCP tools, atomic grading, FSRS
scheduling, retry-safe mutations, Library, My Decks, Study, and Graph views,
the D1-backed account path, and the Sites wrapper. See
[the dated challenge delta](docs/CHALLENGE_DELTA.md).

## Competition links

- Live app: pending exact-commit deployment and hosted acceptance.
- Source repository: <https://github.com/brandonkluzek/Meshful>.
- Demo video: pending exact-source recording and owner approval.
- Devpost: pending final source, live URL, and video tuple.

The [WebMCP Challenge rules](https://webmcp.devpost.com/rules) require a working
live URL, public source with a visible open-source license, a public
under-three-minute YouTube demo with audio, and clear prior-versus-new
documentation. External actions remain owner-gated.
