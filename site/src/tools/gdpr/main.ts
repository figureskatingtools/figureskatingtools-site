import '../../style.css'
import './gdpr.css'
import { renderSiteNav, initSiteNav, injectSiteNavStyles, initCompetitionSelector } from '@figureskatingtools/shared-ui'
import { escapeHtml, fetchUser, renderSignInView, setupUserMenu, type UserInfo } from '../../shell.js'
import type { Category, GenerateResponse, PlanResponse, ScanResponse, Skater } from './types.js'

// The backend is fs-gdpr-tool, proxied by the router (never root-absolute /api).
const API_BASE = '/tools/gdpr/api';
const REPLACEMENT = 'Nimi poistettu pyynnöstä';

const appElement = document.querySelector<HTMLDivElement>('#app')!;

injectSiteNavStyles();

// ── State (memory only: nothing is written to localStorage/sessionStorage) ──

interface State {
  scan: ScanResponse | null;
  selected: string[];               // skater ids, in selection order
  protocolEnabled: boolean;
  protocolUrl: string;
  plan: PlanResponse | null;
  planFor: string;                  // selection key the plan was made for
  planConfirmed: boolean;
  result: GenerateResponse | null;
  zip: Blob | null;
  downloaded: boolean;
  busy: string;                     // '' | 'scan' | 'plan' | 'generate'
  error: string;
}

const state: State = freshState();

function freshState(): State {
  return {
    scan: null, selected: [], protocolEnabled: false, protocolUrl: '',
    plan: null, planFor: '', planConfirmed: false,
    result: null, zip: null, downloaded: false, busy: '', error: '',
  };
}

function reset(): void {
  Object.assign(state, freshState());
}

const ERROR_TEXT: Record<string, string> = {
  invalid_url: 'That does not look like an event URL.',
  host_not_allowed: 'Results can only be fetched from the approved result sites.',
  event_not_found: 'No event index was found at that URL.',
  protocol_not_found: 'No protocol PDF was found at that URL.',
  not_a_pdf: 'The protocol URL must point to a PDF file.',
  no_categories: 'The page was fetched but no FS Manager categories were found on it.',
  unsupported_encoding: 'A page uses a character encoding the tool cannot preserve.',
  event_changed: 'The event pages changed since they were fetched (a live competition?). Fetch again.',
  protocol_plan_changed: 'The protocol or the selection changed since the plan was confirmed. Show the plan again.',
  protocol_not_confirmed: 'Confirm the protocol plan first.',
  invalid_selection: 'The selection no longer matches the fetched event. Fetch again.',
  file_too_large: 'A file is larger than the tool accepts.',
  too_many_files: 'The event links more files than the tool accepts.',
  event_too_large: 'The event is larger than the tool accepts.',
  upstream_error: 'The results site returned an error.',
  upstream_unreachable: 'The results site could not be reached.',
  unauthorized: 'Your session has expired. Reload the page to sign in again.',
  forbidden: 'Your account is not allowed to use this tool.',
};

async function api<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  let data: unknown = null;
  try {
    data = await resp.json();
  } catch {
    // fall through to the generic message
  }
  if (!resp.ok) {
    const code = (data as { error?: string } | null)?.error ?? '';
    throw new Error(ERROR_TEXT[code] ?? `The request failed (${resp.status}${code ? `, ${code}` : ''}).`);
  }
  return data as T;
}

// ── Lookups ──────────────────────────────────────────────────────────────────

function allSkaters(): Map<string, { skater: Skater; category: Category }> {
  const out = new Map<string, { skater: Skater; category: Category }>();
  for (const category of state.scan?.categories ?? []) {
    for (const skater of category.skaters) out.set(skater.id, { skater, category });
  }
  return out;
}

function selectionKey(): string {
  return state.selected.join(',');
}

/** "selected skater N" → the name, for showing the report to the operator.
 *  The backend's report and manifest never contain names. */
function labelName(label: string): string {
  const m = /selected skater (\d+)/.exec(label);
  const id = m ? state.selected[Number(m[1]) - 1] : undefined;
  const entry = id ? allSkaters().get(id) : undefined;
  return entry ? `${entry.skater.name} (${entry.category.name})` : label;
}

function planValid(): boolean {
  return !!state.plan && state.planFor === selectionKey();
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function doScan(url: string): Promise<void> {
  const keepUrl = url.trim();
  reset();
  state.busy = 'scan';
  render();
  try {
    state.scan = await api<ScanResponse>('/scan', { eventUrl: keepUrl });
    state.protocolUrl = state.scan.suggestedProtocolUrl ?? '';
  } catch (e) {
    state.error = (e as Error).message;
  } finally {
    state.busy = '';
    render();
  }
}

function toggleSkater(id: string, on: boolean): void {
  const lookup = allSkaters();
  const linked = [id, ...(lookup.get(id)?.skater.alsoIn ?? [])];
  for (const sid of linked) {
    const idx = state.selected.indexOf(sid);
    if (on && idx === -1) state.selected.push(sid);
    if (!on && idx !== -1 && sid === id) state.selected.splice(idx, 1);
  }
  clearDerived();
  render();
}

/** Any change of the selection invalidates the protocol plan and the result. */
function clearDerived(): void {
  state.planConfirmed = false;
  state.result = null;
  state.zip = null;
  state.downloaded = false;
  state.error = '';
}

async function doPlan(): Promise<void> {
  if (!state.scan) return;
  state.busy = 'plan';
  state.plan = null;
  state.planConfirmed = false;
  state.error = '';
  render();
  try {
    state.plan = await api<PlanResponse>('/protocol_plan', {
      eventUrl: state.scan.eventUrl,
      snapshot: state.scan.snapshot,
      selection: state.selected,
      protocolUrl: state.protocolUrl.trim(),
    });
    state.planFor = selectionKey();
  } catch (e) {
    state.error = (e as Error).message;
  } finally {
    state.busy = '';
    render();
  }
}

async function doGenerate(): Promise<void> {
  if (!state.scan) return;
  const body: Record<string, unknown> = {
    eventUrl: state.scan.eventUrl,
    snapshot: state.scan.snapshot,
    selection: state.selected,
  };
  // A protocol in which none of the selected skaters appears is left alone.
  const protocolTouched = !!state.plan && state.plan.pages.length > 0;
  if (state.protocolEnabled && !(planValid() && !protocolTouched)) {
    if (!planValid() || !state.planConfirmed || !state.plan) return;
    body.protocol = { url: state.plan.protocolUrl, planHash: state.plan.planHash, confirmed: true };
  }
  state.busy = 'generate';
  state.result = null;
  state.zip = null;
  state.error = '';
  render();
  try {
    const result = await api<GenerateResponse>('/generate', body);
    const bytes = Uint8Array.from(atob(result.zipBase64), (c) => c.charCodeAt(0));
    state.zip = new Blob([bytes], { type: 'application/zip' });
    state.result = { ...result, zipBase64: '' };
    state.downloaded = false;
  } catch (e) {
    state.error = (e as Error).message;
  } finally {
    state.busy = '';
    render();
  }
}

function doDownload(): void {
  if (!state.zip || !state.result) return;
  const url = URL.createObjectURL(state.zip);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.result.zipName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Drop the archive from memory once the browser has it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  state.zip = null;
  state.downloaded = true;
  render();
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderFetchCard(): string {
  const s = state.scan;
  return `
    <section class="card gdpr-step reveal reveal-2">
      <span class="micro-label">Step 1 · Event</span>
      <h2>Fetch the published results</h2>
      <p>Paste the FS Manager event page URL (the competition's results index).</p>
      <form class="gdpr-row" id="scanForm">
        <input class="gdpr-input" id="eventUrl" type="url" required
          placeholder="https://www.figureskatingresults.fi/results/2627/…/index.htm"
          value="${escapeHtml(s?.eventUrl ?? '')}" ${state.busy ? 'disabled' : ''}>
        <button class="btn btn-primary" type="submit" ${state.busy ? 'disabled' : ''}>
          ${state.busy === 'scan' ? 'Fetching…' : 'Fetch'}
        </button>
      </form>
      ${s ? `<p class="gdpr-meta">${s.categories.length} categories · ${s.stats.html} pages · ${s.stats.pdf} PDFs fetched${
        s.stats.missingLinks ? ` · ${s.stats.missingLinks} linked files missing on the site` : ''}</p>` : ''}
    </section>`;
}

function renderSkater(skater: Skater, names: Map<string, { skater: Skater; category: Category }>): string {
  const checked = state.selected.includes(skater.id);
  const also = skater.alsoIn.map((id) => names.get(id)?.category.name).filter(Boolean);
  return `
    <label class="gdpr-skater${checked ? ' is-selected' : ''}">
      <input type="checkbox" data-skater="${escapeHtml(skater.id)}" ${checked ? 'checked' : ''} ${state.busy ? 'disabled' : ''}>
      <span class="gdpr-skater-name">${escapeHtml(skater.name)}</span>
      <span class="gdpr-skater-club">${escapeHtml(skater.club)}</span>
      ${skater.status ? `<span class="gdpr-tag">${escapeHtml(skater.status)}</span>` : ''}
      ${also.length ? `<span class="gdpr-tag gdpr-tag--also" title="The same name is listed in another category; it is selected along">also in ${escapeHtml(also.join(', '))}</span>` : ''}
    </label>`;
}

function renderSelectCard(): string {
  const s = state.scan;
  if (!s) return '';
  const lookup = allSkaters();
  const cats = s.categories.map((c) => {
    const count = c.skaters.filter((sk) => state.selected.includes(sk.id)).length;
    return `
      <details class="gdpr-cat" ${count ? 'open' : ''}>
        <summary>
          <span class="gdpr-cat-name">${escapeHtml(c.name)}</span>
          <span class="gdpr-cat-meta">${c.skaters.length} skaters · ${escapeHtml(c.segments.join(', '))}</span>
          ${count ? `<span class="gdpr-tag gdpr-tag--sel">${count} selected</span>` : ''}
        </summary>
        <div class="gdpr-skaters">${c.skaters.map((sk) => renderSkater(sk, lookup)).join('')}</div>
      </details>`;
  }).join('');
  return `
    <section class="card gdpr-step reveal reveal-2">
      <span class="micro-label">Step 2 · Skaters</span>
      <h2>Select the skaters to remove</h2>
      <p>Their name and club are replaced with “${REPLACEMENT}” in every page and PDF of their category. Placements and scores stay.</p>
      <input class="gdpr-input gdpr-filter" id="skaterFilter" type="search" placeholder="Filter by name or club">
      <div class="gdpr-cats" id="catList">${cats}</div>
      <p class="gdpr-meta">${state.selected.length} selected</p>
    </section>`;
}

function renderPlanTable(plan: PlanResponse): string {
  if (!plan.pages.length) {
    return '<p class="gdpr-meta">The selected skaters do not appear in this protocol. It will not be changed.</p>';
  }
  const rows = plan.pages.map((p) => {
    const who = p.skaters.map((i) => escapeHtml(labelName(`selected skater ${i + 1}`))).join('<br>');
    return `<tr class="${p.action === 'remove_page' ? 'is-remove' : ''}">
      <td class="num">${p.page}</td>
      <td>${escapeHtml(p.typeLabel)}${p.heading ? `<div class="gdpr-sub">${escapeHtml(p.heading)}</div>` : ''}</td>
      <td>${who}</td>
      <td>${p.action === 'remove_page' ? '<strong>Remove page</strong>' : 'Replace name and club'}</td>
    </tr>`;
  }).join('');
  return `
    <table class="gdpr-table">
      <thead><tr><th>Page</th><th>Type</th><th>Skater</th><th>Planned action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="gdpr-meta">${plan.pageCount} pages in total · output file: <code>${escapeHtml(plan.outputPath)}</code> (name unchanged)</p>`;
}

function renderProtocolCard(): string {
  if (!state.scan || !state.selected.length) return '';
  const valid = planValid();
  return `
    <section class="card gdpr-step reveal reveal-3">
      <span class="micro-label">Step 3 · Protocol (optional)</span>
      <h2>Protocol PDF</h2>
      <label class="gdpr-check">
        <input type="checkbox" id="protocolEnabled" ${state.protocolEnabled ? 'checked' : ''} ${state.busy ? 'disabled' : ''}>
        Also redact the competition protocol made with the Protocol Generator
      </label>
      ${state.protocolEnabled ? `
        <div class="gdpr-row">
          <input class="gdpr-input" id="protocolUrl" type="url" placeholder="https://…/protocol_….pdf"
            value="${escapeHtml(state.protocolUrl)}" ${state.busy ? 'disabled' : ''}>
          <button class="btn btn-secondary" id="planBtn" type="button" ${state.busy || !state.protocolUrl.trim() ? 'disabled' : ''}>
            ${state.busy === 'plan' ? 'Reading…' : 'Show plan'}
          </button>
        </div>
        ${valid && state.plan ? renderPlanTable(state.plan) : ''}
        ${valid && state.plan && state.plan.pages.length ? `
          <label class="gdpr-check gdpr-confirm">
            <input type="checkbox" id="planConfirm" ${state.planConfirmed ? 'checked' : ''} ${state.busy ? 'disabled' : ''}>
            I have checked the plan: podium pages are removed entirely, the other pages get the name and club replaced.
          </label>` : ''}
        ${state.plan && !valid ? '<p class="gdpr-meta">The selection changed — show the plan again.</p>' : ''}
      ` : ''}
    </section>`;
}

function renderResult(): string {
  const r = state.result;
  if (!r) return '';
  const v = r.manifest.verification;
  const problems = [...v.htmlPages, ...v.pdfFiles].filter((c) => !c.ok);
  const files = r.manifest.changedFiles.map((f) => `
    <tr><td><code>${escapeHtml(f.path)}</code></td>
      <td>${escapeHtml(f.skaters.map(labelName).join(', '))}</td>
      <td>${f.pagesRemoved?.length ? `${f.pagesRemoved.length} page(s) removed, ` : ''}${
        f.rowsRedacted ?? f.occurrencesRedacted ?? (f.pagesRedacted?.length ?? 0)} ${
        f.rowsRedacted !== undefined ? 'row(s)' : f.occurrencesRedacted !== undefined ? 'occurrence(s)' : 'page(s)'} redacted</td></tr>`).join('');
  const residual = v.remainingOccurrences.map((o) => `
    <tr><td><code>${escapeHtml(o.file)}</code></td><td>${escapeHtml(o.location)}</td><td>${escapeHtml(labelName(o.skater))}</td></tr>`).join('');
  return `
    <div class="gdpr-verdict ${v.ok ? 'is-ok' : 'is-bad'}">
      ${v.ok
        ? `Verified: no selected name remains in any of the ${v.filesSearched} files, and every other skater's rows, placements and scores are unchanged.`
        : 'Verification found problems — review them before uploading anything.'}
    </div>
    ${residual ? `<h3>Remaining occurrences</h3>
      <table class="gdpr-table"><thead><tr><th>File</th><th>Location</th><th>Skater</th></tr></thead><tbody>${residual}</tbody></table>` : ''}
    ${v.skatersNotFound.length ? `<p class="gdpr-warn">Not found in any page: ${escapeHtml(v.skatersNotFound.map(labelName).join(', '))}</p>` : ''}
    ${problems.length ? `<h3>Integrity checks</h3><ul class="gdpr-problems">${problems.map((c) =>
      `<li><code>${escapeHtml(c.file)}</code>: ${escapeHtml(c.problems.join('; '))}</li>`).join('')}</ul>` : ''}
    <h3>Changed files</h3>
    <table class="gdpr-table"><thead><tr><th>File</th><th>Skaters</th><th>Change</th></tr></thead><tbody>${files}</tbody></table>
    <div class="gdpr-row gdpr-download">
      ${state.downloaded
        ? '<p class="gdpr-meta">ZIP downloaded and cleared from this page. The server kept no copy.</p>'
        : `<button class="btn btn-primary" id="downloadBtn" type="button">Download ${escapeHtml(r.zipName)}</button>`}
      <button class="btn btn-secondary" id="resetBtn" type="button">Start over</button>
    </div>
    <ul class="gdpr-notes">${r.manifest.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`;
}

function renderGenerateCard(): string {
  if (!state.scan || !state.selected.length) return '';
  const needsPlan = state.protocolEnabled && !(planValid() && state.planConfirmed);
  const emptyPlan = state.protocolEnabled && planValid() && state.plan && !state.plan.pages.length;
  const blocked = state.busy !== '' || (needsPlan && !emptyPlan);
  return `
    <section class="card gdpr-step reveal reveal-4">
      <span class="micro-label">Step 4 · Generate</span>
      <h2>Generate and verify</h2>
      <p>Produces the changed files only, searches every file for the removed names and checks that nobody else's results changed.</p>
      ${needsPlan && !emptyPlan ? '<p class="gdpr-meta">Show and confirm the protocol plan first, or untick the protocol.</p>' : ''}
      <button class="btn btn-primary" id="generateBtn" type="button" ${blocked ? 'disabled' : ''}>
        ${state.busy === 'generate' ? 'Generating…' : 'Generate'}
      </button>
      ${renderResult()}
    </section>`;
}

function renderPage(): string {
  return `
    <main class="auth-main gdpr-main">
      <header class="gdpr-header reveal reveal-1">
        <span class="micro-label">Tools</span>
        <h1>GDPR Removal Tool</h1>
        <p class="gdpr-lead">
          Remove a skater's name from published FS Manager results and the competition protocol on request.
          You get a ZIP with only the changed files, ready to upload over the published ones.
          If the competition is republished from FS Manager, run the removal again.
        </p>
      </header>
      ${state.error ? `<div class="gdpr-error" role="alert">${escapeHtml(state.error)}</div>` : ''}
      ${renderFetchCard()}
      ${renderSelectCard()}
      ${renderProtocolCard()}
      ${renderGenerateCard()}
    </main>`;
}

let filterText = '';

function render(): void {
  const main = document.getElementById('gdprRoot');
  if (!main) return;
  const scrollY = window.scrollY;
  main.innerHTML = renderPage();
  bind();
  applyFilter();
  window.scrollTo(0, scrollY);
}

function applyFilter(): void {
  const input = document.getElementById('skaterFilter') as HTMLInputElement | null;
  if (!input) return;
  input.value = filterText;
  const q = filterText.trim().toLocaleLowerCase();
  document.querySelectorAll<HTMLElement>('.gdpr-skater').forEach((el) => {
    el.classList.toggle('hidden', !!q && !el.textContent!.toLocaleLowerCase().includes(q));
  });
  if (q) document.querySelectorAll<HTMLDetailsElement>('.gdpr-cat').forEach((d) => { d.open = true; });
}

function bind(): void {
  document.getElementById('scanForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = (document.getElementById('eventUrl') as HTMLInputElement).value;
    filterText = '';
    void doScan(url);
  });
  document.querySelectorAll<HTMLInputElement>('input[data-skater]').forEach((cb) => {
    cb.addEventListener('change', () => toggleSkater(cb.dataset.skater!, cb.checked));
  });
  document.getElementById('skaterFilter')?.addEventListener('input', (e) => {
    filterText = (e.target as HTMLInputElement).value;
    applyFilter();
  });
  document.getElementById('protocolEnabled')?.addEventListener('change', (e) => {
    state.protocolEnabled = (e.target as HTMLInputElement).checked;
    clearDerived();
    render();
  });
  document.getElementById('protocolUrl')?.addEventListener('input', (e) => {
    state.protocolUrl = (e.target as HTMLInputElement).value;
    state.plan = null;
    state.planConfirmed = false;
    const btn = document.getElementById('planBtn') as HTMLButtonElement | null;
    if (btn) btn.disabled = !state.protocolUrl.trim();
  });
  document.getElementById('planBtn')?.addEventListener('click', () => void doPlan());
  document.getElementById('planConfirm')?.addEventListener('change', (e) => {
    state.planConfirmed = (e.target as HTMLInputElement).checked;
    state.result = null;
    state.zip = null;
    render();
  });
  document.getElementById('generateBtn')?.addEventListener('click', () => void doGenerate());
  document.getElementById('downloadBtn')?.addEventListener('click', doDownload);
  document.getElementById('resetBtn')?.addEventListener('click', () => {
    reset();
    filterText = '';
    render();
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function init() {
  const userInfo = await fetchUser();
  if (!userInfo) {
    renderSignInView(appElement, '/tools/gdpr/');
  } else {
    renderAuthenticatedView(userInfo);
  }
}

function renderAuthenticatedView(userInfo: UserInfo) {
  appElement.innerHTML = `
    ${renderSiteNav({ activeApp: 'gdpr', logoUrl: '/logo.png' })}
    <div id="gdprRoot"></div>
    <footer class="site-footer">
      <p>Supporting the figure skating community — created with a pinch of AI ❤️</p>
    </footer>
  `;

  const userSection = document.getElementById('fst-nav-right');
  if (userSection) setupUserMenu(userSection, userInfo);
  initSiteNav();
  const competitionSlot = document.getElementById('fst-nav-competition');
  if (competitionSlot) void initCompetitionSelector(competitionSlot);

  render();
}

// Leaving the page drops everything; nothing was stored anywhere but memory.
window.addEventListener('pagehide', reset);

init();
