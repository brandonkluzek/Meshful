/**
 * Prepared D1 persistence only. The service must authenticate the principal,
 * verify its exact identity binding/scopes, and validate state transitions.
 * No synchronous localStorage contract or user identity is inferred here.
 */
export function createD1Repository(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new TypeError("A prepared D1 database with atomic batch support is required");
  }
  const statement = (sql, ...values) => db.prepare(sql).bind(...values);

  async function findPrincipalByIdentity(identity) {
    const { provider, issuer, subject } = verifiedIdentity(identity);
    const row = await statement(`
      SELECT principal_id FROM meshful_identity_bindings
      WHERE provider = ? AND issuer = ? AND subject = ?
    `, provider, issuer, subject).first();
    return row ? { principalId: row.principal_id } : null;
  }

  async function provisionPrincipalForVerifiedIdentity(identity) {
    const { provider, issuer, subject } = verifiedIdentity(identity);
    const candidateId = globalThis.crypto.randomUUID();
    const now = new Date().toISOString();
    // One serialized batch avoids both duplicate bindings and orphan principals.
    // This hook does NOT authenticate; Accounts calls it only after verification.
    const results = await db.batch([
      statement(`
        INSERT INTO meshful_principals (principal_id, created_at)
        SELECT ?, ? WHERE NOT EXISTS (
          SELECT 1 FROM meshful_identity_bindings
          WHERE provider = ? AND issuer = ? AND subject = ?
        )
      `, candidateId, now, provider, issuer, subject),
      statement(`
        INSERT INTO meshful_identity_bindings
          (provider, issuer, subject, principal_id, created_at)
        SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM meshful_principals WHERE principal_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM meshful_identity_bindings
            WHERE provider = ? AND issuer = ? AND subject = ?
          )
      `, provider, issuer, subject, candidateId, now, candidateId, provider, issuer, subject),
      statement(`
        INSERT INTO meshful_learner_state
          (principal_id, revision, state_json, catalog_version, catalog_digest, updated_at)
        SELECT principal_id, 0, NULL, NULL, NULL, ? FROM meshful_identity_bindings
        WHERE provider = ? AND issuer = ? AND subject = ?
        ON CONFLICT(principal_id) DO NOTHING
      `, now, provider, issuer, subject),
      statement(`
        SELECT principal_id FROM meshful_identity_bindings
        WHERE provider = ? AND issuer = ? AND subject = ?
      `, provider, issuer, subject),
    ]);
    const row = results[3].results[0];
    if (!row) throw new Error("Principal provisioning did not produce an identity binding");
    return { principalId: row.principal_id };
  }

  async function getState(principalId) {
    nonemptyText(principalId, "principalId");
    const row = await statement(`
      SELECT revision, state_json, catalog_version, catalog_digest, updated_at
      FROM meshful_learner_state WHERE principal_id = ?
    `, principalId).first();
    return row ? {
      revision: row.revision,
      stateJson: row.state_json,
      catalogRef: row.catalog_version === null ? null : {
        version: row.catalog_version, digest: row.catalog_digest,
      },
      updatedAt: row.updated_at,
    } : null;
  }

  async function getReceipt(principalId, requestId) {
    nonemptyText(principalId, "principalId");
    nonemptyText(requestId, "requestId");
    const row = await statement(`
      SELECT fingerprint, response_json, revision FROM meshful_request_receipts
      WHERE principal_id = ? AND request_id = ?
    `, principalId, requestId).first();
    return row ? {
      fingerprint: row.fingerprint, responseJson: row.response_json, revision: row.revision,
    } : null;
  }

  async function listReviewEvents(principalId, { afterRevision = 0, limit = 100 } = {}) {
    nonemptyText(principalId, "principalId");
    nonnegativeRevision(afterRevision, "afterRevision");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError("limit must be an integer between 1 and 1000");
    }
    const rows = await statement(`
      SELECT event_id, revision, deck_id, card_id, payload_json
      FROM meshful_review_events WHERE principal_id = ? AND revision > ?
      ORDER BY revision ASC, event_id ASC LIMIT ?
    `, principalId, afterRevision, limit).all();
    return rows.results.map((row) => ({
      eventId: row.event_id, revision: row.revision, deckId: row.deck_id,
      cardId: row.card_id, payload: JSON.parse(row.payload_json),
    }));
  }

  async function getImportArchive(principalId, sourceId) {
    nonemptyText(principalId, "principalId");
    nonemptyText(sourceId, "sourceId");
    const row = await statement(`
      SELECT source_id, digest, raw_json, revision FROM meshful_import_archives
      WHERE principal_id = ? AND source_id = ?
    `, principalId, sourceId).first();
    return row ? {
      sourceId: row.source_id, digest: row.digest, rawJson: row.raw_json, revision: row.revision,
    } : null;
  }

  async function commit({
    principalId, expectedRevision, requestId, fingerprint, stateJson,
    catalogRef, responseJson, events = [], importArchive, now,
  }) {
    for (const [name, value] of Object.entries({ principalId, requestId, fingerprint, stateJson, responseJson, now })) {
      nonemptyText(value, name);
    }
    nonnegativeRevision(expectedRevision, "expectedRevision");
    if (expectedRevision === Number.MAX_SAFE_INTEGER) throw new RangeError("Revision limit reached");
    nonemptyText(catalogRef?.version, "catalogRef.version");
    nonemptyText(catalogRef?.digest, "catalogRef.digest");
    if (!Array.isArray(events)) throw new TypeError("events must be an array");
    for (const event of events) {
      for (const field of ["eventId", "deckId", "cardId", "payloadJson"]) {
        nonemptyText(event?.[field], `events.${field}`);
      }
    }
    if (importArchive !== undefined) {
      for (const field of ["sourceId", "digest", "rawJson"]) {
        nonemptyText(importArchive?.[field], `importArchive.${field}`);
      }
    }
    const revision = expectedRevision + 1;
    const attemptToken = globalThis.crypto.randomUUID();
    const batch = [
      // The receipt is the CAS admission record; stale reads insert nothing.
      // A duplicate request/revision constraint error rolls back the full batch.
      statement(`
        INSERT INTO meshful_request_receipts
          (principal_id, request_id, revision, fingerprint, response_json, attempt_token, created_at)
        SELECT principal_id, ?, revision + 1, ?, ?, ?, ? FROM meshful_learner_state
        WHERE principal_id = ? AND revision = ?
      `, requestId, fingerprint, responseJson, attemptToken, now, principalId, expectedRevision),
      statement(`
        UPDATE meshful_learner_state
        SET revision = ?, state_json = ?, catalog_version = ?, catalog_digest = ?, updated_at = ?
        WHERE principal_id = ? AND revision = ? AND EXISTS (
          SELECT 1 FROM meshful_request_receipts
          WHERE principal_id = ? AND request_id = ? AND attempt_token = ? AND revision = ?
        )
      `, revision, stateJson, catalogRef.version, catalogRef.digest, now,
      principalId, expectedRevision, principalId, requestId, attemptToken, revision),
    ];
    for (const event of events) {
      batch.push(statement(`
        INSERT INTO meshful_review_events
          (principal_id, event_id, revision, deck_id, card_id, payload_json, created_at)
        SELECT r.principal_id, ?, r.revision, ?, ?, ?, ? FROM meshful_request_receipts r
        JOIN meshful_learner_state s ON s.principal_id = r.principal_id AND s.revision = r.revision
        WHERE r.principal_id = ? AND r.request_id = ? AND r.attempt_token = ?
      `, event.eventId, event.deckId, event.cardId, event.payloadJson, now,
      principalId, requestId, attemptToken));
    }
    if (importArchive !== undefined) {
      batch.push(statement(`
        INSERT INTO meshful_import_archives
          (principal_id, source_id, digest, raw_json, revision, created_at)
        SELECT r.principal_id, ?, ?, ?, r.revision, ? FROM meshful_request_receipts r
        JOIN meshful_learner_state s ON s.principal_id = r.principal_id AND s.revision = r.revision
        WHERE r.principal_id = ? AND r.request_id = ? AND r.attempt_token = ?
      `, importArchive.sourceId, importArchive.digest, importArchive.rawJson, now,
      principalId, requestId, attemptToken));
    }
    // Read inside this same atomic batch, not from a possibly later revision.
    batch.push(statement(`
      SELECT revision FROM meshful_learner_state WHERE principal_id = ?
    `, principalId));
    let results;
    try {
      results = await db.batch(batch);
    } catch (error) {
      // D1 has already rolled the atomic batch back. Classify only this known
      // uniqueness conflict; do not inspect another learner's archive/binding.
      if (importArchive !== undefined && isLocalSourceClaimConflict(error)) {
        const conflict = new Error("This local source has already been claimed");
        conflict.code = "LOCAL_SOURCE_ALREADY_CLAIMED";
        throw conflict;
      }
      throw error;
    }
    const current = results.at(-1).results[0];
    if (!current) throw new Error("Cannot commit an unprovisioned principal");
    return { committed: results[0].meta.changes === 1, revision: current.revision };
  }

  return Object.freeze({
    findPrincipalByIdentity, provisionPrincipalForVerifiedIdentity,
    getState, getReceipt, listReviewEvents, getImportArchive, commit,
  });
}

function nonemptyText(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a nonempty string`);
  }
}

function nonnegativeRevision(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer`);
  }
}

function verifiedIdentity(identity) {
  for (const field of ["provider", "issuer", "subject"]) {
    nonemptyText(identity?.[field], `identity.${field}`);
  }
  // Exact strings: never normalize subjects/issuers or match email/name.
  return identity;
}

function isLocalSourceClaimConflict(error) {
  const seen = new Set();
  // SQLite names the exact failed column; D1 may add its error-code wrapper or
  // retain that SQLite error as a cause. Other constraints remain raw errors.
  const knownMessage = /^(?:D1_ERROR: )?UNIQUE constraint failed: meshful_import_archives\.source_id(?:: SQLITE_CONSTRAINT(?:_UNIQUE)?)?$/;
  for (let current = error; current && typeof current === "object" && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (typeof current.message === "string" && knownMessage.test(current.message)) return true;
  }
  return false;
}
