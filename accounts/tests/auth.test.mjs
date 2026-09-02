import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { UnsecuredJWT } from 'jose';
import {
  AuthError, PRODUCT_VIEWS, assertLearnerScope, assertOwnedResource,
  authFailureResponse, createAccountStateFence, createRemoteMcpAuthenticator,
  createSitesAuthenticator, describePersistence, mcpAuthFailure,
  protectedResourceMetadata,
} from '../index.mjs';
import {
  CLIENT_ID, ISSUER, METADATA_URL, NOW, ORIGIN, RESOURCE, SITE_ID,
  identityRegistry, remoteIdentity, remoteRequest, signingFixtures,
  siteIdentity, siteRequest,
} from './fixtures.mjs';

// Provider-free contract proof only. These tests do not establish deployed
// Sites header provenance, Backend SQL isolation, a linking flow, or hosted QA.
let signing;
const networkAttempts = [];
before(async () => {
  mock.method(globalThis, 'fetch', async (...args) => {
    networkAttempts.push(String(args[0]));
    throw new Error('Network is forbidden in accounts contract tests.');
  });
  signing = await signingFixtures();
});
after(() => {
  mock.restoreAll();
  assert.deepEqual(networkAttempts, [], 'Contract tests must never attempt network access.');
});

function registry() {
  return identityRegistry([
    [siteIdentity(), 'principal-a'], [siteIdentity('site-user-b'), 'principal-b'],
    [remoteIdentity(), 'principal-a'], [remoteIdentity('remote-user-b'), 'principal-b'],
  ]);
}

function sites(bindings = registry(), options = {}) {
  return createSitesAuthenticator({
    siteId: SITE_ID, allowedOrigins: [ORIGIN], isTrustedIngress: () => true,
    findPrincipalByIdentity: bindings.findPrincipalByIdentity,
    provisionPrincipalForVerifiedIdentity: bindings.provisionPrincipalForVerifiedIdentity,
    ...options,
  });
}

function remote(bindings = registry(), options = {}) {
  return createRemoteMcpAuthenticator({
    enabled: true, issuer: ISSUER, resource: RESOURCE, jwks: signing.jwks,
    allowedClientIds: [CLIENT_ID], clock: () => NOW,
    findPrincipalByIdentity: bindings.findPrincipalByIdentity, ...options,
  });
}

async function rejected(operation, status = 401, code) {
  let actual;
  await assert.rejects(operation, (error) => {
    actual = error;
    assert.equal(authFailureResponse(error).status, status);
    if (code !== undefined) assert.equal(error.code, code);
    return true;
  });
  return actual;
}

test('verified Sites context is minimal, immutable, and keyed by Site plus subject', async () => {
  const bindings = registry();
  const context = await sites(bindings)(siteRequest({ headers: {
    'oai-authenticated-user-full-name': 'Synthetic Personal Name',
    'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
  } }));
  assert.deepEqual(context, {
    principalId: 'principal-a', identity: siteIdentity(), transport: 'sites-browser',
    scopes: ['learner:read', 'learner:write'],
  });
  for (const value of [context, context.identity, context.scopes]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { context.principalId = 'principal-b'; }, TypeError);
  assert.throws(() => { context.identity.subject = 'site-user-b'; }, TypeError);
  assert.throws(() => { context.scopes.push('admin'); }, TypeError);
  assert.deepEqual(bindings.lookups, [siteIdentity()]);
  assert.doesNotMatch(JSON.stringify(context), /email|full.?name|Synthetic Personal Name|example\.test/i);
});

for (const method of ['GET', 'HEAD']) {
  test(`Sites ${method} uses verified ingress without requiring a mutation Origin`, async () => {
    assert.equal((await sites()(siteRequest({ method }))).principalId, 'principal-a');
  });
}

test('Sites ingress proof is required by default even with complete identity headers', async () => {
  const authenticate = createSitesAuthenticator({
    siteId: SITE_ID, findPrincipalByIdentity: registry().findPrincipalByIdentity,
  });
  await rejected(() => authenticate(siteRequest()), 401, 'untrusted_ingress');
});

for (const trusted of [false, undefined, null, 1, 'true', {}]) {
  test(`Sites ingress rejects nonliteral true: ${JSON.stringify(trusted)}`, async () => {
    const bindings = registry();
    await rejected(() => sites(bindings, { isTrustedIngress: () => trusted })(siteRequest()));
    assert.equal(bindings.lookups.length, 0);
    assert.equal(bindings.provisions.length, 0);
  });
}

test('Sites verifier failure is sanitized and cannot fall back to identity headers', async () => {
  const authenticate = sites(registry(), { isTrustedIngress() { throw new Error('private ingress detail'); } });
  const error = await rejected(() => authenticate(siteRequest()), 503, 'auth_unavailable');
  assert.doesNotMatch(await authFailureResponse(error).text(), /private ingress detail/);
});

for (const [label, options] of [
  ['both missing', { subject: null, email: null }], ['subject missing', { subject: null }],
  ['email missing', { email: null }], ['subject empty', { subject: '' }],
  ['email empty', { email: '' }], ['invalid email', { email: 'not-an-email' }],
  ['control byte in email', { email: 'synthetic\x01@example.test' }],
  ['delete byte in email', { email: 'synthetic\x7f@example.test' }],
  ['ambiguous combined subject', { subject: 'site-user-a, site-user-b' }],
  ['ambiguous combined email', { email: 'a@example.test, b@example.test' }],
  ['oversized subject', { subject: 'a'.repeat(513) }],
]) {
  test(`Sites rejects ${label}`, async () => {
    const bindings = registry();
    await rejected(() => sites(bindings)(siteRequest(options)));
    assert.equal(bindings.lookups.length, 0);
  });
}

test('plain request-like objects cannot impersonate Request at either transport', async () => {
  const fake = { url: `${ORIGIN}/accounts`, method: 'GET', headers: siteRequest().headers };
  await rejected(() => sites()(fake));
  await rejected(() => remote()(fake));
});

test('Sites ignores request-supplied account IDs, identity JSON, and trust-looking headers', async () => {
  const context = await sites()(new Request(`${ORIGIN}/accounts?principalId=principal-b`, {
    method: 'POST', headers: {
      origin: ORIGIN, 'content-type': 'application/json',
      'oai-authenticated-user-id': 'site-user-a', 'oai-authenticated-user-email': 'a@example.test',
      'x-user-id': 'principal-b', 'x-trusted-ingress': 'true',
    },
    body: JSON.stringify({ principalId: 'principal-b', identity: siteIdentity('site-user-b') }),
  }));
  assert.equal(context.principalId, 'principal-a');
  const noIngress = sites(registry(), { isTrustedIngress: () => false });
  await rejected(() => noIngress(siteRequest({ headers: { 'x-trusted-ingress': 'true' } })));
});

test('equal email or display name never links a different Sites subject', async () => {
  const authenticate = sites();
  const a = await authenticate(siteRequest({ headers: { 'oai-authenticated-user-full-name': 'Same Name' } }));
  const b = await authenticate(siteRequest({ subject: 'site-user-b', headers: {
    'oai-authenticated-user-full-name': 'Same Name',
  } }));
  assert.notEqual(a.principalId, b.principalId);
  await rejected(() => authenticate(siteRequest({ subject: 'unknown-subject' })), 403, 'identity_not_bound');
});

test('same subject on another Site is a different binding', async () => {
  const bindings = registry();
  await rejected(() => sites(bindings, { siteId: 'another-site' })(siteRequest()), 403, 'identity_not_bound');
  assert.deepEqual(bindings.lookups, [siteIdentity('site-user-a', 'another-site')]);
});

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
  test(`Sites ${method} requires an allowed exact Origin`, async () => {
    const authenticate = sites();
    await rejected(() => authenticate(siteRequest({ method })), 403, 'csrf_rejected');
    assert.equal((await authenticate(siteRequest({ method, origin: ORIGIN }))).principalId, 'principal-a');
  });
}

for (const origin of ['null', 'http://meshful.test', 'https://evil.test',
  `${ORIGIN}.evil.test`, `${ORIGIN}/`, `${ORIGIN}/account`, `${ORIGIN}:8443`]) {
  test(`Sites rejects mutation Origin ${origin}`, async () => {
    await rejected(() => sites()(siteRequest({ method: 'POST', origin })), 403, 'csrf_rejected');
  });
}

for (const fetchSite of ['cross-site', 'same-site', 'none']) {
  test(`Sites rejects mutation fetch provenance ${fetchSite}`, async () => {
    await rejected(() => sites()(siteRequest({ method: 'POST', origin: ORIGIN,
      headers: { 'sec-fetch-site': fetchSite },
    })), 403, 'csrf_rejected');
  });
}

test('Sites mutation accepts exact same-origin fetch provenance', async () => {
  assert.equal((await sites()(siteRequest({ method: 'POST', origin: ORIGIN,
    headers: { 'sec-fetch-site': 'same-origin' },
  }))).principalId, 'principal-a');
});

test('Sites route never consumes bearer credentials or access-token query parameters', async () => {
  const token = await signing.issue();
  await rejected(() => sites()(siteRequest({ headers: { authorization: `Bearer ${token}` } })));
  await rejected(() => sites()(siteRequest({ query: '?access_token=synthetic' })));
});

test('Sites never provisions by default', async () => {
  const bindings = identityRegistry();
  await rejected(() => sites(bindings)(siteRequest()), 403, 'identity_not_bound');
  assert.equal(bindings.provisions.length, 0);
});

test('explicit first-Sites-sign-in provisioning rechecks a durable exact binding', async () => {
  const bindings = identityRegistry();
  const authenticate = sites(bindings, { allowProvisioning: true });
  const [first, concurrent] = await Promise.all([authenticate(siteRequest()), authenticate(siteRequest())]);
  const again = await authenticate(siteRequest({ email: 'changed@example.test' }));
  assert.equal(first.principalId, concurrent.principalId);
  assert.equal(first.principalId, again.principalId);
  assert.deepEqual(first.identity, siteIdentity());
  assert.ok(bindings.provisions.length >= 1);
  assert.ok(bindings.provisions.every((identity) => Object.keys(identity).length === 3));
});

test('Sites rejects provisioning without a persisted matching identity binding', async () => {
  const bindings = identityRegistry();
  const authenticate = sites(bindings, { allowProvisioning: true,
    provisionPrincipalForVerifiedIdentity: async () => ({ principalId: 'principal-a' }),
  });
  await rejected(() => authenticate(siteRequest()), 503, 'auth_unavailable');
});

test('Sites rejects provisioning that returns a principal different from the stored binding', async () => {
  const bindings = identityRegistry();
  const authenticate = sites(bindings, { allowProvisioning: true,
    provisionPrincipalForVerifiedIdentity: async (identity) => {
      bindings.bind(identity, 'principal-b');
      return { principalId: 'principal-a' };
    },
  });
  await rejected(() => authenticate(siteRequest()), 503, 'auth_unavailable');
});

test('failed verification never reaches opt-in provisioning', async () => {
  const bindings = identityRegistry();
  await rejected(() => sites(bindings, { allowProvisioning: true,
    isTrustedIngress: () => false,
  })(siteRequest()));
  assert.equal(bindings.provisions.length, 0);
});

test('Sites configuration rejects sparse origins, unsafe URLs, and ambiguous provisioning policy', () => {
  for (const allowedOrigins of [Array(1), [ORIGIN, ,], 'https://meshful.test',
    ['http://meshful.test'], [`${ORIGIN}/path`], [`${ORIGIN}?query=1`],
    [`${ORIGIN}#fragment`], ['https://user:password@meshful.test']]) {
    assert.throws(() => sites(registry(), { allowedOrigins }), TypeError);
  }
  assert.throws(() => sites(registry(), { allowProvisioning: 'true' }), TypeError);
  assert.throws(() => sites(registry(), { allowProvisioning: true,
    provisionPrincipalForVerifiedIdentity: undefined,
  }), TypeError);
  assert.throws(() => sites(registry(), { findPrincipalByIdentity: undefined }), TypeError);
});

test('mutation-origin allowlist is a configuration snapshot', async () => {
  const allowedOrigins = [ORIGIN];
  const authenticate = sites(registry(), { allowedOrigins });
  allowedOrigins.push('https://evil.test');
  await rejected(() => authenticate(siteRequest({ method: 'POST', origin: 'https://evil.test' })), 403);
});

test('binding lookup failures and malformed principal IDs fail closed', async () => {
  for (const result of [undefined, {}, { principalId: '' }, { principalId: 'a,b' }]) {
    await rejected(() => sites(registry(), { findPrincipalByIdentity: async () => result })(siteRequest()), 503);
  }
  await rejected(() => sites(registry(), { findPrincipalByIdentity: async () => {
    throw new Error('database credential and learner answer');
  } })(siteRequest()), 503);
});

test('remote authentication is disabled by default and never fetches or resolves identity', async () => {
  const bindings = registry();
  const authenticate = createRemoteMcpAuthenticator({
    jwksUrl: 'https://must-not-contact.example.test/jwks',
    findPrincipalByIdentity: bindings.findPrincipalByIdentity,
  });
  await rejected(async () => authenticate(remoteRequest(await signing.issue())), 503, 'auth_not_configured');
  assert.equal(bindings.lookups.length, 0);
});

test('truthy remote enablement flags do not activate the verifier', async () => {
  for (const enabled of ['true', 1, {}, false]) {
    const authenticate = createRemoteMcpAuthenticator({ enabled });
    await rejected(() => authenticate(remoteRequest()), 503, 'auth_not_configured');
  }
});

test('remote startup rejects sparse or missing clients and ambiguous JWKS sources', () => {
  for (const allowedClientIds of [Array(1), [CLIENT_ID, ,], [], undefined, CLIENT_ID, ['']]) {
    assert.throws(() => remote(registry(), { allowedClientIds }), TypeError);
  }
  assert.throws(() => remote(registry(), { jwks: undefined }), TypeError);
  assert.throws(() => remote(registry(), { jwksUrl: 'https://identity.meshful.test/jwks' }), TypeError);
  assert.throws(() => remote(registry(), { findPrincipalByIdentity: undefined }), TypeError);
  for (const maxTokenAgeSeconds of [0, -1, 1.5, Infinity, 86401]) {
    assert.throws(() => remote(registry(), { maxTokenAgeSeconds }), TypeError);
  }
});

test('remote configuration rejects HTTP, credential-bearing, and parameterized trust URLs', () => {
  for (const issuer of ['http://identity.meshful.test/', 'https://user:password@identity.meshful.test/',
    `${ISSUER}?tenant=other`, `${ISSUER}#other`, 'https://identity.meshful.test\\evil']) {
    assert.throws(() => remote(registry(), { issuer }), TypeError);
  }
  assert.throws(() => remote(registry(), { resource: 'http://meshful.test/mcp' }), TypeError);
  assert.throws(() => remote(registry(), { jwks: undefined,
    jwksUrl: 'http://identity.meshful.test/jwks',
  }), TypeError);
});

test('client allowlist and local JWKS snapshots cannot be changed after initialization', async () => {
  const allowedClientIds = [CLIENT_ID];
  const jwks = structuredClone(signing.jwks);
  const authenticate = remote(registry(), { allowedClientIds, jwks });
  allowedClientIds.push('new-untrusted-client');
  jwks.keys.length = 0;
  assert.equal((await authenticate(remoteRequest(await signing.issue()))).principalId, 'principal-a');
  const unexpectedClient = await signing.issue({ claims: { client_id: 'new-untrusted-client' } });
  await rejected(() => authenticate(remoteRequest(unexpectedClient)));
});

for (const signer of ['ec', 'rsa']) {
  test(`remote ${signer} access token uses real local signature verification`, async () => {
    const context = await remote()(remoteRequest(await signing.issue({ signer })));
    assert.deepEqual(context, { principalId: 'principal-a', identity: remoteIdentity(),
      transport: 'remote-mcp', scopes: ['learner:read', 'learner:write'] });
    assert.ok(Object.isFrozen(context));
    assert.ok(Object.isFrozen(context.identity));
    assert.ok(Object.isFrozen(context.scopes));
  });
}

for (const authorization of [undefined, '', 'Basic synthetic', 'Bearer opaque',
  'Bearer a.b.c', 'Bearer a.b.c, Bearer d.e.f', 'Bearer  a.b.c', 'Bearer ' + 'a'.repeat(16385)]) {
  test(`remote rejects missing/malformed authorization (${authorization?.slice(0, 24) ?? 'missing'})`, async () => {
    const headers = authorization === undefined ? {} : { authorization };
    await rejected(() => remote()(remoteRequest(undefined, { headers })));
  });
}

for (const claim of ['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'client_id', 'scope']) {
  test(`remote requires signed claim ${claim}`, async () => {
    const token = await signing.issue({ omit: [claim] });
    await rejected(() => remote()(remoteRequest(token)));
  });
}

for (const [label, claims] of [
  ['expired', { exp: NOW / 1000 }], ['not yet valid', { nbf: NOW / 1000 + 1 }],
  ['future issued-at', { iat: NOW / 1000 + 1 }],
  ['too old', { iat: NOW / 1000 - 3601 }],
  ['excessive total lifetime', { exp: NOW / 1000 + 3600 }],
  ['expiration before issued-at', { exp: NOW / 1000 - 20 }],
  ['fractional issued-at', { iat: NOW / 1000 - 0.5 }],
  ['fractional expiration', { exp: NOW / 1000 + 0.5 }],
  ['fractional not-before', { nbf: NOW / 1000 - 0.5 }],
  ['string expiration', { exp: String(NOW / 1000 + 300) }],
  ['wrong issuer', { iss: 'https://evil.test/' }],
  ['wrong resource', { aud: `${RESOURCE}/other` }],
  ['multi-resource audience', { aud: [RESOURCE, 'https://other.test/mcp'] }],
  ['array instead of exact audience', { aud: [RESOURCE] }],
  ['unknown client', { client_id: 'other-client' }],
  ['array client', { client_id: [CLIENT_ID] }],
  ['empty subject', { sub: '' }], ['non-string subject', { sub: 42 }],
  ['ambiguous subject', { sub: 'a,b' }], ['oversized subject', { sub: 'a'.repeat(513) }],
  ['empty token ID', { jti: '' }], ['non-string token ID', { jti: 42 }],
  ['array scope', { scope: ['learner:read'] }],
  ['tab-separated scope', { scope: 'learner:read\tlearner:write' }],
]) {
  test(`remote rejects ${label}`, async () => {
    const token = await signing.issue({ claims });
    const bindings = registry();
    await rejected(() => remote(bindings)(remoteRequest(token)));
    assert.equal(bindings.lookups.length, 0, 'invalid tokens must not consult learner identity data');
  });
}

for (const [label, options] of [
  ['wrong signature', { signer: 'otherEc' }], ['symmetric algorithm', { signer: 'secret' }],
  ['unknown signing key', { header: { kid: 'unknown-key' } }],
  ['missing key ID', { header: { kid: undefined } }],
  ['ID token type', { header: { typ: 'JWT' } }],
  ['missing token type', { header: { typ: undefined } }],
  ['untrusted key URL', { header: { jku: 'https://evil.test/jwks' } }],
  ['embedded key', { header: { jwk: { kty: 'RSA', n: 'synthetic', e: 'AQAB' } } }],
  ['certificate URL', { header: { x5u: 'https://evil.test/cert' } }],
  ['embedded certificate', { header: { x5c: ['synthetic-certificate'] } }],
]) {
  test(`remote rejects ${label}`, async () => {
    await rejected(async () => remote()(remoteRequest(await signing.issue(options))));
  });
}

test('remote rejects unsigned alg=none tokens', async () => {
  const unsigned = new UnsecuredJWT(signing.baseClaims).encode();
  await rejected(() => remote()(remoteRequest(unsigned)));
});

for (const query of ['?access_token=synthetic', '?token=synthetic', '?id_token=synthetic']) {
  test(`remote never reads token query transport ${query}`, async () => {
    await rejected(() => remote()(remoteRequest(undefined, { query })));
    const token = await signing.issue();
    await rejected(() => remote()(remoteRequest(token, { query })));
  });
}

for (const name of ['oai-authenticated-user-id', 'oai-authenticated-user-email']) {
  test(`remote rejects Sites header ${name}, including beside a valid bearer`, async () => {
    const headers = { [name]: name.endsWith('email') ? 'a@example.test' : 'site-user-a' };
    await rejected(() => remote()(remoteRequest(undefined, { headers })));
    const token = await signing.issue();
    await rejected(() => remote()(remoteRequest(token, { headers })));
  });
}

test('remote never provisions and equal email/subject cannot link across providers', async () => {
  const bindings = identityRegistry([[siteIdentity('same-subject'), 'principal-a']]);
  const token = await signing.issue({ claims: {
    sub: 'same-subject', email: 'synthetic@example.test', name: 'Same Name',
  } });
  await rejected(() => remote(bindings)(remoteRequest(token)), 403, 'identity_not_bound');
  assert.deepEqual(bindings.lookups, [remoteIdentity('same-subject')]);
  assert.equal(bindings.provisions.length, 0);
});

test('equal remote subject under a different verified issuer is not the same binding', async () => {
  const otherIssuer = 'https://other-identity.test/';
  const token = await signing.issue({ claims: { iss: otherIssuer } });
  const bindings = registry();
  await rejected(() => remote(bindings, { issuer: otherIssuer })(remoteRequest(token)), 403, 'identity_not_bound');
  assert.deepEqual(bindings.lookups, [remoteIdentity('remote-user-a', otherIssuer)]);
});

test('issuer strings and subjects are exact bindings, never URL- or case-normalized aliases', async () => {
  for (const issuer of ['https://IDENTITY.meshful.test/', 'https://identity.meshful.test']) {
    const token = await signing.issue({ claims: { iss: issuer } });
    const bindings = registry();
    await rejected(() => remote(bindings, { issuer })(remoteRequest(token)), 403, 'identity_not_bound');
    assert.deepEqual(bindings.lookups, [remoteIdentity('remote-user-a', issuer)]);
  }
  const token = await signing.issue({ claims: { sub: 'REMOTE-USER-A' } });
  await rejected(() => remote()(remoteRequest(token)), 403, 'identity_not_bound');
});

test('remote verified payload and request account hints cannot override exact binding lookup', async () => {
  const bindings = registry();
  const token = await signing.issue({ claims: { principalId: 'principal-b', userId: 'principal-b',
    email: 'private@example.test', name: 'Private Synthetic Name',
    identity: remoteIdentity('remote-user-b'),
  } });
  const request = new Request(`${RESOURCE}?principalId=principal-b`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'x-user-id': 'principal-b' },
    body: JSON.stringify({ principalId: 'principal-b', identity: remoteIdentity('remote-user-b') }),
  });
  const context = await remote(bindings)(request);
  assert.equal(context.principalId, 'principal-a');
  assert.deepEqual(bindings.lookups, [remoteIdentity()]);
  assert.doesNotMatch(JSON.stringify(context), /private|email|name|principal-b/i);
});

test('cross-transport principal equality requires separate exact server-owned bindings', async () => {
  // These are pre-established synthetic bindings, not an implemented account-
  // linking feature or proof that a browser credential is an OAuth access token.
  const bindings = identityRegistry([[siteIdentity(), 'principal-a']]);
  const browser = await sites(bindings)(siteRequest());
  const token = await signing.issue();
  await rejected(() => remote(bindings)(remoteRequest(token)), 403, 'identity_not_bound');
  bindings.bind(remoteIdentity(), 'principal-a');
  const client = await remote(bindings)(remoteRequest(token));
  assert.equal(browser.principalId, client.principalId);
  assert.notDeepEqual(browser.identity, client.identity);
});

test('scope grants are exact and unknown OAuth scopes never become learner permissions', async () => {
  const token = await signing.issue({ claims: { scope: 'openid admin learner:read learner:read' } });
  const context = await remote()(remoteRequest(token));
  assert.deepEqual(context.scopes, ['learner:read']);
  assert.equal(assertLearnerScope(context, 'learner:read'), context);
  await rejected(async () => assertLearnerScope(context, 'learner:write'), 403, 'insufficient_scope');
  await rejected(async () => assertLearnerScope(context, 'admin'), 403, 'insufficient_scope');
});

for (const scope of ['', 'openid profile', 'Learner:read', 'learner:reader', 'learner:*']) {
  test(`remote grants no learner authority for scope ${JSON.stringify(scope)}`, async () => {
    const token = await signing.issue({ claims: { scope } });
    await rejected(() => remote()(remoteRequest(token)), 403, 'insufficient_scope');
  });
}

test('remote rejects credentials that expire during async identity lookup', async () => {
  let clock = NOW;
  const token = await signing.issue({ claims: { exp: NOW / 1000 + 1 } });
  const authenticate = remote(registry(), { clock: () => clock,
    findPrincipalByIdentity: async () => {
      clock += 1000;
      return { principalId: 'principal-a' };
    },
  });
  await rejected(() => authenticate(remoteRequest(token)));
});

test('previously issued remote contexts lose authority on expiry', async () => {
  let clock = NOW;
  const token = await signing.issue({ claims: { exp: NOW / 1000 + 1 } });
  const context = await remote(registry(), { clock: () => clock })(remoteRequest(token));
  assert.equal(assertLearnerScope(context, 'learner:read'), context);
  clock += 1000;
  await rejected(async () => assertLearnerScope(context, 'learner:read'));
  await rejected(async () => assertOwnedResource(context, 'learner:write', 'principal-a'));
});

test('invalid server clock fails closed', async () => {
  const token = await signing.issue();
  await rejected(() => remote(registry(), { clock: () => NaN })(remoteRequest(token)), 503);
});

for (const kind of ['decks', 'sessions', 'grades', 'history']) {
  test(`synthetic ownership contract: A cannot read/write B ${kind}`, async () => {
    // A synthetic map only: SQL query predicates and route integration must be
    // proven separately by Backend. This tests the Accounts guard's contract.
    const rows = new Map([
      ['a', { ownerPrincipalId: 'principal-a', value: `A ${kind}` }],
      ['b', { ownerPrincipalId: 'principal-b', value: `B private ${kind}` }],
    ]);
    const context = await sites()(siteRequest());
    function read(id) {
      const row = rows.get(id);
      assertOwnedResource(context, 'learner:read', row?.ownerPrincipalId);
      return row.value;
    }
    function write(id) {
      const row = rows.get(id);
      assertOwnedResource(context, 'learner:write', row?.ownerPrincipalId);
      row.value = 'changed';
    }
    assert.equal(read('a'), `A ${kind}`);
    const foreign = await rejected(async () => read('b'), 404, 'resource_not_found');
    const missing = await rejected(async () => read('absent'), 404, 'resource_not_found');
    assert.deepEqual(await authFailureResponse(foreign).json(), await authFailureResponse(missing).json());
    await rejected(async () => write('b'), 404);
    assert.equal(rows.get('b').value, `B private ${kind}`);
    write('a');
    assert.equal(rows.get('a').value, 'changed');
    await rejected(async () => assertOwnedResource(null, 'learner:read', 'principal-a'));
  });
}

test('scope ownership guard checks permission before resource access', async () => {
  const token = await signing.issue({ claims: { scope: 'learner:read' } });
  const context = await remote()(remoteRequest(token));
  assert.equal(assertOwnedResource(context, 'learner:read', 'principal-a'), context);
  await rejected(async () => assertOwnedResource(context, 'learner:write', 'principal-a'), 403);
});

test('plain, frozen, cloned, inherited, and proxied contexts cannot carry authority', async () => {
  const context = await sites()(siteRequest());
  const fakes = [null, {}, { ...context }, structuredClone(context),
    Object.freeze(JSON.parse(JSON.stringify(context))), Object.create(context),
    new Proxy(context, {}), { ...context, principalId: 'principal-b' }];
  for (const fake of fakes) {
    await rejected(async () => assertLearnerScope(fake, 'learner:read'));
    await rejected(async () => assertOwnedResource(fake, 'learner:read', 'principal-a'));
  }
});

test('failure responses are no-store, safe JSON with no reflected secret details', async () => {
  for (const error of [new Error('Bearer private-token; learner answer; database password'),
    { status: 401, code: 'invalid_credentials', message: 'private-message' },
    new AuthError('unrecognized-secret-error')]) {
    const response = authFailureResponse(error);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), { error: {
      code: 'auth_unavailable', message: 'Account access is temporarily unavailable.',
    } });
  }
});

test('even modified AuthError instances cannot reflect attacker-controlled status or message', async () => {
  const error = new AuthError('invalid_credentials');
  error.message = 'private-token'; error.status = 200; error.stack = 'private-stack';
  const response = authFailureResponse(error);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: {
    code: 'invalid_credentials', message: 'Authentication required.',
  } });
});

for (const code of ['authentication_required', 'invalid_credentials', 'insufficient_scope']) {
  test(`OAuth challenge is advertised for ${code} with configured resource metadata`, () => {
    const error = new AuthError(code);
    const response = authFailureResponse(error, { resourceMetadataUrl: METADATA_URL });
    const challenge = response.headers.get('www-authenticate');
    assert.match(challenge, /^Bearer /);
    assert.ok(challenge.includes(`resource_metadata="${METADATA_URL}"`));
    const result = mcpAuthFailure(error, { resourceMetadataUrl: METADATA_URL });
    assert.equal(result.isError, true);
    assert.deepEqual(result._meta['mcp/www_authenticate'], [challenge]);
  });
}

for (const code of ['identity_not_bound', 'resource_not_found', 'auth_not_configured', 'auth_unavailable']) {
  test(`OAuth retries are not advertised for ${code}`, () => {
    const error = new AuthError(code);
    assert.equal(authFailureResponse(error, { resourceMetadataUrl: METADATA_URL }).headers.get('www-authenticate'), null);
    assert.equal(mcpAuthFailure(error, { resourceMetadataUrl: METADATA_URL })._meta, undefined);
  });
}

test('no remote provider metadata or challenge is invented when configuration is absent', () => {
  assert.equal(authFailureResponse(new AuthError()).headers.get('www-authenticate'), null);
  assert.equal(mcpAuthFailure(new AuthError())._meta, undefined);
  assert.deepEqual(protectedResourceMetadata({ issuer: ISSUER, resource: RESOURCE }), {
    resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ['learner:read', 'learner:write'],
  });
});

test('account-state fence rejects stale A/B/logout work, clones, and foreign-fence tickets', () => {
  const fence = createAccountStateFence();
  const local = fence.capture();
  assert.equal(fence.isCurrent(local), true);
  const a = fence.changePrincipal('principal-a');
  assert.equal(fence.isCurrent(local), false);
  assert.equal(fence.isCurrent(a), true);
  const b = fence.changePrincipal('principal-b');
  assert.equal(fence.isCurrent(a), false);
  assert.equal(fence.isCurrent(b), true);
  const loggedOut = fence.changePrincipal(null);
  assert.equal(fence.isCurrent(b), false);
  assert.equal(fence.isCurrent(loggedOut), true);
  const aAgain = fence.changePrincipal('principal-a');
  assert.equal(fence.isCurrent(a), false);
  assert.equal(fence.isCurrent({ ...aAgain }), false);
  assert.equal(fence.isCurrent(createAccountStateFence().changePrincipal('principal-a')), false);
  assert.equal(fence.isCurrent(null), false);
  fence.changePrincipal('principal-a');
  assert.equal(fence.isCurrent(aAgain), false);
});

test('sign-in does not imply account saving; all people retain the same four views', () => {
  const signedOut = describePersistence();
  const signedInLocal = describePersistence({ principalId: 'principal-a' });
  const account = describePersistence({ principalId: 'principal-a', accountSyncReady: true });
  for (const state of [signedOut, signedInLocal, account]) {
    assert.deepEqual(state.views, ['Study', 'My Decks', 'Library', 'Graph']);
    assert.equal(state.views, PRODUCT_VIEWS);
    assert.ok(Object.isFrozen(state));
    assert.ok(Object.isFrozen(state.views));
  }
  assert.equal(signedOut.storage, 'device-local');
  assert.match(signedOut.message, /anyone using this browser profile/i);
  assert.equal(signedInLocal.storage, 'device-local');
  assert.match(signedInLocal.message, /account saving is not enabled/i);
  assert.equal(account.storage, 'account');
  assert.match(account.message, /only changes confirmed as saved/i);
  assert.match(account.message, /not imported automatically/i);
  assert.equal(describePersistence({ accountSyncReady: true }).storage, 'device-local');
});

test('browser policy rejects ambiguous principal and sync configuration', () => {
  for (const principalId of ['', undefined, {}, 1]) {
    assert.throws(() => createAccountStateFence().changePrincipal(principalId), TypeError);
  }
  assert.throws(() => describePersistence({ accountSyncReady: 'true' }), TypeError);
});
