import { createD1Repository as createV1Repository } from "../../src/d1-repository.mjs";
import { BackendError, byteLength, sha256 } from "../../src/contracts.mjs";
import { decodeDocument, DOCUMENT_DECODE_MAX_BYTES, FRAGMENT_MAX_BYTES, FRAGMENT_MIN_BYTES } from "./fragment-codec.mjs";

// These are SQL transport limits, not a claim that arbitrary canonical states
// fit a Worker. The service separately bounds its materialized working set;
// actual hosted memory, CPU and query allowance still require qualification.
export const PACKED_JSON_MAX_BYTES = 1_400_000;
export const MAX_BATCH_STATEMENTS = 40;
export const MAX_PARTS_PER_READ = 16;
const ASSEMBLY_PARTS_PER_READ = 128;
const REVIEW_PAGE_BYTES = 1_048_576;

/** Owner-scoped, lossless documents over one atomic D1 batch per command. */
export function createD1Repository(db) {
  const legacy = createV1Repository(db);
  const statement = (sql, ...values) => db.prepare(sql).bind(...values);

  async function documentMetadata(principalId, documentId) {
    const row = await statement(`
      SELECT json_quote(document_id) AS document_id_json, kind, revision, byte_length, digest, part_count
      FROM meshful_v2_documents WHERE principal_id = ? AND document_id = ?
    `, principalId, documentId).first();
    return row ? metadata(row) : null;
  }

  async function readParts(principalId, document, afterPart, limit, verifyHashes = false) {
    const rows = await statement(`
      SELECT p.ordinal, p.object_digest, p.byte_length, o.byte_length AS object_bytes, json_quote(o.body) AS body_json
      FROM meshful_v2_parts p
      LEFT JOIN meshful_v2_objects o
        ON o.principal_id = p.principal_id AND o.digest = p.object_digest
      WHERE p.principal_id = ? AND p.document_id = ? AND p.ordinal > ?
      ORDER BY p.ordinal ASC LIMIT ?
    `, principalId, document.id, afterPart, limit).all();
    const parts = [];
    for (const [index, row] of rows.results.entries()) {
      const body = parseStoredJson(row.body_json);
      corrupt(row.ordinal === afterPart + index + 1 && row.ordinal < document.partCount);
      corrupt(typeof body === "string" && row.object_bytes === row.byte_length
        && Number.isSafeInteger(row.byte_length) && row.byte_length >= 0
        && row.byte_length <= FRAGMENT_MAX_BYTES && byteLength(body) === row.byte_length);
      if (verifyHashes) corrupt(await sha256(body) === row.object_digest);
      parts.push({ ordinal: row.ordinal, digest: row.object_digest, byteLength: row.byte_length, text: body });
    }
    corrupt(parts.length === Math.min(limit, Math.max(0, document.partCount - afterPart - 1)));
    return parts;
  }

  async function readDocument(principalId, documentId, knownMetadata) {
    const document = knownMetadata ?? await documentMetadata(principalId, documentId);
    corrupt(document !== null);
    if (document.byteLength > DOCUMENT_DECODE_MAX_BYTES) {
      throw new BackendError("RECOVERY_REQUIRED", "This document exceeds the assembly budget; use its bounded recovery pages", 413);
    }
    corrupt(document.byteLength > 0 && document.partCount > 0
      && document.partCount <= Math.ceil(document.byteLength / (FRAGMENT_MIN_BYTES - 3)) + 1);
    const parts = [];
    while (parts.length < document.partCount) {
      parts.push(...await readParts(principalId, document, parts.length - 1, ASSEMBLY_PARTS_PER_READ));
    }
    const text = await decodeDocument({ byteLength: document.byteLength, digest: document.digest, parts });
    return { text, document, chunkDigests: [...new Set(parts.map((part) => part.digest))] };
  }

  async function getRecoveryHead(principalId) {
    nonempty(principalId, "principalId", 128);
    const row = await statement(`
      SELECT h.revision, json_quote(h.state_document_id) AS state_document_id_json,
        json_quote(h.catalog_version) AS catalog_version_json, h.catalog_digest, h.updated_at,
        json_quote(d.document_id) AS document_id_json, d.kind, d.revision AS document_revision, d.byte_length, d.digest, d.part_count
      FROM meshful_v2_heads h
      LEFT JOIN meshful_v2_documents d
        ON d.principal_id = h.principal_id AND d.document_id = h.state_document_id
      WHERE h.principal_id = ?
    `, principalId).first();
    if (!row) {
      const previous = await legacy.getState(principalId);
      return previous ? { ...previous, storageVersion: 1, stateDocumentId: null, document: null } : null;
    }
    const stateDocumentId = storedString(row, "state_document_id");
    corrupt(storedString(row, "document_id") === stateDocumentId && row.kind === "state"
      && row.document_revision === row.revision);
    return {
      storageVersion: 2, revision: row.revision, stateDocumentId,
      catalogRef: { version: storedString(row, "catalog_version"), digest: row.catalog_digest }, updatedAt: row.updated_at,
      document: metadata({ ...row, revision: row.document_revision }),
    };
  }

  async function getDocumentParts(principalId, documentId, { afterPart = -1, limit = MAX_PARTS_PER_READ } = {}) {
    nonempty(principalId, "principalId", 128);
    nonempty(documentId, "documentId", 512);
    if (!Number.isSafeInteger(afterPart) || afterPart < -1 || afterPart >= Number.MAX_SAFE_INTEGER
      || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PARTS_PER_READ) {
      throw new TypeError(`afterPart must be >= -1 and limit must be 1..${MAX_PARTS_PER_READ}`);
    }
    const document = await documentMetadata(principalId, documentId);
    if (!document) return null;
    const parts = await readParts(principalId, document, afterPart, limit, true);
    const nextAfterPart = parts.at(-1)?.ordinal ?? afterPart;
    return { document, parts, nextAfterPart, done: nextAfterPart >= document.partCount - 1 };
  }

  async function getState(principalId) {
    const head = await getRecoveryHead(principalId);
    if (!head) return null;
    if (head.storageVersion === 1) {
      return { revision: head.revision, stateJson: head.stateJson, catalogRef: head.catalogRef,
        updatedAt: head.updatedAt, storageVersion: 1, storageProof: null };
    }
    const value = await readDocument(principalId, head.stateDocumentId, head.document);
    return {
      revision: head.revision, stateJson: value.text, catalogRef: head.catalogRef, updatedAt: head.updatedAt,
      storageVersion: 2,
      storageProof: Object.freeze({ principalId, revision: head.revision,
        readStatements: 1 + Math.ceil(head.document.partCount / ASSEMBLY_PARTS_PER_READ),
        chunkDigests: Object.freeze(value.chunkDigests) }),
    };
  }

  async function getReceipt(principalId, requestId) {
    nonempty(principalId, "principalId", 128);
    nonempty(requestId, "requestId", 128);
    const row = await statement(`
      SELECT fingerprint, json_quote(response_document_id) AS response_document_id_json, revision FROM meshful_v2_receipts
      WHERE principal_id = ? AND request_id = ?
    `, principalId, requestId).first();
    if (!row) return legacy.getReceipt(principalId, requestId);
    const value = await readDocument(principalId, storedString(row, "response_document_id"));
    corrupt(value.document.kind === "receipt" && value.document.revision === row.revision);
    return { fingerprint: row.fingerprint, responseJson: value.text, revision: row.revision };
  }

  async function getImportArchive(principalId, sourceId) {
    nonempty(principalId, "principalId", 128);
    nonempty(sourceId, "sourceId", 128);
    const row = await statement(`
      SELECT digest, json_quote(document_id) AS document_id_json, revision FROM meshful_v2_import_archives
      WHERE principal_id = ? AND source_id = ?
    `, principalId, sourceId).first();
    if (!row) {
      const previous = await legacy.getImportArchive(principalId, sourceId);
      return previous ? { ...previous, sourceId } : null;
    }
    const value = await readDocument(principalId, storedString(row, "document_id"));
    corrupt(value.document.kind === "import" && value.document.revision === row.revision
      && value.document.digest === row.digest);
    return { sourceId, digest: row.digest, rawJson: value.text, revision: row.revision };
  }

  async function listReviewEvents(principalId, { afterRevision = 0, limit = 100 } = {}) {
    nonempty(principalId, "principalId", 128);
    validRevision(afterRevision, "afterRevision");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("Invalid review limit");
    // Select metadata first. A page may be shorter than requested; neither the
    // row count nor 100 separately valid payloads is a safe unbounded read.
    const rows = await statement(`
      SELECT json_quote(event_id) AS event_id_json, revision, json_quote(deck_id) AS deck_id_json,
        json_quote(card_id) AS card_id_json, NULL AS document_id_json, event_id AS sort_event_id,
        length(CAST(payload_json AS BLOB)) AS byte_length, 1 AS storage_version
      FROM meshful_review_events WHERE principal_id = ? AND revision > ?
      UNION ALL
      SELECT json_quote(e.event_id), e.revision, json_quote(e.deck_id), json_quote(e.card_id), json_quote(e.document_id), e.event_id,
        d.byte_length, 2 AS storage_version
      FROM meshful_v2_review_events e LEFT JOIN meshful_v2_documents d
        ON d.principal_id = e.principal_id AND d.document_id = e.document_id
      WHERE e.principal_id = ? AND e.revision > ?
      ORDER BY revision ASC, sort_event_id ASC LIMIT ?
    `, principalId, afterRevision, principalId, afterRevision, Math.min(limit, 16)).all();
    const result = [];
    let bytes = 0;
    for (const row of rows.results) {
      const eventId = storedString(row, "event_id");
      corrupt(Number.isSafeInteger(row.byte_length) && row.byte_length >= 0);
      if (result.length && bytes + row.byte_length > REVIEW_PAGE_BYTES) break;
      let payloadJson;
      if (row.storage_version === 1) {
        const prior = await statement(`
          SELECT payload_json FROM meshful_review_events WHERE principal_id = ? AND event_id = ?
        `, principalId, eventId).first();
        corrupt(prior !== null);
        payloadJson = prior.payload_json;
      } else {
        const value = await readDocument(principalId, storedString(row, "document_id"));
        corrupt(value.document.kind === "review" && value.document.revision === row.revision);
        payloadJson = value.text;
      }
      result.push({ eventId, revision: row.revision, deckId: storedString(row, "deck_id"),
        cardId: storedString(row, "card_id"), payload: parseStoredJson(payloadJson) });
      bytes += row.byte_length;
    }
    return result;
  }

  async function commit({ principalId, expectedRevision, requestId, fingerprint, catalogRef,
    documents, stateDocumentId, responseDocumentId, events = [], importArchive, baseRecord, now }) {
    nonempty(principalId, "principalId", 128);
    nonempty(requestId, "requestId", 128);
    nonempty(fingerprint, "fingerprint", 512);
    nonempty(now, "now", 128);
    nonempty(catalogRef?.version, "catalogRef.version", 512);
    nonempty(catalogRef?.digest, "catalogRef.digest", 512);
    validRevision(expectedRevision, "expectedRevision");
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
    const batch = [statement(`
      INSERT INTO meshful_v2_receipts
        (principal_id, request_id, revision, fingerprint, response_document_id, attempt_token, created_at)
      SELECT principal_id, ?, revision + 1, ?, ?, ?, ? FROM (
        SELECT principal_id, revision FROM meshful_v2_heads WHERE principal_id = ?
        UNION ALL
        SELECT principal_id, revision FROM meshful_learner_state WHERE principal_id = ?
          AND NOT EXISTS (SELECT 1 FROM meshful_v2_heads WHERE principal_id = ?)
      ) WHERE revision = ?
    `, requestId, fingerprint, responseDocumentId, attemptToken, now,
    principalId, principalId, principalId, expectedRevision)];

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
          (SELECT revision FROM meshful_learner_state WHERE principal_id = ?)) AS revision
    `, principalId, requestId, attemptToken, principalId, principalId));
    if (batch.length > MAX_BATCH_STATEMENTS) {
      throw new BackendError("COMMIT_TOO_LARGE",
        "This atomic command exceeds the qualified storage transport budget; preserve the draft", 413);
    }
    let results;
    try { results = await db.batch(batch); }
    catch (error) {
      if (importArchive !== undefined && isSourceClaimConflict(error)) {
        throw new BackendError("LOCAL_SOURCE_ALREADY_CLAIMED", "This local source has already been claimed", 409);
      }
      throw error;
    }
    const row = results.at(-1).results[0];
    if (!row || !Number.isSafeInteger(row.revision)) throw new Error("Cannot commit an unprovisioned principal");
    return { committed: row.committed === 1, revision: row.revision };
  }

  return Object.freeze({
    findPrincipalByIdentity: legacy.findPrincipalByIdentity,
    provisionPrincipalForVerifiedIdentity: legacy.provisionPrincipalForVerifiedIdentity,
    getState, getReceipt, listReviewEvents, getImportArchive, commit, getRecoveryHead, getDocumentParts,
  });
}

function prepareDocuments({ documents, stateDocumentId, responseDocumentId, events, importArchive, requestId, revision }) {
  if (stateDocumentId !== `state:${revision}` || responseDocumentId !== `receipt:${requestId}`
    || !Array.isArray(documents) || !Array.isArray(events) || events.length > 1) throw new TypeError("Invalid commit documents");
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
    validDigest(importArchive?.digest);
    if (importArchive.documentId !== undefined && importArchive.documentId !== `import:${importArchive.sourceId}`) {
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
    validDigest(document.digest);
    if (!Number.isSafeInteger(document.byteLength) || document.byteLength < 0 || !Array.isArray(document.parts)) {
      throw new TypeError("Invalid document metadata");
    }
    if (document.kind === "import" && document.digest !== importArchive.digest) throw new TypeError("Import digest mismatch");
    let bytes = 0;
    for (const [ordinal, part] of document.parts.entries()) {
      validDigest(part?.digest);
      if (!Number.isSafeInteger(part.byteLength) || part.byteLength < 0 || part.byteLength > FRAGMENT_MAX_BYTES
        || typeof part.text !== "string" || byteLength(part.text) !== part.byteLength) {
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

function metadata(row) {
  const documentId = storedString(row, "document_id");
  corrupt(["state", "receipt", "review", "import"].includes(row.kind)
    && Number.isSafeInteger(row.revision) && row.revision > 0
    && Number.isSafeInteger(row.byte_length) && row.byte_length >= 0
    && Number.isSafeInteger(row.part_count) && row.part_count >= 0
    && typeof row.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(row.digest));
  return { id: documentId, kind: row.kind, revision: row.revision,
    byteLength: row.byte_length, digest: row.digest, partCount: row.part_count };
}

function corrupt(condition) {
  if (!condition) throw new BackendError("STORAGE_CORRUPT", "Stored document failed integrity verification; preserve all data", 503);
}

function parseStoredJson(value) {
  try { return JSON.parse(value); }
  catch { corrupt(false); }
}

// Some SQLite bindings truncate raw TEXT at NUL. Quoted projections preserve
// complete metadata identities and fragment text without changing their keys.
function storedString(row, key) {
  const value = parseStoredJson(row[`${key}_json`]);
  corrupt(typeof value === "string");
  return value;
}

function nonempty(value, label, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new TypeError(`Invalid ${label}`);
}

function validRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${label}`);
}

function validDigest(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError("Invalid content digest");
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
