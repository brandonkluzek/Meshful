export const LOCAL_WEBSITE_ENTRY = "/study/js/start.js";
export const ACCOUNT_WEBSITE_ENTRY = "/study/integration/account-start.js";

// Only the generated server page supplies these booleans. Query parameters,
// cookies, browser storage and display-only profile fields never select the
// account-backed mutation path.
/**
 * @param {{ authenticated: boolean, databaseAvailable: boolean, assetsAvailable: boolean,
 *   accountPersistenceEnabled?: boolean }} options
 */
export function selectWebsiteEntry({ authenticated, databaseAvailable, assetsAvailable,
  accountPersistenceEnabled = false } = {}) {
  if (![authenticated, databaseAvailable, assetsAvailable, accountPersistenceEnabled]
    .every((value) => typeof value === "boolean")) {
    throw new TypeError("Website entry selection requires server-owned readiness flags.");
  }
  if (!accountPersistenceEnabled || !authenticated) return LOCAL_WEBSITE_ENTRY;
  return databaseAvailable && assetsAvailable ? ACCOUNT_WEBSITE_ENTRY : null;
}
