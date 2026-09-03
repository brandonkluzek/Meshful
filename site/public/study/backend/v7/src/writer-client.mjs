import { BackendError, clone, exactKeys, requireThat, revision } from "../../src/contracts.mjs";
import { requestIdentity } from "../../v2/src/request-identity.mjs";

/**
 * Browser transport for the principal-scoped study-writer boundary. Accounts
 * owns retention and lifecycle of the token; this helper never writes storage
 * and never changes the immutable account binding.
 */
export function createStudyWriterClient({
  fetchImpl = globalThis.fetch,
  baseUrl = "/api/learner/v2",
  accountBinding,
} = {}) {
  requireThat(typeof fetchImpl === "function" && typeof baseUrl === "string" && baseUrl.length > 0,
    "CLIENT_CONFIGURATION", "A fetch implementation and API base URL are required");
  requireThat(typeof accountBinding === "string" && accountBinding.length > 0,
    "CLIENT_CONFIGURATION", "An immutable account binding is required");
  const prefix = baseUrl.replace(/\/+$/, "");

  async function request(path, { method = "GET", body, writerGrant } = {}) {
    const headers = { Accept: "application/json", "X-Meshful-Account": accountBinding };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (writerGrant) {
      const checked = validateWriterGrant(writerGrant);
      headers["X-Meshful-Writer-Epoch"] = String(checked.writerEpoch);
      headers["X-Meshful-Writer-Token"] = checked.token;
    }
    let response;
    try {
      response = await fetchImpl(`${prefix}${path}`, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        ...(body === undefined ? {} : { body: stable(body) }),
      });
    } catch {
      throw new BackendError("REQUEST_UNCONFIRMED",
        "The writer-boundary request was not confirmed; preserve and retry its exact input", 503);
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw malformed(); }
    if (!response.ok || payload?.ok !== true) {
      if (typeof payload?.error?.code === "string" && typeof payload.error?.message === "string") {
        throw new BackendError(payload.error.code, payload.error.message, response.status);
      }
      throw malformed();
    }
    requireThat(payload.data?.account_binding === accountBinding, "INVALID_SERVER_RESPONSE",
      "Writer response belongs to a different account", 502);
    return clone(payload.data);
  }

  async function status() {
    const result = await request("/writer-grant");
    validStatus(result);
    return result;
  }

  async function mutate(action, input) {
    requireThat(["acquire", "takeover", "release"].includes(action),
      "INVALID_INPUT", "Writer action must be acquire, takeover, or release");
    exactKeys(input, ["requestId", "expectedWriterEpoch", "token"]);
    requestIdentity(input.requestId);
    revision(input.expectedWriterEpoch, "expected writer epoch");
    const token = validToken(input.token);
    const body = {
      request_id: input.requestId,
      action,
      expected_writer_epoch: input.expectedWriterEpoch,
      grant_token: token,
    };
    const result = await request("/writer-grant", { method: "POST", body });
    validMutation(result, action, input.requestId);
    return { ...result, writerGrant: result.active
      ? Object.freeze({ writerEpoch: result.writer_epoch, token }) : null };
  }

  async function validate(writerGrant) {
    const result = await request("/writer-grant/validate", { method: "POST", writerGrant });
    requireThat(result?.schema_version === 1 && typeof result.current === "boolean",
      "INVALID_SERVER_RESPONSE", "Writer validation response is invalid", 502);
    validStatus(result);
    return result;
  }

  return Object.freeze({
    status,
    acquire: (input) => mutate("acquire", input),
    takeover: (input) => mutate("takeover", input),
    release: (input) => mutate("release", input),
    validate,
  });
}

export function generateWriterToken(cryptoImpl = globalThis.crypto) {
  requireThat(cryptoImpl && typeof cryptoImpl.getRandomValues === "function",
    "CLIENT_CONFIGURATION", "A cryptographically secure random source is required");
  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateWriterGrant(value) {
  exactKeys(value, ["writerEpoch", "token"]);
  revision(value.writerEpoch, "writer epoch");
  requireThat(value.writerEpoch >= 1, "INVALID_INPUT", "A positive writer epoch is required");
  return { writerEpoch: value.writerEpoch, token: validToken(value.token) };
}

function validToken(value) {
  requireThat(typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    "INVALID_INPUT", "Writer token must contain 32 random bytes encoded as lowercase hex");
  return value;
}

function validStatus(result) {
  requireThat(result?.schema_version === 1 && Number.isSafeInteger(result.writer_epoch)
    && result.writer_epoch >= 0 && typeof result.active === "boolean",
  "INVALID_SERVER_RESPONSE", "Writer status response is invalid", 502);
}

function validMutation(result, action, requestId) {
  validStatus(result);
  requireThat(result.action === action && result.receipt?.idempotency_key === requestId
    && typeof result.receipt.replayed === "boolean" && result.active === (action !== "release"),
  "INVALID_SERVER_RESPONSE", "Writer mutation response is invalid", 502);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function malformed() {
  return new BackendError("INVALID_SERVER_RESPONSE", "The writer response was not valid JSON", 502);
}
