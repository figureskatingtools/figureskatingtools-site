/**
 * Shared app shell — auth gate, sign-in view and user menu.
 * Used by main.ts and by the other pages of the site so the
 * gate and the signed-in chrome stay identical everywhere.
 */

/** Escape HTML */
/**
 * Escape for HTML text **and** quoted attribute values: the pages interpolate
 * names, e-mails and file names into `title="…"`/`data-*="…"` too, and an
 * e-mail may legally contain a quote, so quotes are always escaped.
 */
export function escapeHtml(str: string): string {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Same as `escapeHtml`; kept as the explicit name for attribute values */
export const escapeAttr = escapeHtml;

/** The signed-in user, as reported by the router's `/userinfo` endpoint */
export interface UserInfo {
  authenticated: true;
  userId: string;
  identityProvider: string;
  userDetails: string;
  /** Display name from the principal's name claim; '' when unknown */
  name: string;
  userRoles: string[];
  /** The router lists this user as an admin (shows the Admin panel link) */
  isAdmin: boolean;
}

/**
 * Sign-in URL. The router's `/signin` redirects to the identity provider's
 * Easy Auth login, so a provider change (Entra External ID) never touches the
 * frontends.
 *
 * `appPath` is where the user lands after the round-trip, so each app passes
 * its own path (`/judgepapers/`, `/tools/banner/`, …) and login returns into it.
 */
export function loginUrl(appPath = '/'): string {
  return `/signin?return=${encodeURIComponent(appPath)}`;
}

/** Sign-out URL for App Service Easy Auth */
export function logoutUrl(redirectPath = '/'): string {
  return `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(redirectPath)}`;
}

/**
 * Set by `fetchUser` when the router refused the signed-in account itself:
 * 403 `tenant_not_allowed` = an Entra account from an organisation that is not
 * on the site's tenant allow-list. Signing in again with the same account
 * cannot help, so the sign-in views explain that instead of offering Sign In.
 */
let tenantBlocked = false;

/** The router's public "no access yet" page (server.js NO_ACCESS_PATH). */
const NO_ACCESS_PATH = '/no-access/';

/** True when the last `fetchUser` hit 403 `tenant_not_allowed` */
export function isTenantBlocked(): boolean {
  return tenantBlocked;
}

/**
 * Check auth via the router's `/userinfo` endpoint, which flattens the Easy
 * Auth `x-ms-client-principal` header into `{authenticated, userId, …}`.
 * Returns null when unauthenticated or when the call fails — and also for an
 * account from a tenant the site does not allow (then `isTenantBlocked()`).
 * An External ID account without the access role (403 `access_not_granted`)
 * is sent to /no-access/ and the promise never settles.
 */
export async function fetchUser(): Promise<UserInfo | null> {
  tenantBlocked = false;
  try {
    const resp = await fetch('/userinfo', { headers: { Accept: 'application/json' } });
    if (resp.status === 403) {
      const body = await resp.json().catch(() => null);
      if (body?.error === 'access_not_granted') {
        // Signed in to External ID but without the site's access app role:
        // the public no-access page explains it. Never resolve, so the app
        // does not flash its sign-in view while the browser navigates away.
        location.replace(NO_ACCESS_PATH);
        return new Promise<never>(() => {});
      }
      tenantBlocked = body?.error === 'tenant_not_allowed';
      return null;
    }
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data && data.authenticated) {
      return {
        authenticated: true,
        userId: data.userId ?? '',
        identityProvider: data.identityProvider ?? 'aad',
        userDetails: data.userDetails ?? 'unknown',
        name: typeof data.name === 'string' ? data.name : '',
        userRoles: Array.isArray(data.userRoles) ? data.userRoles : [],
        isAdmin: data.isAdmin === true,
      };
    }
  } catch (_e) {
    // assume unauthenticated
  }
  return null;
}

const TENANT_BLOCKED_TITLE = "Your organisation's account isn't allowed on this site";
const TENANT_BLOCKED_TEXT =
  "You signed in with an account from an organisation that can't use figureskatingtools.com. " +
  'Sign out and sign in again with another account.';

/**
 * The "your organisation's account isn't allowed" card, for the tool apps
 * that keep their own landing markup (Judge Paper Creator, Score Modifier).
 */
export function tenantBlockedCardHtml(): string {
  return `
    <div class="card landing-card" role="alert">
      <span class="micro-label">Account not allowed</span>
      <h2>${escapeHtml(TENANT_BLOCKED_TITLE)}</h2>
      <p class="lead">${escapeHtml(TENANT_BLOCKED_TEXT)}</p>
      <div class="landing-contact">
        <p>If you think your organisation should have access, contact:</p>
        <a href="mailto:markus@lintuala.fi">markus@lintuala.fi</a>
      </div>
      <div style="margin-top: 2rem;">
        <a href="${logoutUrl()}" class="btn btn-primary">Sign out</a>
      </div>
    </div>
  `;
}

/** Render the unauthenticated landing/sign-in view into `appElement` */
export function renderSignInView(appElement: HTMLElement, redirectPath = '/'): void {
  if (tenantBlocked) {
    appElement.innerHTML = `
      <div class="unauth-page">
        <div class="unauth-header">
          <a href="${logoutUrl()}" class="btn btn-primary btn-sm unauth-signin-btn">Sign out</a>
        </div>
        <div class="unauth-content" role="alert">
          <img src="/logo.png" alt="Figure Skating Tools" class="unauth-logo">
          <h1 class="unauth-title">${escapeHtml(TENANT_BLOCKED_TITLE)}</h1>
          <p class="unauth-description">${escapeHtml(TENANT_BLOCKED_TEXT)}</p>
          <p class="unauth-contact">
            If you think your organisation should have access, contact
            <a href="mailto:markus@lintuala.fi">markus@lintuala.fi</a>
          </p>
          <a href="${logoutUrl()}" class="btn btn-primary">Sign out</a>
          <p class="unauth-privacy">
            <a href="/privacy/">Privacy notice</a> · <a href="/terms/">Terms of use</a>
          </p>
        </div>
      </div>
    `;
    return;
  }
  const href = loginUrl(redirectPath);
  appElement.innerHTML = `
    <div class="unauth-page">
      <div class="unauth-header">
        <a href="${href}" class="btn btn-primary btn-sm unauth-signin-btn">Sign In</a>
      </div>
      <div class="unauth-content">
        <img src="/logo.png" alt="Figure Skating Tools" class="unauth-logo reveal reveal-1">
        <p class="unauth-kicker reveal reveal-1">figureskatingtools.com</p>
        <h1 class="unauth-title reveal reveal-2">Tools for figure skating <em>result service</em> operations.</h1>
        <p class="unauth-description reveal reveal-3">
          There are several tools available for logged-on users to help figure skating result service operations.
        </p>
        <p class="unauth-contact reveal reveal-3">
          For access, contact <a href="mailto:markus@lintuala.fi">markus@lintuala.fi</a>
        </p>
        <a href="${href}" class="btn btn-primary reveal reveal-4">Sign In to Continue</a>
        <p class="unauth-privacy reveal reveal-4">
          <a href="/privacy/">Privacy notice</a> · <a href="/terms/">Terms of use</a>
        </p>
      </div>
    </div>
  `;
}

/** Render the signed-in user menu (avatar button + dropdown) into `container` */
export function setupUserMenu(container: HTMLElement, user: UserInfo): void {
  container.innerHTML = `
    <div class="user-menu-container">
      <button id="user-menu-btn" class="user-btn">
        <span>${escapeHtml(user.userDetails)}</span>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
          <path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/>
        </svg>
      </button>
      <div id="user-dropdown" class="dropdown-menu">
        <div style="padding: 0.75rem 1rem; border-bottom: 1px solid var(--border-color); font-size: 0.75rem; color: var(--text-secondary);">
          Signed in as <br> <strong style="color: var(--text-primary);">${escapeHtml(user.userDetails)}</strong>
        </div>
        ${user.isAdmin ? '<a href="/admin/" class="dropdown-item">Admin panel</a>' : ''}
        <a href="/privacy/" class="dropdown-item">Privacy notice</a>
        <a href="/terms/" class="dropdown-item">Terms of use</a>
        <a href="${logoutUrl()}" class="dropdown-item">Sign Out</a>
      </div>
    </div>
  `;

  const btn = document.getElementById('user-menu-btn')!;
  const dropdown = document.getElementById('user-dropdown')!;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('show');
  });

  document.addEventListener('click', () => {
    dropdown.classList.remove('show');
  });

  dropdown.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}
