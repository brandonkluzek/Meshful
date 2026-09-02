import * as backend from '../../backend/v2/src/index.mjs';
import { createSitesAuthenticator } from '../../accounts/sites.mjs';
import { authFailureResponse } from '../../accounts/core.mjs';
import { createPrivateLearnerEndpoint } from '../../web/integration/learner-endpoint.mjs';
import { createStudyStore, createMemoryStorage } from '../../web/js/store.js';
import { WEBMCP_TOOL_SCHEMAS } from '../../web/js/webmcp.js';
import { CATALOG } from '../../web/data/catalog.js';
import { catalogRelease } from './catalog-release.mjs';

export const SITE_ID = 'appgprj_6a9334b99f20819195ece80ebe97016b';
export const ACCOUNT_ACTIVATION_VALUE = 'enabled';

function exactHttpsOrigin(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) return null;
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
}

export function createPreparedSiteEndpoint({ database = null, activation = null } = {}) {
  return createPrivateLearnerEndpoint({
    backend,
    accounts: { createSitesAuthenticator, authFailureResponse },
    createStudyStore,
    createMemoryStorage,
    toolSchemas: WEBMCP_TOOL_SCHEMAS,
    catalogReleases: [{ ...catalogRelease, catalog: CATALOG }],
    defaultCatalogVersion: catalogRelease.version,
    database,
    activation,
  });
}

// The route supplies runtime provenance through a private WeakSet. Account
// activation additionally requires the real D1 binding, an exact hosted origin,
// and an explicit Sites runtime value. Missing/invalid configuration stays
// ACCOUNT_SYNC_DISABLED and never falls back to a signed-in local store.
export function createSiteRequestHandler({
  database = null,
  accountActivation = null,
  allowedOrigin = null,
} = {}) {
  const origin = exactHttpsOrigin(allowedOrigin);
  const trustedRequests = new WeakSet();
  const active = Boolean(database) && accountActivation === ACCOUNT_ACTIVATION_VALUE && origin !== null;
  const endpoint = createPreparedSiteEndpoint({
    database: active ? database : null,
    activation: active
      ? {
          siteId: SITE_ID,
          allowedOrigins: [origin],
          isTrustedIngress: (request) => trustedRequests.has(request),
          allowProvisioning: true,
        }
      : null,
  });

  return Object.freeze({
    active,
    async handle(request) {
      if (active) trustedRequests.add(request);
      return endpoint.handle(request);
    },
  });
}
