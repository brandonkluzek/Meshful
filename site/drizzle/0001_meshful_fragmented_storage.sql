-- Additive successor to 0001. Apply through Website's Sites migration path.
-- V1 rows remain recovery evidence. No learner JSON is concatenated in SQL.

CREATE TABLE meshful_v2_objects (
  principal_id TEXT NOT NULL REFERENCES meshful_principals(principal_id),
  digest TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, digest),
  UNIQUE (principal_id, digest, byte_length),
  CHECK (length(digest) = 71 AND substr(digest, 1, 7) = 'sha256:'),
  CHECK (typeof(byte_length) = 'integer' AND byte_length >= 0 AND byte_length <= 65536),
  CHECK (length(CAST(body AS BLOB)) = byte_length),
  CHECK (length(CAST(created_at AS BLOB)) BETWEEN 1 AND 512)
);
--> statement-breakpoint
CREATE TABLE meshful_v2_documents (
  principal_id TEXT NOT NULL REFERENCES meshful_principals(principal_id),
  document_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  revision INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  digest TEXT NOT NULL,
  part_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, document_id),
  FOREIGN KEY (principal_id, revision)
    REFERENCES meshful_v2_receipts(principal_id, revision),
  CHECK (length(CAST(document_id AS BLOB)) BETWEEN 1 AND 2048),
  CHECK (kind IN ('state', 'receipt', 'review', 'import')),
  CHECK (typeof(revision) = 'integer' AND revision > 0 AND revision <= 9007199254740991),
  CHECK (typeof(byte_length) = 'integer' AND byte_length >= 0 AND byte_length <= 9007199254740991),
  CHECK (length(digest) = 71 AND substr(digest, 1, 7) = 'sha256:'),
  CHECK (typeof(part_count) = 'integer' AND part_count >= 0 AND part_count <= 9007199254740991),
  CHECK (length(CAST(created_at AS BLOB)) BETWEEN 1 AND 512)
);
--> statement-breakpoint
CREATE INDEX meshful_v2_documents_owner_revision
  ON meshful_v2_documents(principal_id, revision);
--> statement-breakpoint
CREATE TABLE meshful_v2_parts (
  principal_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  object_digest TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  PRIMARY KEY (principal_id, document_id, ordinal),
  FOREIGN KEY (principal_id, document_id)
    REFERENCES meshful_v2_documents(principal_id, document_id),
  FOREIGN KEY (principal_id, object_digest, byte_length)
    REFERENCES meshful_v2_objects(principal_id, digest, byte_length),
  CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0 AND ordinal <= 9007199254740991),
  CHECK (typeof(byte_length) = 'integer' AND byte_length >= 0 AND byte_length <= 65536)
);
--> statement-breakpoint
CREATE TABLE meshful_v2_receipts (
  principal_id TEXT NOT NULL REFERENCES meshful_principals(principal_id),
  request_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  response_document_id TEXT NOT NULL,
  attempt_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, request_id),
  UNIQUE (principal_id, revision),
  -- Admission precedes fragments. The complete batch must supply this document.
  FOREIGN KEY (principal_id, response_document_id)
    REFERENCES meshful_v2_documents(principal_id, document_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (length(CAST(request_id AS BLOB)) BETWEEN 1 AND 512),
  CHECK (typeof(revision) = 'integer' AND revision > 0 AND revision <= 9007199254740991),
  CHECK (length(CAST(fingerprint AS BLOB)) BETWEEN 1 AND 2048),
  CHECK (length(CAST(response_document_id AS BLOB)) BETWEEN 1 AND 2048),
  CHECK (length(CAST(attempt_token AS BLOB)) BETWEEN 1 AND 512),
  CHECK (length(CAST(created_at AS BLOB)) BETWEEN 1 AND 512)
);
--> statement-breakpoint
CREATE TABLE meshful_v2_heads (
  principal_id TEXT PRIMARY KEY NOT NULL REFERENCES meshful_principals(principal_id),
  revision INTEGER NOT NULL,
  state_document_id TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  catalog_digest TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (principal_id, state_document_id)
    REFERENCES meshful_v2_documents(principal_id, document_id),
  FOREIGN KEY (principal_id, revision)
    REFERENCES meshful_v2_receipts(principal_id, revision),
  CHECK (typeof(revision) = 'integer' AND revision > 0 AND revision <= 9007199254740991),
  CHECK (length(CAST(state_document_id AS BLOB)) BETWEEN 1 AND 2048),
  CHECK (length(CAST(catalog_version AS BLOB)) BETWEEN 1 AND 2048),
  CHECK (length(CAST(catalog_digest AS BLOB)) BETWEEN 1 AND 2048),
  CHECK (length(CAST(updated_at AS BLOB)) BETWEEN 1 AND 512)
);
--> statement-breakpoint
CREATE TABLE meshful_v2_review_events (
  principal_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  deck_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, event_id),
  FOREIGN KEY (principal_id, revision)
    REFERENCES meshful_v2_receipts(principal_id, revision),
  FOREIGN KEY (principal_id, document_id)
    REFERENCES meshful_v2_documents(principal_id, document_id),
  CHECK (length(CAST(event_id AS BLOB)) BETWEEN 1 AND 512),
  CHECK (length(CAST(deck_id AS BLOB)) BETWEEN 1 AND 2048),
  CHECK (length(CAST(card_id AS BLOB)) BETWEEN 1 AND 2048),
  CHECK (length(CAST(created_at AS BLOB)) BETWEEN 1 AND 512)
);
--> statement-breakpoint
CREATE INDEX meshful_v2_reviews_owner_revision_event
  ON meshful_v2_review_events(principal_id, revision, event_id);
--> statement-breakpoint
CREATE TABLE meshful_v2_import_archives (
  principal_id TEXT NOT NULL,
  source_id TEXT NOT NULL UNIQUE,
  digest TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, source_id),
  FOREIGN KEY (principal_id, revision)
    REFERENCES meshful_v2_receipts(principal_id, revision),
  FOREIGN KEY (principal_id, document_id)
    REFERENCES meshful_v2_documents(principal_id, document_id),
  CHECK (length(CAST(source_id AS BLOB)) BETWEEN 1 AND 512),
  CHECK (length(digest) = 71 AND substr(digest, 1, 7) = 'sha256:'),
  CHECK (length(CAST(created_at AS BLOB)) BETWEEN 1 AND 512)
);
--> statement-breakpoint
-- No admission may shadow a previously committed request in either format.
CREATE TRIGGER meshful_v2_receipt_preserve_v1
BEFORE INSERT ON meshful_v2_receipts
WHEN EXISTS (SELECT 1 FROM meshful_request_receipts
  WHERE principal_id = NEW.principal_id AND request_id = NEW.request_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_REQUEST_ALREADY_EXISTS'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v1_receipt_preserve_v2
BEFORE INSERT ON meshful_request_receipts
WHEN EXISTS (SELECT 1 FROM meshful_v2_receipts
  WHERE principal_id = NEW.principal_id AND request_id = NEW.request_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_REQUEST_ALREADY_EXISTS'); END;
--> statement-breakpoint
-- Both versions must agree on the global, non-transferable local-source claim.
CREATE TRIGGER meshful_v2_import_preserve_v1
BEFORE INSERT ON meshful_v2_import_archives
WHEN EXISTS (SELECT 1 FROM meshful_import_archives WHERE source_id = NEW.source_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_LOCAL_SOURCE_ALREADY_CLAIMED'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v1_import_preserve_v2
BEFORE INSERT ON meshful_import_archives
WHEN EXISTS (SELECT 1 FROM meshful_v2_import_archives WHERE source_id = NEW.source_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_LOCAL_SOURCE_ALREADY_CLAIMED'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_review_preserve_v1
BEFORE INSERT ON meshful_v2_review_events
WHEN EXISTS (SELECT 1 FROM meshful_review_events
  WHERE principal_id = NEW.principal_id AND event_id = NEW.event_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_REVIEW_ALREADY_EXISTS'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v1_review_preserve_v2
BEFORE INSERT ON meshful_review_events
WHEN EXISTS (SELECT 1 FROM meshful_v2_review_events
  WHERE principal_id = NEW.principal_id AND event_id = NEW.event_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_REVIEW_ALREADY_EXISTS'); END;
--> statement-breakpoint
-- Once the atomic v2 head exists, an old server cannot overwrite the v1 shadow.
CREATE TRIGGER meshful_v1_state_after_takeover_update
BEFORE UPDATE ON meshful_learner_state
WHEN EXISTS (SELECT 1 FROM meshful_v2_heads WHERE principal_id = OLD.principal_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_STORAGE_V2_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v1_state_after_takeover_delete
BEFORE DELETE ON meshful_learner_state
WHEN EXISTS (SELECT 1 FROM meshful_v2_heads WHERE principal_id = OLD.principal_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_STORAGE_V2_REQUIRED'); END;
--> statement-breakpoint
-- The final head switch also asserts complete manifests for this admission.
CREATE TRIGGER meshful_v2_head_complete_insert
BEFORE INSERT ON meshful_v2_heads
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM meshful_v2_documents
    WHERE principal_id = NEW.principal_id AND document_id = NEW.state_document_id
      AND kind = 'state' AND revision = NEW.revision
  ) OR EXISTS (
    SELECT 1 FROM meshful_v2_documents d
    WHERE d.principal_id = NEW.principal_id AND d.revision = NEW.revision AND (
      d.part_count <> (SELECT count(*) FROM meshful_v2_parts p
        WHERE p.principal_id = d.principal_id AND p.document_id = d.document_id)
      OR d.byte_length <> (SELECT coalesce(sum(p.byte_length), 0) FROM meshful_v2_parts p
        WHERE p.principal_id = d.principal_id AND p.document_id = d.document_id)
      OR d.part_count - 1 <> (SELECT coalesce(max(p.ordinal), -1) FROM meshful_v2_parts p
        WHERE p.principal_id = d.principal_id AND p.document_id = d.document_id)
    )
  ) THEN RAISE(ABORT, 'MESHFUL_INCOMPLETE_DOCUMENT') END);
END;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_head_complete_update
BEFORE UPDATE ON meshful_v2_heads
BEGIN
  SELECT (CASE WHEN NEW.principal_id <> OLD.principal_id OR NEW.revision <> OLD.revision + 1
    THEN RAISE(ABORT, 'MESHFUL_INVALID_HEAD_TRANSITION') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM meshful_v2_documents
    WHERE principal_id = NEW.principal_id AND document_id = NEW.state_document_id
      AND kind = 'state' AND revision = NEW.revision
  ) OR EXISTS (
    SELECT 1 FROM meshful_v2_documents d
    WHERE d.principal_id = NEW.principal_id AND d.revision = NEW.revision AND (
      d.part_count <> (SELECT count(*) FROM meshful_v2_parts p
        WHERE p.principal_id = d.principal_id AND p.document_id = d.document_id)
      OR d.byte_length <> (SELECT coalesce(sum(p.byte_length), 0) FROM meshful_v2_parts p
        WHERE p.principal_id = d.principal_id AND p.document_id = d.document_id)
      OR d.part_count - 1 <> (SELECT coalesce(max(p.ordinal), -1) FROM meshful_v2_parts p
        WHERE p.principal_id = d.principal_id AND p.document_id = d.document_id)
    )
  ) THEN RAISE(ABORT, 'MESHFUL_INCOMPLETE_DOCUMENT') END);
END;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_head_no_delete
BEFORE DELETE ON meshful_v2_heads
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_HEAD'); END;
--> statement-breakpoint
-- Retention/deletion is a separate authorized migration, never an implicit GC.
CREATE TRIGGER meshful_v2_objects_no_update BEFORE UPDATE ON meshful_v2_objects
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_OBJECT'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_objects_no_delete BEFORE DELETE ON meshful_v2_objects
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_OBJECT'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_documents_no_update BEFORE UPDATE ON meshful_v2_documents
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_DOCUMENT'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_documents_no_delete BEFORE DELETE ON meshful_v2_documents
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_DOCUMENT'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_parts_no_update BEFORE UPDATE ON meshful_v2_parts
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_PART'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_parts_no_delete BEFORE DELETE ON meshful_v2_parts
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_PART'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_receipts_no_update BEFORE UPDATE ON meshful_v2_receipts
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_RECEIPT'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_receipts_no_delete BEFORE DELETE ON meshful_v2_receipts
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_RECEIPT'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_reviews_no_update BEFORE UPDATE ON meshful_v2_review_events
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_REVIEW'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_reviews_no_delete BEFORE DELETE ON meshful_v2_review_events
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_REVIEW'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_imports_no_update BEFORE UPDATE ON meshful_v2_import_archives
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_IMPORT'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_imports_no_delete BEFORE DELETE ON meshful_v2_import_archives
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_IMPORT'); END;
