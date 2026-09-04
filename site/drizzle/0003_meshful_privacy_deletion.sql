PRAGMA foreign_keys = ON;
--> statement-breakpoint
-- One-use, short-lived destructive-action capabilities. Tokens are random and
-- only their SHA-256 digests are stored. The binding digest covers the trusted
-- principal, exact durable revision, exact target instance, and reviewed impact.
CREATE TABLE meshful_destructive_confirmations (
  principal_id TEXT NOT NULL REFERENCES meshful_principals(principal_id),
  token_digest TEXT NOT NULL,
  kind TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  binding_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, token_digest),
  CHECK (kind IN ('deck', 'account')),
  CHECK (typeof(expected_revision) = 'integer' AND expected_revision >= 0),
  CHECK (length(token_digest) = 71 AND substr(token_digest, 1, 7) = 'sha256:'),
  CHECK (length(binding_digest) = 71 AND substr(binding_digest, 1, 7) = 'sha256:'),
  CHECK (length(expires_at) > 0 AND length(created_at) > 0)
);
--> statement-breakpoint
CREATE INDEX meshful_destructive_confirmations_expiry
  ON meshful_destructive_confirmations(principal_id, expires_at);
--> statement-breakpoint
-- Minimal content-free receipts make lost-response retries deterministic after
-- the ordinary learner receipts themselves have been purged.
CREATE TABLE meshful_destructive_deletion_receipts (
  principal_id TEXT NOT NULL REFERENCES meshful_principals(principal_id),
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  resulting_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, request_id),
  CHECK (kind IN ('deck', 'account')),
  CHECK (length(fingerprint) = 71 AND substr(fingerprint, 1, 7) = 'sha256:'),
  CHECK (json_valid(response_json)),
  CHECK (typeof(resulting_revision) = 'integer' AND resulting_revision > 0),
  CHECK (length(created_at) > 0)
);
--> statement-breakpoint
CREATE TABLE meshful_retired_deck_instances (
  principal_id TEXT NOT NULL REFERENCES meshful_principals(principal_id),
  instance_digest TEXT NOT NULL,
  request_id TEXT NOT NULL,
  retired_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, instance_digest),
  FOREIGN KEY (principal_id, request_id)
    REFERENCES meshful_destructive_deletion_receipts(principal_id, request_id),
  CHECK (length(instance_digest) = 71 AND substr(instance_digest, 1, 7) = 'sha256:'),
  CHECK (length(retired_at) > 0)
);
--> statement-breakpoint
-- This table is internal transaction authority, not an API credential. Every
-- destructive repository batch creates and removes its row atomically.
CREATE TABLE meshful_data_deletion_authorizations (
  principal_id TEXT PRIMARY KEY NOT NULL REFERENCES meshful_principals(principal_id),
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (kind IN ('deck', 'account')),
  CHECK (length(request_id) > 0 AND length(created_at) > 0)
);
--> statement-breakpoint
-- Existing append-only guards remain fail-closed except inside an explicitly
-- authorized destructive batch. Update guards are intentionally unchanged.
DROP TRIGGER meshful_v1_state_after_takeover_delete;
--> statement-breakpoint
CREATE TRIGGER meshful_v1_state_after_takeover_delete
BEFORE DELETE ON meshful_learner_state
WHEN EXISTS (SELECT 1 FROM meshful_v2_heads WHERE principal_id = OLD.principal_id)
  AND NOT EXISTS (SELECT 1 FROM meshful_data_deletion_authorizations
    WHERE principal_id = OLD.principal_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_STORAGE_V2_REQUIRED'); END;
--> statement-breakpoint
DROP TRIGGER meshful_v2_head_no_delete;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_head_no_delete BEFORE DELETE ON meshful_v2_heads
WHEN NOT EXISTS (SELECT 1 FROM meshful_data_deletion_authorizations
  WHERE principal_id = OLD.principal_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_HEAD'); END;
--> statement-breakpoint
DROP TRIGGER meshful_v2_objects_no_delete;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_objects_no_delete BEFORE DELETE ON meshful_v2_objects
WHEN NOT EXISTS (SELECT 1 FROM meshful_data_deletion_authorizations
  WHERE principal_id = OLD.principal_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_OBJECT'); END;
--> statement-breakpoint
DROP TRIGGER meshful_v2_documents_no_delete;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_documents_no_delete BEFORE DELETE ON meshful_v2_documents
WHEN NOT EXISTS (SELECT 1 FROM meshful_data_deletion_authorizations
  WHERE principal_id = OLD.principal_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_DOCUMENT'); END;
--> statement-breakpoint
DROP TRIGGER meshful_v2_parts_no_delete;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_parts_no_delete BEFORE DELETE ON meshful_v2_parts
WHEN NOT EXISTS (SELECT 1 FROM meshful_data_deletion_authorizations
  WHERE principal_id = OLD.principal_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_PART'); END;
--> statement-breakpoint
DROP TRIGGER meshful_v2_receipts_no_delete;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_receipts_no_delete BEFORE DELETE ON meshful_v2_receipts
WHEN NOT EXISTS (SELECT 1 FROM meshful_data_deletion_authorizations
  WHERE principal_id = OLD.principal_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_RECEIPT'); END;
--> statement-breakpoint
DROP TRIGGER meshful_v2_reviews_no_delete;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_reviews_no_delete BEFORE DELETE ON meshful_v2_review_events
WHEN NOT EXISTS (SELECT 1 FROM meshful_data_deletion_authorizations
  WHERE principal_id = OLD.principal_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_REVIEW'); END;
--> statement-breakpoint
DROP TRIGGER meshful_v2_imports_no_delete;
--> statement-breakpoint
CREATE TRIGGER meshful_v2_imports_no_delete BEFORE DELETE ON meshful_v2_import_archives
WHEN NOT EXISTS (SELECT 1 FROM meshful_data_deletion_authorizations
  WHERE principal_id = OLD.principal_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_IMPORT'); END;
--> statement-breakpoint
DROP TRIGGER meshful_study_writer_receipts_no_delete;
--> statement-breakpoint
CREATE TRIGGER meshful_study_writer_receipts_no_delete
BEFORE DELETE ON meshful_study_writer_receipts
WHEN NOT EXISTS (SELECT 1 FROM meshful_data_deletion_authorizations
  WHERE principal_id = OLD.principal_id)
BEGIN SELECT RAISE(ABORT, 'MESHFUL_IMMUTABLE_WRITER_RECEIPT'); END;
