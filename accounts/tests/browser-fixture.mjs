import { createAccountStorageController } from '../browser-storage.mjs';

const query = new URL(location.href).searchParams;
const run = query.get('run');
if (!/^[a-z0-9-]{1,80}$/.test(run ?? '')) throw new Error('Use the fixture server URL with a unique run identifier.');
const name = query.get('tab') === 'two' ? 'two' : 'one';
const byId = (id) => document.getElementById(id);
const result = (value) => { byId('result').textContent = JSON.stringify(value, null, 2); };
const invalidate = ({ reason }) => {
  byId('visible').textContent = 'hidden';
  byId('invalidations').textContent += reason + '\n';
};
const config = { siteId: `native-fixture-${run}`, onInvalidate: invalidate };
const controller = createAccountStorageController(config);
let lease;
let deliver;
byId('capabilities').textContent = JSON.stringify({ nativeLocks: Boolean(navigator.locks), secureContext: isSecureContext, tab: name });
function action(id, runAction) {
  byId(id).addEventListener('click', async () => {
    try { result(await runAction()); }
    catch (error) { result({ ok: false, code: error.code ?? 'FIXTURE_FAILURE' }); }
  });
}
async function open(accountBinding) {
  const startup = controller.beginEpoch();
  // Synthetic discovery only. No cookie, provider or backend request is made.
  const ticket = controller.bindPrincipal(accountBinding, startup);
  lease = await controller.acquire({ accountBinding, ticket });
  return { ok: true, accountBinding, nativeLease: lease.isCurrent() };
}
action('open-a', () => open('synthetic-A'));
action('open-b', () => open('synthetic-B'));
action('save', () => {
  const requestId = `synthetic-${lease.accountBinding}-${name}`;
  lease.outbox.write({ accountBinding: lease.accountBinding, command: {
    request_id: requestId, expected_revision: 0, operation: 'submit_grade',
    args: { idempotency_key: requestId, answer_text: 'Synthetic native-lock test only.' },
  } });
  return { ok: true, saved: requestId };
});
action('read', () => {
  const value = lease.outbox.read();
  byId('visible').textContent = JSON.stringify(value === null ? null : {
    accountBinding: value.accountBinding, requestId: value.command.request_id,
  });
  return { ok: true, nativeLease: lease.isCurrent() };
});
action('hold', () => {
  const originalLease = lease;
  const originalTicket = originalLease.executionGuard.capture();
  deliver = () => {
    originalLease.outbox.write(null);
    return { ok: true, stillCurrent: originalLease.executionGuard.isCurrent(originalTicket) };
  };
  return { ok: true, held: originalLease.accountBinding };
});
action('deliver', () => deliver());
action('invalidate', () => {
  controller.beginEpoch({ broadcast: true });
  return { ok: true, invalidated: true };
});
action('release', async () => {
  await lease.release();
  return { ok: true, released: true };
});
action('missing', () => {
  createAccountStorageController({ ...config, locks: {} });
  throw new Error('Missing locks unexpectedly accepted.');
});
