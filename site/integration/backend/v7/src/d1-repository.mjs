import { createD1Repository as createV2Repository } from "../../v2/src/d1-repository.mjs";
import { BackendError, byteLength } from "../../src/contracts.mjs";
import { FRAGMENT_MAX_BYTES } from "../../v2/src/fragment-codec.mjs";
import { MAX_BATCH_STATEMENTS, PACKED_JSON_MAX_BYTES } from "../../v2/src/d1-repository.mjs";

/**
 * V2 durable documents plus one principal-scoped, non-expiring study-writer
 * grant. Epoch+token authorization is checked inside the same D1 batch as each
 * Study mutation, so a successful takeover makes every older Study writer
 * unable to commit. Independent account commands remain whole-state revision
 * compare-and-swap writes and never change the Study grant. Wall-clock time is
 * audit metadata only.
 */
export function createD1Repository(db) {
  const base = createV2Repository(db);
  const statement = (sql, ...values) => db.prepare(sql).bind(...values);

  async function getWriterGrant(principalId) {
    nonempty(principalId, "principalId", 128);
    const row = await statement(`
      SELECT writer_epoch, active, updated_at
      FROM meshful_study_writer_grants WHERE principal_id = ?
    `, principalId).first();
    if (!row) return { writerEpoch: 0, active: false, updatedAt: null };
    validEpoch(row.writer_epoch);
    corrupt(row.active === 0 || row.active === 1);
    corrupt(typeof row.updated_at === "string" && row.updated_at.length > 0);
    return { writerEpoch: row.writer_epoch, active: row.active === 1, updatedAt: row.updated_at };
  }

  async function getWriterReceipt(principalId, requestId) {
    nonempty(principalId, "principalId", 128);
    nonempty(requestId, "requestId", 128);
    const row = await statement(`
      SELECT action, fingerprint, writer_epoch, response_json, created_at
      FROM meshful_study_writer_receipts
      WHERE principal_id = ? AND request_id = ?
    `, principalId, requestId).first();
    if (!row) return null;
    corrupt(["acquire", "takeover", "release"].includes(row.action));
    validEpoch(row.writer_epoch, 1);
    digest(row.fingerprint);
    corrupt(typeof row.response_json === "string" && typeof row.created_at === "string");
    return { action: row.action, fingerprint: row.fingerprint, writerEpoch: row.writer_epoch,
      responseJson: row.response_json, createdAt: row.created_at };
  }

  async function isWriterGrantCurrent(principalId, writerGrant) {
    nonempty(principalId, "principalId", 128);
    validWriterGrant(writerGrant);
    const row = await statement(`
      SELECT EXISTS (
        SELECT 1 FROM meshful_study_writer_grants
        WHERE principal_id = ? AND writer_epoch = ? AND token_digest = ? AND active = 1
      ) AS current
    `, principalId, writerGrant.writerEpoch, writerGrant.tokenDigest).first();
    return row?.current === 1;
  }

  async function mutateWriterGrant({ principalId, requestId, action, expectedWriterEpoch,
    tokenDigest, fingerprint, responseJson, now }) {
    nonempty(principalId, "principalId", 128);
    nonempty(requestId, "requestId", 128);
    if (!["acquire", "takeover", "release"].includes(action)) throw new TypeError("Invalid writer action");
    validEpoch(expectedWriterEpoch);
    if (expectedWriterEpoch === Number.MAX_SAFE_INTEGER) throw new RangeError("Writer epoch limit reached");
    digest(tokenDigest); digest(fingerprint);
    nonempty(responseJson, "responseJson", 4096);
    nonempty(now, "now", 128);
    const writerEpoch = expectedWriterEpoch + 1;
    const attemptToken = crypto.randomUUID();
    const active = action === "release" ? 0 : 1;
    const storedToken = active ? tokenDigest : null;
    const batch = [statement(`
      INSERT INTO meshful_study_writer_receipts
        (principal_id, request_id, action, fingerprint, writer_epoch, response_json, attempt_token, created_at)
      SELECT p.principal_id, ?, ?, ?, ?, ?, ?, ?
      FROM meshful_principals p
      LEFT JOIN meshful_study_writer_grants g ON g.principal_id = p.principal_id
      WHERE p.principal_id = ? AND coalesce(g.writer_epoch, 0) = ? AND (
        (? = 'acquire' AND coalesce(g.active, 0) = 0)
        OR (? = 'takeover' AND g.active = 1)
        OR (? = 'release' AND g.active = 1 AND g.token_digest = ?)
      )
    `, requestId, action, fingerprint, writerEpoch, responseJson, attemptToken, now,
    principalId, expectedWriterEpoch, action, action, action, tokenDigest), statement(`
      INSERT INTO meshful_study_writer_grants
        (principal_id, writer_epoch, token_digest, active, updated_at)
      SELECT principal_id, writer_epoch, ?, ?, ?
      FROM meshful_study_writer_receipts WHERE attempt_token = ?
      ON CONFLICT(principal_id) DO UPDATE SET
        writer_epoch = excluded.writer_epoch,
        token_digest = excluded.token_digest,
        active = excluded.active,
        updated_at = excluded.updated_at
    `, storedToken, active, now, attemptToken), statement(`
      SELECT EXISTS (
        SELECT 1 FROM meshful_study_writer_receipts WHERE attempt_token = ?
      ) AS committed,
      coalesce((SELECT writer_epoch FROM meshful_study_writer_grants WHERE principal_id = ?), 0)
        AS writer_epoch,
      coalesce((SELECT active FROM meshful_study_writer_grants WHERE principal_id = ?), 0)
        AS active
    `, attemptToken, principalId, principalId)];
    let results;
    try { results = await db.batch(batch); }
    catch (error) {
      const replay = await getWriterReceipt(principalId, requestId);
      if (replay) return { committed: false, replay };
      throw error;
    }
    const row = results.at(-1)?.results?.[0];
    if (!row || !Number.isSafeInteger(row.writer_epoch)) throw new Error("Writer grant result is unavailable");
    return { committed: row.committed === 1, writerEpoch: row.writer_epoch, active: row.active === 1 };
  }

  async function commit({ principalId, expectedRevision, requestId, fingerprint, catalogRef,
    documents, stateDocumentId, responseDocumentId, events = [], importArchive, baseRecord,
    writerGrant, now }) {
    nonempty(principalId, "principalId", 128);
    nonempty(requestId, "requestId", 128);
    nonempty(fingerprint, "fingerprint", 512);
    nonempty(now, "now", 128);
    nonempty(catalogRef?.version, "catalogRef.version", 512);
    nonempty(catalogRef?.digest, "catalogRef.digest", 512);
    validRevision(expectedRevision);
    if (writerGrant !== null && writerGrant !== undefined) validWriterGrant(writerGrant);
    if (expectedRevision === Number.MAX_SAFE_INTEGER) throw new RangeError("Revision limit reached");
    const revision = expectedRevision + 1;
    const { objects, documentRows, partRows, eventRows } = prepareDocuments({
      documents, stateDocumentId, responseDocumentId, events, importArchive, requestId, revision,
    });
    const proof = baseRecord?.storageProof;
    const knownDigests = baseRecord?.revision === expectedRevision && proof?.principalId === principalId
      && proof.revision === expectedRevision && Array.isArray(proof.chunkDigests)
      ? new Set(proof.chunkDigests) : new Set();
    const attemptToken = crypto.randomUUID();
    const writerRequired = writerGrant ? 1 : 0;
    const writerEpoch = writerGrant?.writerEpoch ?? null;
    const writerTokenDigest = writerGrant?.tokenDigest ?? null;
    const batch = [statement(`
      INSERT INTO meshful_v2_receipts
        (principal_id, request_id, revision, fingerprint, response_document_id, attempt_token, created_at)
      SELECT candidate.principal_id, ?, candidate.revision + 1, ?, ?, ?, ? FROM (
        SELECT principal_id, revision FROM meshful_v2_heads WHERE principal_id = ?
        UNION ALL
        SELECT principal_id, revision FROM meshful_learner_state WHERE principal_id = ?
          AND NOT EXISTS (SELECT 1 FROM meshful_v2_heads WHERE principal_id = ?)
      ) candidate
      WHERE candidate.revision = ? AND (? = 0 OR EXISTS (
        SELECT 1 FROM meshful_study_writer_grants g
        WHERE g.principal_id = candidate.principal_id AND g.writer_epoch = ?
          AND g.token_digest = ? AND g.active = 1
      ))
    `, requestId, fingerprint, responseDocumentId, attemptToken, now,
    principalId, principalId, principalId, expectedRevision,
    writerRequired, writerEpoch, writerTokenDigest)];

    for (const packed of packRows([...objects.values()].filter((part) => !knownDigests.has(part[0])))) {
      batch.push(statement(`
        INSERT INTO meshful_v2_objects (principal_id, digest, byte_length, body, created_at)
        SELECT r.principal_id, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'),
          json_extract(j.value, '$[2]'), ?
        FROM json_each(?) j CROSS JOIN meshful_v2_receipts r
        WHERE r.principal_id = ? AND r.request_id = ? AND r.attempt_token = ?
        ON CONFLICT(principal_id, digest) DO UPDATE
          SET body = excluded.body, byte_length = excluded.byte_length
          WHERE meshful_v2_objects.body <> excluded.body
            OR meshful_v2_objects.byte_length <> excluded.byte_length
      `, now, packed, principalId, requestId, attemptToken));
    }
    for (const packed of packRows(documentRows)) {
      batch.push(statement(`
        INSERT INTO meshful_v2_documents
          (principal_id, document_id, kind, revision, byte_length, digest, part_count, created_at)
        SELECT r.principal_id, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), r.revision,
          json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'), ?
        FROM json_each(?) j CROSS JOIN meshful_v2_receipts r
        WHERE r.principal_id = ? AND r.request_id = ? AND r.attempt_token = ?
      `, now, packed, principalId, requestId, attemptToken));
    }
    for (const packed of packRows(partRows)) {
      batch.push(statement(`
        INSERT INTO meshful_v2_parts (principal_id, document_id, ordinal, object_digest, byte_length)
        SELECT r.principal_id, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'),
          json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]')
        FROM json_each(?) j CROSS JOIN meshful_v2_receipts r
        WHERE r.principal_id = ? AND r.request_id = ? AND r.attempt_token = ?
      `, packed, principalId, requestId, attemptToken));
    }
    for (const packed of packRows(eventRows)) {
      batch.push(statement(`
        INSERT INTO meshful_v2_review_events
          (principal_id, event_id, revision, deck_id, card_id, document_id, created_at)
        SELECT r.principal_id, json_extract(j.value, '$[0]'), r.revision, json_extract(j.value, '$[1]'),
          json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]'), ?
        FROM json_each(?) j CROSS JOIN meshful_v2_receipts r
        WHERE r.principal_id = ? AND r.request_id = ? AND r.attempt_token = ?
      `, now, packed, principalId, requestId, attemptToken));
    }
    if (importArchive !== undefined) {
      batch.push(statement(`
        INSERT INTO meshful_v2_import_archives
          (principal_id, source_id, digest, document_id, revision, created_at)
        SELECT principal_id, ?, ?, ?, revision, ? FROM meshful_v2_receipts
        WHERE principal_id = ? AND request_id = ? AND attempt_token = ?
      `, importArchive.sourceId, importArchive.digest, `import:${importArchive.sourceId}`, now,
      principalId, requestId, attemptToken));
    }
    batch.push(statement(`
      INSERT INTO meshful_v2_heads
        (principal_id, revision, state_document_id, catalog_version, catalog_digest, updated_at)
      SELECT principal_id, revision, ?, ?, ?, ? FROM meshful_v2_receipts
      WHERE principal_id = ? AND request_id = ? AND attempt_token = ?
      ON CONFLICT(principal_id) DO UPDATE SET
        revision = CASE WHEN meshful_v2_heads.revision = ? THEN excluded.revision ELSE 0 END,
        state_document_id = excluded.state_document_id, catalog_version = excluded.catalog_version,
        catalog_digest = excluded.catalog_digest, updated_at = excluded.updated_at
    `, stateDocumentId, catalogRef.version, catalogRef.digest, now,
    principalId, requestId, attemptToken, expectedRevision));
    batch.push(statement(`
      SELECT EXISTS (SELECT 1 FROM meshful_v2_receipts
        WHERE principal_id = ? AND request_id = ? AND attempt_token = ?) AS committed,
        coalesce((SELECT revision FROM meshful_v2_heads WHERE principal_id = ?),
          (SELECT revision FROM meshful_learner_state WHERE principal_id = ?)) AS revision,
        CASE WHEN ? = 0 THEN 1 ELSE EXISTS (SELECT 1 FROM meshful_study_writer_grants
          WHERE principal_id = ? AND writer_epoch = ? AND token_digest = ? AND active = 1)
        END AS writer_authorized
    `, principalId, requestId, attemptToken, principalId, principalId,
    writerRequired, principalId, writerEpoch, writerTokenDigest));
    if (batch.length > MAX_BATCH_STATEMENTS) {
      throw new BackendError("COMMIT_TOO_LARGE",
        "This atomic command exceeds the qualified storage transport budget; preserve the draft", 413);
    }
    let results;
    try { results = await db.batch(batch); }
    catch (error) {
      if (importArchive !== undefined && isSourceClaimConflict(error)) {
        throw new BackendError("LOCAL_SOURCE_ALREADY_CLAIMED",
          "This local source has already been claimed", 409);
      }
      throw error;
    }
    const row = results.at(-1)?.results?.[0];
    if (!row || !Number.isSafeInteger(row.revision)) throw new Error("Cannot commit an unprovisioned principal");
    return { committed: row.committed === 1, revision: row.revision,
      writerAuthorized: row.writer_authorized === 1 };
  }

  return Object.freeze({
    ...base,
    getWriterGrant,
    getWriterReceipt,
    isWriterGrantCurrent,
    mutateWriterGrant,
    commit,
  });
}

function prepareDocuments({ documents, stateDocumentId, responseDocumentId, events, importArchive,
  requestId, revision }) {
  if (stateDocumentId !== `state:${revision}` || responseDocumentId !== `receipt:${requestId}`
    || !Array.isArray(documents) || !Array.isArray(events) || events.length > 1) {
    throw new TypeError("Invalid commit documents");
  }
  const required = new Map([[stateDocumentId, "state"], [responseDocumentId, "receipt"]]);
  const eventRows = events.map((event) => {
    for (const key of ["eventId", "deckId", "cardId"]) nonempty(event?.[key], key, key === "eventId" ? 128 : 512);
    const id = `review:${event.eventId}`;
    if (event.documentId !== undefined && event.documentId !== id) throw new TypeError("Review document ID mismatch");
    if (required.has(id)) throw new TypeError("Duplicate review event");
    required.set(id, "review");
    return [event.eventId, event.deckId, event.cardId, id];
  });
  if (importArchive !== undefined) {
    nonempty(importArchive?.sourceId, "sourceId", 128);
    digest(importArchive?.digest);
    if (importArchive.documentId !== undefined
      && importArchive.documentId !== `import:${importArchive.sourceId}`) {
      throw new TypeError("Import document ID mismatch");
    }
    required.set(`import:${importArchive.sourceId}`, "import");
  }
  if (required.size !== documents.length) throw new TypeError("Commit document set is incomplete");
  const objects = new Map();
  const documentRows = [];
  const partRows = [];
  for (const document of documents) {
    nonempty(document?.id, "document.id", 512);
    if (required.get(document.id) !== document.kind) throw new TypeError("Unexpected or duplicate document");
    required.delete(document.id);
    digest(document.digest);
    if (!Number.isSafeInteger(document.byteLength) || document.byteLength < 0 || !Array.isArray(document.parts)) {
      throw new TypeError("Invalid document metadata");
    }
    if (document.kind === "import" && document.digest !== importArchive.digest) {
      throw new TypeError("Import digest mismatch");
    }
    let bytes = 0;
    for (const [ordinal, part] of document.parts.entries()) {
      digest(part?.digest);
      if (!Number.isSafeInteger(part.byteLength) || part.byteLength < 0
        || part.byteLength > FRAGMENT_MAX_BYTES || typeof part.text !== "string"
        || byteLength(part.text) !== part.byteLength) {
        throw new TypeError("Invalid document fragment");
      }
      bytes += part.byteLength;
      const previous = objects.get(part.digest);
      if (previous && (previous[1] !== part.byteLength || previous[2] !== part.text)) {
        throw new TypeError("Conflicting fragment content digest");
      }
      objects.set(part.digest, [part.digest, part.byteLength, part.text]);
      partRows.push([document.id, ordinal, part.digest, part.byteLength]);
    }
    if (bytes !== document.byteLength) throw new TypeError("Document byte count mismatch");
    documentRows.push([document.id, document.kind, document.byteLength, document.digest, document.parts.length]);
  }
  return { objects, documentRows, partRows, eventRows };
}

function* packRows(rows) {
  let packed = [];
  let bytes = 2;
  for (const row of rows) {
    const serialized = JSON.stringify(row);
    const size = byteLength(serialized);
    if (size + 2 > PACKED_JSON_MAX_BYTES) throw new TypeError("A SQL transport row exceeds its bound");
    if (bytes + size + (packed.length ? 1 : 0) > PACKED_JSON_MAX_BYTES) {
      yield `[${packed.join(",")}]`;
      packed = [];
      bytes = 2;
    }
    bytes += size + (packed.length ? 1 : 0);
    packed.push(serialized);
  }
  if (packed.length) yield `[${packed.join(",")}]`;
}

function validWriterGrant(value) {
  if (!value || !Number.isSafeInteger(value.writerEpoch) || value.writerEpoch < 1) {
    throw new TypeError("Invalid writer grant epoch");
  }
  digest(value.tokenDigest);
}

function validEpoch(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError("Invalid writer epoch");
  }
}

function validRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid expectedRevision");
}

function digest(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError("Invalid content digest");
  }
}

function nonempty(value, label, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function corrupt(condition) {
  if (!condition) {
    throw new BackendError("STORAGE_CORRUPT", "Stored writer grant failed integrity verification; preserve all data", 503);
  }
}

function isSourceClaimConflict(error) {
  const known = /^(?:D1_ERROR: )?(?:MESHFUL_LOCAL_SOURCE_ALREADY_CLAIMED|UNIQUE constraint failed: meshful_v2_import_archives\.source_id)(?:: SQLITE_CONSTRAINT(?:_UNIQUE|_TRIGGER)?)?$/;
  const seen = new Set();
  for (let current = error; current && typeof current === "object" && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (typeof current.message === "string" && known.test(current.message)) return true;
  }
  return false;
}
