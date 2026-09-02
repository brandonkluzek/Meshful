// Dormant: the wrapper does not select this entry. Never load it alongside the
// browser-local start.js; initializeWebsite itself rejects a second selection.
import { initializePrivateAccountWebsite } from "./account-entry.js";
import { createDurableClient } from "../backend/v2/src/durable-client.mjs";
import { createAccountStorageController } from "../accounts/browser-storage.mjs";
import { CATALOG } from "../data/catalog.js";
import { catalogRelease } from "./catalog-release.mjs";

try {
  const release = { ...catalogRelease, catalog: CATALOG };
  await initializePrivateAccountWebsite({
    createDurableClient, createAccountStorageController,
    siteId: "appgprj_6a9334b99f20819195ece80ebe97016b",
    baseUrl: "/api/learner/v2", release, localSourceRelease: release,
  });
} catch {
  // Configuration/storage failure must not seed or silently open a local store.
  const loading = document.querySelector("[data-loading]");
  const view = document.querySelector("[data-view]");
  if (loading) loading.hidden = true;
  if (view) {
    view.hidden = false;
    view.textContent = "Account access is unavailable. Your saved data has not been changed. Reload to try again.";
  }
}
