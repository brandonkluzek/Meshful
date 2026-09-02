import {
  LEARNER_SCOPES, deny, isOpaqueId, mintVerifiedContext,
  requireBindingLookup, resolveVerifiedIdentity, trustedHttpsUrl,
} from './core.mjs';

const USER_ID = 'oai-authenticated-user-id';
const USER_EMAIL = 'oai-authenticated-user-email';
const SAFE_METHODS = new Set(['GET', 'HEAD']);

export function createSitesAuthenticator({
  siteId,
  allowedOrigins = [],
  isTrustedIngress = () => false,
  findPrincipalByIdentity,
  provisionPrincipalForVerifiedIdentity,
  allowProvisioning = false,
} = {}) {
  if (typeof siteId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(siteId)) {
    throw new TypeError('The exact trusted Sites project ID is required.');
  }
  requireBindingLookup(findPrincipalByIdentity);
  if (typeof isTrustedIngress !== 'function') throw new TypeError('Invalid ingress verifier.');
  if (typeof allowProvisioning !== 'boolean') throw new TypeError('Invalid provisioning policy.');
  if (allowProvisioning && typeof provisionPrincipalForVerifiedIdentity !== 'function') {
    throw new TypeError('Explicit Backend provisioning hook is required.');
  }
  if (!Array.isArray(allowedOrigins)) throw new TypeError('Use an explicit origin allowlist.');
  const origins = new Set([...allowedOrigins].map((origin) => {
    const url = trustedHttpsUrl(`${origin}/`);
    if (url.origin !== origin) throw new TypeError('Allowlist exact HTTPS origins only.');
    return origin;
  }));
  const issuer = `urn:meshful:sites:${siteId}`;

  return async function authenticate(request) {
    if (!(request instanceof Request)) deny('invalid_credentials');
    // This predicate must inspect server/runtime provenance, never a client
    // header, Host, a boolean in JSON, or the mere presence of the user ID.
    let trusted;
    try { trusted = await isTrustedIngress(request); } catch { deny('auth_unavailable'); }
    if (trusted !== true) deny('untrusted_ingress');
    if (request.headers.has('authorization')) deny('invalid_credentials');
    if (new URL(request.url).searchParams.has('access_token')) deny('invalid_credentials');

    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.get('origin');
      const fetchSite = request.headers.get('sec-fetch-site');
      if (!origins.has(origin) || (fetchSite !== null && fetchSite !== 'same-origin')) {
        deny('csrf_rejected');
      }
    }

    const subject = request.headers.get(USER_ID);
    const email = request.headers.get(USER_EMAIL);
    if (!subject && !email) deny('authentication_required');
    if (!isOpaqueId(subject) || typeof email !== 'string' || email.length > 320 ||
        /[\x00-\x20\x7F]/.test(email) ||
        !/^[^\s,@]+@[^\s,@]+$/.test(email)) deny('invalid_credentials');

    // Email is a consistency check on the supported dispatcher envelope only.
    // It and the optional display name are never retained or used as keys.
    const identity = Object.freeze({ provider: 'sites-chatgpt', issuer, subject });
    const principalId = await resolveVerifiedIdentity(identity, {
      findPrincipalByIdentity, provisionPrincipalForVerifiedIdentity, allowProvisioning,
    });
    return mintVerifiedContext({
      principalId, identity, transport: 'sites-browser', scopes: LEARNER_SCOPES,
    });
  };
}
