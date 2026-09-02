// Server entry point. Client code may import browser-state.mjs only.
export {
  AuthError, LEARNER_SCOPES, assertLearnerScope, assertOwnedResource,
  authFailureResponse, mcpAuthFailure,
} from './core.mjs';
export { createSitesAuthenticator } from './sites.mjs';
export { createRemoteMcpAuthenticator, protectedResourceMetadata } from './remote.mjs';
export { PRODUCT_VIEWS, createAccountStateFence, describePersistence } from './browser-state.mjs';
