// Website lifecycle only. Business transitions remain in the delivered durable
// client/server. Factories are injected by a private, server-selected entry;
// neither a URL parameter nor display-only sign-in enables this path.
const READS = ["getLearningOverview", "searchLibrary", "searchMyDecks", "getDeck", "validateDeck", "getStudySession"];
const WRITES = ["ingestDeck", "updateDeck", "addCards", "updateCards", "startStudySession", "submitGrade", "finishStudySession", "addLibraryDeck"];
const copy = (value) => structuredClone(value);

export class AccountRuntimeError extends Error {
  constructor(code, message) { super(message); this.name = "AccountRuntimeError"; this.code = code; }
}
const fail = (code, message) => { throw new AccountRuntimeError(code, message); };
const changed = () => fail("ACCOUNT_CHANGED", "Account access changed. Reconnect before continuing; saved work has not been reset.");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const optionalRead = (reads, name) => {
  try { const read = reads?.[name]; return typeof read === "function" ? read : null; }
  catch { return null; } // An optional capability cannot poison its independent sibling.
};

export function createAccountRuntime({
  createStorageController, createDurableClient, hydrateSnapshot, storageOptions,
  fetchImpl = globalThis.fetch, baseUrl = "/api/learner/v1", localClaimSource = null,
  onInvalidate = () => {}, onReplay = () => {}, makeId = () => globalThis.crypto.randomUUID(),
} = {}) {
  if (![createStorageController, createDurableClient, hydrateSnapshot, fetchImpl, onInvalidate, makeId].every((fn) => typeof fn === "function")) {
    fail("ACCOUNT_CONFIGURATION", "The private account integration is incomplete.");
  }
  if (!/^\/api\/learner\/v[12]$/.test(baseUrl)) fail("ACCOUNT_CONFIGURATION", "Use the same-origin learner endpoint.");
  let current = null;
  let releaseCompletion = null;
  const previews = new WeakMap();
  const controller = createStorageController({ ...storageOptions, onInvalidate(reason) {
    const retiring = current;
    current = null; // Retire references BEFORE any DOM cleanup or asynchronous work.
    if (retiring) {
      retiring.readStudyAvailability = null;
      retiring.readStudyActivity = null;
      retiring.snapshot = null;
      retiring.raw = undefined;
      retiring.catalogRef = null;
    }
    // Accounts revokes its lease before this synchronous sink. Native lock
    // release can finish later; retain only its completion, not learner state.
    if (retiring) releaseCompletion = retiring.lease.release();
    onInvalidate(reason);
  } });

  function assertSession(session, ticket = session.ticket) {
    if (current !== session || !session.lease.executionGuard.isCurrent(ticket)) changed();
  }
  function assertDiscovery(ticket) {
    if (!controller.executionGuard.isCurrent(ticket)) changed();
  }
  function readConfirmedProjection(session, field, args, label, unavailableCode) {
    assertSession(session);
    const read = session[field];
    const snapshot = session.snapshot;
    const revision = session.revision;
    const sequence = session.loadSequence;
    if (!read || revision < session.minimumRevision) {
      fail(unavailableCode, `Load the confirmed account state before checking ${label.toLowerCase()}.`);
    }
    // Recompute as_of on every read. Each optional capability fails separately;
    // there is no async, HTTP, cached-result or local mutation fallback.
    const result = read(copy(args));
    assertSession(session);
    if (read !== session[field] || snapshot !== session.snapshot || revision !== session.revision ||
        sequence !== session.loadSequence || revision < session.minimumRevision) {
      fail("STALE_ACCOUNT_SNAPSHOT", `${label} changed. Check the current account state again.`);
    }
    if (typeof result?.then === "function") {
      Promise.resolve(result).catch(() => {}); // Suppress a rejected invalid async capability; never await/adopt it.
      fail("INVALID_ACCOUNT_RESPONSE", `${label} must be a synchronous confirmed read.`);
    }
    if (!object(result) || result.app_revision !== snapshot.revision) {
      fail("INVALID_ACCOUNT_RESPONSE", `${label} does not match the confirmed account state.`);
    }
    // Canonical app_revision and durable revision differ after an import.
    const projected = copy(result);
    assertSession(session);
    if (read !== session[field] || snapshot !== session.snapshot || revision !== session.revision ||
        sequence !== session.loadSequence || revision < session.minimumRevision) {
      fail("STALE_ACCOUNT_SNAPSHOT", `${label} changed. Check the current account state again.`);
    }
    return projected;
  }
  function retireOnAuthError(error, session) {
    if (current === session && session && (error?.status === 401 || error?.status === 403 ||
        /^(ACCOUNT_CHANGED|UNAUTHENTICATED|unauthenticated|csrf_rejected|untrusted_ingress|auth_unavailable)$/.test(error?.code ?? ""))) {
      controller.beginEpoch({ broadcast: true });
    }
  }
  async function request(path, { binding, body, check } = {}) {
    check();
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { Accept: "application/json", ...(binding ? { "X-Meshful-Account": binding } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    check();
    const payload = await response.json();
    check();
    if (!response.ok || payload?.ok !== true) {
      retireOnAuthError({ status: response.status, code: payload?.error?.code }, current);
      fail(payload?.error?.code ?? "ACCOUNT_REQUEST_FAILED", "The account request could not be confirmed. Your recovery data is preserved.");
    }
    if (!object(payload.data)) fail("INVALID_ACCOUNT_RESPONSE", "The account response was incomplete.");
    return payload.data;
  }

  function refresh(session, ticket = session.ticket) {
    const job = { minimum: Math.max(session.revision, session.minimumRevision) };
    let task;
    task = loadSnapshot(session, ticket, job).catch(async (error) => {
      assertSession(session, ticket);
      const successor = session.latestRefresh;
      if (["STALE_CLIENT_RESPONSE", "STALE_ACCOUNT_SNAPSHOT"].includes(error.code) && successor && successor !== task) {
        await successor;
        assertSession(session, ticket);
        // Successful supersession is not a failed save. Do not resolve until a
        // sufficiently new snapshot has actually passed hydration/cache guards.
        if (session.revision >= Math.max(job.minimum, session.minimumRevision)) return session.revision;
      }
      throw error;
    });
    session.latestRefresh = task;
    return task;
  }

  async function loadSnapshot(session, ticket, job) {
    assertSession(session, ticket);
    const sequence = ++session.loadSequence;
    let data;
    try { data = await session.client.load(); }
    catch (error) { retireOnAuthError(error, session); throw error; }
    assertSession(session, ticket);
    if (data.account_binding !== session.binding) {
      controller.beginEpoch({ broadcast: true });
      changed();
    }
    const revision = data.durable_revision;
    const raw = data.state_json;
    if (!Number.isSafeInteger(revision) || revision < 0 ||
        !(raw === null || typeof raw === "string")) {
      fail("INVALID_ACCOUNT_RESPONSE", "The account snapshot was incomplete.");
    }
    job.minimum = Math.max(job.minimum, revision);
    // Observation and adoption are separate: even a superseded request can
    // prove that the currently retained reader is older than confirmed state.
    session.minimumRevision = Math.max(session.minimumRevision, revision);
    if (revision > session.revision) {
      session.readStudyAvailability = null;
      session.readStudyActivity = null;
    }
    if (revision < Math.max(session.revision, session.minimumRevision) || sequence !== session.loadSequence) {
      fail("STALE_ACCOUNT_SNAPSHOT", "A newer account snapshot is already available.");
    }
    if (revision === session.revision && raw !== session.raw) {
      fail("ACCOUNT_SNAPSHOT_CONFLICT", "Two snapshots disagree at the same durable revision.");
    }
    const hydrated = await hydrateSnapshot(data);
    assertSession(session, ticket);
    if (sequence !== session.loadSequence || revision < Math.max(session.revision, session.minimumRevision)) {
      fail("STALE_ACCOUNT_SNAPSHOT", "A newer account snapshot is already available.");
    }
    const readModel = hydrated?.kind === "confirmed-account-read-model.v1";
    const snapshot = readModel ? hydrated.snapshot : hydrated;
    if (!object(snapshot)) fail("INVALID_ACCOUNT_RESPONSE", "The account snapshot was incomplete.");
    const readStudyAvailability = readModel ? optionalRead(hydrated.reads, "getStudyAvailability") : null;
    const readStudyActivity = readModel ? optionalRead(hydrated.reads, "getStudyActivity") : null;
    const nextSnapshot = copy(snapshot);
    const nextCatalogRef = copy(data.catalog_ref);
    // Hydrated snapshots remain read-only in memory. Do not copy large server
    // state into the optional synchronous browser cache. Recovery writes are
    // limited to Accounts' fixed outbox and explicit immutable claim backup.
    // Trusted adapters can reenter through accessors or cloning. Stage every
    // value first, then guard the callback-free publication as one unit.
    assertSession(session, ticket);
    if (sequence !== session.loadSequence || revision < Math.max(session.revision, session.minimumRevision)) {
      fail("STALE_ACCOUNT_SNAPSHOT", "A newer account snapshot is already available.");
    }
    session.snapshot = nextSnapshot;
    session.readStudyAvailability = readStudyAvailability;
    session.readStudyActivity = readStudyActivity;
    session.revision = revision;
    session.raw = raw;
    session.catalogRef = nextCatalogRef;
    return session.revision;
  }

  async function receiptMatchesClaim(data, draft, session) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(draft.request.raw_state_json));
    assertSession(session);
    const expectedDigest = "sha256:" + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return data?.result?.receipt?.operation === "claim_local_state" &&
      data.result.receipt.idempotency_key === draft.request.request_id &&
      typeof data.result.receipt.replayed === "boolean" &&
      data.result.source_id === draft.request.source_id &&
      data.result.source_digest === expectedDigest &&
      data.catalog_ref?.version === draft.request.catalog_ref?.version && data.catalog_ref?.digest === draft.request.catalog_ref?.digest &&
      data.durable_revision === draft.request.expected_revision + 1;
  }
  function sameClaimDraft(saved, draft) {
    return saved?.accountBinding === draft.accountBinding &&
      ["request_id", "expected_revision", "source_id", "raw_state_json"].every((key) => saved.request?.[key] === draft.request[key]) &&
      saved.request?.catalog_ref?.version === draft.request.catalog_ref.version &&
      saved.request?.catalog_ref?.digest === draft.request.catalog_ref.digest;
  }
  async function inspectClaim(session) {
    const draft = session.lease.claim.read();
    if (!draft) return;
    session.claimPending = true;
    try {
      const receipt = await request(`/receipts/${encodeURIComponent(draft.request.request_id)}`, {
        binding: session.binding, check: () => assertSession(session),
      });
      if (await receiptMatchesClaim(receipt, draft, session)) {
        session.minimumRevision = Math.max(session.minimumRevision, receipt.durable_revision);
        if (session.revision < session.minimumRevision) await refresh(session);
        session.claimPending = false;
      }
    } catch (error) {
      assertSession(session);
      // A missing/unavailable receipt never triggers an automatic import.
      if (error.code === "ACCOUNT_CHANGED") throw error;
    }
  }

  async function connect({ broadcast = false } = {}) {
    const discovery = controller.beginEpoch({ broadcast });
    const releasing = releaseCompletion;
    if (releasing) {
      await releasing;
      assertDiscovery(discovery);
      if (releaseCompletion === releasing) releaseCompletion = null;
    }
    const data = await request("/state", { check: () => assertDiscovery(discovery) });
    if (typeof data.account_binding !== "string" || !data.account_binding) fail("INVALID_ACCOUNT_RESPONSE", "An authenticated account binding is required.");
    const ticket = controller.bindPrincipal(data.account_binding, discovery);
    const lease = await controller.acquire({ accountBinding: data.account_binding, ticket });
    assertDiscovery(ticket);
    if (!lease.isCurrent()) changed();
    const session = { binding: data.account_binding, lease, ticket, revision: -1, minimumRevision: 0, loadSequence: 0,
      snapshot: null, readStudyAvailability: null, readStudyActivity: null, raw: undefined,
      view: { route: "study", selectedDeckId: null }, claimPending: false, claimPreparing: false, claimSending: false };
    current = session;
    // Pre-send guard only: do not discard a confirmed old-account receipt here.
    // WebMCP must see it, validate it, then return ACCOUNT_CHANGED_AFTER_COMMIT.
    try {
      session.client = createDurableClient({ baseUrl, outbox: lease.outbox, fetchImpl: (...args) => {
        assertSession(session);
        return fetchImpl(...args);
      } });
      await refresh(session);
      await inspectClaim(session);
      assertSession(session);
    } catch (error) {
      if (current === session) await lease.release();
      throw error;
    }

    const facade = {
      getSnapshot() {
        assertSession(session);
        return { ...copy(session.snapshot), view: copy(session.view) };
      },
      getStudyAvailability(args = {}) {
        return readConfirmedProjection(session, "readStudyAvailability", args, "Study availability", "STUDY_AVAILABILITY_UNAVAILABLE");
      },
      getStudyActivity(args = {}) {
        return readConfirmedProjection(session, "readStudyActivity", args, "Study activity", "STUDY_ACTIVITY_UNAVAILABLE");
      },
      setView(patch) {
        assertSession(session);
        // Navigation is device-local presentation, never a second business write.
        session.view = { ...session.view, ...copy(patch) };
      },
    };
    for (const method of [...READS, ...WRITES]) {
      facade[method] = async (...args) => {
        assertSession(session);
        if (WRITES.includes(method) && (session.claimPending || session.claimPreparing)) fail("CLAIM_RECOVERY_REQUIRED", "Finish or recover the original local import before another write.");
        let result;
        try { result = await session.client[method](...args); }
        catch (error) { retireOnAuthError(error, session); throw error; }
        if (WRITES.includes(method) && result?.receipt?.replayed === true && current === session && lease.isCurrent()) {
          try {
            await refresh(session);
            assertSession(session);
            onReplay({ execution_context: session.ticket });
          } catch { /* A confirmed replay is not a second action or a write failure. */ }
        }
        return result;
      };
    }
    return Object.freeze({
      store: Object.freeze(facade), executionGuard: lease.executionGuard, accountBinding: session.binding,
      refresh: (context = ticket) => refresh(session, context),
      isCurrent: (context = ticket) => current === session && lease.executionGuard.isCurrent(context),
      getRecovery() {
        assertSession(session);
        return { command: session.client.getPending(), claim: session.claimPending ? lease.claim.read() : null };
      },
      async retryPending() {
        assertSession(session);
        if (session.claimPending) fail("CLAIM_RECOVERY_REQUIRED", "Recover the original local import first.");
        const result = await session.client.retryPending();
        assertSession(session);
        await refresh(session);
        return result; // Recovery hydrates; it never emits another reveal/advance.
      },
      async previewLocalClaim() {
        assertSession(session);
        if (!localClaimSource) fail("LOCAL_CLAIM_UNAVAILABLE", "A matching local source has not been selected for import.");
        if (session.raw !== null || session.revision !== 0 || session.client.getPending() || session.claimPending) {
          fail("LOCAL_CLAIM_NOT_EMPTY", "Local data can only be copied explicitly into an empty account. Neither workspace was changed.");
        }
        const source = await localClaimSource.inspect();
        assertSession(session);
        const preview = Object.freeze({ accountBinding: session.binding, bytes: new TextEncoder().encode(source.rawStateJson).byteLength });
        previews.set(preview, { session, source });
        return preview;
      },
      async confirmLocalClaim(preview, confirmedAccountBinding) {
        assertSession(session);
        const saved = previews.get(preview);
        if (!saved || saved.session !== session || confirmedAccountBinding !== session.binding) changed();
        if (session.claimPending || session.claimPreparing || session.client.getPending() || session.raw !== null || session.revision !== 0) {
          fail("LOCAL_CLAIM_NOT_EMPTY", "The destination changed. No local data was imported.");
        }
        session.claimPreparing = true; // Fence tool writes before the first await.
        try {
          const source = await localClaimSource.prepare({ ...saved.source, accountBinding: session.binding,
            check: () => assertSession(session) });
          assertSession(session);
          if (session.client.getPending() || session.raw !== null || session.revision !== 0) {
            fail("LOCAL_CLAIM_NOT_EMPTY", "The destination changed while preserving the import. Both copies remain intact.");
          }
        const draft = { accountBinding: session.binding, request: { request_id: `claim:${makeId()}`, expected_revision: 0,
          source_id: source.sourceId, catalog_ref: copy(source.catalogRef), raw_state_json: source.rawStateJson } };
        // Immutable exact intent/backup must be durably readable before HTTP.
        lease.claim.write(draft);
        session.claimPending = true;
        assertSession(session);
        if (!sameClaimDraft(lease.claim.read(), draft)) fail("CLAIM_BACKUP_UNCONFIRMED", "The import backup was not confirmed. Nothing was sent.");
        previews.delete(preview);
        session.claimPending = true;
          return await sendClaim(session);
        } finally { session.claimPreparing = false; }
      },
      retryLocalClaim: () => sendClaim(session),
      release: () => lease.release(),
    });
  }

  async function sendClaim(session) {
    assertSession(session);
    if (session.claimSending) fail("CLAIM_IN_FLIGHT", "The original import is still being confirmed.");
    const draft = session.lease.claim.read();
    if (!draft || !session.claimPending || session.client.getPending()) fail("CLAIM_RECOVERY_REQUIRED", "No pending local import is available to retry.");
    session.claimSending = true;
    try {
      const data = await request("/claims", { binding: session.binding, body: draft.request, check: () => assertSession(session) });
      if (!await receiptMatchesClaim(data, draft, session)) fail("INVALID_CLAIM_RECEIPT", "The import receipt was incomplete. Keep the original backup for recovery.");
      session.minimumRevision = Math.max(session.minimumRevision, data.durable_revision);
      await refresh(session);
      assertSession(session);
      session.claimPending = false; // Original key and immutable backup are kept.
      return data.result;
    } finally { session.claimSending = false; }
  }

  return Object.freeze({ connect, invalidate: () => controller.beginEpoch({ broadcast: true }), dispose: () => controller.dispose() });
}
