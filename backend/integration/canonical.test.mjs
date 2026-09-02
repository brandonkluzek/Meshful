import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteD1 } from "../test-support/sqlite-d1.mjs";
import { createD1Repository } from "../src/d1-repository.mjs";
import { createLearnerService } from "../src/learner-service.mjs";
import { createCanonicalEngine, STORAGE_KEY } from "../src/canonical-engine.mjs";
import { sha256 } from "../src/contracts.mjs";
import { contextFor, definitionCatalog, FIXED_NOW, gradeFor } from "../test-support/fixtures.mjs";

assert.ok(process.env.MESHFUL_CANONICAL_ROOT,
  "Set MESHFUL_CANONICAL_ROOT to the authorized competition checkout; this test never copies it.");
const root = resolve(process.env.MESHFUL_CANONICAL_ROOT);
const { createStudyStore, createMemoryStorage } = await import(pathToFileURL(join(root, "web/js/store.js")));
const { WEBMCP_TOOL_NAMES, WEBMCP_TOOL_SCHEMAS } = await import(pathToFileURL(join(root, "web/js/webmcp.js")));
const code = (expected) => (error) => error.code === expected;

async function engineFor(catalog = definitionCatalog(), version = "synthetic-2026-08-30") {
  return createCanonicalEngine({ createStudyStore, createMemoryStorage, toolSchemas: WEBMCP_TOOL_SCHEMAS,
    catalogs: [{ version, catalog }], defaultCatalogVersion: version });
}
function serviceFor(db, engine) {
  return createLearnerService({ repository: createD1Repository(db), engine, clock: () => FIXED_NOW });
}
async function setup(t) {
  const db = new SqliteD1().applyMigration(); t.after(() => db.close());
  const engine = await engineFor(); const service = serviceFor(db, engine);
  const a = await contextFor(service); const b = await contextFor(service, "learner-b");
  return { db, engine, service, a, b };
}
function command(operation, args, expected_revision) {
  return { request_id: args.idempotency_key ?? args.client_action_id, expected_revision, operation, args };
}
async function installAndStart(service, a, suffix = "") {
  const installed = await service.command(a, command("add_library_deck", {
    library_deck_id: "backend-fixture", expected_catalog_version: "1", client_action_id: `install${suffix}`,
  }, 0));
  const started = await service.command(a, command("start_study_session", {
    deck_id: installed.result.deck.id, limit: 5, idempotency_key: `start${suffix}`,
  }, 1));
  return { installed, started };
}

test("bind receipt to actual canonical source bytes (not only dirty HEAD)", async (t) => {
  for (const file of ["web/js/store.js", "web/js/webmcp.js", "web/js/deck-build-guide.js", "web/js/grading-guide.js"]) {
    const digest = await sha256(await readFile(join(root, file), "utf8"));
    t.diagnostic(`${file} ${digest}`);
  }
});

test("same learner's deck and real canonical grade survive file reload, replay once, and remain private", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meshful-canonical-"));
  const path = join(dir, "learner.sqlite");
  let db = new SqliteD1(path).applyMigration();
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const engine = await engineFor(); let service = serviceFor(db, engine);
  const a = await contextFor(service); const b = await contextFor(service, "learner-b");
  const { installed, started } = await installAndStart(service, a);
  assert.equal(started.result.session.total, 1, "only the prerequisite-eligible card is introduced");
  const grade = command("submit_grade", gradeFor(started.result), 2);
  const committed = await service.command(a, grade);
  const stateBeforeReload = await service.getState(a);
  assert.equal(stateBeforeReload.state.schemaVersion, 2);
  db.close(); db = new SqliteD1(path); service = serviceFor(db, engine);
  const recovered = await service.command(a, grade);
  assert.equal(recovered.result.receipt.replayed, true);
  assert.equal(recovered.result.review_id, committed.result.review_id);
  assert.deepEqual((await service.getState(a)).state, stateBeforeReload.state);
  const [event] = (await service.listReviews(a)).events;
  assert.equal(event.payload.review.answer_text, grade.args.answer_text);
  assert.equal(event.payload.review.feedback, grade.args.feedback);
  assert.equal(event.payload.card_version.definition, definitionCatalog()[0].cards[0].definition);
  assert.equal(event.payload.review.scheduleAfter.repetitions, 1);
  assert.equal(event.payload.review.scheduleAfter.algorithm, "fsrs-6-default-v1");
  assert.equal(event.payload.catalog_ref.digest, engine.defaultCatalogRef.digest);
  assert.equal((await service.listReviews(a)).events.length, 1);
  assert.equal((await service.getState(b)).state, null);
  await assert.rejects(service.query(b, { operation: "get_deck", args: { scope: "personal", deck_id: installed.result.deck.id } }), code("DECK_NOT_FOUND"));
  await assert.rejects(service.command(b, { ...grade, expected_revision: 0 }), code("SESSION_NOT_FOUND"));
  await assert.rejects(service.command(a, { ...grade, request_id: "fresh-stale", args: { ...grade.args, idempotency_key: "fresh-stale" } }), code("STALE_DURABLE_REVISION"));
  assert.equal((await service.listReviews(a)).events.length, 1);
});

test("canonical card/session stale guards and closed grading schema reject without durable writes", async (t) => {
  const { service, a } = await setup(t);
  const { started } = await installAndStart(service, a);
  const initial = await service.getState(a);
  const grade = gradeFor(started.result);
  await assert.rejects(service.command(a, command("submit_grade", { ...grade, verdict: "correct" }, 2)), code("INVALID_TOOL_INPUT"));
  await assert.rejects(service.command(a, command("submit_grade", { ...grade, expected_card_revision: 77 }, 2)), (e) => e.code.startsWith("STALE_"));
  await assert.rejects(service.command(a, command("submit_grade", { ...grade, expected_session_revision: 77 }, 2)), (e) => e.code.startsWith("STALE_"));
  await assert.rejects(service.command(a, command("submit_grade", { ...grade, rubric_evidence: [{ rubric_item_id: "not-an-item", status: "met", note: "bad" }] }, 2)));
  assert.equal((await service.getState(a)).state_json, initial.state_json);
  assert.equal((await service.listReviews(a)).events.length, 0);
});

test("catalog pin drift blocks use but raw recovery and idempotent receipts still work", async (t) => {
  const { db, service, a } = await setup(t);
  const { started } = await installAndStart(service, a);
  const grade = command("submit_grade", gradeFor(started.result), 2);
  await service.command(a, grade);
  const changed = definitionCatalog(); changed[0].cards[0].definition = "Unreviewed changed content.";
  const drifted = serviceFor(db, await engineFor(changed));
  await assert.rejects(drifted.query(a, { operation: "get_learning_overview", args: {} }), code("CATALOG_UNAVAILABLE"));
  assert.equal((await drifted.getState(a)).durable_revision, 3);
  assert.equal((await drifted.command(a, grade)).result.receipt.replayed, true);
});

test("schema1 and sparse schema2 local claims preserve originals and prior exact history", async (t) => {
  for (const schema of [1, 2]) {
    const { service, a, engine } = await setup(t);
    const storage = createMemoryStorage();
    const local = createStudyStore({ catalog: definitionCatalog(), storage, clock: () => new Date(FIXED_NOW) });
    const installed = local.addLibraryDeck({ library_deck_id: "backend-fixture", expected_catalog_version: "1", client_action_id: "local-install" });
    const started = local.startStudySession({ deck_id: installed.deck.id, idempotency_key: "local-start", limit: 1 });
    const grade = gradeFor(started, "local-grade"); local.submitGrade(grade);
    const raw = schema === 1 ? JSON.stringify(local.getSnapshot(), null, 2) : storage.getItem(STORAGE_KEY);
    const claim = { request_id: `claim-schema-${schema}`, expected_revision: 0, source_id: `local-origin-schema-${schema}`,
      catalog_ref: engine.defaultCatalogRef, raw_state_json: raw };
    const receipt = await service.claimLocalState(a, claim);
    assert.equal(receipt.result.legacy_schema, schema);
    assert.equal((await service.getImportArchive(a, claim.source_id)).rawJson, raw);
    assert.equal((await service.listReviews(a)).events.length, 0, "do not invent missing old content provenance");
    assert.match((await service.getState(a)).state_json, /Elements can be/);
    assert.equal((await service.claimLocalState(a, claim)).result.receipt.replayed, true);
    await assert.rejects(service.command(a, command("submit_grade", grade, 1)), code("LEGACY_REQUEST_REQUIRES_REFRESH"));
  }
});

test("local corrupt state is rejected before consuming the empty durable slot", async (t) => {
  const { service, engine, a } = await setup(t);
  const raw = JSON.stringify({ schemaVersion: 1, revision: 0, personalDecks: { broken: {} }, sessions: {}, actionReceipts: {}, actionReceiptOrder: [] });
  await assert.rejects(service.claimLocalState(a, { request_id: "bad-import", expected_revision: 0, source_id: "bad-origin",
    catalog_ref: engine.defaultCatalogRef, raw_state_json: raw }), code("INVALID_LOCAL_STATE"));
  assert.equal((await service.getState(a)).state, null);
});

test("canonical constructor card IDs and finished sessions survive import", async (t) => {
  const catalog = definitionCatalog();
  catalog[0].cards = [{ ...catalog[0].cards[0], id: "constructor" }]; catalog[0].edges = [];
  const engine = await engineFor(catalog);
  const db = new SqliteD1().applyMigration(); t.after(() => db.close());
  const service = serviceFor(db, engine); const a = await contextFor(service);
  const storage = createMemoryStorage();
  const local = createStudyStore({ catalog, storage, clock: () => new Date(FIXED_NOW) });
  const deck = local.addLibraryDeck({ library_deck_id: "backend-fixture", expected_catalog_version: "1", client_action_id: "i" });
  const started = local.startStudySession({ deck_id: deck.deck.id, idempotency_key: "s" });
  local.finishStudySession({ session_id: started.session.session_id, expected_session_revision: started.session.session_revision,
    disposition: "end", idempotency_key: "end" });
  const raw = storage.getItem(STORAGE_KEY);
  await service.claimLocalState(a, { request_id: "claim-constructor", expected_revision: 0, source_id: "constructor-origin",
    catalog_ref: engine.defaultCatalogRef, raw_state_json: raw });
  assert.equal((await service.getImportArchive(a, "constructor-origin")).rawJson, raw);
  const result = await service.query(a, { operation: "get_study_session", args: { session_id: started.session.session_id } });
  assert.equal(result.result.session.status, "finished");
});

test("new review source/card snapshot survives a later material content edit", async (t) => {
  const { service, a } = await setup(t);
  const { installed, started } = await installAndStart(service, a);
  const grade = command("submit_grade", gradeFor(started.result), 2);
  await service.command(a, grade);
  const before = (await service.listReviews(a)).events;
  const deck = await service.query(a, { operation: "get_deck", args: { scope: "personal", deck_id: installed.result.deck.id } });
  const updated = await service.command(a, command("update_cards", {
    deck_id: installed.result.deck.id, expected_deck_revision: deck.result.deck.deck_revision,
    updates: [{ card_id: grade.args.card_id, patch: { definition_md: "A well-defined collection of distinct elements." } }],
    idempotency_key: "edit-after-grade",
  }, 3));
  assert.equal(updated.durable_revision, 4);
  assert.deepEqual((await service.listReviews(a)).events, before);
  assert.equal((await service.command(a, grade)).result.receipt.replayed, true);
});

test("external prerequisite references remain pinned metadata and do not become a new queue gate", async (t) => {
  const catalog = definitionCatalog(); catalog[0].cards[0].prerequisites = ["other-deck.foundation"];
  const engine = await engineFor(catalog);
  const db = new SqliteD1().applyMigration(); t.after(() => db.close());
  const service = serviceFor(db, engine); const a = await contextFor(service);
  const { installed, started } = await installAndStart(service, a);
  assert.equal(started.result.session.total, 1);
  const read = await service.query(a, { operation: "get_deck", args: { scope: "personal", deck_id: installed.result.deck.id } });
  assert.equal(read.result.cross_deck_edge_count, 1);
  assert.deepEqual(read.result.deck.cards[0].prerequisite_ids, ["other-deck.foundation"]);
  const raw = (await service.getState(a)).state_json;
  const imported = await engine.importLocal(raw, engine.defaultCatalogRef, { now: FIXED_NOW });
  assert.equal(imported.stateJson, raw);
});

test("legacy committed-answer migration is atomic with the claim and preserves the original answer archive", async (t) => {
  const { service, engine, a } = await setup(t);
  const storage = createMemoryStorage();
  const local = createStudyStore({ catalog: definitionCatalog(), storage, clock: () => new Date(FIXED_NOW) });
  const installed = local.addLibraryDeck({ library_deck_id: "backend-fixture", expected_catalog_version: "1", client_action_id: "legacy-install" });
  const started = local.startStudySession({ deck_id: installed.deck.id, mode: "new", limit: 1, client_action_id: "legacy-start" });
  local.captureAnswer({ session_id: started.session.id, card_id: started.current_card.id,
    answer: "Original legacy answer α.", expected_session_revision: started.session.revision, client_action_id: "legacy-answer" });
  const raw = storage.getItem(STORAGE_KEY);
  assert.equal(JSON.parse(raw).sessions[started.session.id].phase, "answer_committed");
  await service.claimLocalState(a, { request_id: "claim-legacy", expected_revision: 0, source_id: "legacy-origin",
    catalog_ref: engine.defaultCatalogRef, raw_state_json: raw });
  const state = await service.getState(a);
  assert.equal(state.state.sessions[started.session.id].phase, "awaiting_answer");
  assert.equal(state.state.sessions[started.session.id].capture, null);
  assert.equal((await service.getImportArchive(a, "legacy-origin")).rawJson, raw);
  assert.equal((await service.listReviews(a)).events.length, 0);
});

// Independent public-tool mapping: do not import the adapter's dispatch tables,
// or an incorrect operation/method pair could be repeated in its own oracle.
const PARITY_METHODS = Object.freeze({
  get_learning_overview: "getLearningOverview",
  search_library: "searchLibrary",
  list_my_decks: "searchMyDecks",
  get_deck: "getDeck",
  validate_deck: "validateDeck",
  get_study_session: "getStudySession",
  ingest_deck: "ingestDeck",
  update_deck: "updateDeck",
  add_cards: "addCards",
  update_cards: "updateCards",
  start_study_session: "startStudySession",
  submit_grade: "submitGrade",
  finish_study_session: "finishStudySession",
});
const PARITY_READ_NAMES = [
  "get_learning_overview", "search_library", "list_my_decks",
  "get_deck", "validate_deck", "get_study_session",
];

function parityDeck() {
  const source = definitionCatalog()[0];
  return {
    schema_version: "normalized-definition-deck.v2",
    deck_id: "parity-deck", title: "Persistence parity",
    cards: source.cards.map((card) => ({
      id: card.id, term: card.term, definition: card.definition,
      criteria: [...card.required_concepts],
    })),
    edges: source.edges.map((edge) => ({ from: edge.prerequisite_card_id, to: edge.dependent_card_id })),
  };
}

async function directParity(t) {
  const catalog = definitionCatalog();
  const db = new SqliteD1().applyMigration(); t.after(() => db.close());
  const engine = await engineFor(catalog);
  const service = serviceFor(db, engine);
  const learner = await contextFor(service);
  const storage = createMemoryStorage();
  const direct = createStudyStore({ catalog, storage, clock: () => new Date(FIXED_NOW) });
  const visited = new Set();
  const reads = new Set();

  function invoke(operation, args) {
    // This is the trusted context supplied by registerWebMCPTools. In particular,
    // searchLibrary without it selects a different, legacy Website contract.
    return direct[PARITY_METHODS[operation]](structuredClone(args), {
      source: "webmcp", tool_name: operation,
    });
  }
  async function assertStateParity(operation) {
    const actual = await service.getState(learner);
    assert.equal(actual.state_json, storage.getItem(STORAGE_KEY), `${operation}: exact persisted canonical bytes`);
    const reloaded = createStudyStore({
      catalog, clock: () => new Date(FIXED_NOW),
      storage: createMemoryStorage(actual.state_json === null ? {} : { [STORAGE_KEY]: actual.state_json }),
    });
    assert.deepEqual(reloaded.getSnapshot(), direct.getSnapshot(), `${operation}: rehydrated state`);
    return actual;
  }
  return {
    visited, reads,
    async read(operation, args = {}) {
      assert.ok(PARITY_READ_NAMES.includes(operation), `${operation} must be a read tool`);
      const before = await service.getState(learner);
      const beforeDirect = storage.dump();
      const actual = await service.query(learner, { operation, args });
      assert.deepEqual(actual.result, invoke(operation, args), `${operation}: trusted canonical read result`);
      assert.equal(actual.durable_revision, before.durable_revision);
      assert.deepEqual(await service.getState(learner), before, `${operation}: no durable read mutation`);
      assert.deepEqual(storage.dump(), beforeDirect, `${operation}: no canonical read mutation`);
      await assertStateParity(operation);
      visited.add(operation); reads.add(operation);
      return actual.result;
    },
    async write(operation, args) {
      assert.ok(!PARITY_READ_NAMES.includes(operation), `${operation} must be a write tool`);
      const before = await service.getState(learner);
      const actual = await service.command(learner, command(operation, args, before.durable_revision));
      assert.deepEqual(actual.result, invoke(operation, args), `${operation}: trusted canonical commit result`);
      assert.equal(actual.durable_revision, before.durable_revision + 1);
      await assertStateParity(operation);
      visited.add(operation);
      return actual.result;
    },
  };
}

test("all six read tools match canonical WebMCP dispatch, including empty and filtered Library searches", async (t) => {
  const parity = await directParity(t);
  assert.equal((await parity.read("get_learning_overview")).decks.length, 0);
  assert.equal((await parity.read("list_my_decks")).total_matching, 0);
  const emptyArgs = await parity.read("search_library");
  const emptyQuery = await parity.read("search_library", { query: "" });
  assert.deepEqual(emptyQuery, emptyArgs);
  assert.equal(emptyArgs.total_matching, 1);
  assert.equal(Object.hasOwn(emptyArgs.items[0], "cards"), false, "Library search stays summary-only");
  const filtered = await parity.read("search_library", {
    query: "Persistence", subjects: ["mathematics"], domains: ["mathematics"],
    levels: ["introductory"], limit: 1,
  });
  assert.deepEqual(filtered.items.map((deck) => deck.deck_id), ["backend-fixture"]);
  assert.equal((await parity.read("search_library", { subjects: ["biology"] })).total_matching, 0);
  assert.equal((await parity.read("get_deck", { scope: "library", deck_id: "backend-fixture" })).card_count, 2);
  assert.equal((await parity.read("validate_deck", { source: "candidate", operation: "create", deck: parityDeck() })).ingestible, true);

  const ingested = await parity.write("ingest_deck", { operation: "create", deck: parityDeck(), idempotency_key: "read-parity:ingest" });
  assert.equal((await parity.read("list_my_decks", { query: "parity", status: "all", sort: "title", limit: 1 })).total_matching, 1);
  await parity.read("get_deck", { scope: "personal", deck_id: ingested.deck_id });
  await parity.read("validate_deck", { source: "stored", scope: "personal", deck_id: ingested.deck_id });
  const started = await parity.write("start_study_session", {
    deck_id: ingested.deck_id, limit: 5, idempotency_key: "read-parity:start",
  });
  assert.equal(started.session.total, 1, "the canonical internal prerequisite still gates new cards");
  await parity.read("get_study_session", { session_id: started.session.session_id });
  await parity.read("get_learning_overview");
  assert.deepEqual([...parity.reads].sort(), [...PARITY_READ_NAMES].sort());
});

test("all 13 tools retain direct canonical result and storage parity through authoring, grading, pause, resume, and finish", async (t) => {
  assert.deepEqual(Object.keys(PARITY_METHODS).sort(), [...WEBMCP_TOOL_NAMES].sort(), "cover the entire registered tool surface");
  const parity = await directParity(t);
  await parity.read("get_learning_overview");
  await parity.read("search_library", { query: "" });
  await parity.read("list_my_decks");
  await parity.read("validate_deck", { source: "candidate", operation: "create", deck: parityDeck() });
  const ingested = await parity.write("ingest_deck", { operation: "create", deck: parityDeck(), idempotency_key: "parity:ingest" });
  const metadata = await parity.write("update_deck", {
    deck_id: ingested.deck_id, expected_deck_revision: ingested.deck_revision,
    patch: { title: "Persistence parity revised", subject: "mathematics", domain: "mathematics", level: "introductory" },
    idempotency_key: "parity:metadata",
  });
  const added = await parity.write("add_cards", {
    deck_id: ingested.deck_id, expected_deck_revision: metadata.deck_revision,
    cards: [{
      card_id: `${ingested.deck_id}.collection`, term: "collection", prompt: null,
      definition_md: "A group of objects regarded together.", aliases: [],
      required_concepts: [{ rubric_item_id: "required-1", text: "objects regarded together" }],
      accepted_variants: [], major_error_concepts: [], prerequisite_ids: [], tags: [],
      source_refs: [], difficulty_hint: null, module_ids: [], provenance: null, archived: false,
    }], idempotency_key: "parity:add",
  });
  await parity.write("update_cards", {
    deck_id: ingested.deck_id, expected_deck_revision: added.deck_revision,
    updates: [{ card_id: `${ingested.deck_id}.set`, patch: {
      definition_md: "A well-defined collection of distinct objects, called elements.", tags: ["definition"],
    } }], idempotency_key: "parity:card-edit",
  });
  const deck = await parity.read("get_deck", { scope: "personal", deck_id: ingested.deck_id });
  assert.equal(deck.deck.cards.find((card) => card.card_id === `${ingested.deck_id}.set`).card_revision, 2);
  assert.equal((await parity.read("validate_deck", { source: "stored", scope: "personal", deck_id: ingested.deck_id })).ingestible, true);
  await parity.read("list_my_decks", { query: "revised", sort: "title" });
  const started = await parity.write("start_study_session", {
    deck_id: ingested.deck_id, limit: 5, idempotency_key: "parity:start",
  });
  assert.equal(started.session.total, 2);
  assert.equal(started.current_card.card_id, `${ingested.deck_id}.set`);
  await parity.read("get_study_session", { session_id: started.session.session_id });
  const graded = await parity.write("submit_grade", gradeFor(started, "parity:grade"));
  assert.equal(graded.session.reviewed, 1);
  assert.equal(graded.session.remaining, 1);
  assert.equal(graded.next_card.card_id, `${ingested.deck_id}.collection`, "grading does not rebuild the established queue");
  assert.equal((await parity.read("get_learning_overview")).recent_reviews.length, 1);
  await parity.write("finish_study_session", {
    session_id: graded.session.session_id, expected_session_revision: graded.session.session_revision,
    disposition: "pause", idempotency_key: "parity:pause",
  });
  assert.equal((await parity.read("get_study_session", { session_id: started.session.session_id })).session.status, "paused");
  const resumed = await parity.write("start_study_session", {
    deck_id: ingested.deck_id, limit: 1, idempotency_key: "parity:resume",
  });
  assert.equal(resumed.session.session_id, started.session.session_id);
  assert.equal(resumed.current_card.card_id, graded.next_card.card_id);
  await parity.write("finish_study_session", {
    session_id: resumed.session.session_id, expected_session_revision: resumed.session.session_revision,
    disposition: "end", idempotency_key: "parity:end",
  });
  assert.equal((await parity.read("get_study_session", { session_id: started.session.session_id })).session.status, "finished");
  await parity.read("get_deck", { scope: "personal", deck_id: ingested.deck_id });
  await parity.read("get_learning_overview");
  assert.deepEqual([...parity.visited].sort(), [...WEBMCP_TOOL_NAMES].sort(), "every registered tool executed against both stores");
});
