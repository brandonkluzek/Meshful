// Browser-safe policy helpers. These do not authenticate a user, perform sync,
// migrate existing browser storage, or make local data private on a shared PC.
export const PRODUCT_VIEWS = Object.freeze(['Study', 'My Decks', 'Library', 'Graph']);

function checkPrincipal(principalId) {
  if (principalId !== null &&
      (typeof principalId !== 'string' || principalId.length === 0 || principalId.length > 512)) {
    throw new TypeError('Use an account principal ID or null for local state.');
  }
}

export function createAccountStateFence() {
  let epoch = 0;
  let principalId = null;
  const tickets = new WeakSet();
  function capture() {
    const ticket = Object.freeze({ epoch, principalId });
    tickets.add(ticket);
    return ticket;
  }
  return Object.freeze({
    changePrincipal(next) {
      checkPrincipal(next);
      principalId = next;
      epoch += 1; // Also invalidate A -> logout -> A, and same-account reloads.
      return capture();
    },
    capture,
    isCurrent(ticket) {
      return Boolean(ticket && tickets.has(ticket) &&
        ticket.epoch === epoch && ticket.principalId === principalId);
    },
  });
}

export function describePersistence({ principalId = null, accountSyncReady = false } = {}) {
  checkPrincipal(principalId);
  if (typeof accountSyncReady !== 'boolean') throw new TypeError('Use an explicit sync capability.');
  const account = principalId !== null && accountSyncReady;
  return Object.freeze({
    views: PRODUCT_VIEWS,
    storage: account ? 'account' : 'device-local',
    message: account
      ? 'Account saving is enabled. Only changes confirmed as saved are in your account. Earlier browser-local data is not imported automatically.'
      : principalId !== null
        ? 'You are signed in, but account saving is not enabled. Study data is still stored only in this browser.'
        : 'Study data is stored in this browser, not in an account. Anyone using this browser profile may be able to see it.',
  });
}
