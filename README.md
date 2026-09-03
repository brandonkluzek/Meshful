# Meshful

**Learn through conversation. Keep progress in one dependable study system.**

Meshful is a chat-led learning workspace where a learner answers in their own
words, an AI agent evaluates the meaning of the answer, and the website records
one deterministic review. The site owns decks, sessions, scheduling, and saved
progress. Agents can tutor and propose bounded changes through 13 page-owned
WebMCP tools without maintaining a separate copy of learner state.

- [Open Meshful](https://meshful.ai)
- [View the source](https://github.com/brandonkluzek/Meshful)

## How Meshful works

1. Choose a course from the Deck Library or create a personal deck.
2. Start or resume a study session. Meshful shows the current term while keeping
   the definition and grading rubric private.
3. Answer naturally in chat. The agent evaluates meaning and gives concise
   feedback.
4. The agent calls `submit_grade` once. Meshful atomically records the exact
   answer and assessment, updates the FSRS schedule, reveals the definition, and
   advances the session.
5. Return later for due reviews, switch decks without losing the queue, and use
   the prerequisite graph to see how concepts connect.

The regular website remains usable when WebMCP is unavailable. WebMCP adds a
shared, inspectable contract so an agent can work with the same state and rules
as the learner-facing interface.

## Why WebMCP

Meshful divides responsibility deliberately:

- **The learner** supplies the answer and decides when to reveal, continue, or
  move a study session between clients.
- **The agent** grades semantic recall, explains mistakes, tutors in chat, and
  makes deck changes only through declared tool inputs.
- **The site** authorizes access, validates every input and output, owns the
  canonical learner state, applies scheduling exactly once, and renders visible
  effects.

This keeps the creative strengths of an agent separate from operations that
need deterministic state, revision checks, idempotency, and durable receipts.
The result is a coherent study product rather than an agent operating an
unstructured page.

## Capabilities

- A continuous study queue with due reviews, eligible new cards, and early
  practice ordered by due date
- Meaning-based grading mapped to Again, Hard, Good, or Easy
- Revision-guarded, retry-safe mutations and exact readback after uncertain
  results
- Deck Library search, installation, personal deck creation, and targeted card
  editing
- My Decks progress, recent activity, resumable sessions, and deck switching
- A prerequisite graph backed by the same card and edge identities used by
  study
- Browser-local guest use and durable signed-in account storage

## WebMCP surface

`site/public/study/js/webmcp.js` contains the inspectable
`document.modelContext.registerTool` calls, closed JSON schemas, output
validation, account-epoch guards, and visible-effect handoffs for all 13 tools.
The site registers this surface:

| Area | Read tools | State-changing tools |
|---|---|---|
| Overview and collections | `get_learning_overview`, `search_library`, `list_my_decks`, `get_deck` | |
| Deck authoring | | `validate_deck`, `ingest_deck`, `update_deck`, `add_cards`, `update_cards` |
| Study | `get_study_session` | `start_study_session`, `submit_grade`, `finish_study_session` |

Tool discovery metadata is compact, but the registered names, schemas,
annotations, handlers, execution guards, and response contracts remain explicit.
WebMCP support is optional and registration is skipped cleanly when
`document.modelContext` is absent.

## Architecture

- `site/public/study/` contains the browser application, WebMCP registration,
  deterministic store, and versioned Deck Library runtime.
- `site/integration/accounts/` owns the trusted identity boundary used by the
  site.
- `site/integration/backend/v7/` contains the selected durable learner service
  and Study-writer implementation for Cloudflare D1.
- `site/app/` packages the learner API and the page that hosts the study
  workspace.
- `site/drizzle/` contains the three applied D1 schema migrations.
- `site/tests/` verifies the selected sources, browser behavior, WebMCP metadata,
  account boundaries, and deployment composition.

The page and the agent share one canonical store. There is no agent-side shadow
database and no provider call inside the deterministic scheduling path.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
git clone https://github.com/brandonkluzek/Meshful.git
cd Meshful
npm --prefix site ci
npm run verify
npm --prefix site run dev
```

Open the local URL printed by Vinext. Guest study does not require an AI
provider, account, or environment file.

For a hosted signed-in deployment, bind a D1 database as `DB` and configure the
account route with exact values supplied by the deployment environment:

```dotenv
MESHFUL_ACCOUNT_SYNC=enabled
MESHFUL_ALLOWED_ORIGIN=https://your-approved-host.example
SITE_ORIGIN=https://your-approved-host.example
```

Account mode fails closed when its binding, activation flag, exact origin, or
trusted identity ingress is missing.

## Test WebMCP

Run the focused registration and transaction suite:

```bash
npm run verify:webmcp
```

Run the complete source, test, WebMCP, and production-build verification:

```bash
npm run verify
```

The focused tests exercise exact 13-tool registration, closed schemas,
idempotent grading, revision conflicts, account changes, output validation,
Deck Library access, and fail-closed behavior.

## Deck Library and licensing

The included public Deck Library release contains 72 courses, 9,988 cards, and
17,712 prerequisite links. It is AI-reviewed educational content, not a claim
of human subject-matter certification or measured learning outcomes. Its
versioned manifests and course files under `site/public/study/data/` make the
shipped collection inspectable and replaceable as future releases are added.

Software is licensed under [Apache License 2.0](LICENSE). The Deck Library,
owner-controlled documentation, and brand artwork are licensed under
[CC BY 4.0](LICENSES/CC-BY-4.0.md). The three small generated example decks are
dedicated under [CC0 1.0](LICENSES/CC0-1.0.md). See
[LICENSES/README.md](LICENSES/README.md) for the file-level license map and
attribution requirements.

## Contributing

Issues and focused pull requests are welcome. Please preserve the
learner/agent/site authority boundary, include tests for state-changing
behavior, and run `npm run verify` before opening a pull request.

Meshful began from an experimental local study-engine foundation and was
meaningfully extended into this hosted WebMCP product.
