import type { SiteNavOptions, NavTool, NavSmallTool } from './types.js';

/**
 * Default tools listed in the site navigation.
 *
 * Everything lives on one origin now, so a tool is just a path — the links
 * are identical on localhost, test and prod.
 */
const DEFAULT_TOOLS: NavTool[] = [
  {
    id: 'judgepapers',
    label: 'Judge Paper Creator',
    path: '/judgepapers/',
    enabled: true,
  },
  {
    id: 'scoremodifier',
    label: 'Score Modifier',
    path: '/scoremodifier/',
    enabled: true,
  },
  {
    id: 'protocolgenerator',
    label: 'Protocol Generator',
    path: '/protocolgenerator/',
    enabled: true,
  },
];

/** Small tools hosted inside the main site under /tools/... */
const SMALL_TOOLS: NavSmallTool[] = [
  { id: 'banner', label: 'Competition Banner Generator', path: '/tools/banner/' },
];

/**
 * Detect the environment prefix from the current hostname.
 * - test.figureskatingtools.com → 'test.'
 * - figureskatingtools.com → '' (prod)
 * - localhost → '' (local dev)
 *
 * Tool links no longer need this (they are plain paths), but the changelog
 * branch selection on the home page still does.
 */
export function getEnvPrefix(): string {
  if (typeof window === 'undefined') return '';
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return '';
  const match = hostname.match(/^(test)\./);
  return match ? `${match[1]}.` : '';
}

/**
 * Render the unified site navigation bar HTML.
 * Contains logo, tool sections with dropdowns, a "Tools" dropdown for small
 * in-site tools, and a right-side slot for app-specific content (e.g., user menu).
 *
 * @param options - Navigation configuration (or just the activeApp id string)
 * @returns HTML string to insert at the top of the page
 */
export function renderSiteNav(options: SiteNavOptions | string): string {
  const opts: SiteNavOptions =
    typeof options === 'string' ? { activeApp: options } : options;

  const tools = [...DEFAULT_TOOLS, ...(opts.extraTools ?? [])];
  const homeUrl = '/';
  const logoUrl = opts.logoUrl ?? '/logo.png';

  // Build tool navigation items
  const toolsHtml = tools
    .map((tool) => {
      const isActive = tool.id === opts.activeApp;

      // Active app with sub-items → dropdown with in-app navigation.
      // Optional and currently unused: judgepapers and protocolgenerator dropped
      // their "Competitions" / "New Competition" items when they started binding
      // to the site's active competition (the nav's competition selector is the
      // only way to switch workspaces now).
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

      // Enabled tool, not currently active → link to its path
      const url = isActive ? '#' : tool.path;
      const activeClass = isActive ? ' fst-nav-item--active' : '';
      return `<div class="fst-nav-item${activeClass}">
        <a href="${url}" class="fst-nav-item-link">${tool.label}</a>
      </div>`;
    })
    .join('');

  // Small in-site tools → "Tools" dropdown
  const smallToolsActive = SMALL_TOOLS.some((t) => t.id === opts.activeApp);
  const smallToolsItemsHtml = SMALL_TOOLS.map(
    (tool) => `<a href="${tool.path}" class="fst-dropdown-item">${tool.label}</a>`
  ).join('');
  const smallToolsItem = `<div class="fst-nav-item fst-nav-has-dropdown${
    smallToolsActive ? ' fst-nav-item--active' : ''
  }">
    <button class="fst-nav-item-btn" data-dropdown="small-tools" aria-expanded="false" aria-haspopup="true">
      Tools
      <svg class="fst-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l4 4 4-4"/></svg>
    </button>
    <div class="fst-dropdown-menu" data-menu="small-tools">
      ${smallToolsItemsHtml}
    </div>
  </div>`;

  return `<nav class="fst-nav" role="navigation">
    <div class="fst-nav-inner">
      <a href="${homeUrl}" class="fst-nav-logo">
        <img src="${logoUrl}" alt="Figure Skating Tools" class="fst-nav-logo-img">
        <span class="fst-nav-logo-text">FSTools</span>
      </a>
      <div class="fst-nav-menu">
        ${toolsHtml}
        ${smallToolsItem}
      </div>
      <div class="fst-nav-competition" id="fst-nav-competition"></div>
      <div class="fst-nav-right" id="fst-nav-right"></div>
    </div>
  </nav>`;
}

/** Pending hover-close timer, shared across all dropdowns */
let hoverCloseTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Initialize site nav event listeners (dropdown toggles, hover-open on pointer
 * devices, click outside to close).
 * Call this after the nav HTML has been inserted into the DOM.
 */
export function initSiteNav(): void {
  const closeAll = (): void => {
    document.querySelectorAll('.fst-nav-item-btn[data-dropdown]').forEach((t) => {
      t.setAttribute('aria-expanded', 'false');
    });
    document.querySelectorAll('.fst-dropdown-menu').forEach((m) => {
      m.classList.remove('fst-dropdown-menu--open');
    });
  };

  const open = (toggle: Element, menu: Element): void => {
    toggle.setAttribute('aria-expanded', 'true');
    menu.classList.add('fst-dropdown-menu--open');
  };

  // Handle all dropdown toggles (also the touch / keyboard path)
  document.querySelectorAll('.fst-nav-item-btn[data-dropdown]').forEach((toggle) => {
    const menuId = toggle.getAttribute('data-dropdown');
    const menu = document.querySelector(`.fst-dropdown-menu[data-menu="${menuId}"]`);
    if (!menu) return;

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const expanded = toggle.getAttribute('aria-expanded') === 'true';

      // Close all dropdowns first, then toggle this one
      closeAll();
      if (!expanded) open(toggle, menu);
    });
  });

  // Close dropdowns on click outside
  document.addEventListener('click', () => {
    closeAll();
  });

  // Prevent dropdown menu clicks from closing the dropdown
  document.querySelectorAll('.fst-dropdown-menu').forEach((menu) => {
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  });

  // Hover-open on real pointer devices only (avoids sticky hover on touch)
  const canHover =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  if (!canHover) return;

  document.querySelectorAll('.fst-nav-has-dropdown').forEach((wrapper) => {
    const toggle = wrapper.querySelector('.fst-nav-item-btn[data-dropdown]');
    const menuId = toggle?.getAttribute('data-dropdown');
    const menu = menuId
      ? document.querySelector(`.fst-dropdown-menu[data-menu="${menuId}"]`)
      : null;
    if (!toggle || !menu) return;

    wrapper.addEventListener('mouseenter', () => {
      if (hoverCloseTimer !== undefined) {
        clearTimeout(hoverCloseTimer);
        hoverCloseTimer = undefined;
      }
      closeAll();
      open(toggle, menu);
    });

    wrapper.addEventListener('mouseleave', () => {
      if (hoverCloseTimer !== undefined) clearTimeout(hoverCloseTimer);
      hoverCloseTimer = setTimeout(() => {
        hoverCloseTimer = undefined;
        closeAll();
      }, 150);
    });
  });
}
