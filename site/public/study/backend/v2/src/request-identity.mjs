import { requireThat, text } from "../../src/contracts.mjs";

// Request/source identities cross URL and UTF-8 SQL boundaries. Ill-formed
// UTF-16 cannot be transported there without changing its identity. Learner
// content is different: JSON escapes preserve lone surrogates in its fields.
export function requestIdentity(value, label = "request_id") {
  text(value, label);
  requireThat(!/[\uD800-\uDFFF]/u.test(value), "INVALID_REQUEST_ID",
    `${label} must use well-formed Unicode. No command was sent or committed; preserve the original draft`, 400);
  return value;
}
