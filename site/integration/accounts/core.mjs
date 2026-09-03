// Server-only. Never serialize a principal context to a browser or accept one
// from a request body. Backend owns identity bindings and owner-scoped queries.
export const LEARNER_SCOPES = Object.freeze(['learner:read', 'learner:write']);

const ERRORS = Object.freeze({
  authentication_required: [401, 'Authentication required.'],
  invalid_credentials: [401, 'Authentication required.'],
  untrusted_ingress: [401, 'Authentication required.'],
  identity_not_bound: [403, 'Account access is not available for this identity.'],
  insufficient_scope: [403, 'Permission denied.'],
  csrf_rejected: [403, 'Request origin is not allowed.'],
  resource_not_found: [404, 'Resource not found.'],
  auth_not_configured: [503, 'Account access is not enabled.'],
  auth_unavailable: [503, 'Account access is temporarily unavailable.'],
});

export class AuthError extends Error {
  constructor(code = 'authentication_required') {
    const safeCode = Object.hasOwn(ERRORS, code) ? code : 'auth_unavailable';
    super(ERRORS[safeCode][1]);
    this.name = 'AuthError';
    this.code = safeCode;
    this.status = ERRORS[safeCode][0];
  }
}

export function deny(code) {
  throw new AuthError(code);
}

// Exact, bounded opaque IDs; no case folding, email matching, or delimiter
// concatenation for database identity keys. Backend stores the three columns.
export function isOpaqueId(value, maxLength = 512) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= maxLength && /^[\x21-\x7E]+$/.test(value) &&
    !value.includes(',');
}

export function trustedHttpsUrl(value) {
  if (typeof value !== 'string') throw new TypeError('A trusted HTTPS URL is required.');
  const url = new URL(value);
  if (!value.startsWith('https://') || /[\s\\?#]/.test(value) ||
      url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new TypeError('Use an exact, credential-free HTTPS URL without query or fragment.');
  }
  return url;
}

export function requireBindingLookup(findPrincipalByIdentity) {
  if (typeof findPrincipalByIdentity !== 'function') {
    throw new TypeError('Backend identity lookup is required.');
  }
}

// Internal seam for the two authenticators below, not a public credential API.
export async function resolveVerifiedIdentity(identity, {
  findPrincipalByIdentity,
  provisionPrincipalForVerifiedIdentity,
  allowProvisioning = false,
}) {
  try {
    let binding = await findPrincipalByIdentity(identity);
    if (binding === null && allowProvisioning) {
      if (identity.provider !== 'sites-chatgpt' ||
          typeof provisionPrincipalForVerifiedIdentity !== 'function') {
        deny('auth_unavailable');
      }
      const provisioned = await provisionPrincipalForVerifiedIdentity(identity);
      binding = await findPrincipalByIdentity(identity);
      if (!binding || binding.principalId !== provisioned?.principalId) {
        deny('auth_unavailable');
      }
    }
    if (binding === null) deny('identity_not_bound');
    if (!binding || !isOpaqueId(binding.principalId)) deny('auth_unavailable');
    return binding.principalId;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    // Provider/DB failures, headers, tokens and learner data never enter errors.
    deny('auth_unavailable');
  }
}

const issuedContexts = new WeakMap();

// Only authentication adapters mint these process-local, immutable contexts.
// The brand prevents accidental JSON/plain-object substitution, not hostile
// server code. Each HTTP request still requires fresh authentication.
export function mintVerifiedContext({ principalId, identity, transport, scopes }, {
  expiresAt = null,
  clock = Date.now,
} = {}) {
  const context = Object.freeze({
    principalId,
    identity: Object.freeze({
      provider: identity.provider, issuer: identity.issuer, subject: identity.subject,
    }),
    transport,
    scopes: Object.freeze([...new Set(scopes)]),
  });
  issuedContexts.set(context, { expiresAt, clock });
  assertFreshContext(context);
  return context;
}

function assertFreshContext(context) {
  const issued = context && issuedContexts.get(context);
  if (!issued) deny('authentication_required');
  if (issued.expiresAt !== null) {
    const now = issued.clock();
    if (!Number.isFinite(now) || now >= issued.expiresAt) deny('invalid_credentials');
  }
}

export function assertLearnerScope(context, scope) {
  assertFreshContext(context);
  if (!LEARNER_SCOPES.includes(scope) || !context.scopes.includes(scope)) {
    deny('insufficient_scope');
  }
  return context;
}

// Defense in depth only: Backend MUST also include principalId in every query,
// join, mutation, session lookup, export, and idempotency key. Do not fetch a
// foreign row and then rely only on this post-load check.
export function assertOwnedResource(context, scope, ownerPrincipalId) {
  assertLearnerScope(context, scope);
  if (!isOpaqueId(ownerPrincipalId) || ownerPrincipalId !== context.principalId) {
    deny('resource_not_found');
  }
  return context;
}

function safeError(error) {
  return error instanceof AuthError && Object.hasOwn(ERRORS, error.code)
    ? new AuthError(error.code) : new AuthError('auth_unavailable');
}

function oauthChallenge(error, resourceMetadataUrl) {
  if (!resourceMetadataUrl ||
      (error.status !== 401 && error.code !== 'insufficient_scope')) return null;
  const url = trustedHttpsUrl(resourceMetadataUrl).href;
  const code = error.code === 'insufficient_scope' ? 'insufficient_scope' : 'invalid_token';
  return `Bearer resource_metadata="${url}", error="${code}", ` +
    'error_description="Sign in with the configured provider to continue"';
}

export function authFailureResponse(error, { resourceMetadataUrl } = {}) {
  const safe = safeError(error);
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Cookie, Authorization, oai-authenticated-user-id',
  });
  const challenge = oauthChallenge(safe, resourceMetadataUrl);
  if (challenge) headers.set('WWW-Authenticate', challenge);
  return new Response(JSON.stringify({ error: { code: safe.code, message: safe.message } }), {
    status: safe.status, headers,
  });
}

export function mcpAuthFailure(error, { resourceMetadataUrl } = {}) {
  const safe = safeError(error);
  const result = { isError: true, content: [{ type: 'text', text: safe.message }] };
  const challenge = oauthChallenge(safe, resourceMetadataUrl);
  if (challenge) result._meta = { 'mcp/www_authenticate': [challenge] };
  return result;
}
