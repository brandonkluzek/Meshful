/**
 * Sites/Website migration-review input, not a second runtime storage path.
 * Include this file AND ../../db/schema.ts in Website's schema configuration.
 * Identity tables remain owned by the original schema; none are redeclared here.
 *
 * IMPORTANT: generated SQL is NOT equivalent to, or deployable instead of,
 * ../migrations/0002_fragmented_storage.sql without the mandatory custom SQL:
 *   - meshful_v2_receipts(principal_id, response_document_id) must reference
 *     meshful_v2_documents(principal_id, document_id) DEFERRABLE INITIALLY DEFERRED.
 *     The foreignKey declaration below records its columns but cannot express
 *     that deferral through the Drizzle SQLite API used here. An immediate FK
 *     prevents receipt-first atomic admission from succeeding.
 *   - All 23 authored triggers are required: cross-version receipt/review/source
 *     protection, v1 takeover protection, complete/consecutive head transitions,
 *     and immutable heads, objects, documents, parts, receipts, reviews, imports.
 * Drizzle declarations below do not create those triggers. Review and retain the
 * exact custom migration/journal before enabling any endpoint. Named checks and
 * unique indexes express the same constraints as SQL's unnamed CHECK/UNIQUEs;
 * this file is not an applied-migration or generated-SQL parity receipt.
 */
import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { meshfulPrincipals } from "../../db/schema";

// Explicit callback returns break circular type inference between receipts and
// documents without weakening either table's inferred column types.
type TableConstraint = ReturnType<typeof check> | ReturnType<typeof foreignKey>
  | ReturnType<typeof index> | ReturnType<typeof primaryKey> | ReturnType<typeof uniqueIndex>;

export const meshfulV2Objects = sqliteTable("meshful_v2_objects", {
  principalId: text("principal_id").notNull().references(() => meshfulPrincipals.principalId),
  digest: text("digest").notNull(),
  byteLength: integer("byte_length").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
}, (table): TableConstraint[] => [
  primaryKey({ name: "meshful_v2_objects_pk", columns: [table.principalId, table.digest] }),
  uniqueIndex("meshful_v2_objects_owner_digest_bytes").on(table.principalId, table.digest, table.byteLength),
  check("meshful_v2_objects_digest", sql`length(${table.digest}) = 71 AND substr(${table.digest}, 1, 7) = 'sha256:'`),
  check("meshful_v2_objects_bytes", sql`typeof(${table.byteLength}) = 'integer' AND ${table.byteLength} >= 0 AND ${table.byteLength} <= 65536`),
  check("meshful_v2_objects_body_bytes", sql`length(CAST(${table.body} AS BLOB)) = ${table.byteLength}`),
  check("meshful_v2_objects_created", sql`length(CAST(${table.createdAt} AS BLOB)) BETWEEN 1 AND 512`),
]);

export const meshfulV2Documents = sqliteTable("meshful_v2_documents", {
  principalId: text("principal_id").notNull().references(() => meshfulPrincipals.principalId),
  documentId: text("document_id").notNull(),
  kind: text("kind").notNull(),
  revision: integer("revision").notNull(),
  byteLength: integer("byte_length").notNull(),
  digest: text("digest").notNull(),
  partCount: integer("part_count").notNull(),
  createdAt: text("created_at").notNull(),
}, (table): TableConstraint[] => [
  primaryKey({ name: "meshful_v2_documents_pk", columns: [table.principalId, table.documentId] }),
  foreignKey({ name: "meshful_v2_documents_receipt_fk", columns: [table.principalId, table.revision], foreignColumns: [meshfulV2Receipts.principalId, meshfulV2Receipts.revision] }),
  index("meshful_v2_documents_owner_revision").on(table.principalId, table.revision),
  check("meshful_v2_documents_id", sql`length(CAST(${table.documentId} AS BLOB)) BETWEEN 1 AND 2048`),
  check("meshful_v2_documents_kind", sql`${table.kind} IN ('state', 'receipt', 'review', 'import')`),
  check("meshful_v2_documents_revision", sql`typeof(${table.revision}) = 'integer' AND ${table.revision} > 0 AND ${table.revision} <= 9007199254740991`),
  check("meshful_v2_documents_bytes", sql`typeof(${table.byteLength}) = 'integer' AND ${table.byteLength} >= 0 AND ${table.byteLength} <= 9007199254740991`),
  check("meshful_v2_documents_digest", sql`length(${table.digest}) = 71 AND substr(${table.digest}, 1, 7) = 'sha256:'`),
  check("meshful_v2_documents_parts", sql`typeof(${table.partCount}) = 'integer' AND ${table.partCount} >= 0 AND ${table.partCount} <= 9007199254740991`),
  check("meshful_v2_documents_created", sql`length(CAST(${table.createdAt} AS BLOB)) BETWEEN 1 AND 512`),
]);

export const meshfulV2Parts = sqliteTable("meshful_v2_parts", {
  principalId: text("principal_id").notNull(),
  documentId: text("document_id").notNull(),
  ordinal: integer("ordinal").notNull(),
  objectDigest: text("object_digest").notNull(),
  byteLength: integer("byte_length").notNull(),
}, (table): TableConstraint[] => [
  primaryKey({ name: "meshful_v2_parts_pk", columns: [table.principalId, table.documentId, table.ordinal] }),
  foreignKey({ name: "meshful_v2_parts_document_fk", columns: [table.principalId, table.documentId], foreignColumns: [meshfulV2Documents.principalId, meshfulV2Documents.documentId] }),
  foreignKey({ name: "meshful_v2_parts_object_fk", columns: [table.principalId, table.objectDigest, table.byteLength], foreignColumns: [meshfulV2Objects.principalId, meshfulV2Objects.digest, meshfulV2Objects.byteLength] }),
  check("meshful_v2_parts_ordinal", sql`typeof(${table.ordinal}) = 'integer' AND ${table.ordinal} >= 0 AND ${table.ordinal} <= 9007199254740991`),
  check("meshful_v2_parts_bytes", sql`typeof(${table.byteLength}) = 'integer' AND ${table.byteLength} >= 0 AND ${table.byteLength} <= 65536`),
]);

export const meshfulV2Receipts = sqliteTable("meshful_v2_receipts", {
  principalId: text("principal_id").notNull().references(() => meshfulPrincipals.principalId),
  requestId: text("request_id").notNull(),
  revision: integer("revision").notNull(),
  fingerprint: text("fingerprint").notNull(),
  responseDocumentId: text("response_document_id").notNull(),
  attemptToken: text("attempt_token").notNull(),
  createdAt: text("created_at").notNull(),
}, (table): TableConstraint[] => [
  primaryKey({ name: "meshful_v2_receipts_pk", columns: [table.principalId, table.requestId] }),
  uniqueIndex("meshful_v2_receipts_owner_revision").on(table.principalId, table.revision),
  uniqueIndex("meshful_v2_receipts_attempt_token").on(table.attemptToken),
  // MUST be DEFERRABLE INITIALLY DEFERRED in custom 0002 SQL; see file header.
  foreignKey({ name: "meshful_v2_receipts_response_document_fk", columns: [table.principalId, table.responseDocumentId], foreignColumns: [meshfulV2Documents.principalId, meshfulV2Documents.documentId] }),
  check("meshful_v2_receipts_request", sql`length(CAST(${table.requestId} AS BLOB)) BETWEEN 1 AND 512`),
  check("meshful_v2_receipts_revision", sql`typeof(${table.revision}) = 'integer' AND ${table.revision} > 0 AND ${table.revision} <= 9007199254740991`),
  check("meshful_v2_receipts_fingerprint", sql`length(CAST(${table.fingerprint} AS BLOB)) BETWEEN 1 AND 2048`),
  check("meshful_v2_receipts_response", sql`length(CAST(${table.responseDocumentId} AS BLOB)) BETWEEN 1 AND 2048`),
  check("meshful_v2_receipts_attempt", sql`length(CAST(${table.attemptToken} AS BLOB)) BETWEEN 1 AND 512`),
  check("meshful_v2_receipts_created", sql`length(CAST(${table.createdAt} AS BLOB)) BETWEEN 1 AND 512`),
]);

export const meshfulV2Heads = sqliteTable("meshful_v2_heads", {
  principalId: text("principal_id").primaryKey().notNull().references(() => meshfulPrincipals.principalId),
  revision: integer("revision").notNull(),
  stateDocumentId: text("state_document_id").notNull(),
  catalogVersion: text("catalog_version").notNull(),
  catalogDigest: text("catalog_digest").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table): TableConstraint[] => [
  foreignKey({ name: "meshful_v2_heads_document_fk", columns: [table.principalId, table.stateDocumentId], foreignColumns: [meshfulV2Documents.principalId, meshfulV2Documents.documentId] }),
  foreignKey({ name: "meshful_v2_heads_receipt_fk", columns: [table.principalId, table.revision], foreignColumns: [meshfulV2Receipts.principalId, meshfulV2Receipts.revision] }),
  check("meshful_v2_heads_revision", sql`typeof(${table.revision}) = 'integer' AND ${table.revision} > 0 AND ${table.revision} <= 9007199254740991`),
  check("meshful_v2_heads_document", sql`length(CAST(${table.stateDocumentId} AS BLOB)) BETWEEN 1 AND 2048`),
  check("meshful_v2_heads_catalog_version", sql`length(CAST(${table.catalogVersion} AS BLOB)) BETWEEN 1 AND 2048`),
  check("meshful_v2_heads_catalog_digest", sql`length(CAST(${table.catalogDigest} AS BLOB)) BETWEEN 1 AND 2048`),
  check("meshful_v2_heads_updated", sql`length(CAST(${table.updatedAt} AS BLOB)) BETWEEN 1 AND 512`),
]);

export const meshfulV2ReviewEvents = sqliteTable("meshful_v2_review_events", {
  principalId: text("principal_id").notNull(),
  eventId: text("event_id").notNull(),
  revision: integer("revision").notNull(),
  deckId: text("deck_id").notNull(),
  cardId: text("card_id").notNull(),
  documentId: text("document_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table): TableConstraint[] => [
  primaryKey({ name: "meshful_v2_reviews_pk", columns: [table.principalId, table.eventId] }),
  foreignKey({ name: "meshful_v2_reviews_receipt_fk", columns: [table.principalId, table.revision], foreignColumns: [meshfulV2Receipts.principalId, meshfulV2Receipts.revision] }),
  foreignKey({ name: "meshful_v2_reviews_document_fk", columns: [table.principalId, table.documentId], foreignColumns: [meshfulV2Documents.principalId, meshfulV2Documents.documentId] }),
  index("meshful_v2_reviews_owner_revision_event").on(table.principalId, table.revision, table.eventId),
  check("meshful_v2_reviews_event", sql`length(CAST(${table.eventId} AS BLOB)) BETWEEN 1 AND 512`),
  check("meshful_v2_reviews_deck", sql`length(CAST(${table.deckId} AS BLOB)) BETWEEN 1 AND 2048`),
  check("meshful_v2_reviews_card", sql`length(CAST(${table.cardId} AS BLOB)) BETWEEN 1 AND 2048`),
  check("meshful_v2_reviews_created", sql`length(CAST(${table.createdAt} AS BLOB)) BETWEEN 1 AND 512`),
]);

export const meshfulV2ImportArchives = sqliteTable("meshful_v2_import_archives", {
  principalId: text("principal_id").notNull(),
  sourceId: text("source_id").notNull(),
  digest: text("digest").notNull(),
  documentId: text("document_id").notNull(),
  revision: integer("revision").notNull(),
  createdAt: text("created_at").notNull(),
}, (table): TableConstraint[] => [
  primaryKey({ name: "meshful_v2_imports_pk", columns: [table.principalId, table.sourceId] }),
  uniqueIndex("meshful_v2_imports_source_claim").on(table.sourceId),
  foreignKey({ name: "meshful_v2_imports_receipt_fk", columns: [table.principalId, table.revision], foreignColumns: [meshfulV2Receipts.principalId, meshfulV2Receipts.revision] }),
  foreignKey({ name: "meshful_v2_imports_document_fk", columns: [table.principalId, table.documentId], foreignColumns: [meshfulV2Documents.principalId, meshfulV2Documents.documentId] }),
  check("meshful_v2_imports_source", sql`length(CAST(${table.sourceId} AS BLOB)) BETWEEN 1 AND 512`),
  check("meshful_v2_imports_digest", sql`length(${table.digest}) = 71 AND substr(${table.digest}, 1, 7) = 'sha256:'`),
  check("meshful_v2_imports_created", sql`length(CAST(${table.createdAt} AS BLOB)) BETWEEN 1 AND 512`),
]);
