import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { accountSiteConfig, createPreparedSiteEndpoint, learnerEndpoint } from "../integration/site-runtime.mjs";
import {
  ACCOUNT_WEBSITE_ENTRY,
  LOCAL_WEBSITE_ENTRY,
  selectWebsiteEntry,
} from "../integration/site-selection.mjs";
import {
  ACCOUNT_ACCEPTANCE_SUBJECTS_ENV_KEY,
  ACCOUNT_PERSISTENCE_ENV_KEY,
  ACCOUNT_PERSISTENCE_MODES,
  accountPersistenceAllowsSubject,
  isAccountPersistenceEnabled,
  resolveAccountAcceptanceSubject,
  resolveAccountAcceptanceSubjects,
  resolveAccountPersistenceMode,
  resolveAccountPersistencePolicy,
} from "../integration/account-persistence-release.mjs";
import { createTrustedSitesAuthenticator } from "../integration/accounts/sites-trusted-request.mjs";
import {
  LIBRARY_EXPECTED_PINS,
  LIBRARY_RELEASE,
  LIBRARY_RESOLUTION_BUDGET,
  PREVIOUS_LIBRARY_RELEASE,
  RETAINED_LIBRARY_RELEASE,
} from "../integration/library-runtime.mjs";

test("the generated server owns the mutually exclusive browser entry selection", async () => {
  for (const authenticated of [false, true]) for (const databaseAvailable of [false, true]) {
    for (const assetsAvailable of [false, true]) {
      assert.equal(selectWebsiteEntry({ authenticated, databaseAvailable, assetsAvailable }), LOCAL_WEBSITE_ENTRY);
      assert.equal(selectWebsiteEntry({ authenticated, databaseAvailable, assetsAvailable,
        accountPersistenceEnabled: false }), LOCAL_WEBSITE_ENTRY);
    }
  }
  assert.equal(selectWebsiteEntry({ authenticated: false, databaseAvailable: true, assetsAvailable: true,
    accountPersistenceEnabled: true }), LOCAL_WEBSITE_ENTRY);
  assert.equal(selectWebsiteEntry({ authenticated: true, databaseAvailable: true, assetsAvailable: true,
    accountPersistenceEnabled: true }), ACCOUNT_WEBSITE_ENTRY);
  assert.equal(selectWebsiteEntry({ authenticated: true, databaseAvailable: false, assetsAvailable: true,
    accountPersistenceEnabled: true }), null);
  assert.equal(selectWebsiteEntry({ authenticated: true, databaseAvailable: true, assetsAvailable: false,
    accountPersistenceEnabled: true }), null);
  assert.equal(selectWebsiteEntry({ authenticated: true, databaseAvailable: false, assetsAvailable: false,
    accountPersistenceEnabled: true }), null);
  assert.throws(() => selectWebsiteEntry({ authenticated: "yes", databaseAvailable: true,
    assetsAvailable: true, accountPersistenceEnabled: true }), TypeError);
  const config = JSON.parse(await readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"));
  assert.equal(config.d1, "DB");
  assert.equal(config.r2, null);
  const page = (await readFile(new URL("../app/page.tsx", import.meta.url), "utf8")).toString();
  assert.match(page, /selectWebsiteEntry\(\{/);
  assert.match(page, /const viewer = await getChatGPTUser\(\)/);
  assert.match(page, /const candidateUser = accountPolicy\.enabled \? viewer : null/);
  assert.match(page, /accountPersistenceAllowsSubject\(/);
  assert.match(page, /authenticated:\s*user !== null/);
  assert.match(page, /databaseAvailable:\s*Boolean\(runtime\.DB\)/);
  assert.match(page, /assetsAvailable:\s*Boolean\(runtime\.ASSETS\)/);
  assert.match(page, /accountPersistenceEnabled:\s*accountPolicy\.enabled/);
  assert.match(page, /MESHFUL_ACCOUNT_ACCEPTANCE_SUBJECTS/);
  assert.match(page, /import Script from 'next\/script'/);
  assert.match(page, /id="meshful-study-entry"/);
  assert.match(page, /type="module"/);
  assert.match(page, /const WEBSITE_ASSET_REVISION = 'v72-guest-study-reset'/);
  assert.match(page, /src=\{`\$\{websiteEntry\}\?release=\$\{WEBSITE_ASSET_REVISION\}`\}/);
  assert.match(page, /strategy="afterInteractive"/);
  assert.doesNotMatch(page, /<script\s+type=["']module["']/);
  assert.match(page, /accountBackendUnavailable/);
  assert.match(page, /Your browser data has not been changed[\s\S]*Sign out/);
  assert.doesNotMatch(page, /URLSearchParams|localStorage|document\.cookie/);
  assert.match(page, /data-storage-label/);
  assert.match(page, /data-storage-note/);
  assert.match(page, /Signed in with ChatGPT/);
  assert.match(page, /Checking account…/);
  assert.match(page, /Confirming your saved decks and progress\./);
  assert.match(page, /Decks, reviews, and progress stay in this browser\./);
  assert.doesNotMatch(page, /Signing out does not clear data saved in this browser\./);
  assert.match(page, /Use a separate browser profile on a shared device\./);
  assert.match(page, /Data &amp; privacy/);
  assert.match(page, /Delete my data/);
  assert.match(page, /Your full chat is not copied into Meshful\./);
  assert.doesNotMatch(page, /Working with your agent/);
  assert.match(page, /chatGPTSignOutPath\('\/'\)/);
  assert.match(page, /data-account-signout[^>]*>Sign out</);
  assert.doesNotMatch(page, /Study progress is saved in this browser on this device\./);
  assert.equal((page.match(/>Deck Library</g) ?? []).length, 2);
  assert.match(page, /chatGPTSignInPath\('\/'\)/);
  assert.match(page, /data-account-signin[^>]*>Sign in with ChatGPT</);
  assert.doesNotMatch(page, /Connecting…|safely saved to your account|available on every device/i);
  const app = await readFile(new URL("../public/study/js/app.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/study/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(app, /accountDialog\.innerHTML/);
  assert.match(app, /function markAccountStorageSaved\(status\)/);
  assert.match(app, /function markAccountStorageNeedsAttention\(status\)/);
  assert.match(app, /account-save-check/);
  assert.match(app, /<h2 id="settings-title">Data &amp; privacy<\/h2>/);
  assert.match(app, /data-storage-state><span class="account-save-check"/);
  assert.match(app, /Decks, reviews, and progress stay in this browser\. ChatGPT sign-in identifies you, but study data does not sync between devices yet\./);
  const accountSettings = app.match(/function showAccountSettings\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(accountSettings, "signed-in settings remain available");
  assert.doesNotMatch(accountSettings, /data-reset-local/);
  assert.match(accountSettings, /account-save-status/);
  assert.match(accountSettings, />Saved to account<\/span>/);
  assert.doesNotMatch(accountSettings, /Synced|sync between devices/i);
  assert.doesNotMatch(accountSettings, /Copy browser data to account|Recover saved action|Recover browser-data copy/);
  assert.match(accountSettings, /data-open-pending-account-action/);
  assert.match(accountSettings, /Browser data/);
  assert.match(accountSettings, /Account change/);
  assert.match(accountSettings, /Add to account/);
  assert.match(accountSettings, /Try saving again/);
  assert.match(css, /\.account-storage-card\.needs-account-save\s*\{[^}]*border-color:\s*#4b5059;/s);
  assert.doesNotMatch(css, /\.account-storage-card\.needs-account-save\s*\{[^}]*linear-gradient/s);
  assert.match(css, /\.account-save-attention\s*\{[^}]*color:\s*#c7cbd2 !important;/s);
  assert.match(css, /\.account-attention-dot\s*\{[^}]*background:\s*#9aa0aa;/s);
  assert.doesNotMatch(css, /\.account-save-attention\s*\{[^}]*#e7c77d/s);
  assert.match(accountSettings, /<h3>Data deletion<\/h3>/);
  assert.match(accountSettings, /data-request-delete-account>Delete my data<\/button>/);
  assert.match(accountSettings, /This permanently removes your Meshful decks, reviews, sessions, progress/);
  assert.match(accountSettings, /does not delete your ChatGPT account/);
  const claimOffer = app.match(/function showLocalClaimOffer\(preview\) \{([\s\S]*?)\n\}/)?.[1];
  const claimCheck = app.match(/async function offerLocalClaimIfAvailable\(context\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(claimOffer, "guest-data offer remains a focused account prompt");
  assert.ok(claimCheck, "guest data and empty account are checked before prompting");
  assert.match(claimOffer, /Browser study data found/);
  assert.match(claimOffer, /studied in this browser before signing in/);
  assert.match(claimOffer, /not in your account/);
  assert.match(claimOffer, /without replacing anything or removing the browser copy/);
  assert.match(claimOffer, /Add to account/);
  assert.match(claimCheck, /context\.session\.previewLocalClaim\(\)/);
  assert.match(claimCheck, /if \(recovery\.claim \|\| recovery\.command\) return/);
  assert.doesNotMatch(claimCheck, /showPendingAccountAction/);
  assert.match(app, /Finish adding browser study data/);
  assert.match(app, /Account change needs confirmation/);
  assert.match(app, /could not confirm whether the decks and progress from this browser were added after you signed in/);
  assert.match(app, /could not confirm that your last account change was saved/);
  const fatal = app.slice(app.indexOf("function showFatal(error)"), app.indexOf("function queueRender"));
  assert.match(fatal, /Oops, something went wrong\./);
  assert.match(fatal, /Try again to open your study workspace\./);
  assert.doesNotMatch(fatal, /Reconnect account|error\?\.message|qualified working set/);
  assert.match(app, /await finishStartup\(\);\s*await offerLocalClaimIfAvailable\(captureView\(\)\);/);
  assert.doesNotMatch(app, /Copy browser data to account|Recover saved action|Recover browser-data copy/);
  assert.match(app, /Reset study data\?/);
  assert.match(app, /Your decks, reviews, progress, and saved graph layouts will be cleared from this browser/);
  assert.doesNotMatch(app, /Working with your agent/);
  assert.doesNotMatch(app, /Changes appear after they are safely saved to your account\./);
  assert.match(app, /function syncLocalStorageUI\(\)/);
  assert.match(app, /workspace\.ephemeral \? "Temporary" : "Saved in this browser"/);
  assert.match(app, /This example is temporary and is not saved after reload\./);
  const [styles, mark] = await Promise.all([
    readFile(new URL("../public/study/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/meshful-header-mark.svg", import.meta.url), "utf8"),
  ]);
  assert.match(styles, /\.brand-mark\s*\{[^}]*width:\s*42px;[^}]*height:\s*42px;/s);
  assert.match(styles, /\.brand-copy strong\s*\{[^}]*font-size:\s*20px;/s);
  assert.equal([...mark.matchAll(/<use href="#arrow"/g)].length, 2);
  assert.match(mark, /r="1\.65"/);
  assert.match(mark, /r="1\.75"/);
});

test("account persistence has a strict default-closed server policy and exact private cohort", () => {
  assert.equal(ACCOUNT_PERSISTENCE_ENV_KEY, "MESHFUL_ACCOUNT_PERSISTENCE_MODE");
  assert.equal(ACCOUNT_ACCEPTANCE_SUBJECTS_ENV_KEY, "MESHFUL_ACCOUNT_ACCEPTANCE_SUBJECTS");
  for (const value of [undefined, null, "", "closed", "true", "PRIVATE_ACCEPTANCE",
    "private_acceptance ", "released ", true, 1]) {
    assert.equal(resolveAccountPersistenceMode(value), ACCOUNT_PERSISTENCE_MODES.CLOSED);
    assert.equal(isAccountPersistenceEnabled(value), false);
  }
  assert.equal(resolveAccountPersistenceMode("private_acceptance"),
    ACCOUNT_PERSISTENCE_MODES.PRIVATE_ACCEPTANCE);
  assert.equal(resolveAccountPersistenceMode("released"), ACCOUNT_PERSISTENCE_MODES.RELEASED);
  assert.equal(isAccountPersistenceEnabled("private_acceptance"), false);

  for (const value of [undefined, null, "", " person-A", "person-A ", "a,b", "a@b.example",
    "line\nbreak", true, 1, {}]) assert.equal(resolveAccountAcceptanceSubject(value), null);
  assert.equal(resolveAccountAcceptanceSubject("sites-user-A"), "sites-user-A");

  assert.deepEqual(resolveAccountAcceptanceSubjects('["sites-user-A","sites-user-B"]'),
    ["sites-user-A", "sites-user-B"]);
  for (const value of [undefined, null, "", "sites-user-A", "[]", "{}",
    '["sites-user-A","sites-user-A"]', '["user@example.invalid"]', '["sites-user-A",1]']) {
    assert.deepEqual(resolveAccountAcceptanceSubjects(value), []);
  }

  const privateSubjects = '["sites-user-A","sites-user-B"]';
  assert.deepEqual(resolveAccountPersistencePolicy("private_acceptance", privateSubjects), {
    mode: "private_acceptance", enabled: true, acceptanceSubjects: ["sites-user-A", "sites-user-B"],
    allowProvisioning: true,
  });
  assert.deepEqual(resolveAccountPersistencePolicy("released", "ignored-user"), {
    mode: "released", enabled: true, acceptanceSubjects: [], allowProvisioning: true,
  });
  assert.deepEqual(resolveAccountPersistencePolicy("private_acceptance", "a@b.example"), {
    mode: "private_acceptance", enabled: false, acceptanceSubjects: [],
    allowProvisioning: false,
  });
  assert.equal(accountPersistenceAllowsSubject("private_acceptance", privateSubjects, "sites-user-A"), true);
  assert.equal(accountPersistenceAllowsSubject("private_acceptance", privateSubjects, "sites-user-B"), true);
  assert.equal(accountPersistenceAllowsSubject("private_acceptance", privateSubjects, "sites-user-C"), false);
  assert.equal(accountPersistenceAllowsSubject("private_acceptance", privateSubjects, "SITES-USER-A"), false);
  assert.equal(accountPersistenceAllowsSubject("private_acceptance", undefined, "sites-user-A"), false);
  assert.equal(accountPersistenceAllowsSubject("released", undefined, "sites-user-A"), true);
  assert.equal(accountPersistenceAllowsSubject("released", undefined, "user@example.invalid"), false);
});

test("forged identity fields, origin and URL switches cannot activate learner endpoints", async () => {
  for (const method of ["GET", "POST"]) for (const path of ["state", "commands", "claims", "receipts/example", "reviews"]) {
    const request = new Request(`https://meshful.ai/api/learner/v2/${path}?account=true`, { method,
      headers: { "oai-authenticated-user-id": "forged", "oai-authenticated-user-email": "forged@example.invalid",
        Host: "meshful.ai", Origin: "https://meshful.ai", "X-Meshful-Account": "arbitrary" },
      ...(method === "POST" ? { body: '{}' } : {}),
    });
    const response = await learnerEndpoint.handle(request);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "ACCOUNT_SYNC_DISABLED");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await learnerEndpoint.canSelectAccountEntry(request), false);
  }
  let databaseReads = 0;
  let assetFetches = 0;
  const database = new Proxy({}, {
    get() { databaseReads += 1; throw new Error("Default-denied requests must not touch D1."); },
  });
  const assets = { fetch() { assetFetches += 1; throw new Error("Closed requests must not load Library assets."); } };
  const endpoint = createPreparedSiteEndpoint({ database, assets, activation: null });
  for (const method of ["GET", "POST"]) {
    for (const path of ["state", "commands", "claims", "receipts/example", "reviews", "documents/example", "recovery", "unknown"]) {
      const response = await endpoint.handle(new Request(`https://meshful.ai/api/learner/v2/${path}`, {
        method,
        headers: {
          "oai-authenticated-user-id": "forged",
          origin: "https://meshful.ai",
          cookie: "account=true",
          "x-meshful-account": "forged",
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      }));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { ok: false, error: {
        code: "ACCOUNT_SYNC_DISABLED",
        message: "Account-backed storage is not enabled for this build.",
      } });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    }
  }
  assert.equal(databaseReads, 0);
  assert.equal(assetFetches, 0);
});

test("the selected Accounts successor stays closed without platform request provenance", async () => {
  let lookups = 0;
  const authenticate = createTrustedSitesAuthenticator({
    siteId: "appgprj_6a9334b99f20819195ece80ebe97016b",
    allowedOrigins: ["https://meshful.ai"],
    findPrincipalByIdentity: async () => { lookups += 1; return null; },
  });
  const forged = new Request("https://meshful.ai/api/learner/v2/state", {
    headers: {
      "oai-authenticated-user-id": "forged",
      "oai-authenticated-user-email": "forged@example.invalid",
      host: "meshful.ai",
    },
  });
  await assert.rejects(authenticate(forged), (error) =>
    error?.code === "auth_not_configured" && error?.status === 503);
  assert.equal(lookups, 0);
});

test("legacy ingress predicates cannot compose or select account-backed storage", async () => {
  let databaseReads = 0;
  const database = new Proxy({}, {
    get() { databaseReads += 1; throw new Error("Legacy activation must not touch D1."); },
  });
  const endpoint = createPreparedSiteEndpoint({
    database,
    activation: {
      siteId: "appgprj_6a9334b99f20819195ece80ebe97016b",
      allowedOrigins: ["https://meshful.ai"],
      isTrustedIngress: async () => true,
    },
  });
  const request = new Request("https://meshful.ai/api/learner/v2/state", {
    headers: { "oai-authenticated-user-id": "forged", host: "meshful.ai" },
  });
  const response = await endpoint.handle(request);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "ACCOUNT_SYNC_DISABLED");
  assert.equal(await endpoint.canSelectAccountEntry(request), false);
  assert.equal(databaseReads, 0);
});

test("server composition selects the atomic trusted-request adapter only", async () => {
  const runtime = await readFile(new URL("../integration/site-runtime.mjs", import.meta.url), "utf8");
  const endpoint = await readFile(new URL("../integration/website/learner-endpoint.mjs", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/learner/[...path]/route.ts", import.meta.url), "utf8");
  assert.match(runtime, /sites-trusted-request\.mjs/);
  assert.match(runtime, /createTrustedSitesAuthenticator/);
  assert.doesNotMatch(runtime, /accounts\/sites\.mjs|createSitesAuthenticator/);
  assert.match(endpoint, /resolveTrustedSitesRequest/);
  assert.doesNotMatch(endpoint, /isTrustedIngress/);
  assert.match(route, /const user = await getChatGPTUser\(\)/);
  assert.match(route, /subject:\s*user\.userId/);
  assert.doesNotMatch(route, /subject:\s*user\.(?:email|displayName|fullName)/);
  assert.match(route, /accountPersistenceAllowsSubject\([\s\S]*user\.userId/);
  assert.match(route, /MESHFUL_ACCOUNT_ACCEPTANCE_SUBJECTS/);
  assert.match(route, /activation:\s*accountPolicy\.enabled[\s\S]*allowProvisioning:\s*accountPolicy\.allowProvisioning[\s\S]*resolveTrustedSitesRequest[\s\S]*: null/);
  assert.deepEqual(accountSiteConfig, {
    siteId: "appgprj_6a9334b99f20819195ece80ebe97016b",
    allowedOrigins: ["https://meshful.ai"],
    allowProvisioning: false,
  });
});

test("the trusted resolver provisions only the verified Sites subject", async () => {
  let resolverCalls = 0;
  let lookupCalls = 0;
  let provisionCalls = 0;
  let binding = null;
  const authenticate = createTrustedSitesAuthenticator({
    ...accountSiteConfig,
    allowProvisioning: true,
    resolveTrustedSitesRequest: async () => {
      resolverCalls += 1;
      return { trusted: true, authenticated: true, subject: "sites-user-A" };
    },
    findPrincipalByIdentity: async (identity) => {
      lookupCalls += 1;
      assert.deepEqual(identity, {
        provider: "sites-chatgpt",
        issuer: `urn:meshful:sites:${accountSiteConfig.siteId}`,
        subject: "sites-user-A",
      });
      return binding;
    },
    provisionPrincipalForVerifiedIdentity: async (identity) => {
      provisionCalls += 1;
      assert.equal(identity.subject, "sites-user-A");
      binding = { principalId: "principal-A" };
      return binding;
    },
  });
  const context = await authenticate(new Request("https://meshful.ai/api/learner/v2/state", {
    headers: {
      "oai-authenticated-user-id": "forged-B",
      "oai-authenticated-user-email": "forged@example.invalid",
    },
  }));
  assert.equal(context.principalId, "principal-A");
  assert.equal(context.identity.subject, "sites-user-A");
  assert.equal(resolverCalls, 1);
  assert.equal(lookupCalls, 2);
  assert.equal(provisionCalls, 1);
});

test("anonymous and bearer requests fail before identity lookup or provisioning", async () => {
  let resolverCalls = 0;
  let lookups = 0;
  let provisions = 0;
  const authenticate = createTrustedSitesAuthenticator({
    ...accountSiteConfig,
    resolveTrustedSitesRequest: async () => {
      resolverCalls += 1;
      return { trusted: true, authenticated: false };
    },
    findPrincipalByIdentity: async () => { lookups += 1; return null; },
    provisionPrincipalForVerifiedIdentity: async () => { provisions += 1; return null; },
  });
  await assert.rejects(
    authenticate(new Request("https://meshful.ai/api/learner/v2/state")),
    (error) => error?.code === "authentication_required" && error?.status === 401,
  );
  assert.equal(resolverCalls, 1);
  assert.equal(lookups, 0);
  assert.equal(provisions, 0);
  await assert.rejects(
    authenticate(new Request("https://meshful.ai/api/learner/v2/state", {
      headers: { authorization: "Bearer forged" },
    })),
    (error) => error?.code === "invalid_credentials" && error?.status === 401,
  );
  assert.equal(resolverCalls, 1);
  assert.equal(lookups, 0);
  assert.equal(provisions, 0);
});

test("the account constructor selects the sanitized public Deck Library while retaining prior exact bases", async () => {
  assert.equal(LIBRARY_RELEASE, "2026-09-03.public-sanitized.v4");
  assert.equal(LIBRARY_EXPECTED_PINS.constructorRef.digest,
    "sha256:ce0589f4055dd2cf45a07601eaec0ec71107c62683289e1b0a54417d9480e859");
  assert.equal(PREVIOUS_LIBRARY_RELEASE, "2026-09-02.public-sanitized.v3");
  assert.equal(RETAINED_LIBRARY_RELEASE, "2026-08-30.reviewed-72.v1");
  assert.deepEqual(LIBRARY_RESOLUTION_BUDGET, {
    max_decks: 42, max_cards: 5_500, max_raw_chunk_bytes: 7_000_000,
  });
  const runtime = await readFile(new URL("../integration/site-runtime.mjs", import.meta.url), "utf8");
  const accountStart = await readFile(new URL("../public/study/integration/account-start.js", import.meta.url), "utf8");
  const accountEntry = await readFile(new URL("../public/study/integration/account-entry.js", import.meta.url), "utf8");
  const catalogLoader = await readFile(new URL("../public/study/js/library-loader.js", import.meta.url), "utf8");
  assert.match(runtime, /backend\/v7\/src\/index\.mjs/);
  assert.match(runtime, /createReviewedLibraryResolver/);
  assert.doesNotMatch(runtime, /core\/data\/catalog\.js|catalogReleases|defaultCatalogVersion/);
  assert.match(accountStart, /loadWebsiteLibrary/);
  assert.match(accountStart, /createWebsiteAccountCatalogLoader/);
  assert.match(accountStart, /catalogOptions, loadAccountCatalog/);
  assert.match(accountStart, /account-entry\.js\?release=v72-guest-study-reset/);
  assert.match(accountEntry, /js\/app\.js\?release=v72-guest-study-reset/);
  assert.match(accountEntry, /loadAccountCatalog\(\{[\s\S]*storedStateJson,[\s\S]*constructorCatalogRef:[\s\S]*check,/);
  assert.match(catalogLoader, /prepareLibraryCatalogResolver/);
  assert.match(catalogLoader, /intent:\s*\{ kind: "query", operation: "hydrate_confirmed_state", args: \{\} \}/);
  const accountLoader = catalogLoader.slice(catalogLoader.indexOf("export async function createWebsiteAccountCatalogLoader"));
  assert.doesNotMatch(accountLoader, /LEGACY_EXAMPLES/);
  assert.doesNotMatch(accountStart, /data\/catalog\.js|CATALOG/);
});

test("offline math styling is shipped locally and the correct initialization entry is available", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /\/study\/vendor\/katex\/katex.min.css/);
  assert.match(layout, /<body suppressHydrationWarning>/);
  const entry = await readFile(new URL("../public/study/js/start.js", import.meta.url), "utf8");
  assert.match(entry, /await initializeWebsite\(\)/);
  assert.match(entry, /app\.js\?release=v72-guest-study-reset/);
  assert.doesNotMatch(entry, /account-start|createDurableClient/);
  const accountEntry = await readFile(new URL("../public/study/integration/account-start.js", import.meta.url), "utf8");
  assert.match(accountEntry, /initializePrivateAccountWebsite/);
  assert.match(accountEntry, /baseUrl:\s*"\/api\/learner\/v2"/);
  assert.match(accountEntry, /backend\/v7\/src\/durable-client\.mjs/);
  assert.match(accountEntry, /backend\/v7\/src\/writer-client\.mjs/);
  assert.match(accountEntry, /createStudyWriterClient, generateWriterToken/);
  assert.doesNotMatch(accountEntry, /from\s+["'][^"']*start\.js["']|createBrowserWorkspace/);
});
