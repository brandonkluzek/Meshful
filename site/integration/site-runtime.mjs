// Private integration candidate. Public access remains unchanged.
import * as backend from "./backend/v7/src/index.mjs";
import { createTrustedSitesAuthenticator } from "./accounts/sites-trusted-request.mjs";
import { authFailureResponse } from "./accounts/core.mjs";
import { createPrivateLearnerEndpoint } from "./website/learner-endpoint.mjs";
import { createStudyStore, createMemoryStorage } from "./core/js/store.js";
import { WEBMCP_TOOL_SCHEMAS } from "./core/js/webmcp.js";
import {
  BACKEND_EXPECTED_CATALOG_PINS,
  LIBRARY_RESOLUTION_BUDGET,
  createReviewedLibraryResolver,
} from "./library-runtime.mjs";

export const accountSiteConfig = Object.freeze({
  siteId: "appgprj_6a9334b99f20819195ece80ebe97016b",
  allowedOrigins: Object.freeze(["https://meshful.ai"]),
  // Provisioning is default-off here. The generated server route may override
  // it only from the separately resolved server-owned release policy.
  allowProvisioning: false,
});

/**
 * @param {{ database?: unknown, assets?: unknown, activation?: unknown }} [options]
 */
export function createPreparedSiteEndpoint({ database = null, assets = null, activation = null } = {}) {
  let resolverPromise = null;
  return createPrivateLearnerEndpoint({
    backend, accounts: { createTrustedSitesAuthenticator, authFailureResponse },
    createStudyStore, createMemoryStorage, toolSchemas: WEBMCP_TOOL_SCHEMAS,
    createCatalogResolver: typeof assets?.fetch === "function" ? () => {
      if (!resolverPromise) {
        resolverPromise = createReviewedLibraryResolver(assets).catch((error) => {
          resolverPromise = null;
          throw error;
        });
      }
      return resolverPromise;
    } : null,
    expectedCatalogPins: BACKEND_EXPECTED_CATALOG_PINS,
    expectedResolutionBudget: LIBRARY_RESOLUTION_BUDGET,
    database,
    activation,
  });
}

// Test/local fallback. The Sites route injects env.DB separately, but neither
// path admits provisioning, ingress trust, or account entry selection. Database
// presence alone must never enable learner writes.
export const learnerEndpoint = createPreparedSiteEndpoint();
