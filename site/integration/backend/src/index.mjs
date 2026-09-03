// Server entry point. Supply canonical runtime exports, a D1 binding, and the
// Accounts authenticator explicitly; nothing initializes or deploys itself.
export { createD1Repository } from "./d1-repository.mjs";
export { createCanonicalEngine } from "./canonical-engine.mjs";
export { createLearnerService } from "./learner-service.mjs";
export { createLearnerHandler } from "./http-handler.mjs";
export { BackendError } from "./contracts.mjs";
