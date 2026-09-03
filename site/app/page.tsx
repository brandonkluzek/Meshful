import { env } from 'cloudflare:workers';
import Script from 'next/script';
import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  getChatGPTUser,
} from './chatgpt-auth';
import {
  accountPersistenceAllowsSubject,
  resolveAccountPersistencePolicy,
} from '../integration/account-persistence-release.mjs';

const WEBSITE_ASSET_REVISION = 'v40-learner-graph';
import { selectWebsiteEntry } from '../integration/site-selection.mjs';

export const dynamic = 'force-dynamic';

type MeshfulRuntimeBindings = {
  DB?: unknown;
  ASSETS?: unknown;
  MESHFUL_ACCOUNT_PERSISTENCE_MODE?: unknown;
  MESHFUL_ACCOUNT_ACCEPTANCE_SUBJECTS?: unknown;
};

function escapeHTML(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'A';
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export default async function Home() {
  const runtime = env as MeshfulRuntimeBindings;
  const accountPolicy = resolveAccountPersistencePolicy(
    runtime.MESHFUL_ACCOUNT_PERSISTENCE_MODE,
    runtime.MESHFUL_ACCOUNT_ACCEPTANCE_SUBJECTS,
  );
  // Private Sites already authenticate the viewer. Keep that display identity
  // separate from the stricter account-persistence gate below.
  const viewer = await getChatGPTUser();
  const candidateUser = accountPolicy.enabled ? viewer : null;
  const user = candidateUser && accountPersistenceAllowsSubject(
    runtime.MESHFUL_ACCOUNT_PERSISTENCE_MODE,
    runtime.MESHFUL_ACCOUNT_ACCEPTANCE_SUBJECTS,
    candidateUser.userId,
  ) ? candidateUser : null;
  const websiteEntry = selectWebsiteEntry({
    authenticated: user !== null,
    databaseAvailable: Boolean(runtime.DB),
    assetsAvailable: Boolean(runtime.ASSETS),
    accountPersistenceEnabled: accountPolicy.enabled,
  });
  const accountBackendUnavailable = user !== null && websiteEntry === null;
  const displayName = viewer ? escapeHTML(viewer.displayName) : '';
  const email = viewer ? escapeHTML(viewer.email) : '';
  const avatar = viewer ? escapeHTML(initials(viewer.displayName)) : '';
  const signInPath = escapeHTML(chatGPTSignInPath('/'));
  const signOutPath = escapeHTML(chatGPTSignOutPath('/'));
  const accountTrigger = viewer
    ? `<span class="account-avatar" aria-hidden="true">${avatar}</span>`
    : `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="3" /><path d="M4.5 16c.8-3 2.7-4.5 5.5-4.5s4.7 1.5 5.5 4.5" /></svg>`;
  const accountPanel = viewer
    ? `<div class="profile-row">
        <span class="profile-avatar" aria-hidden="true">${avatar}</span>
        <div><strong>${displayName}</strong><span>${email}</span></div>
      </div>
      <p class="account-auth-state"><span aria-hidden="true">✓</span> Signed in with ChatGPT</p>
      <div class="account-storage-card">
        <div><strong>Study data</strong><span data-account-storage-state>Saved in this browser</span></div>
        <p data-account-storage-note>ChatGPT sign-in identifies you, but study data does not sync between devices yet.</p>
      </div>
      <button class="account-menu-row" type="button" data-open-settings>Data &amp; privacy <span aria-hidden="true">→</span></button>
      <a class="account-menu-row" data-account-signout href="${signOutPath}" target="_top">Sign out</a>
      <p class="account-note">Signing out does not clear data saved in this browser.</p>`
    : `<div class="account-storage-card">
        <div><strong>Study data</strong><span data-account-storage-state>Saved in this browser</span></div>
        <p data-account-storage-note>Decks, reviews, and progress stay in this browser.</p>
      </div>
      <a class="button button-primary account-signin" data-account-signin href="${signInPath}" target="_top">Sign in with ChatGPT</a>
      <p class="account-note">Use a separate browser profile on a shared device.</p>
      <button class="account-menu-row" type="button" data-open-settings>Data &amp; privacy <span aria-hidden="true">→</span></button>`;
  const unavailableView = accountBackendUnavailable
    ? `<section class="page"><div class="empty-state"><div class="empty-state-inner">
        <p class="eyebrow">Account unavailable</p>
        <h2>Your saved account could not open.</h2>
        <p>Your browser data has not been changed. Reload to try again.</p>
        <div class="empty-actions"><a class="button button-secondary" href="${signOutPath}" target="_top">Sign out</a></div>
      </div></div></section>`
    : '';

  const shell = `
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="app-shell" data-app-shell>
      <header class="topbar">
        <a class="brand" href="#study" aria-label="Meshful home">
          <span class="brand-mark" aria-hidden="true"></span>
          <span class="brand-copy">
            <strong>Meshful</strong>
          </span>
        </a>

        <nav class="primary-nav" aria-label="Primary">
          <a href="#study" data-nav="study">Study</a>
          <a href="#decks" data-nav="decks">My Decks</a>
          <a href="#library" data-nav="library">Deck Library</a>
        </nav>

        <div class="topbar-actions">
          <button class="account-trigger" type="button" data-action="open-account" aria-label="Open account">
            ${accountTrigger}
          </button>
        </div>
      </header>

      <main id="main" class="main" tabindex="-1">
        <div class="route-loading" data-loading role="status" aria-label="Loading study workspace"${accountBackendUnavailable ? ' hidden' : ''}>
          <div class="skeleton skeleton-title"></div>
          <div class="skeleton skeleton-card"></div>
          <div class="skeleton skeleton-row"></div>
        </div>
        <div data-view${accountBackendUnavailable ? '' : ' hidden'}>${unavailableView}</div>
      </main>

      <nav class="mobile-nav" aria-label="Mobile primary">
        <a href="#study" data-nav="study">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3.5h9a2 2 0 0 1 2 2v11H6a2 2 0 0 1-2-2v-11Z" /><path d="M7 7h5M7 10h5" /></svg>
          <span>Study</span>
        </a>
        <a href="#decks" data-nav="decks">
          <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="5" width="14" height="11" rx="2" /><path d="M6 5V3h8v2" /></svg>
          <span>My Decks</span>
        </a>
        <a href="#library" data-nav="library">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 4.5a2 2 0 0 1 2-2H9v14H5.5a2 2 0 0 0-2 1.5V4.5ZM16.5 4.5a2 2 0 0 0-2-2H11v14h3.5a2 2 0 0 1 2 1.5V4.5Z" /></svg>
          <span>Deck Library</span>
        </a>
      </nav>
    </div>

    <dialog class="sheet-dialog" data-deck-dialog aria-labelledby="deck-dialog-title">
      <div data-deck-dialog-content></div>
    </dialog>

    <dialog class="account-dialog" data-account-dialog aria-labelledby="account-title">
      <div class="account-panel">
        <div class="dialog-header-compact">
          <h2 id="account-title">Account</h2>
          <button class="icon-button" type="button" data-close-account aria-label="Close account">×</button>
        </div>
        ${accountPanel}
      </div>
    </dialog>

    <dialog class="account-dialog" data-settings-dialog aria-labelledby="settings-title">
      <div class="account-panel">
        <div class="dialog-header-compact">
          <h2 id="settings-title">Data &amp; privacy</h2>
          <button class="icon-button" type="button" data-close-settings aria-label="Close settings">×</button>
        </div>
        <section class="settings-section" aria-label="Study data">
          <div class="settings-row"><span data-storage-label>Study data</span><span data-storage-state>Saved in this browser</span></div>
          <p class="account-note" data-storage-note>Decks, reviews, and progress stay in this browser and do not sync between devices yet.</p>
          <button class="button button-danger" type="button" data-reset-local>Reset study data</button>
          <p class="account-note">Your full chat is not copied into Meshful.</p>
        </section>
      </div>
    </dialog>

    <div class="toast-region" role="status" aria-live="polite" aria-atomic="true" data-toasts></div>
  `;

  return (
    <>
      <div
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: shell }}
      />
      {websiteEntry ? (
        <Script
          id="meshful-study-entry"
          type="module"
          src={`${websiteEntry}?release=${WEBSITE_ASSET_REVISION}`}
          strategy="afterInteractive"
        />
      ) : null}
    </>
  );
}
