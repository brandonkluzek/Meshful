// Prepared Next/vinext route: map to app/api/learner/[...path]/route.ts in
// the successor overlay and adjust only this relative import at packaging.
// Intentionally no database binding or production ingress predicate is admitted.
import { createPrivateLearnerEndpoint } from "./learner-endpoint.mjs";

const endpoint = createPrivateLearnerEndpoint();
export const GET = (request: Request) => endpoint.handle(request);
export const POST = (request: Request) => endpoint.handle(request);
