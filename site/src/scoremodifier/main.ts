import './style.css'
import {
    renderSiteNav,
    initSiteNav,
    injectSiteNavStyles,
    initCompetitionSelector,
    getActiveCompetition,
    subscribeActiveCompetition,
    refreshActiveCompetition,
    clearActiveCompetition,
    readPlatformError,
    isGoneCompetitionError,
    platformErrorMessage,
    isReadOnlyCompetition,
    ownerLabel,
    competitionLabel,
    formatDateFi,
    type PlatformCompetition,
    DOWNLOAD_EXPIRY_MARGIN_MS,
    usableDownloadUrl,
} from '@figureskatingtools/shared-ui';
import {
    escapeAttr,
    escapeHtml,
    fetchUser,
    isTenantBlocked,
    loginUrl,
    logoutUrl,
    setupUserMenu,
    tenantBlockedCardHtml,
    type UserInfo,
} from '../shell.js';

// Inject the shared figureskatingtools.com nav styles once at startup
injectSiteNavStyles();

/** Where login returns to, and the prefix of this tool's API routes */
const APP_PATH = '/scoremodifier/';
const API_BASE = '/scoremodifier/api';

interface GenerateResult {
    id: string;
    name: string;
    fileName: string;
    downloadUrl: string | null;
    pages: number;
    expiration: string | null;
    htmlFileName?: string;
    htmlUrl?: string | null;
}

type Tool = 'perskater' | 'results';
let activeTool: Tool = 'perskater';

// Tulokkaat re-uses the original FSM export name (kept in sync with the backend
// default) so the results PDF drops straight into the publishing workflow.
const TULOKKAAT_PDF_FILENAME = 'FSKXSYNCHRONMLTULO--01FNL-000100--_JudgesDetailsperSkater.pdf';

/** The default results PDF download name for the current category. */
function defaultResultsFilename(): string {
    const cat = (document.getElementById('r-category') as HTMLInputElement).value.trim().toUpperCase();
    return cat === 'TULOKKAAT' ? TULOKKAAT_PDF_FILENAME : 'results.pdf';
}

const appElement = document.querySelector<HTMLDivElement>('#app')!;

// The shared site nav (across all figureskatingtools.com apps) is rendered into
// #site-nav-container by init() once the auth state is known.
appElement.innerHTML = `
  <div id="site-nav-container"></div>

  <main>
    <div id="loading-view" class="loading-screen">
      <h2>Authenticating...</h2>
      <p>Please wait while we verify your credentials.</p>
    </div>

    <div id="landing-view" class="hidden">
      <div class="card landing-card reveal">
        <span class="micro-label">Score Modifier</span>
        <h2>Reshape your competition score papers</h2>
        <p class="lead">
          Split a <strong>Figure Skating Manager</strong> "Judges Details Per Skater" export so
          every skater or team gets their own page — ready to hand out.
        </p>
        <div class="landing-contact">
          <p>To access the application, please sign in with your figureskatingtools.com account.</p>
        </div>
        <div style="margin-top: 2rem;">
          <a href="${loginUrl(APP_PATH)}" class="btn btn-primary">Sign In to Continue</a>
        </div>
      </div>
    </div>

    <div id="main-content" class="hidden">
      <div id="pick-view" class="card reveal hidden" style="max-width: 860px; margin: 0 auto;">
        <span class="micro-label">Score Modifier</span>
        <h2 style="margin-bottom: 0.75rem;">No competition selected</h2>
        <p id="pick-notice" class="status-error hidden" role="status"></p>
        <p class="lead">Choose or create a competition from the selector in the top bar —
          every tool works on the same selected competition, and what you generate here is
          kept with it and deleted together with its data.</p>
      </div>

      <div id="readonly-view" class="card reveal hidden" style="max-width: 860px; margin: 0 auto;">
        <span class="micro-label">Score Modifier</span>
        <h2 style="margin-bottom: 0.75rem;">View-only access</h2>
        <p class="lead">View-only access — ask the owner for write access.</p>
        <p id="readonly-owner" class="text-muted"></p>
        <p class="text-muted">Everything Score Modifier makes is stored with the selected competition,
          so generating needs write access to it.</p>
      </div>

      <div id="tool-view" class="card reveal hidden" style="max-width: 860px; margin: 0 auto;">
        <span class="micro-label">Score Modifier</span>

        <div class="tool-tabs" role="tablist">
          <button class="tool-tab is-active" id="tab-perskater" type="button" role="tab">One skater per page</button>
          <button class="tool-tab" id="tab-results" type="button" role="tab">Results summary</button>
        </div>

        <div id="upload-area" class="upload-area" style="margin: 1.25rem 0;">
          <p class="upload-title">Drag &amp; drop your "Judges Details Per Skater" PDF here</p>
          <p class="upload-or">or</p>
          <button id="browse-files-btn" class="btn btn-sm btn-primary" type="button">Browse Files</button>
          <input type="file" id="file-input" accept="application/pdf,.pdf" style="display: none;">
          <div id="selected-file" class="upload-status"></div>
        </div>

        <section id="opts-perskater" class="tool-panel">
          <p class="lead">
            Each skater/team is placed on its own page (rank order), with the report header repeated
            and a clean footer. Currently used for the <strong>Tulokkaat&nbsp;(Beginners)</strong> category.
          </p>
          <label class="checkbox-row" style="display: flex; align-items: center; gap: 0.6rem; margin: 1rem 0;">
            <input type="checkbox" id="include-ranks">
            <span>Include ranks <span class="text-muted">(off by default — non-podium ranks are hidden)</span></span>
          </label>
        </section>

        <section id="opts-results" class="tool-panel hidden">
          <p class="lead">
            Build a polished one-page <strong>JudgesDetailsperSkater</strong> results sheet (PDF) — podium with
            scores plus everyone else in skating order — and a podium-only
            <strong>CAT###RS.htm</strong> page.
          </p>
          <div class="field">
            <label class="form-label" for="idx-url">Competition <strong>index.htm</strong> URL
              <span class="text-muted">(auto-fills the fields below)</span></label>
            <div style="display: flex; gap: 0.5rem;">
              <input type="url" id="idx-url" class="form-input"
                     placeholder="https://www.figureskatingresults.fi/results/…/index.htm">
              <button id="idx-fetch" class="btn btn-sm btn-secondary" type="button">Fetch</button>
            </div>
            <div id="idx-status" class="upload-status"></div>
          </div>
          <div class="field-grid">
            <div class="field"><label class="form-label" for="r-competition">Competition</label>
              <input id="r-competition" class="form-input"></div>
            <div class="field"><label class="form-label" for="r-date">Date</label>
              <input id="r-date" class="form-input"></div>
            <div class="field"><label class="form-label" for="r-venue">Venue</label>
              <input id="r-venue" class="form-input"></div>
            <div class="field"><label class="form-label" for="r-catpage">Category page (HTML filename)</label>
              <select id="r-catpage" class="form-input"><option value="">— auto-match from index —</option></select></div>
            <div class="field"><label class="form-label" for="r-category">Category label (badge)</label>
              <input id="r-category" class="form-input" value="TULOKKAAT"></div>
            <div class="field"><label class="form-label" for="r-supertitle">Supertitle</label>
              <input id="r-supertitle" class="form-input" value="MUODOSTELMALUISTELU · VAPAAOHJELMA"></div>
          </div>
          <label class="checkbox-row" style="display: flex; align-items: center; gap: 0.6rem; margin: 1rem 0 0.25rem;">
            <input type="checkbox" id="r-custom-filename">
            <span>Customize export filename
              <span class="text-muted">(Tulokkaat uses the standard FSM filename automatically)</span></span>
          </label>
          <div class="field hidden" id="r-filename-field">
            <label class="form-label" for="r-filename">Export filename (PDF)</label>
            <input id="r-filename" class="form-input">
          </div>
        </section>

        <div class="form-actions" style="justify-content: flex-start;">
          <button id="btn-generate" class="btn btn-primary" type="button" disabled>Generate</button>
        </div>

        <div id="result-area" style="margin-top: 1.5rem;"></div>
      </div>
    </div>
  </main>

  <footer class="site-footer">
    <p>Supporting the figure skating community — created with a pinch of AI ❤️</p>
  </footer>
`;

let selectedFile: File | null = null;

function setSelectedFile(file: File | null) {
    const status = document.getElementById('selected-file')!;
    const generateBtn = document.getElementById('btn-generate') as HTMLButtonElement;
    if (file && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        status.innerHTML = `<span class="status-error">Please choose a PDF file.</span>`;
        selectedFile = null;
        generateBtn.disabled = true;
        return;
    }
    selectedFile = file;
    if (file) {
        const sizeKb = Math.round(file.size / 1024);
        status.innerHTML = `Selected: <strong>${escapeHtml(file.name)}</strong> (${sizeKb} KB)`;
        generateBtn.disabled = false;
    } else {
        status.textContent = '';
        generateBtn.disabled = true;
    }
}

function showError(msg: string) {
    document.getElementById('result-area')!.innerHTML =
        `<div class="result-card result-card--error"><p class="status-error">${escapeHtml(msg)}</p></div>`;
}


function downloadLink(url: string, fileName: string, label: string, primary = true): string {
    const cls = primary ? 'btn btn-primary' : 'btn btn-secondary';
    return `<a class="${cls}" href="${escapeAttr(url)}" download="${escapeAttr(fileName)}" data-expiring-link>${escapeHtml(label)}</a>`;
}

/**
 * The download links of a result are short-lived (15 min from generation).
 * One clicked after `RESULT_LINK_MAX_AGE_MS`, or within a minute of its
 * `expiration`, is not followed: generating again is the only way to a new
 * link, and that is the user's call, so the link turns into a note.
 */
const RESULT_LINK_MAX_AGE_MS = 14 * 60 * 1000;
/** When the shown result arrived (epoch ms), and when its links expire (ISO, if reported) */
let resultReceivedAt = 0;
let resultExpiration: string | null = null;

function noteResultReceived(data: GenerateResult): void {
    resultReceivedAt = Date.now();
    resultExpiration = data.expiration ?? null;
}

function resultLinksExpired(now = Date.now()): boolean {
    if (!resultReceivedAt || now - resultReceivedAt > RESULT_LINK_MAX_AGE_MS) return true;
    const expires = resultExpiration ? Date.parse(resultExpiration) : NaN;
    return Number.isFinite(expires) && expires - now <= DOWNLOAD_EXPIRY_MARGIN_MS;
}

const LINK_EXPIRED_HTML = '<span class="text-muted link-expired">Link expired — generate again</span>';

// One delegated listener: the result area is re-rendered on every generate
document.addEventListener('click', (e) => {
    const link = (e.target as Element | null)?.closest?.<HTMLAnchorElement>('a[data-expiring-link]');
    if (!link || !resultLinksExpired()) return;
    e.preventDefault();
    link.outerHTML = LINK_EXPIRED_HTML;
});

/**
 * The selected platform competition, sent as `platformId` on every generate
 * call: the backend links what it generates to it and deletes it on the
 * platform competition's deletion date. Required (400 `platform_id_required`
 * without it), which is why the tool is only shown with a competition selected.
 */
function withPlatformId(params: URLSearchParams, competition: PlatformCompetition): URLSearchParams {
    params.set('platformId', competition.id);
    return params;
}

/** Generate pressed while no competition is selected (another tab cleared it) */
class NoCompetitionError extends Error {
    constructor() {
        super('Select a competition in the top bar first.');
        this.name = 'NoCompetitionError';
    }
}

/**
 * Show a failed generate call readably. A competition that was deleted or no
 * longer exists is dropped from the selection everywhere, and the pick card
 * says why; other platform codes get the shared wording; anything else is the
 * backend's own text.
 */
async function showFailure(resp: Response, requested: PlatformCompetition): Promise<void> {
    const text = (await resp.text()).trim();
    const code = readPlatformError(resp.status, text);
    // Name the competition the request was made for — the selection may have
    // changed while it was in flight
    const label = competitionLabel(requested);
    // The owner made this view-only since the page loaded: the message, and a
    // refreshed selection that swaps the form for the view-only card
    if (code === 'platform_read_only') void refreshActiveCompetition();
    if (isGoneCompetitionError(code)) {
        const message = platformErrorMessage(code!, label);
        if (getActiveCompetition()?.id === requested.id) {
            showPickNotice(message);
            clearActiveCompetition();   // → the pick card
        } else {
            showError(message);         // another competition is selected by now: keep it
        }
        return;
    }
    showError(code ? platformErrorMessage(code, label) : text || `Error ${resp.status}`);
}

/** One-off explanation on the pick card (cleared once a competition is chosen) */
function showPickNotice(message: string | null) {
    const el = document.getElementById('pick-notice');
    if (!el) return;
    el.textContent = message ?? '';
    el.classList.toggle('hidden', !message);
}

async function runPerSkater(requested: PlatformCompetition) {
    const resultArea = document.getElementById('result-area')!;
    const includeRanks = (document.getElementById('include-ranks') as HTMLInputElement).checked;
    const query = withPlatformId(new URLSearchParams({ includeRanks: String(includeRanks) }), requested);
    const resp = await fetch(`${API_BASE}/generate?${query.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: selectedFile,
    });
    if (!resp.ok) {
        await showFailure(resp, requested);
        return;
    }
    const data: GenerateResult = await resp.json();
    const downloadUrl = usableDownloadUrl(data.downloadUrl);
    if (!downloadUrl) {
        showError('Generated, but no download link was returned.');
        return;
    }
    noteResultReceived(data);
    resultArea.innerHTML = `
        <div class="result-card">
            <p class="status-success">Done — ${data.pages} page${data.pages === 1 ? '' : 's'} created.</p>
            <p class="text-muted">${escapeHtml(data.name)}</p>
            ${downloadLink(downloadUrl, data.fileName, `Download ${data.fileName}`)}
        </div>`;
}

async function runResults(requested: PlatformCompetition) {
    const resultArea = document.getElementById('result-area')!;
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value.trim();
    const customFilename = (document.getElementById('r-custom-filename') as HTMLInputElement).checked;
    const params = new URLSearchParams({
        competition: val('r-competition'),
        date: val('r-date'),
        venue: val('r-venue'),
        category: val('r-category'),
        supertitle: val('r-supertitle'),
        catFile: val('r-catpage'),
        indexUrl: val('idx-url'),
        // Blank → backend applies the category default (Tulokkaat = FSM name)
        pdfFile: customFilename ? val('r-filename') : '',
    });
    withPlatformId(params, requested);
    const resp = await fetch(`${API_BASE}/generate_results?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: selectedFile,
    });
    if (!resp.ok) {
        await showFailure(resp, requested);
        return;
    }
    const data: GenerateResult = await resp.json();
    const downloadUrl = usableDownloadUrl(data.downloadUrl);
    if (!downloadUrl) {
        showError('Generated, but no download link was returned.');
        return;
    }
    noteResultReceived(data);
    // The HTML page's link can fail to sign on its own: say so instead of a dead button
    const htmlUrl = usableDownloadUrl(data.htmlUrl);
    const htmlBtn = data.htmlFileName
        ? (htmlUrl
            ? downloadLink(htmlUrl, data.htmlFileName, `Download ${data.htmlFileName}`, false)
            : `<span class="text-muted">${escapeHtml(data.htmlFileName)}: link unavailable — generate again</span>`)
        : '';
    resultArea.innerHTML = `
        <div class="result-card">
            <p class="status-success">Results page created.</p>
            <p class="text-muted">${escapeHtml(data.name)}</p>
            <div class="result-actions">
                ${downloadLink(downloadUrl, data.fileName, `Download ${data.fileName}`)}
                ${htmlBtn}
            </div>
        </div>`;
}

async function runGenerate() {
    if (!selectedFile) return;
    const generateBtn = document.getElementById('btn-generate') as HTMLButtonElement;
    const resultArea = document.getElementById('result-area')!;

    generateBtn.disabled = true;
    const originalLabel = generateBtn.textContent;
    generateBtn.textContent = 'Generating…';
    resultArea.innerHTML = `<p class="text-muted">Processing your PDF…</p>`;

    try {
        // The competition this request is for, fixed now — a selection change
        // while it is in flight must not redirect or clear the wrong one
        const requested = getActiveCompetition();
        if (!requested) throw new NoCompetitionError();
        if (activeTool === 'results') {
            await runResults(requested);
        } else {
            await runPerSkater(requested);
        }
    } catch (e) {
        if (e instanceof NoCompetitionError) {
            showError(e.message);
        } else {
            showError('Something went wrong. Please try again.');
            console.error(e);
        }
    } finally {
        generateBtn.textContent = originalLabel;
        generateBtn.disabled = !selectedFile;
    }
}

/** Write a value into a results field, ignoring blanks (explicit override) */
function set(id: string, v: string) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el && v) el.value = v;
}

/** Same, but never clobbers something the user (or a fetch) already put there */
function setIfEmpty(id: string, v: string) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el && v && !el.value.trim()) el.value = v;
}

/**
 * Prefill the results tab from the site-wide active competition.
 *
 * Enhancement only: empty fields are filled, anything already typed — or
 * fetched from an index.htm — wins.
 */
function prefillFromActiveCompetition() {
    const competition = getActiveCompetition();
    if (!competition) return;
    document.querySelector('#tool-view .micro-label')!.textContent =
        `Score Modifier · ${competitionLabel(competition)}`;
    setIfEmpty('r-competition', competition.name);
    // `r-date` is free text printed onto the results sheet — Finnish, not ISO
    setIfEmpty('r-date', formatDateFi(competition.date));
    setIfEmpty('r-venue', competition.venue);
}

async function fetchIndex() {
    const url = (document.getElementById('idx-url') as HTMLInputElement).value.trim();
    const status = document.getElementById('idx-status')!;
    if (!url) {
        status.innerHTML = `<span class="status-error">Enter the competition index.htm URL first.</span>`;
        return;
    }
    status.textContent = 'Fetching…';
    try {
        const resp = await fetch(`${API_BASE}/parse_index?url=${encodeURIComponent(url)}`);
        if (!resp.ok) {
            status.innerHTML = `<span class="status-error">${escapeHtml((await resp.text()) || `Error ${resp.status}`)}</span>`;
            return;
        }
        const data = await resp.json();
        set('r-competition', data.competition || '');
        // index.htm usually hands back Finnish text already; ISO gets converted
        set('r-date', formatDateFi(data.date) || '');
        set('r-venue', data.venue || '');
        const sel = document.getElementById('r-catpage') as HTMLSelectElement;
        sel.innerHTML = `<option value="">— auto-match from index —</option>`;
        for (const c of (data.categories || []) as Array<{ name: string; catFile: string }>) {
            const opt = document.createElement('option');
            opt.value = c.catFile;
            opt.textContent = `${c.name} (${c.catFile})`;
            sel.appendChild(opt);
        }
        const n = (data.categories || []).length;
        status.innerHTML = `<span class="status-success">Loaded${n ? ` — ${n} categor${n === 1 ? 'y' : 'ies'}` : ''}.</span>`;
    } catch (e) {
        status.innerHTML = `<span class="status-error">Could not fetch the index page.</span>`;
        console.error(e);
    }
}

function switchTool(tool: Tool) {
    activeTool = tool;
    document.getElementById('tab-perskater')!.classList.toggle('is-active', tool === 'perskater');
    document.getElementById('tab-results')!.classList.toggle('is-active', tool === 'results');
    document.getElementById('opts-perskater')!.classList.toggle('hidden', tool !== 'perskater');
    document.getElementById('opts-results')!.classList.toggle('hidden', tool !== 'results');
    document.getElementById('result-area')!.innerHTML = '';
    const btn = document.getElementById('btn-generate')!;
    btn.textContent = tool === 'results' ? 'Generate results page' : 'Generate';
}

function wireTool() {
    const input = document.getElementById('file-input') as HTMLInputElement;
    const browseBtn = document.getElementById('browse-files-btn')!;
    const dropZone = document.getElementById('upload-area')!;

    browseBtn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => setSelectedFile(input.files?.[0] ?? null));

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        const file = e.dataTransfer?.files?.[0];
        if (file) setSelectedFile(file);
    });

    document.getElementById('btn-generate')!.addEventListener('click', runGenerate);

    document.getElementById('tab-perskater')!.addEventListener('click', () => switchTool('perskater'));
    document.getElementById('tab-results')!.addEventListener('click', () => switchTool('results'));
    document.getElementById('idx-fetch')!.addEventListener('click', fetchIndex);

    const customFn = document.getElementById('r-custom-filename') as HTMLInputElement;
    const fnField = document.getElementById('r-filename-field')!;
    const fnInput = document.getElementById('r-filename') as HTMLInputElement;
    customFn.addEventListener('change', () => {
        fnField.classList.toggle('hidden', !customFn.checked);
        if (customFn.checked && !fnInput.value.trim()) fnInput.value = defaultResultsFilename();
    });
}

async function init() {
    const loadingView = document.getElementById('loading-view')!;
    const landingView = document.getElementById('landing-view')!;
    const mainContent = document.getElementById('main-content')!;
    const navContainer = document.getElementById('site-nav-container')!;

    // 1. Auth info (the router's /userinfo flattens the Easy Auth headers)
    const user: UserInfo | null = await fetchUser();

    // 2. Render the shared site nav
    navContainer.innerHTML = renderSiteNav({
        activeApp: 'scoremodifier',
        logoUrl: '/logo.png',
    });
    initSiteNav();
    const userSection = document.getElementById('fst-nav-right')!;

    if (!user) {
        if (isTenantBlocked()) {
            // Signed in, but with an account from a tenant the site refuses
            userSection.innerHTML = `<a href="${logoutUrl()}" class="btn btn-primary btn-sm">Sign out</a>`;
            landingView.innerHTML = tenantBlockedCardHtml();
        } else {
            userSection.innerHTML = `<a href="${loginUrl(APP_PATH)}" class="btn btn-primary btn-sm">Sign In</a>`;
        }
        loadingView.classList.add('hidden');
        landingView.classList.remove('hidden');
        return;
    }

    // 3. User menu + the site-wide competition selector
    setupUserMenu(userSection, user);
    const competitionSlot = document.getElementById('fst-nav-competition');
    if (competitionSlot) void initCompetitionSelector(competitionSlot);

    // 4. Show the tool — only with a competition selected, because everything
    //    generated belongs to (and is deleted with) that competition
    loadingView.classList.add('hidden');
    mainContent.classList.remove('hidden');
    wireTool();
    showForActiveCompetition();
    subscribeActiveCompetition(() => showForActiveCompetition());
    // Drop a selection whose competition has been deleted meanwhile
    void refreshActiveCompetition();
}

/**
 * The tool with a competition selected, the "pick a competition" card without —
 * and the view-only card instead of the form when the competition is shared
 * with this user read-only (generating stores the output with it, a write).
 */
function showForActiveCompetition() {
    const active = getActiveCompetition();
    const readOnly = Boolean(active) && isReadOnlyCompetition(active);
    document.getElementById('pick-view')!.classList.toggle('hidden', Boolean(active));
    document.getElementById('readonly-view')!.classList.toggle('hidden', !readOnly);
    document.getElementById('tool-view')!.classList.toggle('hidden', !active || readOnly);
    const owner = ownerLabel(active?.owner);
    document.getElementById('readonly-owner')!.textContent = readOnly
        ? `“${competitionLabel(active!)}” is shared with you${owner ? ` by ${owner}` : ''}.`
        : '';
    if (active && !readOnly) {
        showPickNotice(null);
        prefillFromActiveCompetition();
    }
}

init();
