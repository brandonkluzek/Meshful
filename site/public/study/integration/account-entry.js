import { initializeWebsite } from "../js/app.js?release=v43-real-progress-graph";
import { createAccountSnapshotHydrator } from "../js/account-snapshot.js";
import { createLocalClaimSource } from "../js/local-claim-source.js";

// Called only by a separately approved, server-selected private wrapper entry.
// The normal start.js does not import/call this entry. Factories are the exact
// delivered browser-safe Backend and Accounts exports; no remote SDK is used.
export function initializePrivateAccountWebsite({ createDurableClient, createStudyWriterClient,
  generateWriterToken, createAccountSessionController,
  siteId, catalogOptions, loadAccountCatalog, baseUrl = "/api/learner/v1",
  fetchImpl = globalThis.fetch, storage = globalThis.localStorage, locks = globalThis.navigator?.locks,
  eventTarget = globalThis.window } = {}) {
  const sameRelease = (ref, expected) => ref?.version === expected?.version && ref?.digest === expected?.digest;
  const constructorCatalogRef = catalogOptions?.constructorCatalogRef;
  const constructorCatalogRefs = catalogOptions?.constructorCatalogRefs ?? [constructorCatalogRef];
  const admittedRelease = (ref) => constructorCatalogRefs.some((expected) => sameRelease(ref, expected));
  if (!catalogOptions?.catalog || !constructorCatalogRef?.version || !constructorCatalogRef?.digest
      || !Array.isArray(constructorCatalogRefs) || !constructorCatalogRefs.length
      || typeof loadAccountCatalog !== "function") {
    throw new Error("An exact admitted catalog release is required.");
  }
  const hydrateSnapshot = createAccountSnapshotHydrator(async (ref, { empty, storedStateJson, check }) => {
    if (!(ref === null && empty) && !admittedRelease(ref)) {
      throw new Error("The account requires a different exact catalog release. No content was substituted.");
    }
    check();
    const selectedRef = ref ?? constructorCatalogRef;
    const resolved = await loadAccountCatalog({
      storedStateJson,
      constructorCatalogRef: selectedRef,
      check,
    });
    check();
    if (!sameRelease(resolved?.constructorCatalogRef, selectedRef)
        || !resolved?.catalog || !Array.isArray(resolved.retainedCatalogs)) {
      throw new Error("The account requires a different exact catalog release. No content was substituted.");
    }
    return resolved;
  });
  return initializeWebsite({ accountOptions: {
    createDurableClient, createStudyWriterClient, generateWriterToken,
    createSessionController: createAccountSessionController, hydrateSnapshot,
    storageOptions: { siteId, storage, locks, eventTarget }, fetchImpl, baseUrl,
    localClaimSource: createLocalClaimSource({ siteId, storage, locks, catalogRef: constructorCatalogRef }),
  }, catalogOptions });
}
