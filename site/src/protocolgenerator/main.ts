import './style.css'
import {
  renderSiteNav,
  initSiteNav,
  injectSiteNavStyles,
  initCompetitionSelector,
  getActiveCompetition,
  competitionLabel,
  formatDateFi,
  subscribeActiveCompetition,
  listCompetitionFiles,
  uploadCompetitionFile,
  sortCategoriesForMatching,
  matchCategory,
  planAutoAssignment,
  applyOutcomeLocally,
  stripTrailingDashes,
  type CategoryInfo,
  type AutoAssignOutcome,
  type AutoAssignTarget,
  type StructureLike,
  type TrayReason,
  type PoolFile,
} from '@figureskatingtools/shared-ui';
import type { CompetitionDetails, Structure, Category, Segment, SlotTarget, FileMeta } from './types';
import { attachPreview } from './preview';
import { escapeHtml, fetchUser, renderSignInView, setupUserMenu, type UserInfo } from '../shell.js';

/** Where this app lives on the site — login round-trips back into it. */
const APP_PATH = '/protocolgenerator/';

/**
 * This tool's API prefix. The site router strips `/protocolgenerator` and
 * forwards to the Protocol Generator Function App, so every route below keeps
 * its original name — same origin, cookies and Easy Auth headers flow.
 */
const API_BASE = '/protocolgenerator/api';

/** Absolute URL of one of this tool's API routes (also used for `<img src>`). */
function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** JSON for a single-quoted HTML attribute. */
function attr(obj: unknown): string {
  return JSON.stringify(obj).replace(/'/g, '&#39;');
}

// ── module state ──
let currentId: string | null = null;
/** Platform competition GUID this tool is currently bound to (see `bindActiveCompetition`). */
let boundPlatformId: string | null = null;
/** Guards against an out-of-order resolve when the selection changes mid-flight. */
let bindToken = 0;
let details: CompetitionDetails | null = null;
/** Files in the platform competition pool; null = unbound or pool unavailable. */
let poolFiles: PoolFile[] | null = null;
/** Set once the pool proves unusable for this competition (unbound, off, down). */
let poolDisabled = false;
/** The "uploaded to this tool only" notice is worth saying once, not per file. */
let poolNoticeShown = false;
const openCats = new Set<string>();
/** Collapsed-by-default state of the "Team rosters" per-category groups. */
const openRosterCats = new Set<string>();
/** Which teams show their expanded skater list inside the roster groups. */
const openRosterTeams = new Set<string>();

/** The `#app` host element — resolved in `mount()`, never at import time. */
let appElement: HTMLDivElement;

const APP_HTML = `
  <div id="site-nav-container"></div>
  <main>
    <div id="loading-view" class="loading-screen">
      <h2>Authenticating…</h2>
      <p>Please wait while we verify your credentials.</p>
    </div>

    <div id="error-view" class="error-screen hidden"></div>

    <div id="main-content" class="hidden">
      <div id="modal-overlay" class="modal-overlay hidden">
        <div class="modal">
          <h3 id="modal-title">Confirm</h3>
          <p id="modal-message" class="modal-message"></p>
          <div id="modal-extra"></div>
          <div class="modal-actions">
            <button id="modal-cancel" class="btn btn-ghost btn-sm">Cancel</button>
            <button id="modal-confirm" class="btn btn-primary btn-sm">Confirm</button>
          </div>
        </div>
      </div>

      <div id="view-pick-competition" class="hidden">
        <div class="card reveal bind-card">
          <div id="bind-body"></div>
        </div>
      </div>

      <div id="view-detail" class="hidden">
        <div class="card reveal">
          <div class="view-header">
            <div class="view-header-lead">
              <h2 id="detail-title">Competition</h2>
              <span class="help-icon" tabindex="0" role="button" aria-label="How to use the Protocol Generator">?<span class="help-pop">
                <strong>How to use the Protocol Generator</strong>
                <ul>
                  <li>Upload the competition's <strong>schedule</strong> (PDF or DT_SCHEDULE XML) — it builds the categories and segments automatically.</li>
                  <li>Fill in the <strong>event details</strong> (organiser, venue, dates); they feed the cover and information pages.</li>
                  <li>Drop each category's result PDFs and photos onto their <strong>slots</strong>; drag between slots to fix placements, and hover a file to preview it.</li>
                  <li>Files exported from <strong>Figure Skating Manager</strong> are recognized by their file name and placed into the right category and segment automatically — placed files carry an <strong>auto</strong> tag. <strong>Auto-place files</strong> retries recognition for anything still in Uploads.</li>
                  <li><strong>Competition files</strong> are shared between the tools: PDFs uploaded for the same competition in Judge Paper Creator can be imported from the Uploads section without re-uploading.</li>
                  <li>Required files (marked <span class="req">•</span>) drive each category's <em>"n/n uploaded"</em> readiness badge.</li>
                  <li>For synchronized skating, import the <strong>DT_PARTIC</strong> team rosters to add team pages.</li>
                  <li>Before generating, <strong>check every auto-tagged file</strong> — automatic placement goes by file name, so confirm each one sits in the right slot. Dragging a file by hand clears its tag.</li>
                  <li>Press <strong>Generate Protocol</strong> to build the bound PDF; download or delete generated protocols from the list below.</li>
                </ul>
              </span></span>
            </div>
            <div class="retention" id="retention"></div>
          </div>
          <div id="detail-body"></div>
        </div>
      </div>
    </div>
  </main>
`;

function showView(viewId: string) {
  ['view-pick-competition', 'view-detail'].forEach(id => {
    document.getElementById(id)?.classList.toggle('hidden', id !== viewId);
  });
}

/* ── the site-wide active competition drives this app ──
   There is no per-tool competition list any more: the competition selected in
   the nav is resolved to this tool's own record (`/resolve_competition`, which
   creates or adopts it on first use) and that record *is* the app. */

/** Render one card into the "pick a competition" view. */
function renderBindCard(html: string) {
  showView('view-pick-competition');
  const body = document.getElementById('bind-body');
  if (body) body.innerHTML = html;
}

/** Nothing selected — point at the nav selector, no error, no noise. */
function showPickCompetition() {
  renderBindCard(`
    <span class="micro-label">Protocol Generator</span>
    <h2 style="margin-bottom: 0.75rem;">No competition selected</h2>
    <p class="bind-lead">Choose or create a competition from the selector in the top bar —
      every tool works on the same selected competition.</p>
    <ol class="howto-list">
      <li>Upload the competition's <strong>schedule</strong> (DT_SCHEDULE XML or PDF).</li>
      <li>Fill in the event details and drop in the result PDFs and photos — Figure Skating Manager
        exports are recognized by name and placed automatically with an <strong>auto</strong> tag.</li>
      <li>Check the auto-tagged files and drag any file between slots to fix placements; hover to preview.</li>
      <li>Press <strong>Generate Protocol</strong> to build the bound PDF.</li>
    </ol>`);
}

/** Resolve in flight. */
function showBindLoading(name: string) {
  renderBindCard(`
    <span class="micro-label">Protocol Generator</span>
    <h2 style="margin-bottom: 0.75rem;">Opening ${escapeHtml(name)}…</h2>
    <p class="bind-lead"><span class="spinner spinner--ink"></span>Linking the selected competition to this tool.</p>`);
}

/** Resolve failed — readable message plus a retry. */
function showBindError(message: string) {
  renderBindCard(`
    <span class="micro-label">Protocol Generator</span>
    <h2 style="margin-bottom: 0.75rem;">Could not open the competition</h2>
    <p class="bind-lead text-error">${escapeHtml(message)}</p>
    <button id="btn-bind-retry" class="btn btn-primary btn-sm">Retry</button>`);
  document.getElementById('btn-bind-retry')
    ?.addEventListener('click', () => void bindActiveCompetition(true));
}

/**
 * Bind this tool to the active platform competition.
 *
 * No selection → the quiet "pick a competition" card. Same GUID as the current
 * binding → nothing to do (the subscription fires on every storage change).
 * Otherwise resolve the platform GUID into this tool's competition record and
 * open it.
 */
async function bindActiveCompetition(force = false): Promise<void> {
  const active = getActiveCompetition();
  const token = ++bindToken;

  if (!active) {
    boundPlatformId = null;
    currentId = null;
    details = null;
    poolFiles = null;
    showPickCompetition();
    return;
  }

  if (!force && active.id === boundPlatformId) return;

  // Pool availability is per competition (a tool record can be unbound) — a new
  // selection gets a clean slate.
  poolFiles = null;
  poolDisabled = false;

  const label = competitionLabel(active);
  showBindLoading(label);

  try {
    const resp = await apiJson('/resolve_competition', {
      platformId: active.id,
      name: label,
      dates: active.date || '',
      // The platform venue prefills the tool's ice rink (event details)
      venue: active.venue || '',
    });
    if (!resp.ok) {
      throw new Error((await resp.text()).trim() || `The tool API returned ${resp.status}.`);
    }
    const data = await resp.json() as { id?: string; name?: string };
    if (token !== bindToken) return;   // selection changed while we waited
    if (!data?.id) throw new Error('The tool API returned no competition id.');
    boundPlatformId = active.id;
    await openCompetition(data.id, data.name || label);
  } catch (e) {
    if (token !== bindToken) return;
    boundPlatformId = null;
    showBindError(e instanceof Error ? e.message : 'Network error.');
  }
}

// ── API helpers ──
// Paths are relative to this tool's API prefix, e.g. apiGet('/get_competition_details').
async function apiGet(path: string): Promise<Response> {
  return fetch(apiUrl(path));
}
async function apiJson(path: string, body: unknown): Promise<Response> {
  return fetch(apiUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function apiRaw(path: string, body: Blob | ArrayBuffer): Promise<Response> {
  return fetch(apiUrl(path), { method: 'POST', body });
}

// ── retention ──
/** `dd.MM.yyyy`, or the `-` sentinel this UI uses for "no usable date". */
function fmtDate(value: string): string {
  if (!value || value === '-') return '-';
  const pretty = formatDateFi(value);
  // formatDateFi hands unparsable input straight back — that means "no date" here
  return /^\d{2}\.\d{2}\.\d{4}$/.test(pretty) ? pretty : '-';
}

/**
 * Finnish date + clock — `dd.MM.yyyy HH.mm`, local time (Finnish clock times
 * use dots, not colons). Anything unparsable is shown as it came in.
 */
function fmtTimestamp(value?: string | null): string {
  if (!value) return '';
  const day = formatDateFi(value);
  if (day === value) return value;              // not an ISO value — leave it alone
  if (!/[T ]\d{1,2}:/.test(value)) return day;  // date only — no clock to print
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return value;
  const hh = String(parsed.getHours()).padStart(2, '0');
  const mm = String(parsed.getMinutes()).padStart(2, '0');
  return `${day} ${hh}.${mm}`;
}

/**
 * Compact "Auto-deletes <date> [· Extend]" line in the competition header.
 *
 * Rendered only when the backend actually reports a deletion date on
 * `get_competition_details` (or hands a fresh one back from the extend route) —
 * with no date available the line stays empty. The Extend button surfaces only
 * during the last 7 days before deletion; each press pushes the date a week
 * out (no cap), so it simply reappears when the new date draws near.
 */
const EXTEND_VISIBLE_MS = 7 * 24 * 3600 * 1000;

function renderRetention(date?: string | null) {
  const el = document.getElementById('retention');
  if (!el) return;
  const pretty = date ? fmtDate(date) : '';
  if (!pretty || pretty === '-') { el.innerHTML = ''; return; }
  const due = date ? new Date(date).getTime() : NaN;
  const dueSoon = Number.isFinite(due) && due - Date.now() <= EXTEND_VISIBLE_MS;
  el.innerHTML = `<span class="retention-date">Auto-deletes ${escapeHtml(pretty)}</span>${dueSoon ? `
    <span class="retention-sep">·</span>
    <button class="btn btn-xs btn-ghost" id="btn-extend">Extend</button>` : ''}`;
  document.getElementById('btn-extend')?.addEventListener('click', extendRetention);
}

/** Push the auto-deletion date out; the response carries the new date. */
async function extendRetention() {
  if (!currentId) return;
  const btn = document.getElementById('btn-extend') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = 'Extending…'; }
  try {
    const resp = await fetch(
      apiUrl(`/extend_competition_deletion?id=${encodeURIComponent(currentId)}`), { method: 'POST' });
    if (!resp.ok) throw new Error(String(resp.status));
    const data = await resp.json() as { deletionDate?: string };
    if (details && data.deletionDate) details.deletionDate = data.deletionDate;
    renderRetention(data.deletionDate);
    flash('Auto-deletion postponed.');
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = 'Extend'; }
    alert('Could not extend the deletion date.');
  }
}

// ── detail view ──
async function openCompetition(id: string, name: string) {
  currentId = id;
  showView('view-detail');
  document.getElementById('detail-title')!.textContent = name;
  document.getElementById('retention')!.innerHTML = '';
  document.getElementById('detail-body')!.innerHTML = '<p class="text-muted">Loading…</p>';
  await loadDetails();
}

async function loadDetails() {
  if (!currentId) return;
  try {
    const resp = await apiGet(`/get_competition_details?id=${encodeURIComponent(currentId)}`);
    if (!resp.ok) throw new Error(String(resp.status));
    details = await resp.json();
    await refreshPoolFiles();
    renderDetails();
  } catch {
    document.getElementById('detail-body')!.innerHTML = '<p class="text-error">Failed to load competition.</p>';
  }
}

function fileMeta(fileId: string | null): FileMeta | null {
  if (!fileId || !details) return null;
  return details.structure.files[fileId] || null;
}

function fileUrl(fileId: string): string {
  return apiUrl(`/get_file?competition=${encodeURIComponent(currentId!)}&fileId=${encodeURIComponent(fileId)}`);
}

function chipHtml(fileId: string): string {
  const m = fileMeta(fileId);
  if (!m) return '';
  const kindClass = m.kind === 'image' ? 'chip-kind--image' : m.kind === 'xml' ? 'chip-kind--xml' : '';
  const autoPill = m.autoAssigned
    ? '<span class="chip-auto" title="Placed automatically from the filename — drag to move it, or leave it to confirm">auto</span>'
    : '';
  return `<span class="file-chip" draggable="true" data-file-id="${escapeHtml(fileId)}">
      <span class="chip-kind ${kindClass}">${escapeHtml(m.kind)}</span>
      <span class="chip-name" title="${escapeHtml(m.filename)}">${escapeHtml(m.filename)}</span>
      ${autoPill}
      <button class="chip-x" data-del-file="${escapeHtml(fileId)}" title="Delete file">×</button>
    </span>`;
}

function slotHtml(label: string, target: SlotTarget, fileId: string | null, required = false): string {
  const filled = fileId ? 'is-filled' : '';
  const reqCls = required && !fileId ? 'is-missing' : '';
  const inner = fileId ? chipHtml(fileId) : '<div class="slot-empty">drop a file</div>';
  return `<div class="slot ${filled} ${reqCls}" data-target='${attr(target)}'>
      <span class="slot-label">${escapeHtml(label)}${required ? ' <span class="req">•</span>' : ''}</span>
      ${inner}
    </div>`;
}

/** Whether a category's segments hold more than one segment. With a single
 * segment, its results just repeat the total results and detail scores may be
 * absent (beginner/local judging), so those two slots are optional — see
 * `segmentHtml` / `categoryReadiness`. The Panel of Judges is always required. */
function isMultiSegment(cat: Category): boolean {
  return (cat.segments || []).length > 1;
}

/** Required-slot fill progress for a category. Required: Protocol Head Page +
 * Total Results, the Panel of Judges on every segment, and — only when the
 * category has 2+ segments — each segment's Results and Judges Scores Details. */
function categoryReadiness(cat: Category): { filled: number; total: number; ready: boolean } {
  let total = 0, filled = 0;
  const req = (v: string | null | undefined) => { total++; if (v) filled++; };
  req(cat.titlePdf);
  req(cat.totalResultsPdf);
  const multi = isMultiSegment(cat);
  (cat.segments || []).forEach(s => {
    req(s.panelPdf);                       // Panel of Judges: always required
    if (multi) { req(s.resultsPdf); req(s.judgesDetailsPdf); }
  });
  return { filled, total, ready: total > 0 && filled === total };
}

function segmentHtml(cat: Category, seg: Segment): string {
  // With only one segment, Results and Judges Scores Details are optional (the
  // single segment's results duplicate the total results, and beginner/local
  // judging may not publish detail scores). Panel of Judges is always required.
  const multi = isMultiSegment(cat);
  return `<div class="segment-block">
      <div class="segment-head">
        <input class="form-input segment-name" style="max-width: 320px;" value="${escapeHtml(seg.name)}"
               data-edit="set_segment" data-cat="${cat.id}" data-seg="${seg.id}" data-field="name">
        <label class="segment-units" title="Competition units (skaters/pairs/teams) that performed this segment. Auto-filled from the results PDF; correct it here if needed. Drives the competition-information page counts.">
          Units
          <input class="form-input" type="number" min="0" inputmode="numeric" placeholder="—"
                 value="${seg.unitCount ?? ''}"
                 data-edit="set_segment" data-cat="${cat.id}" data-seg="${seg.id}" data-field="unitCount">
        </label>
        <button class="btn btn-xs btn-ghost btn-ghost--danger" data-rm-seg="${seg.id}" data-cat="${cat.id}">Remove segment</button>
      </div>
      <div class="segment-roles">
        ${slotHtml('Segment Results', { kind: 'segment', categoryId: cat.id, segmentId: seg.id, role: 'results' }, seg.resultsPdf, multi)}
        ${slotHtml('Panel of Judges', { kind: 'segment', categoryId: cat.id, segmentId: seg.id, role: 'panel' }, seg.panelPdf, true)}
        ${slotHtml('Judges Scores Details Without Referee', { kind: 'segment', categoryId: cat.id, segmentId: seg.id, role: 'judgesDetails' }, seg.judgesDetailsPdf, multi)}
      </div>
    </div>`;
}

type TeamRow = Category['teams'][number];
type PhotoStatus = 'green' | 'yellow' | 'red';

/** Picture readiness of one team — the colour code shown in the roster list and
 * the order generation actually uses: photo → fallback → placeholder. */
function teamPhotoStatus(team: TeamRow): PhotoStatus {
  if (team.photo) return 'green';
  if (team.photoFallback) return 'yellow';
  return 'red';
}

const STATUS_TITLE: Record<PhotoStatus, string> = {
  green: 'Competition photo assigned',
  yellow: 'Accreditation fallback only — used because no competition photo is set',
  red: 'No picture at all — the team page falls back to a placeholder',
};

/** One compact team line: status dot, inline name/org edits, skater toggle,
 * Remove, and both photo slots (same SlotTarget objects the backend expects,
 * so drag/drop, chips and one-file-one-slot behave exactly as before). */
function teamRowHtml(cat: Category, team: TeamRow): string {
  const status = teamPhotoStatus(team);
  const count = team.members?.length || 0;
  const isOpen = openRosterTeams.has(team.id);
  const roster = count
    ? `<ul class="roster-skaters">${team.members.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`
    : '<span class="team-roster-empty">No roster yet — import the DT_PARTIC XML pair.</span>';
  return `<div class="team-row ${status === 'red' ? 'team-row--alert' : ''}">
      <div class="team-row-main">
        <span class="status-dot is-${status}" title="${escapeHtml(STATUS_TITLE[status])}"></span>
        <input class="form-input form-input--compact team-row-name" placeholder="Team name" value="${escapeHtml(team.name)}"
               data-edit="set_team" data-cat="${cat.id}" data-team="${team.id}" data-field="name">
        <input class="form-input form-input--compact team-row-org" placeholder="Club" value="${escapeHtml(team.org)}"
               data-edit="set_team" data-cat="${cat.id}" data-team="${team.id}" data-field="org">
        <button class="roster-skaters-toggle" data-toggle-roster-team="${team.id}"
                title="Show or hide the skater names">${count} skater${count === 1 ? '' : 's'}
          <span class="toggle-icon">${isOpen ? '▴' : '▾'}</span>
        </button>
        <button class="btn btn-xs btn-ghost btn-ghost--danger" data-rm-team="${team.id}" data-cat="${cat.id}">Remove</button>
      </div>
      <div class="team-row-slots">
        ${slotHtml('Competition photo', { kind: 'teamPhoto', categoryId: cat.id, teamId: team.id }, team.photo)}
        ${slotHtml('Fallback picture', { kind: 'teamPhotoFallback', categoryId: cat.id, teamId: team.id }, team.photoFallback ?? null)}
      </div>
      ${isOpen ? `<div class="team-row-roster">${roster}</div>` : ''}
    </div>`;
}

/** One collapsible per-category roster group. Zero-team synchro categories are
 * included too, so "Add team" is reachable everywhere. */
function rosterGroupHtml(cat: Category): string {
  const isOpen = openRosterCats.has(cat.id);
  const teams = cat.teams || [];
  const tally: Record<PhotoStatus, number> = { green: 0, yellow: 0, red: 0 };
  teams.forEach(t => { tally[teamPhotoStatus(t)]++; });
  const tallyHtml = (['green', 'yellow', 'red'] as const)
    .filter(k => tally[k] > 0)
    .map(k => `<span class="dot-count" title="${escapeHtml(STATUS_TITLE[k])}">
        <span class="status-dot is-${k}"></span>${tally[k]}</span>`).join('');
  return `<div class="roster-group">
      <div class="category-header roster-group-head is-synchro" data-toggle-roster="${cat.id}">
        <div class="category-head-lead">
          <span class="category-title">${escapeHtml(cat.name || '(unnamed)')}</span>
          <span class="micro-label">${teams.length} team${teams.length === 1 ? '' : 's'}</span>
        </div>
        <div class="category-head-tail">
          <span class="dot-tally">${tallyHtml}</span>
          <button class="btn btn-xs btn-primary" data-add-team="${cat.id}">Add team</button>
          <span class="toggle-icon">${isOpen ? '▴' : '▾'}</span>
        </div>
      </div>
      <div class="roster-group-body" style="display:${isOpen ? 'block' : 'none'};">
        ${teams.map(t => teamRowHtml(cat, t)).join('')
          || '<p class="section-sub roster-group-empty">No teams here yet — import the rosters or add one manually.</p>'}
      </div>
    </div>`;
}

/** The whole "Team rosters" body: synchro categories only, in schedule order. */
function rosterGroupsHtml(cats: Category[]): string {
  const groups = cats
    .filter(c => c.discipline === 'synchro')
    .slice()
    .sort((a, b) => a.order - b.order);
  if (!groups.length) {
    return `<p class="section-sub">No synchronized skating categories — team pages, rosters and
      team photos only apply to synchro.</p>`;
  }
  return `<div class="roster-groups">${groups.map(rosterGroupHtml).join('')}</div>`;
}

/** Persistent status panel for the last roster import (or automatic re-match).
 * The backend stores the report in metadata.json, so it survives reloads and is
 * refreshed silently whenever a Total Results PDF is assigned. */
function rosterReportHtml(s: Structure): string {
  const r = s.rosterImport;
  if (!r) return '';

  const when = fmtTimestamp(r.at);

  const unmatched = r.unmatched || [];
  const withdrawn = r.withdrawn || [];

  const list = (title: string, rows: string[]) => `
      <div class="roster-report-list">
        <span class="micro-label">${escapeHtml(title)} (${rows.length})</span>
        <ul>${rows.map(row => `<li>${row}</li>`).join('')}</ul>
      </div>`;

  const who = (t: { name: string; org: string }) =>
    escapeHtml(t.name || '(unnamed)') + (t.org ? ` <span class="roster-report-org">(${escapeHtml(t.org)})</span>` : '');

  const blocks: string[] = [];
  if (withdrawn.length) {
    blocks.push(list('Registered but not in any result sheet (withdrawn)',
      withdrawn.map(t => `${who(t)}${t.eventLabel ? ` — ${escapeHtml(t.eventLabel)}` : ''}`)));
  }
  if (unmatched.length) {
    blocks.push(list('Not placed',
      unmatched.map(t => `${who(t)} — ${escapeHtml(t.reason || 'no matching category')}`)));
  }
  if (!blocks.length) blocks.push('<p class="roster-report-ok">All registered teams placed.</p>');

  return `<div class="roster-report">
      <p class="roster-report-sum">Imported ${r.imported} team(s)${r.moved ? ` · ${r.moved} moved` : ''}${
        when ? ` <span class="roster-report-when">${escapeHtml(when)}</span>` : ''}</p>
      ${blocks.join('')}
    </div>`;
}

function categoryHtml(cat: Category): string {
  const isOpen = openCats.has(cat.id);
  const isSynchro = cat.discipline === 'synchro';
  const podiumNames = (cat.podium?.names || ['', '', '']).slice(0, 3);
  // Everything team-related (names, rosters, photos, fallback pictures) lives in
  // the "Team rosters" section below — the category card only points there.
  const teamsPointer = isSynchro ? `
      <p class="section-sub cat-teams-pointer">${(cat.teams || []).length} team${(cat.teams || []).length === 1 ? '' : 's'}
        — photos &amp; rosters are managed in <strong>Team rosters</strong> below.</p>` : '';

  const r = categoryReadiness(cat);
  const readyBadge = `<span class="cat-ready ${r.ready ? 'is-ready' : ''}" title="Required files uploaded">${r.ready ? '✓ ' : ''}${r.filled}/${r.total} uploaded</span>`;

  return `<div class="category-card">
      <div class="category-header ${isSynchro ? 'is-synchro' : ''}" data-toggle-cat="${cat.id}">
        <div class="category-head-lead">
          <span class="category-title">${escapeHtml(cat.name || '(unnamed)')}</span>
          ${isSynchro ? '<span class="tag-synchro">Synchro</span>' : ''}
        </div>
        <div class="category-head-tail">
          ${readyBadge}
          <span class="micro-label">${(cat.segments || []).length} seg</span>
          <span class="toggle-icon">${isOpen ? '▴' : '▾'}</span>
        </div>
      </div>
      <div class="category-content" style="display:${isOpen ? 'block' : 'none'};">
        <div class="cat-meta">
          <input class="form-input" style="max-width: 320px;" value="${escapeHtml(cat.name)}"
                 data-edit="set_category" data-cat="${cat.id}" data-field="name">
          <select class="discipline-select" data-discipline="${cat.id}">
            ${['single', 'pair', 'dance', 'synchro'].map(d =>
              `<option value="${d}" ${cat.discipline === d ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
          <button class="btn btn-xs btn-ghost btn-ghost--danger" data-rm-cat="${cat.id}">Remove category</button>
        </div>

        ${teamsPointer}

        <div class="section">
          <div class="section-head"><h3>Category pages</h3></div>
          <div class="slot-grid">
            ${slotHtml('Protocol Head Page (PDF)', { kind: 'categoryTitle', categoryId: cat.id }, cat.titlePdf, true)}
            ${slotHtml('Podium photo', { kind: 'podiumPhoto', categoryId: cat.id }, cat.podium?.photo || null)}
            ${slotHtml('Total results (PDF)', { kind: 'totalResults', categoryId: cat.id }, cat.totalResultsPdf, true)}
          </div>
          <div class="podium-names" style="margin-top: 0.75rem;">
            ${['1st', '2nd', '3rd'].map((p, i) => `
              <div class="podium-name-row">
                <span class="podium-place">${p} place</span>
                <input class="form-input" placeholder="Name(s)" value="${escapeHtml(podiumNames[i] || '')}"
                       data-podium="${cat.id}" data-place="${i}">
              </div>`).join('')}
          </div>
        </div>

        <div class="section">
          <div class="section-head"><h3>Segments</h3>
            <button class="btn btn-xs btn-primary" data-add-seg="${cat.id}">Add segment</button>
          </div>
          ${(cat.segments || []).slice().sort((a, b) => a.order - b.order).map(s => segmentHtml(cat, s)).join('')
            || '<p class="section-sub">No segments yet.</p>'}
        </div>
      </div>
    </div>`;
}

function renderDetails() {
  if (!details) return;
  ensureAutoPlaceReady();
  const s: Structure = details.structure;
  document.getElementById('detail-title')!.textContent = s.name;
  renderRetention(details.deletionDate);

  const ev = s.event;
  const field = (key: keyof typeof ev, label: string, wide = false) =>
    `<div class="event-field ${wide ? 'event-field--wide' : ''}">
       <label>${label}</label>
       <input class="form-input" data-event="${key}" value="${escapeHtml(ev[key] || '')}">
     </div>`;

  const trayChips = details.unassigned.length
    ? details.unassigned.map(chipHtml).join('')
    : '<span class="tray-empty">No unassigned files. Uploads land here, then drag them into slots.</span>';

  // The tag only survives on files whose automatic slot assignment succeeded,
  // so this is exactly the set the user should verify before generating.
  const autoTagged = Object.values(s.files || {}).filter(m => m.autoAssigned).length;

  const scheduleSection = s.scheduleParsed
    ? `<p class="section-sub">${(s.categories || []).length} categories parsed from the schedule.
         <button class="btn btn-xs btn-ghost" id="btn-reparse">Replace schedule…</button></p>`
    : `<div class="upload-area" id="schedule-drop">
         <p class="upload-title">Drop the competition schedule (DT_SCHEDULE XML or PDF)</p>
         <p class="upload-or">or</p>
         <button class="btn btn-sm btn-primary" id="schedule-browse">Browse…</button>
         <input type="file" id="schedule-input" accept=".xml,.pdf" style="display:none;">
       </div>
       <p class="section-sub">An ISU <strong>DT_SCHEDULE</strong> XML is preferred — it carries exact times, disciplines, segments and the ice rink.</p>`;

  const gen = details.generatedFiles || [];
  const genHtml = gen.length ? gen.map(g => `
      <div class="gen-file">
        <a class="gen-file-link" href="${g.url}" target="_blank" rel="noopener noreferrer">
          <span>${escapeHtml(g.fileName)}</span>
          <span class="gen-badge">${g.size ? Math.round(Number(g.size) / 1024) + ' KB' : ''}</span>
        </a>
        <button class="btn btn-xs btn-ghost btn-ghost--danger" data-del-protocol="${escapeHtml(g.fileName)}" title="Delete this protocol">×</button>
      </div>`).join('') : '<p class="section-sub">No protocol generated yet.</p>';

  document.getElementById('detail-body')!.innerHTML = `
    <div class="section">
      <div class="section-head"><h3>Event details</h3>
        <button class="btn btn-xs btn-ghost" id="btn-save-event">Save</button>
      </div>
      <div class="event-form">
        ${field('title', 'Protocol title', true)}
        ${field('organization', 'Organized by')}
        ${field('authorization', 'With authorization of')}
        ${field('city', 'Held in (city)')}
        ${field('rink', 'Ice rink / arena')}
        ${field('dates', 'Dates')}
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h3>Schedule</h3></div>
      ${scheduleSection}
    </div>

    <div class="section">
      <div class="section-head"><h3>Cover &amp; last page</h3></div>
      <p class="section-sub">Leave empty to use the default placeholder pages.</p>
      <div class="page-slot-row">
        ${slotHtml('Cover page (PDF or image)', { kind: 'cover' }, s.coverPage.fileId)}
        ${slotHtml('Last page (PDF or image)', { kind: 'lastPage' }, s.lastPage.fileId)}
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h3>Header &amp; footer</h3></div>
      <p class="section-sub">Stamped on every interior page. Leave empty to use the Figureskatingtools brand bands — the header automatically prints the competition name, dates and location. Upload an image to override either band.</p>
      <div class="page-slot-row">
        ${slotHtml('Competition header (image)', { kind: 'header' }, s.header?.fileId || null)}
        ${slotHtml('Competition footer (image)', { kind: 'footer' }, s.footer?.fileId || null)}
      </div>
      <label class="footer-toggle">
        <input type="checkbox" id="footer-enabled" ${s.footerEnabled !== false ? 'checked' : ''}>
        Show the footer band on every page
      </label>
    </div>

    <div class="section">
      <div class="section-head"><h3>Uploads</h3>
        <div class="section-head-actions">
          ${autoPlaceButtonHtml()}
          <button class="btn btn-xs btn-primary" id="tray-browse">Upload files…</button>
          <input type="file" id="tray-input" multiple accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.xml" style="display:none;">
        </div>
      </div>
      <p class="section-sub">Drop PDFs and photos here or into any slot — Figure Skating Manager exports
        are recognized by their file name and placed automatically with an <strong>auto</strong> tag.
        <strong>Auto-place files</strong> retries recognition for everything still here;
        drag chips between slots to move them.</p>
      <div class="tray" data-target='${attr({ kind: 'tray' })}'>
        <div class="tray-chips">${trayChips}</div>
      </div>
      ${poolImportHtml()}
    </div>

    <div class="section">
      <div class="section-head">
        <h3>Categories<span class="help-icon" tabindex="0" role="button" aria-label="Required files help">?<span class="help-pop">
          <strong>Required files</strong> (marked <span class="req">•</span>) drive each category's
          <em>"n/n uploaded"</em> badge — it turns green with a ✓ when all are present.
          <ul>
            <li>Every category needs a <strong>Protocol Head Page</strong> and <strong>Total Results</strong>.</li>
            <li>The <strong>Podium Photo</strong> is optional — left empty, the podium page simply shows blank space.</li>
            <li><strong>Panel of Judges</strong> is required on every segment.</li>
            <li>With <strong>two or more segments</strong>, each segment also requires its <strong>Segment Results</strong> and <strong>Judges Scores Details Without Referee</strong>.</li>
            <li>With <strong>a single segment</strong>, those two are optional: the lone segment's results would just repeat the Total Results, and for beginner-level competitors or local judging systems the detail scores might not be published — so they aren't required.</li>
          </ul>
        </span></span></h3>
        <button class="btn btn-xs btn-primary" id="btn-add-cat">Add category</button>
      </div>
      ${(s.categories || []).slice().sort((a, b) => a.order - b.order).map(categoryHtml).join('')
        || '<p class="section-sub">No categories yet. Upload a schedule or add one manually.</p>'}
    </div>

    ${(s.categories || []).length ? `
    <div class="section">
      <div class="section-head">
        <h3>Team rosters<span class="help-icon" tabindex="0" role="button" aria-label="Team roster help">?<span class="help-pop">
          <strong>Importing the teams</strong>
          <ul>
            <li>Assign each category's <strong>Total Results</strong> PDF first — teams register per
              event but compete per block, and the result sheets are the only place that mapping exists.</li>
            <li>Then select the competition's <strong>DT_PARTIC_TEAMS</strong> and <strong>DT_PARTIC</strong>
              XML files together; one pair covers the whole competition and every team is placed
              into the right block automatically.</li>
            <li>Assign a missing results PDF later and the teams are <strong>re-matched
              automatically</strong> — no need to import again.</li>
            <li>Accreditation pictures import in bulk from one <strong>ZIP</strong>: files named
              <code>Team-Name_Club-Name.jpeg</code>, optionally in folders named like the categories
              (the folder name is only a matching hint, and names may be ASCII-folded —
              "Helsinki-JaaLeidit" still matches "Helsinki JääLeidit"). Images matching no team land
              in the Uploads tray.</li>
          </ul>
          <strong>Picture status</strong>
          <ul>
            <li><span class="status-dot is-green"></span> <strong>Green</strong> — competition
              (kiss'n'cry) photo assigned; that is what the team page uses.</li>
            <li><span class="status-dot is-yellow"></span> <strong>Yellow</strong> — accreditation
              fallback only; used because no competition photo is set.</li>
            <li><span class="status-dot is-red"></span> <strong>Red</strong> — no picture at all, so
              the team page shows a placeholder; the whole row is highlighted.</li>
          </ul>
        </span></span></h3>
        <div class="section-head-actions">
          <button class="btn btn-xs btn-ghost" id="btn-import-rosters">Import teams (DT_PARTIC)…</button>
          <button class="btn btn-xs btn-ghost" id="btn-upload-fallbacks">Upload fallback pictures (ZIP)…</button>
        </div>
      </div>
      <p class="section-sub">Everything team-related lives here: names, rosters and both pictures.
        Assign the <strong>Total Results</strong> PDFs first, then import the DT_PARTIC XML pair —
        see <span class="help-hint">?</span> for the full flow and the colour codes.</p>
      ${rosterGroupsHtml(s.categories || [])}
      ${rosterReportHtml(s)}
    </div>` : ''}

    ${autoTagged ? `<p class="auto-check-note">${autoTagged} file${autoTagged === 1 ? ' was' : 's were'}
      placed automatically (<span class="chip-auto">auto</span>) — check they sit in the right slots
      before generating. Dragging a file by hand confirms it and clears the tag.</p>` : ''}
    <div class="action-bar">
      <div class="gen-list">${genHtml}</div>
      <button class="btn btn-primary btn-generate" id="btn-generate">Generate Protocol</button>
    </div>
  `;

  wireDetail();
}

// ── wiring ──
function wireDetail() {
  const body = document.getElementById('detail-body')!;

  // Hover previews + drag handles for every chip.
  body.querySelectorAll<HTMLElement>('.file-chip').forEach(chip => {
    const fid = chip.dataset.fileId!;
    const meta = fileMeta(fid);
    if (meta) attachPreview(chip, fileUrl(fid), meta);
    chip.addEventListener('dragstart', e => {
      e.dataTransfer!.setData('text/plain', fid);
      e.dataTransfer!.effectAllowed = 'move';
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
  });

  // Drop zones: slots + tray.
  body.querySelectorAll<HTMLElement>('[data-target]').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('dragover');
      const target = JSON.parse(zone.getAttribute('data-target')!) as SlotTarget;
      if (e.dataTransfer?.files?.length) {
        uploadFiles(e.dataTransfer.files, target);
        return;
      }
      const fid = e.dataTransfer?.getData('text/plain');
      if (fid) assignFile(fid, target);
    });
  });

  // Delete-file buttons (stop the drag/drop & prevent chip dragstart issues).
  body.querySelectorAll<HTMLElement>('[data-del-file]').forEach(b =>
    b.addEventListener('click', e => { e.stopPropagation(); deleteFile(b.dataset.delFile!); }));

  // Category collapse toggles.
  body.querySelectorAll<HTMLElement>('[data-toggle-cat]').forEach(h =>
    h.addEventListener('click', e => {
      if ((e.target as HTMLElement).closest('input,select,button')) return;
      const id = h.dataset.toggleCat!;
      if (openCats.has(id)) openCats.delete(id); else openCats.add(id);
      renderDetails();
    }));

  // Roster group collapse toggles (Team rosters section).
  body.querySelectorAll<HTMLElement>('[data-toggle-roster]').forEach(h =>
    h.addEventListener('click', e => {
      if ((e.target as HTMLElement).closest('input,select,button')) return;
      const id = h.dataset.toggleRoster!;
      if (openRosterCats.has(id)) openRosterCats.delete(id); else openRosterCats.add(id);
      renderDetails();
    }));

  // Per-team skater-list expanders.
  body.querySelectorAll<HTMLElement>('[data-toggle-roster-team]').forEach(b =>
    b.addEventListener('click', e => {
      e.stopPropagation();
      const id = b.dataset.toggleRosterTeam!;
      if (openRosterTeams.has(id)) openRosterTeams.delete(id); else openRosterTeams.add(id);
      renderDetails();
    }));

  // Event detail inputs (save on blur).
  body.querySelectorAll<HTMLInputElement>('[data-event]').forEach(inp =>
    inp.addEventListener('change', () => saveEvent()));
  document.getElementById('btn-save-event')?.addEventListener('click', () => saveEvent());

  // Structure text edits (category / segment / team).
  body.querySelectorAll<HTMLInputElement>('[data-edit]').forEach(inp =>
    inp.addEventListener('change', () => {
      const op = inp.dataset.edit!;
      const payload: any = { op, categoryId: inp.dataset.cat };
      if (inp.dataset.seg) payload.segmentId = inp.dataset.seg;
      if (inp.dataset.team) payload.teamId = inp.dataset.team;
      payload[inp.dataset.field!] = inp.value;
      editStructure(payload, false);
    }));

  // Discipline change (re-render to toggle synchro team UI).
  body.querySelectorAll<HTMLSelectElement>('[data-discipline]').forEach(sel =>
    sel.addEventListener('change', () =>
      editStructure({ op: 'set_category', categoryId: sel.dataset.discipline, discipline: sel.value }, true)));

  // Podium names.
  body.querySelectorAll<HTMLInputElement>('[data-podium]').forEach(inp =>
    inp.addEventListener('change', () => {
      const catId = inp.dataset.podium!;
      const cat = details!.structure.categories.find(c => c.id === catId);
      if (!cat) return;
      const names = (cat.podium?.names || ['', '', '']).slice(0, 3);
      names[Number(inp.dataset.place)] = inp.value;
      cat.podium.names = names;
      editStructure({ op: 'set_podium', categoryId: catId, names }, false);
    }));

  // Add / remove buttons.
  document.getElementById('btn-add-cat')?.addEventListener('click', () =>
    editStructure({ op: 'add_category', name: 'New Category', discipline: 'single' }, true));
  body.querySelectorAll<HTMLElement>('[data-rm-cat]').forEach(b =>
    b.addEventListener('click', () => editStructure({ op: 'remove_category', categoryId: b.dataset.rmCat }, true)));
  body.querySelectorAll<HTMLElement>('[data-add-seg]').forEach(b =>
    b.addEventListener('click', () => editStructure({ op: 'add_segment', categoryId: b.dataset.addSeg, name: 'Segment' }, true)));
  body.querySelectorAll<HTMLElement>('[data-rm-seg]').forEach(b =>
    b.addEventListener('click', () => editStructure({ op: 'remove_segment', categoryId: b.dataset.cat, segmentId: b.dataset.rmSeg }, true)));
  body.querySelectorAll<HTMLElement>('[data-add-team]').forEach(b =>
    b.addEventListener('click', () => {
      openRosterCats.add(b.dataset.addTeam!);   // keep the group open to show the new row
      editStructure({ op: 'add_team', categoryId: b.dataset.addTeam }, true);
    }));
  body.querySelectorAll<HTMLElement>('[data-rm-team]').forEach(b =>
    b.addEventListener('click', () => editStructure({ op: 'remove_team', categoryId: b.dataset.cat, teamId: b.dataset.rmTeam }, true)));

  // Roster import (two DT_PARTIC XML files, one pair for the whole competition).
  document.getElementById('btn-import-rosters')?.addEventListener('click', () => pickRosters());

  // Fallback (accreditation) pictures — one ZIP for the whole competition.
  document.getElementById('btn-upload-fallbacks')?.addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.zip';
    inp.onchange = () => { if (inp.files?.[0]) uploadFallbackZip(inp.files[0]); };
    inp.click();
  });

  // Schedule upload.
  const schedBrowse = document.getElementById('schedule-browse');
  const schedInput = document.getElementById('schedule-input') as HTMLInputElement | null;
  schedBrowse?.addEventListener('click', () => schedInput?.click());
  schedInput?.addEventListener('change', () => { if (schedInput.files?.[0]) parseSchedule(schedInput.files[0]); });
  const schedDrop = document.getElementById('schedule-drop');
  schedDrop?.addEventListener('dragover', e => { e.preventDefault(); schedDrop.classList.add('dragover'); });
  schedDrop?.addEventListener('dragleave', () => schedDrop.classList.remove('dragover'));
  schedDrop?.addEventListener('drop', e => {
    e.preventDefault(); schedDrop.classList.remove('dragover');
    if (e.dataTransfer?.files?.[0]) parseSchedule(e.dataTransfer.files[0]);
  });
  document.getElementById('btn-reparse')?.addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.xml,.pdf';
    inp.onchange = () => { if (inp.files?.[0]) parseSchedule(inp.files[0], true); };
    inp.click();
  });

  // Tray upload.
  const trayBrowse = document.getElementById('tray-browse');
  const trayInput = document.getElementById('tray-input') as HTMLInputElement | null;
  trayBrowse?.addEventListener('click', () => trayInput?.click());
  trayInput?.addEventListener('change', () => { if (trayInput.files?.length) uploadFiles(trayInput.files); trayInput.value = ''; });

  // Place recognized tray files into their slots in one go.
  document.getElementById('btn-auto-place')?.addEventListener('click', () => void autoPlaceTrayFiles());

  // Import files another tool (or FSM) put in this competition's shared pool.
  document.getElementById('btn-pool-import')?.addEventListener('click', () => void importPoolFiles());
  document.querySelector('.pool-import .pool-file-list')?.addEventListener('change', syncPoolImportButton);
  document.getElementById('btn-pool-select-all')?.addEventListener('click', (e) => {
    const all = poolChecks();
    const everySelected = all.length > 0 && all.every(c => c.checked);
    all.forEach(c => { c.checked = !everySelected; });
    (e.currentTarget as HTMLButtonElement).textContent = everySelected ? 'Select all' : 'Clear selection';
    syncPoolImportButton();
  });

  // Delete a generated protocol file.
  body.querySelectorAll<HTMLElement>('[data-del-protocol]').forEach(b =>
    b.addEventListener('click', () => deleteProtocol(b.dataset.delProtocol!)));

  // Footer band toggle.
  document.getElementById('footer-enabled')?.addEventListener('change', e => {
    const enabled = (e.target as HTMLInputElement).checked;
    if (details) details.structure.footerEnabled = enabled;
    editStructure({ op: 'set_footer_enabled', enabled }, false);
  });

  // Generate.
  document.getElementById('btn-generate')?.addEventListener('click', generate);
}

function deleteProtocol(fileName: string) {
  if (!currentId) return;
  openConfirmModal({
    title: 'Delete protocol?',
    message: `Delete the generated protocol <strong>${escapeHtml(fileName)}</strong>? This cannot be undone.`,
    onConfirm: async () => {
      const resp = await fetch(
        apiUrl(`/delete_protocol?competition=${encodeURIComponent(currentId!)}&fileName=${encodeURIComponent(fileName)}`),
        { method: 'DELETE' });
      if (!resp.ok) { alert('Delete failed: ' + (await resp.text())); throw new Error('delete failed'); }
      await loadDetails();
    },
  });
}

// ── mutations ──
async function saveEvent() {
  if (!currentId) return;
  const event: Record<string, string> = {};
  document.querySelectorAll<HTMLInputElement>('[data-event]').forEach(inp => {
    event[inp.dataset.event!] = inp.value;
    if (details) (details.structure.event as any)[inp.dataset.event!] = inp.value;
  });
  try { await apiJson('/save_event_settings', { id: currentId, event }); } catch { /* ignore */ }
}

async function assignFile(fileId: string, target: SlotTarget) {
  if (!currentId) return;
  try {
    const resp = await apiJson('/assign_file', { id: currentId, fileId, target });
    if (!resp.ok) { alert('Could not move file: ' + (await resp.text())); return; }
    await learnFromManualAssign(fileId, target);
    await loadDetails();
  } catch { alert('Network error moving file.'); }
}

/** Category-scoped slots: dropping into one names the file's category. */
const LEARNABLE_KINDS: ReadonlySet<SlotTarget['kind']> = new Set(['categoryTitle', 'totalResults', 'segment']);

/**
 * One manual drag teaches the category. The user just told us this file belongs
 * to this category, so its filename's abbreviation is the category's code —
 * stamp it and every sibling file matches by code from then on. Silent when
 * recognition is unavailable or the filename says nothing.
 */
async function learnFromManualAssign(fileId: string, target: SlotTarget): Promise<void> {
  if (!LEARNABLE_KINDS.has(target.kind) || !categoryNeedsCode(target.categoryId)) return;
  const filename = fileMeta(fileId)?.filename;
  if (!filename) return;
  const categories = await loadJpCategories();
  if (!categories) return;
  const matched = matchCategory(filename, categories);
  if (matched?.abbreviation) await stampCategoryCode(target.categoryId!, matched.abbreviation);
}

/* ── filename recognition → automatic slot placement ──
   Judge Papers owns the `categories` table that turns an FSM export filename
   into a category; this tool reads the very same table through that tool's API
   prefix (the router proxies each prefix to its own backend), so a category
   added there works here with no code change. The table being unreachable is
   not an error: recognition simply switches off and every file lands in the
   tray, exactly as before this feature existed. */

const JP_CATEGORIES_URL = '/judgepapers/api/get_categories';

/** In-flight/settled memo — the table is fetched at most once per page load. */
let jpCategories: Promise<CategoryInfo[] | null> | null = null;

function loadJpCategories(): Promise<CategoryInfo[] | null> {
  if (!jpCategories) {
    jpCategories = (async () => {
      try {
        const resp = await fetch(JP_CATEGORIES_URL, { headers: { Accept: 'application/json' } });
        if (!resp.ok) return null;
        const rows = await resp.json();
        return Array.isArray(rows) && rows.length
          ? sortCategoriesForMatching(rows as CategoryInfo[])
          : null;
      } catch {
        return null;
      }
    })();
  }
  return jpCategories;
}

/** Whether recognition is known to work — the "Auto-place files" button must
 * not offer what it cannot do. Resolving it is async, so the first usable
 * answer re-renders the view (once: the flag only ever goes true). */
let autoPlaceReady = false;

function ensureAutoPlaceReady(): void {
  if (autoPlaceReady) return;
  void loadJpCategories().then(cats => {
    if (!cats || autoPlaceReady) return;
    autoPlaceReady = true;
    renderDetails();
  });
}

/** Offered only when there is something to place, somewhere to place it, and a
 * category table to place it with. */
function autoPlaceButtonHtml(): string {
  if (!details || !details.unassigned.length) return '';
  if (!(details.structure.categories || []).length || !autoPlaceReady) return '';
  return '<button class="btn btn-xs btn-ghost" id="btn-auto-place">Auto-place files</button>';
}

/** How the summary toast names each reason a file stayed in the tray. */
const TRAY_REASON_LABEL: Record<TrayReason, string> = {
  'unrecognized': 'unrecognized',
  'not-for-protocol': 'not used in protocols',
  'unknown-suffix': 'unknown file kind',
  'ambiguous-category': 'category unclear',
  'ambiguous-segment': 'segment unclear',
  'slot-occupied': 'slot occupied',
};

/**
 * Plan a whole batch at once. Each outcome is applied to a **clone** of the
 * rendered structure, so two files in the same drop can never be sent to the
 * same slot. Null = recognition unavailable; the caller uploads as before.
 */
async function planBatch(names: string[]): Promise<AutoAssignOutcome[] | null> {
  if (!details || !names.length) return null;
  const categories = await loadJpCategories();
  if (!categories) return null;
  const working: StructureLike = structuredClone(details.structure);
  return names.map(name => {
    const outcome = planAutoAssignment(name, categories, working);
    applyOutcomeLocally(working, outcome, name);
    return outcome;
  });
}

/** Add a planned placement's slot params (the backend tags only if it sticks). */
function applyAutoParams(params: URLSearchParams, outcome: AutoAssignOutcome | undefined): void {
  if (!outcome || outcome.action !== 'assign') return;
  const t = outcome.target;
  params.set('slotKind', t.kind);
  params.set('categoryId', t.categoryId);
  if (t.segmentId) params.set('segmentId', t.segmentId);
  if (t.role) params.set('role', t.role);
  params.set('autoAssigned', '1');
}

/* ── learned category codes ──
   A schedule PDF gives its categories no ISU code, so the very first file of
   each has to be recognized by *name*. Stamping the abbreviation that match
   proved onto the code-less category turns every sibling file into a cheap,
   unambiguous code match — a category learns its code once, from whichever
   file (or manual drag) got there first. Failing to stamp costs nothing: the
   next batch simply matches by name again. */

/** Does this category still have no ISU code? (`----` padding counts as none,
 * exactly as the planner's own code matching reads it.) */
function categoryNeedsCode(categoryId: string | undefined): boolean {
  if (!categoryId || !details) return false;
  const cat = details.structure.categories?.find(c => c.id === categoryId);
  return !!cat && !stripTrailingDashes(cat.code);
}

/** Write a learned code; never fatal, so callers don't guard it. */
async function stampCategoryCode(categoryId: string, code: string): Promise<void> {
  if (!currentId) return;
  try {
    await apiJson('/edit_structure', { id: currentId, op: 'set_category', categoryId, code });
  } catch { /* ignore — recognition keeps working by name */ }
}

/** Stamp the codes a planned batch learned: one call per category, at most. */
async function stampLearnedCodes(outcomes: (AutoAssignOutcome | undefined)[]): Promise<void> {
  const learned = new Map<string, string>();
  outcomes.forEach(o => {
    if (!o || o.action !== 'assign') return;
    const { categoryId, categoryCode, matchedBy } = o.target;
    if (matchedBy !== 'name' || !categoryCode || learned.has(categoryId)) return;
    if (categoryNeedsCode(categoryId)) learned.set(categoryId, categoryCode);
  });
  for (const [categoryId, code] of learned) await stampCategoryCode(categoryId, code);
}

/** The wire shape `assign_file` expects — `categoryCode`/`matchedBy` are the
 * planner's own provenance and have no place in the request body. */
function slotTargetOf(t: AutoAssignTarget): SlotTarget {
  const target: SlotTarget = { kind: t.kind, categoryId: t.categoryId };
  if (t.segmentId) target.segmentId = t.segmentId;
  if (t.role) target.role = t.role;
  return target;
}

/** "3 placed automatically · 2 left in Uploads (1 unrecognized, 1 slot occupied)" */
function summarizeBatch(outcomes: AutoAssignOutcome[]): string | null {
  const placed = outcomes.filter(o => o.action === 'assign').length;
  if (!placed) return null;   // nothing recognized — stay quiet, as before
  const counts = new Map<TrayReason, number>();
  outcomes.forEach(o => {
    if (o.action === 'tray') counts.set(o.reason, (counts.get(o.reason) ?? 0) + 1);
  });
  const trayed = outcomes.length - placed;
  const why = [...counts.entries()].map(([r, n]) => `${n} ${TRAY_REASON_LABEL[r]}`).join(', ');
  return `${placed} placed automatically`
    + (trayed ? ` · ${trayed} left in Uploads (${why})` : '');
}

/* ── competition file pool ── */

function notePoolUnavailable(): void {
  poolDisabled = true;
  poolFiles = null;
  if (poolNoticeShown) return;
  poolNoticeShown = true;
  flash('Competition file pool unavailable — uploaded to this tool only.');
}

/** Refresh the pool listing; any failure just hides the import section. */
async function refreshPoolFiles(): Promise<void> {
  if (!boundPlatformId || poolDisabled) { poolFiles = null; return; }
  try {
    poolFiles = await listCompetitionFiles(boundPlatformId);
  } catch {
    poolFiles = null;
  }
}

/** Pool files this competition has not imported yet. */
function pendingPoolFiles(): PoolFile[] {
  if (!poolFiles || !details) return [];
  const known = new Set<string>();
  Object.values(details.structure.files || {}).forEach(m => {
    if (m.poolName) known.add(m.poolName);
    if (m.filename) known.add(m.filename);
  });
  return poolFiles.filter(f => !known.has(f.name));
}

function poolImportHtml(): string {
  const pending = pendingPoolFiles();
  if (!pending.length) return '';
  // Collapsed by default; a re-render (details refresh) keeps it open.
  const wasOpen = document.querySelector('details.pool-import')?.hasAttribute('open') ?? false;
  return `<details class="pool-import"${wasOpen ? ' open' : ''}>
      <summary class="pool-import-head">
        <span class="pool-import-title">Competition files</span>
        <span class="pool-import-count">${pending.length} available</span>
      </summary>
      <p class="section-sub">Uploaded for this competition in another tool — select the files you need and press Import. Recognized files go straight into their slots.</p>
      <div class="pool-file-list">${pending.map(f =>
        `<label class="pool-file" title="${escapeHtml(f.sourceTool || f.source)}">
           <input type="checkbox" class="pool-file-check" value="${escapeHtml(f.name)}">
           <span class="pool-file-name">${escapeHtml(f.name)}</span>
         </label>`).join('')}</div>
      <div class="pool-import-actions">
        <button class="btn btn-xs btn-ghost" id="btn-pool-select-all">Select all</button>
        <button class="btn btn-xs btn-primary" id="btn-pool-import" disabled>Import selected</button>
      </div>
    </details>`;
}

function poolChecks(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('.pool-file-check'));
}

function syncPoolImportButton(): void {
  const btn = document.getElementById('btn-pool-import') as HTMLButtonElement | null;
  if (!btn) return;
  const n = poolChecks().filter(c => c.checked).length;
  btn.disabled = n === 0;
  btn.textContent = n ? `Import selected (${n})` : 'Import selected';
}

/** Import the selected pool files, auto-placing what we can. */
async function importPoolFiles(): Promise<void> {
  if (!currentId || !boundPlatformId) return;
  const chosen = poolChecks().filter(c => c.checked).map(c => c.value);
  if (!chosen.length) return;

  const btn = document.getElementById('btn-pool-import') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }

  const outcomes = await planBatch(chosen);
  let failed = 0;
  for (let i = 0; i < chosen.length; i++) {
    const params = new URLSearchParams({ competition: currentId, name: chosen[i]! });
    applyAutoParams(params, outcomes?.[i]);
    try {
      const resp = await fetch(apiUrl(`/import_platform_file?${params.toString()}`), { method: 'POST' });
      if (!resp.ok) {
        failed++;
        if (resp.status === 503 || resp.status === 409) { notePoolUnavailable(); break; }
      }
    } catch { failed++; }
  }

  if (outcomes) await stampLearnedCodes(outcomes);
  await loadDetails();
  const parts = [`Imported ${chosen.length - failed} of ${chosen.length} competition file(s)`];
  const summary = outcomes ? summarizeBatch(outcomes) : null;
  if (summary) parts.push(summary);
  flash(parts.join(' · ') + '.');
}

/**
 * Place every tray file the recognizer is sure about.
 *
 * Planning is the upload path's (a clone of the structure, outcomes applied one
 * by one, so two files never chase the same slot); placing is the manual drag's
 * `assign_file`, flagged `autoAssigned` so the chips keep their "auto" pill and
 * a later drag still counts as the user's confirmation.
 */
async function autoPlaceTrayFiles(): Promise<void> {
  if (!currentId || !details) return;
  const fileIds = details.unassigned.slice();
  if (!fileIds.length) return;

  const btn = document.getElementById('btn-auto-place') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = 'Placing…'; }

  const outcomes = await planBatch(fileIds.map(fid => fileMeta(fid)?.filename || ''));
  if (!outcomes) {
    if (btn) { btn.disabled = false; btn.textContent = 'Auto-place files'; }
    flash('Filename recognition is unavailable right now.');
    return;
  }

  let failed = 0;
  for (let i = 0; i < fileIds.length; i++) {
    const outcome = outcomes[i]!;
    if (outcome.action !== 'assign') continue;
    try {
      const resp = await apiJson('/assign_file', {
        id: currentId,
        fileId: fileIds[i],
        target: slotTargetOf(outcome.target),
        autoAssigned: true,
      });
      if (!resp.ok) failed++;
    } catch { failed++; }
  }

  await stampLearnedCodes(outcomes);
  await loadDetails();
  const parts = [summarizeBatch(outcomes) ?? 'Nothing recognized — every file stayed in Uploads'];
  if (failed) parts.push(`${failed} could not be moved`);
  flash(parts.join(' · ') + '.');
}

/**
 * Upload one file's bytes.
 *
 * With a platform competition bound the bytes go to the shared pool first and
 * are imported from there, so every tool sees the same file. Any pool trouble
 * (unreachable, not configured, this record unbound) falls back to the tool's
 * own upload route with identical slot params — the upload always happens, it
 * is just not shared.
 */
async function uploadOneFile(file: File, params: URLSearchParams): Promise<void> {
  if (boundPlatformId && !poolDisabled) {
    let poolName: string | null = null;
    try {
      poolName = (await uploadCompetitionFile(boundPlatformId, file, 'protocolgenerator')).name;
    } catch {
      notePoolUnavailable();
    }
    if (poolName) {
      const importParams = new URLSearchParams(params);
      importParams.delete('filename');
      importParams.set('name', poolName);
      try {
        const resp = await fetch(apiUrl(`/import_platform_file?${importParams.toString()}`), { method: 'POST' });
        if (resp.ok) return;
        if (resp.status === 503 || resp.status === 409) notePoolUnavailable();
        // Any other failure falls through: the direct upload below both stores
        // the file and reports whatever is actually wrong with it.
      } catch { /* fall through to the direct upload */ }
    }
  }
  try {
    const resp = await apiRaw(`/upload_file?${params.toString()}`, file);
    if (!resp.ok) alert(`Upload failed for ${file.name}: ${await resp.text()}`);
  } catch { alert(`Upload error for ${file.name}.`); }
}

async function uploadFiles(files: FileList, target?: SlotTarget) {
  if (!currentId) return;
  const list = Array.from(files);
  // A drop onto a specific slot is a deliberate manual placement — only tray
  // drops and the Browse button go through filename recognition.
  const outcomes = (!target || target.kind === 'tray')
    ? await planBatch(list.map(f => f.name))
    : null;

  for (let i = 0; i < list.length; i++) {
    const file = list[i]!;
    const params = new URLSearchParams({ competition: currentId, filename: file.name });
    if (target && target.kind !== 'tray') {
      params.set('slotKind', target.kind);
      if (target.categoryId) params.set('categoryId', target.categoryId);
      if (target.segmentId) params.set('segmentId', target.segmentId);
      if (target.teamId) params.set('teamId', target.teamId);
      if (target.role) params.set('role', target.role);
    } else {
      applyAutoParams(params, outcomes?.[i]);
    }
    await uploadOneFile(file, params);
  }
  if (outcomes) await stampLearnedCodes(outcomes);
  await loadDetails();

  const summary = outcomes ? summarizeBatch(outcomes) : null;
  if (summary) flash(summary);
}

async function deleteFile(fileId: string) {
  if (!currentId) return;
  try {
    await fetch(apiUrl(`/delete_file?competition=${encodeURIComponent(currentId)}&fileId=${encodeURIComponent(fileId)}`), { method: 'DELETE' });
    await loadDetails();
  } catch { alert('Could not delete file.'); }
}

async function editStructure(payload: any, reload: boolean) {
  if (!currentId) return;
  try {
    const resp = await apiJson('/edit_structure', { id: currentId, ...payload });
    if (!resp.ok) { alert('Edit failed: ' + (await resp.text())); return; }
    if (reload) await loadDetails();
  } catch { alert('Network error editing competition.'); }
}

async function parseSchedule(file: File, force = false) {
  if (!currentId) return;
  const url = `/parse_schedule?competition=${encodeURIComponent(currentId)}${force ? '&force=true' : ''}`;
  try {
    const resp = await apiRaw(url, file);
    if (resp.status === 409) {
      if (confirm('This competition already has categories. Replace them from this schedule?')) {
        return parseSchedule(file, true);
      }
      return;
    }
    if (!resp.ok) { alert('Schedule parse failed: ' + (await resp.text())); return; }
    await loadDetails();
  } catch { alert('Network error parsing schedule.'); }
}

function pickRosters() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.xml'; inp.multiple = true;
  inp.onchange = async () => {
    const files = Array.from(inp.files || []);
    if (!files.length) return;
    const texts = await Promise.all(files.map(f => f.text()));
    let teamsXml = '', particXml = '';
    texts.forEach(t => {
      if (/DocumentType="DT_PARTIC_TEAMS"/.test(t)) teamsXml = t;
      else if (/DocumentType="DT_PARTIC"/.test(t)) particXml = t;
    });
    // Fallbacks if DocumentType isn't present: use filenames, then order.
    if (!teamsXml || !particXml) {
      files.forEach((f, i) => {
        if (/teams/i.test(f.name) && !teamsXml) teamsXml = texts[i];
        else if (!particXml) particXml = texts[i];
      });
    }
    if (!teamsXml) { alert('Could not find a DT_PARTIC_TEAMS file among the selected files.'); return; }
    await importRosters(teamsXml, particXml);
  };
  inp.click();
}

async function importRosters(teamsXml: string, particXml: string) {
  if (!currentId) return;
  try {
    // Omit the XML keys entirely when empty — the backend then re-matches from
    // the archived roster files instead of expecting a fresh upload.
    const body = {
      id: currentId,
      ...(teamsXml ? { teamsXml } : {}),
      ...(particXml ? { particXml } : {}),
    };
    const resp = await apiJson('/import_rosters', body);
    if (!resp.ok) { alert('Roster import failed: ' + (await resp.text())); return; }
    const data = await resp.json();
    await loadDetails();
    // Details (withdrawn / not placed) live in the persistent panel, not here.
    flash(`Imported ${data.imported} team(s)${data.moved ? `, ${data.moved} moved` : ''} — see the Team rosters section for details.`);
  } catch { alert('Network error importing rosters.'); }
}

/** Bulk-import accreditation pictures from one ZIP (folders ≈ categories, files
 * "Team-Name_Club-Name.jpeg"). Matched images become the team's fallback
 * picture; anything unmatched stays in the Uploads tray and is reported. */
async function uploadFallbackZip(file: File) {
  if (!currentId) return;
  try {
    const resp = await apiRaw(
      '/upload_fallback_photos?' + new URLSearchParams({ competition: currentId }), file);
    if (!resp.ok) { alert('Fallback picture import failed: ' + (await resp.text())); return; }
    const data = await resp.json();
    await loadDetails();
    const parts = [`Matched ${data.matched} fallback picture(s)`];
    if (Array.isArray(data.unmatchedFiles) && data.unmatchedFiles.length) {
      parts.push(`no team matched: ${data.unmatchedFiles.join(', ')}`);
    }
    if (Array.isArray(data.rejected) && data.rejected.length) {
      parts.push(`rejected: ${data.rejected.join(', ')}`);
    }
    flash(parts.join(' — ') + '.');
  } catch { alert('Network error importing fallback pictures.'); }
}

/** Brief transient status toast reusing the upload-status look. */
function flash(msg: string) {
  let el = document.getElementById('pg-flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pg-flash';
    el.style.cssText = 'position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;padding:0.6rem 1.1rem;border-radius:0.5rem;box-shadow:var(--shadow-lg);z-index:90;font-size:0.85rem;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  setTimeout(() => { if (el) el.style.opacity = '0'; el!.style.transition = 'opacity 0.5s'; }, 2500);
}

async function generate() {
  if (!currentId) return;
  const btn = document.getElementById('btn-generate') as HTMLButtonElement;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Generating…';
  try {
    const resp = await apiJson('/generate_protocol', { id: currentId });
    if (resp.ok) {
      btn.textContent = 'Done!';
      btn.classList.add('btn-success');
      setTimeout(() => { btn.classList.remove('btn-success'); btn.textContent = 'Generate Protocol'; btn.disabled = false; loadDetails(); }, 1500);
    } else {
      alert('Generation failed: ' + (await resp.text()));
      btn.textContent = 'Generate Protocol'; btn.disabled = false;
    }
  } catch {
    alert('Network error generating protocol.');
    btn.textContent = 'Generate Protocol'; btn.disabled = false;
  }
}

// ── confirmation modal ──
// Graphical confirmation modal (reuses the #modal-overlay component) — a single
// place for destructive confirmations so they're consistent and not JS popups.
function openConfirmModal(opts: {
  title: string; message: string; confirmLabel?: string;
  onConfirm: () => Promise<void> | void;
}) {
  const overlay = document.getElementById('modal-overlay')!;
  document.getElementById('modal-title')!.textContent = opts.title;
  document.getElementById('modal-message')!.innerHTML = opts.message;
  document.getElementById('modal-extra')!.innerHTML = '';
  const confirm = document.getElementById('modal-confirm') as HTMLButtonElement;
  const cancel = document.getElementById('modal-cancel') as HTMLButtonElement;
  confirm.className = 'btn btn-danger btn-sm';
  confirm.textContent = opts.confirmLabel || 'Delete';
  overlay.classList.remove('hidden');
  const close = () => overlay.classList.add('hidden');
  cancel.onclick = close;
  confirm.onclick = async () => {
    confirm.disabled = true;
    try { await opts.onConfirm(); close(); }
    catch { /* the action surfaced its own error; keep the modal open */ }
    finally { confirm.disabled = false; }
  };
}

// ── init / auth ──
async function init() {
  const loadingView = document.getElementById('loading-view')!;
  const mainContent = document.getElementById('main-content')!;
  const navContainer = document.getElementById('site-nav-container')!;

  try {
    const user: UserInfo | null = await fetchUser();

    if (!user) {
      // The site-wide gate — identical on every app path.
      renderSignInView(appElement, APP_PATH);
      return;
    }

    navContainer.innerHTML = renderSiteNav({
      activeApp: 'protocolgenerator',
      logoUrl: '/logo.png',
    });
    initSiteNav();

    const userSection = document.getElementById('fst-nav-right')!;
    setupUserMenu(userSection, user);

    // Site-wide competition picker; renders nothing when the platform API is
    // not reachable, so the tool still works standalone.
    const competitionSlot = document.getElementById('fst-nav-competition');
    if (competitionSlot) void initCompetitionSelector(competitionSlot);
    // The selector never fires on subscribe, so bind once here and then on every
    // change (this tab and, through the storage event, other tabs).
    subscribeActiveCompetition(() => void bindActiveCompetition());

    loadingView.classList.add('hidden');
    mainContent.classList.remove('hidden');

    await bindActiveCompetition();
  } catch {
    loadingView.classList.add('hidden');
    document.getElementById('error-view')!.classList.remove('hidden');
    document.getElementById('error-view')!.innerHTML = '<h2>Error</h2><p>Failed to initialize application.</p>';
  }
}

let mounted = false;

/**
 * Write the app into `#app` and start it.
 *
 * Everything DOM-touching lives in here on purpose: importing this module must
 * have no side effects, so the multi-entry Vite build can share chunks between
 * apps without one app's markup leaking into another's document.
 */
export function mount(): void {
  if (mounted) return;
  mounted = true;
  appElement = document.querySelector<HTMLDivElement>('#app')!;
  injectSiteNavStyles();
  appElement.innerHTML = APP_HTML;
  void init();
}

mount();
