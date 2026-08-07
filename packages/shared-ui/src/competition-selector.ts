/**
 * The competition selector that lives in the site navigation bar.
 *
 * Renders a dropdown showing the active competition (or "Select competition…"),
 * the list of competitions from the platform registry, a "New competition…"
 * dialog and a clear item.
 *
 * **Degrades to rendering nothing** when `/api/competitions` is unavailable, so
 * the frontend can ship before the platform API exists.
 */

import {
  clearActiveCompetition,
  competitionLabel,
  createCompetition,
  CompetitionApiError,
  getActiveCompetition,
  listCompetitions,
  normalizeCompetitionCode,
  setActiveCompetition,
  subscribeActiveCompetition,
  type PlatformCompetition,
} from './competition.js';

/** Escape text for interpolation into HTML (also safe inside quoted attributes) */
function esc(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** How many competitions the dropdown lists before it starts scrolling */
const MENU_MAX_ITEMS = 25;

const CHEVRON_SVG =
  '<svg class="fst-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none" ' +
  'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M1 1l4 4 4-4"/></svg>';

/* ════════════════════════════════════════════════════════════════
   Selector
   ════════════════════════════════════════════════════════════════ */

/**
 * Render the competition selector into `container` (normally
 * `#fst-nav-competition`).
 *
 * Resolves once the first competition list has loaded. If the API is not
 * reachable the container is left empty and no listeners are attached.
 */
export async function initCompetitionSelector(container: HTMLElement): Promise<void> {
  let competitions: PlatformCompetition[];
  try {
    competitions = await listCompetitions();
  } catch (_e) {
    // Platform API not deployed / unreachable — render nothing at all.
    container.innerHTML = '';
    return;
  }

  const render = (): void => {
    container.innerHTML = buildSelectorHtml(competitions, getActiveCompetition());
    wire(container, competitions, render);
  };

  // Attached once — re-rendering the menu markup must not pile up listeners
  document.addEventListener('click', () => closeMenu(container));

  render();
  subscribeActiveCompetition(() => render());
}

/** Collapse the dropdown, if it is open */
function closeMenu(container: HTMLElement): void {
  container.querySelector('[data-fst-comp-toggle]')?.setAttribute('aria-expanded', 'false');
  container.querySelector('[data-fst-comp-menu]')?.classList.remove('fst-comp-menu--open');
}

function buildSelectorHtml(
  competitions: PlatformCompetition[],
  active: PlatformCompetition | null
): string {
  const label = active ? competitionLabel(active) : 'Select competition…';
  const activeClass = active ? ' fst-comp-btn--active' : '';

  const items = competitions.slice(0, MENU_MAX_ITEMS).map((c) => {
    const selected = active && active.id === c.id ? ' fst-comp-item--selected' : '';
    const meta = [c.code, c.date, c.venue].filter(Boolean).join(' · ');
    return `<button type="button" class="fst-comp-item${selected}" data-competition-id="${esc(c.id)}">
      <span class="fst-comp-item-name">${esc(competitionLabel(c))}</span>
      ${meta ? `<span class="fst-comp-item-meta">${esc(meta)}</span>` : ''}
    </button>`;
  }).join('');

  const emptyState = competitions.length === 0
    ? '<p class="fst-comp-empty">No competitions yet.</p>'
    : '';

  const clearItem = active
    ? `<button type="button" class="fst-comp-action" data-fst-comp-clear>Clear selection</button>`
    : '';

  return `<div class="fst-comp">
    <button type="button" class="fst-comp-btn${activeClass}" data-fst-comp-toggle aria-expanded="false" aria-haspopup="true">
      <span class="fst-comp-dot"></span>
      <span class="fst-comp-btn-label">${esc(label)}</span>
      ${CHEVRON_SVG}
    </button>
    <div class="fst-comp-menu" data-fst-comp-menu>
      <div class="fst-comp-menu-head">Competition</div>
      <div class="fst-comp-list">${items}${emptyState}</div>
      <div class="fst-comp-menu-foot">
        <button type="button" class="fst-comp-action" data-fst-comp-new>New competition…</button>
        ${clearItem}
      </div>
    </div>
  </div>`;
}

function wire(
  container: HTMLElement,
  competitions: PlatformCompetition[],
  rerender: () => void
): void {
  const toggle = container.querySelector<HTMLButtonElement>('[data-fst-comp-toggle]');
  const menu = container.querySelector<HTMLElement>('[data-fst-comp-menu]');
  if (!toggle || !menu) return;

  const close = (): void => closeMenu(container);

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    menu.classList.toggle('fst-comp-menu--open', !open);
  });

  menu.addEventListener('click', (e) => e.stopPropagation());

  container.querySelectorAll<HTMLButtonElement>('[data-competition-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-competition-id');
      const picked = competitions.find((c) => c.id === id) ?? null;
      close();
      setActiveCompetition(picked); // re-renders through the subscription
    });
  });

  container.querySelector('[data-fst-comp-clear]')?.addEventListener('click', () => {
    close();
    clearActiveCompetition();
  });

  container.querySelector('[data-fst-comp-new]')?.addEventListener('click', () => {
    close();
    void openCreateCompetitionDialog().then((created) => {
      if (!created) return;
      competitions.unshift(created);
      setActiveCompetition(created);
      rerender();
    });
  });
}

/* ════════════════════════════════════════════════════════════════
   "New competition" dialog
   ════════════════════════════════════════════════════════════════ */

const DIALOG_ID = 'fst-competition-dialog';

/**
 * Open the shared "New competition" dialog.
 *
 * Resolves with the created competition, or null when the user cancels.
 * The caller decides whether to make it the active competition.
 */
export function openCreateCompetitionDialog(prefillName = ''): Promise<PlatformCompetition | null> {
  return new Promise((resolve) => {
    document.getElementById(DIALOG_ID)?.remove();

    const dialog = document.createElement('dialog');
    dialog.id = DIALOG_ID;
    dialog.className = 'fst-comp-dialog';
    dialog.innerHTML = `
      <form method="dialog" class="fst-comp-form">
        <h2 class="fst-comp-dialog-title">New competition</h2>
        <p class="fst-comp-dialog-lead">
          Everything you create here becomes available to every tool on the site.
        </p>

        <label class="fst-comp-field">
          <span class="fst-comp-field-label">Name</span>
          <input type="text" name="name" required autocomplete="off" value="${esc(prefillName)}"
                 placeholder="Winter Cup 2026">
        </label>

        <label class="fst-comp-field">
          <span class="fst-comp-field-label">Code</span>
          <input type="text" name="code" required autocomplete="off" placeholder="winter-cup-2026">
          <span class="fst-comp-field-note">Unique across the whole site. Auto-filled from the name.</span>
        </label>

        <div class="fst-comp-field-row">
          <label class="fst-comp-field">
            <span class="fst-comp-field-label">Start date</span>
            <input type="date" name="date" autocomplete="off">
          </label>
          <label class="fst-comp-field">
            <span class="fst-comp-field-label">Venue</span>
            <input type="text" name="venue" autocomplete="off" placeholder="Ice Arena, Helsinki">
          </label>
        </div>

        <p class="fst-comp-dialog-error" data-fst-comp-error hidden></p>

        <div class="fst-comp-dialog-actions">
          <button type="button" class="fst-comp-btn-secondary" data-fst-comp-cancel>Cancel</button>
          <button type="submit" class="fst-comp-btn-primary" data-fst-comp-submit>Create</button>
        </div>
      </form>
    `;
    document.body.appendChild(dialog);

    const form = dialog.querySelector('form')!;
    const nameInput = form.elements.namedItem('name') as HTMLInputElement;
    const codeInput = form.elements.namedItem('code') as HTMLInputElement;
    const dateInput = form.elements.namedItem('date') as HTMLInputElement;
    const venueInput = form.elements.namedItem('venue') as HTMLInputElement;
    const errorEl = dialog.querySelector<HTMLElement>('[data-fst-comp-error]')!;
    const submitBtn = dialog.querySelector<HTMLButtonElement>('[data-fst-comp-submit]')!;

    // Auto-slug the code from the name until the user types their own
    let codeEdited = false;
    codeInput.value = normalizeCompetitionCode(prefillName);
    codeInput.addEventListener('input', () => { codeEdited = true; });
    nameInput.addEventListener('input', () => {
      if (!codeEdited) codeInput.value = normalizeCompetitionCode(nameInput.value);
    });

    let settled = false;
    const finish = (result: PlatformCompetition | null): void => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(result);
    };

    dialog.querySelector('[data-fst-comp-cancel]')?.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(null);
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;

      errorEl.hidden = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating…';

      void createCompetition({
        name: nameInput.value,
        code: codeInput.value,
        date: dateInput.value,
        venue: venueInput.value,
      })
        .then((created) => finish(created))
        .catch((err: unknown) => {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Create';
          errorEl.hidden = false;
          errorEl.textContent =
            err instanceof CompetitionApiError
              ? err.message
              : 'Could not create the competition. Please try again.';
        });
    });

    dialog.showModal();
    nameInput.focus();
  });
}
