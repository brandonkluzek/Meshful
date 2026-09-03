import { createDurableClient as createV1Client } from "../../src/durable-client.mjs";
import { WRITE_METHODS } from "../../src/canonical-engine.mjs";
import { requestIdentity } from "./request-identity.mjs";

// Keep the already-qualified v1 retry/outbox/account state machine unchanged.
// Adapt compact snapshots and opaque request-key transport around that one
// state machine. The browser parses its state copy; the Worker sends one copy.
export function createDurableClient({ fetchImpl = globalThis.fetch, baseUrl = "/api/learner/v2", outbox } = {}) {
  const prefix = baseUrl.replace(/\/+$/, "");
  const stateUrl = `${prefix}/state`;
  const receiptPrefix = `${prefix}/receipts/`;
  const client = createV1Client({ baseUrl, outbox, fetchImpl: async (url, options) => {
    // Dot-only request IDs are valid opaque keys but normalize as URL path
    // segments. Keep the frozen retry state machine; transport the encoded key
    // in an exact query parameter before URL normalization can change it.
    const transportUrl = options.method === "GET" && url.startsWith(receiptPrefix)
      ? `${prefix}/receipts?request_id=${url.slice(receiptPrefix.length)}` : url;
    const response = await fetchImpl(transportUrl, options);
    if (url !== stateUrl || options.method !== "GET") return response;
    return { ok: response.ok, status: response.status, async json() {
      const payload = await response.json();
      const data = payload?.data;
      if (response.ok && payload?.ok === true && data?.snapshot_encoding === "canonical-json.v1" &&
          (data.state_json === null || typeof data.state_json === "string") && !Object.hasOwn(data, "state")) {
        return { ...payload, data: { ...data, state: data.state_json === null ? null : JSON.parse(data.state_json) } };
      }
      return payload; // v1 handles malformed/auth/error responses, unchanged.
    } };
  } });
  // Deterministic transport admission only. There is still exactly one v1
  // retry/outbox implementation, including its already-pending draft recovery.
  const command = async (operation, args = {}) => {
    requestIdentity(operation === "add_library_deck" ? args.client_action_id : args.idempotency_key);
    return client.command(operation, args);
  };
  const wrapped = { ...client, command, async retryPending() {
    const pending = client.getPending();
    if (pending) requestIdentity(pending.command.request_id);
    return client.retryPending();
  } };
  for (const [operation, method] of Object.entries(WRITE_METHODS)) wrapped[method] = (args) => command(operation, args);
  return Object.freeze(wrapped);
}
