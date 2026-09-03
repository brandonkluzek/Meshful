// Selected only by the generated server page after it verifies the signed-in
// request and both DB and ASSETS bindings. Never load it alongside the
// browser-local start.js; initializeWebsite itself rejects a second selection.
import { initializePrivateAccountWebsite } from "./account-entry.js?release=v40-learner-graph";
import { createDurableClient } from "../backend/v7/src/durable-client.mjs";
import { createStudyWriterClient, generateWriterToken } from "../backend/v7/src/writer-client.mjs";
import { createAccountSessionController } from "../accounts/browser-study-session.mjs";
import { createWebsiteAccountCatalogLoader, loadWebsiteLibrary } from "../js/library-loader.js";

try {
  const [catalogOptions, loadAccountCatalog] = await Promise.all([
    loadWebsiteLibrary({ storedStateJson: null }),
    createWebsiteAccountCatalogLoader(),
  ]);
  await initializePrivateAccountWebsite({
    createDurableClient, createStudyWriterClient, generateWriterToken, createAccountSessionController,
    siteId: "appgprj_6a9334b99f20819195ece80ebe97016b",
    baseUrl: "/api/learner/v2", catalogOptions, loadAccountCatalog,
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
