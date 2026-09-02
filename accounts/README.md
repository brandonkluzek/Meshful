# Meshful Accounts boundary

Isolated identity adapters, access guards, and a browser-only account storage
controller. Not installed in the competition runtime. Backend owns persistence; Website alone owns integration
and Sites deployment. No provider account, token issuer or linking flow is
created here. See [the agreed contract](../docs/accounts-privacy/IDENTITY_CONTRACT.md).

The browser-storage successor is documented in
[BROWSER_STORAGE_HANDOFF.md](../docs/accounts-privacy/BROWSER_STORAGE_HANDOFF.md).
Import `browser-storage.mjs` directly in browser code. It supplies native
cross-tab leases, fixed-account outboxes, auth-epoch invalidation, and separate
cache/immutable claim recovery slots without duplicating Backend's client.
The original `browser-state.mjs` fence and all server auth modules are unchanged.

Before integration, verify the exact admitted files:

```sh
node accounts/checks/verify-delivery.mjs
```

Run that command from the delivery root (or use the script's absolute path).
It is read-only, needs no dependencies and checks all listed sizes/SHA-256
digests. The manifest excludes its own hash and the installed dependency/cache
directories. It is not a digital signature or an independent provenance audit.

Run the provider-free tests with Node 22.13 or later:

```sh
npm test
```

Use the already installed dependencies for this low-disk checkout. A fresh
installation, when separately appropriate, needs the pinned `jose` dependency
and contacts npm; no installation was performed for the browser successor.
Tests use synthetic local keys and data; no real credentials are needed.

The server entry is `index.mjs`. Example composition, using server-owned values
and Backend hooks only:

```js
const authenticate = createSitesAuthenticator({
  siteId: trustedDeployment.projectId,
  allowedOrigins: ['https://meshful.ai'],
  isTrustedIngress: verifiedSitesIngress,
  findPrincipalByIdentity: backend.findPrincipalByIdentity.bind(backend),
  // First-sign-in provisioning needs a separately enabled, reviewed flow.
  allowProvisioning: false,
});

// Inject authenticate into Backend's learner HTTP handler. It must run before
// parsing/acting on private learner input. Never replace verifiedSitesIngress
// with a check of caller-controlled headers/Host or an unconditional true.
```

`verifiedSitesIngress` is intentionally not implemented or asserted by this
module: Website must establish the real dispatcher-only trust boundary. Missing
proof means keep this path disabled, not invent a production bypass.

For the original standalone fence, import `browser-state.mjs` directly, never
the server entry. It alone does not partition storage. The successor controller
wraps that unchanged fence and supplies the account-scoped storage boundary.
Website still owns actual DOM/timer invalidation, fresh authenticated discovery,
durable-client creation and all hydration/tool sinks. Neither helper authenticates
a caller, auto-imports legacy local decks, encrypts local data, or protects it
from another person/script using the same browser profile/origin.

Sites server routes may import `sites.mjs` and `core.mjs` directly; they do not
need to import the disabled remote adapter or `jose` into that route.

Both transports produce the agreed server-only context. `AuthError` exposes
sanitized `status` and `code`; `authFailureResponse` produces no-store HTTP
errors, and `mcpAuthFailure` can produce the documented remote OAuth challenge.
Backend remains responsible for private success responses, SQL isolation,
input validation, idempotency and lifecycle behavior. Never serialize contexts,
credentials or internal errors into learner responses.
