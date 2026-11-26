/**
 * The Custom generate dialog (fs-judgepapers issue #85): choose which days,
 * people, segments and roles of the generated papers go into a print, and
 * get that part as its own PDF per day.
 *
 * The flow is generate → pick → cut. `get_papers_index` says whether the
 * stored papers are the ones a Generate would make right now; if not, the
 * host runs a normal Generate first. The list is then drawn from the index
 * (custom.ts holds the selection model), and `generate_custom_papers` cuts
 * the selection out of the generated packets.
 *
 * The lists are rendered once per index; every change after that only
 * updates the ticks, the page counts and the row classes in place, so focus
 * and scroll position never move. main.ts owns everything outside the
 * dialog (the options, the settings queue, the generate run, the page's
 * notices) and hands it in as the host.
 */
import {
    isDownloadLinkStale,
    openFreshDownload,
    platformErrorMessage,
    readPlatformError,
    usableDownloadUrl,
} from '@figureskatingtools/shared-ui';
import { escapeAttr, escapeHtml } from '../shell.js';
import {
    DEFAULT_SEGMENT_GROUPING,
    applyLast,
    applyNotInLast,
    buildModel,
    carryOver,
    dayLabel,
    dropLoneCovers,
    filterPeople,
    formatCount,
    groupId,
    initialSelection,
    invertSelection,
    loneCovers,
    pagesText,
    parseIndexAnswer,
    partNote,
    personId,
    personRoles,
    personRows,
    plural,
    quickByCategory,
    quickByDay,
    roleChoices,
    selectAll,
    selectNone,
    setGroup,
    stateOf,
    timeLabel,
    toRequest,
    totals,
    type CustomModel,
    type IndexAnswer,
    type LastSelection,
    type PartRow,
    type QuickSegment,
    type SegmentGrouping,
} from './custom';

/**
 * How the page's wait for the papers of a cut-off generate request ended:
 * the stored papers are current, the wait ran out, or the index answered
 * something that will not change (400, 401, 403, 404, 410).
 */
export type PapersWait =
    | { kind: 'current' }
    | { kind: 'timeout' }
    | { kind: 'http'; status: number; text: string };

/** How a generate run the dialog asked for ended */
export type GenerateOutcome =
    | { kind: 'ok'; warning: string | null }
    | { kind: 'http'; status: number; text: string }
    /**
     * The request was cut (502 / 504, or no answer) while the backend run
     * may still be going. The page keeps the run (Generate stays busy) and
     * asks the index itself until the papers are there; `settled` says how
     * that ended. The wait belongs to the page: it goes on when the dialog
     * is closed.
     */
    | { kind: 'pending'; settled: Promise<PapersWait> }
    /** Not started; `message` says why */
    | { kind: 'refused'; message: string };

/** What the page does for the dialog */
export interface CustomDialogHost {
    apiBase: string;
    competitionId: string;
    /**
     * The generate options as they stood when the button was pressed. Every
     * index request and the generate run send these same options, so the
     * papers made are the ones the index is asked about.
     */
    options: unknown;
    /**
     * Waits until no settings save is queued. Null when the list on the page
     * is still what a run would act on, else the message for the user.
     */
    settle(): Promise<string | null>;
    /** The "Papers are missing" confirmation when something is missing; false = not confirmed */
    confirmMissing(): Promise<boolean>;
    /**
     * A normal generate run with `options`. `watching()` turns false when
     * the dialog is closed meanwhile: the host then ends the run like any
     * Generate (the warning or the failure as a notice on the page).
     */
    generate(watching: () => boolean): Promise<GenerateOutcome>;
    /**
     * The message when the platform refused a call for good (view-only
     * access, the competition is gone); null for any other failure. The
     * dialog then closes and hands the message to `notify`.
     */
    refusal(status: number, text: string): string | null;
    /** A message on the page, for when the dialog is no longer there to show it */
    notify(title: string, message: string): void;
    /** The backend replaced these source files with newer ones from the competition file pool */
    poolRefreshed(names: string[]): void;
    /**
     * Re-read the competition: its files or papers changed without the page
     * seeing it. Resolves once the re-read has ended and the list is rendered.
     */
    reloadDetails(): Promise<void>;
    /** Custom papers were created: re-read the Generated files list */
    filesCreated(): void;
    /** A fresh download link of a generated file (the first ones live 15 minutes) */
    freshDownloadUrl(fileName: string): Promise<string | null | undefined>;
    /** Where focus goes when the dialog closes */
    returnFocus(): HTMLElement | null;
}

const DIALOG_ID = 'custom-dialog';
/** Below this the panes stack and Quick select folds (the breakpoint in style.css) */
const NARROW_QUERY = '(max-width: 860px)';

const PREPARING_TEXT = 'This is the same work as Generate. The list opens when the papers are ready. '
    + 'If nothing has changed since the last Generate, this step is skipped.';
const STILL_PREPARING_TEXT = 'This is taking longer than usual. The papers are still being made; '
    + 'the list opens as soon as they are ready.';
const SESSION_EXPIRED = 'Your session has expired. Reload the page and sign in again.';
const NO_CONNECTION = 'Could not reach the server. Check your connection and try again.';

type State = 'preparing' | 'ready' | 'creating' | 'done' | 'error';

/** The parts of the dialog each state shows */
const VIEWS: Record<State, string[]> = {
    preparing: ['preparing'],
    ready: ['lists', 'foot'],
    creating: ['lists', 'foot', 'veil'],
    done: ['done'],
    error: ['error'],
};

/** One file `generate_custom_papers` created */
interface CreatedFile {
    fileName: string;
    url: string | null;
    expiration: string | null;
    date: string;
    packets: number;
    segments: number;
    pages: number;
}

function parseCreatedFiles(raw: unknown): CreatedFile[] {
    const files = (raw as { files?: unknown } | null)?.files;
    if (!Array.isArray(files)) return [];
    const number = (value: unknown): number => (typeof value === 'number' && value > 0 ? Math.trunc(value) : 0);
    return files
        .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === 'object' && typeof f.fileName === 'string')
        .map(f => ({
            fileName: f.fileName as string,
            url: usableDownloadUrl(f.url),
            expiration: typeof f.expiration === 'string' ? f.expiration : null,
            date: typeof f.date === 'string' ? f.date : '',
            packets: number(f.packets),
            segments: number(f.segments),
            pages: number(f.pages),
        }));
}

/** Closes the open dialog, whatever it is doing */
let closeOpen: (() => void) | null = null;

/**
 * Close an open Custom generate dialog (another competition was opened, or
 * the user's access turned view-only). A generate run it started goes on and
 * ends like any Generate.
 */
export function closeCustomDialog(): void {
    closeOpen?.();
}

/** Open the dialog and start preparing the papers */
export function openCustomDialog(host: CustomDialogHost): void {
    closeCustomDialog();
    document.getElementById(DIALOG_ID)?.remove();

    const dialog = document.createElement('dialog');
    dialog.id = DIALOG_ID;
    dialog.className = 'custom-dialog';
    dialog.setAttribute('aria-labelledby', `${DIALOG_ID}-title`);
    dialog.innerHTML = `
      <header class="custom-head">
        <h2 id="${DIALOG_ID}-title">Custom generate</h2>
        <span class="custom-made" data-made hidden></span>
        <button type="button" class="custom-close" data-close aria-label="Close">×</button>
      </header>

      <div class="custom-banner" data-notes role="status" hidden></div>
      <div class="custom-banner custom-banner--error" data-problem role="alert" hidden>
        <span data-problem-text></span>
        <button type="button" class="custom-link" data-problem-retry hidden>Retry</button>
      </div>

      <div class="custom-center" data-view="preparing" role="status" hidden>
        <div class="custom-spin" aria-hidden="true"></div>
        <h3>Preparing the papers…</h3>
        <p data-preparing-note hidden></p>
        <p data-preparing-text>${PREPARING_TEXT}</p>
      </div>

      <div class="custom-center" data-view="error" hidden>
        <h3 data-error-title></h3>
        <p data-error-text role="alert"></p>
        <div class="custom-center-actions">
          <button type="button" class="btn custom-btn-outline" data-error-retry>Retry</button>
          <button type="button" class="btn btn-ghost" data-close data-error-close>Close</button>
        </div>
      </div>

      <div class="custom-body" data-view="lists" hidden>
        <details class="custom-quick" data-quick open>
          <summary>Quick select</summary>
          <div class="custom-quick-in">
            <div>
              <div class="custom-q-actions">
                <button type="button" class="custom-sbtn" data-all>All</button>
                <button type="button" class="custom-sbtn" data-none>None</button>
                <button type="button" class="custom-sbtn" data-invert>Invert</button>
              </div>
              <div data-last-wrap hidden>
                <div class="custom-q-actions custom-q-last">
                  <button type="button" class="custom-sbtn" data-last>Last selection</button>
                  <button type="button" class="custom-sbtn" data-not-last>Not in last selection</button>
                </div>
                <p class="custom-q-note" data-last-note></p>
              </div>
            </div>

            <div>
              <div class="custom-q-h">
                <h3 id="${DIALOG_ID}-h-seg">Segments</h3>
                <span class="custom-pair" role="group" aria-label="Group the segments">
                  <button type="button" class="custom-sbtn" data-by="day" aria-pressed="false">By day</button>
                  <button type="button" class="custom-sbtn" data-by="category" aria-pressed="false">By category</button>
                </span>
              </div>
              <div data-q-by="day" role="group" aria-labelledby="${DIALOG_ID}-h-seg"></div>
              <div data-q-by="category" role="group" aria-labelledby="${DIALOG_ID}-h-seg" hidden></div>
              <p class="custom-q-note">One tick sets that segment for every person. Cover pages are not touched.</p>
            </div>

            <div>
              <div class="custom-q-h"><h3 id="${DIALOG_ID}-h-roles">Roles</h3></div>
              <div data-q-roles role="group" aria-labelledby="${DIALOG_ID}-h-roles"></div>
            </div>

            <div>
              <div class="custom-q-h"><h3 id="${DIALOG_ID}-h-extras">Extras</h3></div>
              <div data-q-extras role="group" aria-labelledby="${DIALOG_ID}-h-extras"></div>
            </div>
          </div>
        </details>

        <div class="custom-people">
          <div class="custom-people-head">
            <h3 id="${DIALOG_ID}-h-people">Papers by person</h3>
            <button type="button" class="custom-sbtn" data-expand>Expand all</button>
            <button type="button" class="custom-sbtn" data-collapse>Collapse all</button>
            <input type="search" class="custom-search" data-search placeholder="Search a name…"
                   aria-label="Search a person by name" autocomplete="off" spellcheck="false">
          </div>
          <div class="custom-tree-scroll">
            <ul class="custom-tree" data-tree aria-labelledby="${DIALOG_ID}-h-people"></ul>
            <p class="custom-empty" data-empty hidden></p>
          </div>
        </div>
      </div>

      <footer class="custom-foot" data-view="foot" hidden>
        <div class="custom-totals" data-totals role="status"></div>
        <div class="custom-foot-right">
          <label class="custom-opt"><input type="checkbox" data-contents checked> Contents page at the front</label>
          <span class="custom-foot-buttons">
            <button type="button" class="btn btn-ghost" data-close>Cancel</button>
            <button type="button" class="btn btn-primary" data-go disabled>Generate selected</button>
          </span>
        </div>
        <div class="custom-lone" data-lone role="status" hidden>
          <span data-lone-text></span>
          <button type="button" class="custom-link" data-lone-fix>Leave those covers out</button>
        </div>
      </footer>

      <div class="custom-veil" data-view="veil" role="status" tabindex="-1" hidden>
        <div class="custom-spin" aria-hidden="true"></div>
        <div>Creating the custom PDF…</div>
      </div>

      <div class="custom-done" data-view="done" hidden></div>
    `;
    document.body.appendChild(dialog);

    const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => dialog.querySelector<T>(selector)!;
    const madeEl = $('[data-made]');
    const notesEl = $('[data-notes]');
    const problemEl = $('[data-problem]');
    const problemText = $('[data-problem-text]');
    const problemRetry = $<HTMLButtonElement>('[data-problem-retry]');
    const preparingNote = $('[data-preparing-note]');
    const preparingText = $('[data-preparing-text]');
    const errorTitle = $('[data-error-title]');
    const errorText = $('[data-error-text]');
    const errorRetry = $<HTMLButtonElement>('[data-error-retry]');
    const listsEl = $('[data-view="lists"]');
    const footEl = $('[data-view="foot"]');
    const veilEl = $('[data-view="veil"]');
    const doneEl = $('[data-view="done"]');
    const quickEl = $<HTMLDetailsElement>('[data-quick]');
    const lastWrap = $('[data-last-wrap]');
    const lastNote = $('[data-last-note]');
    const treeEl = $('[data-tree]');
    const emptyEl = $('[data-empty]');
    const searchEl = $<HTMLInputElement>('[data-search]');
    const totalsEl = $('[data-totals]');
    const loneEl = $('[data-lone]');
    const loneText = $('[data-lone-text]');
    const contentsBox = $<HTMLInputElement>('[data-contents]');
    const goBtn = $<HTMLButtonElement>('[data-go]');
    const closeBtn = $<HTMLButtonElement>('.custom-close');

    let state: State = 'preparing';
    let closed = false;
    /** Closed by the page (another competition, view-only), not by the user */
    let closedByHost = false;
    /** Every prepare and every submit takes a number; one that is no longer the latest stops */
    let run = 0;
    let model: CustomModel | null = null;
    let sel = new Set<string>();
    let last: LastSelection | null = null;
    /** The selection to re-apply once the papers are prepared again */
    let keepKeys: string[] | null = null;
    /** What the banner above the lists says (a generate warning, "the papers had changed") */
    let notes: string[] = [];
    /** The page's file list is behind the backend's (a pool refresh): re-read it when the dialog closes */
    let listStale = false;
    /** When the done view's download links were made (epoch ms) */
    let filesFetchedAt = 0;
    let grouping: SegmentGrouping = DEFAULT_SEGMENT_GROUPING;
    /** The ticks of each group, with the row and the page column they update */
    const rows = new Map<string, Array<{ input: HTMLInputElement; line: HTMLElement; pg: HTMLElement }>>();

    /* ── States ── */

    function show(next: State) {
        state = next;
        dialog.dataset.state = next;
        for (const el of dialog.querySelectorAll<HTMLElement>('[data-view]')) {
            el.hidden = !VIEWS[next].includes(el.dataset.view!);
        }
        const listed = next === 'ready' || next === 'creating';
        madeEl.hidden = !(listed || next === 'done');
        notesEl.hidden = !listed || notes.length === 0;
        problemEl.hidden = next !== 'ready' || problemText.textContent === '';
        // While the request runs nothing of the selection may change
        listsEl.inert = next === 'creating';
        footEl.inert = next === 'creating';
        closeBtn.disabled = next === 'creating';
    }

    function renderNotes() {
        notesEl.innerHTML = notes.map(note => `<p>${escapeHtml(note)}</p>`).join('');
        notesEl.hidden = !(state === 'ready' || state === 'creating') || notes.length === 0;
    }

    /** An inline message above the lists; `retry` offers the request again */
    function setProblem(message: string, retry = false) {
        problemText.textContent = message;
        problemRetry.hidden = !retry;
        problemEl.hidden = state !== 'ready' || message === '';
    }

    function fail(title: string, message: string, retry: boolean) {
        errorTitle.textContent = title;
        errorText.textContent = message;
        errorRetry.hidden = !retry;
        show('error');
        (retry ? errorRetry : $<HTMLButtonElement>('[data-error-close]')).focus();
    }

    /** The message of a 503: the platform's own wording, else the backend's text */
    function unavailableText(status: number, text: string): string {
        const code = readPlatformError(status, text);
        return code ? platformErrorMessage(code) : (text || 'The service is not available right now. Try again.');
    }

    // Narrow windows: Quick select starts folded; wide windows always show it
    const narrow = window.matchMedia(NARROW_QUERY);
    const fitQuick = () => { quickEl.open = !narrow.matches; };

    /** What closeCustomDialog runs: the page takes the dialog away */
    const closeFromHost = () => {
        closedByHost = true;
        close();
    };

    function close() {
        if (closed) return;
        closed = true;
        if (closeOpen === closeFromHost) closeOpen = null;
        narrow.removeEventListener('change', fitQuick);
        const target = host.returnFocus();
        if (dialog.open) dialog.close();
        dialog.remove();
        if (target?.isConnected && !(target instanceof HTMLButtonElement && target.disabled)) target.focus();
        if (listStale && !closedByHost) void host.reloadDetails();
    }

    /** Close on the user's request: not while the custom PDF is being created */
    function requestClose() {
        if (state !== 'creating') close();
    }

    /** The platform refused for good: the page shows why, the dialog goes */
    function refused(message: string) {
        close();
        host.notify('Custom generate', message);
    }

    /* ── Preparing: index → (generate → index) → lists ── */

    type IndexResult =
        | { ok: true; answer: IndexAnswer }
        /** status 0 = no answer, -1 = an answer that could not be read */
        | { ok: false; status: number; text: string };

    async function requestIndex(): Promise<IndexResult> {
        let resp: Response;
        try {
            resp = await fetch(`${host.apiBase}/get_papers_index`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: host.competitionId, options: host.options }),
            });
        } catch (_e) {
            return { ok: false, status: 0, text: '' };
        }
        if (!resp.ok) return { ok: false, status: resp.status, text: (await resp.text().catch(() => '')).trim() };
        const answer = parseIndexAnswer(await resp.json().catch(() => null));
        if (!answer) return { ok: false, status: -1, text: '' };
        if (answer.refreshedFromPool.length && !closed) {
            host.poolRefreshed(answer.refreshedFromPool);
            listStale = true;
        }
        return { ok: true, answer };
    }

    /** A failed index request, in the error view */
    function indexFailed(status: number, text: string) {
        const refusal = host.refusal(status, text);
        if (refusal) {
            refused(refusal);
        } else if (status === 404) {
            fail('Custom generate is not available', 'Custom generate is not available on this server yet.', false);
        } else if (status === 401) {
            fail('The papers were not prepared', SESSION_EXPIRED, false);
        } else if (status === 400) {
            fail('The papers were not prepared', text || 'The request was not accepted.', false);
        } else if (status === 503) {
            fail('The papers could not be read', unavailableText(status, text), true);
        } else if (status === 0) {
            fail('The papers could not be read', NO_CONNECTION, true);
        } else {
            fail('The papers could not be read', 'The list of the papers could not be read. Try again.', true);
        }
    }

    /**
     * Find out whether the papers are current, generate them when they are
     * not, and open the lists. `keep` is a selection to re-apply (the papers
     * had changed under an open list); `note` says so while preparing.
     * Never loops: papers that are still not current after one generate run
     * end in the error view, where Retry is the user's decision.
     */
    async function prepare(keep: string[] | null, note = ''): Promise<void> {
        const mine = ++run;
        try {
            await prepareRun(mine, keep, note);
        } catch (e) {
            // Nothing here is expected to throw; never leave the spinner turning
            console.warn('Custom generate: preparing failed', e);
            if (!closed && mine === run) {
                fail('The papers could not be listed', 'Something went wrong while opening the list. Try again.', true);
            }
        }
    }

    async function prepareRun(mine: number, keep: string[] | null, note: string) {
        const live = () => !closed && mine === run;
        keepKeys = keep;
        notes = [];
        renderNotes();
        setProblem('');
        preparingNote.textContent = note;
        preparingNote.hidden = note === '';
        preparingText.textContent = PREPARING_TEXT;
        show('preparing');
        // Whatever had focus (Retry, the veil) is gone now: keep focus in the dialog
        if (dialog.open) closeBtn.focus();

        const problem = await host.settle();
        if (!live()) return;
        if (problem) {
            fail('The papers were not prepared', problem, true);
            return;
        }

        const first = await requestIndex();
        if (!live()) return;
        if (!first.ok) {
            indexFailed(first.status, first.text);
            return;
        }
        if (first.answer.current) {
            openLists(first.answer);
            return;
        }

        // The files are no longer the ones the page lists (an upload or a
        // delete elsewhere, a newer export taken from the pool): what is
        // missing is asked about from a fresh list, checked like the first one
        if (first.answer.reason === 'files' || first.answer.refreshedFromPool.length > 0) {
            await host.reloadDetails();
            if (!live()) return;
            listStale = false;
            const changed = await host.settle();
            if (!live()) return;
            if (changed) {
                fail('The papers were not prepared', changed, true);
                return;
            }
        }

        // Not current: the same run as Generate, after the same confirmation
        if (!(await host.confirmMissing())) {
            if (live()) close();
            return;
        }
        if (!live()) return;
        const outcome = await host.generate(() => !closed);
        if (!live()) return;

        if (outcome.kind === 'refused') {
            fail('The papers were not prepared', outcome.message, true);
            return;
        }
        if (outcome.kind === 'http') {
            const refusal = host.refusal(outcome.status, outcome.text);
            if (refusal) {
                refused(refusal);
            } else if (outcome.status === 401) {
                fail('The papers were not prepared', SESSION_EXPIRED, false);
            } else if (outcome.status === 503) {
                fail('The papers were not prepared', unavailableText(outcome.status, outcome.text), true);
            } else {
                fail('The papers were not prepared', outcome.text
                    ? `An error occurred while generating papers: ${outcome.text}`
                    : `An error occurred while generating papers (HTTP ${outcome.status}).`, true);
            }
            return;
        }
        if (outcome.kind === 'pending') {
            // The request was cut, the run may still be going: the page is
            // waiting for the papers (one wait, with or without this dialog)
            preparingText.textContent = STILL_PREPARING_TEXT;
            const waited = await outcome.settled;
            if (!live()) return;
            listStale = false;   // the page re-read the competition when its wait ended
            if (waited.kind === 'timeout') {
                fail('The papers are not ready yet', 'The papers were not ready after three minutes. They may '
                    + 'still be on their way: try again in a moment.', true);
                return;
            }
            if (waited.kind === 'http') {
                indexFailed(waited.status, waited.text);
                return;
            }
        } else if (outcome.warning) {
            notes.push(outcome.warning);
            renderNotes();
        }

        // The page re-reads the competition after the run; the papers are
        // there, so the index is asked once more, with the same options
        listStale = false;
        const second = await requestIndex();
        if (!live()) return;
        if (!second.ok) {
            indexFailed(second.status, second.text);
        } else if (second.answer.current) {
            openLists(second.answer);
        } else {
            fail('The papers could not be listed', 'The papers were generated, but the files or settings of the '
                + 'competition changed meanwhile, so the list would not match them. Try again.', true);
        }
    }

    /* ── The lists ── */

    let seq = 0;
    const SPACER = '<span></span>';

    /** One tick row; `label` and `meta` are HTML */
    function rowHtml(o: { group: string; label: string; meta?: string; cls?: string; lead?: string }): string {
        const id = `${DIALOG_ID}-c${++seq}`;
        return `<div class="custom-line ${o.cls ?? ''}">${o.lead ?? ''}`
            + `<input type="checkbox" id="${id}" data-g="${escapeAttr(o.group)}" aria-describedby="${o.meta ? `${id}-m ` : ''}${id}-p">`
            + `<div class="custom-txt"><label class="custom-lbl" for="${id}">${o.label}</label>`
            + `${o.meta ? `<span class="custom-meta" id="${id}-m">${o.meta}</span>` : ''}</div>`
            + `<span class="custom-pg" id="${id}-p"></span></div>`;
    }

    /** A disclosure button for the rows listed in `kidsId` */
    const twisty = (open: boolean, what: string, kidsId: string): string =>
        `<button type="button" class="custom-tw" aria-expanded="${open}" aria-controls="${kidsId}" `
        + `aria-label="${escapeAttr(`Rows of ${what}`)}"></button>`;

    const timeHtml = (when: string): string => (when ? `<span class="custom-t">${escapeHtml(when)}</span>` : '');

    function treeHtml(m: CustomModel): string {
        const index = m.index;
        return index.days.map(day => {
            const date = day.date;
            const label = dayLabel(date);
            const copies = day.schedule?.copies ?? 0;
            const schedule = day.schedule ? `<li class="custom-node custom-extra">${rowHtml({
                group: groupId.schedule(date), cls: 'custom-l1', lead: SPACER,
                label: `Combined time schedule <span class="custom-times">× ${formatCount(copies)} ${copies === 1 ? 'copy' : 'copies'}</span>`,
            })}</li>` : '';
            const people = day.people.map(person => {
                const partHtml = (row: PartRow, cls: string, withCategory: boolean): string => {
                    const name = withCategory && row.segment ? `${row.category}, ${row.segment}`
                        : (withCategory ? row.category : row.segment || row.category);
                    const note = partNote(row.part);
                    const meta = [row.part.label, note].filter(Boolean).map(escapeHtml).join(' · ');
                    return `<li class="custom-node">${rowHtml({
                        group: row.group, cls, lead: SPACER, label: `${timeHtml(row.start)}${escapeHtml(name)}`, meta,
                    })}</li>`;
                };
                const kids = `<li class="custom-node">${rowHtml({
                    group: groupId.cover(date, person.slug), label: 'Cover page', cls: 'custom-l2', lead: SPACER,
                })}</li>` + personRows(index, date, person).map(row => (row.kind === 'part'
                    ? partHtml(row.row, 'custom-l2', true)
                    : `<li class="custom-node custom-cat">${rowHtml({
                        group: row.group, label: escapeHtml(row.name), cls: 'custom-l2', lead: SPACER,
                    })}<ul class="custom-kids">${row.rows.map(r => partHtml(r, 'custom-l3', false)).join('')}</ul></li>`)).join('');
                const kidsId = `${DIALOG_ID}-k${++seq}`;
                return `<li class="custom-node custom-person" data-person="${escapeAttr(personId(date, person.slug))}">`
                    + rowHtml({
                        group: groupId.person(date, person.slug), label: escapeHtml(person.name),
                        meta: escapeHtml(personRoles(person)), cls: 'custom-l1', lead: twisty(false, person.name, kidsId),
                    })
                    + `<ul class="custom-kids" id="${kidsId}" hidden>${kids}</ul></li>`;
            }).join('');
            const kidsId = `${DIALOG_ID}-k${++seq}`;
            return `<li class="custom-node custom-day">`
                + rowHtml({
                    group: groupId.day(date), label: escapeHtml(label),
                    meta: plural(day.people.length, 'person', 'people'), lead: twisty(true, label, kidsId),
                })
                + `<ul class="custom-kids" id="${kidsId}">${schedule}${people}</ul></li>`;
        }).join('');
    }

    const peopleMeta = (segment: QuickSegment): string => plural(segment.people, 'person', 'people');

    function quickByDayHtml(m: CustomModel): string {
        return quickByDay(m).map(day => {
            const headId = `${DIALOG_ID}-d${++seq}`;
            const segmentHtml = (s: QuickSegment, cls: string, withCategory: boolean): string => rowHtml({
                group: s.group, cls, meta: peopleMeta(s),
                label: `${timeHtml(s.start)}${escapeHtml(withCategory && s.segment ? `${s.category}, ${s.segment}`
                    : (withCategory ? s.category : s.segment || s.category))}`,
            });
            const body = day.rows.map(row => (row.kind === 'segment'
                ? segmentHtml(row.segment, '', true)
                : `<div class="custom-cat">${rowHtml({ group: row.group, label: escapeHtml(row.name) })}</div>`
                    + row.segments.map(s => segmentHtml(s, 'custom-q2', false)).join(''))).join('');
            return `<div class="custom-q-day" role="group" aria-labelledby="${headId}">`
                + `<div class="custom-q-day-h" id="${headId}">${escapeHtml(dayLabel(day.date))}</div>${body}</div>`;
        }).join('');
    }

    function quickByCategoryHtml(m: CustomModel): string {
        return quickByCategory(m).map(category =>
            `<div class="custom-cat">${rowHtml({ group: category.group, label: escapeHtml(category.name) })}</div>`
            + category.segments.map(s => rowHtml({
                group: s.group, cls: 'custom-q2', meta: peopleMeta(s),
                label: `${timeHtml(`${dayLabel(s.date)} ${s.start}`.trim())}${escapeHtml(s.segment || s.category)}`,
            })).join('')).join('');
    }

    /** Draw both panes from the model (once per index) and collect the ticks */
    function renderLists(m: CustomModel) {
        treeEl.innerHTML = treeHtml(m);
        $('[data-q-by="day"]').innerHTML = quickByDayHtml(m);
        $('[data-q-by="category"]').innerHTML = quickByCategoryHtml(m);
        $('[data-q-roles]').innerHTML = roleChoices(m).map(role =>
            rowHtml({ group: role.group, label: escapeHtml(role.label) })).join('');
        $('[data-q-extras]').innerHTML = rowHtml({ group: groupId.covers, label: 'Cover pages' })
            + (m.groups.has(groupId.schedules) ? rowHtml({ group: groupId.schedules, label: 'Combined schedules' }) : '');

        rows.clear();
        for (const input of dialog.querySelectorAll<HTMLInputElement>('input[data-g]')) {
            const line = input.closest<HTMLElement>('.custom-line')!;
            const group = input.dataset.g!;
            if (!rows.has(group)) rows.set(group, []);
            rows.get(group)!.push({ input, line, pg: line.querySelector<HTMLElement>('.custom-pg')! });
        }
        const made = timeLabel(m.index.generatedUtc);
        madeEl.textContent = `${made ? `Papers made ${made} · ` : ''}`
            + `${plural(m.groups.get(groupId.all)?.pages ?? 0, 'page', 'pages')}`;
        searchEl.value = '';
        applyFilter();
    }

    /** Bring every tick, page count and total in line with the selection, in place */
    function refresh() {
        if (!model) return;
        for (const [group, list] of rows) {
            const s = stateOf(model, sel, group);
            const pages = pagesText(s);
            for (const row of list) {
                row.input.checked = s.all;
                row.input.indeterminate = s.some;
                row.input.disabled = s.empty;
                if (row.pg.textContent !== pages) row.pg.textContent = pages;
                row.line.classList.toggle('is-off', s.none);
                row.line.classList.toggle('is-some', s.some);
                row.line.classList.toggle('is-empty', s.empty);
            }
        }
        const t = totals(model, sel);
        const summary = `<b>${formatCount(t.pages)}</b> of ${plural(t.total, 'page', 'pages')} · `
            + `${plural(t.packets, 'packet', 'packets')} · ${plural(t.days, 'day', 'days')}`;
        // The status region is announced when it changes: leave it alone when it does not
        if (totalsEl.innerHTML !== summary) totalsEl.innerHTML = summary;
        const lone = loneCovers(model, sel).length;
        const loneSentence = lone === 1 ? '1 packet would hold only a cover page.'
            : `${formatCount(lone)} packets would hold only a cover page.`;
        if (lone && loneText.textContent !== loneSentence) loneText.textContent = loneSentence;
        loneEl.hidden = lone === 0;
        goBtn.disabled = t.pages === 0;
    }

    function renderLast() {
        lastWrap.hidden = !last;
        if (!last) return;
        const when = timeLabel(last.savedUtc);
        lastNote.textContent = `Last custom run${when ? ` ${when}` : ''}`
            + `${last.pages ? `: ${plural(last.pages, 'page', 'pages')}` : ''}.`;
    }

    function setGrouping(by: SegmentGrouping) {
        grouping = by;
        for (const button of dialog.querySelectorAll<HTMLElement>('[data-by]')) {
            button.setAttribute('aria-pressed', String(button.dataset.by === by));
        }
        for (const list of dialog.querySelectorAll<HTMLElement>('[data-q-by]')) list.hidden = list.dataset.qBy !== by;
    }

    /** The person search: only the people whose name matches, and the days that have one */
    function applyFilter() {
        if (!model) return;
        const hits = filterPeople(model.index, searchEl.value);
        let shownDays = 0;
        for (const day of treeEl.querySelectorAll<HTMLElement>(':scope > .custom-day')) {
            let shown = 0;
            for (const node of day.querySelectorAll<HTMLElement>('.custom-person')) {
                const hit = !hits || hits.has(node.dataset.person ?? '');
                node.hidden = !hit;
                if (hit) shown++;
            }
            // A day's combined schedule is nobody's: out of the way while searching
            for (const extra of day.querySelectorAll<HTMLElement>('.custom-extra')) extra.hidden = hits !== null;
            day.hidden = hits !== null && shown === 0;
            if (!day.hidden) shownDays++;
        }
        emptyEl.textContent = hits ? 'Nobody matches that name.' : 'The generated papers hold nothing to choose from.';
        emptyEl.hidden = shownDays > 0;
    }

    function setOpen(node: Element, open: boolean) {
        const button = node.querySelector<HTMLElement>(':scope > .custom-line .custom-tw');
        const kids = node.querySelector<HTMLElement>(':scope > .custom-kids');
        if (!button || !kids) return;
        button.setAttribute('aria-expanded', String(open));
        kids.hidden = !open;
    }

    /**
     * Focus for a keyboard user arriving at the lists: the first quick
     * selection, or the search field while Quick select is folded (a narrow
     * window), where its buttons take no focus.
     */
    function focusLists() {
        for (const target of [$('[data-all]'), searchEl]) {
            target.focus();
            if (document.activeElement === target) return;
        }
    }

    function openLists(answer: IndexAnswer) {
        if (!answer.index) return;
        model = buildModel(answer.index);
        sel = keepKeys ? carryOver(model, keepKeys) : initialSelection(model);
        keepKeys = null;
        last = answer.last;
        renderLists(model);
        renderLast();
        setGrouping(grouping);
        show('ready');
        renderNotes();
        refresh();
        focusLists();
    }

    /* ── Generate selected → done ── */

    async function submit() {
        if (state !== 'ready' || !model) return;
        const current = model;
        const selection = toRequest(current, sel);
        if (!Object.keys(selection).length) return;
        const mine = ++run;
        setProblem('');
        show('creating');
        veilEl.focus();

        let resp: Response | null = null;
        try {
            resp = await fetch(`${host.apiBase}/generate_custom_papers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: host.competitionId,
                    generation: current.index.generation,
                    selection,
                    contents: contentsBox.checked,
                }),
            });
        } catch (_e) {
            resp = null;
        }
        const status = resp?.status ?? 0;
        const files = resp?.ok ? parseCreatedFiles(await resp.json().catch(() => null)) : [];
        const text = resp && !resp.ok ? (await resp.text().catch(() => '')).trim() : '';

        // What went wrong, for the user; '' when the papers were created
        const problem = resp?.ok ? ''
            : status === 0 ? NO_CONNECTION
            : status === 401 ? SESSION_EXPIRED
            : status === 503 ? unavailableText(status, text)
            : (status === 400 || status === 409 || status === 413) && text ? text
            : `Could not create the custom papers (HTTP ${status}). Try again.`;

        if (closed) {
            // Closed mid-request (a second Escape closes a modal dialog in Chrome
            // even while its cancel is prevented): the outcome goes to the page
            if (closedByHost) return;
            if (resp?.ok || status === 0 || status === 502 || status === 504) host.filesCreated();
            if (problem) host.notify('Custom papers not created', host.refusal(status, text) ?? problem);
            return;
        }
        if (mine !== run) return;

        if (resp?.ok) {
            host.filesCreated();
            last = {
                savedUtc: new Date().toISOString(),
                pages: files.reduce((sum, file) => sum + file.pages, 0),
                selection,
            };
            renderLast();
            renderDone(files);
            show('done');
            doneEl.querySelector<HTMLElement>('h3')?.focus();
            return;
        }

        const refusal = host.refusal(status, text);
        if (refusal) {
            refused(refusal);
            return;
        }
        if (status === 409 && text.startsWith('papers_changed')) {
            // The papers are no longer the ones this list shows: prepare again,
            // and tick again whatever of the selection still exists
            await prepare([...sel], 'The papers changed after the list was opened, so they are prepared again. '
                + 'Your selection is kept.');
            if (!closed && state === 'ready') {
                notes.unshift('The papers had changed, so the list was made again. Check the selection and generate once more.');
                renderNotes();
            }
            return;
        }
        // Cut off without an answer, the request may have created the files all the same
        if (status === 0 || status === 502 || status === 504) host.filesCreated();
        show('ready');
        setProblem(problem, status === 503 || status === 0);
        goBtn.focus();
    }

    function renderDone(files: CreatedFile[]) {
        filesFetchedAt = Date.now();
        const fileHtml = (file: CreatedFile): string => {
            const facts = [
                dayLabel(file.date),
                plural(file.packets, 'packet', 'packets'),
                plural(file.segments, 'segment', 'segments'),
                plural(file.pages, 'page', 'pages'),
            ].filter(Boolean).join(' · ');
            const link = file.url
                ? `<a class="custom-sbtn" href="${escapeAttr(file.url)}" target="_blank" rel="noopener noreferrer"
                      data-file="${escapeAttr(file.fileName)}" data-expiration="${escapeAttr(file.expiration ?? '')}"
                      aria-label="${escapeAttr(`Download ${file.fileName}`)}">Download</a>`
                : '<span class="custom-fdesc">Download it from the Generated files list</span>';
            return `
              <li>
                <div>
                  <div class="custom-fname">${escapeHtml(file.fileName)}</div>
                  <div class="custom-fdesc">${escapeHtml(facts)}</div>
                </div>
                ${link}
              </li>`;
        };
        doneEl.innerHTML = `
          <div class="custom-done-head">
            <div>
              <h3 tabindex="-1">Custom papers are ready</h3>
              <p class="custom-done-sub">They are also in the Generated files list, where you can send,
                 copy a link or delete them like any day PDF.</p>
            </div>
            <div class="custom-done-actions">
              <button type="button" class="btn custom-btn-outline" data-again>Make another</button>
              <button type="button" class="btn btn-primary" data-close>Close</button>
            </div>
          </div>
          ${files.length
              ? `<ul class="custom-files">${files.map(fileHtml).join('')}</ul>`
              : '<p class="custom-done-sub">Find the new files in the Generated files list.</p>'}`;
    }

    /* ── Events ── */

    dialog.addEventListener('change', (e) => {
        const input = e.target;
        if (!(input instanceof HTMLInputElement) || input.dataset.g === undefined || !model) return;
        setGroup(model, sel, input.dataset.g, input.checked);
        setProblem('');
        refresh();
    });

    dialog.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const button = target.closest<HTMLElement>('button, a');
        if (!button || !dialog.contains(button)) return;

        if (button.hasAttribute('data-close')) {
            requestClose();
        } else if (button.classList.contains('custom-tw')) {
            const node = button.closest('.custom-node');
            if (node) setOpen(node, button.getAttribute('aria-expanded') !== 'true');
        } else if (button.hasAttribute('data-error-retry')) {
            void prepare(keepKeys);
        } else if (button.hasAttribute('data-problem-retry')) {
            void submit();
        } else if (button.hasAttribute('data-go')) {
            void submit();
        } else if (button.hasAttribute('data-again')) {
            show('ready');
            refresh();
            focusLists();
        } else if (button.dataset.by === 'day' || button.dataset.by === 'category') {
            setGrouping(button.dataset.by);
        } else if (button.hasAttribute('data-expand')) {
            treeEl.querySelectorAll('.custom-day, .custom-person').forEach(node => setOpen(node, true));
        } else if (button.hasAttribute('data-collapse')) {
            treeEl.querySelectorAll('.custom-person').forEach(node => setOpen(node, false));
        } else if (button instanceof HTMLAnchorElement && button.dataset.file !== undefined) {
            // A download link that has (nearly) expired is fetched again before it opens
            if (!isDownloadLinkStale(filesFetchedAt, button.dataset.expiration)) return;
            e.preventDefault();
            const fileName = button.dataset.file;
            void openFreshDownload({
                newTab: true,
                refresh: () => host.freshDownloadUrl(fileName),
                onUnavailable: () => {
                    const note = document.createElement('span');
                    note.className = 'custom-fdesc';
                    note.textContent = 'Download it from the Generated files list';
                    button.replaceWith(note);
                },
            });
        } else if (model) {
            // The quick selections
            if (button.hasAttribute('data-all')) selectAll(model, sel);
            else if (button.hasAttribute('data-none')) selectNone(sel);
            else if (button.hasAttribute('data-invert')) invertSelection(model, sel);
            else if (button.hasAttribute('data-last') && last) applyLast(model, sel, last.selection);
            else if (button.hasAttribute('data-not-last') && last) applyNotInLast(model, sel, last.selection);
            else if (button.hasAttribute('data-lone-fix')) dropLoneCovers(model, sel);
            else return;
            setProblem('');
            refresh();
            // "Leave those covers out" hides its own notice: keep focus in the footer
            if (button.hasAttribute('data-lone-fix') && loneEl.hidden) (goBtn.disabled ? contentsBox : goBtn).focus();
        }
    });

    searchEl.addEventListener('input', applyFilter);

    // Escape: never while the custom PDF is being created
    dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        requestClose();
    });
    // Closed anyway (a second Escape in Chrome): tidy up as for any close
    dialog.addEventListener('close', () => close());

    narrow.addEventListener('change', fitQuick);
    fitQuick();

    closeOpen = closeFromHost;
    setGrouping(grouping);
    show('preparing');
    dialog.showModal();
    void prepare(null);
}
