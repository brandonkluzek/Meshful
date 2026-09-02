// All identities, addresses, keys, and data here are synthetic. No provider,
// network, browser storage, or Backend database is used by these fixtures.
import { exportJWK, generateKeyPair, generateSecret, SignJWT } from 'jose';

export const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);
export const ORIGIN = 'https://meshful.test';
export const SITE_ID = 'synthetic-site';
export const ISSUER = 'https://identity.meshful.test/';
export const RESOURCE = `${ORIGIN}/mcp`;
export const METADATA_URL = `${ORIGIN}/.well-known/oauth-protected-resource`;
export const CLIENT_ID = 'synthetic-client';

export function siteIdentity(subject = 'site-user-a', siteId = SITE_ID) {
  return { provider: 'sites-chatgpt', issuer: `urn:meshful:sites:${siteId}`, subject };
}

export function remoteIdentity(subject = 'remote-user-a', issuer = ISSUER) {
  return { provider: 'oauth', issuer, subject };
}

export function identityRegistry(initialBindings = []) {
  // This is only a lookup/provisioning-contract fixture, not Backend tables.
  const bindings = new Map(initialBindings.map(([identity, principalId]) => [
    JSON.stringify([identity.provider, identity.issuer, identity.subject]), principalId,
  ]));
  const lookups = [];
  const provisions = [];
  const keyOf = ({ provider, issuer, subject }) => JSON.stringify([provider, issuer, subject]);
  return {
    lookups,
    provisions,
    bind(identity, principalId) { bindings.set(keyOf(identity), principalId); },
    async findPrincipalByIdentity(identity) {
      lookups.push({ ...identity });
      const principalId = bindings.get(keyOf(identity));
      return principalId === undefined ? null : { principalId };
    },
    async provisionPrincipalForVerifiedIdentity(identity) {
      provisions.push({ ...identity });
      const key = keyOf(identity);
      if (!bindings.has(key)) bindings.set(key, `provisioned-${bindings.size + 1}`);
      return { principalId: bindings.get(key) };
    },
  };
}

export function siteRequest({
  subject = 'site-user-a', email = 'synthetic@example.test', method = 'GET',
  origin, headers = {}, query = '',
} = {}) {
  const requestHeaders = new Headers(headers);
  if (subject !== null) requestHeaders.set('oai-authenticated-user-id', subject);
  if (email !== null) requestHeaders.set('oai-authenticated-user-email', email);
  if (origin !== undefined) requestHeaders.set('origin', origin);
  return new Request(`${ORIGIN}/accounts${query}`, { method, headers: requestHeaders });
}

export function remoteRequest(token, { headers = {}, query = '', method = 'POST' } = {}) {
  const requestHeaders = new Headers(headers);
  if (token !== undefined) requestHeaders.set('authorization', `Bearer ${token}`);
  return new Request(`${RESOURCE}${query}`, { method, headers: requestHeaders });
}

export async function signingFixtures() {
  const [ec, rsa, otherEc, secret] = await Promise.all([
    generateKeyPair('ES256'), generateKeyPair('RS256'),
    generateKeyPair('ES256'), generateSecret('HS256'),
  ]);
  const ecJwk = { ...await exportJWK(ec.publicKey), alg: 'ES256', use: 'sig', kid: 'synthetic-ec' };
  const rsaJwk = { ...await exportJWK(rsa.publicKey), alg: 'RS256', use: 'sig', kid: 'synthetic-rsa' };
  const keys = {
    ec: { key: ec.privateKey, alg: 'ES256', kid: ecJwk.kid },
    rsa: { key: rsa.privateKey, alg: 'RS256', kid: rsaJwk.kid },
    otherEc: { key: otherEc.privateKey, alg: 'ES256', kid: ecJwk.kid },
    secret: { key: secret, alg: 'HS256', kid: ecJwk.kid },
  };
  const baseClaims = {
    iss: ISSUER, sub: 'remote-user-a', aud: RESOURCE,
    iat: NOW / 1000 - 10, exp: NOW / 1000 + 300,
    jti: 'synthetic-token', client_id: CLIENT_ID,
    scope: 'learner:read learner:write',
  };
  return {
    jwks: { keys: [ecJwk, rsaJwk] },
    baseClaims,
    async issue({ claims = {}, omit = [], header = {}, signer = 'ec' } = {}) {
      const selected = keys[signer];
      const payload = { ...baseClaims, ...claims };
      for (const claim of omit) delete payload[claim];
      return new SignJWT(payload).setProtectedHeader({
        alg: selected.alg, typ: 'at+jwt', kid: selected.kid, ...header,
      }).sign(selected.key);
    },
  };
}
