import {
  READ_METHODS,
  WRITE_METHODS as V3_WRITE_METHODS,
} from "../../src/canonical-engine.mjs";
import { BackendError, assertJson, clone, exactKeys, object, requireThat, revision, stableJson, text } from "../../src/contracts.mjs";
import { requestIdentity } from "../../v2/src/request-identity.mjs";

const WRITE_METHODS = Object.freeze({
  ...V3_WRITE_METHODS,
  submit_self_grade: "submitSelfGrade",
  set_deck_archived: "setDeckArchived",
});
const STUDY_WRITE_OPERATIONS = new Set([
  "start_study_session",
  "submit_grade",
  "submit_self_grade",
  "finish_study_session",
]);
const TERMINAL_UNCOMMITTED_ARCHIVE_CODES = new Set([
  "INVALID_TOOL_INPUT",
  "REQUEST_ID_MISMATCH",
  "DECK_NOT_FOUND",
  "STALE_REVISION",
  "DECK_IN_ACTIVE_SESSION",
]);
const TERMINAL_UNCOMMITTED_STUDY_CODES = new Set([
  "SESSION_NOT_ACTIVE",
]);

/**
 * Browser async handoff, not a local study store or UI/hydration controller.
 * outbox.read()/write(record|null) must be synchronous and explicitly supplied.
 * The adapter must keep one immutable account scope and be held under an
 * exclusive cross-tab lease. Read/compare/write alone is not an atomic lock.
 * Create a fresh client for each Accounts authentication epoch.
 * Only {accountBinding, command} is stored: a recovery draft, never study state.
 * Clearing a confirmed draft may fail without turning a known commit into an
 * apparent failure; getPending().recoveryStatus then requires receipt replay.
 */
export function createDurableClient({
  fetchImpl = globalThis.fetch, baseUrl = "/api/learner/v2", outbox, writerGrant,
} = {}) {
  requireThat(typeof fetchImpl === "function" && typeof baseUrl === "string" && baseUrl.length > 0,
    "CLIENT_CONFIGURATION", "A fetch implementation and API base URL are required");
  requireThat(outbox && typeof outbox.read === "function" && typeof outbox.write === "function",
    "OUTBOX_REQUIRED", "Explicit synchronous recovery storage is required");
  const fixedWriterGrant = writerGrant == null ? null : validateWriterGrant(writerGrant);
  const prefix = baseUrl.replace(/\/+$/, "");
  let pending;
  try {
    const saved = synchronous(outbox.read());
    pending = saved == null ? null : validatePending(saved);
  } catch {
    throw new BackendError("OUTBOX_UNAVAILABLE", "Recovery storage could not be read; preserve its contents before continuing", 503);
  }
  let recoveryStatus = pending ? "recovery-required" : null;
  let outboxPredecessor = null;
  let commitConfirmed = false;
  let accountBinding = null;
  let durableRevision = null;
  let loadSequence = 0;
  let accountChanged = false;
  let sending = false;
  let inFlight = null;

  function getPending() {
    return pending ? { ...clone(pending), recoveryStatus } : null;
  }

  function rememberRevision(binding, value) {
    // An old replay receipt must never rewind a newer loaded/query revision.
    if (binding === accountBinding) durableRevision = Math.max(durableRevision, value);
  }

  function requireOriginalAccount() {
    requireThat(!accountChanged, "ACCOUNT_CHANGED",
      "This client belongs to a previous account; preserve its draft and create a new account-scoped client", 409);
  }

  async function request(path, { method = "GET", binding, body, writer = false } = {}) {
    const headers = { Accept: "application/json" };
    if (binding !== undefined) headers["X-Meshful-Account"] = binding;
    if (writer) {
      requireThat(fixedWriterGrant, "CLIENT_CONFIGURATION",
        "A Study writer grant is required for Study commands");
      headers["X-Meshful-Writer-Epoch"] = String(fixedWriterGrant.writerEpoch);
      headers["X-Meshful-Writer-Token"] = fixedWriterGrant.token;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    let response;
    try {
      const receiptPrefix = "/receipts/";
      const transportPath = method === "GET" && path.startsWith(receiptPrefix)
        ? `/receipts?request_id=${path.slice(receiptPrefix.length)}`
        : path;
      response = await fetchImpl(`${prefix}${transportPath}`, {
        method, headers, credentials: "same-origin", cache: "no-store", redirect: "error",
        ...(body === undefined ? {} : { body: stableJson(body) }),
      });
    } catch {
      throw new BackendError("REQUEST_UNCONFIRMED", "The request was not confirmed; preserve and retry the original recovery draft", 503);
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw malformed(); }
    if (!response.ok || payload?.ok !== true) {
      if ((!response.ok || payload?.ok === false) && typeof payload?.error?.code === "string" && typeof payload.error?.message === "string") {
        throw new BackendError(payload.error.code, payload.error.message, response.status);
      }
      throw malformed();
    }
    if (path === "/state" && payload.data?.snapshot_encoding === "canonical-json.v1"
      && (payload.data.state_json === null || typeof payload.data.state_json === "string")
      && !Object.hasOwn(payload.data, "state")) {
      let state;
      try { state = payload.data.state_json === null ? null : JSON.parse(payload.data.state_json); }
      catch { throw malformed(); }
      payload = { ...payload, data: { ...payload.data, state } };
    }
    if (!isObject(payload.data)) throw malformed();
    return payload.data;
  }

  async function load() {
    requireOriginalAccount();
    const sequence = ++loadSequence;
    const data = await request("/state");
    requireThat(sequence === loadSequence, "STALE_CLIENT_RESPONSE",
      "A newer state load superseded this response", 409);
    if (typeof data.account_binding !== "string" || data.account_binding.length === 0 ||
        !isRevision(data.durable_revision) ||
        !Object.hasOwn(data, "state") || !Object.hasOwn(data, "state_json") ||
        !(data.state === null || isObject(data.state)) ||
        !(data.state_json === null || typeof data.state_json === "string") ||
        (data.state === null) !== (data.state_json === null)) throw malformed();
    if (accountBinding !== null && accountBinding !== data.account_binding) {
      accountChanged = true;
      requireOriginalAccount();
    }
    requireThat(accountBinding === null || data.durable_revision >= durableRevision,
      "STALE_CLIENT_RESPONSE", "This snapshot predates an already known durable revision", 409);
    if (accountBinding === null) {
      accountBinding = data.account_binding;
      durableRevision = data.durable_revision;
    } else rememberRevision(accountBinding, data.durable_revision);
    // Return the actual server snapshot, without pretending a local transition
    // or stale snapshot has a newer revision. Website owns hydration ordering.
    return data;
  }

  async function query(operation, args = {}) {
    requireOriginalAccount();
    requireThat(Object.hasOwn(READ_METHODS, operation), "OPERATION_NOT_ALLOWED", "Unsupported query operation");
    const input = { operation, args: clone(assertJson(args)) };
    if (accountBinding === null) await load();
    const binding = accountBinding;
    const data = await request("/queries", { method: "POST", binding, body: input });
    if (!isRevision(data.durable_revision) || !Object.hasOwn(data, "result")) throw malformed();
    rememberRevision(binding, data.durable_revision);
    return data.result;
  }

  function persistPending(previous = outboxPredecessor ?? pending) {
    try {
      const saved = readOutbox();
      requireThat(saved === null || sameDraft(saved, previous) || sameDraft(saved, pending), "OUTBOX_CONFLICT",
        "Another recovery draft occupies this outbox; preserve both before continuing", 409);
      synchronous(outbox.write(clone(pending)));
      requireThat(sameDraft(readOutbox(), pending), "OUTBOX_UNAVAILABLE",
        "The recovery draft was not saved; no command was sent", 503);
      outboxPredecessor = null;
    }
    catch (error) {
      if (!commitConfirmed) recoveryStatus = "outbox-write-failed";
      if (error instanceof BackendError && error.code === "OUTBOX_CONFLICT") throw error;
      throw new BackendError("OUTBOX_UNAVAILABLE", "The recovery draft could not be saved; no command was sent", 503);
    }
  }

  function readOutbox() {
    const saved = synchronous(outbox.read());
    return saved == null ? null : validatePending(saved);
  }

  function clearMatchingDraft(original) {
    const saved = readOutbox();
    requireThat(saved === null || sameDraft(saved, original), "OUTBOX_CONFLICT",
      "A different recovery draft must not be cleared by this acknowledgement", 409);
    if (saved !== null) synchronous(outbox.write(null));
    requireThat(readOutbox() === null, "OUTBOX_UNAVAILABLE", "The confirmed recovery draft could not be cleared", 503);
  }

  function sameDraft(left, right) {
    return stableJson(left) === stableJson(right);
  }

  function settleDefiniteUncommitted(original) {
    recoveryStatus = "rejected-uncommitted-outbox-pending";
    try {
      clearMatchingDraft(original);
      pending = null;
      recoveryStatus = null;
      commitConfirmed = false;
    } catch (clearError) {
      // No server commit occurred, but the retained draft still blocks new work
      // until its exact account-scoped outbox can be cleared safely.
      throw clearError;
    }
  }

  async function sendPending() {
    let original = pending;
    persistPending(); // Also re-saves a draft whose previous outbox write failed.
    if (!commitConfirmed) recoveryStatus = "awaiting-confirmation";
    let data;
    let requiresReplayReceipt = false;
    try { data = await post(original); }
    catch (error) {
      if (isDurableRace(error)) {
        try {
          data = await request(`/receipts/${encodeURIComponent(original.command.request_id)}`, {
            binding: original.accountBinding,
          });
          requiresReplayReceipt = true;
        } catch (lookupError) {
          if (lookupError?.code === "NOT_FOUND" && lookupError?.status === 404) {
            settleDefiniteUncommitted(original);
            throw error;
          }
          // Auth/account changes, unavailable receipt storage and malformed
          // responses preserve the original draft for a later exact recovery.
          throw lookupError;
        }
      } else if (isDefiniteUncommittedRejection(error, original)) {
        settleDefiniteUncommitted(original);
        throw error;
      } else {
        if (error.code !== "IDEMPOTENCY_CONFLICT" || error.status !== 409) throw error;
        // The same tool intent can be repeated after its outbox was cleared or
        // after a reload. Recover only an existing receipt's original revision.
        // A network error or stale write never takes this path. No result from
        // this read is exposed until the full-envelope fingerprint is rechecked.
        const known = await request(`/receipts/${encodeURIComponent(original.command.request_id)}`, {
          binding: original.accountBinding,
        });
        if (!isRevision(known.durable_revision) || known.durable_revision < 1 ||
            known.result?.receipt?.idempotency_key !== original.command.request_id ||
            known.result.receipt.replayed !== true) throw malformed();
        const expectedRevision = known.durable_revision - 1;
        if (expectedRevision === original.command.expected_revision) throw error;
        const recovered = { ...clone(original), command: { ...clone(original.command), expected_revision: expectedRevision } };
        pending = recovered;
        // A write or readback can fail after replacement already reached disk.
        // Retain both allowed versions until persistence is confirmed; never
        // strand retry against a predecessor of our own saved recovery draft.
        outboxPredecessor = original;
        persistPending(original);
        original = recovered;
        data = await post(original); // Same operation/args/binding; strong server check.
      }
    }
    const receipt = data.result?.receipt;
    if (!isRevision(data.durable_revision) || data.durable_revision !== original.command.expected_revision + 1 ||
        !isObject(data.result) || !isObject(receipt) ||
        receipt.idempotency_key !== original.command.request_id || typeof receipt.replayed !== "boolean") throw malformed();
    if (requiresReplayReceipt && receipt.replayed !== true) {
      throw new BackendError("INVALID_SERVER_RESPONSE",
        "The receipt lookup did not confirm a replay; keep and retry the exact recovery draft", 502);
    }
    if (original.command.operation === "set_deck_archived") {
      validateArchiveSuccess(data.result, original.command.args, original.command.request_id);
    }
    rememberRevision(original.accountBinding, data.durable_revision);
    commitConfirmed = true;
    recoveryStatus = "committed-outbox-pending";
    try {
      clearMatchingDraft(original);
      pending = null;
      recoveryStatus = null;
      commitConfirmed = false;
    } catch {
      // The server commit is known. Keep the exact draft available for replay,
      // block new commands, and resolve with the original canonical result.
    }
    return data.result;
  }

  function post(draft) {
    return request("/commands", {
      method: "POST", binding: draft.accountBinding, body: draft.command,
      writer: STUDY_WRITE_OPERATIONS.has(draft.command.operation),
    });
  }

  function startSending(work) {
    sending = true;
    const promise = work();
    inFlight = promise;
    const done = () => { if (inFlight === promise) { sending = false; inFlight = null; } };
    promise.then(done, done);
    return promise;
  }

  async function command(operation, args = {}) {
    requireOriginalAccount();
    requireThat(Object.hasOwn(WRITE_METHODS, operation), "OPERATION_NOT_ALLOWED", "Unsupported command operation");
    const captured = clone(assertJson(args));
    object(captured, "args");
    const requestId = actionIdentity(operation, captured);
    text(requestId, "action identity");
    requestIdentity(requestId);
    if (pending) {
      requireThat(pending.command.operation === operation && sameDraft(pending.command.args, captured),
        "PENDING_COMMAND", "Recover the original pending action before starting another", 409);
      if (sending) {
        const replayed = clone(await inFlight);
        replayed.receipt.replayed = true;
        return replayed;
      }
      return retryPending();
    }
    requireThat(!sending, "PENDING_COMMAND", "The original action is already being sent", 409);
    requireThat(accountBinding !== null, "STATE_NOT_LOADED",
      "Load the authenticated learner before constructing a write action", 409);
    pending = {
      accountBinding,
      command: { request_id: requestId, expected_revision: durableRevision, operation, args: captured },
    };
    commitConfirmed = false;
    recoveryStatus = "not-sent";
    return startSending(sendPending);
  }

  async function retryPending() {
    requireOriginalAccount();
    requireThat(!sending, "PENDING_COMMAND", "The original action is already being sent", 409);
    requireThat(pending, "NO_PENDING_COMMAND", "There is no saved action to retry", 409);
    return startSending(async () => {
      const current = await load();
      requireThat(current.account_binding === pending.accountBinding, "ACCOUNT_CHANGED",
        "Sign in to the original account before retrying this preserved action", 409);
      // Keep original expected_revision even if load saw a later revision:
      // the server checks durable replay before checking stale revisions.
      return sendPending();
    });
  }

  const client = { load, query, command, retryPending, getPending };
  for (const [operation, method] of Object.entries(READ_METHODS)) client[method] = (args) => query(operation, args);
  for (const [operation, method] of Object.entries(WRITE_METHODS)) client[method] = (args) => command(operation, args);
  return Object.freeze(client);
}

function validateWriterGrant(value) {
  exactKeys(value, ["writerEpoch", "token"]);
  revision(value.writerEpoch, "writer epoch");
  requireThat(value.writerEpoch >= 1, "CLIENT_CONFIGURATION", "A positive writer epoch is required");
  requireThat(typeof value.token === "string" && /^[a-f0-9]{64}$/.test(value.token),
    "CLIENT_CONFIGURATION", "A 32-byte lowercase-hex writer token is required");
  return Object.freeze(clone(value));
}

function validatePending(value) {
  exactKeys(value, ["accountBinding", "command"]);
  text(value.accountBinding, "saved account binding");
  const command = value.command;
  exactKeys(command, ["request_id", "expected_revision", "operation", "args"]);
  text(command.request_id, "saved action identity");
  requestIdentity(command.request_id);
  revision(command.expected_revision);
  requireThat(Object.hasOwn(WRITE_METHODS, command.operation), "INVALID_INPUT", "Saved action operation is unsupported");
  assertJson(command.args);
  object(command.args, "saved action args");
  const id = actionIdentity(command.operation, command.args);
  requireThat(id === command.request_id, "REQUEST_ID_MISMATCH", "Saved request identity does not match its action");
  return clone(value);
}

function isDefiniteUncommittedRejection(error, draft) {
  if (!(error?.status >= 400 && error?.status < 500)) return false;
  if (draft?.command?.operation === "set_deck_archived") {
    return TERMINAL_UNCOMMITTED_ARCHIVE_CODES.has(error?.code);
  }
  return STUDY_WRITE_OPERATIONS.has(draft?.command?.operation) &&
    TERMINAL_UNCOMMITTED_STUDY_CODES.has(error?.code);
}

function isDurableRace(error) {
  return error?.code === "STALE_DURABLE_REVISION"
    && error?.status === 409;
}

function validateArchiveSuccess(result, args, requestId) {
  const deck = result.deck;
  const effect = result.visible_effect;
  const receipt = result.receipt;
  const expectedEffect = args.archived ? "deck_archived" : "deck_restored";
  const valid = isObject(deck)
    && deck.id === args.deck_id
    && deck.archived === args.archived
    && isRevision(deck.revision)
    && deck.revision === args.expected_revision + 1
    && isObject(effect)
    && effect.type === expectedEffect
    && effect.deck_id === args.deck_id
    && isRevision(result.app_revision)
    && isRevision(receipt.previous_app_revision)
    && receipt.previous_app_revision + 1 === result.app_revision
    && receipt.app_revision === result.app_revision
    && receipt.operation === "set_deck_archived"
    && receipt.client_action_id === requestId
    && receipt.transaction_id === `durable-archive:${requestId}`;
  requireThat(valid, "INVALID_SERVER_RESPONSE",
    "The Archive response did not match the preserved request; keep and retry the exact recovery draft", 502);
}

function actionIdentity(operation, args) {
  return ["add_library_deck", "set_deck_archived"].includes(operation)
    ? args.client_action_id
    : args.idempotency_key;
}

function synchronous(value) {
  if (value && typeof value.then === "function") {
    // Observe a rejected nonconforming outbox promise without awaiting it or
    // treating it as a successful durable draft write.
    Promise.resolve(value).catch(() => {});
    throw new BackendError("OUTBOX_UNAVAILABLE", "Recovery storage must be synchronous", 503);
  }
  return value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
}

function malformed() {
  return new BackendError("MALFORMED_RESPONSE", "The server reply did not confirm the expected contract; preserve the original recovery draft", 502);
}
