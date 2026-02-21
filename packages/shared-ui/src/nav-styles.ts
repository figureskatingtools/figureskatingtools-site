const NAV_STYLES = `
/* ── Figure Skating Tools — Site Navigation ── */
.fst-site-nav {
  background-color: #1e293b;
  color: #f1f5f9;
  font-family: 'Inter', system-ui, Avenir, Helvetica, Arial, sans-serif;
  font-size: 0.8125rem;
  line-height: 1.5;
  position: sticky;
  top: 0;
  z-index: 100;
  -webkit-font-smoothing: antialiased;
}

.fst-site-nav-inner {
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 1.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 2.25rem;
}

.fst-site-nav-brand {
  color: #f1f5f9;
  text-decoration: none;
  font-weight: 600;
  font-size: 0.8125rem;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.fst-site-nav-brand:hover {
  color: #ffffff;
}

.fst-site-nav-links {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.fst-nav-link {
  color: #cbd5e1;
  text-decoration: none;
  padding: 0.25rem 0.625rem;
  border-radius: 0.25rem;
  transition: color 0.15s, background-color 0.15s;
  font-size: 0.8125rem;
}

.fst-nav-link:hover {
  color: #ffffff;
  background-color: rgba(255, 255, 255, 0.08);
}

/* Dropdown */
.fst-nav-dropdown {
  position: relative;
}

.fst-nav-dropdown-toggle {
  background: none;
  border: none;
  color: #cbd5e1;
  cursor: pointer;
  padding: 0.25rem 0.625rem;
  border-radius: 0.25rem;
  font-size: 0.8125rem;
  font-family: inherit;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  transition: color 0.15s, background-color 0.15s;
}

.fst-nav-dropdown-toggle:hover {
  color: #ffffff;
  background-color: rgba(255, 255, 255, 0.08);
}

.fst-nav-dropdown-toggle svg {
  transition: transform 0.15s;
}

.fst-nav-dropdown-toggle[aria-expanded="true"] svg {
  transform: rotate(180deg);
}

.fst-nav-dropdown-menu {
  display: none;
  position: absolute;
  right: 0;
  top: calc(100% + 0.25rem);
  background-color: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 0.5rem;
  box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
  min-width: 220px;
  flex-direction: column;
  overflow: hidden;
  z-index: 110;
}

.fst-nav-dropdown-menu--open {
  display: flex;
}

.fst-nav-dropdown-item {
  display: block;
  padding: 0.625rem 1rem;
  color: #1e293b;
  text-decoration: none;
  font-size: 0.875rem;
  transition: background-color 0.15s;
  white-space: nowrap;
}

.fst-nav-dropdown-item:hover {
  background-color: #f1f5f9;
}

.fst-nav-dropdown-item--active {
  font-weight: 600;
  color: #6366f1;
  background-color: #eef2ff;
}

.fst-nav-dropdown-item--active:hover {
  background-color: #e0e7ff;
}

.fst-nav-dropdown-item--disabled {
  color: #94a3b8;
  cursor: default;
}

.fst-nav-dropdown-item--disabled:hover {
  background-color: transparent;
}

.fst-nav-dropdown-item--disabled small {
  font-size: 0.75rem;
  font-style: italic;
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
