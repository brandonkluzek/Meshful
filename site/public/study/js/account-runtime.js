import { WEBMCP_STUDY_EXECUTION } from "./webmcp.js";

// Website lifecycle only. Browser reads are lock-free and server-confirmed.
// Writes remain in Backend's durable client. Study writes own the exact Study
// writer; short account commands use an independent serialized recovery lane.
// No local business-state fallback exists here.
const READ_OPERATIONS = Object.freeze({
  getLearningOverview: "get_learning_overview",
  searchLibrary: "search_library",
  searchMyDecks: "list_my_decks",
  getDeck: "get_deck",
  validateDeck: "validate_deck",
  getStudySession: "get_study_session",
});
const WRITE_OPERATIONS = Object.freeze({
  ingestDeck: "ingest_deck",
  updateDeck: "update_deck",
  addCards: "add_cards",
  updateCards: "update_cards",
  startStudySession: "start_study_session",
  submitGrade: "submit_grade",
  finishStudySession: "finish_study_session",
  addLibraryDeck: "add_library_deck",
  setDeckArchived: "set_deck_archived",
});
const STUDY_WRITES = new Set(["startStudySession", "submitGrade", "finishStudySession"]);
const STATE_BUSY_RETRY_DELAYS_MS = Object.freeze([75, 200]);
const copy = (value) => structuredClone(value);

export class AccountRuntimeError extends Error {
  constructor(code, message) { super(message); this.name = "AccountRuntimeError"; this.code = code; }
}

const fail = (code, message) => { throw new AccountRuntimeError(code, message); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const changed = () => fail("ACCOUNT_CHANGED", "Account access changed. Reconnect before continuing; saved work has not been reset.");
const operationId = (args) => args?.client_action_id ?? args?.idempotency_key ?? null;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function samePendingAction(pending, method, args) {
  return pending?.command?.operation === WRITE_OPERATIONS[method]
    && pending.command.request_id === operationId(args)
    && stableJson(pending.command.args) === stableJson(args);
}

const optionalRead = (reads, name) => {
  try { const read = reads?.[name]; return typeof read === "function" ? read : null; }
  catch { return null; }
};

export function createAccountRuntime({
  createSessionController, createDurableClient, createStudyWriterClient = null,
  generateWriterToken = null, hydrateSnapshot, storageOptions,
  fetchImpl = globalThis.fetch, baseUrl = "/api/learner/v2", localClaimSource = null,
  onInvalidate = () => {}, onStudySuperseded = () => {}, onReplay = () => {},
  makeId = () => globalThis.crypto.randomUUID(),
  wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  schedule = (work, delay) => setTimeout(work, delay),
} = {}) {
  if (![createSessionController, createDurableClient, hydrateSnapshot, fetchImpl, onInvalidate,
    onStudySuperseded, onReplay, makeId, wait, schedule].every((fn) => typeof fn === "function")) {
    fail("ACCOUNT_CONFIGURATION", "The private account integration is incomplete.");
  }
  const serverWriterEnabled = typeof createStudyWriterClient === "function" &&
    typeof generateWriterToken === "function";
  if ((createStudyWriterClient === null) !== (generateWriterToken === null) ||
      (createStudyWriterClient !== null && !serverWriterEnabled)) {
    fail("ACCOUNT_CONFIGURATION", "The server study-writer integration is incomplete.");
  }
  if (!/^\/api\/learner\/v[12]$/.test(baseUrl)) fail("ACCOUNT_CONFIGURATION", "Use the same-origin learner endpoint.");

  let current = null;
  const previews = new WeakMap();
  const controller = createSessionController({ ...storageOptions, onInvalidate(reason) {
    const retiring = current;
    current = null;
    if (retiring) {
      retiring.snapshot = null;
      retiring.raw = undefined;
      retiring.catalogRef = null;
      retiring.readStudyAvailability = null;
      retiring.readStudyActivity = null;
      retiring.study = null;
      retiring.studyPromise = null;
    }
    onInvalidate(reason);
  } });

  function assertSession(session, ticket = session.browseTicket) {
    if (current !== session || !session.browse.executionGuard.isCurrent(ticket)) changed();
  }

  function assertDiscovery(ticket) {
    if (!controller.executionGuard.isCurrent(ticket)) changed();
  }

  function assertWriter(session, access, ticket) {
    assertSession(session);
    if (!access.executionGuard.isCurrent(ticket)) fail("ACCOUNT_LEASE_LOST", "Account writer access changed. The recovery draft was preserved.");
  }

  function retireOnAuthError(error, session) {
    if (current === session && (error?.status === 401 || error?.status === 403 ||
      /^(ACCOUNT_CHANGED|UNAUTHENTICATED|unauthenticated|csrf_rejected|untrusted_ingress|auth_unavailable)$/.test(error?.code ?? ""))) {
      controller.beginEpoch({ broadcast: true });
    }
  }

  async function request(path, { session = null, binding, body, writerGrant = null, check } = {}) {
    check();
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          ...(binding ? { "X-Meshful-Account": binding } : {}),
          ...(writerGrant ? {
            "X-Meshful-Writer-Epoch": String(writerGrant.writerEpoch),
            "X-Meshful-Writer-Token": writerGrant.token,
          } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      check();
      fail("REQUEST_UNCONFIRMED", "The request was not confirmed. Saved recovery data was preserved.");
    }
    check();
    let payload;
    try { payload = await response.json(); }
    catch { fail("INVALID_ACCOUNT_RESPONSE", "The account response was incomplete."); }
    check();
    if (!response.ok || payload?.ok !== true) {
      const error = { status: response.status, code: payload?.error?.code };
      retireOnAuthError(error, session);
      fail(payload?.error?.code ?? "ACCOUNT_REQUEST_FAILED",
        payload?.error?.message ?? "The account request could not be confirmed. Recovery data was preserved.");
    }
    if (!object(payload.data)) fail("INVALID_ACCOUNT_RESPONSE", "The account response was incomplete.");
    return payload.data;
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
    const result = read(copy(args));
    assertSession(session);
    if (read !== session[field] || snapshot !== session.snapshot || revision !== session.revision ||
      sequence !== session.loadSequence || revision < session.minimumRevision) {
      fail("STALE_ACCOUNT_SNAPSHOT", `${label} changed. Check the current account state again.`);
    }
    if (typeof result?.then === "function") {
      Promise.resolve(result).catch(() => {});
      fail("INVALID_ACCOUNT_RESPONSE", `${label} must be a synchronous confirmed read.`);
    }
    if (!object(result) || result.app_revision !== snapshot.revision) {
      fail("INVALID_ACCOUNT_RESPONSE", `${label} does not match the confirmed account state.`);
    }
    const projected = copy(result);
    assertSession(session);
    if (read !== session[field] || snapshot !== session.snapshot || revision !== session.revision ||
      sequence !== session.loadSequence || revision < session.minimumRevision) {
      fail("STALE_ACCOUNT_SNAPSHOT", `${label} changed. Check the current account state again.`);
    }
    return projected;
  }

  function validateStateData(data, session = null) {
    if (typeof data?.account_binding !== "string" || !data.account_binding ||
      !Number.isSafeInteger(data.durable_revision) || data.durable_revision < 0 ||
      !(data.state_json === null || typeof data.state_json === "string") ||
      !object(data.catalog_ref)) {
      fail("INVALID_ACCOUNT_RESPONSE", "The account snapshot was incomplete.");
    }
    if (session && data.account_binding !== session.binding) {
      controller.beginEpoch({ broadcast: true });
      changed();
    }
  }

  async function adoptSnapshot(session, ticket, data, sequence, job) {
    assertSession(session, ticket);
    validateStateData(data, session);
    const revision = data.durable_revision;
    const raw = data.state_json;
    job.minimum = Math.max(job.minimum, revision);
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
    const hydrated = await hydrateSnapshot(data, { check: () => {
      assertSession(session, ticket);
      if (sequence !== session.loadSequence) fail("STALE_ACCOUNT_SNAPSHOT", "A newer account snapshot is already available.");
    } });
    assertSession(session, ticket);
    if (sequence !== session.loadSequence || revision < Math.max(session.revision, session.minimumRevision)) {
      fail("STALE_ACCOUNT_SNAPSHOT", "A newer account snapshot is already available.");
    }
    const readModel = hydrated?.kind === "confirmed-account-read-model.v1";
    const snapshot = readModel ? hydrated.snapshot : hydrated;
    if (!object(snapshot)) fail("INVALID_ACCOUNT_RESPONSE", "The account snapshot was incomplete.");
    const nextSnapshot = copy(snapshot);
    const nextCatalogRef = copy(data.catalog_ref);
    const readStudyAvailability = readModel ? optionalRead(hydrated.reads, "getStudyAvailability") : null;
    const readStudyActivity = readModel ? optionalRead(hydrated.reads, "getStudyActivity") : null;
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
    return revision;
  }

  async function loadSnapshot(session, ticket, job, providedData) {
    assertSession(session, ticket);
    const sequence = ++session.loadSequence;
    let data = providedData;
    if (data === undefined) {
      for (let attempt = 0; ; attempt += 1) {
        assertSession(session, ticket);
        if (sequence !== session.loadSequence) fail("STALE_ACCOUNT_SNAPSHOT", "A newer account snapshot is already available.");
        try {
          data = await request("/state", { session, check: () => {
            assertSession(session, ticket);
            if (sequence !== session.loadSequence) fail("STALE_ACCOUNT_SNAPSHOT", "A newer account snapshot is already available.");
          } });
          break;
        } catch (error) {
          if (error?.code !== "SERVICE_BUSY" || attempt >= STATE_BUSY_RETRY_DELAYS_MS.length) throw error;
          await wait(STATE_BUSY_RETRY_DELAYS_MS[attempt]);
        }
      }
    }
    return adoptSnapshot(session, ticket, data, sequence, job);
  }

  function refresh(session, ticket = session.browse.executionGuard.capture()) {
    const job = { minimum: Math.max(session.revision, session.minimumRevision) };
    let task;
    task = loadSnapshot(session, ticket, job).catch(async (error) => {
      assertSession(session, ticket);
      const successor = session.latestRefresh;
      if (["STALE_CLIENT_RESPONSE", "STALE_ACCOUNT_SNAPSHOT"].includes(error.code) && successor && successor !== task) {
        await successor;
        assertSession(session, ticket);
        if (session.revision >= Math.max(job.minimum, session.minimumRevision)) return session.revision;
      }
      throw error;
    });
    session.latestRefresh = task;
    return task;
  }

  async function query(session, method, args = {}) {
    const ticket = session.browse.executionGuard.capture();
    assertSession(session, ticket);
    const data = await request("/queries", {
      session,
      binding: session.binding,
      body: { operation: READ_OPERATIONS[method], args: copy(args) },
      check: () => assertSession(session, ticket),
    });
    if (!Number.isSafeInteger(data.durable_revision) || data.durable_revision < 0 || !Object.hasOwn(data, "result")) {
      fail("INVALID_ACCOUNT_RESPONSE", "The account query response was incomplete.");
    }
    if (data.durable_revision < session.minimumRevision) {
      fail("STALE_ACCOUNT_SNAPSHOT", "The account query predates confirmed learner state.");
    }
    session.minimumRevision = Math.max(session.minimumRevision, data.durable_revision);
    if (data.durable_revision > session.revision) {
      session.readStudyAvailability = null;
      session.readStudyActivity = null;
    }
    assertSession(session, ticket);
    return copy(data.result);
  }

  function scopedFetch(session, access, writerTicket) {
    return async (...args) => {
      assertWriter(session, access, writerTicket);
      const response = await fetchImpl(...args);
      assertWriter(session, access, writerTicket);
      return response;
    };
  }

  async function acquireServerWriter(session, access, writerTicket, { explicit = false } = {}) {
    if (!serverWriterEnabled) return null;
    assertWriter(session, access, writerTicket);
    const client = createStudyWriterClient({
      baseUrl,
      accountBinding: session.binding,
      fetchImpl: scopedFetch(session, access, writerTicket),
    });
    const status = await client.status();
    assertWriter(session, access, writerTicket);
    if (status.active && !explicit) {
      fail("WRITER_ALREADY_ACTIVE",
        "Study is active in another browser or device. Choose Continue here to take control explicitly.");
    }
    const token = generateWriterToken();
    const action = status.active ? "takeover" : "acquire";
    const result = await client[action]({
      requestId: `writer-${action}:${makeId()}`,
      expectedWriterEpoch: status.writer_epoch,
      token,
    });
    assertWriter(session, access, writerTicket);
    if (!result?.writerGrant) {
      fail("INVALID_ACCOUNT_RESPONSE", "The account writer grant was incomplete.");
    }
    return { client, grant: result.writerGrant };
  }

  async function validateServerWriter(session, access, writerTicket, serverWriter) {
    if (!serverWriter) return;
    const result = await serverWriter.client.validate(serverWriter.grant);
    assertWriter(session, access, writerTicket);
    if (result.current !== true || result.writer_epoch !== serverWriter.grant.writerEpoch) {
      fail("WRITER_SUPERSEDED", "Study continued in another browser or device. The saved recovery action was preserved.");
    }
  }

  async function releaseServerWriter(session, access, writerTicket, serverWriter) {
    if (!serverWriter) return;
    assertWriter(session, access, writerTicket);
    await serverWriter.client.release({
      requestId: `writer-release:${makeId()}`,
      expectedWriterEpoch: serverWriter.grant.writerEpoch,
      token: serverWriter.grant.token,
    });
    assertWriter(session, access, writerTicket);
  }

  async function prepareClient(session, access, {
    explicit = false,
    requireServerWriter = false,
  } = {}) {
    const writerTicket = access.executionGuard.capture();
    assertWriter(session, access, writerTicket);
    const recovery = access.recovery.read();
    const claim = access.claim.read();
    if (claim && session.raw === null && session.revision === 0) {
      session.claimPending = true;
      fail("CLAIM_RECOVERY_REQUIRED", "Finish or recover the original local import before another write.");
    }
    let serverWriter = null;
    try {
      if (requireServerWriter) {
        serverWriter = await acquireServerWriter(session, access, writerTicket, { explicit });
      }
      const client = createDurableClient({
        baseUrl,
        outbox: access.outbox,
        fetchImpl: scopedFetch(session, access, writerTicket),
        ...(serverWriter ? { writerGrant: serverWriter.grant } : {}),
      });
      const pending = client.getPending();
      if (!pending) {
        const loaded = await client.load();
        assertWriter(session, access, writerTicket);
        if (loaded.account_binding !== session.binding) {
          controller.beginEpoch({ broadcast: true });
          changed();
        }
      }
      return { access, writerTicket, recovery, client, pending, serverWriter };
    } catch (error) {
      if (serverWriter) {
        try { await releaseServerWriter(session, access, writerTicket, serverWriter); }
        catch { /* Preserve the first failure; the server grant stays fail-closed. */ }
      }
      throw error;
    }
  }

  function writerCommandPromise(prepared, method, args) {
    const invoke = () => prepared.client[method](copy(args));
    if (!prepared.pending) return invoke();
    if (samePendingAction(prepared.pending, method, args)) return invoke();
    if (prepared.recovery?.pending !== null) {
      fail("PENDING_COMMAND", "Recover the earlier saved action before starting a different one.");
    }
    return prepared.client.retryPending().then(invoke);
  }

  function orderedCommandRecoveries(session) {
    const recoveries = [];
    if (session.studyCommandRecovery) {
      recoveries.push({ lane: "study", command: session.studyCommandRecovery });
    }
    if (session.accountCommandRecovery) {
      recoveries.push({ lane: "account-command", command: session.accountCommandRecovery });
    }
    return recoveries.sort((left, right) => {
      const leftRevision = left.command?.command?.expected_revision;
      const rightRevision = right.command?.command?.expected_revision;
      if (Number.isSafeInteger(leftRevision) && Number.isSafeInteger(rightRevision) &&
          leftRevision !== rightRevision) return leftRevision - rightRevision;
      if (Number.isSafeInteger(leftRevision) !== Number.isSafeInteger(rightRevision)) {
        return Number.isSafeInteger(leftRevision) ? -1 : 1;
      }
      return left.lane === right.lane ? 0 : left.lane === "study" ? -1 : 1;
    });
  }

  function setCommandRecovery(session, lane, pending) {
    if (lane === "study") session.studyCommandRecovery = pending ? copy(pending) : null;
    else if (lane === "account-command") session.accountCommandRecovery = pending ? copy(pending) : null;
    else fail("INVALID_ACCOUNT_RESPONSE", "The recovery lane was not recognized.");
    const selected = orderedCommandRecoveries(session)[0] ?? null;
    session.commandRecovery = selected ? copy(selected.command) : null;
    session.commandRecoveryLane = selected?.lane ?? null;
  }

  async function completeWrite(session, result, lane) {
    assertSession(session);
    setCommandRecovery(session, lane, null);
    if (result?.receipt?.replayed === true) {
      await refresh(session);
      assertSession(session);
      onReplay({ execution_context: session.browse.executionGuard.capture() });
    }
    return result;
  }

  async function shortWrite(session, method, args) {
    assertSession(session);
    let preparedForFailure = null;
    try {
      const result = await controller.runExclusiveMutation({
        accountBinding: session.binding,
        ticket: session.accountTicket,
        purpose: "account-command",
      }, {
        prepare: async (access) => {
          const prepared = await prepareClient(session, access);
          preparedForFailure = prepared;
          if (prepared.recovery?.pending !== null && !samePendingAction(prepared.pending, method, args)) {
            setCommandRecovery(session, "account-command", prepared.pending);
            fail("PENDING_COMMAND", "Recover the earlier saved action before starting a different one.");
          }
          return prepared;
        },
        mutate: async (_access, prepared) => writerCommandPromise(prepared, method, args),
      });
      const completed = await completeWrite(session, result, "account-command");
      const retained = preparedForFailure?.client.getPending();
      if (retained) {
        setCommandRecovery(session, "account-command", retained);
      }
      return completed;
    } catch (error) {
      const retained = preparedForFailure?.client.getPending();
      if (retained) {
        setCommandRecovery(session, "account-command", retained);
      }
      retireOnAuthError(error, session);
      throw error;
    }
  }

  async function ensureStudy(session, { explicit = false } = {}) {
    assertSession(session);
    if (session.studyBlocked && !explicit) {
      fail("STUDY_SUPERSEDED", "This study was continued in another tab. Choose Continue here before grading in this tab.");
    }
    if (explicit) session.studyBlocked = false;
    if (session.study?.lease.isCurrent()) return session.study;
    // isCurrent() may discover a delayed study-intent signal and synchronously
    // revoke presentation authority. Do not let that observation fall through
    // into a fresh acquisition for an implicit/stale mutation.
    if (session.studyBlocked && !explicit) {
      fail("STUDY_SUPERSEDED", "This study was continued in another tab. Choose Continue here before grading in this tab.");
    }
    if (explicit) session.studyBlocked = false;
    if (session.studyPromise) return session.studyPromise;
    const prior = session.study;
    const requestGeneration = ++session.studyRequestGeneration;
    const task = (async () => {
      if (prior) {
        try { await prior.lease.released; } catch { /* The next native grant remains authoritative. */ }
        assertSession(session);
        if (session.studyBlocked && !explicit) {
          fail("STUDY_SUPERSEDED", "This study was continued in another tab. Choose Continue here before grading in this tab.");
        }
        if (explicit) session.studyBlocked = false;
      }
      const holder = { lease: null, client: null, recovery: null, writerTicket: null,
        serverWriter: null, superseded: false, fallbackRelease: null };
      const lease = await controller.acquireStudy({
        accountBinding: session.binding,
        ticket: session.accountTicket,
        onSuperseded(info) {
          holder.superseded = true;
          session.studyBlocked = true;
          try { onStudySuperseded(info); } catch { /* Storage safety is already revoked. */ }
        },
      });
      holder.lease = lease;
      try {
        if (requestGeneration !== session.studyRequestGeneration) {
          fail("STUDY_REQUEST_CANCELLED", "The requested study view changed before writer access was available.");
        }
        holder.writerTicket = lease.executionGuard.capture();
        assertWriter(session, lease, holder.writerTicket);
        holder.serverWriter = await acquireServerWriter(session, lease, holder.writerTicket,
          { explicit });
        holder.recovery = lease.recovery.read();
        const claim = lease.claim.read();
        if (claim && session.raw === null && session.revision === 0) {
          session.claimPending = true;
          fail("CLAIM_RECOVERY_REQUIRED", "Finish or recover the original local import before studying.");
        }
        holder.client = createDurableClient({
          baseUrl,
          outbox: lease.outbox,
          fetchImpl: scopedFetch(session, lease, holder.writerTicket),
          ...(holder.serverWriter ? { writerGrant: holder.serverWriter.grant } : {}),
        });
        const pending = holder.client.getPending();
        setCommandRecovery(session, "study", pending);
        if (!pending) {
          const loaded = await holder.client.load();
          assertWriter(session, lease, holder.writerTicket);
          if (loaded.account_binding !== session.binding) {
            controller.beginEpoch({ broadcast: true });
            changed();
          }
        }
        session.study = holder;
        return holder;
      } catch (error) {
        if (holder.serverWriter) {
          try { await releaseServerWriter(session, lease, holder.writerTicket, holder.serverWriter); }
          catch { /* Preserve the acquisition failure; the server remains fail-closed. */ }
        }
        try { await lease.release(); } catch { /* Preserve the original failure. */ }
        throw error;
      }
    })();
    session.studyPromise = task;
    try { return await task; }
    finally { if (session.studyPromise === task) session.studyPromise = null; }
  }

  async function studyWrite(session, method, args, metadata = {}) {
    const holder = await ensureStudy(session);
    const lease = holder.lease;
    const ticket = lease.executionGuard.capture();
    const studyExecution = metadata?.[WEBMCP_STUDY_EXECUTION];
    studyExecution?.bind(lease.executionGuard);
    const pending = holder.client.getPending();
    // A short account command may have advanced the whole-state revision while
    // leaving this session/card untouched. Refresh the durable head before
    // constructing a new Study draft; exact inner revisions still fail closed.
    if (!pending) {
      const loaded = await holder.client.load();
      assertWriter(session, lease, ticket);
      if (loaded.account_binding !== session.binding) {
        controller.beginEpoch({ broadcast: true });
        changed();
      }
    }
    if (holder.recovery?.pending !== null && !samePendingAction(pending, method, args)) {
      setCommandRecovery(session, "study", pending);
      fail("PENDING_COMMAND", "Recover the earlier saved action before starting a different one.");
    }
    let result;
    try {
      result = await lease.runMutation(() => writerCommandPromise({
        client: holder.client,
        pending: holder.client.getPending(),
        recovery: holder.recovery,
      }, method, args));
      await validateServerWriter(session, lease, ticket, holder.serverWriter);
    } catch (error) {
      if (error?.code === "WRITER_SUPERSEDED") {
        holder.superseded = true;
        session.studyBlocked = true;
        try { onStudySuperseded({ reason: "remote-study-writer", accountBinding: session.binding }); }
        catch { /* Server writer authority is already revoked. */ }
      }
      if (error?.code === "SESSION_NOT_ACTIVE") {
        // A same-deck account Archive may have atomically paused this session
        // on another tab/device. The confirmed rejection made no review; retire
        // the now-stale Study presentation and refresh the durable account view.
        try { await releaseStudy(session); } catch { /* Preserve the canonical conflict. */ }
        try { await refresh(session); } catch { /* Preserve the canonical conflict. */ }
      }
      retireOnAuthError(error, session);
      throw error;
    }
    if (!lease.executionGuard.isCurrent(ticket)) {
      fail("ACCOUNT_CHANGED_AFTER_COMMIT", "The action may be saved, but study continued in another tab. Recover it there; do not submit it again.");
    }
    holder.recovery = lease.recovery.read();
    const completed = result?.session?.status === "completed" || method === "finishStudySession";
    if (completed && studyExecution) {
      studyExecution.deferRelease(() => releaseStudy(session));
    } else if (completed) {
      clearTimeout(holder.fallbackRelease);
      holder.fallbackRelease = schedule(() => releaseStudy(session).catch(() => {}), 5_000);
    }
    return completeWrite(session, result, "study");
  }

  async function releaseStudy(session, { clearBlock = false, cancelPending = false } = {}) {
    assertSession(session);
    if (cancelPending) session.studyRequestGeneration += 1;
    const holder = session.study;
    if (clearBlock) session.studyBlocked = false;
    if (!holder) return;
    if (session.study === holder) session.study = null;
    clearTimeout(holder.fallbackRelease);
    let serverError = null;
    try {
      await releaseServerWriter(session, holder.lease, holder.writerTicket, holder.serverWriter);
    } catch (error) { serverError = error; }
    finally { await holder.lease.release(); }
    if (serverError && !["WRITER_SUPERSEDED", "STALE_WRITER_EPOCH"].includes(serverError.code)) {
      throw serverError;
    }
  }

  async function recoverStudyCommand(session, activeStudy = null) {
    const existing = activeStudy ?? (session.study?.lease.isCurrent() ? session.study : null);
    const holder = existing ?? await ensureStudy(session);
    if (!holder.client.getPending()) {
      if (!existing) await releaseStudy(session);
      fail("NO_PENDING_COMMAND", "There is no uncertain saved Study action to recover.");
    }
    const result = await holder.lease.runMutation(() => holder.client.retryPending());
    await validateServerWriter(session, holder.lease, holder.writerTicket, holder.serverWriter);
    holder.recovery = holder.lease.recovery.read();
    return result;
  }

  function recoverAccountCommand(session) {
    return controller.runExclusiveMutation({
      accountBinding: session.binding,
      ticket: session.accountTicket,
      purpose: "account-command",
    }, {
      prepare: async (access) => {
        const prepared = await prepareClient(session, access);
        if (!prepared.pending) {
          fail("NO_PENDING_COMMAND", "There is no uncertain saved account action to recover.");
        }
        return prepared;
      },
      mutate: async (_access, prepared) => prepared.client.retryPending(),
    });
  }

  async function recoverPending(session) {
    assertSession(session);
    const activeStudy = session.study?.lease.isCurrent() ? session.study : null;
    let recoveredLane = session.commandRecoveryLane;
    let result;
    if (recoveredLane === "study") {
      result = await recoverStudyCommand(session, activeStudy);
    } else if (recoveredLane === "account-command") {
      result = await recoverAccountCommand(session);
    } else if (activeStudy?.client.getPending()) {
      // Compatibility for controller adapters that predate lock-free discovery.
      recoveredLane = "study";
      result = await recoverStudyCommand(session, activeStudy);
    } else {
      try {
        result = await recoverAccountCommand(session);
        recoveredLane = "account-command";
      } catch (error) {
        if (error?.code !== "NO_PENDING_COMMAND") throw error;
        // Legacy Study drafts retain the historical outbox and must never be
        // sent through the independent account-command lane.
        result = await recoverStudyCommand(session, activeStudy);
        recoveredLane = "study";
      }
    }
    setCommandRecovery(session, recoveredLane, null);
    await refresh(session);
    assertSession(session);
    onReplay({ execution_context: session.browse.executionGuard.capture() });
    return result;
  }

  async function digestClaim(raw) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return "sha256:" + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function sameClaimDraft(saved, draft) {
    return saved?.accountBinding === draft.accountBinding &&
      ["request_id", "expected_revision", "source_id", "raw_state_json"].every((key) => saved.request?.[key] === draft.request[key]) &&
      saved.request?.catalog_ref?.version === draft.request.catalog_ref.version &&
      saved.request?.catalog_ref?.digest === draft.request.catalog_ref.digest;
  }

  function validClaimReceipt(data, draft, expectedDigest) {
    return data?.result?.receipt?.operation === "claim_local_state" &&
      data.result.receipt.idempotency_key === draft.request.request_id &&
      typeof data.result.receipt.replayed === "boolean" &&
      data.result.source_id === draft.request.source_id &&
      data.result.source_digest === expectedDigest &&
      data.catalog_ref?.version === draft.request.catalog_ref?.version &&
      data.catalog_ref?.digest === draft.request.catalog_ref?.digest &&
      data.durable_revision === draft.request.expected_revision + 1;
  }

  async function sendClaim(session, suppliedDraft = null) {
    assertSession(session);
    if (session.claimSending) fail("CLAIM_IN_FLIGHT", "The original import is still being confirmed.");
    session.claimSending = true;
    try {
      const data = await controller.runExclusiveMutation({
        accountBinding: session.binding,
        ticket: session.accountTicket,
        purpose: "claim",
      }, {
        prepare: async (access) => {
          const writerTicket = access.executionGuard.capture();
          assertWriter(session, access, writerTicket);
          const recovery = access.recovery.read();
          if (recovery.pending !== null) {
            setCommandRecovery(session, "study", recovery.pending.pending);
            fail("PENDING_COMMAND", "Recover the earlier saved action before importing local data.");
          }
          const saved = access.claim.read();
          const draft = suppliedDraft ?? saved;
          if (!draft) fail("CLAIM_RECOVERY_REQUIRED", "No saved local import is available to retry.");
          if (saved && !sameClaimDraft(saved, draft)) fail("ACCOUNT_CLAIM_CONFLICT", "A different local import backup is already retained.");
          const expectedDigest = await digestClaim(draft.request.raw_state_json);
          assertWriter(session, access, writerTicket);
          const serverWriter = await acquireServerWriter(session, access, writerTicket);
          return { access, writerTicket, saved, draft, expectedDigest, serverWriter };
        },
        mutate: async (_access, prepared) => {
          try {
            if (!prepared.saved) prepared.access.claim.write(prepared.draft);
            session.claimPending = true;
            const data = await request("/claims", {
              session,
              binding: session.binding,
              body: prepared.draft.request,
              writerGrant: prepared.serverWriter?.grant ?? null,
              check: () => assertWriter(session, prepared.access, prepared.writerTicket),
            });
            if (!validClaimReceipt(data, prepared.draft, prepared.expectedDigest)) {
              fail("INVALID_CLAIM_RECEIPT", "The import receipt was incomplete. Keep the original backup for recovery.");
            }
            await validateServerWriter(session, prepared.access, prepared.writerTicket,
              prepared.serverWriter);
            return data;
          } finally {
            await releaseServerWriter(session, prepared.access, prepared.writerTicket,
              prepared.serverWriter);
          }
        },
      });
      session.minimumRevision = Math.max(session.minimumRevision, data.durable_revision);
      await refresh(session);
      assertSession(session);
      session.claimPending = false;
      return data.result;
    } finally { session.claimSending = false; }
  }

  async function connect({ broadcast = false } = {}) {
    const discovery = controller.beginEpoch({ broadcast });
    const initial = await request("/state", { check: () => assertDiscovery(discovery) });
    validateStateData(initial);
    const accountTicket = controller.bindPrincipal(initial.account_binding, discovery);
    const browse = controller.browse({ accountBinding: initial.account_binding, ticket: accountTicket });
    const browseTicket = browse.executionGuard.capture();
    const session = {
      binding: initial.account_binding,
      accountTicket,
      browse,
      browseTicket,
      revision: -1,
      minimumRevision: 0,
      loadSequence: 0,
      latestRefresh: null,
      snapshot: null,
      raw: undefined,
      catalogRef: null,
      readStudyAvailability: null,
      readStudyActivity: null,
      view: { route: "study", selectedDeckId: null },
      study: null,
      studyPromise: null,
      studyRequestGeneration: 0,
      studyBlocked: false,
      commandRecovery: null,
      commandRecoveryLane: null,
      studyCommandRecovery: null,
      accountCommandRecovery: null,
      claimPending: false,
      claimPreparing: false,
      claimSending: false,
    };
    current = session;
    try {
      await loadSnapshot(session, browseTicket, { minimum: 0 }, initial);
      assertSession(session, browseTicket);
      if (typeof controller.inspectRecoveries === "function") {
        const discovered = controller.inspectRecoveries({
          accountBinding: session.binding,
          ticket: session.accountTicket,
        });
        assertSession(session, browseTicket);
        setCommandRecovery(session, "study", discovered.study);
        setCommandRecovery(session, "account-command", discovered.accountCommand);
      }
    } catch (error) {
      if (current === session) current = null;
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
        session.view = { ...session.view, ...copy(patch) };
      },
    };
    for (const method of Object.keys(READ_OPERATIONS)) facade[method] = (args = {}) => query(session, method, args);
    for (const method of Object.keys(WRITE_OPERATIONS)) {
      facade[method] = (args = {}, metadata = {}) => STUDY_WRITES.has(method)
        ? studyWrite(session, method, args, metadata)
        : shortWrite(session, method, args);
    }

    return Object.freeze({
      store: Object.freeze(facade),
      executionGuard: browse.executionGuard,
      accountBinding: session.binding,
      refresh: (context = browse.executionGuard.capture()) => refresh(session, context),
      isCurrent: (context = browseTicket) => current === session && browse.executionGuard.isCurrent(context),
      beginStudy: async () => { await ensureStudy(session); return true; },
      takeOverStudy: async () => { await ensureStudy(session, { explicit: true }); return true; },
      releaseStudy: (options) => releaseStudy(session, options),
      isStudyCurrent: (executionContext = null) => {
        const lease = session.study?.lease;
        if (!lease?.isCurrent() || session.studyBlocked) return false;
        if (executionContext === null || executionContext === undefined) return true;
        try { return lease.executionGuard.isCurrent(executionContext) === true; }
        catch { return false; }
      },
      getRecovery() {
        assertSession(session);
        const commands = orderedCommandRecoveries(session).map(({ lane, command }) => ({
          lane,
          command: copy(command),
        }));
        return {
          command: copy(session.commandRecovery),
          commandLane: session.commandRecoveryLane,
          commands,
          claim: session.claimPending ? { pending: true } : null,
          unchecked: true,
        };
      },
      retryPending: () => recoverPending(session),
      async previewLocalClaim() {
        assertSession(session);
        if (!localClaimSource) fail("LOCAL_CLAIM_UNAVAILABLE", "A matching local source has not been selected for import.");
        if (session.raw !== null || session.revision !== 0 || session.claimPending) {
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
        if (session.raw !== null || session.revision !== 0 || session.claimPending || session.claimPreparing) {
          fail("LOCAL_CLAIM_NOT_EMPTY", "The destination changed. No local data was imported.");
        }
        session.claimPreparing = true;
        try {
          const source = await localClaimSource.prepare({
            ...saved.source,
            accountBinding: session.binding,
            check: () => assertSession(session),
          });
          assertSession(session);
          if (session.raw !== null || session.revision !== 0) {
            fail("LOCAL_CLAIM_NOT_EMPTY", "The destination changed while preserving the import. Both copies remain intact.");
          }
          const draft = {
            accountBinding: session.binding,
            request: {
              request_id: `claim:${makeId()}`,
              expected_revision: 0,
              source_id: source.sourceId,
              catalog_ref: copy(source.catalogRef),
              raw_state_json: source.rawStateJson,
            },
          };
          previews.delete(preview);
          return await sendClaim(session, draft);
        } finally { session.claimPreparing = false; }
      },
      retryLocalClaim: () => sendClaim(session),
      release: () => releaseStudy(session),
    });
  }

  return Object.freeze({
    connect,
    invalidate: () => controller.beginEpoch({ broadcast: true }),
    dispose: () => controller.dispose(),
  });
}
