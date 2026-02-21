const NAV_STYLES = `
/* ── Figure Skating Tools — Unified Navigation ── */
.fst-nav {
  background-color: #ffffff;
  border-bottom: 1px solid #e2e8f0;
  font-family: 'Inter', system-ui, Avenir, Helvetica, Arial, sans-serif;
  font-size: 0.875rem;
  line-height: 1.5;
  position: sticky;
  top: 0;
  z-index: 100;
  -webkit-font-smoothing: antialiased;
}

.fst-nav-inner {
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 1.5rem;
  display: flex;
  align-items: center;
  height: 3.5rem;
  gap: 1.5rem;
}

/* Logo */
.fst-nav-logo {
  display: flex;
  align-items: center;
  text-decoration: none;
  flex-shrink: 0;
}

.fst-nav-logo img {
  height: 28px;
  width: auto;
}

/* Menu items container */
.fst-nav-menu {
  display: flex;
  align-items: center;
  gap: 0.125rem;
  flex: 1;
}

/* Individual nav item wrapper */
.fst-nav-item {
  position: relative;
}

/* Shared styles for links and dropdown toggles */
.fst-nav-item-link,
.fst-nav-item-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  color: #475569;
  text-decoration: none;
  font-size: 0.875rem;
  font-weight: 500;
  font-family: inherit;
  background: none;
  border: none;
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s;
  white-space: nowrap;
}

.fst-nav-item-link:hover,
.fst-nav-item-btn:hover {
  color: #1e293b;
  background-color: #f1f5f9;
}

/* Active tool highlight */
.fst-nav-item--active > .fst-nav-item-link,
.fst-nav-item--active > .fst-nav-item-btn {
  color: #6366f1;
  font-weight: 600;
}

.fst-nav-item--active > .fst-nav-item-link:hover,
.fst-nav-item--active > .fst-nav-item-btn:hover {
  background-color: #eef2ff;
}

/* Disabled (coming soon) tool */
.fst-nav-item--disabled .fst-nav-item-label {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 0.75rem;
  color: #94a3b8;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: default;
  white-space: nowrap;
}

.fst-nav-item--disabled .fst-nav-item-label small {
  font-size: 0.75rem;
  font-style: italic;
}

/* Chevron icon */
.fst-chevron {
  transition: transform 0.2s;
}

.fst-nav-item-btn[aria-expanded="true"] .fst-chevron {
  transform: rotate(180deg);
}

/* Dropdown menu */
.fst-dropdown-menu {
  display: none;
  position: absolute;
  left: 0;
  top: calc(100% + 0.375rem);
  background-color: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 0.5rem;
  box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
  min-width: 200px;
  flex-direction: column;
  overflow: hidden;
  z-index: 110;
  padding: 0.25rem 0;
}

.fst-dropdown-menu--open {
  display: flex;
}

.fst-dropdown-item {
  display: block;
  padding: 0.5rem 1rem;
  color: #1e293b;
  text-decoration: none;
  font-size: 0.875rem;
  font-weight: 400;
  transition: background-color 0.15s;
  white-space: nowrap;
  cursor: pointer;
}

.fst-dropdown-item:hover {
  background-color: #f1f5f9;
}

.fst-dropdown-item--disabled {
  color: #94a3b8;
  cursor: default;
}

.fst-dropdown-item--disabled:hover {
  background-color: transparent;
}

.fst-dropdown-item--disabled small {
  font-size: 0.75rem;
  font-style: italic;
}

/* Right side slot (user menu, sign-in button) */
.fst-nav-right {
  display: flex;
  align-items: center;
  margin-left: auto;
  flex-shrink: 0;
}

/* Separator between nav sections (optional) */
.fst-nav-separator {
  width: 1px;
  height: 1.25rem;
  background-color: #e2e8f0;
  margin: 0 0.25rem;
}
`;

let stylesInjected = false;

/**
 * Inject site navigation CSS styles into the document head.
 * Safe to call multiple times — styles are only injected once.
 */
export function injectSiteNavStyles(): void {
  if (stylesInjected) return;
  if (typeof document === 'undefined') return;

  const style = document.createElement('style');
  style.setAttribute('data-fst-site-nav', '');
  style.textContent = NAV_STYLES;
  document.head.appendChild(style);
  stylesInjected = true;
}
