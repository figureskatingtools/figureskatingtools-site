import type { SiteNavOptions, NavTool } from './types.js';

/** Default tools listed in the site navigation dropdown */
const DEFAULT_TOOLS: NavTool[] = [
  {
    id: 'judgepapers',
    label: 'Judge Paper Creator',
    subdomain: 'judgepapers',
    enabled: true,
  },
  {
    id: 'scoremodifier',
    label: 'Judge Score Modifier',
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
function getEnvPrefix(): string {
  if (typeof window === 'undefined') return '';
  const hostname = window.location.hostname;

  // Local development — no prefix
  if (hostname === 'localhost' || hostname === '127.0.0.1') return '';

  // Match env prefix: dev.* or test.* at the start of hostname
  const match = hostname.match(/^(dev|test)\./);
  return match ? `${match[1]}.` : '';
}

/** Build a full URL for a given subdomain, respecting the environment prefix */
function buildToolUrl(subdomain: string, envPrefix: string): string {
  if (typeof window === 'undefined') return '#';
  const hostname = window.location.hostname;

  // Local development — stay on localhost
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return '#';
  }

  return `https://${envPrefix}${subdomain}.${SITE_DOMAIN}`;
}

/** Build the home (main site) URL respecting the environment prefix */
function buildHomeUrl(envPrefix: string): string {
  if (typeof window === 'undefined') return '#';
  const hostname = window.location.hostname;

  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return '/';
  }

  return `https://${envPrefix}${SITE_DOMAIN}`;
}

/**
 * Render the site-level navigation bar HTML.
 * This bar sits above the app's own header and provides cross-tool navigation.
 *
 * @param options - Navigation configuration
 * @returns HTML string to insert at the top of the page
 */
export function renderSiteNav(options: SiteNavOptions | string): string {
  const opts: SiteNavOptions =
    typeof options === 'string' ? { activeApp: options } : options;

  const envPrefix = getEnvPrefix();
  const tools = [...DEFAULT_TOOLS, ...(opts.extraTools ?? [])];
  const homeUrl = buildHomeUrl(envPrefix);

  const toolItems = tools
    .map((tool) => {
      const url = buildToolUrl(tool.subdomain, envPrefix);
      const isActive = tool.id === opts.activeApp;
      const disabledClass = !tool.enabled ? ' fst-nav-item--disabled' : '';
      const activeClass = isActive ? ' fst-nav-item--active' : '';

      if (!tool.enabled) {
        return `<span class="fst-nav-dropdown-item${disabledClass}" title="Coming soon">${tool.label} <small>(coming soon)</small></span>`;
      }
      return `<a href="${url}" class="fst-nav-dropdown-item${activeClass}">${tool.label}</a>`;
    })
    .join('\n            ');

  return `<div class="fst-site-nav">
    <div class="fst-site-nav-inner">
      <a href="${homeUrl}" class="fst-site-nav-brand">Figure Skating Tools</a>
      <div class="fst-site-nav-links">
        <div class="fst-nav-dropdown">
          <button class="fst-nav-dropdown-toggle" aria-expanded="false" aria-haspopup="true">
            Tools <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M1 1l4 4 4-4"/></svg>
          </button>
          <div class="fst-nav-dropdown-menu">
            ${toolItems}
          </div>
        </div>
        <a href="${homeUrl}#downloads" class="fst-nav-link">Downloads</a>
      </div>
    </div>
  </div>`;
}

/**
 * Initialize site nav event listeners (dropdown toggle, click outside to close).
 * Call this after the nav HTML has been inserted into the DOM.
 */
export function initSiteNav(): void {
  const toggle = document.querySelector('.fst-nav-dropdown-toggle');
  const menu = document.querySelector('.fst-nav-dropdown-menu');
  if (!toggle || !menu) return;

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    menu.classList.toggle('fst-nav-dropdown-menu--open');
  });

  document.addEventListener('click', () => {
    toggle.setAttribute('aria-expanded', 'false');
    menu.classList.remove('fst-nav-dropdown-menu--open');
  });
}
