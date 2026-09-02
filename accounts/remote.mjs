import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose';
import {
  LEARNER_SCOPES, deny, isOpaqueId, mintVerifiedContext,
  requireBindingLookup, resolveVerifiedIdentity, trustedHttpsUrl,
} from './core.mjs';

const ALGORITHMS = Object.freeze(['RS256', 'ES256']);
const REQUIRED_CLAIMS = ['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'client_id', 'scope'];
const FORBIDDEN_KEY_HEADERS = ['jku', 'jwk', 'x5u', 'x5c'];

// Resource-server verification only. No authorization server, OAuth callback,
// account linking, token minting, token exchange, or provider account setup.
export function createRemoteMcpAuthenticator({
  enabled = false,
  issuer,
  resource,
  jwks,
  jwksUrl,
  allowedClientIds,
  findPrincipalByIdentity,
  clock = Date.now,
  maxTokenAgeSeconds = 3600,
} = {}) {
  if (enabled !== true) return async () => deny('auth_not_configured');
  trustedHttpsUrl(issuer);
  trustedHttpsUrl(resource);
  requireBindingLookup(findPrincipalByIdentity);
  if (!Array.isArray(allowedClientIds) || !allowedClientIds.length ||
      [...allowedClientIds].some((id) => !isOpaqueId(id, 2048))) {
    throw new TypeError('Explicit OAuth client IDs are required.');
  }
  if (typeof clock !== 'function' || !Number.isSafeInteger(maxTokenAgeSeconds) ||
      maxTokenAgeSeconds < 1 || maxTokenAgeSeconds > 86400) {
    throw new TypeError('Invalid token lifetime policy.');
  }
  if ((jwks === undefined) === (jwksUrl === undefined)) {
    throw new TypeError('Configure exactly one trusted JWKS source.');
  }
  const clients = new Set(allowedClientIds);
  // JWKS URLs are trusted configuration, never a token jku/iss or request URL.
  // This constructor performs no fetch. Remote fetching occurs only when an
  // enabled authenticator receives a token. Local JWKS keep all tests offline.
  const keys = jwksUrl !== undefined
    ? createRemoteJWKSet(trustedHttpsUrl(jwksUrl), {
      timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 300000,
    })
    : createLocalJWKSet(structuredClone(jwks));

  return async function authenticate(request) {
    if (!(request instanceof Request)) deny('invalid_credentials');
    // Explicit transport separation: never fall back to browser identity.
    if (request.headers.has('oai-authenticated-user-id') ||
        request.headers.has('oai-authenticated-user-email')) deny('invalid_credentials');
    const query = new URL(request.url).searchParams;
    if (['access_token', 'id_token', 'token'].some((key) => query.has(key))) {
      deny('invalid_credentials');
    }
    const authorization = request.headers.get('authorization');
    if (authorization === null) deny('authentication_required');
    if (authorization.length > 16384) deny('invalid_credentials');
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);
    if (!match) deny('invalid_credentials');
    const now = clock();
    if (!Number.isFinite(now) || now < 0) deny('auth_unavailable');
    let verified;
    try {
      verified = await jwtVerify(match[1], keys, {
        issuer, audience: resource, algorithms: ALGORITHMS, typ: 'at+jwt',
        requiredClaims: REQUIRED_CLAIMS, clockTolerance: 0,
        maxTokenAge: maxTokenAgeSeconds, currentDate: new Date(now),
      });
    } catch {
      deny('invalid_credentials');
    }
    const { payload, protectedHeader } = verified;
    if (!isOpaqueId(protectedHeader.kid) ||
        FORBIDDEN_KEY_HEADERS.some((field) => Object.hasOwn(protectedHeader, field)) ||
        payload.aud !== resource ||
        !isOpaqueId(payload.sub) || !isOpaqueId(payload.jti) ||
        !clients.has(payload.client_id) ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
        payload.iat > Math.floor(now / 1000) || payload.exp <= payload.iat ||
        payload.exp - payload.iat > maxTokenAgeSeconds ||
        (payload.nbf !== undefined && !Number.isSafeInteger(payload.nbf))) {
      deny('invalid_credentials');
    }
    if (typeof payload.scope !== 'string' ||
        (payload.scope !== '' && !/^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/.test(payload.scope))) {
      deny('invalid_credentials');
    }
    const granted = new Set(payload.scope.split(' '));
    const scopes = LEARNER_SCOPES.filter((scope) => granted.has(scope));
    if (!scopes.length) deny('insufficient_scope');
    const identity = Object.freeze({ provider: 'oauth', issuer: payload.iss, subject: payload.sub });
    const principalId = await resolveVerifiedIdentity(identity, { findPrincipalByIdentity });
    // Recheck expiry after asynchronous binding lookup, not just before it.
    return mintVerifiedContext({ principalId, identity, transport: 'remote-mcp', scopes }, {
      expiresAt: payload.exp * 1000, clock,
    });
  };
}

export function protectedResourceMetadata({ issuer, resource }) {
  trustedHttpsUrl(issuer);
  trustedHttpsUrl(resource);
  return Object.freeze({
    resource,
    authorization_servers: Object.freeze([issuer]),
    scopes_supported: LEARNER_SCOPES,
  });
}
