PRAGMA foreign_keys = ON;
--> statement-breakpoint
-- One explicit, non-expiring study-writer grant per learner. Authorization
-- never depends on wall-clock expiry: acquire/takeover/release advance the
-- monotonic epoch, and every learner mutation atomically checks epoch+token.
CREATE TABLE meshful_study_writer_grants (
  principal_id TEXT NOT NULL PRIMARY KEY,
  writer_epoch INTEGER NOT NULL,
  token_digest TEXT,
  active INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT meshful_writer_principal_fk FOREIGN KEY (principal_id)
    REFERENCES meshful_principals(principal_id),
  CONSTRAINT meshful_writer_epoch CHECK (writer_epoch >= 0),
  CONSTRAINT meshful_writer_active CHECK (active IN (0, 1)),
  CONSTRAINT meshful_writer_token CHECK (
    (active = 1 AND substr(token_digest, 1, 7) = 'sha256:'
      AND length(token_digest) = 71
      AND substr(token_digest, 8) NOT GLOB '*[^0-9a-f]*')
    OR (active = 0 AND token_digest IS NULL)
  ),
  CONSTRAINT meshful_writer_updated_nonempty CHECK (length(updated_at) > 0)
);
--> statement-breakpoint
-- Lease actions are replayable without persisting the plaintext grant token.
-- The token remains client-held; only the full-request fingerprint and digest
-- enter D1. Receipts are immutable recovery evidence.
CREATE TABLE meshful_study_writer_receipts (
  principal_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  writer_epoch INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  attempt_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT meshful_writer_receipts_pk PRIMARY KEY (principal_id, request_id),
  CONSTRAINT meshful_writer_receipt_principal_fk FOREIGN KEY (principal_id)
    REFERENCES meshful_principals(principal_id),
  CONSTRAINT meshful_writer_receipt_action CHECK (action IN ('acquire', 'takeover', 'release')),
  CONSTRAINT meshful_writer_receipt_epoch CHECK (writer_epoch >= 1),
  CONSTRAINT meshful_writer_receipt_request CHECK (
    length(CAST(request_id AS BLOB)) BETWEEN 1 AND 128
  ),
  CONSTRAINT meshful_writer_receipt_fingerprint CHECK (
    substr(fingerprint, 1, 7) = 'sha256:' AND length(fingerprint) = 71
      AND substr(fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT meshful_writer_receipt_response CHECK (json_valid(response_json)),
  CONSTRAINT meshful_writer_receipt_attempt CHECK (length(attempt_token) > 0),
  CONSTRAINT meshful_writer_receipt_created CHECK (length(created_at) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX meshful_study_writer_attempt
  ON meshful_study_writer_receipts(attempt_token);
--> statement-breakpoint
CREATE TRIGGER meshful_study_writer_receipts_no_update
BEFORE UPDATE ON meshful_study_writer_receipts
BEGIN SELECT RAISE(ABORT, 'MESHFUL_WRITER_RECEIPT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER meshful_study_writer_receipts_no_delete
BEFORE DELETE ON meshful_study_writer_receipts
BEGIN SELECT RAISE(ABORT, 'MESHFUL_WRITER_RECEIPT_IMMUTABLE'); END;
