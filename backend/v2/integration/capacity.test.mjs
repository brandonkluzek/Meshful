import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setup, command, canonical, webmcp, canonicalRoot, accountsRoot } from "../test-support/real-runtime.mjs";
import { makeMaxNativeV2Args, makeNativeV2RegressionArgs, MAX_NATIVE_V2_CREATE_ARGS_SHA256 } from "../test-support/capacity-fixtures.mjs";
import { gradeFor, FIXED_NOW, definitionCatalog } from "../../test-support/fixtures.mjs";
import { sha256, byteLength } from "../../src/contracts.mjs";
import { STORAGE_KEY } from "../src/canonical-engine.mjs";
import { createCanonicalEngine, createLearnerService } from "../src/index.mjs";
const code = (value) => (error) => error.code === value;

test("record exact canonical and Accounts source bytes used by this provider-free composition", async (t) => {
  for (const file of ["web/js/store.js", "web/js/webmcp.js", "web/js/library-catalog.js"]) {
    t.diagnostic(`${file} ${await sha256(await readFile(join(canonicalRoot, file), "utf8"))}`);
  }
  for (const file of ["accounts/core.mjs", "accounts/sites.mjs", "accounts/index.mjs"]) {
    t.diagnostic(`${file} ${await sha256(await readFile(join(accountsRoot, file), "utf8"))}`);
  }
});

test("205026-byte native input persists through actual client + Accounts + HTTP + SQLite, then grades once", async (t) => {
  const h = await setup(t);
  const client = h.client(); await client.load();
  const args = makeNativeV2RegressionArgs(); assert.equal(byteLength(JSON.stringify(args)), 205_026);
  h.resetMetrics();
  const ingested = await client.ingestDeck(args);
  const metrics = structuredClone(h.metrics);
  const snapshot = await client.load();
  assert.equal(snapshot.durable_revision, 1);
  assert.equal(snapshot.state.schemaVersion, 2);
  assert.ok(snapshot.state_json.includes("Synthetic capacity regression"));
  assert.equal((await h.call("learner-a", "state")).body.data.state, undefined, "Worker sends exact state only once");
  assert.equal((await client.ingestDeck(args)).receipt.replayed, true);
  const started = await client.startStudySession({ deck_id: ingested.deck_id, limit: 1, idempotency_key: "regression:start" });
  const grade = gradeFor(started, "regression:grade");
  const committed = await client.submitGrade(grade);
  const second = h.client(); await second.load();
  assert.equal((await second.submitGrade(grade)).review_id, committed.review_id);
  assert.equal((await h.call("learner-a", "reviews")).body.data.events.length, 1);
  const reopened = canonical.createStudyStore({ catalog: [], storage: canonical.createMemoryStorage({ [STORAGE_KEY]: (await second.load()).state_json }), clock: () => new Date(FIXED_NOW) });
  assert.equal(reopened.getDeck({ scope: "personal", deck_id: ingested.deck_id }).card_count, 50);
  assert.ok(metrics.maxBindBytes < 2_000_000 && metrics.maxSqlBytes < 100_000 && metrics.maxParameters <= 100);
  t.diagnostic(`regression commit SQL=${metrics.queries} batch=${metrics.batches.join(",")} max-bind=${metrics.maxBindBytes}B`);
});

test("maximum compact native-v2 input, including NUL request identity, is one atomic reloadable command", async (t) => {
  const h = await setup(t, { catalog: [] });
  const client = h.client(); await client.load();
  const args = makeMaxNativeV2Args();
  const bytes = byteLength(JSON.stringify(args));
  assert.equal(bytes, 4_523_091);
  assert.equal(await sha256(JSON.stringify(args)), `sha256:${MAX_NATIVE_V2_CREATE_ARGS_SHA256}`);
  assert.ok(bytes <= h.engine.capacity.maxCommandBytes);
  h.resetMetrics();
  const ingested = await client.ingestDeck(args);
  const writeMetrics = structuredClone(h.metrics);
  const snapshot = await client.load();
  assert.equal(snapshot.durable_revision, 1);
  assert.ok(byteLength(snapshot.state_json) > 6_700_000);
  const deck = await client.getDeck({ scope: "personal", deck_id: ingested.deck_id });
  assert.equal(deck.card_count, 50);
  assert.equal(deck.deck.cards[0].definition_md.length, 8_000);
  assert.equal((await client.ingestDeck(args)).receipt.replayed, true);
  assert.equal((await client.load()).durable_revision, 1);
  assert.ok(writeMetrics.maxBindBytes < 2_000_000 && writeMetrics.maxParameters <= 100);
  assert.ok(writeMetrics.queries <= 50, "measured write fits even the stricter published D1 query count, not its CPU allowance");
  t.diagnostic(`max native args=${bytes}B state=${byteLength(snapshot.state_json)}B SQL=${writeMetrics.queries} batch=${writeMetrics.batches.join(",")} bind=${writeMetrics.maxBindBytes}B`);
});

test("a mid-fragment failure rolls back all documents, receipt and head; identical retry succeeds", async (t) => {
  const h = await setup(t);
  const client = h.client(); await client.load();
  let fail = true;
  h.db.beforeStatement = ({ sql }) => {
    if (fail && /INSERT INTO meshful_v2_parts/.test(sql)) { fail = false; throw new Error("synthetic failure after fragment insert"); }
  };
  const args = makeNativeV2RegressionArgs();
  await assert.rejects(client.ingestDeck(args), code("COMMIT_UNCONFIRMED"));
  assert.equal((await h.call("learner-a", "state")).body.data.durable_revision, 0);
  assert.equal((await h.db.prepare("SELECT count(*) AS n FROM meshful_v2_objects").first()).n, 0);
  assert.equal((await h.db.prepare("SELECT count(*) AS n FROM meshful_v2_receipts").first()).n, 0);
  assert.equal((await client.ingestDeck(args)).receipt.replayed, false);
  assert.equal((await client.load()).durable_revision, 1);
});

test("lost acknowledgement keeps the original account draft and replays through compact reload", async (t) => {
  const h = await setup(t);
  let saved = null;
  const outbox = { read: () => structuredClone(saved), write: (value) => { saved = structuredClone(value); } };
  let lose = true;
  const client = h.client("learner-a", { outbox, afterResponse(response, url) {
    if (lose && url.endsWith("/commands") && response.status === 200) { lose = false; throw new Error("lost local acknowledgement"); }
    return response;
  } });
  const bound = await client.load();
  const args = makeNativeV2RegressionArgs();
  await assert.rejects(client.ingestDeck(args), code("REQUEST_UNCONFIRMED"));
  assert.equal(saved.accountBinding, bound.account_binding);
  assert.equal(saved.command.expected_revision, 0);
  const wrongAccount = h.client("learner-b", { outbox }); await wrongAccount.load();
  await assert.rejects(wrongAccount.ingestDeck(args), code("ACCOUNT_CHANGED"));
  assert.equal(saved.accountBinding, bound.account_binding);
  const recovered = h.client("learner-a", { outbox });
  assert.equal((await recovered.ingestDeck(args)).receipt.replayed, true);
  assert.equal(saved, null);
  assert.equal((await recovered.load()).durable_revision, 1);
});

test("opaque dot-segment request IDs replay exactly without URL path normalization", async (t) => {
  const h = await setup(t);
  const client = h.client(); await client.load();
  const args = { library_deck_id: "backend-fixture", expected_catalog_version: "1", client_action_id: ".." };
  const first = await client.addLibraryDeck(args);
  const replay = await client.addLibraryDeck(args);
  assert.equal(replay.receipt.replayed, true);
  assert.equal(replay.deck.id, first.deck.id);
  assert.equal((await client.load()).durable_revision, 1);
});

test("ill-formed transport identity is a definite preflight rejection while learner text remains exact", async (t) => {
  const h = await setup(t);
  let writes = 0;
  const client = h.client("a", { outbox: { read: () => null, write: () => { writes++; } } });
  const bound = await client.load();
  const args = { library_deck_id: "backend-fixture", expected_catalog_version: "1", client_action_id: "\ud800" };
  await assert.rejects(client.addLibraryDeck(args), code("INVALID_REQUEST_ID"));
  assert.equal(writes, 0);
  const direct = await h.call("a", "commands", { accountBinding: bound.account_binding, body: command("add_library_deck", args, 0) });
  assert.equal(direct.status, 400); assert.equal(direct.body.error.retryable, false);
  assert.equal((await h.call("a", "state")).body.data.durable_revision, 0);
  const contentClient = h.client("a"); await contentClient.load();
  const native = makeNativeV2RegressionArgs(); native.deck.cards[0].definition = "Exact learner text \ud800 preserved as a JSON escape.";
  const created = await contentClient.ingestDeck(native);
  assert.equal((await contentClient.getDeck({ scope: "personal", deck_id: created.deck_id })).deck.cards[0].definition_md, native.deck.cards[0].definition);
});

test("scope/identity rejection and owner-pinned recovery never expose another learner's fragmented data", async (t) => {
  const h = await setup(t);
  assert.equal((await h.call("spoof", "state", { trusted: false })).body.error.code, "untrusted_ingress");
  assert.equal((await h.call(null, "state")).body.error.code, "authentication_required");
  const a = h.client("a"); const initial = await a.load();
  await a.ingestDeck(makeNativeV2RegressionArgs());
  const head = (await h.call("a", "recovery")).body.data;
  assert.equal(head.revision, 1);
  assert.equal(head.account_binding, initial.account_binding);
  assert.equal((await h.call("b", `documents/${encodeURIComponent(head.stateDocumentId)}`)).status, 404);
  assert.equal((await h.call("b", "recovery", { accountBinding: initial.account_binding })).body.error.code, "ACCOUNT_CHANGED");
  let after = -1; let text = "";
  do {
    const page = (await h.call("a", `documents/${encodeURIComponent(head.stateDocumentId)}?after_part=${after}&limit=1`)).body.data;
    assert.equal(page.document.digest, head.document.digest);
    text += page.parts.map((part) => part.text).join("");
    after = page.nextAfterPart;
    if (page.done) break;
  } while (true);
  assert.equal(await sha256(text), head.document.digest);
  assert.equal(text, (await a.load()).state_json);
  const identity = { provider: "sites-chatgpt", issuer: "urn:meshful:sites:local-test", subject: "a" };
  await assert.rejects(h.service.getState({ principalId: initial.account_binding, identity, transport: "sites-browser", scopes: [] }), code("FORBIDDEN"));
});

test("all 13 unchanged tools match direct canonical results and exact state through the v2 client", async (t) => {
  const h = await setup(t);
  const client = h.client(); await client.load();
  const storage = canonical.createMemoryStorage();
  const direct = canonical.createStudyStore({ catalog: definitionCatalog(), storage, clock: () => new Date(FIXED_NOW) });
  // Independent tool/method mapping, not imported from either adapter.
  const methods = { get_learning_overview: "getLearningOverview", search_library: "searchLibrary",
    list_my_decks: "searchMyDecks", get_deck: "getDeck", validate_deck: "validateDeck", get_study_session: "getStudySession",
    ingest_deck: "ingestDeck", update_deck: "updateDeck", add_cards: "addCards", update_cards: "updateCards",
    start_study_session: "startStudySession", submit_grade: "submitGrade", finish_study_session: "finishStudySession" };
  const seen = new Set();
  async function run(operation, args = {}) {
    const actual = await client[methods[operation]](structuredClone(args));
    const expected = direct[methods[operation]](structuredClone(args), { source: "webmcp", tool_name: operation });
    assert.deepEqual(actual, expected, `${operation}: same canonical result`);
    assert.equal((await client.load()).state_json, storage.getItem(STORAGE_KEY), `${operation}: exact canonical state`);
    seen.add(operation); return actual;
  }
  await run("get_learning_overview"); await run("search_library");
  await run("search_library", { query: "set", limit: 10 }); await run("list_my_decks");
  const deck = { schema_version: "normalized-definition-deck.v2", deck_id: "capacity-parity", title: "Capacity parity",
    cards: definitionCatalog()[0].cards.map((card) => ({ id: card.id, term: card.term, definition: card.definition, criteria: card.required_concepts })),
    edges: [{ from: "set", to: "subset" }] };
  await run("validate_deck", { source: "candidate", operation: "create", deck });
  const created = await run("ingest_deck", { operation: "create", deck, idempotency_key: "parity:create" });
  const edited = await run("update_deck", { deck_id: created.deck_id, expected_deck_revision: created.deck_revision,
    patch: { title: "Capacity parity revised" }, idempotency_key: "parity:metadata" });
  const added = await run("add_cards", { deck_id: created.deck_id, expected_deck_revision: edited.deck_revision,
    cards: [{ card_id: `${created.deck_id}.collection`, term: "collection", prompt: null,
      definition_md: "Objects considered together.", aliases: [], required_concepts: [{ rubric_item_id: "required-1", text: "objects considered together" }],
      accepted_variants: [], major_error_concepts: [], prerequisite_ids: [], tags: [], source_refs: [], difficulty_hint: null,
      module_ids: [], provenance: null, archived: false }], idempotency_key: "parity:add" });
  await run("update_cards", { deck_id: created.deck_id, expected_deck_revision: added.deck_revision,
    updates: [{ card_id: `${created.deck_id}.set`, patch: { definition_md: "A well-defined collection of distinct objects." } }],
    idempotency_key: "parity:edit-card" });
  await run("get_deck", { scope: "personal", deck_id: created.deck_id });
  const started = await run("start_study_session", { deck_id: created.deck_id, limit: 5, idempotency_key: "parity:start" });
  await run("get_study_session", { session_id: started.session.session_id });
  const graded = await run("submit_grade", gradeFor(started, "parity:grade"));
  await run("finish_study_session", { session_id: graded.session.session_id, expected_session_revision: graded.session.session_revision,
    disposition: "pause", idempotency_key: "parity:pause" });
  const resumed = await run("start_study_session", { deck_id: created.deck_id, limit: 1, idempotency_key: "parity:resume" });
  await run("finish_study_session", { session_id: resumed.session.session_id, expected_session_revision: resumed.session.session_revision,
    disposition: "end", idempotency_key: "parity:end" });
  await run("get_learning_overview");
  assert.deepEqual([...seen].sort(), [...webmcp.WEBMCP_TOOL_NAMES].sort());
});

test("explicit schema1 and schema2 claims preserve original archives and replay without merging", async (t) => {
  const h = await setup(t);
  const localStorage = canonical.createMemoryStorage();
  const local = canonical.createStudyStore({ catalog: definitionCatalog(), storage: localStorage, clock: () => new Date(FIXED_NOW) });
  const installed = local.addLibraryDeck({ library_deck_id: "backend-fixture", expected_catalog_version: "1", client_action_id: "source:install" });
  const started = local.startStudySession({ deck_id: installed.deck.id, limit: 1, idempotency_key: "source:start" }, { source: "webmcp", tool_name: "start_study_session" });
  const graded = local.submitGrade(gradeFor(started, "source:grade"), { source: "webmcp", tool_name: "submit_grade" });
  const sources = [JSON.stringify(local.getSnapshot()), localStorage.getItem(STORAGE_KEY)];
  assert.deepEqual(sources.map((raw) => JSON.parse(raw).schemaVersion), [1, 2]);
  for (const [index, raw] of sources.entries()) {
    const subject = `claim-${index}`;
    const client = h.client(subject); const initial = await client.load();
    const body = { request_id: `claim:${index}`, expected_revision: 0, source_id: `local-source:${index}`,
      catalog_ref: h.engine.defaultCatalogRef, raw_state_json: raw };
    const call = () => h.call(subject, "claims", { accountBinding: initial.account_binding, body });
    const first = await call(); assert.equal(first.status, 200);
    assert.equal(first.body.data.result.legacy_schema, index + 1);
    assert.equal((await call()).body.data.result.receipt.replayed, true);
    const archive = (await h.call(subject, `imports?source_id=${body.source_id}`)).body.data;
    assert.equal(archive.rawJson, raw); assert.equal(archive.digest, await sha256(raw));
    const state = await client.load(); assert.equal(state.durable_revision, 1);
    const restored = canonical.createStudyStore({ catalog: definitionCatalog(), storage: canonical.createMemoryStorage({ [STORAGE_KEY]: state.state_json }), clock: () => new Date(FIXED_NOW) });
    const histories = Object.values(restored.getSnapshot().personalDecks[installed.deck.id].cards).flatMap((card) => card.reviewHistory);
    assert.equal(histories.length, 1); assert.equal(histories[0].reviewId, graded.review_id);
    const anotherClaim = { ...body, request_id: `second-claim:${index}`, source_id: `second-source:${index}`, expected_revision: 1 };
    const conflict = await h.call(subject, "claims", { accountBinding: initial.account_binding, body: anotherClaim });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, "LOCAL_STATE_CONFLICT");
    assert.equal((await client.load()).state_json, state.state_json);
  }
});

test("missing exact catalog prevents canonical use but leaves owner-pinned state recovery intact", async (t) => {
  const h = await setup(t);
  const client = h.client("recover-owner"); const initial = await client.load();
  await client.addLibraryDeck({ library_deck_id: "backend-fixture", expected_catalog_version: "1", client_action_id: "recover:install" });
  const differentEngine = await createCanonicalEngine({ ...canonical, toolSchemas: webmcp.WEBMCP_TOOL_SCHEMAS,
    catalogs: [{ version: "different-only", catalog: [] }], defaultCatalogVersion: "different-only" });
  const service = createLearnerService({ repository: h.repository, engine: differentEngine, clock: () => FIXED_NOW });
  const context = { principalId: initial.account_binding,
    identity: { provider: "sites-chatgpt", issuer: "urn:meshful:sites:local-test", subject: "recover-owner" },
    transport: "sites-browser", scopes: ["learner:read", "learner:write"] };
  await assert.rejects(service.query(context, { operation: "get_learning_overview", args: {} }), code("CATALOG_UNAVAILABLE"));
  const snapshot = await service.getState(context);
  const head = await service.getRecoveryHead(context);
  const page = await service.getDocumentParts(context, head.stateDocumentId);
  assert.equal(page.account_binding, initial.account_binding);
  assert.equal(page.done, true);
  assert.equal(page.parts.map((part) => part.text).join(""), snapshot.state_json);
  assert.equal(await sha256(snapshot.state_json), head.document.digest);
  assert.equal(snapshot.durable_revision, 1);
});
