import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  getChatGPTUser,
} from './chatgpt-auth';

export const dynamic = 'force-dynamic';

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
  const user = await getChatGPTUser();
  const displayName = user ? escapeHTML(user.displayName) : '';
  const email = user ? escapeHTML(user.email) : '';
  const avatar = user ? escapeHTML(initials(user.displayName)) : '';
  const signInPath = escapeHTML(chatGPTSignInPath('/'));
  const signOutPath = escapeHTML(chatGPTSignOutPath('/'));
  // Exactly one entry is selected on the server. Anonymous guests remain
  // browser-local. Signed-in users use the durable client and fail closed when
  // D1/account activation is unavailable; no header, query or local flag can
  // switch a running browser-local workspace into account mode.
  const selectedWebsiteEntry = user
    ? '/study/integration/account-start.js'
    : '/study/js/start.js';
  const accountTrigger = user
    ? `<span class="account-avatar" aria-hidden="true">${avatar}</span>`
    : `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="3" /><path d="M4.5 16c.8-3 2.7-4.5 5.5-4.5s4.7 1.5 5.5 4.5" /></svg>`;
  const accountPanel = user
    ? `<div class="profile-row">
        <span class="profile-avatar" aria-hidden="true">${avatar}</span>
        <div><strong>${displayName}</strong><span>${email}</span></div>
      </div>
      <button class="account-menu-row" type="button" data-open-settings>Settings</button>
      <a class="account-menu-row" href="${signOutPath}" target="_top">Sign out</a>`
    : `<p class="account-note">Guest study data stays in this browser. Sign in to use an account after hosted account saving is activated.</p>
      <a class="button button-primary" href="${signInPath}" target="_top">Sign in with ChatGPT</a>
      <button class="account-menu-row" type="button" data-open-settings>Settings</button>`;

  const shell = `
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="app-shell" data-app-shell>
      <header class="topbar">
        <a class="brand" href="#study" aria-label="Meshful home">
          <svg class="brand-mark" viewBox="0 0 28 28" aria-hidden="true">
            <path d="M5 20.5 11.5 14 17 18.5 23 8" />
            <circle cx="5" cy="20.5" r="2" />
            <circle cx="11.5" cy="14" r="2" />
            <circle cx="17" cy="18.5" r="2" />
            <circle cx="23" cy="8" r="2" />
          </svg>
          <span class="brand-copy">
            <strong>Meshful</strong>
          </span>
        </a>

        <nav class="primary-nav" aria-label="Primary">
          <a href="#study" data-nav="study">Study</a>
          <a href="#decks" data-nav="decks">My Decks</a>
          <a href="#library" data-nav="library">Library</a>
        </nav>

        <div class="topbar-actions">
          <button class="account-trigger" type="button" data-action="open-account" aria-label="Open account">
            ${accountTrigger}
          </button>
        </div>
      </header>

      <main id="main" class="main" tabindex="-1">
        <div class="route-loading" data-loading role="status" aria-label="Loading study workspace">
          <div class="skeleton skeleton-title"></div>
          <div class="skeleton skeleton-card"></div>
          <div class="skeleton skeleton-row"></div>
        </div>
        <div data-view hidden></div>
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
          <span>Library</span>
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
          <h2 id="settings-title">Settings</h2>
          <button class="icon-button" type="button" data-close-settings aria-label="Close settings">×</button>
        </div>
        <div class="settings-row"><span data-storage-label>Study data</span><span data-storage-state>${user ? 'Account-backed after each confirmed save. Earlier local data is copied only after explicit confirmation into an empty account; the original remains.' : 'Saved in this browser'}</span></div>
        <button class="button button-danger" type="button" data-reset-local>Reset study data</button>
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
      <script type="module" src={selectedWebsiteEntry}></script>
    </>
  );
}
