import { BackendError, assertJson, requireThat } from "./contracts.mjs";

const RESPONSE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store, max-age=0",
  "pragma": "no-cache", "x-content-type-options": "nosniff",
  "vary": "Cookie, Authorization, Origin",
};

async function readJson(request, maxBytes) {
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  requireThat(type === "application/json", "UNSUPPORTED_MEDIA_TYPE", "Use application/json", 415);
  const length = request.headers.get("content-length");
  if (length !== null) requireThat(/^\d+$/.test(length) && Number(length) <= maxBytes,
    "INPUT_TOO_LARGE", "Request body exceeds this rollout's limit", 413);
  requireThat(request.body, "INVALID_INPUT", "A JSON request body is required");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new BackendError("INPUT_TOO_LARGE", "Request body exceeds this rollout's limit", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  try { return assertJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data))); }
  catch (error) {
    if (error instanceof BackendError) throw error;
    throw new BackendError("INVALID_INPUT", "Request body must contain valid JSON");
  }
}

function errorStatus(error) {
  if (error instanceof BackendError) return error.status;
  if (["UNAUTHENTICATED", "AUTH_REQUIRED"].includes(error?.code)) return 401;
  if (["FORBIDDEN", "IDENTITY_UNBOUND"].includes(error?.code)) return 403;
  if (/NOT_FOUND$/.test(error?.code ?? "")) return 404;
  if (/^(STALE_|ACTIVE_SESSION|CARD_MISMATCH|INVALID_SESSION_PHASE|CATALOG_BASE_UNAVAILABLE|IDEMPOTENCY_)/.test(error?.code ?? "")) return 409;
  if (/^(INVALID_|CORRUPT_|UNKNOWN_|DECK_VALIDATION|RUBRIC_|MISSING_|CARD_)/.test(error?.code ?? "")) return 400;
  return 503;
}

// Mount inside Website's server route. authenticate comes only from Accounts.
// No fallback reads of identity headers, body fields, emails, or bearer tokens.
export function createLearnerHandler({
  service, authenticate, authenticationFailureResponse,
  browserOrigins = [], prefix = "/api/learner/v1", maxBodyBytes = 2_000_000,
}) {
  requireThat(service && typeof authenticate === "function", "AUTH_ADAPTER_REQUIRED",
    "A verified Accounts authenticate(request) closure is required", 503);
  const origins = new Set(browserOrigins.map((origin) => {
    const url = new URL(origin);
    requireThat(url.origin === origin && ["https:", "http:"].includes(url.protocol),
      "CONFIGURATION_ERROR", "Use exact configured browser origins", 503);
    return origin;
  }));
  return async function handle(request) {
    let context;
    try { context = await authenticate(request); }
    catch (error) {
      // Accounts owns its fixed sanitized AuthError map, including 401/403.
      // This callback sees only authentication errors, never SQL/engine errors.
      if (authenticationFailureResponse) {
        const response = authenticationFailureResponse(error);
        if (response instanceof Response) return response;
      }
      return new Response(JSON.stringify({ ok: false, error: {
        code: "AUTHENTICATION_UNAVAILABLE", message: "Authentication could not be verified", retryable: false,
      } }), { status: 401, headers: RESPONSE_HEADERS });
    }
    try {
      requireThat(context, "UNAUTHENTICATED", "Sign in is required", 401);
      const url = new URL(request.url);
      const path = url.pathname;
      requireThat(path.startsWith(`${prefix}/`), "NOT_FOUND", "Endpoint not found", 404);
      if (context.transport === "sites-browser") {
        const origin = request.headers.get("origin");
        requireThat(request.headers.get("sec-fetch-site") !== "cross-site" &&
          (origin === null || origins.has(origin)), "ORIGIN_REJECTED", "Cross-origin learner requests are not allowed", 403);
        if (request.method === "POST") requireThat(origin !== null && origins.has(origin),
          "ORIGIN_REJECTED", "A configured same-origin browser request is required", 403);
      }
      if (request.method === "POST" || request.headers.has("x-meshful-account")) {
        // An account-change guard, never an ownership selector. This prevents a
        // persisted command or receipt recovery for learner A from being sent
        // as newly signed-in B. State bootstrap may omit the assertion.
        requireThat(request.headers.get("x-meshful-account") === context.principalId,
          "ACCOUNT_CHANGED", "Reload after sign-in before sending this saved action", 409);
      }
      let result;
      if (request.method === "GET" && path === `${prefix}/state`) result = await service.getState(context);
      else if (request.method === "POST" && path === `${prefix}/commands`) result = await service.command(context, await readJson(request, maxBodyBytes));
      else if (request.method === "POST" && path === `${prefix}/queries`) result = await service.query(context, await readJson(request, maxBodyBytes));
      else if (request.method === "POST" && path === `${prefix}/claims`) result = await service.claimLocalState(context, await readJson(request, maxBodyBytes));
      else if (request.method === "GET" && path === `${prefix}/reviews`) {
        requireThat([...url.searchParams.keys()].every((key) => ["after_revision", "limit"].includes(key)),
          "INVALID_INPUT", "Unsupported review query parameter");
        result = await service.listReviews(context, {
          afterRevision: Number(url.searchParams.get("after_revision") ?? 0),
          limit: Number(url.searchParams.get("limit") ?? 100),
        });
      } else if (request.method === "GET" && path.startsWith(`${prefix}/receipts/`)) {
        result = await service.getReceipt(context, decodeURIComponent(path.slice(`${prefix}/receipts/`.length)));
      } else if (request.method === "GET" && path.startsWith(`${prefix}/imports/`)) {
        result = await service.getImportArchive(context, decodeURIComponent(path.slice(`${prefix}/imports/`.length)));
      } else throw new BackendError("NOT_FOUND", "Endpoint not found", 404);
      return new Response(JSON.stringify({ ok: true, data: result }), { status: 200, headers: RESPONSE_HEADERS });
    } catch (error) {
      const status = errorStatus(error);
      const known = error instanceof BackendError || (typeof error?.code === "string" && status < 500);
      return new Response(JSON.stringify({ ok: false, error: {
        code: known ? error.code : "SERVICE_UNAVAILABLE",
        message: error instanceof BackendError ? error.message :
          (status < 500 ? "The authenticated request did not satisfy the learner contract" : "Storage is unavailable; preserve and retry the identical request"),
        retryable: status === 503,
      } }), { status, headers: RESPONSE_HEADERS });
    }
  };
}
