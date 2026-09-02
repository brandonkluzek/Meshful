// Website-owned server composition seam. No database binding, provisioning or
// header-based trust inference occurs in the default-denied configuration.
const disabled = () => Response.json({ ok: false, error: { code: "ACCOUNT_SYNC_DISABLED",
  message: "Account-backed storage is not enabled for this build." } }, {
  status: 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

export function createPrivateLearnerEndpoint({ backend, accounts, createStudyStore, createMemoryStorage,
  toolSchemas, catalogReleases, defaultCatalogVersion, database, activation = null } = {}) {
  let handler;
  async function trusted(request) {
    if (!activation || typeof activation.isTrustedIngress !== "function") return false;
    try { return await activation.isTrustedIngress(request) === true; } catch { return false; }
  }
  async function compose() {
    // Dependencies are injected from the exact admitted Backend/Accounts bytes,
    // not copied rules or a second implementation of command/grade scheduling.
    const engine = await backend.createCanonicalEngine({ createStudyStore, createMemoryStorage, toolSchemas,
      catalogs: catalogReleases, defaultCatalogVersion });
    const service = backend.createLearnerService({ repository: backend.createD1Repository(database), engine });
    const authenticate = accounts.createSitesAuthenticator({
      siteId: activation.siteId, allowedOrigins: activation.allowedOrigins,
      isTrustedIngress: activation.isTrustedIngress,
      allowProvisioning: activation.allowProvisioning === true,
      findPrincipalByIdentity: service.findPrincipalByIdentity,
      provisionPrincipalForVerifiedIdentity: service.provisionPrincipalForVerifiedIdentity,
    });
    return backend.createLearnerHandler({ service, authenticate,
      authenticationFailureResponse: accounts.authFailureResponse, browserOrigins: activation.allowedOrigins });
  }
  return Object.freeze({
    async handle(request) {
      if (!await trusted(request) || !database) return disabled();
      if (!handler) handler = compose().catch((error) => { handler = null; throw error; });
      try { return await (await handler)(request); }
      catch { return disabled(); } // No exception data or automatic local fallback.
    },
    async canSelectAccountEntry(request) { return Boolean(database) && await trusted(request); },
  });
}
