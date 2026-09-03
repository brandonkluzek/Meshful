import {
  LEARNER_SCOPES, deny, isOpaqueId, mintVerifiedContext,
  requireBindingLookup, resolveVerifiedIdentity, trustedHttpsUrl,
} from './core.mjs';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

// This additive adapter deliberately does not read oai-authenticated-user-*,
// Host, forwarded-host, cookies, JSON, or a client-provided trust flag. The
// Website supplies the injected resolver only from the generated server-only
// Sites getChatGPTUser() request context. It must bind the stable Sites subject
// to that same dispatch-owned route invocation. Raw headers and generic Worker
// routes are not substitutes; the exact deployment still needs spoof/direct-
// origin negative acceptance before release activation.
export function createTrustedSitesAuthenticator({
  siteId,
  allowedOrigins = [],
  resolveTrustedSitesRequest,
  findPrincipalByIdentity,
  provisionPrincipalForVerifiedIdentity,
  allowProvisioning = false,
} = {}) {
  if (typeof siteId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(siteId)) {
    throw new TypeError('The exact trusted Sites project ID is required.');
  }
  requireBindingLookup(findPrincipalByIdentity);
  if (resolveTrustedSitesRequest !== undefined && typeof resolveTrustedSitesRequest !== 'function') {
    throw new TypeError('Invalid trusted Sites request resolver.');
  }
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
    if (request.headers.has('authorization')) deny('invalid_credentials');
    if (new URL(request.url).searchParams.has('access_token')) deny('invalid_credentials');
    if (!resolveTrustedSitesRequest) deny('auth_not_configured');

    let verified;
    try {
      verified = normalizeTrustedResult(await resolveTrustedSitesRequest(request));
    } catch {
      deny('auth_unavailable');
    }
    if (verified.trusted !== true) deny('untrusted_ingress');
    if (verified.authenticated !== true) deny('authentication_required');
    if (!isOpaqueId(verified.subject)) deny('invalid_credentials');

    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.get('origin');
      const fetchSite = request.headers.get('sec-fetch-site');
      if (!origins.has(origin) || (fetchSite !== null && fetchSite !== 'same-origin')) {
        deny('csrf_rejected');
      }
    }

    const identity = Object.freeze({
      provider: 'sites-chatgpt', issuer, subject: verified.subject,
    });
    const principalId = await resolveVerifiedIdentity(identity, {
      findPrincipalByIdentity, provisionPrincipalForVerifiedIdentity, allowProvisioning,
    });
    return mintVerifiedContext({
      principalId, identity, transport: 'sites-browser', scopes: LEARNER_SCOPES,
    });
  };
}

function normalizeTrustedResult(value) {
  if (!plainDataRecord(value)) throw new TypeError('Malformed trusted request result.');
  const keys = Reflect.ownKeys(value);
  if (keys.length === 1 && keys[0] === 'trusted' && dataValue(value, 'trusted') === false) {
    return { trusted: false };
  }
  if (keys.length === 2 && sameKeys(keys, ['authenticated', 'trusted']) &&
      dataValue(value, 'trusted') === true && dataValue(value, 'authenticated') === false) {
    return { trusted: true, authenticated: false };
  }
  if (keys.length === 3 && sameKeys(keys, ['authenticated', 'subject', 'trusted']) &&
      dataValue(value, 'trusted') === true && dataValue(value, 'authenticated') === true) {
    return { trusted: true, authenticated: true, subject: dataValue(value, 'subject') };
  }
  throw new TypeError('Malformed trusted request result.');
}

function plainDataRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' &&
    Object.hasOwn(value, key) && 'value' in Object.getOwnPropertyDescriptor(value, key));
}

function dataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor)) throw new TypeError('Data property required.');
  return descriptor.value;
}

function sameKeys(actual, expected) {
  return actual.every((key) => typeof key === 'string') &&
    [...actual].sort().join('\n') === [...expected].sort().join('\n');
}
