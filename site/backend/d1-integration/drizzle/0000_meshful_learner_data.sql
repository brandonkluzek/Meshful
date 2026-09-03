-- Apply through the Sites-owned D1 migration path. No provider provisioning.
-- Immutable receipts and import archives are intentionally not cascade-deleted.

CREATE TABLE meshful_principals (
  principal_id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT meshful_principals_id_nonempty CHECK (length(principal_id) > 0),
  CONSTRAINT meshful_principals_created_nonempty CHECK (length(created_at) > 0)
);
--> statement-breakpoint
CREATE TABLE meshful_identity_bindings (
  provider TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES meshful_principals(principal_id),
  created_at TEXT NOT NULL,
  CONSTRAINT meshful_identity_bindings_pk PRIMARY KEY (provider, issuer, subject),
  CONSTRAINT meshful_identity_provider_nonempty CHECK (length(provider) > 0),
  CONSTRAINT meshful_identity_issuer_nonempty CHECK (length(issuer) > 0),
  CONSTRAINT meshful_identity_subject_nonempty CHECK (length(subject) > 0),
  CONSTRAINT meshful_identity_created_nonempty CHECK (length(created_at) > 0)
);
--> statement-breakpoint
CREATE TABLE meshful_learner_state (
  principal_id TEXT PRIMARY KEY NOT NULL REFERENCES meshful_principals(principal_id),
  revision INTEGER NOT NULL DEFAULT 0,
  state_json TEXT,
  catalog_version TEXT,
  catalog_digest TEXT,
  updated_at TEXT NOT NULL,
  CONSTRAINT meshful_state_revision CHECK (
    typeof(revision) = 'integer' AND revision >= 0 AND revision <= 9007199254740991
  ),
  CONSTRAINT meshful_state_json CHECK (state_json IS NULL OR json_valid(state_json)),
  CONSTRAINT meshful_state_catalog CHECK (
    (state_json IS NULL AND catalog_version IS NULL AND catalog_digest IS NULL)
    OR (state_json IS NOT NULL AND catalog_version IS NOT NULL AND length(catalog_version) > 0
      AND catalog_digest IS NOT NULL AND length(catalog_digest) > 0)
  ),
  CONSTRAINT meshful_state_updated_nonempty CHECK (length(updated_at) > 0)
);
--> statement-breakpoint
CREATE TABLE meshful_request_receipts (
  principal_id TEXT NOT NULL REFERENCES meshful_principals(principal_id),
  request_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  attempt_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT meshful_request_receipts_pk PRIMARY KEY (principal_id, request_id),
  CONSTRAINT meshful_receipt_request_nonempty CHECK (length(request_id) > 0),
  CONSTRAINT meshful_receipt_revision CHECK (
    typeof(revision) = 'integer' AND revision > 0 AND revision <= 9007199254740991
  ),
  CONSTRAINT meshful_receipt_fingerprint_nonempty CHECK (length(fingerprint) > 0),
  CONSTRAINT meshful_receipt_response_json CHECK (json_valid(response_json)),
  CONSTRAINT meshful_receipt_attempt_nonempty CHECK (length(attempt_token) > 0),
  CONSTRAINT meshful_receipt_created_nonempty CHECK (length(created_at) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX meshful_receipt_owner_revision
  ON meshful_request_receipts(principal_id, revision);
--> statement-breakpoint
CREATE UNIQUE INDEX meshful_receipt_attempt_token
  ON meshful_request_receipts(attempt_token);
--> statement-breakpoint
CREATE TABLE meshful_review_events (
  principal_id TEXT NOT NULL REFERENCES meshful_principals(principal_id),
  event_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  deck_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT meshful_review_events_pk PRIMARY KEY (principal_id, event_id),
  CONSTRAINT meshful_review_receipt_fk FOREIGN KEY (principal_id, revision)
    REFERENCES meshful_request_receipts(principal_id, revision),
  CONSTRAINT meshful_review_event_nonempty CHECK (length(event_id) > 0),
  CONSTRAINT meshful_review_revision CHECK (
    typeof(revision) = 'integer' AND revision > 0 AND revision <= 9007199254740991
  ),
  CONSTRAINT meshful_review_deck_nonempty CHECK (length(deck_id) > 0),
  CONSTRAINT meshful_review_card_nonempty CHECK (length(card_id) > 0),
  CONSTRAINT meshful_review_payload_json CHECK (json_valid(payload_json)),
  CONSTRAINT meshful_review_created_nonempty CHECK (length(created_at) > 0)
);
--> statement-breakpoint
CREATE INDEX meshful_review_owner_revision_event
  ON meshful_review_events(principal_id, revision, event_id);
--> statement-breakpoint
CREATE TABLE meshful_import_archives (
  principal_id TEXT NOT NULL REFERENCES meshful_principals(principal_id),
  source_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT meshful_import_archives_pk PRIMARY KEY (principal_id, source_id),
  CONSTRAINT meshful_import_receipt_fk FOREIGN KEY (principal_id, revision)
    REFERENCES meshful_request_receipts(principal_id, revision),
  CONSTRAINT meshful_import_source_nonempty CHECK (length(source_id) > 0),
  CONSTRAINT meshful_import_digest_nonempty CHECK (length(digest) > 0),
  CONSTRAINT meshful_import_raw_json CHECK (json_valid(raw_json)),
  CONSTRAINT meshful_import_revision CHECK (
    typeof(revision) = 'integer' AND revision > 0 AND revision <= 9007199254740991
  ),
  CONSTRAINT meshful_import_created_nonempty CHECK (length(created_at) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX meshful_import_source_claim
  ON meshful_import_archives(source_id);
