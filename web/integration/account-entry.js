import { initializeWebsite } from "../js/app.js";
import { createAccountSnapshotHydrator } from "../js/account-snapshot.js";
import { createLocalClaimSource } from "../js/local-claim-source.js";

// Called only by a separately approved, server-selected private wrapper entry.
// The normal start.js does not import/call this entry. Factories are the exact
// delivered browser-safe Backend and Accounts exports; no remote SDK is used.
export function initializePrivateAccountWebsite({ createDurableClient, createAccountStorageController,
  siteId, release, baseUrl = "/api/learner/v1", localSourceRelease = null,
  fetchImpl = globalThis.fetch, storage = globalThis.localStorage, locks = globalThis.navigator?.locks,
  eventTarget = globalThis.window } = {}) {
  const sameRelease = (ref, expected) => ref?.version === expected?.version && ref?.digest === expected?.digest;
  if (!release?.catalog || !release.version || !release.digest) throw new Error("An exact admitted catalog release is required.");
  const hydrateSnapshot = createAccountSnapshotHydrator((ref, { empty }) => {
    if (!(ref === null && empty) && !sameRelease(ref, release)) throw new Error("The account requires a different exact catalog release. No content was substituted.");
    return release.catalog;
  });
  return initializeWebsite({ accountOptions: {
    createDurableClient, createStorageController: createAccountStorageController, hydrateSnapshot,
    storageOptions: { siteId, storage, locks, eventTarget }, fetchImpl, baseUrl,
    localClaimSource: localSourceRelease ? createLocalClaimSource({ siteId, storage, locks,
      catalogRef: { version: localSourceRelease.version, digest: localSourceRelease.digest } }) : null,
  } });
}
