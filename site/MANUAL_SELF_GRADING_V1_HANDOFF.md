# Manual self-grading v1 handoff

## Selection

- Base: `c690d19` (`codex/post-v35-sites-candidate-v2`)
- Integration branch: `codex/manual-self-grading-v1`
- Integrate the full range `c690d19..codex/manual-self-grading-v1`; the first
  commit preserves the initial UI patch and the tip replaces its provisional
  sentinel-grade behavior with the audited typed operation.
- Selection receipt: `integration/SELECTED_INPUTS.json` → `post_v35_successors.manual_self_grading_v1`
- Deployment: intentionally not performed

## Learner behavior

1. Every active unanswered card offers **Grade myself**, including mobile,
   standalone browsers, and agent-hosted desktop.
2. Opening it reveals the definition and shows the four canonical FSRS buckets:
   **Again**, **Hard**, **Good**, and **Easy**.
3. **Back** returns to the front without writing learner state.
4. Selecting a bucket commits immediately through the private
   `submit_self_grade` operation, holds the reviewed definition in place, and
   exposes only **Next card** or **Finish session**.
5. Agent grading remains available through the public `submit_grade` tool.

## Contract boundary

- A self-grade stores `grading_mode: "self"`, `answer_revealed: true`, and the
  selected rating.
- It does not create `answer_text`, `answer_origin`, `rubric_evidence`, tutor
  feedback, misconceptions, model confidence, or an answer ID.
- The operation uses the existing session/card revision guards, Study-writer
  grant, FSRS scheduler, durable D1 transaction, review sidecar, and receipt
  recovery path.
- The picker creates one idempotency key before submission and retains it for an
  uncertain retry. Agent/self races can append only one review.
- There is no public WebMCP schema or tool-count change and no D1 migration.

## Validation

- `node --test tests/*.test.mjs`
  - PASS: 178 tests, 0 failures
- `node --test tests/release-selection.test.mjs`
  - PASS: 4 tests, 0 failures
- `git diff --check`
  - PASS
- `cmp integration/core/js/store.js public/study/js/store.js`
  - PASS: byte-identical mirrors

The isolated worktree did not have a complete `node_modules`; a pinned offline
install missed one package and the environment approval service failed before a
normal install could run. Website Release should run `npm run build` and a real
mobile/desktop browser smoke after integrating this commit and before deployment.

## Website Release smoke

- On mobile and desktop, confirm **Grade myself** is present before reveal.
- Open it and confirm the definition plus a 2×2 mobile / 1×4 desktop rating grid.
- Press **Back** and confirm no review count or stored learner bytes changed.
- Reopen, select each rating in separate sessions, and confirm the reviewed back
  remains visible until **Next card** / **Finish session**.
- In an account session, simulate a lost acknowledgement and confirm the exact
  pending `submit_self_grade` request replays without a second review.
- Confirm an agent grade and a manual grade racing on the same revision cannot
  both commit.
