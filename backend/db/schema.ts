// Sites schema input; declarations mirror migrations/0001_learner_data.sql.
// Runtime operations use the prepared D1 API in src/d1-repository.mjs.
import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const meshfulPrincipals = sqliteTable("meshful_principals", {
  principalId: text("principal_id").primaryKey().notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  check("meshful_principals_id_nonempty", sql`length(${table.principalId}) > 0`),
  check("meshful_principals_created_nonempty", sql`length(${table.createdAt}) > 0`),
]);

export const meshfulIdentityBindings = sqliteTable("meshful_identity_bindings", {
  provider: text("provider").notNull(),
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  principalId: text("principal_id").notNull().references(() => meshfulPrincipals.principalId),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ name: "meshful_identity_bindings_pk", columns: [table.provider, table.issuer, table.subject] }),
  check("meshful_identity_provider_nonempty", sql`length(${table.provider}) > 0`),
  check("meshful_identity_issuer_nonempty", sql`length(${table.issuer}) > 0`),
  check("meshful_identity_subject_nonempty", sql`length(${table.subject}) > 0`),
  check("meshful_identity_created_nonempty", sql`length(${table.createdAt}) > 0`),
]);

export const meshfulLearnerState = sqliteTable("meshful_learner_state", {
  principalId: text("principal_id").primaryKey().notNull().references(() => meshfulPrincipals.principalId),
  revision: integer("revision").notNull().default(0),
  stateJson: text("state_json"),
  catalogVersion: text("catalog_version"),
  catalogDigest: text("catalog_digest"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("meshful_state_revision", sql`typeof(${table.revision}) = 'integer' AND ${table.revision} >= 0 AND ${table.revision} <= 9007199254740991`),
  check("meshful_state_json", sql`${table.stateJson} IS NULL OR json_valid(${table.stateJson})`),
  check("meshful_state_catalog", sql`(${table.stateJson} IS NULL AND ${table.catalogVersion} IS NULL AND ${table.catalogDigest} IS NULL) OR (${table.stateJson} IS NOT NULL AND ${table.catalogVersion} IS NOT NULL AND length(${table.catalogVersion}) > 0 AND ${table.catalogDigest} IS NOT NULL AND length(${table.catalogDigest}) > 0)`),
  check("meshful_state_updated_nonempty", sql`length(${table.updatedAt}) > 0`),
]);

export const meshfulRequestReceipts = sqliteTable("meshful_request_receipts", {
  principalId: text("principal_id").notNull().references(() => meshfulPrincipals.principalId),
  requestId: text("request_id").notNull(),
  revision: integer("revision").notNull(),
  fingerprint: text("fingerprint").notNull(),
  responseJson: text("response_json").notNull(),
  attemptToken: text("attempt_token").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ name: "meshful_request_receipts_pk", columns: [table.principalId, table.requestId] }),
  uniqueIndex("meshful_receipt_owner_revision").on(table.principalId, table.revision),
  uniqueIndex("meshful_receipt_attempt_token").on(table.attemptToken),
  check("meshful_receipt_request_nonempty", sql`length(${table.requestId}) > 0`),
  check("meshful_receipt_revision", sql`typeof(${table.revision}) = 'integer' AND ${table.revision} > 0 AND ${table.revision} <= 9007199254740991`),
  check("meshful_receipt_fingerprint_nonempty", sql`length(${table.fingerprint}) > 0`),
  check("meshful_receipt_response_json", sql`json_valid(${table.responseJson})`),
  check("meshful_receipt_attempt_nonempty", sql`length(${table.attemptToken}) > 0`),
  check("meshful_receipt_created_nonempty", sql`length(${table.createdAt}) > 0`),
]);

export const meshfulReviewEvents = sqliteTable("meshful_review_events", {
  principalId: text("principal_id").notNull().references(() => meshfulPrincipals.principalId),
  eventId: text("event_id").notNull(),
  revision: integer("revision").notNull(),
  deckId: text("deck_id").notNull(),
  cardId: text("card_id").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ name: "meshful_review_events_pk", columns: [table.principalId, table.eventId] }),
  foreignKey({ name: "meshful_review_receipt_fk", columns: [table.principalId, table.revision], foreignColumns: [meshfulRequestReceipts.principalId, meshfulRequestReceipts.revision] }),
  index("meshful_review_owner_revision_event").on(table.principalId, table.revision, table.eventId),
  check("meshful_review_event_nonempty", sql`length(${table.eventId}) > 0`),
  check("meshful_review_revision", sql`typeof(${table.revision}) = 'integer' AND ${table.revision} > 0 AND ${table.revision} <= 9007199254740991`),
  check("meshful_review_deck_nonempty", sql`length(${table.deckId}) > 0`),
  check("meshful_review_card_nonempty", sql`length(${table.cardId}) > 0`),
  check("meshful_review_payload_json", sql`json_valid(${table.payloadJson})`),
  check("meshful_review_created_nonempty", sql`length(${table.createdAt}) > 0`),
]);

export const meshfulImportArchives = sqliteTable("meshful_import_archives", {
  principalId: text("principal_id").notNull().references(() => meshfulPrincipals.principalId),
  sourceId: text("source_id").notNull(),
  digest: text("digest").notNull(),
  rawJson: text("raw_json").notNull(),
  revision: integer("revision").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ name: "meshful_import_archives_pk", columns: [table.principalId, table.sourceId] }),
  foreignKey({ name: "meshful_import_receipt_fk", columns: [table.principalId, table.revision], foreignColumns: [meshfulRequestReceipts.principalId, meshfulRequestReceipts.revision] }),
  uniqueIndex("meshful_import_source_claim").on(table.sourceId),
  check("meshful_import_source_nonempty", sql`length(${table.sourceId}) > 0`),
  check("meshful_import_digest_nonempty", sql`length(${table.digest}) > 0`),
  check("meshful_import_raw_json", sql`json_valid(${table.rawJson})`),
  check("meshful_import_revision", sql`typeof(${table.revision}) = 'integer' AND ${table.revision} > 0 AND ${table.revision} <= 9007199254740991`),
  check("meshful_import_created_nonempty", sql`length(${table.createdAt}) > 0`),
]);
