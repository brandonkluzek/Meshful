import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createMemoryStorage, createStudyStore } from "../js/store.js";
import { DECK_BUILD_GUIDE } from "../js/deck-build-guide.js";
import { GRADING_GUIDE_VERSION } from "../js/grading-guide.js";
import {
  WEBMCP_TOOL_NAMES,
  WEBMCP_TOOL_SCHEMAS,
  registerWebMCPTools,
} from "../js/webmcp.js";

const NOW = "2026-08-29T12:00:00.000Z";
const retainedV2Fixture = JSON.parse(
  await readFile(
    new URL("../../tests/fixtures/deck_generation/order-relations.normalized.json", import.meta.url),
    "utf8",
  ),
);
const EXPECTED_NAMES = [
  "get_learning_overview",
  "search_library",
  "list_my_decks",
  "get_deck",
  "validate_deck",
  "ingest_deck",
  "update_deck",
  "add_cards",
  "update_cards",
  "start_study_session",
  "get_study_session",
  "submit_grade",
  "finish_study_session",
];
const READ_ONLY_NAMES = new Set([
  "get_learning_overview",
  "search_library",
  "list_my_decks",
  "get_deck",
  "validate_deck",
  "get_study_session",
]);
const RETIRED_NAMES = new Set([
  "inspect_app_state",
  "inspect_deck",
  "add_library_deck",
  "search_my_decks",
  "set_deck_archived",
  "inspect_deck_graph",
  "focus_deck_graph",
  "inspect_study_session",
  "capture_answer",
  "preview_review",
  "apply_review",
  "preview_deck_changes",
  "apply_deck_changes",
]);

function makeCatalog(cardCount = 2) {
  const cards = Array.from({ length: cardCount }, (_, index) => ({
    id: `term-${index + 1}`,
    term: `Term ${index + 1}`,
    definition: `Canonical definition ${index + 1}.`,
    accepted_points: [`Definition point ${index + 1}`],
  }));
  return [
    {
      id: cardCount > 50 ? "large-library-deck" : "linear-algebra-i",
      title: cardCount > 50 ? "Large Library Deck" : "Linear Algebra I",
      description: "A definition deck.",
      subject: "mathematics",
      domain: "mathematics",
      level: "introductory",
      version: "1",
      tags: ["definitions"],
      cards,
      edges: cards.slice(1).map((card, index) => ({
        prerequisite_card_id: cards[index].id,
        dependent_card_id: card.id,
      })),
      provenance: {
        origin: "fixture",
        source_outline: "Test fixture.",
        source_records: [],
        notes: "Provider-free test data.",
      },
      evidence_tier: "unclassified",
      rights_status: "unclassified",
    },
  ];
}

function makeStore({ cardCount = 2, storage = createMemoryStorage() } = {}) {
  return createStudyStore({
    catalog: makeCatalog(cardCount),
    storage,
    clock: () => new Date(NOW),
  });
}

function normalizedDeck({ deckId = "agent-deck", cardCount = 1 } = {}) {
  const cards = Array.from({ length: cardCount }, (_, index) => ({
    id: `term-${index + 1}`,
    term: `Agent term ${index + 1}`,
    definition: `Agent definition ${index + 1}.`,
    criteria: [`State definition point ${index + 1}.`],
    tags: [],
  }));
  return {
    schema_version: "normalized-definition-deck.v2",
    deck_id: deckId,
    title: "Agent Definition Deck",
    cards,
    edges: Array.from({ length: Math.max(0, cardCount - 1) }, (_, index) => ({
      from: `term-${index + 1}`,
      to: `term-${index + 2}`,
    })),
  };
}

function completeCandidateCard(deckId, suffix) {
  return {
    card_id: `${deckId}.${suffix}`,
    term: `Added ${suffix}`,
    prompt: null,
    definition_md: `Definition for ${suffix}.`,
    aliases: [],
    required_concepts: [{ rubric_item_id: `required-${suffix}`, text: "State the definition." }],
    accepted_variants: [],
    major_error_concepts: [],
    prerequisite_ids: [`${deckId}.term-1`],
    tags: [],
    source_refs: ["source-1"],
    difficulty_hint: null,
    module_ids: [],
    provenance: null,
    archived: false,
  };
}

function normalizedDeckFromRead(read) {
  const { deck } = read.data;
  return {
    schema_version: "normalized-definition-deck.v2",
    deck_id: deck.deck_id,
    title: deck.title,
    cards: deck.cards
      .filter((card) => !card.archived)
      .map((card) => ({
        id: card.card_id.slice(`${deck.deck_id}.`.length),
        term: card.term,
        definition: card.definition_md,
        criteria: card.required_concepts.map((item) => item.text),
        tags: card.tags,
      })),
    edges: deck.cards.flatMap((card) =>
      card.prerequisite_ids
        .filter((prerequisiteId) => prerequisiteId.startsWith(`${deck.deck_id}.`))
        .map((prerequisiteId) => ({
          from: prerequisiteId.slice(`${deck.deck_id}.`.length),
          to: card.card_id.slice(`${deck.deck_id}.`.length),
        })),
    ),
  };
}

function reviewCodes(result) {
  return result.data.agent_review_required.map((item) => item.code);
}

function withDocument(value, callback) {
  const hadDocument = Object.hasOwn(globalThis, "document");
  const previous = globalThis.document;
  globalThis.document = value;
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      if (hadDocument) globalThis.document = previous;
      else delete globalThis.document;
    });
}

function withWindow(value, callback) {
  const hadWindow = Object.hasOwn(globalThis, "window");
  const previous = globalThis.window;
  globalThis.window = value;
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      if (hadWindow) globalThis.window = previous;
      else delete globalThis.window;
    });
}

async function captureTools(store, registrationOverride, onVisibleEffect) {
  const registrations = [];
  let calls = 0;
  let result;
  await withDocument(
    {
      modelContext: {
        async registerTool(definition) {
          calls += 1;
          if (registrationOverride) await registrationOverride(definition, calls);
          registrations.push(definition);
        },
      },
    },
    async () => {
      result = await registerWebMCPTools({ store, onVisibleEffect });
    },
  );
  return { registrations, calls, result };
}

function execute(registrations, name, input = {}) {
  const definition = registrations.find((candidate) => candidate.name === name);
  assert.ok(definition, `missing registration for ${name}`);
  return definition.execute(input);
}

async function reviewOneCard(registrations, deckId, key) {
  const started = await execute(registrations, "start_study_session", {
    deck_id: deckId,
    limit: 1,
    idempotency_key: `${key}:start`,
  });
  assert.equal(started.ok, true);
  const card = started.data.current_card;
  const graded = await execute(registrations, "submit_grade", {
    session_id: started.data.session.session_id,
    card_id: card.card_id,
    expected_card_revision: card.card_revision,
    expected_session_revision: started.data.session.session_revision,
    answer_text: card.definition_md,
    answer_origin: "chat",
    rating: "good",
    rubric_evidence: card.required_concepts.map((item) => ({
      rubric_item_id: item.rubric_item_id,
      status: "met",
      note: "The learner stated this definition point.",
    })),
    feedback: "Correct definition.",
    misconceptions: [],
    confidence: 0.95,
    idempotency_key: `${key}:grade`,
  });
  assert.equal(graded.ok, true);
  assert.equal(graded.data.session.status, "completed");
  return graded;
}

function assertClosedObjectSchemas(schema, path) {
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, `${path} must reject additional properties`);
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    assertClosedObjectSchemas(child, `${path}.properties.${key}`);
  }
  if (schema.items) assertClosedObjectSchemas(schema.items, `${path}.items`);
  for (const keyword of ["oneOf", "anyOf", "allOf"]) {
    for (const [index, child] of (schema[keyword] ?? []).entries()) {
      assertClosedObjectSchemas(child, `${path}.${keyword}[${index}]`);
    }
  }
}

function assertFailure(result, code) {
  assert.deepEqual(Object.keys(result), ["ok", "error"]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.equal(typeof result.error.retryable, "boolean");
  assert.equal("stack" in result.error, false);
  assert.equal("details" in result.error, false);
  assert.doesNotThrow(() => JSON.stringify(result));
}

test("gracefully preserves the normal website when WebMCP is unavailable", async () => {
  await withDocument(undefined, async () => {
    const result = await registerWebMCPTools({ store: makeStore() });
    assert.equal(result.supported, false);
    assert.deepEqual(result.registered, []);
    assert.match(result.reason, /normal website UI remains usable/);
  });
});

test("registers no site tools from an iframe", async () => {
  const calls = [];
  await withWindow({ top: {} }, async () => {
    await withDocument(
      { modelContext: { registerTool(definition) { calls.push(definition); } } },
      async () => {
        const result = await registerWebMCPTools({ store: makeStore() });
        assert.equal(result.supported, false);
        assert.deepEqual(result.registered, []);
        assert.match(result.reason, /top-level page/);
      },
    );
  });
  assert.equal(calls.length, 0);
});

test("registers the exact target 13 with closed contracts and exact read-only hints", async () => {
  const { registrations, result } = await captureTools(makeStore());
  assert.equal(result.supported, true);
  assert.deepEqual(result.registered, EXPECTED_NAMES);
  assert.deepEqual(WEBMCP_TOOL_NAMES, EXPECTED_NAMES);
  assert.deepEqual(registrations.map(({ name }) => name), EXPECTED_NAMES);
  assert.equal(registrations.length, 13);

  for (const name of ["start_study_session", "get_study_session", "submit_grade"]) {
    assert.ok(
      registrations.find((definition) => definition.name === name).description.includes(GRADING_GUIDE_VERSION),
      `${name} must always expose the grading guide; missing wiring cannot be skipped`,
    );
  }

  for (const definition of registrations) {
    assert.ok(definition.title.length > 3);
    assert.ok(definition.description.length > 60);
    assert.equal(typeof definition.execute, "function");
    assert.equal(
      definition.annotations?.readOnlyHint === true,
      READ_ONLY_NAMES.has(definition.name),
      `${definition.name} read-only hint`,
    );
    assertClosedObjectSchemas(definition.inputSchema, `${definition.name}.input`);
    assertClosedObjectSchemas(WEBMCP_TOOL_SCHEMAS[definition.name].output, `${definition.name}.output`);
    assert.equal("outputSchema" in definition, false, "the current WebMCP API accepts inputSchema only");
  }

  assert.equal(WEBMCP_TOOL_NAMES.some((name) => RETIRED_NAMES.has(name)), false);
  assert.deepEqual(
    Object.keys(WEBMCP_TOOL_SCHEMAS.start_study_session.input.properties).sort(),
    ["deck_id", "idempotency_key", "limit"],
  );
  assert.deepEqual(
    Object.keys(WEBMCP_TOOL_SCHEMAS.get_deck.input.properties).sort(),
    ["deck_id", "scope"],
  );
  assert.deepEqual(
    Object.keys(WEBMCP_TOOL_SCHEMAS.submit_grade.input.properties).sort(),
    [
      "answer_origin",
      "answer_text",
      "card_id",
      "confidence",
      "expected_card_revision",
      "expected_session_revision",
      "feedback",
      "idempotency_key",
      "misconceptions",
      "rating",
      "rubric_evidence",
      "session_id",
    ],
  );
});

test("registered validation guidance distinguishes structural checks from required Study prerequisites", async () => {
  const { registrations } = await captureTools(makeStore());
  const validation = registrations.find(({ name }) => name === "validate_deck");
  assert.ok(validation.description.includes(
    "This check does not certify external prerequisite targets or semantics; Study still enforces retained required prerequisites before a card's first introduction.",
  ));
  assert.doesNotMatch(validation.description, /Cross-deck references are retained as metadata, not verified study gates/);
  assert.ok(validation.description.endsWith(DECK_BUILD_GUIDE), "the complete authoring guide remains unchanged");
  assert.deepEqual(validation.inputSchema, WEBMCP_TOOL_SCHEMAS.validate_deck.input);
});

test("preflights all target store handlers before registering any tool", async () => {
  const incomplete = { ...makeStore(), submitGrade: undefined };
  const { calls, registrations, result } = await captureTools(incomplete);
  assert.equal(result.supported, true);
  assert.deepEqual(result.registered, []);
  assert.equal(result.failed.code, "STORE_CONTRACT_INCOMPLETE");
  assert.deepEqual(result.failed.missing_methods, ["submitGrade"]);
  assert.equal(calls, 0);
  assert.equal(registrations.length, 0);
});

test("partial registration leaves every earlier tool fail-closed", async () => {
  const registrations = [];
  let calls = 0;
  await withDocument(
    {
      modelContext: {
        registerTool(definition) {
          calls += 1;
          if (calls === 3) throw new Error("registration interrupted");
          registrations.push(definition);
        },
      },
    },
    async () => {
      const result = await registerWebMCPTools({ store: makeStore() });
      assert.equal(result.failed.code, "REGISTRATION_FAILED");
      assert.equal(result.failed.tool_name, "list_my_decks");
      assert.deepEqual(result.registered, EXPECTED_NAMES.slice(0, 2));
      for (const definition of registrations) {
        assertFailure(await definition.execute({}), "TOOL_SURFACE_UNAVAILABLE");
      }
    },
  );
});

test("rejects extra input before execution and rejects retired study ceremony fields", async () => {
  let overviewCalls = 0;
  const base = makeStore();
  const store = {
    ...base,
    getLearningOverview(...args) {
      overviewCalls += 1;
      return base.getLearningOverview(...args);
    },
  };
  const { registrations } = await captureTools(store);

  const extra = await execute(registrations, "get_learning_overview", { route: "graph" });
  assertFailure(extra, "INVALID_TOOL_INPUT");
  assert.equal(extra.error.issues[0].path, "input.route");
  assert.equal(overviewCalls, 0);

  const mode = await execute(registrations, "start_study_session", {
    deck_id: "agent-deck",
    mode: "repair",
    idempotency_key: "bad-mode",
  });
  assertFailure(mode, "INVALID_TOOL_INPUT");
  assert.equal(mode.error.issues[0].path, "input.mode");

  const paging = await execute(registrations, "get_deck", {
    scope: "library",
    deck_id: "linear-algebra-i",
    limit: 1,
  });
  assertFailure(paging, "INVALID_TOOL_INPUT");

  const ceremony = await execute(registrations, "submit_grade", {
    session_id: "session-1",
    card_id: "agent-deck.term-1",
    expected_card_revision: 1,
    expected_session_revision: 1,
    answer_text: "Definition",
    answer_origin: "chat",
    rating: "good",
    rubric_evidence: [],
    feedback: "Accurate definition.",
    misconceptions: [],
    confidence: 0.9,
    capture_id: "retired-capture",
    idempotency_key: "bad-ceremony",
  });
  assertFailure(ceremony, "INVALID_TOOL_INPUT");
  assert.equal(ceremony.error.issues[0].path, "input.capture_id");
});

test("fails closed on malformed handler output", async () => {
  const base = makeStore();
  const store = {
    ...base,
    getLearningOverview() {
      return {
        as_of: NOW,
        due_total: 0,
        new_available_total: 0,
        decks: [],
        recent_reviews: [],
        route: "graph",
      };
    },
  };
  const { registrations } = await captureTools(store);
  const result = await execute(registrations, "get_learning_overview");
  assertFailure(result, "INVALID_TOOL_OUTPUT");
  assert.equal(result.error.issues[0].path, "data.route");
});

test("returns closed JSON-safe store errors without stack or arbitrary details", async () => {
  const { registrations } = await captureTools(makeStore());
  const result = await execute(registrations, "get_study_session", {
    session_id: "missing-session",
  });
  assertFailure(result, "SESSION_NOT_FOUND");
});

for (const toolName of ["get_study_session", "submit_grade", "finish_study_session"]) {
  test(`${toolName} rejects inherited session identities without changing the active session`, async () => {
    const storage = createMemoryStorage();
    const store = makeStore({ storage });
    const effects = [];
    const { registrations } = await captureTools(store, undefined, (effect) => effects.push(effect));
    const ingested = await execute(registrations, "ingest_deck", {
      operation: "create",
      deck: normalizedDeck(),
      idempotency_key: `${toolName}:session-identity:create`,
    });
    assert.equal(ingested.ok, true);
    const started = await execute(registrations, "start_study_session", {
      deck_id: ingested.data.deck_id,
      limit: 1,
      idempotency_key: `${toolName}:session-identity:start`,
    });
    assert.equal(started.ok, true);
    const card = started.data.current_card;
    const before = store.getSnapshot();
    const persistedBefore = storage.dump();
    effects.length = 0;

    for (const sessionId of ["missing-session", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
      const input = toolName === "get_study_session"
        ? { session_id: sessionId }
        : toolName === "finish_study_session"
          ? {
              session_id: sessionId,
              expected_session_revision: started.data.session.session_revision,
              disposition: "end",
              idempotency_key: `${toolName}:session-identity:${sessionId}`,
            }
          : {
              session_id: sessionId,
              card_id: card.card_id,
              expected_card_revision: card.card_revision,
              expected_session_revision: started.data.session.session_revision,
              answer_text: "Synthetic answer.",
              answer_origin: "chat",
              rating: "good",
              rubric_evidence: card.required_concepts.map((item) => ({
                rubric_item_id: item.rubric_item_id,
                status: "met",
                note: "Synthetic test evidence.",
              })),
              feedback: "Synthetic feedback.",
              misconceptions: [],
              confidence: 1,
              idempotency_key: `${toolName}:session-identity:${sessionId}`,
            };
      assertFailure(await execute(registrations, toolName, input), "SESSION_NOT_FOUND");
      assert.deepEqual(store.getSnapshot(), before);
      assert.deepEqual(storage.dump(), persistedBefore);
      assert.deepEqual(effects, []);
    }

    const reloaded = makeStore({ storage });
    assert.deepEqual(reloaded.getSnapshot(), before);
    assert.deepEqual(
      reloaded.getStudySession({ session_id: started.data.session.session_id }),
      { session: started.data.session, current_card: started.data.current_card },
    );
  });
}

test("uses summary-only Library search and returns one complete deck above 50 cards", async () => {
  const store = makeStore({ cardCount: 60 });
  const beforeView = store.getSnapshot().view;
  const { registrations } = await captureTools(store);

  const searched = await execute(registrations, "search_library", {
    query: "large",
    limit: 10,
  });
  assert.deepEqual(Object.keys(searched), ["ok", "data"]);
  assert.equal(searched.ok, true);
  assert.equal(searched.data.total_matching, 1);
  assert.equal(searched.data.items.length, 1);
  assert.equal("cards" in searched.data.items[0], false);

  const read = await execute(registrations, "get_deck", {
    scope: "library",
    deck_id: "large-library-deck",
  });
  assert.equal(read.ok, true);
  assert.equal(read.data.complete, true);
  assert.equal(read.data.card_count, 60);
  assert.equal(read.data.deck.cards.length, 60);
  assert.equal("next_cursor" in read.data, false);
  assert.deepEqual(read.data.deck.cards[1].prerequisite_ids, ["large-library-deck.term-1"]);
  assert.deepEqual(store.getSnapshot().view, beforeView);
});

test("list_my_decks lists summaries without a query and supports optional pagination without side effects", async () => {
  const storage = createMemoryStorage();
  const store = makeStore({ storage });
  const effects = [];
  const { registrations } = await captureTools(store, undefined, (effect) => effects.push(effect));
  for (const deckId of ["alpha", "beta"]) {
    const deck = normalizedDeck({ deckId });
    deck.title = `${deckId} definitions`;
    const created = await execute(registrations, "ingest_deck", {
      operation: "create", deck, idempotency_key: `list-decks:${deckId}`,
    });
    assert.equal(created.ok, true);
  }
  effects.length = 0;
  const before = store.getSnapshot();
  const beforeStorage = storage.dump();
  const all = await execute(registrations, "list_my_decks");
  assert.equal(all.ok, true);
  assert.equal(all.data.total_matching, 2);
  assert.equal(all.data.items.length, 2);
  assert.ok(all.data.items.every((item) => !("cards" in item)));
  const first = await execute(registrations, "list_my_decks", { sort: "title", limit: 1 });
  assert.equal(first.data.items[0].deck_id, "alpha");
  const second = await execute(registrations, "list_my_decks", {
    sort: "title", limit: 1, cursor: first.data.next_cursor,
  });
  assert.equal(second.data.items[0].deck_id, "beta");
  assert.equal("next_cursor" in second.data, false);
  assert.deepEqual(store.getSnapshot(), before);
  assert.deepEqual(storage.dump(), beforeStorage);
  assert.deepEqual(effects, []);
});

test("routes validation and all targeted deck writes through closed atomic actions", async () => {
  const store = makeStore();
  const beforeView = store.getSnapshot().view;
  const { registrations } = await captureTools(store);
  const deck = normalizedDeck({ deckId: "agent-deck" });

  const validated = await execute(registrations, "validate_deck", {
    source: "candidate",
    operation: "create",
    deck,
  });
  assert.equal(validated.ok, true);
  assert.equal(validated.data.ingestible, true);
  assert.equal(validated.data.blockers.length, 0);
  assert.ok(validated.data.agent_review_required.length > 0);

  const ingested = await execute(registrations, "ingest_deck", {
    operation: "create",
    deck,
    idempotency_key: "deck:create",
  });
  assert.equal(ingested.ok, true);
  assert.equal(ingested.data.deck_revision, 1);
  assert.equal(ingested.data.receipt.operation, "ingest_deck");

  const updatedDeck = await execute(registrations, "update_deck", {
    deck_id: "agent-deck",
    expected_deck_revision: 1,
    patch: { title: "Updated Agent Deck" },
    idempotency_key: "deck:update-metadata",
  });
  assert.equal(updatedDeck.ok, true);
  assert.deepEqual(updatedDeck.data.changed_fields, ["title"]);
  assert.equal(updatedDeck.data.deck_revision, 2);

  const added = await execute(registrations, "add_cards", {
    deck_id: "agent-deck",
    expected_deck_revision: 2,
    cards: [completeCandidateCard("agent-deck", "added")],
    idempotency_key: "deck:add-card",
  });
  assert.equal(added.ok, true);
  assert.deepEqual(added.data.added_card_ids, ["agent-deck.added"]);
  assert.equal(added.data.deck_revision, 3);

  const archived = await execute(registrations, "update_cards", {
    deck_id: "agent-deck",
    expected_deck_revision: 3,
    updates: [{ card_id: "agent-deck.added", patch: { archived: true } }],
    idempotency_key: "deck:archive-card",
  });
  assert.equal(archived.ok, true);
  assert.equal(archived.data.deck_revision, 4);
  assert.deepEqual(archived.data.updates[0].changed_fields, ["archived"]);
  assert.equal(archived.data.updates[0].scheduling_result, "preserved");

  const personal = await execute(registrations, "list_my_decks", {
    query: "updated",
    status: "active",
  });
  assert.equal(personal.ok, true);
  assert.equal(personal.data.items.length, 1);
  assert.equal("cards" in personal.data.items[0], false);

  const complete = await execute(registrations, "get_deck", {
    scope: "personal",
    deck_id: "agent-deck",
  });
  assert.equal(complete.ok, true);
  assert.equal(complete.data.card_count, 2);
  assert.equal(complete.data.archived_card_count, 1);
  assert.equal(
    complete.data.deck.cards.find((card) => card.card_id === "agent-deck.added").archived,
    true,
  );
  assert.deepEqual(store.getSnapshot().view, beforeView);
});

test("every new non-grade commit emits one route-neutral current-view refresh signal", async () => {
  const store = makeStore();
  const effects = [];
  const contexts = [];
  const beforeView = store.getSnapshot().view;
  const { registrations } = await captureTools(store, undefined, (effect, context) => {
    effects.push(effect);
    contexts.push(context);
  });
  const deck = normalizedDeck({ deckId: "reactive-deck", cardCount: 2 });
  const ingestInput = {
    operation: "create",
    deck,
    idempotency_key: "reactive:ingest",
  };

  const ingested = await execute(registrations, "ingest_deck", ingestInput);
  assert.equal(ingested.ok, true);
  const replayed = await execute(registrations, "ingest_deck", ingestInput);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.data.receipt.replayed, true);

  const updatedDeck = await execute(registrations, "update_deck", {
    deck_id: "reactive-deck",
    expected_deck_revision: 1,
    patch: { title: "Reactive Deck Updated" },
    idempotency_key: "reactive:update-deck",
  });
  assert.equal(updatedDeck.ok, true);

  const added = await execute(registrations, "add_cards", {
    deck_id: "reactive-deck",
    expected_deck_revision: 2,
    cards: [completeCandidateCard("reactive-deck", "added")],
    idempotency_key: "reactive:add-card",
  });
  assert.equal(added.ok, true);

  const updatedCards = await execute(registrations, "update_cards", {
    deck_id: "reactive-deck",
    expected_deck_revision: 3,
    updates: [{ card_id: "reactive-deck.added", patch: { tags: ["refreshed"] } }],
    idempotency_key: "reactive:update-card",
  });
  assert.equal(updatedCards.ok, true);

  const started = await execute(registrations, "start_study_session", {
    deck_id: "reactive-deck",
    limit: 2,
    idempotency_key: "reactive:start",
  });
  assert.equal(started.ok, true);

  const finished = await execute(registrations, "finish_study_session", {
    session_id: started.data.session.session_id,
    disposition: "pause",
    expected_session_revision: started.data.session.session_revision,
    idempotency_key: "reactive:pause",
  });
  assert.equal(finished.ok, true);

  assert.deepEqual(effects.map((effect) => effect.tool_name), [
    "ingest_deck",
    "update_deck",
    "add_cards",
    "update_cards",
    "start_study_session",
    "finish_study_session",
  ]);
  for (const effect of effects) {
    assert.deepEqual(Object.keys(effect), ["type", "tool_name", "transaction_id", "app_revision"]);
    assert.equal(effect.type, "webmcp_state_committed");
    assert.equal(typeof effect.transaction_id, "string");
    assert.equal(Number.isInteger(effect.app_revision), true);
  }
  assert.deepEqual(contexts.map((context) => context.tool_name), effects.map((effect) => effect.tool_name));

  const beforeReadEffectCount = effects.length;
  const read = await execute(registrations, "get_deck", {
    scope: "personal",
    deck_id: "reactive-deck",
  });
  assert.equal(read.ok, true);
  assert.equal(effects.length, beforeReadEffectCount, "reads must not request a visible refresh");
  assert.deepEqual(store.getSnapshot().view, beforeView, "refresh signals must not change route or selection");
});

test("retained v2 fixture validates, ingests, and returns all cards, edges, Markdown, and derived criteria", async () => {
  const store = makeStore();
  const beforeView = store.getSnapshot().view;
  const { registrations } = await captureTools(store);

  const validated = await execute(registrations, "validate_deck", {
    source: "candidate",
    operation: "create",
    deck: retainedV2Fixture,
  });
  assert.equal(validated.ok, true);
  assert.equal(validated.data.ingestible, true);
  assert.deepEqual(validated.data.blockers, []);

  const ingested = await execute(registrations, "ingest_deck", {
    operation: "create",
    deck: retainedV2Fixture,
    idempotency_key: "fixture:order-relations:v2",
  });
  assert.equal(ingested.ok, true);
  assert.equal(ingested.data.added_card_ids.length, 8);
  assert.equal(ingested.data.receipt.operation, "ingest_deck");

  const read = await execute(registrations, "get_deck", {
    scope: "personal",
    deck_id: "order-relations",
  });
  assert.equal(read.ok, true);
  assert.equal(read.data.complete, true);
  assert.equal(read.data.card_count, 8);
  assert.equal(read.data.prerequisite_edge_count, 9);
  assert.deepEqual(
    read.data.deck.cards.map((card) => card.card_id),
    retainedV2Fixture.cards.map((card) => `order-relations.${card.id}`),
  );
  const cartesian = read.data.deck.cards.find((card) => card.card_id === "order-relations.cartesian-product");
  assert.equal(cartesian.definition_md, retainedV2Fixture.cards[1].definition);
  assert.deepEqual(
    cartesian.required_concepts.map((item) => item.rubric_item_id),
    ["required-1", "required-2"],
  );
  const partialOrder = read.data.deck.cards.find((card) => card.card_id === "order-relations.partial-order");
  assert.deepEqual(partialOrder.prerequisite_ids.sort(), [
    "order-relations.antisymmetric-relation",
    "order-relations.reflexive-relation",
    "order-relations.transitive-relation",
  ]);
  assert.equal(read.data.deck.provenance.origin, "unclassified");
  assert.deepEqual(read.data.deck.provenance.source_records, []);
  assert.deepEqual(cartesian.source_refs, []);
  assert.deepEqual(store.getSnapshot().view, beforeView);
});

test("v2 edge and DAG failures never mutate state", async () => {
  const invalidCases = [
    {
      label: "unresolved endpoint",
      mutate(deck) { deck.edges.push({ from: "missing-card", to: "set" }); },
      blocker: "UNRESOLVED_EDGE_ENDPOINT",
    },
    {
      label: "cycle",
      mutate(deck) { deck.edges.push({ from: "total-order", to: "set" }); },
      blocker: "DAG_CYCLE",
    },
  ];

  for (const invalidCase of invalidCases) {
    const store = makeStore();
    const { registrations } = await captureTools(store);
    const deck = structuredClone(retainedV2Fixture);
    invalidCase.mutate(deck);
    const before = store.getSnapshot();

    const validated = await execute(registrations, "validate_deck", {
      source: "candidate",
      operation: "create",
      deck,
    });
    assert.equal(validated.ok, true, invalidCase.label);
    assert.equal(validated.data.ingestible, false, invalidCase.label);
    assert.ok(validated.data.blockers.some((item) => item.code === invalidCase.blocker), invalidCase.label);
    assert.deepEqual(store.getSnapshot(), before, `${invalidCase.label} validation must be read-only`);

    const ingested = await execute(registrations, "ingest_deck", {
      operation: "create",
      deck,
      idempotency_key: `invalid:${invalidCase.label.replaceAll(" ", "-")}`,
    });
    assertFailure(ingested, "DECK_VALIDATION_BLOCKED");
    assert.deepEqual(store.getSnapshot(), before, `${invalidCase.label} ingestion must be atomic`);
  }

  const store = makeStore();
  const { registrations } = await captureTools(store);
  const duplicateEdgeDeck = structuredClone(retainedV2Fixture);
  duplicateEdgeDeck.edges.push(structuredClone(duplicateEdgeDeck.edges[0]));
  const before = store.getSnapshot();
  const rejected = await execute(registrations, "validate_deck", {
    source: "candidate",
    operation: "create",
    deck: duplicateEdgeDeck,
  });
  assertFailure(rejected, "INVALID_TOOL_INPUT");
  assert.deepEqual(store.getSnapshot(), before, "duplicate-edge schema rejection must not mutate state");
});

test("personal get_deck card IDs round-trip through update_cards within the requested deck", async () => {
  const store = makeStore();
  const installed = store.addLibraryDeck({
    library_deck_id: "linear-algebra-i",
    expected_catalog_version: "1",
    client_action_id: "install-for-card-round-trip",
  });
  const { registrations } = await captureTools(store);

  const read = await execute(registrations, "get_deck", {
    scope: "personal",
    deck_id: installed.deck.id,
  });
  assert.equal(read.ok, true);
  assert.equal(read.data.deck.cards[0].card_id, `${installed.deck.id}.term-1`);
  assert.deepEqual(read.data.deck.cards[1].prerequisite_ids, [`${installed.deck.id}.term-1`]);

  const qualifiedUpdate = await execute(registrations, "update_cards", {
    deck_id: installed.deck.id,
    expected_deck_revision: read.data.deck.deck_revision,
    updates: [{ card_id: read.data.deck.cards[0].card_id, patch: { tags: ["qualified"] } }],
    idempotency_key: "round-trip:qualified",
  });
  assert.equal(qualifiedUpdate.ok, true);
  assert.equal(qualifiedUpdate.data.updates[0].card_id, "term-1");

  const internalUpdate = await execute(registrations, "update_cards", {
    deck_id: installed.deck.id,
    expected_deck_revision: qualifiedUpdate.data.deck_revision,
    updates: [{ card_id: "term-2", patch: { tags: ["internal"] } }],
    idempotency_key: "round-trip:internal",
  });
  assert.equal(internalUpdate.ok, true);
  assert.equal(internalUpdate.data.updates[0].card_id, "term-2");

  const wrongDeck = await execute(registrations, "update_cards", {
    deck_id: installed.deck.id,
    expected_deck_revision: internalUpdate.data.deck_revision,
    updates: [{ card_id: "another-deck.term-1", patch: { tags: ["wrong-scope"] } }],
    idempotency_key: "round-trip:wrong-deck",
  });
  assertFailure(wrongDeck, "CARD_NOT_FOUND");

  const aliasDuplicate = await execute(registrations, "update_cards", {
    deck_id: installed.deck.id,
    expected_deck_revision: internalUpdate.data.deck_revision,
    updates: [
      { card_id: "term-1", patch: { tags: ["first-alias"] } },
      { card_id: `${installed.deck.id}.term-1`, patch: { tags: ["second-alias"] } },
    ],
    idempotency_key: "round-trip:duplicate-alias",
  });
  assertFailure(aliasDuplicate, "DUPLICATE_CARD_ID");
  assert.equal(store.getSnapshot().personalDecks[installed.deck.id].revision, internalUpdate.data.deck_revision);
});

test("card metadata and qualified prerequisite round-trips preserve installed edges and explicit removals survive reload", async () => {
  const storage = createMemoryStorage();
  const store = makeStore({ cardCount: 3, storage });
  const installed = store.addLibraryDeck({
    library_deck_id: "linear-algebra-i",
    expected_catalog_version: "1",
    client_action_id: "edge-round-trip:install",
  });
  const deckId = installed.deck.id;
  const { registrations } = await captureTools(store);
  const beforeView = store.getSnapshot().view;
  const read = await execute(registrations, "get_deck", { scope: "personal", deck_id: deckId });
  const metadata = await execute(registrations, "update_cards", {
    deck_id: deckId,
    expected_deck_revision: read.data.deck.deck_revision,
    updates: [{ card_id: `${deckId}.term-1`, patch: { tags: ["reviewed"] } }],
    idempotency_key: "edge-round-trip:metadata",
  });
  assert.equal(metadata.ok, true);
  assert.equal(store.getSnapshot().personalDecks[deckId].edges.length, 2);

  const unchanged = await execute(registrations, "update_cards", {
    deck_id: deckId,
    expected_deck_revision: metadata.data.deck_revision,
    updates: [{
      card_id: `${deckId}.term-3`,
      patch: { prerequisite_ids: read.data.deck.cards[2].prerequisite_ids },
    }],
    idempotency_key: "edge-round-trip:unchanged",
  });
  assert.equal(unchanged.ok, true);
  assert.deepEqual(unchanged.data.updates[0].changed_fields, []);
  const after = await execute(registrations, "get_deck", { scope: "personal", deck_id: deckId });
  assert.equal(after.data.prerequisite_edge_count, 2);
  assert.equal(after.data.cross_deck_edge_count, 0);

  const removed = await execute(registrations, "update_cards", {
    deck_id: deckId,
    expected_deck_revision: unchanged.data.deck_revision,
    updates: [{ card_id: `${deckId}.term-3`, patch: { prerequisite_ids: [] } }],
    idempotency_key: "edge-round-trip:remove",
  });
  assert.equal(removed.ok, true);
  const reloaded = makeStore({ cardCount: 3, storage });
  const finalRead = reloaded.getDeck({ scope: "personal", deck_id: deckId });
  assert.equal(finalRead.prerequisite_edge_count, 1);
  assert.deepEqual(finalRead.deck.cards[2].prerequisite_ids, []);
  assert.deepEqual(reloaded.getSnapshot().view, beforeView);
  const started = reloaded.startStudySession({
    deck_id: deckId,
    limit: 3,
    idempotency_key: "edge-round-trip:start",
  });
  assert.equal(started.session.total, 2, "only the two prerequisite-free cards may enter the new queue");
});

test("targeted card writes reject invalid final structure with zero state, storage, or visible effects", async () => {
  const deckId = "deck-linear-algebra-i";
  const cases = [
    { label: "missing qualified prerequisite", code: "UNRESOLVED_PREREQUISITE", updates: [
      { card_id: "term-2", patch: { prerequisite_ids: [`${deckId}.missing`] } },
    ] },
    { label: "missing local prerequisite", code: "UNRESOLVED_PREREQUISITE", updates: [
      { card_id: "term-2", patch: { prerequisite_ids: ["missing"] } },
    ] },
    { label: "duplicate term", code: "DUPLICATE_TERM", updates: [
      { card_id: "term-2", patch: { term: " TERM 1 " } },
    ] },
    { label: "duplicate grading criterion identity", code: "DUPLICATE_CRITERION_ID", updates: [
      { card_id: "term-2", patch: { required_concepts: [
        { rubric_item_id: "same-criterion", text: "First required point." },
        { rubric_item_id: "same-criterion", text: "Second required point." },
      ] } },
    ] },
    { label: "aliased duplicate prerequisite", code: "DUPLICATE_PREREQUISITE", updates: [
      { card_id: "term-2", patch: { prerequisite_ids: ["term-1", `${deckId}.term-1`] } },
    ] },
    { label: "self prerequisite", code: "SELF_PREREQUISITE", updates: [
      { card_id: "term-1", patch: { prerequisite_ids: [`${deckId}.term-1`] } },
    ] },
    { label: "cycle through installed edge", code: "DAG_CYCLE", updates: [
      { card_id: "term-1", patch: { prerequisite_ids: [`${deckId}.term-2`] } },
    ] },
    { label: "archive required card", code: "ARCHIVED_PREREQUISITE", updates: [
      { card_id: "term-1", patch: { archived: true } },
    ] },
    { label: "archive every card", code: "EMPTY_DECK", updates: [
      { card_id: "term-1", patch: { archived: true } },
      { card_id: "term-2", patch: { archived: true } },
    ] },
    { label: "added duplicate term", code: "DUPLICATE_TERM", cards: [
      { ...completeCandidateCard(deckId, "added"), term: "term 1" },
    ] },
    { label: "added missing prerequisite", code: "UNRESOLVED_PREREQUISITE", cards: [
      { ...completeCandidateCard(deckId, "added"), prerequisite_ids: [`${deckId}.missing`] },
    ] },
  ];
  for (const fixture of cases) {
    const storage = createMemoryStorage();
    const store = makeStore({ storage });
    const installed = store.addLibraryDeck({
      library_deck_id: "linear-algebra-i",
      expected_catalog_version: "1",
      client_action_id: "invalid-edit:install",
    });
    assert.equal(installed.deck.id, deckId);
    const effects = [];
    const { registrations } = await captureTools(store, undefined, (effect) => effects.push(effect));
    const before = store.getSnapshot();
    const beforeStorage = storage.dump();
    const result = await execute(registrations, fixture.cards ? "add_cards" : "update_cards", {
      deck_id: installed.deck.id,
      expected_deck_revision: installed.deck.revision,
      ...(fixture.cards ? { cards: fixture.cards } : { updates: fixture.updates }),
      idempotency_key: `invalid-edit:${fixture.label.replaceAll(" ", "-")}`,
    });
    assert.equal(result.ok, false, fixture.label);
    assertFailure(result, fixture.code);
    assert.deepEqual(store.getSnapshot(), before, fixture.label);
    assert.deepEqual(storage.dump(), beforeStorage, fixture.label);
    assert.deepEqual(effects, [], fixture.label);
  }
});

test("unchanged read-to-update preserves learning and canonical Markdown bytes; material edits reset only the schedule", async () => {
  for (const kind of ["catalog-rubric-fallback", "v2-whitespace"]) {
    const store = makeStore();
    const { registrations } = await captureTools(store);
    let deckId;
    if (kind === "catalog-rubric-fallback") {
      deckId = store.addLibraryDeck({
        library_deck_id: "linear-algebra-i",
        expected_catalog_version: "1",
        client_action_id: `${kind}:install`,
      }).deck.id;
    } else {
      const deck = normalizedDeck({ deckId: kind });
      deck.cards[0].definition = "\n    canonical_code()\n\n$$x^2$$\nTrailing prose.\n";
      deck.cards[0].criteria = ["  Preserve this criterion's exact text.\n"];
      const created = await execute(registrations, "ingest_deck", {
        operation: "create", deck, idempotency_key: `${kind}:create`,
      });
      assert.equal(created.ok, true);
      deckId = created.data.deck_id;
    }
    const validation = await execute(registrations, "validate_deck", {
      source: "stored", scope: "personal", deck_id: deckId,
    });
    assert.equal(validation.ok, true, kind);
    assert.equal(validation.data.warnings.some((item) => item.code === "SPARSE_REQUIRED_RUBRIC"), false, kind);
    await reviewOneCard(registrations, deckId, `${kind}:review`);
    const read = await execute(registrations, "get_deck", { scope: "personal", deck_id: deckId });
    const { card_id, card_revision, scheduling, ...patch } = read.data.deck.cards[0];
    const unchanged = await execute(registrations, "update_cards", {
      deck_id: deckId,
      expected_deck_revision: read.data.deck.deck_revision,
      updates: [{ card_id, patch }],
      idempotency_key: `${kind}:unchanged`,
    });
    assert.equal(unchanged.ok, true, kind);
    assert.equal(unchanged.data.updates[0].scheduling_result, "preserved", kind);
    const after = await execute(registrations, "get_deck", { scope: "personal", deck_id: deckId });
    assert.equal(after.data.deck.cards[0].definition_md, patch.definition_md, kind);
    assert.deepEqual(after.data.deck.cards[0].required_concepts, patch.required_concepts, kind);
    assert.deepEqual(after.data.deck.cards[0].scheduling, scheduling, kind);
    const correctedDefinition = "\nA materially corrected **canonical definition**.\n";
    const changed = await execute(registrations, "update_cards", {
      deck_id: deckId,
      expected_deck_revision: unchanged.data.deck_revision,
      updates: [{ card_id, patch: { definition_md: correctedDefinition } }],
      idempotency_key: `${kind}:changed`,
    });
    assert.equal(changed.ok, true, kind);
    assert.equal(changed.data.updates[0].scheduling_result, "reset", kind);
    const finalRead = await execute(registrations, "get_deck", { scope: "personal", deck_id: deckId });
    assert.equal(finalRead.data.deck.cards[0].definition_md, correctedDefinition, kind);
    assert.equal(finalRead.data.deck.cards[0].scheduling.repetitions, 0, kind);
    const reviewedCard = Object.values(store.getSnapshot().personalDecks[deckId].cards)
      .find((card) => card.reviewHistory.length);
    assert.equal(reviewedCard.reviewHistory.length, 1, kind);
    const addedCard = completeCandidateCard(deckId, "byte-preserved");
    addedCard.definition_md = "\n    another_canonical_block()\n";
    addedCard.required_concepts[0].text = "  Keep the criterion bytes.\n";
    const added = await execute(registrations, "add_cards", {
      deck_id: deckId,
      expected_deck_revision: changed.data.deck_revision,
      cards: [addedCard],
      idempotency_key: `${kind}:add`,
    });
    assert.equal(added.ok, true, kind);
    const addedRead = await execute(registrations, "get_deck", { scope: "personal", deck_id: deckId });
    const addedResult = addedRead.data.deck.cards.find((card) => card.card_id === addedCard.card_id);
    assert.equal(addedResult.definition_md, addedCard.definition_md, kind);
    assert.deepEqual(addedResult.required_concepts, addedCard.required_concepts, kind);
  }
});

test("update_cards can restore an archived card without losing its scheduling or review history", async () => {
  const storage = createMemoryStorage();
  const store = makeStore({ storage });
  const installed = store.addLibraryDeck({
    library_deck_id: "linear-algebra-i",
    expected_catalog_version: "1",
    client_action_id: "restore-card:install",
  });
  const deckId = installed.deck.id;
  const effects = [];
  const { registrations } = await captureTools(store, undefined, (effect) => effects.push(effect));
  await reviewOneCard(registrations, deckId, "restore-card:first");
  await reviewOneCard(registrations, deckId, "restore-card:second");
  const before = store.getSnapshot().personalDecks[deckId];
  const archived = await execute(registrations, "update_cards", {
    deck_id: deckId,
    expected_deck_revision: before.revision,
    updates: [{ card_id: `${deckId}.term-2`, patch: { archived: true } }],
    idempotency_key: "restore-card:archive",
  });
  assert.equal(archived.ok, true);
  effects.length = 0;
  const restoreArgs = {
    deck_id: deckId,
    expected_deck_revision: archived.data.deck_revision,
    updates: [{ card_id: `${deckId}.term-2`, patch: { archived: false } }],
    idempotency_key: "restore-card:restore",
  };
  const restored = await execute(registrations, "update_cards", restoreArgs);
  assert.equal(restored.ok, true);
  assert.equal(restored.data.updates[0].scheduling_result, "preserved");
  const replayed = await execute(registrations, "update_cards", restoreArgs);
  assert.equal(replayed.data.receipt.replayed, true);
  assert.equal(effects.length, 1, "replay must not repeat the committed-state callback");
  const after = makeStore({ storage }).getSnapshot().personalDecks[deckId];
  assert.equal(after.cards["term-2"].archived, false);
  assert.deepEqual(after.cards["term-2"].review, before.cards["term-2"].review);
  assert.deepEqual(after.cards["term-2"].reviewHistory, before.cards["term-2"].reviewHistory);
  assert.equal(after.cards["term-2"].reviewHistory.length, 1);
  assert.equal(after.edges.length, 1);
});

test("validate_deck rechecks stored structural defects without modifying the stored bytes", async () => {
  const cases = [
    { code: "DUPLICATE_TERM", mutate(deck) { deck.cards["term-2"].term = "term 1"; } },
    { code: "UNRESOLVED_PREREQUISITE", mutate(deck) {
      deck.cards["term-2"].prerequisiteIds = [`${deck.id}.missing`];
    } },
    { code: "DAG_CYCLE", mutate(deck) { deck.cards["term-1"].prerequisiteIds = [`${deck.id}.term-2`]; } },
    { code: "EMPTY_DECK", mutate(deck) { Object.values(deck.cards).forEach((card) => { card.archived = true; }); } },
    { code: "INVALID_ARGUMENT", mutate(deck) { deck.cards["term-1"].definition = ""; } },
    { code: "CARD_IDENTITY_COLLISION", mutate(deck) {
      const id = `${deck.id}.term-1`;
      deck.cards[id] = { ...structuredClone(deck.cards["term-1"]), id };
      deck.cardOrder.push(id);
    } },
  ];
  for (const fixture of cases) {
    const original = makeStore();
    const installed = original.addLibraryDeck({
      library_deck_id: "linear-algebra-i",
      expected_catalog_version: "1",
      client_action_id: "stored-validation:install",
    });
    const snapshot = original.getSnapshot();
    fixture.mutate(snapshot.personalDecks[installed.deck.id]);
    const storage = createMemoryStorage({
      "adaptive-study-lab:web-state:v1": JSON.stringify(snapshot),
    });
    const store = makeStore({ storage });
    const before = storage.dump();
    const { registrations } = await captureTools(store);
    const result = await execute(registrations, "validate_deck", {
      source: "stored",
      scope: "personal",
      deck_id: installed.deck.id,
    });
    assert.equal(result.ok, true, fixture.code);
    assert.equal(result.data.ingestible, false, fixture.code);
    assert.equal(result.data.status, "blocked", fixture.code);
    assert.ok(result.data.blockers.some((item) => item.code === fixture.code), fixture.code);
    assert.deepEqual(storage.dump(), before, fixture.code);
    assert.deepEqual(store.getSnapshot(), snapshot, fixture.code);
  }
});

test("lean replacement preserves unrepresented rich metadata, external prerequisites, criteria identities, and learning", async () => {
  const catalog = makeCatalog();
  catalog[0].cards[0] = {
    ...catalog[0].cards[0],
    prompt: "Recall the definition of Term 1.",
    aliases: ["First term"],
    required_concepts: [{ rubric_item_id: "original-criterion", text: "Definition point 1" }],
    accepted_variants: ["Equivalent first definition."],
    major_error_concepts: [{ rubric_item_id: "first-error", text: "Do not confuse the second term." }],
    prerequisites: ["external-deck.foundation"],
    tags: ["retain-when-omitted"],
    source_refs: ["source-1"],
    difficulty_hint: "introductory",
    module_ids: ["foundations"],
    provenance: { origin: "test-fixture", notes: "Keep this card's provenance." },
  };
  catalog[0].cards[1].tags = ["clear-when-explicit"];
  const storage = createMemoryStorage();
  const store = createStudyStore({ catalog, storage, clock: () => new Date(NOW) });
  const installed = store.addLibraryDeck({
    library_deck_id: "linear-algebra-i",
    expected_catalog_version: "1",
    client_action_id: "rich-replace:install",
  });
  const deckId = installed.deck.id;
  const { registrations } = await captureTools(store);
  // The external requirement is real, even though this test concerns rich
  // metadata. Establish its prior Good recall rather than bypassing the gate.
  const parentDeck = normalizedDeck({ deckId: "external-deck", cardCount: 1 });
  parentDeck.cards[0].id = "foundation";
  store.ingestDeck({ operation: "create", deck: parentDeck, idempotency_key: "rich-replace:parent" });
  await reviewOneCard(registrations, "external-deck", "rich-replace:parent-review");
  await reviewOneCard(registrations, deckId, "rich-replace:review");
  const before = store.getSnapshot().personalDecks[deckId];
  const read = await execute(registrations, "get_deck", { scope: "personal", deck_id: deckId });
  const replacement = normalizedDeckFromRead(read);
  delete replacement.cards[0].tags;
  replacement.cards[1].tags = [];
  const validated = await execute(registrations, "validate_deck", {
    source: "candidate",
    operation: "replace",
    target_deck_id: deckId,
    expected_deck_revision: before.revision,
    deck: replacement,
  });
  assert.equal(validated.ok, true);
  assert.deepEqual(validated.data.scheduling_impact.reset_card_ids, []);
  const replaced = await execute(registrations, "ingest_deck", {
    operation: "replace",
    target_deck_id: deckId,
    expected_deck_revision: before.revision,
    deck: replacement,
    idempotency_key: "rich-replace:replace",
  });
  assert.equal(replaced.ok, true);
  assert.deepEqual(replaced.data.scheduling_impact, validated.data.scheduling_impact);
  const reloaded = createStudyStore({ catalog, storage, clock: () => new Date(NOW) });
  const after = reloaded.getSnapshot().personalDecks[deckId];
  for (const key of ["description", "subject", "domain", "level", "tags", "modules", "provenance"]) {
    assert.deepEqual(after[key], before[key], key);
  }
  for (const key of ["prompt", "aliases", "requiredConcepts", "acceptedVariants", "majorErrorConcepts", "tags", "sourceRefs", "difficultyHint", "moduleIds", "provenance", "review", "reviewHistory"]) {
    assert.deepEqual(after.cards[`${deckId}.term-1`][key], before.cards["term-1"][key], key);
  }
  assert.deepEqual(after.cards[`${deckId}.term-2`].tags, []);
  const complete = reloaded.getDeck({ scope: "personal", deck_id: deckId });
  assert.equal(complete.prerequisite_edge_count, 1);
  assert.equal(complete.cross_deck_edge_count, 1);
  assert.deepEqual(complete.deck.cards[0].prerequisite_ids, ["external-deck.foundation"]);
  const storedValidation = reloaded.validateDeck({ source: "stored", scope: "personal", deck_id: deckId });
  assert.equal(storedValidation.ingestible, true);
  assert.ok(storedValidation.warnings.some((item) => item.code === "EXTERNAL_PREREQUISITES_UNVERIFIED"));
});

test("a corrected replacement can recover legacy graph defects without discarding unchanged learning", async () => {
  const cases = [
    { code: "DAG_CYCLE", mutate(deck) {
      deck.cards["term-1"].prerequisiteIds = [`${deck.id}.term-2`];
    } },
    { code: "UNRESOLVED_PREREQUISITE", mutate(deck) {
      deck.cards["term-2"].prerequisiteIds = [`${deck.id}.missing`];
    } },
  ];
  for (const fixture of cases) {
    const original = makeStore();
    const installed = original.addLibraryDeck({
      library_deck_id: "linear-algebra-i",
      expected_catalog_version: "1",
      client_action_id: "legacy-replacement:install",
    });
    const deckId = installed.deck.id;
    const originalTools = await captureTools(original);
    await reviewOneCard(originalTools.registrations, deckId, "legacy-replacement:review");
    const replacement = normalizedDeckFromRead({ data: original.getDeck({ scope: "personal", deck_id: deckId }) });
    const legacy = original.getSnapshot();
    const previousCard = structuredClone(legacy.personalDecks[deckId].cards["term-1"]);
    fixture.mutate(legacy.personalDecks[deckId]);
    const storage = createMemoryStorage({ "adaptive-study-lab:web-state:v1": JSON.stringify(legacy) });
    const store = makeStore({ storage });
    const effects = [];
    const { registrations } = await captureTools(store, undefined, (effect) => effects.push(effect));
    const storedValidation = await execute(registrations, "validate_deck", {
      source: "stored", scope: "personal", deck_id: deckId,
    });
    assert.ok(storedValidation.data.blockers.some((item) => item.code === fixture.code));
    const beforeStorage = storage.dump();
    const args = {
      operation: "replace",
      target_deck_id: deckId,
      expected_deck_revision: legacy.personalDecks[deckId].revision,
      deck: replacement,
    };
    const validation = await execute(registrations, "validate_deck", { source: "candidate", ...args });
    assert.equal(validation.ok, true, fixture.code);
    assert.equal(validation.data.ingestible, true, fixture.code);
    assert.deepEqual(validation.data.scheduling_impact.reset_card_ids, [], fixture.code);
    assert.deepEqual(storage.dump(), beforeStorage, "candidate validation must not write");
    const input = { ...args, idempotency_key: `legacy-replacement:${fixture.code}` };
    const replaced = await execute(registrations, "ingest_deck", input);
    assert.equal(replaced.ok, true, fixture.code);
    assert.deepEqual(replaced.data.scheduling_impact, validation.data.scheduling_impact);
    assert.equal((await execute(registrations, "ingest_deck", input)).data.receipt.replayed, true);
    assert.equal(effects.length, 1, "only the committed replacement notifies the page");
    const reloaded = makeStore({ storage });
    const after = reloaded.getSnapshot();
    const restoredCard = after.personalDecks[deckId].cards[`${deckId}.term-1`];
    assert.deepEqual(restoredCard.review, previousCard.review, fixture.code);
    assert.deepEqual(restoredCard.reviewHistory, previousCard.reviewHistory, fixture.code);
    assert.deepEqual(after.sessions, legacy.sessions, fixture.code);
    assert.deepEqual(after.view, legacy.view, fixture.code);
    assert.equal(reloaded.getDeck({ scope: "personal", deck_id: deckId }).prerequisite_edge_count, 1);
    assert.equal(reloaded.validateDeck({ source: "stored", scope: "personal", deck_id: deckId }).ingestible, true);
  }
});

test("add_cards can resolve a legacy missing prerequisite but cannot retain invalid final structure", async () => {
  for (const qualified of [false, true]) {
    const original = makeStore();
    const deckId = original.addLibraryDeck({
      library_deck_id: "linear-algebra-i",
      expected_catalog_version: "1",
      client_action_id: "legacy-add:install",
    }).deck.id;
    const legacy = original.getSnapshot();
    legacy.personalDecks[deckId].cards["term-2"].prerequisiteIds = [qualified ? `${deckId}.missing` : "missing"];
    const storage = createMemoryStorage({ "adaptive-study-lab:web-state:v1": JSON.stringify(legacy) });
    const store = makeStore({ storage });
    const effects = [];
    const { registrations } = await captureTools(store, undefined, (effect) => effects.push(effect));
    const beforeStorage = storage.dump();
    const invalid = await execute(registrations, "add_cards", {
      deck_id: deckId, expected_deck_revision: 1,
      cards: [completeCandidateCard(deckId, "unrelated")], idempotency_key: "legacy-add:invalid",
    });
    assertFailure(invalid, "UNRESOLVED_PREREQUISITE");
    assert.deepEqual(storage.dump(), beforeStorage);
    assert.deepEqual(store.getSnapshot(), legacy);
    assert.deepEqual(effects, []);
    const repaired = await execute(registrations, "add_cards", {
      deck_id: deckId, expected_deck_revision: 1,
      cards: [completeCandidateCard(deckId, "missing")], idempotency_key: "legacy-add:resolve",
    });
    assert.equal(repaired.ok, true, qualified ? "qualified reference" : "local reference");
    assert.equal(effects.length, 1);
    const reloaded = makeStore({ storage });
    const read = reloaded.getDeck({ scope: "personal", deck_id: deckId });
    assert.equal(read.card_count, 3);
    assert.equal(read.prerequisite_edge_count, 3);
    assert.equal(reloaded.validateDeck({ source: "stored", scope: "personal", deck_id: deckId }).ingestible, true);
  }
});

test("legacy recovery still rejects ambiguous or incomplete stored identities without mutation", async () => {
  const cases = [
    { code: "DUPLICATE_CARD_ID", mutate(deck) { deck.cardOrder.push("term-1"); } },
    { code: "INVALID_CARD_ID", mutate(deck) { deck.cardOrder.pop(); } },
    { code: "INVALID_CARD_ID", mutate(deck) { deck.cardOrder.push("missing"); } },
    { code: "INVALID_CARD_ID", mutate(deck) { deck.cards["term-1"].id = "different"; } },
    { code: "CARD_IDENTITY_COLLISION", mutate(deck) {
      const id = `${deck.id}.term-1`;
      deck.cards[id] = { ...structuredClone(deck.cards["term-1"]), id };
      deck.cardOrder.push(id);
    } },
  ];
  for (const fixture of cases) {
    const original = makeStore();
    const deckId = original.addLibraryDeck({
      library_deck_id: "linear-algebra-i",
      expected_catalog_version: "1",
      client_action_id: "legacy-identity:install",
    }).deck.id;
    const replacement = normalizedDeckFromRead({ data: original.getDeck({ scope: "personal", deck_id: deckId }) });
    const legacy = original.getSnapshot();
    fixture.mutate(legacy.personalDecks[deckId]);
    const storage = createMemoryStorage({ "adaptive-study-lab:web-state:v1": JSON.stringify(legacy) });
    const store = makeStore({ storage });
    const effects = [];
    const { registrations } = await captureTools(store, undefined, (effect) => effects.push(effect));
    const beforeStorage = storage.dump();
    const replacementArgs = {
      operation: "replace", target_deck_id: deckId, expected_deck_revision: 1, deck: replacement,
    };
    const attempts = [
      ["validate_deck", { source: "candidate", ...replacementArgs }],
      ["ingest_deck", { ...replacementArgs, idempotency_key: "legacy-identity:replace" }],
      ["add_cards", {
        deck_id: deckId, expected_deck_revision: 1,
        cards: [completeCandidateCard(deckId, "added")], idempotency_key: "legacy-identity:add",
      }],
    ];
    for (const [name, input] of attempts) {
      assertFailure(await execute(registrations, name, input), fixture.code);
      assert.deepEqual(store.getSnapshot(), legacy, name);
      assert.deepEqual(storage.dump(), beforeStorage, name);
      assert.deepEqual(effects, [], name);
    }
  }
});

test("replace migrates installed local card identities without losing unchanged progress and resets only changed content", async () => {
  const store = makeStore();
  const installed = store.addLibraryDeck({
    library_deck_id: "linear-algebra-i",
    expected_catalog_version: "1",
    client_action_id: "identity-replace:install",
  });
  const { registrations } = await captureTools(store);
  const started = await execute(registrations, "start_study_session", {
    deck_id: installed.deck.id,
    limit: 1,
    idempotency_key: "identity-replace:start",
  });
  const graded = await execute(registrations, "submit_grade", {
    session_id: started.data.session.session_id,
    card_id: started.data.current_card.card_id,
    expected_card_revision: started.data.current_card.card_revision,
    expected_session_revision: started.data.session.session_revision,
    answer_text: "Canonical definition 1.",
    answer_origin: "chat",
    rating: "good",
    rubric_evidence: [{
      rubric_item_id: "required-1",
      status: "met",
      note: "The required definition point was present.",
    }],
    feedback: "Correct.",
    misconceptions: [],
    confidence: 0.95,
    idempotency_key: "identity-replace:grade",
  });
  assert.equal(graded.ok, true);
  assert.equal(graded.data.session.status, "completed");

  const beforeReplace = await execute(registrations, "get_deck", {
    scope: "personal",
    deck_id: installed.deck.id,
  });
  const replacement = normalizedDeckFromRead(beforeReplace);
  const validated = await execute(registrations, "validate_deck", {
    source: "candidate",
    operation: "replace",
    target_deck_id: installed.deck.id,
    expected_deck_revision: beforeReplace.data.deck.deck_revision,
    deck: replacement,
  });
  assert.equal(validated.ok, true);
  assert.deepEqual(validated.data.scheduling_impact, {
    preserved_card_ids: [`${installed.deck.id}.term-1`, `${installed.deck.id}.term-2`],
    reset_card_ids: [],
    new_card_ids: [],
    archived_card_ids: [],
  });

  const replaced = await execute(registrations, "ingest_deck", {
    operation: "replace",
    target_deck_id: installed.deck.id,
    expected_deck_revision: beforeReplace.data.deck.deck_revision,
    deck: replacement,
    idempotency_key: "identity-replace:unchanged",
  });
  assert.equal(replaced.ok, true);
  assert.deepEqual(replaced.data.unchanged_card_ids, [
    `${installed.deck.id}.term-1`,
    `${installed.deck.id}.term-2`,
  ]);
  const unchangedSnapshot = store.getSnapshot();
  const migratedCard = unchangedSnapshot.personalDecks[installed.deck.id].cards[`${installed.deck.id}.term-1`];
  assert.equal(unchangedSnapshot.personalDecks[installed.deck.id].cards["term-1"], undefined);
  assert.equal(migratedCard.review.repetitions, 1);
  assert.equal(migratedCard.reviewHistory.length, 1);

  replacement.cards[0].definition = "Materially changed canonical definition.";
  const changed = await execute(registrations, "ingest_deck", {
    operation: "replace",
    target_deck_id: installed.deck.id,
    expected_deck_revision: replaced.data.deck_revision,
    deck: replacement,
    idempotency_key: "identity-replace:changed",
  });
  assert.equal(changed.ok, true);
  assert.deepEqual(changed.data.updated_card_ids, [`${installed.deck.id}.term-1`]);
  const changedCard = store.getSnapshot().personalDecks[installed.deck.id].cards[`${installed.deck.id}.term-1`];
  assert.equal(changedCard.review.repetitions, 0);
  assert.equal(changedCard.reviewHistory.length, 1);
  assert.equal(changedCard.contentRevision, migratedCard.contentRevision + 1);

  const finalRead = await execute(registrations, "get_deck", {
    scope: "personal",
    deck_id: installed.deck.id,
  });
  assert.equal(new Set(finalRead.data.deck.cards.map((card) => card.card_id)).size, 2);
});

test("add_cards rejects an installed local-qualified alias collision atomically and migrates a valid add", async () => {
  const store = makeStore();
  const installed = store.addLibraryDeck({
    library_deck_id: "linear-algebra-i",
    expected_catalog_version: "1",
    client_action_id: "identity-add:install",
  });
  const { registrations } = await captureTools(store);
  const before = store.getSnapshot();
  const collision = await execute(registrations, "add_cards", {
    deck_id: installed.deck.id,
    expected_deck_revision: installed.deck.revision,
    cards: [completeCandidateCard(installed.deck.id, "term-1")],
    idempotency_key: "identity-add:collision",
  });
  assertFailure(collision, "CARD_EXISTS");
  assert.deepEqual(store.getSnapshot(), before);

  const added = await execute(registrations, "add_cards", {
    deck_id: installed.deck.id,
    expected_deck_revision: installed.deck.revision,
    cards: [completeCandidateCard(installed.deck.id, "added")],
    idempotency_key: "identity-add:valid",
  });
  assert.equal(added.ok, true);
  const snapshot = store.getSnapshot();
  const deck = snapshot.personalDecks[installed.deck.id];
  assert.equal(deck.cards["term-1"], undefined);
  assert.ok(deck.cards[`${installed.deck.id}.term-1`]);
  assert.deepEqual(deck.cards[`${installed.deck.id}.added`].prerequisiteIds, [
    `${installed.deck.id}.term-1`,
  ]);
  assert.ok(deck.edges.some((edge) =>
    edge.prerequisiteCardId === `${installed.deck.id}.term-1`
      && edge.dependentCardId === `${installed.deck.id}.added`));

  const read = await execute(registrations, "get_deck", {
    scope: "personal",
    deck_id: installed.deck.id,
  });
  assert.equal(read.data.card_count, 3);
  assert.equal(new Set(read.data.deck.cards.map((card) => card.card_id)).size, 3);
});

test("schema-valid constructor deck identity uses own-key lookup", async () => {
  const store = makeStore();
  const { registrations } = await captureTools(store);
  const deck = normalizedDeck({ deckId: "constructor" });
  const validated = await execute(registrations, "validate_deck", {
    source: "candidate",
    operation: "create",
    deck,
  });
  assert.equal(validated.ok, true);
  assert.equal(validated.data.ingestible, true);
  assert.equal(validated.data.blockers.some((item) => item.code === "DECK_EXISTS"), false);

  const ingested = await execute(registrations, "ingest_deck", {
    operation: "create",
    deck,
    idempotency_key: "constructor:create",
  });
  assert.equal(ingested.ok, true);
  assert.equal(ingested.data.deck_id, "constructor");
  const read = await execute(registrations, "get_deck", {
    scope: "personal",
    deck_id: "constructor",
  });
  assert.equal(read.ok, true);
  assert.equal(read.data.deck.deck_id, "constructor");
});

test("source-rights review is scoped to stored source-bearing and Library-derived decks", async () => {
  const store = makeStore();
  const { registrations } = await captureTools(store);
  const leanDeck = normalizedDeck({ deckId: "lean-rights" });
  const candidate = await execute(registrations, "validate_deck", {
    source: "candidate",
    operation: "create",
    deck: leanDeck,
  });
  assert.equal(reviewCodes(candidate).includes("SOURCE_RIGHTS_REVIEW"), false);
  const ingested = await execute(registrations, "ingest_deck", {
    operation: "create",
    deck: leanDeck,
    idempotency_key: "rights:lean-create",
  });
  const storedLean = await execute(registrations, "validate_deck", {
    source: "stored",
    scope: "personal",
    deck_id: "lean-rights",
  });
  assert.equal(reviewCodes(storedLean).includes("SOURCE_RIGHTS_REVIEW"), false);

  const sourceBearing = await execute(registrations, "update_deck", {
    deck_id: "lean-rights",
    expected_deck_revision: ingested.data.deck_revision,
    patch: {
      provenance: {
        origin: "owner-source",
        source_outline: "Owner-provided source.",
        source_records: [{
          source_id: "source-1",
          title: "Source One",
          uri: "https://example.test/source-1",
          locator: "section 1",
          license: "unknown",
        }],
        evidence_tier: "unclassified",
        rights_status: "review-required",
        notes: "",
      },
    },
    idempotency_key: "rights:add-provenance",
  });
  assert.equal(sourceBearing.ok, true);
  const storedSourceBearing = await execute(registrations, "validate_deck", {
    source: "stored",
    scope: "personal",
    deck_id: "lean-rights",
  });
  assert.equal(reviewCodes(storedSourceBearing).includes("SOURCE_RIGHTS_REVIEW"), true);

  const installed = store.addLibraryDeck({
    library_deck_id: "linear-algebra-i",
    expected_catalog_version: "1",
    client_action_id: "rights:install-library",
  });
  const libraryDerived = await execute(registrations, "validate_deck", {
    source: "stored",
    scope: "personal",
    deck_id: installed.deck.id,
  });
  assert.equal(reviewCodes(libraryDerived).includes("SOURCE_RIGHTS_REVIEW"), true);

  const libraryRead = await execute(registrations, "get_deck", {
    scope: "personal",
    deck_id: installed.deck.id,
  });
  const libraryReplacement = normalizedDeckFromRead(libraryRead);
  const replacementValidation = await execute(registrations, "validate_deck", {
    source: "candidate",
    operation: "replace",
    target_deck_id: installed.deck.id,
    expected_deck_revision: libraryRead.data.deck.deck_revision,
    deck: libraryReplacement,
  });
  assert.equal(reviewCodes(replacementValidation).includes("SOURCE_RIGHTS_REVIEW"), true);
  const replaced = await execute(registrations, "ingest_deck", {
    operation: "replace",
    target_deck_id: installed.deck.id,
    expected_deck_revision: libraryRead.data.deck.deck_revision,
    deck: libraryReplacement,
    idempotency_key: "rights:replace-library",
  });
  assert.equal(replaced.ok, true);
  const afterReplacement = await execute(registrations, "validate_deck", {
    source: "stored",
    scope: "personal",
    deck_id: installed.deck.id,
  });
  assert.equal(reviewCodes(afterReplacement).includes("SOURCE_RIGHTS_REVIEW"), true);
});

test("submit_grade commits once and emits the full post-commit presentation handoff", async () => {
  const store = makeStore();
  const effects = [];
  const effectContexts = [];
  const registrations = [];
  await withDocument(
    {
      modelContext: {
        registerTool(definition) {
          registrations.push(definition);
        },
      },
    },
    async () => {
      await registerWebMCPTools({
        store,
        onVisibleEffect(effect, context) {
          effects.push(effect);
          effectContexts.push(context);
        },
      });
    },
  );

  const deck = normalizedDeck({ deckId: "study-deck", cardCount: 2 });
  deck.edges = [];
  const beforeView = store.getSnapshot().view;
  const ingested = await execute(registrations, "ingest_deck", {
    operation: "create",
    deck,
    idempotency_key: "study:ingest",
  });
  assert.equal(ingested.ok, true);

  const started = await execute(registrations, "start_study_session", {
    deck_id: "study-deck",
    limit: 2,
    idempotency_key: "study:start",
  });
  assert.equal(started.ok, true);
  assert.equal(started.data.session.status, "active");
  assert.equal(started.data.current_card.card_id, "study-deck.term-1");
  assert.match(started.data.current_card.definition_md, /Agent definition 1/);
  assert.equal(started.data.current_card.required_concepts[0].rubric_item_id, "required-1");
  effects.length = 0;
  effectContexts.length = 0;

  const inspected = await execute(registrations, "get_study_session", {
    session_id: started.data.session.session_id,
  });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.data.current_card.definition_md, started.data.current_card.definition_md);

  const gradeInput = {
    session_id: started.data.session.session_id,
    card_id: started.data.current_card.card_id,
    expected_card_revision: started.data.current_card.card_revision,
    expected_session_revision: started.data.session.session_revision,
    answer_text: "The exact learner answer.",
    answer_origin: "chat",
    rating: "good",
    rubric_evidence: [
      {
        rubric_item_id: "required-1",
        status: "met",
        note: "The required definition point was present.",
      },
    ],
    feedback: "Correct: the defining point was stated.",
    misconceptions: [],
    confidence: 0.96,
    idempotency_key: "study:grade:1",
  };

  const beforeRejectedGrade = store.getSnapshot();
  const rejectedGrade = await execute(registrations, "submit_grade", {
    ...gradeInput,
    rubric_evidence: [
      {
        rubric_item_id: "required-from-another-card",
        status: "met",
        note: "This evidence must not be accepted for the active card.",
      },
    ],
    idempotency_key: "study:grade:wrong-rubric",
  });
  assertFailure(rejectedGrade, "RUBRIC_EVIDENCE_MISMATCH");
  assert.equal(rejectedGrade.error.issues[0].path, "rubric_evidence[0].rubric_item_id");
  const afterRejectedGrade = store.getSnapshot();
  assert.equal(afterRejectedGrade.revision, beforeRejectedGrade.revision);
  assert.equal(afterRejectedGrade.sessions[gradeInput.session_id].history.length, 0);
  assert.equal(
    afterRejectedGrade.personalDecks["study-deck"].cards["study-deck.term-1"].reviewHistory.length,
    0,
  );
  assert.equal(effects.length, 0);

  const graded = await execute(registrations, "submit_grade", gradeInput);
  assert.equal(graded.ok, true);
  assert.equal(graded.data.answer_text, gradeInput.answer_text);
  assert.equal(graded.data.rating, "good");
  assert.equal(graded.data.session.status, "active");
  assert.equal(graded.data.session.reviewed, 1);
  assert.equal(graded.data.schedule.next.state, "review");
  assert.ok(graded.data.schedule.next.due_at);
  assert.equal(graded.data.next_card.card_id, "study-deck.term-2");
  assert.equal("visible_effect" in graded.data, false);
  assert.deepEqual(store.getSnapshot().view, beforeView);

  assert.equal(effects.length, 1);
  assert.equal(effects[0].type, "study_grade_committed");
  assert.equal(effects[0].session_id, graded.data.session_id);
  assert.equal(effects[0].reviewed_card_id, graded.data.card_id);
  assert.deepEqual(effects[0].reviewed_card, graded.data.reviewed_card);
  assert.match(effects[0].reviewed_card.definition_md, /Agent definition 1/);
  assert.deepEqual(effects[0].session, graded.data.session);
  assert.equal(effects[0].completion_state, "in_progress");
  assert.deepEqual(effects[0].next_card, graded.data.next_card);
  assert.deepEqual(effectContexts[0], {
    tool_name: "submit_grade",
    idempotency_key: "study:grade:1",
    transaction_id: graded.data.receipt.transaction_id,
  });

  const committed = store.getSnapshot();
  const committedRevision = committed.revision;
  assert.equal(committed.sessions[gradeInput.session_id].history.length, 1);
  assert.equal(committed.sessions[gradeInput.session_id].reviewsApplied, 1);
  assert.equal(
    committed.personalDecks["study-deck"].cards["study-deck.term-1"].reviewHistory.length,
    1,
  );

  const replayed = await execute(registrations, "submit_grade", gradeInput);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.data.receipt.replayed, true);
  assert.equal(replayed.data.review_id, graded.data.review_id);
  assert.equal(effects.length, 1, "an idempotent replay must not replay the presentation animation");
  const afterReplay = store.getSnapshot();
  assert.equal(afterReplay.revision, committedRevision);
  assert.equal(afterReplay.sessions[gradeInput.session_id].history.length, 1);
  assert.equal(
    afterReplay.personalDecks["study-deck"].cards["study-deck.term-1"].reviewHistory.length,
    1,
  );

  const finalGrade = await execute(registrations, "submit_grade", {
    ...gradeInput,
    card_id: graded.data.next_card.card_id,
    expected_card_revision: graded.data.next_card.card_revision,
    expected_session_revision: graded.data.session.session_revision,
    answer_text: "The second exact learner answer.",
    rubric_evidence: [
      {
        rubric_item_id: "required-1",
        status: "met",
        note: "The second required definition point was present.",
      },
    ],
    idempotency_key: "study:grade:2",
  });
  assert.equal(finalGrade.ok, true);
  assert.equal(finalGrade.data.session.status, "completed");
  assert.equal(finalGrade.data.session.reviewed, 2);
  assert.equal("next_card" in finalGrade.data, false);
  assert.equal(effects.length, 2);
  assert.equal(effects[1].reviewed_card_id, "study-deck.term-2");
  assert.equal(effects[1].completion_state, "completed");
  assert.equal("next_card" in effects[1], false);
  const completed = store.getSnapshot();
  assert.equal(completed.sessions[gradeInput.session_id].history.length, 2);
  assert.equal(
    completed.personalDecks["study-deck"].cards["study-deck.term-2"].reviewHistory.length,
    1,
  );
});

test("submit_grade preserves exact answer and assessment text through commit, replay, and reload", async () => {
  const storage = createMemoryStorage();
  const store = makeStore({ storage });
  const effects = [];
  const { registrations } = await captureTools(store, undefined, (effect) => effects.push(effect));
  await execute(registrations, "ingest_deck", {
    operation: "create", deck: normalizedDeck({ deckId: "exact-answer" }), idempotency_key: "exact-answer:create",
  });
  const started = await execute(registrations, "start_study_session", {
    deck_id: "exact-answer", idempotency_key: "exact-answer:start",
  });
  const input = {
    session_id: started.data.session.session_id,
    card_id: started.data.current_card.card_id,
    expected_card_revision: started.data.current_card.card_revision,
    expected_session_revision: started.data.session.session_revision,
    answer_text: "\r\n    A set contains distinct objects.\r\n\t$x \\in X$; café / λ.  \n",
    answer_origin: "chat",
    rating: "hard",
    rubric_evidence: [{
      rubric_item_id: "required-1", status: "partial", note: "\n    Membership is stated; the requested definition is incomplete.\r\n",
    }],
    feedback: "\n**Correction:** state the full defining condition.  \r\n",
    misconceptions: ["  Order is required.  ", "Order is required."],
    confidence: 0.8,
    idempotency_key: "exact-answer:grade",
  };
  effects.length = 0;
  const before = store.getSnapshot();
  const beforeStorage = storage.dump();
  const invalidInputs = [
    { ...input, answer_text: " \r\n\t " },
    { ...input, feedback: " \r\n\t " },
    { ...input, rubric_evidence: [{ ...input.rubric_evidence[0], note: " \r\n\t " }] },
    { ...input, misconceptions: [" \r\n\t "] },
  ];
  for (const invalid of invalidInputs) {
    assertFailure(await execute(registrations, "submit_grade", invalid), "INVALID_ARGUMENT");
    assert.deepEqual(store.getSnapshot(), before);
    assert.deepEqual(storage.dump(), beforeStorage);
    assert.deepEqual(effects, []);
  }
  const graded = await execute(registrations, "submit_grade", input);
  assert.equal(graded.ok, true, JSON.stringify(graded));
  const assessmentFields = ["answer_text", "answer_origin", "rating", "rubric_evidence", "feedback", "misconceptions", "confidence"];
  const committed = store.getSnapshot();
  const card = committed.personalDecks["exact-answer"].cards[input.card_id];
  const session = committed.sessions[input.session_id];
  for (const field of assessmentFields) {
    assert.deepEqual(graded.data[field], input[field], `result.${field}`);
    assert.deepEqual(card.reviewHistory[0][field], input[field], `card history.${field}`);
    assert.deepEqual(session.history[0][field], input[field], `session history.${field}`);
  }
  assert.equal(card.review.repetitions, 1);
  assert.equal(effects.length, 1);
  const committedStorage = storage.dump();
  const reloaded = makeStore({ storage });
  const replayEffects = [];
  const reloadedTools = await captureTools(reloaded, undefined, (effect) => replayEffects.push(effect));
  const replay = await execute(reloadedTools.registrations, "submit_grade", input);
  assert.equal(replay.ok, true);
  assert.equal(replay.data.receipt.replayed, true);
  for (const field of assessmentFields) assert.deepEqual(replay.data[field], input[field], `replay.${field}`);
  assert.deepEqual(reloaded.getSnapshot(), committed);
  assert.deepEqual(storage.dump(), committedStorage);
  assert.deepEqual(replayEffects, []);
  const alteredReplay = await execute(reloadedTools.registrations, "submit_grade", {
    ...input, answer_text: input.answer_text.trim(),
  });
  assertFailure(alteredReplay, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(reloaded.getSnapshot(), committed);
});

test("local grade aliases return qualified identities and ended sessions remain readable after card migration", async () => {
  const catalog = makeCatalog();
  catalog[0].edges = [];
  const storage = createMemoryStorage();
  const store = createStudyStore({ catalog, storage, clock: () => new Date(NOW) });
  const deckId = store.addLibraryDeck({
    library_deck_id: "linear-algebra-i", expected_catalog_version: "1", client_action_id: "grade-alias:install",
  }).deck.id;
  const effects = [];
  const { registrations } = await captureTools(store, undefined, (effect) => effects.push(effect));
  const started = await execute(registrations, "start_study_session", {
    deck_id: deckId, limit: 2, idempotency_key: "grade-alias:start",
  });
  assert.equal(started.data.session.total, 2);
  const card = started.data.current_card;
  const input = {
    session_id: started.data.session.session_id,
    card_id: "term-1",
    expected_card_revision: card.card_revision,
    expected_session_revision: started.data.session.session_revision,
    answer_text: card.definition_md, answer_origin: "chat", rating: "good",
    rubric_evidence: card.required_concepts.map((item) => ({ rubric_item_id: item.rubric_item_id, status: "met", note: "The definition point is present." })),
    feedback: "Correct definition.", misconceptions: [], confidence: 0.95, idempotency_key: "grade-alias:grade",
  };
  effects.length = 0;
  const graded = await execute(registrations, "submit_grade", input);
  assert.equal(graded.ok, true);
  assert.equal(graded.data.card_id, card.card_id);
  assert.equal(graded.data.reviewed_card.card_id, graded.data.card_id);
  assert.equal(effects[0].reviewed_card_id, graded.data.card_id);
  const overview = await execute(registrations, "get_learning_overview");
  assert.equal(overview.data.recent_reviews[0].card_id, card.card_id);
  const ended = await execute(registrations, "finish_study_session", {
    session_id: input.session_id, disposition: "end", expected_session_revision: graded.data.session.session_revision,
    idempotency_key: "grade-alias:end",
  });
  assert.equal(ended.ok, true);
  const before = store.getSnapshot();
  const read = await execute(registrations, "get_deck", { scope: "personal", deck_id: deckId });
  const replacement = await execute(registrations, "ingest_deck", {
    operation: "replace", target_deck_id: deckId, expected_deck_revision: read.data.deck.deck_revision,
    deck: normalizedDeckFromRead(read), idempotency_key: "grade-alias:replace",
  });
  assert.equal(replacement.ok, true);
  const reloaded = createStudyStore({ catalog, storage, clock: () => new Date(NOW) });
  const reloadedTools = await captureTools(reloaded);
  const endedRead = await execute(reloadedTools.registrations, "get_study_session", { session_id: input.session_id });
  assert.equal(endedRead.ok, true, JSON.stringify(endedRead));
  assert.equal(endedRead.data.session.status, "finished");
  assert.equal(endedRead.data.current_card.card_id, `${deckId}.term-2`);
  assert.equal(endedRead.data.current_card.card_id, endedRead.data.session.current_card_id);
  assert.deepEqual(reloaded.getSnapshot().sessions, before.sessions, "identity resolution must not rewrite historical sessions");
  const archived = await execute(reloadedTools.registrations, "update_cards", {
    deck_id: deckId, expected_deck_revision: replacement.data.deck_revision,
    updates: [{ card_id: `${deckId}.term-2`, patch: { archived: true } }],
    idempotency_key: "grade-alias:archive-ended-card",
  });
  assert.equal(archived.ok, true);
  const archivedRead = await execute(reloadedTools.registrations, "get_study_session", { session_id: input.session_id });
  assert.equal(archivedRead.ok, true);
  assert.equal(archivedRead.data.current_card.archived, true);
  assert.equal(archivedRead.data.current_card.card_id, `${deckId}.term-2`);
  const legacy = reloaded.getSnapshot();
  const displayStreak = structuredClone(legacy.streak);
  // A migration fixture uses saved evidence, not the time-dependent display
  // counters exposed by getSnapshot().streak.
  legacy.streak = JSON.parse(storage.getItem("adaptive-study-lab:web-state:v1")).streak;
  legacy.activity.find((event) => event.type === "grade_submitted").cardId = "term-1";
  const legacyStorage = createMemoryStorage({ "adaptive-study-lab:web-state:v1": JSON.stringify(legacy) });
  const legacyStore = createStudyStore({ catalog, storage: legacyStorage, clock: () => new Date(NOW) });
  const legacyBytes = legacyStorage.dump();
  assert.equal(legacyStore.getLearningOverview().recent_reviews[0].card_id, card.card_id);
  assert.deepEqual(legacyStore.getSnapshot(), { ...legacy, streak: displayStreak }, "recent-review reads must not rewrite legacy history");
  assert.deepEqual(legacyStorage.dump(), legacyBytes);
});

test("finish_study_session pauses and start_study_session resumes the same normal queue", async () => {
  const store = makeStore();
  const effects = [];
  const { registrations } = await captureTools(store, undefined, (effect) => effects.push(effect));
  const beforeView = store.getSnapshot().view;
  const deck = normalizedDeck({ deckId: "pause-deck", cardCount: 2 });
  const ingested = await execute(registrations, "ingest_deck", {
    operation: "create",
    deck,
    idempotency_key: "pause:ingest",
  });
  assert.equal(ingested.ok, true);
  const started = await execute(registrations, "start_study_session", {
    deck_id: "pause-deck",
    limit: 2,
    idempotency_key: "pause:start",
  });
  const paused = await execute(registrations, "finish_study_session", {
    session_id: started.data.session.session_id,
    disposition: "pause",
    expected_session_revision: started.data.session.session_revision,
    idempotency_key: "pause:finish",
  });
  assert.equal(paused.ok, true);
  assert.equal(paused.data.status, "paused");
  assert.equal(paused.data.summary.reviewed_count, 0);
  assert.deepEqual(paused.data.summary.rating_counts, {
    again: 0,
    hard: 0,
    good: 0,
    easy: 0,
  });

  const resumeInput = {
    deck_id: "pause-deck",
    limit: 1,
    idempotency_key: "pause:resume",
  };
  const effectCountBeforeResume = effects.length;
  const resumed = await execute(registrations, "start_study_session", resumeInput);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.data.session.session_id, started.data.session.session_id);
  assert.equal(resumed.data.session.status, "active");
  assert.equal(resumed.data.session.session_revision, started.data.session.session_revision + 2);
  assert.equal(resumed.data.current_card.card_id, started.data.current_card.card_id);
  assert.equal(effects.length, effectCountBeforeResume + 1);
  assert.equal(effects.at(-1).type, "webmcp_state_committed");
  assert.equal(effects.at(-1).tool_name, "start_study_session");
  assert.deepEqual(store.getSnapshot().view, beforeView);

  const replayed = await execute(registrations, "start_study_session", resumeInput);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.data.receipt.replayed, true);
  assert.equal(replayed.data.session.session_id, resumed.data.session.session_id);
  assert.equal(replayed.data.session.session_revision, resumed.data.session.session_revision);
  assert.equal(effects.length, effectCountBeforeResume + 1, "resume replay must not emit another callback");
  assert.deepEqual(store.getSnapshot().view, beforeView);
});
