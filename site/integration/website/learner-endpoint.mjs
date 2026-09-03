// Website-owned server composition seam. No database binding, provisioning or
// header-based trust inference occurs in the default-denied configuration.
const disabled = () => Response.json({ ok: false, error: { code: "ACCOUNT_SYNC_DISABLED",
  message: "Account-backed storage is not enabled for this build." } }, {
  status: 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

export function createPrivateLearnerEndpoint({ backend, accounts, createStudyStore, createMemoryStorage,
  toolSchemas, createCatalogResolver, expectedCatalogPins, expectedResolutionBudget,
  database, activation = null } = {}) {
  let handler;
  const canCompose = () => Boolean(database) &&
    typeof createCatalogResolver === "function" &&
    typeof activation?.resolveTrustedSitesRequest === "function";
  async function compose() {
    // Dependencies are injected from the exact admitted Backend/Accounts bytes,
    // not copied rules or a second implementation of command/grade scheduling.
    const catalogResolver = await createCatalogResolver();
    const engine = await backend.createCanonicalEngine({ createStudyStore, createMemoryStorage, toolSchemas,
      catalogResolver, expectedCatalogPins, expectedResolutionBudget });
    const service = backend.createLearnerService({ repository: backend.createD1Repository(database), engine });
    const authenticate = accounts.createTrustedSitesAuthenticator({
      siteId: activation.siteId, allowedOrigins: activation.allowedOrigins,
      resolveTrustedSitesRequest: activation.resolveTrustedSitesRequest,
      allowProvisioning: activation.allowProvisioning === true,
      findPrincipalByIdentity: service.findPrincipalByIdentity,
      provisionPrincipalForVerifiedIdentity: service.provisionPrincipalForVerifiedIdentity,
    });
    return backend.createLearnerHandler({ service, authenticate,
      authenticationFailureResponse: accounts.authFailureResponse, browserOrigins: activation.allowedOrigins });
  }
  return Object.freeze({
    async handle(request) {
      if (!canCompose()) return disabled();
      if (!handler) handler = compose().catch((error) => { handler = null; throw error; });
      try { return await (await handler)(request); }
      catch { return disabled(); } // No exception data or automatic local fallback.
    },
    // The endpoint never selects browser mode from request data. The generated
    // server page owns that decision from its authenticated request context and
    // binding availability; legacy callers retain this fail-closed result.
    async canSelectAccountEntry() { return false; },
  });
}
