import { BackendError, assertJson, requireThat } from "../../src/contracts.mjs";
import { MAX_COMMAND_NODES, MAX_HTTP_BODY_BYTES } from "../../v2/src/capacity.mjs";
import { assertJsonTextBudget } from "../../v2/src/json-budget.mjs";

const HEADERS = {
  "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache", "x-content-type-options": "nosniff", vary: "Cookie, Authorization, Origin",
};
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });

// Workers share the isolate memory ceiling across concurrent requests. Keep a
// single active learner request through body parsing, canonical execution,
// durable commit and response encoding. Reject excess work before reading its
// body; never queue several multi-MB parsed requests inside this isolate.
// A Worker routes all learner requests through this one module singleton.
let active = false;

async function readJson(request, maxBytes) {
  requireThat(request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json",
    "UNSUPPORTED_MEDIA_TYPE", "Use application/json", 415);
  const length = request.headers.get("content-length");
  if (length !== null) requireThat(/^\d+$/.test(length) && Number(length) <= maxBytes,
    "INPUT_TOO_LARGE", "Request body exceeds the qualified transport envelope", 413);
  requireThat(request.body, "INVALID_INPUT", "A JSON body is required");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new BackendError("INPUT_TOO_LARGE", "Request body exceeds the qualified transport envelope", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // A byte ceiling alone still admits millions of small values. Count tokens
    // before JSON.parse creates their object tree, including on untrusted POSTs.
    try { assertJsonTextBudget(decoded, { maxNodes: MAX_COMMAND_NODES }); }
    catch (error) {
      if (error instanceof BackendError && error.status === 413) throw new BackendError("INPUT_TOO_LARGE", "JSON request exceeds the qualified node or nesting budget", 413);
      throw new BackendError("INVALID_INPUT", "Request body must contain valid JSON");
    }
    return assertJson(JSON.parse(decoded), { maxNodes: MAX_COMMAND_NODES });
  }
  catch (error) {
    if (error instanceof BackendError) throw error;
    throw new BackendError("INVALID_INPUT", "Request body must contain valid JSON");
  }
}

function errorStatus(error) {
  if (error instanceof BackendError) return error.status;
  if (error?.code === "SERVICE_BUSY") return 503;
  if (/NOT_FOUND$/.test(error?.code ?? "")) return 404;
  if (error?.code === "LIBRARY_RESOLUTION_LIMIT_EXCEEDED") return 409;
  if (/^(STALE_|ACTIVE_SESSION|DECK_IN_ACTIVE_SESSION|CARD_MISMATCH|INVALID_SESSION_PHASE|CATALOG_BASE_UNAVAILABLE|IDEMPOTENCY_|LIBRARY_DEPENDENCY_|PREREQUISITE_NOT_SATISFIED$)/.test(error?.code ?? "")) return 409;
  if (/^(INVALID_|CORRUPT_|UNKNOWN_|DECK_VALIDATION|RUBRIC_|MISSING_|CARD_)/.test(error?.code ?? "")) return 400;
  return 503;
}
function failure(error) {
  const status = errorStatus(error);
  const knownTransient = error?.code === "SERVICE_BUSY";
  const known = error instanceof BackendError || knownTransient || (typeof error?.code === "string" && status < 500);
  return jsonResponse({ ok: false, error: {
    code: known ? error.code : "SERVICE_UNAVAILABLE",
    message: error instanceof BackendError ? error.message : knownTransient
      ? "Library storage is temporarily unavailable; preserve and retry the identical request"
      : (status < 500
      ? "The authenticated request did not satisfy the learner contract"
      : "Storage is unavailable; preserve and retry the identical request"),
    retryable: status === 503,
  } }, status);
}

export function createLearnerHandler({ service, authenticate, authenticationFailureResponse,
  browserOrigins = [], prefix = "/api/learner/v2", maxBodyBytes = MAX_HTTP_BODY_BYTES }) {
  requireThat(service && typeof authenticate === "function", "AUTH_ADAPTER_REQUIRED", "A verified Accounts authenticate(request) closure is required", 503);
  requireThat(Number.isSafeInteger(maxBodyBytes) && maxBodyBytes > 0 && maxBodyBytes <= MAX_HTTP_BODY_BYTES,
    "CONFIGURATION_ERROR", "Requalify before increasing the transport body budget", 503);
  const origins = new Set(browserOrigins.map((origin) => {
    const url = new URL(origin);
    requireThat(url.origin === origin && ["http:", "https:"].includes(url.protocol), "CONFIGURATION_ERROR", "Use exact browser origins", 503);
    return origin;
  }));
  return async function handle(request) {
    if (active) return failure(new BackendError("SERVICE_BUSY", "Another request is using this isolate's qualified working set. Preserve and retry the identical request", 503));
    active = true;
    try {
      let context;
      try { context = await authenticate(request); }
      catch (error) {
        // Only the trusted authenticate boundary may use Accounts' sanitizer.
        // Never echo arbitrary SQL/engine exception status or exception text.
        if (authenticationFailureResponse) {
          const response = authenticationFailureResponse(error);
          if (response instanceof Response) return response;
        }
        return jsonResponse({ ok: false, error: { code: "AUTHENTICATION_UNAVAILABLE", message: "Authentication could not be verified", retryable: false } }, 401);
      }
      requireThat(context, "UNAUTHENTICATED", "Sign in is required", 401);
      const url = new URL(request.url);
      const path = url.pathname;
      requireThat(path.startsWith(`${prefix}/`), "NOT_FOUND", "Endpoint not found", 404);
      if (context.transport === "sites-browser") {
        const origin = request.headers.get("origin");
        requireThat(request.headers.get("sec-fetch-site") !== "cross-site" && (origin === null || origins.has(origin)),
          "ORIGIN_REJECTED", "Cross-origin learner requests are not allowed", 403);
        if (request.method === "POST") requireThat(origin !== null && origins.has(origin), "ORIGIN_REJECTED", "A configured same-origin request is required", 403);
      }
      if (request.method === "POST" || request.headers.has("x-meshful-account")) requireThat(request.headers.get("x-meshful-account") === context.principalId,
        "ACCOUNT_CHANGED", "This saved action belongs to another account; preserve its original binding", 409);
      let result;
      if (request.method === "GET" && path === `${prefix}/state`) result = await service.getState(context);
      else if (request.method === "POST" && path === `${prefix}/commands`) result = await service.command(context, await readJson(request, maxBodyBytes));
      else if (request.method === "POST" && path === `${prefix}/queries`) result = await service.query(context, await readJson(request, maxBodyBytes));
      else if (request.method === "POST" && path === `${prefix}/claims`) result = await service.claimLocalState(context, await readJson(request, maxBodyBytes));
      else if (request.method === "GET" && path === `${prefix}/reviews`) {
        requireThat([...url.searchParams.keys()].every((key) => ["after_revision", "limit"].includes(key)), "INVALID_INPUT", "Unsupported review query parameter");
        result = await service.listReviews(context, { afterRevision: Number(url.searchParams.get("after_revision") ?? 0), limit: Number(url.searchParams.get("limit") ?? 100) });
      } else if (request.method === "GET" && path === `${prefix}/recovery`) {
        requireThat(url.search === "", "INVALID_INPUT", "Recovery head has no query parameters");
        result = await service.getRecoveryHead(context);
      } else if (request.method === "GET" && path.startsWith(`${prefix}/documents/`)) {
        requireThat([...url.searchParams.keys()].every((key) => ["after_part", "limit"].includes(key)), "INVALID_INPUT", "Unsupported recovery query parameter");
        result = await service.getDocumentParts(context, decodeURIComponent(path.slice(`${prefix}/documents/`.length)), {
          afterPart: Number(url.searchParams.get("after_part") ?? -1), limit: Number(url.searchParams.get("limit") ?? 16),
        });
      } else if (request.method === "GET" && path === `${prefix}/receipts`) {
        requireThat([...url.searchParams.keys()].every((key) => key === "request_id") && url.searchParams.getAll("request_id").length === 1,
          "INVALID_INPUT", "Specify exactly one request_id");
        result = await service.getReceipt(context, url.searchParams.get("request_id"));
      } else if (request.method === "GET" && path === `${prefix}/imports`) {
        requireThat([...url.searchParams.keys()].every((key) => key === "source_id") && url.searchParams.getAll("source_id").length === 1,
          "INVALID_INPUT", "Specify exactly one source_id");
        result = await service.getImportArchive(context, url.searchParams.get("source_id"));
      } else if (request.method === "GET" && path.startsWith(`${prefix}/receipts/`)) result = await service.getReceipt(context, decodeURIComponent(path.slice(`${prefix}/receipts/`.length)));
      else if (request.method === "GET" && path.startsWith(`${prefix}/imports/`)) result = await service.getImportArchive(context, decodeURIComponent(path.slice(`${prefix}/imports/`.length)));
      else throw new BackendError("NOT_FOUND", "Endpoint not found", 404);
      return jsonResponse({ ok: true, data: result });
    } catch (error) { return failure(error); }
    finally { active = false; }
  };
}
