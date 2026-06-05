import './style.css'
import { renderSiteNav, initSiteNav, injectSiteNavStyles } from '@figureskatingtools/shared-ui'

/** Escape HTML */
function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

interface ChangelogEntry {
  date: string;
  title: string;
  description: string;
  tool: string;
  sha: string;
}

const appElement = document.querySelector<HTMLDivElement>('#app')!;

// Inject shared nav styles immediately
injectSiteNavStyles();

async function init() {
  // 1. Check auth via SWA's built-in endpoint
  let userInfo: any = null;
  try {
    const resp = await fetch('/.auth/me');
    const data = await resp.json();
    if (data && data.clientPrincipal) {
      const cp = data.clientPrincipal;
      userInfo = {
        authenticated: true,
        userId: cp.userId,
        identityProvider: cp.identityProvider,
        userDetails: cp.userDetails,
        userRoles: cp.userRoles || [],
      };
    }
  } catch (_e) {
    // assume unauthenticated
  }

  if (!userInfo) {
    renderUnauthenticatedView();
  } else {
    renderAuthenticatedView(userInfo);
  }
}

function renderUnauthenticatedView() {
  appElement.innerHTML = `
    <div class="unauth-page">
      <div class="unauth-header">
        <a href="/.auth/login/aad?post_login_redirect_uri=/" class="btn btn-primary btn-sm unauth-signin-btn">Sign In</a>
      </div>
      <div class="unauth-content">
        <img src="/logo.png" alt="Figure Skating Tools" class="unauth-logo">
        <h1 class="unauth-title">Welcome to figureskatingtools.com</h1>
        <p class="unauth-description">
          There are several tools available for logged-on users to help figure skating result service operations.
        </p>
        <p class="unauth-contact">
          For access, contact <a href="mailto:markus@lintuala.fi">markus@lintuala.fi</a>
        </p>
        <a href="/.auth/login/aad?post_login_redirect_uri=/" class="btn btn-primary">Sign In to Continue</a>
      </div>
    </div>
  `;
}

function renderAuthenticatedView(userInfo: any) {
  appElement.innerHTML = `
    ${renderSiteNav({ activeApp: 'home', logoUrl: '/logo.png' })}

    <main class="auth-main">
      <div class="auth-layout">
        <div class="welcome-panel">
          <div class="card">
            <h2>Welcome to figureskatingtools.com</h2>
            <p>
              Please use the tools nicely and do not harm anyone.
            </p>
            <p>
              All bugs and feature requests should be reported to
              <a href="https://github.com/figureskatingtools" target="_blank" rel="noopener noreferrer">GitHub</a>.
            </p>
            <p>
              In case of inquiries, contact
              <a href="mailto:markus@lintuala.fi">markus@lintuala.fi</a>.
            </p>
          </div>
        </div>
        <div class="changelog-panel">
          <div class="card">
            <h2>What's New</h2>
            <div id="changelog-entries">
              <p class="text-secondary">Loading changelog...</p>
            </div>
          </div>
        </div>
      </div>
    </main>

    <footer class="site-footer">
      <p>&copy; ${new Date().getFullYear()} Figure Skating Tools</p>
    </footer>
  `;

  // Setup user menu
  const userSection = document.getElementById('fst-nav-right');
  if (userSection) {
    setupUserMenu(userSection, userInfo);
  }

  initSiteNav();

  // Load changelog
  loadChangelog();
}

async function loadChangelog() {
  const container = document.getElementById('changelog-entries');
  if (!container) return;

  try {
    const resp = await fetch('/changelog.json');
    if (!resp.ok) throw new Error('Not found');
    const entries: ChangelogEntry[] = await resp.json();

    if (entries.length === 0) {
      container.innerHTML = '<p class="text-secondary">No changelog entries yet.</p>';
      return;
    }

    container.innerHTML = entries.map((entry, i) => {
      const toolBadge = entry.tool
        ? `<span class="changelog-badge changelog-badge--${entry.tool.toLowerCase().replace(/\s+/g, '-')}">${escapeHtml(entry.tool)}</span>`
        : '';
      const hasLongDesc = entry.description && entry.description.length > 150;
      const shortDesc = hasLongDesc ? entry.description.substring(0, 150) + '...' : entry.description;

      return `
        <div class="changelog-entry">
          <div class="changelog-meta">
            <span class="changelog-date">${escapeHtml(entry.date)}</span>
            ${toolBadge}
          </div>
          <h3 class="changelog-title">${escapeHtml(entry.title)}</h3>
          ${entry.description ? `
            <p class="changelog-desc" id="changelog-desc-${i}">${escapeHtml(shortDesc)}</p>
            ${hasLongDesc ? `
              <button class="btn-link changelog-toggle" data-index="${i}" data-expanded="false">Read more</button>
              <p class="changelog-desc-full hidden" id="changelog-full-${i}">${escapeHtml(entry.description)}</p>
            ` : ''}
          ` : ''}
        </div>
      `;
    }).join('');

    // Toggle handlers
    container.querySelectorAll('.changelog-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = (btn as HTMLElement).dataset.index!;
        const expanded = (btn as HTMLElement).dataset.expanded === 'true';
        const shortEl = document.getElementById(`changelog-desc-${idx}`);
        const fullEl = document.getElementById(`changelog-full-${idx}`);
        if (shortEl && fullEl) {
          if (expanded) {
            shortEl.classList.remove('hidden');
            fullEl.classList.add('hidden');
            btn.textContent = 'Read more';
            (btn as HTMLElement).dataset.expanded = 'false';
          } else {
            shortEl.classList.add('hidden');
            fullEl.classList.remove('hidden');
            btn.textContent = 'Show less';
            (btn as HTMLElement).dataset.expanded = 'true';
          }
        }
      });
    });
  } catch (_e) {
    container.innerHTML = '<p class="text-secondary">Changelog not available.</p>';
  }
}

function setupUserMenu(container: HTMLElement, user: any) {
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
        <a href="/.auth/logout?post_logout_redirect_uri=/" class="dropdown-item">Sign Out</a>
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

init();
