import { StudyStoreError } from "./store.js";
import {
  DECK_BUILD_COMMIT_GUIDANCE,
  DECK_BUILD_FIELD_DESCRIPTIONS,
  DECK_BUILD_GUIDE,
} from "./deck-build-guide.js";
import {
  GRADING_FIELD_DESCRIPTIONS,
  GRADING_GUIDE,
  GRADING_STUDY_GUIDANCE,
} from "./grading-guide.js";

const ID = {
  type: "string",
  minLength: 1,
  maxLength: 257,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
};
const DECK_ID = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z0-9](?:[a-z0-9_-]{0,127})$",
};
const LOCAL_CARD_ID = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z0-9](?:[a-z0-9_-]{0,127})$",
};
const CARD_ID = {
  type: "string",
  minLength: 3,
  maxLength: 257,
  pattern: "^[a-z0-9](?:[a-z0-9_-]{0,127})\\.[a-z0-9](?:[a-z0-9_.-]{0,127})$",
};
const IDEMPOTENCY_KEY = { type: "string", minLength: 1, maxLength: 128 };
const CURSOR = { type: "string", minLength: 1, maxLength: 64 };
const REVISION = { type: "integer", minimum: 1 };
const COUNT = { type: "integer", minimum: 0 };
const TIMESTAMP = { type: "string", minLength: 1, maxLength: 64 };
const SHORT_TEXT = { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" };
const TITLE = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" };
const TEXT = { type: "string", minLength: 1, maxLength: 1_000, pattern: "\\S" };
const NULL = { type: "null" };

const objectSchema = (properties, required = [], extra = {}) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
  ...extra,
});
const arraySchema = (items, maxItems, extra = {}) => ({
  type: "array",
  items,
  ...(maxItems === undefined ? {} : { maxItems }),
  ...extra,
});
const stringArray = (maxItems = 50, maxLength = 1_000) =>
  arraySchema({ type: "string", minLength: 1, maxLength }, maxItems, { uniqueItems: true });
const idArray = (maxItems = 10_000) => arraySchema(ID, maxItems, { uniqueItems: true });
const nullable = (schema) => ({ oneOf: [schema, NULL] });
const withGradingFieldDescriptions = (properties) => Object.fromEntries(
  Object.entries(properties).map(([name, schema]) => [
    name,
    { ...schema, description: GRADING_FIELD_DESCRIPTIONS[name] },
  ]),
);

const MODULE_SCHEMA = objectSchema(
  {
    module_id: ID,
    title: TITLE,
    description: { type: "string", maxLength: 1_000 },
    position: { type: "integer", minimum: 0, maximum: 10_000 },
  },
  ["module_id", "title", "description", "position"],
);

const SOURCE_RECORD_SCHEMA = objectSchema(
  {
    source_id: ID,
    title: TITLE,
    uri: { type: "string", maxLength: 2_000 },
    locator: { type: "string", maxLength: 2_000 },
    license: { type: "string", maxLength: 2_000 },
  },
  ["source_id", "title", "uri", "locator", "license"],
);

const PROVENANCE_SCHEMA = objectSchema(
  {
    origin: { type: "string", maxLength: 200 },
    source_outline: { type: "string", maxLength: 8_000 },
    source_records: arraySchema(SOURCE_RECORD_SCHEMA, 100),
    evidence_tier: { type: "string", minLength: 1, maxLength: 200 },
    rights_status: { type: "string", minLength: 1, maxLength: 200 },
    notes: { type: "string", maxLength: 8_000 },
  },
  ["origin", "source_outline", "source_records", "evidence_tier", "rights_status", "notes"],
);

const RUBRIC_ITEM_SCHEMA = objectSchema(
  { rubric_item_id: ID, text: TEXT },
  ["rubric_item_id", "text"],
);

const CANDIDATE_CARD_PROPERTIES = {
  card_id: CARD_ID,
  term: { type: "string", minLength: 1, maxLength: 300, pattern: "\\S" },
  prompt: nullable({ type: "string", minLength: 1, maxLength: 1_000 }),
  definition_md: { type: "string", minLength: 1, maxLength: 8_000, pattern: "\\S" },
  aliases: stringArray(20),
  required_concepts: arraySchema(RUBRIC_ITEM_SCHEMA, 30),
  accepted_variants: stringArray(30),
  major_error_concepts: arraySchema(RUBRIC_ITEM_SCHEMA, 30),
  prerequisite_ids: idArray(50),
  tags: stringArray(50, 100),
  source_refs: stringArray(50, 128),
  difficulty_hint: nullable({ type: "string", minLength: 1, maxLength: 100 }),
  module_ids: idArray(50),
  provenance: nullable(PROVENANCE_SCHEMA),
  archived: { type: "boolean" },
};

const CANDIDATE_CARD_SCHEMA = objectSchema(
  CANDIDATE_CARD_PROPERTIES,
  Object.keys(CANDIDATE_CARD_PROPERTIES),
);

const CANDIDATE_CARD_PATCH_SCHEMA = objectSchema(
  Object.fromEntries(
    Object.entries(CANDIDATE_CARD_PROPERTIES).filter(([key]) => key !== "card_id"),
  ),
  [],
  { minProperties: 1 },
);

const NORMALIZED_CARD_SCHEMA = objectSchema(
  {
    id: { ...LOCAL_CARD_ID, description: DECK_BUILD_FIELD_DESCRIPTIONS.id },
    term: {
      type: "string", minLength: 1, maxLength: 300, pattern: "\\S",
      description: DECK_BUILD_FIELD_DESCRIPTIONS.term,
    },
    definition: {
      type: "string", minLength: 1, maxLength: 8_000, pattern: "\\S",
      description: DECK_BUILD_FIELD_DESCRIPTIONS.definition,
    },
    criteria: arraySchema(
      { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" },
      12,
      {
        minItems: 1,
        uniqueItems: true,
        description: DECK_BUILD_FIELD_DESCRIPTIONS.criteria,
      },
    ),
    tags: arraySchema(
      { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" },
      5,
      { uniqueItems: true, description: DECK_BUILD_FIELD_DESCRIPTIONS.tags },
    ),
  },
  ["id", "term", "definition", "criteria"],
);

const NORMALIZED_EDGE_SCHEMA = objectSchema(
  {
    from: { ...LOCAL_CARD_ID, description: DECK_BUILD_FIELD_DESCRIPTIONS.from },
    to: { ...LOCAL_CARD_ID, description: DECK_BUILD_FIELD_DESCRIPTIONS.to },
  },
  ["from", "to"],
);

const NORMALIZED_DECK_SCHEMA = objectSchema(
  {
    schema_version: {
      const: "normalized-definition-deck.v2",
      description: DECK_BUILD_FIELD_DESCRIPTIONS.schema_version,
    },
    deck_id: { ...DECK_ID, description: DECK_BUILD_FIELD_DESCRIPTIONS.deck_id },
    title: { ...TITLE, description: DECK_BUILD_FIELD_DESCRIPTIONS.title },
    cards: arraySchema(NORMALIZED_CARD_SCHEMA, 50, {
      minItems: 1, description: DECK_BUILD_FIELD_DESCRIPTIONS.cards,
    }),
    edges: arraySchema(NORMALIZED_EDGE_SCHEMA, 250, {
      uniqueItems: true, description: DECK_BUILD_FIELD_DESCRIPTIONS.edges,
    }),
  },
  ["schema_version", "deck_id", "title", "cards", "edges"],
);

const DIAGNOSTIC_SCHEMA = objectSchema(
  {
    code: { type: "string", minLength: 1, maxLength: 128 },
    path: { type: "string", minLength: 1, maxLength: 500 },
    message: { type: "string", minLength: 1, maxLength: 2_000 },
  },
  ["code", "path", "message"],
);

const RECEIPT_SCHEMA = objectSchema(
  {
    transaction_id: ID,
    operation: { type: "string", minLength: 1, maxLength: 128 },
    idempotency_key: IDEMPOTENCY_KEY,
    replayed: { type: "boolean" },
    committed_at: TIMESTAMP,
    previous_app_revision: COUNT,
    app_revision: { type: "integer", minimum: 1 },
  },
  [
    "transaction_id",
    "operation",
    "idempotency_key",
    "replayed",
    "committed_at",
    "previous_app_revision",
    "app_revision",
  ],
);

const SCHEDULE_SUMMARY_SCHEMA = objectSchema(
  {
    state: { enum: ["new", "review"] },
    repetitions: COUNT,
    due_at: nullable(TIMESTAMP),
    last_reviewed_at: nullable(TIMESTAMP),
    last_rating: nullable({ enum: ["again", "hard", "good", "easy"] }),
    learnedness: { type: "number", minimum: 0, maximum: 1 },
    recency: { type: "number", minimum: 0, maximum: 1 },
  },
  ["state", "repetitions", "due_at", "last_reviewed_at", "last_rating", "learnedness", "recency"],
);

const AGENT_CARD_SCHEMA = objectSchema(
  {
    card_id: ID,
    card_revision: REVISION,
    term: { type: "string", minLength: 1, maxLength: 300 },
    prompt: nullable({ type: "string", minLength: 1, maxLength: 1_000 }),
    definition_md: { type: "string", minLength: 1, maxLength: 8_000 },
    aliases: stringArray(20),
    required_concepts: arraySchema(RUBRIC_ITEM_SCHEMA, 30),
    accepted_variants: stringArray(30),
    major_error_concepts: arraySchema(RUBRIC_ITEM_SCHEMA, 30),
    prerequisite_ids: idArray(100),
    tags: stringArray(50, 100),
    source_refs: stringArray(50, 128),
    difficulty_hint: nullable({ type: "string", minLength: 1, maxLength: 100 }),
    module_ids: idArray(50),
    provenance: nullable(PROVENANCE_SCHEMA),
    archived: { type: "boolean" },
    scheduling: SCHEDULE_SUMMARY_SCHEMA,
  },
  [
    "card_id",
    "card_revision",
    "term",
    "prompt",
    "definition_md",
    "aliases",
    "required_concepts",
    "accepted_variants",
    "major_error_concepts",
    "prerequisite_ids",
    "tags",
    "source_refs",
    "difficulty_hint",
    "module_ids",
    "provenance",
    "archived",
    "scheduling",
  ],
);

const SESSION_SCHEMA = objectSchema(
  {
    session_id: ID,
    deck_id: ID,
    deck_title: TITLE,
    status: { enum: ["active", "paused", "completed", "finished"] },
    phase: { enum: ["awaiting_answer", "complete"] },
    session_revision: REVISION,
    total: COUNT,
    reviewed: COUNT,
    remaining: COUNT,
    current_card_id: nullable(ID),
    started_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    finished_at: nullable(TIMESTAMP),
  },
  [
    "session_id",
    "deck_id",
    "deck_title",
    "status",
    "phase",
    "session_revision",
    "total",
    "reviewed",
    "remaining",
    "current_card_id",
    "started_at",
    "updated_at",
    "finished_at",
  ],
);

const PERSONAL_DECK_SUMMARY_SCHEMA = objectSchema(
  {
    deck_id: ID,
    deck_revision: REVISION,
    content_revision: REVISION,
    title: TITLE,
    subject: { type: "string", minLength: 1, maxLength: 100 },
    domain: { type: "string", minLength: 1, maxLength: 100 },
    level: { type: "string", minLength: 1, maxLength: 100 },
    archived: { type: "boolean" },
    card_count: COUNT,
    archived_card_count: COUNT,
    due_count: COUNT,
    new_count: COUNT,
    progress: { type: "number", minimum: 0, maximum: 1 },
    last_activity_at: nullable(TIMESTAMP),
    evidence_tier: { type: "string", minLength: 1, maxLength: 200 },
    rights_status: { type: "string", minLength: 1, maxLength: 200 },
    warning_count: COUNT,
  },
  [
    "deck_id",
    "deck_revision",
    "content_revision",
    "title",
    "subject",
    "domain",
    "level",
    "archived",
    "card_count",
    "archived_card_count",
    "due_count",
    "new_count",
    "progress",
    "last_activity_at",
    "evidence_tier",
    "rights_status",
    "warning_count",
  ],
);

const LIBRARY_DECK_SUMMARY_SCHEMA = objectSchema(
  {
    deck_id: ID,
    version: { type: "string", minLength: 1, maxLength: 128 },
    title: TITLE,
    description: { type: "string", maxLength: 2_000 },
    subject: { type: "string", minLength: 1, maxLength: 100 },
    domain: { type: "string", minLength: 1, maxLength: 100 },
    level: { type: "string", minLength: 1, maxLength: 100 },
    tags: stringArray(50, 100),
    module_count: COUNT,
    card_count: COUNT,
    prerequisite_edge_count: COUNT,
    cross_deck_edge_count: COUNT,
    evidence_tier: { type: "string", minLength: 1, maxLength: 200 },
    rights_status: { type: "string", minLength: 1, maxLength: 200 },
    provenance_summary: objectSchema(
      {
        origin: { type: "string", maxLength: 200 },
        source_count: COUNT,
        notes: { type: "string", maxLength: 8_000 },
      },
      ["origin", "source_count", "notes"],
    ),
  },
  [
    "deck_id",
    "version",
    "title",
    "description",
    "subject",
    "domain",
    "level",
    "tags",
    "module_count",
    "card_count",
    "prerequisite_edge_count",
    "cross_deck_edge_count",
    "evidence_tier",
    "rights_status",
    "provenance_summary",
  ],
);

const COMPLETE_DECK_SCHEMA = objectSchema(
  {
    deck_id: ID,
    deck_revision: COUNT,
    content_revision: COUNT,
    version: { type: "string", minLength: 1, maxLength: 128 },
    title: TITLE,
    description: { type: "string", maxLength: 2_000 },
    subject: { type: "string", minLength: 1, maxLength: 100 },
    domain: { type: "string", minLength: 1, maxLength: 100 },
    level: { type: "string", minLength: 1, maxLength: 100 },
    tags: stringArray(50, 100),
    modules: arraySchema(MODULE_SCHEMA, 1_000),
    provenance: PROVENANCE_SCHEMA,
    archived: { type: "boolean" },
    cards: arraySchema(AGENT_CARD_SCHEMA),
  },
  [
    "deck_id",
    "deck_revision",
    "content_revision",
    "version",
    "title",
    "description",
    "subject",
    "domain",
    "level",
    "tags",
    "modules",
    "provenance",
    "archived",
    "cards",
  ],
);

const SCHEDULING_IMPACT_SCHEMA = objectSchema(
  {
    preserved_card_ids: idArray(),
    reset_card_ids: idArray(),
    new_card_ids: idArray(),
    archived_card_ids: idArray(),
  },
  ["preserved_card_ids", "reset_card_ids", "new_card_ids", "archived_card_ids"],
);

const VALIDATION_OUTPUT_SCHEMA = objectSchema(
  {
    status: { enum: ["blocked", "ready_with_warnings", "ready"] },
    ingestible: { type: "boolean" },
    content_digest: { type: "string", minLength: 1, maxLength: 256 },
    blockers: arraySchema(DIAGNOSTIC_SCHEMA, 1_000),
    warnings: arraySchema(DIAGNOSTIC_SCHEMA, 1_000),
    agent_review_required: arraySchema(DIAGNOSTIC_SCHEMA, 1_000),
    scheduling_impact: SCHEDULING_IMPACT_SCHEMA,
  },
  [
    "status",
    "ingestible",
    "content_digest",
    "blockers",
    "warnings",
    "agent_review_required",
    "scheduling_impact",
  ],
);

const RUBRIC_EVIDENCE_SCHEMA = objectSchema(
  {
    rubric_item_id: ID,
    status: { enum: ["met", "partial", "missed", "contradicted"] },
    note: { type: "string", minLength: 1, maxLength: 1_000 },
  },
  ["rubric_item_id", "status", "note"],
);

const TOOL_DEFINITIONS = [
  tool(
    "get_learning_overview",
    "Read current due totals, active-session facts, bounded deck progress summaries, and recent reviews. This never recommends work or changes the current page.",
    objectSchema({}),
    objectSchema(
      {
        as_of: TIMESTAMP,
        due_total: COUNT,
        new_available_total: COUNT,
        active_session: SESSION_SCHEMA,
        decks: arraySchema(PERSONAL_DECK_SUMMARY_SCHEMA, 50),
        recent_reviews: arraySchema(
          objectSchema(
            {
              review_id: ID,
              deck_id: ID,
              card_id: ID,
              rating: { enum: ["again", "hard", "good", "easy"] },
              reviewed_at: TIMESTAMP,
            },
            ["review_id", "deck_id", "card_id", "rating", "reviewed_at"],
          ),
          20,
        ),
      },
      ["as_of", "due_total", "new_available_total", "decks", "recent_reviews"],
    ),
    "getLearningOverview",
    true,
  ),
  tool(
    "search_library",
    "Search lightweight summaries in the owner-maintained Library. Results never contain cards and this tool never installs, publishes, selects, or opens a deck.",
    objectSchema({
      query: { type: "string", maxLength: 200 },
      subjects: stringArray(50, 100),
      domains: stringArray(50, 100),
      levels: stringArray(50, 100),
      difficulty_hints: stringArray(50, 100),
      evidence_tiers: stringArray(50, 200),
      rights_statuses: stringArray(50, 200),
      limit: { type: "integer", minimum: 1, maximum: 50 },
      cursor: CURSOR,
    }),
    objectSchema(
      {
        items: arraySchema(LIBRARY_DECK_SUMMARY_SCHEMA, 50),
        total_matching: COUNT,
        next_cursor: CURSOR,
      },
      ["items", "total_matching"],
    ),
    "searchLibrary",
    true,
  ),
  tool(
    "list_my_decks",
    "List personal deck summaries, with optional text/status filters, sorting, and pagination. Call with no arguments to list active decks by due work. Results include revision, progress, provenance, and warnings, not cards; use get_deck for a complete deck. This never changes selection or navigation.",
    objectSchema({
      query: { type: "string", maxLength: 200 },
      status: { enum: ["active", "archived", "all"] },
      sort: { enum: ["due", "recent", "title", "progress"] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      cursor: CURSOR,
    }),
    objectSchema(
      {
        items: arraySchema(PERSONAL_DECK_SUMMARY_SCHEMA, 50),
        total_matching: COUNT,
        next_cursor: CURSOR,
      },
      ["items", "total_matching"],
    ),
    "searchMyDecks",
    true,
  ),
  tool(
    "get_deck",
    "Return one complete Library or personal deck, including every card, rubric, prerequisite, provenance field, revision, archive flag, and scheduling summary. The result is never paged or silently truncated.",
    objectSchema(
      { scope: { enum: ["library", "personal"] }, deck_id: ID },
      ["scope", "deck_id"],
    ),
    objectSchema(
      {
        complete: { const: true },
        scope: { enum: ["library", "personal"] },
        deck: COMPLETE_DECK_SCHEMA,
        card_count: COUNT,
        archived_card_count: COUNT,
        prerequisite_edge_count: COUNT,
        cross_deck_edge_count: COUNT,
        external_prerequisite_deck_ids: idArray(),
        content_digest: { type: "string", minLength: 1, maxLength: 256 },
      },
      [
        "complete",
        "scope",
        "deck",
        "card_count",
        "archived_card_count",
        "prerequisite_edge_count",
        "cross_deck_edge_count",
        "external_prerequisite_deck_ids",
        "content_digest",
      ],
    ),
    "getDeck",
    true,
    completeDeckResult,
  ),
  tool(
    "validate_deck",
    "Check candidate or stored deck structure without certifying factual or pedagogical quality. Results separate structural blockers, warnings, and semantic obligations that still require agent review. This check does not certify external prerequisite targets or semantics; Study still enforces retained required prerequisites before a card's first introduction.\n\n" + DECK_BUILD_GUIDE,
    {
      oneOf: [
        objectSchema(
          { source: { const: "stored" }, scope: { const: "personal" }, deck_id: ID },
          ["source", "scope", "deck_id"],
        ),
        objectSchema(
          {
            source: { const: "candidate" },
            operation: { const: "create" },
            deck: NORMALIZED_DECK_SCHEMA,
          },
          ["source", "operation", "deck"],
        ),
        objectSchema(
          {
            source: { const: "candidate" },
            operation: { const: "replace" },
            target_deck_id: ID,
            expected_deck_revision: REVISION,
            deck: NORMALIZED_DECK_SCHEMA,
          },
          ["source", "operation", "target_deck_id", "expected_deck_revision", "deck"],
        ),
      ],
    },
    VALIDATION_OUTPUT_SCHEMA,
    "validateDeck",
    true,
  ),
  tool(
    "ingest_deck",
    "Atomically create a personal definition deck or replace its full normalized card set after validation. Replacement archives omitted cards, preserves metadata not expressible in the lean payload, retains review history, and reports schedule preservation or reset consequences. Use update_deck for metadata-only edits and update_cards for targeted card edits. This never changes the current route. " + DECK_BUILD_COMMIT_GUIDANCE,
    {
      oneOf: [
        objectSchema(
          {
            operation: { const: "create" },
            deck: NORMALIZED_DECK_SCHEMA,
            idempotency_key: IDEMPOTENCY_KEY,
          },
          ["operation", "deck", "idempotency_key"],
        ),
        objectSchema(
          {
            operation: { const: "replace" },
            target_deck_id: ID,
            expected_deck_revision: REVISION,
            deck: NORMALIZED_DECK_SCHEMA,
            idempotency_key: IDEMPOTENCY_KEY,
          },
          ["operation", "target_deck_id", "expected_deck_revision", "deck", "idempotency_key"],
        ),
      ],
    },
    objectSchema(
      {
        deck_id: ID,
        previous_deck_revision: nullable(REVISION),
        deck_revision: REVISION,
        validation_status: { enum: ["ready_with_warnings", "ready"] },
        content_digest: { type: "string", minLength: 1, maxLength: 256 },
        added_card_ids: idArray(),
        updated_card_ids: idArray(),
        unchanged_card_ids: idArray(),
        archived_card_ids: idArray(),
        scheduling_impact: SCHEDULING_IMPACT_SCHEMA,
        receipt: RECEIPT_SCHEMA,
      },
      [
        "deck_id",
        "previous_deck_revision",
        "deck_revision",
        "validation_status",
        "content_digest",
        "added_card_ids",
        "updated_card_ids",
        "unchanged_card_ids",
        "archived_card_ids",
        "scheduling_impact",
        "receipt",
      ],
    ),
    "ingestDeck",
  ),
  tool(
    "update_deck",
    "Atomically patch personal deck metadata using an expected revision and idempotency key. This cannot change cards, deck identity, archive state, scheduling, selection, or navigation.",
    objectSchema(
      {
        deck_id: ID,
        expected_deck_revision: REVISION,
        patch: objectSchema(
          {
            title: TITLE,
            description: { type: "string", maxLength: 2_000 },
            subject: SHORT_TEXT,
            domain: SHORT_TEXT,
            level: SHORT_TEXT,
            tags: stringArray(50, 100),
            modules: arraySchema(MODULE_SCHEMA, 1_000),
            provenance: PROVENANCE_SCHEMA,
          },
          [],
          { minProperties: 1 },
        ),
        idempotency_key: IDEMPOTENCY_KEY,
      },
      ["deck_id", "expected_deck_revision", "patch", "idempotency_key"],
    ),
    objectSchema(
      {
        deck_id: ID,
        previous_deck_revision: REVISION,
        deck_revision: REVISION,
        changed_fields: stringArray(8, 100),
        warnings: arraySchema(DIAGNOSTIC_SCHEMA, 1_000),
        receipt: RECEIPT_SCHEMA,
      },
      ["deck_id", "previous_deck_revision", "deck_revision", "changed_fields", "warnings", "receipt"],
    ),
    "updateDeck",
  ),
  tool(
    "add_cards",
    "Atomically add 1 to 100 complete cards to a personal deck. Existing or duplicate identities fail the entire batch; the site initializes scheduling and the tool never changes the current view.",
    objectSchema(
      {
        deck_id: ID,
        expected_deck_revision: REVISION,
        cards: arraySchema(CANDIDATE_CARD_SCHEMA, 100, { minItems: 1 }),
        idempotency_key: IDEMPOTENCY_KEY,
      },
      ["deck_id", "expected_deck_revision", "cards", "idempotency_key"],
    ),
    objectSchema(
      {
        deck_id: ID,
        previous_deck_revision: REVISION,
        deck_revision: REVISION,
        added_card_ids: idArray(),
        scheduling_impact: objectSchema(
          {
            initialized_card_ids: idArray(),
            due_dates_owned_by_site: { const: true },
          },
          ["initialized_card_ids", "due_dates_owned_by_site"],
        ),
        warnings: arraySchema(DIAGNOSTIC_SCHEMA, 1_000),
        receipt: RECEIPT_SCHEMA,
      },
      [
        "deck_id",
        "previous_deck_revision",
        "deck_revision",
        "added_card_ids",
        "scheduling_impact",
        "warnings",
        "receipt",
      ],
    ),
    "addCards",
  ),
  tool(
    "update_cards",
    "Atomically patch 1 to 100 existing cards, including prerequisite fields and reversible archive state. Unknown or duplicate identities fail the entire batch; material grading-target edits reset only affected schedules.",
    objectSchema(
      {
        deck_id: ID,
        expected_deck_revision: REVISION,
        updates: arraySchema(
          objectSchema(
            { card_id: ID, patch: CANDIDATE_CARD_PATCH_SCHEMA },
            ["card_id", "patch"],
          ),
          100,
          { minItems: 1 },
        ),
        idempotency_key: IDEMPOTENCY_KEY,
      },
      ["deck_id", "expected_deck_revision", "updates", "idempotency_key"],
    ),
    objectSchema(
      {
        deck_id: ID,
        previous_deck_revision: REVISION,
        deck_revision: REVISION,
        updates: arraySchema(
          objectSchema(
            {
              card_id: ID,
              card_revision: REVISION,
              changed_fields: stringArray(14, 100),
              scheduling_result: { enum: ["preserved", "reset"] },
              scheduling_reason: { type: "string", minLength: 1, maxLength: 1_000 },
            },
            ["card_id", "card_revision", "changed_fields", "scheduling_result", "scheduling_reason"],
          ),
          100,
        ),
        receipt: RECEIPT_SCHEMA,
      },
      ["deck_id", "previous_deck_revision", "deck_revision", "updates", "receipt"],
    ),
    "updateCards",
  ),
  tool(
    "start_study_session",
    "Start or resume the site's one normal scheduled queue and return the full current card to the trusted grading agent. There is no mode, focus-card, route, selection, or navigation input. " + GRADING_STUDY_GUIDANCE,
    objectSchema(
      {
        deck_id: ID,
        limit: { type: "integer", minimum: 1, maximum: 50 },
        idempotency_key: IDEMPOTENCY_KEY,
      },
      ["deck_id", "idempotency_key"],
    ),
    objectSchema(
      { session: SESSION_SCHEMA, current_card: AGENT_CARD_SCHEMA, receipt: RECEIPT_SCHEMA },
      ["session", "receipt"],
    ),
    "startStudySession",
  ),
  tool(
    "get_study_session",
    "Read the current study transaction and the full current definition card and rubric for the trusted grading agent. This never captures an answer, grades, schedules, advances, or navigates. " + GRADING_STUDY_GUIDANCE,
    objectSchema({ session_id: ID }, ["session_id"]),
    objectSchema(
      { session: SESSION_SCHEMA, current_card: AGENT_CARD_SCHEMA },
      ["session"],
    ),
    "getStudySession",
    true,
  ),
  tool(
    "submit_grade",
    "Atomically submit the learner's exact answer and the agent's direct Again, Hard, Good, or Easy grade with rubric evidence and feedback. The site validates the bound revisions, schedules once, records one review, and advances once; this does not navigate or focus the page.\n\n" + GRADING_GUIDE,
    objectSchema(
      withGradingFieldDescriptions({
        session_id: ID,
        card_id: ID,
        expected_card_revision: REVISION,
        expected_session_revision: REVISION,
        answer_text: { type: "string", minLength: 1, maxLength: 4_000 },
        answer_origin: { enum: ["chat", "website"] },
        rating: { enum: ["again", "hard", "good", "easy"] },
        rubric_evidence: arraySchema(
          {
            ...RUBRIC_EVIDENCE_SCHEMA,
            properties: withGradingFieldDescriptions(RUBRIC_EVIDENCE_SCHEMA.properties),
          },
          40,
          { uniqueItems: true },
        ),
        feedback: { type: "string", minLength: 1, maxLength: 2_000 },
        misconceptions: stringArray(20),
        confidence: { type: "number", minimum: 0, maximum: 1 },
        idempotency_key: IDEMPOTENCY_KEY,
      }),
      [
        "session_id",
        "card_id",
        "expected_card_revision",
        "expected_session_revision",
        "answer_text",
        "answer_origin",
        "rating",
        "rubric_evidence",
        "feedback",
        "misconceptions",
        "confidence",
        "idempotency_key",
      ],
    ),
    objectSchema(
      {
        review_id: ID,
        answer_id: ID,
        session_id: ID,
        card_id: ID,
        card_revision: REVISION,
        rating: { enum: ["again", "hard", "good", "easy"] },
        answer_text: { type: "string", minLength: 1, maxLength: 4_000 },
        answer_origin: { enum: ["chat", "website"] },
        rubric_evidence: arraySchema(RUBRIC_EVIDENCE_SCHEMA, 40),
        feedback: { type: "string", minLength: 1, maxLength: 2_000 },
        misconceptions: stringArray(20),
        confidence: { type: "number", minimum: 0, maximum: 1 },
        schedule: objectSchema(
          { previous: SCHEDULE_SUMMARY_SCHEMA, next: SCHEDULE_SUMMARY_SCHEMA },
          ["previous", "next"],
        ),
        reviewed_card: AGENT_CARD_SCHEMA,
        session: SESSION_SCHEMA,
        next_card: AGENT_CARD_SCHEMA,
        receipt: RECEIPT_SCHEMA,
      },
      [
        "review_id",
        "answer_id",
        "session_id",
        "card_id",
        "card_revision",
        "rating",
        "answer_text",
        "answer_origin",
        "rubric_evidence",
        "feedback",
        "misconceptions",
        "confidence",
        "schedule",
        "reviewed_card",
        "session",
        "receipt",
      ],
    ),
    "submitGrade",
  ),
  tool(
    "finish_study_session",
    "Pause or end an open study session early using its expected revision. Normal queue completion happens in the final submit_grade; this action does not navigate or create another review.",
    objectSchema(
      {
        session_id: ID,
        disposition: { enum: ["pause", "end"] },
        expected_session_revision: REVISION,
        idempotency_key: IDEMPOTENCY_KEY,
      },
      ["session_id", "disposition", "expected_session_revision", "idempotency_key"],
    ),
    objectSchema(
      {
        session_id: ID,
        status: { enum: ["paused", "finished"] },
        summary: objectSchema(
          {
            reviewed_count: COUNT,
            rating_counts: objectSchema(
              { again: COUNT, hard: COUNT, good: COUNT, easy: COUNT },
              ["again", "hard", "good", "easy"],
            ),
            started_at: TIMESTAMP,
            finished_at: nullable(TIMESTAMP),
          },
          ["reviewed_count", "rating_counts", "started_at", "finished_at"],
        ),
        receipt: RECEIPT_SCHEMA,
      },
      ["session_id", "status", "summary", "receipt"],
    ),
    "finishStudySession",
  ),
];

export const WEBMCP_TOOL_NAMES = Object.freeze(TOOL_DEFINITIONS.map(({ name }) => name));

export const WEBMCP_TOOL_SCHEMAS = Object.freeze(
  Object.fromEntries(
    TOOL_DEFINITIONS.map(({ name, inputSchema, outputSchema }) => [
      name,
      Object.freeze({
        input: jsonSafe(inputSchema, "INVALID_TOOL_INPUT"),
        output: jsonSafe(outputSchema, "INVALID_TOOL_OUTPUT"),
      }),
    ]),
  ),
);

// Account-backed hosts supply the Accounts fence (capture/isCurrent) and a fresh
// store/client per auth epoch. This guards tool delivery, not authentication,
// outbox ownership or hydration ordering. Browser-local hosts may omit it.
export async function registerWebMCPTools({ store, onVisibleEffect, executionGuard } = {}) {
  if (!store || typeof store !== "object") {
    throw new TypeError("registerWebMCPTools requires a study store");
  }
  if (onVisibleEffect !== undefined && typeof onVisibleEffect !== "function") {
    throw new TypeError("onVisibleEffect must be a function when provided");
  }
  if (
    executionGuard !== undefined &&
    (!executionGuard || typeof executionGuard.capture !== "function" || typeof executionGuard.isCurrent !== "function")
  ) {
    throw new TypeError("executionGuard must provide synchronous capture and isCurrent functions");
  }

  function executionIsCurrent(ticket) {
    if (executionGuard === undefined) return true;
    try {
      const current = executionGuard.isCurrent(ticket);
      if (current && typeof current.then === "function") {
        Promise.resolve(current).catch(() => {});
        return false;
      }
      return current === true;
    } catch {
      return false;
    }
  }

  function captureExecution() {
    if (executionGuard === undefined) return { captured: true, ticket: undefined };
    try {
      const ticket = executionGuard.capture();
      if (ticket && typeof ticket.then === "function") {
        Promise.resolve(ticket).catch(() => {});
        return { captured: false, ticket: undefined };
      }
      return { captured: true, ticket };
    } catch {
      return { captured: false, ticket: undefined };
    }
  }

  if (globalThis.window && globalThis.window.top !== globalThis.window) {
    return {
      supported: false,
      registered: [],
      reason: "Site tools must be registered by the top-level page; iframe registration was skipped.",
    };
  }

  const modelContext = globalThis.document?.modelContext;
  if (!modelContext || typeof modelContext.registerTool !== "function") {
    return {
      supported: false,
      registered: [],
      reason: "document.modelContext.registerTool is unavailable; the normal website UI remains usable.",
    };
  }

  const missingMethods = TOOL_DEFINITIONS
    .filter(({ storeMethod }) => typeof store[storeMethod] !== "function")
    .map(({ storeMethod }) => storeMethod);
  if (missingMethods.length) {
    return {
      supported: true,
      registered: [],
      failed: {
        code: "STORE_CONTRACT_INCOMPLETE",
        message: `The study store is missing required WebMCP handlers: ${missingMethods.join(", ")}`,
        missing_methods: missingMethods,
      },
    };
  }

  const registered = [];
  let registrationReady = false;
  let registrationAccountChanged = false;
  // Old callbacks still reference this store. Never let them adopt a later
  // account's ticket, including when identity changes while registration awaits.
  const registrationExecution = captureExecution();
  for (const definition of TOOL_DEFINITIONS) {
    try {
      await modelContext.registerTool({
        name: definition.name,
        title: definition.title,
        description: definition.description,
        inputSchema: jsonSafe(definition.inputSchema, "INVALID_TOOL_INPUT"),
        ...(definition.readOnly ? { annotations: { readOnlyHint: true } } : {}),
        execute: async (input = {}) => {
          if (!registrationReady) {
            if (registrationAccountChanged) return accountChangedEnvelope(false);
            return failureEnvelope(
              "TOOL_SURFACE_UNAVAILABLE",
              "The complete 13-tool site surface did not finish registering.",
              true,
            );
          }
          const execution = captureExecution();
          const executionContext = execution.ticket;
          let confirmedCommit = false;
          const isCurrent = () => registrationExecution.captured && execution.captured &&
            executionIsCurrent(registrationExecution.ticket) && executionIsCurrent(executionContext);
          try {
            if (!isCurrent()) return accountChangedEnvelope(false);
            validateValue(definition.inputSchema, input, "input", "INVALID_TOOL_INPUT");
            const safeInput = jsonSafe(input, "INVALID_TOOL_INPUT");
            const method = store[definition.storeMethod];
            const rawResult = await method.call(store, safeInput, {
              source: "webmcp",
              tool_name: definition.name,
            });
            const data = jsonSafe(rawResult, "INVALID_TOOL_OUTPUT");
            validateValue(definition.outputSchema, data, "data", "INVALID_TOOL_OUTPUT");
            if (definition.resultInvariant) definition.resultInvariant(data);
            if (!definition.readOnly) {
              if (data.receipt.operation !== definition.name || data.receipt.idempotency_key !== safeInput.idempotency_key) {
                contractError("INVALID_TOOL_OUTPUT", "data.receipt", "must identify the original tool operation and idempotency key");
              }
              // A partial, malformed or unrelated receipt is not commit proof.
              confirmedCommit = true;
            }
            if (!isCurrent()) return accountChangedEnvelope(confirmedCommit);
            if (
              !definition.readOnly &&
              onVisibleEffect &&
              data.receipt.replayed === false
            ) {
              try {
                await onVisibleEffect(
                  committedVisibleEffect(definition.name, data),
                  {
                    tool_name: definition.name,
                    idempotency_key: data.receipt.idempotency_key,
                    transaction_id: data.receipt.transaction_id,
                    ...(executionGuard === undefined ? {} : { execution_context: executionContext }),
                  },
                );
              } catch {
                // The state transaction is already committed. Presentation failure must
                // never turn it into a second grade attempt or a misleading write error.
              }
            }
            // Presentation can await hydration/animation. Recheck the ORIGINAL
            // ticket after that await before exposing any old-account result.
            if (!isCurrent()) return accountChangedEnvelope(confirmedCommit);
            return { ok: true, data };
          } catch (error) {
            if (!isCurrent()) {
              return accountChangedEnvelope(confirmedCommit);
            }
            return toolError(error);
          }
        },
      });
      registered.push(definition.name);
    } catch (error) {
      return {
        supported: true,
        registered,
        failed: {
          tool_name: definition.name,
          code: "REGISTRATION_FAILED",
          message: safeMessage(error),
        },
      };
    }
  }

  if (!registrationExecution.captured || !executionIsCurrent(registrationExecution.ticket)) {
    registrationAccountChanged = true;
    return {
      supported: true,
      registered,
      failed: { code: "ACCOUNT_CHANGED", message: "The account context changed while registering its tools; re-register for the current account." },
    };
  }
  registrationReady = true;
  return { supported: true, registered };
}

function tool(name, description, inputSchema, outputSchema, storeMethod, readOnly = false, resultInvariant) {
  return {
    name,
    title: name
      .split("_")
      .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
      .join(" "),
    description,
    inputSchema,
    outputSchema,
    storeMethod,
    readOnly,
    resultInvariant,
  };
}

function committedVisibleEffect(toolName, data) {
  if (toolName === "submit_grade") {
    return jsonSafe(
      {
        type: "study_grade_committed",
        session_id: data.session_id,
        reviewed_card_id: data.card_id,
        reviewed_card: data.reviewed_card,
        session: data.session,
        ...(data.next_card ? { next_card: data.next_card } : {}),
        completion_state: data.session.status === "completed" ? "completed" : "in_progress",
      },
      "INVALID_TOOL_OUTPUT",
    );
  }
  return jsonSafe(
    {
      type: "webmcp_state_committed",
      tool_name: toolName,
      transaction_id: data.receipt.transaction_id,
      app_revision: data.receipt.app_revision,
    },
    "INVALID_TOOL_OUTPUT",
  );
}

function completeDeckResult(data) {
  if (data.complete !== true || data.deck.cards.length !== data.card_count) {
    contractError(
      "INVALID_TOOL_OUTPUT",
      "data.card_count",
      "must equal the number of cards in the complete deck result",
    );
  }
}

function accountChangedEnvelope(confirmedCommit) {
  return failureEnvelope(
    confirmedCommit ? "ACCOUNT_CHANGED_AFTER_COMMIT" : "ACCOUNT_CHANGED",
    confirmedCommit
      ? "The action was confirmed in the original account, but the account context changed. Its result was withheld. Return to the original account and reuse the original idempotency key to recover it; do not grade again with a new key."
      : "The account context changed, so this result was withheld. A submitted action may already be saved; recover it in the original account with the original idempotency key.",
    false,
  );
}

function toolError(error) {
  const code =
    error instanceof StudyStoreError || typeof error?.code === "string"
      ? String(error.code).slice(0, 128)
      : "TOOL_EXECUTION_FAILED";
  const issues = normalizeIssues(error);
  return failureEnvelope(code, safeMessage(error), isRetryable(code), issues);
}

function failureEnvelope(code, message, retryable = false, issues = []) {
  return {
    ok: false,
    error: {
      code,
      message: String(message).slice(0, 2_000),
      retryable: Boolean(retryable),
      ...(issues.length ? { issues } : {}),
    },
  };
}

function normalizeIssues(error) {
  const raw = Array.isArray(error?.issues)
    ? error.issues
    : Array.isArray(error?.details?.issues)
      ? error.details.issues
      : [];
  return raw.slice(0, 100).map((issue) => ({
    code: String(issue?.code ?? error?.code ?? "TOOL_ERROR").slice(0, 128),
    path: String(issue?.path ?? "input").slice(0, 500),
    message: String(issue?.message ?? safeMessage(error)).slice(0, 2_000),
  }));
}

function isRetryable(code) {
  return new Set([
    "ACTIVE_SESSION_EXISTS",
    "DECK_IN_ACTIVE_SESSION",
    "STALE_APP_REVISION",
    "STALE_REVISION",
    "TOOL_SURFACE_UNAVAILABLE",
    // The durable adapter retains the original account, payload and action
    // key; retry these only as that exact intent, never as a new grade.
    "SERVICE_BUSY",
    "REQUEST_UNCONFIRMED",
    "COMMIT_UNCONFIRMED",
    "MALFORMED_RESPONSE",
  ]).has(code);
}

function safeMessage(error) {
  if (error instanceof Error && error.message) return error.message.slice(0, 2_000);
  return "The site tool could not complete the requested operation.";
}

function jsonSafe(value, code) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("value is not JSON serializable");
    return JSON.parse(serialized);
  } catch (error) {
    const wrapped = new Error("The tool value is not JSON serializable.");
    wrapped.code = code;
    wrapped.issues = [
      {
        code,
        path: code === "INVALID_TOOL_INPUT" ? "input" : "data",
        message: safeMessage(error),
      },
    ];
    throw wrapped;
  }
}

function validateValue(schema, value, path, errorCode) {
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validateValue(candidate, value, path, errorCode);
        return true;
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) {
      contractError(errorCode, path, "must match exactly one allowed shape");
    }
    validateValue(matches[0], value, path, errorCode);
    return;
  }

  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    contractError(errorCode, path, `must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    contractError(errorCode, path, `must be one of ${schema.enum.join(", ")}`);
  }

  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      contractError(errorCode, path, "must be an object");
    }
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      contractError(errorCode, path, `must contain at least ${schema.minProperties} properties`);
    }
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        contractError(errorCode, `${path}.${required}`, "is required");
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of keys) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          contractError(errorCode, `${path}.${key}`, "is not an allowed property");
        }
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        validateValue(childSchema, value[key], `${path}.${key}`, errorCode);
      }
    }
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) contractError(errorCode, path, "must be an array");
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      contractError(errorCode, path, `must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      contractError(errorCode, path, `must contain at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems) {
      const unique = new Set(value.map(stableStringify));
      if (unique.size !== value.length) contractError(errorCode, path, "must contain unique items");
    }
    value.forEach((item, index) =>
      validateValue(schema.items ?? {}, item, `${path}[${index}]`, errorCode),
    );
    return;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") contractError(errorCode, path, "must be a string");
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      contractError(errorCode, path, `must contain at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      contractError(errorCode, path, `must contain at most ${schema.maxLength} characters`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      contractError(errorCode, path, "has an invalid format");
    }
    return;
  }

  if (schema.type === "integer") {
    if (!Number.isInteger(value)) contractError(errorCode, path, "must be an integer");
    validateBounds(schema, value, path, errorCode);
    return;
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      contractError(errorCode, path, "must be a finite number");
    }
    validateBounds(schema, value, path, errorCode);
    return;
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    contractError(errorCode, path, "must be a boolean");
  }
  if (schema.type === "null" && value !== null) {
    contractError(errorCode, path, "must be null");
  }
}

function validateBounds(schema, value, path, errorCode) {
  if (schema.minimum !== undefined && value < schema.minimum) {
    contractError(errorCode, path, `must be at least ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    contractError(errorCode, path, `must be at most ${schema.maximum}`);
  }
}

function contractError(code, path, message) {
  const error = new Error(`${path} ${message}`);
  error.code = code;
  error.issues = [{ code, path, message }];
  throw error;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
