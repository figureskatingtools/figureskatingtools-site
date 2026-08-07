/**
 * Shared app shell — auth gate, sign-in view and user menu.
 * Used by main.ts and by the other pages of the site so the
 * gate and the signed-in chrome stay identical everywhere.
 */

/** Escape HTML */
export function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** The signed-in user, as reported by the router's `/userinfo` endpoint */
export interface UserInfo {
  authenticated: true;
  userId: string;
  identityProvider: string;
  userDetails: string;
  userRoles: string[];
}

/**
 * Sign-in URL for App Service Easy Auth.
 *
 * `appPath` is where the user lands after the round-trip, so each app passes
 * its own path (`/judgepapers/`, `/tools/banner/`, …) and login returns into it.
 */
export function loginUrl(appPath = '/'): string {
  return `/.auth/login/aad?post_login_redirect_url=${encodeURIComponent(appPath)}`;
}

/** Sign-out URL for App Service Easy Auth */
export function logoutUrl(redirectPath = '/'): string {
  return `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(redirectPath)}`;
}

/**
 * Check auth via the router's `/userinfo` endpoint, which flattens the Easy
 * Auth `x-ms-client-principal` header into `{authenticated, userId, …}`.
 * Returns null when unauthenticated or when the call fails.
 */
export async function fetchUser(): Promise<UserInfo | null> {
  try {
    const resp = await fetch('/userinfo', { headers: { Accept: 'application/json' } });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data && data.authenticated) {
      return {
        authenticated: true,
        userId: data.userId ?? '',
        identityProvider: data.identityProvider ?? 'aad',
        userDetails: data.userDetails ?? 'unknown',
        userRoles: Array.isArray(data.userRoles) ? data.userRoles : [],
      };
    }
  } catch (_e) {
    // assume unauthenticated
  }
  return null;
}

/** Render the unauthenticated landing/sign-in view into `appElement` */
export function renderSignInView(appElement: HTMLElement, redirectPath = '/'): void {
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
