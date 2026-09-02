# Meshful web candidate

**Connect terms. Build understanding.**

Meshful is Adaptive Study Lab's WebMCP Challenge candidate. It is a calm
definition-study website that works on its own and lets a
ChatGPT or Codex agent operate the same visible, browser-owned study state
through page-defined WebMCP tools.

The product has four distinct experiences:

- **Study** is the home screen: due work, streak, compact progress, activity,
  and one resumable definition session.
- **My Decks** is the learner's collection: active/archived decks, due work,
  coverage, recency, provenance, and last activity.
- **Library** is the separate, versioned course catalog. The approved public
  release has 72 courses, 9,988 cards and 17,712 required links.
  Installing a course also installs its required prerequisite courses atomically.
- **Graph** is a draggable, zoomable prerequisite DAG whose fixed-size nodes are
  actual concept cards and whose edges are actual prerequisite relations.

## Run locally

Requirements: a current Node.js runtime. There are no frontend package
dependencies or provider requests. The inspectable public Deck Library source is in
`../library/`. The exact browser projection and public-only release index ship
under `data/`, so a clean clone opens the approved 72-course catalog directly.
Future catalog changes must regenerate both surfaces from one approved release;
do not hand-edit individual course or browser-artifact bytes.

```bash
cd web
npm run check
npm test
npm run dev
```

Open <http://127.0.0.1:4173/>. Pass a different port as the final argument if
needed, for example `npm run dev -- 8765`.

Useful deterministic previews:

- `/?demo=empty#study` — empty collection and onboarding;
- `/?demo=loading#study` — a deliberately delayed loading state; and
- `/?demo=error#study` — the recoverable error-state presentation.

Normal first run starts with an empty personal collection; it does not seed
learner history. Previously installed examples remain in My Decks with their
saved sessions and history. The owner-requested completed Introductory Mechanics
example retains its gold outline and `Example progress` label; it is not a real
learner-outcome claim. The three public examples remain compatibility inputs,
not normal catalog entries. `?demo=empty` is memory-only and must not be used to
demonstrate persistence.

## Clean, reload-persistent recording workspace

This is a local candidate capability, not a deployed recording receipt or
permission to run a provider, record, or publish. Use a dedicated persistent
browser profile when recording is authorized, then open the approved exact
build with a new query such as `/?recording=launch-take01#study`.

- The identifier must contain 1–64 lowercase letters, digits, underscores, or
  hyphens, starting with a letter or digit. Do not combine it with `demo`.
- A new identifier starts with no installed decks, sessions, reviews, or seeded
  mastery/activity. Settings identifies the namespace as `Recording: …` and
  `Saved in this browser`. It uses the same four views and tool contracts.
- The namespace persists in localStorage on the same origin, browser profile,
  and recording identifier. Reloading keeps installed decks, session position,
  committed answers/reviews, and graph pins. Closing an incognito profile,
  clearing browser storage, or changing origin is not persistence evidence.
- Normal study data is neither imported nor reset. Its existing storage key is
  unchanged. Recording keys append `:recording:<identifier>`; graph preferences
  receive the same suffix. A recording Reset affects only that namespace.
- Verify the starting state with the visible empty Study view and
  `get_learning_overview`: empty decks, no active session, and no recent
  reviews. If the identifier already has data, choose a new one; do not clear
  the owner's normal workspace.
- Add approved ordinary-academic content through Library or the supported
  authoring tools. For a real grade capture, use the learner's actual chat
  answer and one agent `submit_grade`; do not inject the test suite's ratings or
  feedback. Retain the exact receipt, reveal, advance, and reload readback.
- Complete authentication before opening the recording URL. Keep that full URL
  after reload; the existing sign-in/sign-out return path does not retain it.
  Recording isolation is not account partitioning, cloud sync, or auth proof.

No catalog content gains public release admission from this procedure. The
selected 72-course release is an approved, AI-reviewed public-source package;
Linear Algebra I contains 142 cards and 203 required links. It is not certified
by human subject-matter experts. Existing examples remain unreviewed fixtures.
Exact build/content selection remains required, and neither content set proves
learner outcomes.

## Recovery and session behavior

Storage acquisition, hydration, and first rendering complete before tools are
registered. Corrupt, incompatible, unavailable, or quota-blocked startup shows
recovery with Retry and a local saved-data download where available; recovery
does not automatically reset, migrate into an empty store, or overwrite the
saved bytes. Retry keeps the current recording namespace.

Exit pauses the current queue. Resume reactivates that same session; starting
another deck pauses the former session and opens the requested deck. Paused and
ended session URLs cannot invite an answer or expose the canonical definition.
Committed grade activity is counted on the local calendar day. Its reveal is
bound to the exact visible session and reviewed card, and a pending metadata
refresh cannot cut that reveal short. Provider-free app regressions exercise
these behaviors; they are not real-agent or hosted acceptance.

## Target definition-study contract

The page protects the canonical answer with this sequence:

```text
term visible on the page
  -> trusted agent reads the full current card without revealing it
  -> learner answers in chat
  -> agent grades and gives concise feedback in chat
  -> submit_grade (one revision-guarded, idempotent commit)
  -> definition flips into view, card slides, session advances
```

The learner answers the agent in chat. The website shows the current term and,
only after the atomic grade commit, flips the card to the canonical definition.
Agent prose and detailed feedback stay in chat; the page owns session state,
scheduling, progress, and the visible card transition. The normal interface
remains coherent without WebMCP, but semantic grading is agent-owned.

Every mutation uses an `idempotency_key` and the relevant expected revision.
The trusted agent may read the unanswered card's definition and rubric, but it
must not state them to the learner before the attempt. `submit_grade` stores the
exact learner answer and agent assessment, runs FSRS once, advances once, and
returns the just-reviewed card plus the next safe learner-facing state.

This local candidate is single-user and browser-local. The top-level
same-origin page is its current authorization boundary; it does not yet have an
account identity or make an authenticated-production claim. A deployed
multi-user version must add and verify its real sign-in/authorization boundary
and have the WebMCP tools reuse it.

Each operation refreshes from the current persisted app revision before it
reads or writes, and view-only navigation cannot overwrite a newer sequential
learner write from another tab. The dependency-free localStorage prototype does
not claim an atomic guarantee for truly simultaneous cross-tab writes; a hosted
version should move the same expected-revision contract behind a transactional
store or Web Lock.

## Scheduler identity and boundary

The browser scheduler is `fsrs-6-default-v1`. It implements the published
FSRS-6 memory-state formulas with the 21 published default weights, desired
retention `0.9`, deterministic whole-day interval rounding, and a maximum
interval of 36,500 days. Formula tests cover initial stability/difficulty,
same-day stability, successful recall, lapse stability, retrievability, and
interval calculation.

This is deliberately **not** described as a full or drop-in FSRS scheduler. It
does not implement intraday learning or relearning steps, does not apply
interval fuzzing, and maps the bounded agent assessment to Again/Hard/Good/Easy
before scheduling. Metadata therefore reports `core_formula_exact: true` and
`exact_fsrs: false`. These omissions make the profile deterministic and small,
but they also mean behavior should not be presented as parity with the complete
`py-fsrs` state machine.

## Target WebMCP surface

The corrected target is 13 tools registered through
`document.modelContext.registerTool`:

| Surface | Read | State-changing |
|---|---|---|
| Overview and collections | `get_learning_overview`, `search_library`, `list_my_decks`, `get_deck` | — |
| Personal deck build/edit | — | `validate_deck`, `ingest_deck`, `update_deck`, `add_cards`, `update_cards` |
| Study | `get_study_session` | `start_study_session`, `submit_grade`, `finish_study_session` |

The current JavaScript runtime registers exactly this 13-tool surface. The
retired `capture_answer -> preview_review -> apply_review` ceremony is not
registered, and negative transaction tests cover closed inputs, stale or wrong
identity, conflicting replay, output validation, and fail-closed registration.
This local evidence does not replace real-agent or hosted judge acceptance.

WebMCP support is optional: if `document.modelContext` is absent, registration
is skipped and the normal website continues to work. The fuller agent/page
authority map and judge flow are in
[`WEBMCP_BOUNDARY.md`](../docs/challenge/WEBMCP_BOUNDARY.md) and
[`JUDGE_GUIDE.md`](../docs/challenge/JUDGE_GUIDE.md).

## Content and evidence boundaries

- The owner-approved public release is `2026-09-02.public-sanitized-72.v2`: 72 courses,
  9,988 cards and 17,712 required links, including 770 cross-deck links.
- The old 50-card Linear Algebra I and six smaller fixtures are retained only
  for saved-example compatibility. Their synthetic progress is not transferred
  to canonical course cards.
- The browser build preserves canonical IDs, definitions, criteria and links,
  while omitting the private provenance lookup map and local source paths.
- The public-only release index contains no private-v1 entry or artifact.
- Public source admission does not admit private construction provenance or
  personal learner history into the catalog asset.
- Passing tests establish only the explicitly exercised catalog, graph, state,
  transaction, UI-contract, and tool-registration behavior. They do not prove
  curriculum quality, learning outcomes, security, deployment, or release
  readiness.
- Meshful is the owner-selected product name, replacing TermMesh. The privately
  connected `meshful.ai` domain does not establish public access. The naming decision does not itself
  establish trademark or legal clearance; the former `Lattice` screen remains
  as historical context in [`NAMING_RESEARCH.md`](../docs/challenge/NAMING_RESEARCH.md).
- Software is licensed under Apache-2.0, the academic Deck Library under CC BY 4.0,
  and the three generated examples under CC0 1.0. Hosting and submission remain
  separate owner-controlled gates.

The challenge packaging status and exact owner gates are recorded in
[`SUBMISSION_MANIFEST.md`](../docs/challenge/SUBMISSION_MANIFEST.md).
