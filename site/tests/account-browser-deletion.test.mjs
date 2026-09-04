import assert from "node:assert/strict";
import test from "node:test";

import { createAccountSessionController } from "../public/study/accounts/browser-study-session.mjs";

function storageFixture(initial = {}, { failRemoveAt = null } = {}) {
  const values = new Map(Object.entries(initial));
  let removes = 0;
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(String(key)) ?? null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) {
      removes += 1;
      if (removes === failRemoveAt) throw new Error("blocked remove");
      values.delete(String(key));
    },
  };
  return { storage, values };
}

function boundController(storage, principal = "account-A") {
  const eventTarget = new EventTarget();
  const controller = createAccountSessionController({
    siteId: "site-delete-test", storage, eventTarget, locks: null,
    nonce: (() => { let count = 0; return () => `nonce-${++count}`; })(),
    onInvalidate() {},
  });
  const bootstrap = controller.beginEpoch();
  const ticket = controller.bindPrincipal(principal, bootstrap);
  return { controller, ticket };
}

const receipt = {
  operation: "delete_my_data",
  idempotency_key: "delete-my-data:one",
  replayed: false,
};

test("account browser cleanup removes only the confirmed principal namespace and revokes the epoch", () => {
  const prefix = "meshful:accounts:v2:site-delete-test:account:";
  const { storage, values } = storageFixture({
    [`${prefix}account-A:outbox`]: "A-outbox",
    [`${prefix}account-A:cache`]: "A-cache",
    [`${prefix}account-B:outbox`]: "B-outbox",
    "unrelated:key": "keep",
  });
  const { controller, ticket } = boundController(storage);
  const removed = controller.deletePrincipalBrowserData({
    accountBinding: "account-A", ticket, receipt,
  });
  assert.equal(removed.removedKeys, 2);
  assert.equal(values.has(`${prefix}account-A:outbox`), false);
  assert.equal(values.has(`${prefix}account-A:cache`), false);
  assert.equal(values.get(`${prefix}account-B:outbox`), "B-outbox");
  assert.equal(values.get("unrelated:key"), "keep");
  assert.equal(controller.executionGuard.isCurrent(ticket), false);
  controller.dispose();
});

test("account browser cleanup restores every key after a partial storage failure", () => {
  const prefix = "meshful:accounts:v2:site-delete-test:account:account-A:";
  const initial = {
    [`${prefix}outbox`]: "A-outbox",
    [`${prefix}cache`]: "A-cache",
    [`${prefix}claim`]: "A-claim",
  };
  const { storage, values } = storageFixture(initial, { failRemoveAt: 2 });
  const { controller, ticket } = boundController(storage);
  assert.throws(() => controller.deletePrincipalBrowserData({
    accountBinding: "account-A", ticket, receipt,
  }), (error) => error?.code === "ACCOUNT_STORAGE_UNAVAILABLE");
  for (const [key, value] of Object.entries(initial)) assert.equal(values.get(key), value);
  assert.equal(controller.executionGuard.isCurrent(ticket), true,
    "a verified rollback keeps the browser session available for cleanup retry");
  controller.dispose();
});

test("browser cleanup refuses an unconfirmed or cross-account deletion receipt", () => {
  const { storage } = storageFixture();
  const { controller, ticket } = boundController(storage);
  assert.throws(() => controller.deletePrincipalBrowserData({
    accountBinding: "account-A", ticket, receipt: { ...receipt, operation: "delete_deck" },
  }), (error) => error?.code === "ACCOUNT_DELETION_RECEIPT_REQUIRED");
  assert.throws(() => controller.deletePrincipalBrowserData({
    accountBinding: "account-B", ticket, receipt,
  }), (error) => error?.code === "ACCOUNT_CHANGED");
  controller.dispose();
});
