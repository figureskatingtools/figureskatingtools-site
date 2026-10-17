/**
 * "Share competition" dialog — the owner (or an admin) decides who else sees
 * a competition, and whether they may change it.
 *
 * Follows the competition dialog's pattern (`competition-selector.ts`): one
 * `<dialog>` built from escaped markup, `data-fst-*` hooks, a single `finish()`.
 * The API enforces every rule (owner only, never the owner row or yourself);
 * this UI only keeps the obvious mistakes out of reach and words the errors.
 */

import {
  CompetitionApiError,
  competitionLabel,
  listAccess,
  recentShareUsers,
  removeAccess,
  searchHitEmail,
  searchUsers,
  setAccess,
  userRefToSearchHit,
  USER_SEARCH_MIN_CHARS,
  type AccessGrant,
  type CompetitionAccess,
  type PlatformCompetition,
  type ShareRole,
  type UserRef,
  type UserSearchHit,
} from './competition.js';
import { createKeyedLock } from './keyed-lock.js';

/** Escape text for interpolation into HTML (also safe inside quoted attributes) */
function esc(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DIALOG_ID = 'fst-share-dialog';
const LISTBOX_ID = 'fst-share-results';

/** Debounce between keystrokes and a directory search */
const SEARCH_DEBOUNCE_MS = 250;

/** How many search hits are shown (the API caps at 8 too) */
const MAX_RESULTS = 8;

/** How many "recent" quick picks are offered */
const MAX_QUICK_PICKS = 6;

const ROLE_LABELS: Record<CompetitionAccess, string> = {
  owner: 'Owner',
  write: 'Can edit',
  read: 'View only',
};

/** Human wording for the share routes' error codes */
function shareErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof CompetitionApiError)) return fallback;
  switch (err.code) {
    case 'user_not_found':
    case 'invalid_user':
      return 'That person is no longer in the user directory.';
    case 'cannot_target_self':
      return "You can't change your own access.";
    case 'cannot_change_owner':
      return "The owner's access can't be changed here.";
    case 'competition_deleted':
      return 'This competition has been deleted.';
    case 'owner_required':
      return 'Only the owner can manage who this competition is shared with.';
    case 'grant_not_found':
      return 'That person no longer has access.';
    case 'rate_limited':
      return 'Too many searches — try again later.';
    case 'not_found':
      return 'This competition no longer exists, or you no longer have access to it.';
    case 'conflict':
      return 'Someone changed the access at the same time — please try again.';
  }
  return err.status === 0 ? 'The competition registry is unreachable. Please try again.' : err.message || fallback;
}

/** A grant / recent pick (full e-mail) or a search hit (maybe only a masked e-mail) */
type Person = UserRef | UserSearchHit;

/** The e-mail to show: a search hit's full e-mail when known, else its masked hint */
function shownEmail(user: Person): string {
  return 'emailHint' in user ? searchHitEmail(user) : user.email;
}

/** The person's name, else their (possibly masked) e-mail — never empty */
function personLabel(user: Person): string {
  return user.name.trim() || shownEmail(user).trim() || 'Unknown user';
}

/** A complete e-mail address: what the search matches exactly (one @, no spaces) */
function looksLikeEmail(query: string): boolean {
  return /^[^@\s]+@[^@\s]+$/.test(query);
}

/**
 * Open the share dialog for `competition`.
 *
 * Resolves when the dialog closes: true when the access list changed, so the
 * caller can refresh whatever it shows about sharing.
 */
export function openShareCompetitionDialog(competition: PlatformCompetition): Promise<boolean> {
  return new Promise((resolve) => {
    document.getElementById(DIALOG_ID)?.remove();

    const dialog = document.createElement('dialog');
    dialog.id = DIALOG_ID;
    dialog.className = 'fst-comp-dialog fst-share-dialog';
    dialog.setAttribute('aria-labelledby', `${DIALOG_ID}-title`);
    dialog.innerHTML = `
      <div class="fst-comp-form">
        <h2 class="fst-comp-dialog-title" id="${DIALOG_ID}-title">Share “${esc(competitionLabel(competition))}”</h2>
        <p class="fst-comp-dialog-lead">
          People you share with see this competition in every tool.
          <strong>View only</strong> lets them look and download;
          <strong>Can edit</strong> lets them change everything except sharing and deleting.
        </p>

        <div class="fst-comp-field">
          <label class="fst-comp-field-label" for="${DIALOG_ID}-search">Add a person</label>
          <div class="fst-share-add">
            <div class="fst-share-combo">
              <input type="text" id="${DIALOG_ID}-search" autocomplete="off" spellcheck="false"
                     placeholder="Type a name or a full e-mail address" data-fst-share-search
                     role="combobox" aria-autocomplete="list" aria-expanded="false"
                     aria-controls="${LISTBOX_ID}" aria-describedby="${DIALOG_ID}-hint">
              <ul class="fst-share-results" id="${LISTBOX_ID}" role="listbox"
                  aria-label="Matching people" data-fst-share-results hidden></ul>
            </div>
            <select class="fst-share-role" data-fst-share-role aria-label="Access for the new person">
              <option value="read">${ROLE_LABELS.read}</option>
              <option value="write">${ROLE_LABELS.write}</option>
            </select>
            <button type="button" class="fst-comp-btn-primary" data-fst-share-add disabled>Share</button>
          </div>
          <span class="fst-comp-field-note" id="${DIALOG_ID}-hint" data-fst-share-hint aria-live="polite">
            Type a name (at least ${USER_SEARCH_MIN_CHARS} characters) or a full e-mail address.
            Only people who have signed in to the site can be found.
          </span>
          <div class="fst-share-recent" data-fst-share-recent hidden></div>
        </div>

        <div class="fst-share-section">
          <h3 class="fst-comp-field-label">People with access</h3>
          <ul class="fst-share-list" data-fst-share-list><li class="fst-share-empty">Loading…</li></ul>
        </div>

        <p class="fst-comp-dialog-error" data-fst-share-error role="alert" hidden></p>

        <div class="fst-comp-dialog-actions">
          <button type="button" class="fst-comp-btn-secondary" data-fst-share-done>Done</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);

    const searchInput = dialog.querySelector<HTMLInputElement>('[data-fst-share-search]')!;
    const resultsEl = dialog.querySelector<HTMLUListElement>('[data-fst-share-results]')!;
    const roleSelect = dialog.querySelector<HTMLSelectElement>('[data-fst-share-role]')!;
    const addBtn = dialog.querySelector<HTMLButtonElement>('[data-fst-share-add]')!;
    const hintEl = dialog.querySelector<HTMLElement>('[data-fst-share-hint]')!;
    const recentEl = dialog.querySelector<HTMLElement>('[data-fst-share-recent]')!;
    const listEl = dialog.querySelector<HTMLUListElement>('[data-fst-share-list]')!;
    const errorEl = dialog.querySelector<HTMLElement>('[data-fst-share-error]')!;
    const defaultHint = hintEl.textContent ?? '';

    let grants: AccessGrant[] = [];
    let recent: UserRef[] = [];
    let results: UserSearchHit[] = [];
    let activeIndex = -1;
    let picked: UserSearchHit | null = null;
    let changed = false;
    let searchTimer: number | null = null;
    let searchSeq = 0;
    let settled = false;
    /**
     * People with an access change in flight. One mutation per person at a time:
     * their row's controls (and Share, when they are the picked person) stay
     * disabled until it settles, so a slow PUT can never land after a DELETE.
     */
    const busy = createKeyedLock(() => {
      if (settled) return;
      renderGrants();
      syncAddButton();
    });

    const showError = (message: string | null): void => {
      errorEl.hidden = !message;
      errorEl.textContent = message ?? '';
    };

    const grantFor = (userId: string): AccessGrant | undefined =>
      grants.find((g) => g.userId === userId);

    /* ── Current access list ── */

    const renderGrants = (): void => {
      if (!grants.length) {
        listEl.innerHTML = '<li class="fst-share-empty">Nobody yet.</li>';
        return;
      }
      listEl.innerHTML = grants.map((g) => {
        const who = `<span class="fst-share-person">
            <span class="fst-share-name">${esc(personLabel(g))}</span>
            ${g.email && g.name.trim() ? `<span class="fst-share-email">${esc(g.email)}</span>` : ''}
          </span>`;
        if (g.role === 'owner') {
          return `<li class="fst-share-row">${who}<span class="fst-share-owner">${ROLE_LABELS.owner}</span></li>`;
        }
        const disabled = busy.has(g.userId) ? ' disabled' : '';
        return `<li class="fst-share-row">${who}
            <select class="fst-share-role" data-fst-grant-role="${esc(g.userId)}"${disabled}>
              <option value="read"${g.role === 'read' ? ' selected' : ''}>${ROLE_LABELS.read}</option>
              <option value="write"${g.role === 'write' ? ' selected' : ''}>${ROLE_LABELS.write}</option>
            </select>
            <button type="button" class="fst-share-remove" data-fst-grant-remove="${esc(g.userId)}"${disabled}>Remove</button>
          </li>`;
      }).join('');

      listEl.querySelectorAll<HTMLSelectElement>('[data-fst-grant-role]').forEach((select) => {
        const userId = select.getAttribute('data-fst-grant-role')!;
        const grant = grantFor(userId);
        if (grant) select.setAttribute('aria-label', `Access for ${personLabel(grant)}`);
        select.addEventListener('change', () => {
          void saveGrant(userId, select.value as ShareRole);
        });
      });
      listEl.querySelectorAll<HTMLButtonElement>('[data-fst-grant-remove]').forEach((btn) => {
        const userId = btn.getAttribute('data-fst-grant-remove')!;
        const grant = grantFor(userId);
        if (grant) btn.setAttribute('aria-label', `Remove ${personLabel(grant)}`);
        btn.addEventListener('click', () => {
          void dropGrant(userId);
        });
      });
    };

    const upsertGrant = (grant: AccessGrant): void => {
      const index = grants.findIndex((g) => g.userId === grant.userId);
      if (index >= 0) grants[index] = grant;
      else grants.push(grant);
    };

    /** Share is usable only with a picked person whose access isn't already changing */
    const syncAddButton = (): void => {
      addBtn.disabled = !picked || busy.has(picked.userId);
    };

    const saveGrant = async (userId: string, role: ShareRole): Promise<boolean> => {
      showError(null);
      const ok = await busy.run(userId, async () => {
        try {
          upsertGrant(await setAccess(competition.id, userId, role));
          changed = true;
          renderRecent();
          return true;
        } catch (err: unknown) {
          // The re-render when the lock is released puts a changed select back
          showError(shareErrorMessage(err, 'Could not change the access. Please try again.'));
          return false;
        }
      });
      if (ok === undefined) renderGrants(); // refused: undo the select change
      return ok === true;
    };

    const dropGrant = async (userId: string): Promise<void> => {
      showError(null);
      await busy.run(userId, async () => {
        try {
          await removeAccess(competition.id, userId);
        } catch (err: unknown) {
          showError(shareErrorMessage(err, 'Could not remove the access. Please try again.'));
          return;
        }
        grants = grants.filter((g) => g.userId !== userId);
        changed = true;
        renderRecent();
      });
    };

    /* ── Picking the person to add ── */

    const setPicked = (user: UserSearchHit | null): void => {
      picked = user;
      syncAddButton();
      if (user) {
        searchInput.value = personLabel(user);
        const existing = grantFor(user.userId);
        if (existing && existing.role !== 'owner') roleSelect.value = existing.role;
        hintEl.textContent = existing
          ? `${personLabel(user)} already has access (${ROLE_LABELS[existing.role]}). Share again to change it.`
          : `${shownEmail(user) || personLabel(user)} — choose the access and press Share.`;
      } else {
        hintEl.textContent = defaultHint;
      }
    };

    const closeResults = (): void => {
      resultsEl.hidden = true;
      resultsEl.innerHTML = '';
      searchInput.setAttribute('aria-expanded', 'false');
      searchInput.removeAttribute('aria-activedescendant');
      activeIndex = -1;
    };

    const highlight = (index: number): void => {
      activeIndex = index;
      resultsEl.querySelectorAll<HTMLElement>('[role="option"]').forEach((el, i) => {
        const on = i === index;
        el.classList.toggle('fst-share-option--active', on);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) {
          searchInput.setAttribute('aria-activedescendant', el.id);
          el.scrollIntoView?.({ block: 'nearest' });
        }
      });
      if (index < 0) searchInput.removeAttribute('aria-activedescendant');
    };

    const choose = (index: number): void => {
      const user = results[index];
      if (!user) return;
      closeResults();
      setPicked(user);
      addBtn.focus();
    };

    const renderResults = (): void => {
      if (!results.length) {
        closeResults();
        return;
      }
      resultsEl.innerHTML = results.map((u, i) => {
        const existing = grantFor(u.userId);
        return `<li class="fst-share-option" role="option" id="${LISTBOX_ID}-${i}" aria-selected="false"
                    data-fst-share-option="${i}">
            <span class="fst-share-name">${esc(personLabel(u))}</span>
            ${shownEmail(u) && u.name.trim() ? `<span class="fst-share-email">${esc(shownEmail(u))}</span>` : ''}
            ${existing ? `<span class="fst-share-has">${esc(ROLE_LABELS[existing.role])}</span>` : ''}
          </li>`;
      }).join('');
      resultsEl.hidden = false;
      searchInput.setAttribute('aria-expanded', 'true');
      activeIndex = -1;
      resultsEl.querySelectorAll<HTMLElement>('[data-fst-share-option]').forEach((el) => {
        const index = Number(el.getAttribute('data-fst-share-option'));
        // mousedown, not click: keeps focus in the input until the pick lands
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(index);
        });
      });
    };

    const runSearch = async (query: string): Promise<void> => {
      const seq = ++searchSeq;
      hintEl.textContent = 'Searching…';
      let found: UserSearchHit[];
      try {
        found = await searchUsers(query);
      } catch (err: unknown) {
        if (seq !== searchSeq) return;
        results = [];
        closeResults();
        hintEl.textContent = shareErrorMessage(err, 'Search failed. Please try again.');
        return;
      }
      if (seq !== searchSeq) return; // a newer keystroke won
      const ownerId = grants.find((g) => g.role === 'owner')?.userId;
      results = found.filter((u) => u.userId !== ownerId).slice(0, MAX_RESULTS);
      renderResults();
      hintEl.textContent = results.length
        ? `${results.length} ${results.length === 1 ? 'match' : 'matches'} — use the arrow keys and Enter to pick.`
        : looksLikeEmail(query)
          ? 'Nobody with that e-mail address has signed in to the site yet.'
          : 'Nobody’s name matches. To find someone by e-mail, type their full address. ' +
            'People appear here once they have signed in to the site.';
    };

    searchInput.addEventListener('input', () => {
      if (picked && searchInput.value !== personLabel(picked)) setPicked(null);
      // Every keystroke invalidates the previous search: its pending timer, its
      // in-flight response and the suggestions on screen, so Enter can never pick
      // a result that belongs to an earlier query.
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      searchTimer = null;
      searchSeq++;
      results = [];
      closeResults();
      if (!picked) hintEl.textContent = defaultHint;
      const query = searchInput.value.trim();
      if (query.length < USER_SEARCH_MIN_CHARS) return;
      searchTimer = window.setTimeout(() => {
        searchTimer = null;
        void runSearch(query);
      }, SEARCH_DEBOUNCE_MS);
    });

    searchInput.addEventListener('keydown', (e) => {
      const open = !resultsEl.hidden && results.length > 0;
      if (e.key === 'ArrowDown') {
        if (!open) return;
        e.preventDefault();
        highlight(activeIndex < results.length - 1 ? activeIndex + 1 : 0);
      } else if (e.key === 'ArrowUp') {
        if (!open) return;
        e.preventDefault();
        highlight(activeIndex > 0 ? activeIndex - 1 : results.length - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (open) choose(activeIndex >= 0 ? activeIndex : 0);
        else if (picked) void addPicked();
      } else if (e.key === 'Escape' && open) {
        // Close the list, not the whole dialog
        e.preventDefault();
        e.stopPropagation();
        closeResults();
      }
    });

    searchInput.addEventListener('blur', () => {
      // Give a mouse pick (mousedown) its turn first
      window.setTimeout(closeResults, 120);
    });

    const addPicked = async (): Promise<void> => {
      if (!picked) return;
      const user = picked;
      const ok = await saveGrant(user.userId, roleSelect.value as ShareRole);
      if (!ok || picked !== user) return; // failed, or the user moved on meanwhile
      searchInput.value = '';
      setPicked(null);
      hintEl.textContent = `Shared with ${personLabel(user)}.`;
      searchInput.focus();
    };

    addBtn.addEventListener('click', () => {
      void addPicked();
    });

    /* ── Recent quick picks ── */

    const renderRecent = (): void => {
      const offer = recent.filter((u) => !grantFor(u.userId)).slice(0, MAX_QUICK_PICKS);
      if (!offer.length) {
        recentEl.hidden = true;
        recentEl.innerHTML = '';
        return;
      }
      recentEl.hidden = false;
      recentEl.innerHTML = `<span class="fst-share-recent-label">Recent:</span>` +
        offer.map((u) => `<button type="button" class="fst-share-chip" data-fst-share-recent-id="${esc(u.userId)}"
            title="${esc(u.email)}">${esc(personLabel(u))}</button>`).join('');
      recentEl.querySelectorAll<HTMLButtonElement>('[data-fst-share-recent-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const user = recent.find((u) => u.userId === btn.getAttribute('data-fst-share-recent-id'));
          if (!user) return;
          closeResults();
          setPicked(userRefToSearchHit(user));
          addBtn.focus();
        });
      });
    };

    /* ── Lifecycle ── */

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      dialog.close();
      dialog.remove();
      resolve(changed);
    };

    dialog.querySelector('[data-fst-share-done]')?.addEventListener('click', finish);
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish();
    });

    dialog.showModal();
    searchInput.focus();

    void Promise.allSettled([listAccess(competition.id), recentShareUsers()]).then(([access, people]) => {
      if (settled) return;
      if (access.status === 'fulfilled') {
        grants = access.value;
        renderGrants();
      } else {
        listEl.innerHTML = '';
        showError(shareErrorMessage(access.reason, 'Could not load who has access.'));
      }
      if (people.status === 'fulfilled') {
        recent = people.value;
        renderRecent();
      }
    });
  });
}
