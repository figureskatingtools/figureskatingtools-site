const NAV_STYLES = `
/* ── Figure Skating Tools — Unified Navigation ──
   "Protocol" design language: glacial ink on frost paper,
   hairline rules, medal-gold active marker. */
.fst-nav {
  background-color: rgba(255, 255, 255, 0.82);
  -webkit-backdrop-filter: blur(14px) saturate(1.4);
  backdrop-filter: blur(14px) saturate(1.4);
  border-bottom: 1px solid #d7e1ea;
  font-family: 'Instrument Sans', system-ui, Avenir, Helvetica, Arial, sans-serif;
  font-size: 0.875rem;
  line-height: 1.5;
  position: sticky;
  top: 0;
  z-index: 100;
  overflow: visible;
  -webkit-font-smoothing: antialiased;
}

.fst-nav-inner {
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 2rem;
  display: flex;
  align-items: center;
  height: 4rem;
  gap: 0.75rem;
  position: relative;
}

/* Logo — extends below the nav bar on desktop, text on mobile */
.fst-nav-logo {
  text-decoration: none;
  z-index: 120;
  display: flex;
  align-items: flex-start;
  align-self: flex-start;
  flex-shrink: 0;
}

.fst-nav-logo-img {
  height: 100px;
  width: auto;
  filter: drop-shadow(0 2px 10px rgb(13 31 51 / 0.12));
}

.fst-nav-logo-text {
  display: none;
  font-family: 'Fraunces', Georgia, 'Times New Roman', serif;
  font-weight: 600;
  font-size: 1.25rem;
  color: #0d1f33;
  letter-spacing: -0.01em;
}

/* Mobile: hide image, show text, collapse padding */
@media (max-width: 768px) {
  .fst-nav-inner {
    gap: 0.5rem;
    padding: 0 1rem;
  }
  .fst-nav-logo {
    align-self: center;
  }
  .fst-nav-logo-img {
    display: none;
  }
  .fst-nav-logo-text {
    display: inline;
  }
}

/* Menu items container */
.fst-nav-menu {
  display: flex;
  align-items: center;
  gap: 0.25rem;
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
  gap: 0.4rem;
  padding: 0.5rem 0.875rem;
  border-radius: 0.375rem;
  color: #41566c;
  text-decoration: none;
  font-size: 0.875rem;
  font-weight: 500;
  font-family: inherit;
  letter-spacing: 0.005em;
  background: none;
  border: none;
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s;
  white-space: nowrap;
}

.fst-nav-item-link:hover,
.fst-nav-item-btn:hover {
  color: #0d1f33;
  background-color: #e9f1f8;
}

/* Active tool — ink text with a medal-gold diamond marker */
.fst-nav-item--active > .fst-nav-item-link,
.fst-nav-item--active > .fst-nav-item-btn {
  color: #0d1f33;
  font-weight: 600;
}

.fst-nav-item--active > .fst-nav-item-link::before,
.fst-nav-item--active > .fst-nav-item-btn::before {
  content: '';
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  background: linear-gradient(135deg, #d4af4f, #b08d2f);
  transform: rotate(45deg);
  border-radius: 1px;
}

.fst-nav-item--active > .fst-nav-item-link:hover,
.fst-nav-item--active > .fst-nav-item-btn:hover {
  background-color: #e9f1f8;
}

/* Disabled (coming soon) tool */
.fst-nav-item--disabled .fst-nav-item-label {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 0.875rem;
  color: #93a7ba;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: default;
  white-space: nowrap;
}

.fst-nav-item--disabled .fst-nav-item-label small {
  font-size: 0.7rem;
  font-style: normal;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #a8b9c9;
}

/* Chevron icon */
.fst-chevron {
  transition: transform 0.2s;
}

.fst-nav-item-btn[aria-expanded="true"] .fst-chevron {
  transform: rotate(180deg);
}

/* Dropdown wrapper — invisible bridge across the gap to the menu,
   so moving the cursor down doesn't fire mouseleave */
.fst-nav-has-dropdown {
  position: relative;
}

.fst-nav-has-dropdown::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 100%;
  height: 0.6rem;
}

/* Dropdown menu */
.fst-dropdown-menu {
  display: none;
  position: absolute;
  left: 0;
  top: calc(100% + 0.5rem);
  background-color: #ffffff;
  border: 1px solid #d7e1ea;
  border-radius: 0.5rem;
  box-shadow: 0 12px 32px -8px rgb(13 31 51 / 0.18), 0 2px 8px -2px rgb(13 31 51 / 0.08);
  min-width: 210px;
  flex-direction: column;
  overflow: hidden;
  z-index: 110;
  padding: 0.3rem 0;
}

.fst-dropdown-menu--open {
  display: flex;
}

.fst-dropdown-item {
  display: block;
  padding: 0.55rem 1rem;
  color: #18324d;
  text-decoration: none;
  font-size: 0.875rem;
  font-weight: 450;
  transition: background-color 0.15s, color 0.15s;
  white-space: nowrap;
  cursor: pointer;
}

.fst-dropdown-item:hover {
  background-color: #e9f1f8;
  color: #0d1f33;
}

.fst-dropdown-item--disabled {
  color: #93a7ba;
  cursor: default;
}

.fst-dropdown-item--disabled:hover {
  background-color: transparent;
  color: #93a7ba;
}

.fst-dropdown-item--disabled small {
  font-size: 0.7rem;
  font-style: normal;
  letter-spacing: 0.06em;
  text-transform: uppercase;
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
  background-color: #d7e1ea;
  margin: 0 0.25rem;
}

/* ── Competition selector ──
   Sits between the tool menu and the user menu. Empty (and invisible)
   whenever the platform competitions API is unavailable. */
.fst-nav-competition {
  display: flex;
  align-items: center;
  margin-left: auto;
  flex-shrink: 0;
}

.fst-nav-competition:empty {
  display: none;
}

/* The slot after it keeps its own spacing without doubling the auto margin */
.fst-nav-competition + .fst-nav-right {
  margin-left: 0.5rem;
}

.fst-comp {
  position: relative;
}

.fst-comp-btn {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  max-width: 15rem;
  padding: 0.4rem 0.75rem;
  border: 1px solid #d7e1ea;
  border-radius: 0.5rem;
  background-color: #ffffff;
  color: #41566c;
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.15s, color 0.15s, background-color 0.15s;
}

.fst-comp-btn:hover {
  border-color: #1271b5;
  color: #0d1f33;
  background-color: #e9f1f8;
}

.fst-comp-btn--active {
  color: #0d1f33;
  font-weight: 600;
}

.fst-comp-btn-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.fst-comp-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  background-color: #c6d3df;
}

.fst-comp-btn--active .fst-comp-dot {
  background: linear-gradient(135deg, #d4af4f, #b08d2f);
}

.fst-comp-menu {
  display: none;
  position: absolute;
  right: 0;
  top: calc(100% + 0.5rem);
  min-width: 17rem;
  max-width: 22rem;
  background-color: #ffffff;
  border: 1px solid #d7e1ea;
  border-radius: 0.5rem;
  box-shadow: 0 12px 32px -8px rgb(13 31 51 / 0.18), 0 2px 8px -2px rgb(13 31 51 / 0.08);
  z-index: 110;
  flex-direction: column;
  overflow: hidden;
}

.fst-comp-menu--open {
  display: flex;
}

.fst-comp-menu-head {
  padding: 0.55rem 0.9rem 0.4rem;
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #93a7ba;
}

.fst-comp-list {
  max-height: 17rem;
  overflow-y: auto;
  border-top: 1px solid #eef3f7;
}

.fst-comp-item {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  width: 100%;
  padding: 0.5rem 0.9rem;
  border: none;
  background: none;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s;
}

.fst-comp-item:hover {
  background-color: #e9f1f8;
}

.fst-comp-item-name {
  font-size: 0.8125rem;
  font-weight: 500;
  color: #18324d;
}

.fst-comp-item-meta {
  font-size: 0.7rem;
  color: #93a7ba;
}

.fst-comp-item--selected .fst-comp-item-name {
  font-weight: 600;
  color: #0d5a92;
}

.fst-comp-empty {
  margin: 0;
  padding: 0.75rem 0.9rem;
  font-size: 0.8125rem;
  color: #93a7ba;
}

.fst-comp-menu-foot {
  display: flex;
  flex-direction: column;
  border-top: 1px solid #eef3f7;
}

.fst-comp-action {
  padding: 0.55rem 0.9rem;
  border: none;
  background: none;
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #0d5a92;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s;
}

.fst-comp-action:hover {
  background-color: #e9f1f8;
}

/* ── New-competition dialog ── */
.fst-comp-dialog {
  width: min(30rem, calc(100vw - 2rem));
  padding: 0;
  border: 1px solid #d7e1ea;
  border-radius: 0.75rem;
  background-color: #ffffff;
  color: #0d1f33;
  font-family: 'Instrument Sans', system-ui, Avenir, Helvetica, Arial, sans-serif;
  box-shadow: 0 24px 60px -16px rgb(13 31 51 / 0.35);
}

.fst-comp-dialog::backdrop {
  background-color: rgb(13 31 51 / 0.45);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
}

.fst-comp-form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding: 1.6rem 1.75rem 1.5rem;
}

.fst-comp-dialog-title {
  margin: 0;
  font-family: 'Fraunces', Georgia, 'Times New Roman', serif;
  font-size: 1.35rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.fst-comp-dialog-lead {
  margin: -0.5rem 0 0;
  font-size: 0.85rem;
  color: #64798e;
  line-height: 1.5;
}

.fst-comp-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.fst-comp-field-label {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #64798e;
}

.fst-comp-field input {
  padding: 0.55rem 0.7rem;
  border: 1px solid #c6d3df;
  border-radius: 0.4rem;
  background-color: #ffffff;
  font-family: inherit;
  font-size: 0.9rem;
  color: #0d1f33;
}

.fst-comp-field input:focus {
  outline: none;
  border-color: #1271b5;
  box-shadow: 0 0 0 3px rgb(18 113 181 / 0.14);
}

.fst-comp-field-note {
  font-size: 0.72rem;
  color: #93a7ba;
}

.fst-comp-field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.9rem;
}

.fst-comp-dialog-error {
  margin: 0;
  padding: 0.55rem 0.7rem;
  border: 1px solid #f0cfcf;
  border-radius: 0.4rem;
  background-color: #fbeeee;
  font-size: 0.8125rem;
  color: #c03434;
}

.fst-comp-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
  margin-top: 0.2rem;
}

.fst-comp-btn-primary,
.fst-comp-btn-secondary {
  padding: 0.55rem 1.2rem;
  border-radius: 0.5rem;
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
}

.fst-comp-btn-primary {
  background-color: #0d1f33;
  color: #ffffff;
}

.fst-comp-btn-primary:hover {
  background-color: #1a334f;
}

.fst-comp-btn-primary:disabled {
  opacity: 0.6;
  cursor: default;
}

.fst-comp-btn-secondary {
  background-color: #ffffff;
  border-color: #c6d3df;
  color: #0d1f33;
}

.fst-comp-btn-secondary:hover {
  background-color: #e9f1f8;
  border-color: #1271b5;
}

@media (max-width: 768px) {
  .fst-comp-btn-label {
    max-width: 7rem;
  }
  .fst-comp-field-row {
    grid-template-columns: 1fr;
  }
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
