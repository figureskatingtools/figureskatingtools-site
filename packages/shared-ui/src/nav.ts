import type { SiteNavOptions, NavTool } from './types.js';

/** Default tools listed in the site navigation */
const DEFAULT_TOOLS: NavTool[] = [
  {
    id: 'judgepapers',
    label: 'Judge Paper Creator',
    subdomain: 'judgepapers',
    enabled: true,
  },
  {
    id: 'scoremodifier',
    label: 'Score Modifier',
    subdomain: 'scoremodifier',
    enabled: false,
  },
];

const SITE_DOMAIN = 'figureskatingtools.com';

/**
 * Detect the environment prefix from the current hostname.
 * - dev.judgepapers.figureskatingtools.com → 'dev.'
 * - test.figureskatingtools.com → 'test.'
 * - figureskatingtools.com → '' (prod)
 * - localhost → '' (local dev)
 */
export function getEnvPrefix(): string {
  if (typeof window === 'undefined') return '';
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return '';
  const match = hostname.match(/^(dev|test)\./);
  return match ? `${match[1]}.` : '';
}

/** Build a full URL for a given subdomain, respecting the environment prefix */
function buildToolUrl(subdomain: string, envPrefix: string): string {
  if (typeof window === 'undefined') return '#';
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return '#';
  return `https://${envPrefix}${subdomain}.${SITE_DOMAIN}`;
}

/** Build the home (main site) URL respecting the environment prefix */
function buildHomeUrl(envPrefix: string): string {
  if (typeof window === 'undefined') return '#';
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return '/';
  return `https://${envPrefix}${SITE_DOMAIN}`;
}

/**
 * Render the unified site navigation bar HTML.
 * Contains logo, tool sections with dropdowns, downloads, and a right-side slot
 * for app-specific content (e.g., user menu).
 *
 * @param options - Navigation configuration (or just the activeApp id string)
 * @returns HTML string to insert at the top of the page
 */
export function renderSiteNav(options: SiteNavOptions | string): string {
  const opts: SiteNavOptions =
    typeof options === 'string' ? { activeApp: options } : options;

  const envPrefix = getEnvPrefix();
  const tools = [...DEFAULT_TOOLS, ...(opts.extraTools ?? [])];
  const homeUrl = buildHomeUrl(envPrefix);
  const logoUrl = opts.logoUrl ?? '/logo.png';

  // Build tool navigation items
  const toolsHtml = tools
    .map((tool) => {
      const isActive = tool.id === opts.activeApp;

      // Active app with sub-items → dropdown with in-app navigation
      if (isActive && opts.appNavItems && opts.appNavItems.length > 0) {
        const subItemsHtml = opts.appNavItems
          .map((item) => {
            if (!item.enabled) {
              return `<span class="fst-dropdown-item fst-dropdown-item--disabled">${item.label} <small>(coming soon)</small></span>`;
            }
            return `<a href="#" class="fst-dropdown-item" data-nav-action="${item.id}">${item.label}</a>`;
          })
          .join('');

        return `<div class="fst-nav-item fst-nav-has-dropdown fst-nav-item--active">
          <button class="fst-nav-item-btn" data-dropdown="${tool.id}" aria-expanded="false" aria-haspopup="true">
            ${tool.label}
            <svg class="fst-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l4 4 4-4"/></svg>
          </button>
          <div class="fst-dropdown-menu" data-menu="${tool.id}">
            ${subItemsHtml}
          </div>
        </div>`;
      }

      // Disabled tool → static label
      if (!tool.enabled) {
        return `<div class="fst-nav-item fst-nav-item--disabled">
          <span class="fst-nav-item-label">${tool.label} <small>(coming soon)</small></span>
        </div>`;
      }

      // Enabled tool, not currently active → link to its subdomain
      const url = isActive ? '#' : buildToolUrl(tool.subdomain, envPrefix);
      const activeClass = isActive ? ' fst-nav-item--active' : '';
      return `<div class="fst-nav-item${activeClass}">
        <a href="${url}" class="fst-nav-item-link">${tool.label}</a>
      </div>`;
    })
    .join('');

  // Downloads link
  const downloadsHref =
    opts.activeApp === 'home' ? '#downloads' : `${homeUrl}#downloads`;

  return `<nav class="fst-nav" role="navigation">
    <div class="fst-nav-inner">
      <a href="${homeUrl}" class="fst-nav-logo">
        <img src="${logoUrl}" alt="Figure Skating Tools" class="fst-nav-logo-img">
        <span class="fst-nav-logo-text">FSTools</span>
      </a>
      <div class="fst-nav-menu">
        ${toolsHtml}
        <div class="fst-nav-item">
          <a href="${downloadsHref}" class="fst-nav-item-link">Downloads</a>
        </div>
      </div>
      <div class="fst-nav-right" id="fst-nav-right"></div>
    </div>
  </nav>`;
}

/**
 * Initialize site nav event listeners (dropdown toggles, click outside to close).
 * Call this after the nav HTML has been inserted into the DOM.
 */
export function initSiteNav(): void {
  // Handle all dropdown toggles
  document.querySelectorAll('.fst-nav-item-btn[data-dropdown]').forEach((toggle) => {
    const menuId = toggle.getAttribute('data-dropdown');
    const menu = document.querySelector(`.fst-dropdown-menu[data-menu="${menuId}"]`);
    if (!menu) return;

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const expanded = toggle.getAttribute('aria-expanded') === 'true';

      // Close all dropdowns first
      document.querySelectorAll('.fst-nav-item-btn[data-dropdown]').forEach((t) => {
        t.setAttribute('aria-expanded', 'false');
      });
      document.querySelectorAll('.fst-dropdown-menu').forEach((m) => {
        m.classList.remove('fst-dropdown-menu--open');
      });

      // Toggle this one
      if (!expanded) {
        toggle.setAttribute('aria-expanded', 'true');
        menu.classList.add('fst-dropdown-menu--open');
      }
    });
  });

  // Close dropdowns on click outside
  document.addEventListener('click', () => {
    document.querySelectorAll('.fst-nav-item-btn[data-dropdown]').forEach((t) => {
      t.setAttribute('aria-expanded', 'false');
    });
    document.querySelectorAll('.fst-dropdown-menu').forEach((m) => {
      m.classList.remove('fst-dropdown-menu--open');
    });
  });

  // Prevent dropdown menu clicks from closing the dropdown
  document.querySelectorAll('.fst-dropdown-menu').forEach((menu) => {
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  });
}
