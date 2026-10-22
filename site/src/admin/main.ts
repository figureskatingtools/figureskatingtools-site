import '../style.css'
import './admin.css'
import {
  ACCEPT_DAYS,
  CompetitionApiError,
  acceptHovtpSource,
  competitionFileUrl,
  extendCompetition,
  formatDateFi,
  formatDateTimeFi,
  formatFileSize,
  getActiveCompetition,
  getMe,
  initCompetitionSelector,
  initSiteNav,
  injectSiteNavStyles,
  listCompetitionFiles,
  listHovtpSources,
  normalizeCompetitionCode,
  rejectHovtpSource,
  renderSiteNav,
  retentionInfo,
  revokeHovtpSource,
  setActiveCompetition,
  type AcceptDays,
  type HovtpSource,
  type PlatformCompetition,
  type PoolFile,
} from '@figureskatingtools/shared-ui'
import { escapeHtml, fetchUser, renderSignInView, setupUserMenu, type UserInfo } from '../shell.js'
import {
  ADMIN_USER_SEARCH_MIN_CHARS,
  AdminApiError,
  deleteAdminCompetition,
  getAdminCompetition,
  getPlatformDiagnostics,
  getRouterDiagnostics,
  listAdminCompetitions,
  listAdminUsers,
  listAudit,
  purgeAdminCompetition,
  restoreAdminCompetition,
  runDryRunSweep,
  searchAdminUsers,
  setAdminOwner,
  updateAdminCompetition,
  type AdminCompetition,
  type AdminCompetitionDetail,
  type AdminCompetitionPatch,
  type AdminGrant,
  type AdminStatusFilter,
  type AdminUser,
  type AdminUserRef,
  type AuditEntry,
  type BackendHealth,
  type PlatformDiagnostics,
  type RouterDiagnostics,
} from './api.js'

// The router serves this document to admins only; the platform checks every
// /api/manage call again. Nothing here is a security boundary — it is UI.

const ADMIN_PATH = '/admin/';
const appElement = document.querySelector<HTMLDivElement>('#app')!;

injectSiteNavStyles();

/* ════════════════════════════════════════════════════════════════
   Helpers
   ════════════════════════════════════════════════════════════════ */

/** Text content: every interpolated value goes through this */
function esc(value: unknown): string {
  return escapeHtml(value === null || value === undefined ? '' : String(value));
}

/** Attribute values (escapeHtml escapes quotes too; the name marks the context) */
function attr(value: unknown): string {
  return esc(value);
}

function badge(text: string, kind: 'ok' | 'warn' | 'error' | 'muted' | 'info'): string {
  return `<span class="adm-badge adm-badge--${kind}">${esc(text)}</span>`;
}

/** `YYYY-MM-DD` of today + `days`, on the platform's (UTC) calendar */
function utcDay(days: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days))
    .toISOString()
    .slice(0, 10);
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${s} s`;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch (_e) {
    return String(value);
  }
}

/** One value of an audit change pair, short */
function changeValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

const ERROR_TEXT: Record<string, string> = {
  unreachable: 'The admin API could not be reached. Check the connection and try again.',
  admin_required: 'This account is not an administrator on the platform (check ADMIN_EMAILS on both the router and the platform).',
  unauthorized: 'The platform refused the router: its proxy secret is missing or does not match.',
  cross_site: 'The request was refused as cross-site. Reload the page and try again.',
  proxy_target_not_configured: 'The platform backend is not configured on this router.',
  proxy_request_failed: 'The platform backend could not be reached.',
  not_found: 'That competition does not exist.',
  code_in_use: 'That code is already used by another competition. Rename one of them and try again.',
  deleted: 'The competition is deleted. Restore it first.',
  not_deleted: 'Only a deleted competition can be restored.',
  purged: 'The competition has been purged; its data is gone.',
  purging: 'A purge of this competition has started and may already have removed files, so it cannot be restored. Purge it again to finish.',
  invalid_deletion_date: 'The deletion date must be tomorrow or later.',
  confirm_mismatch: 'The typed code does not match the competition code.',
  purge_failed: 'The purge did not complete. Nothing was tombstoned; it is safe to try again.',
  user_not_found: 'That user is no longer in the user directory.',
  created_by_read_only: '“Created by” is history and cannot be changed. Use Change owner instead.',
  query_too_short: 'Type at least 3 characters.',
  rate_limited: 'Too many searches — try again later.',
  conflict: 'The access list changed at the same time. Reload and try again.',
  invalid_status: 'Unknown status filter.',
  invalid_limit: 'Invalid page size.',
};

function errorText(err: unknown): string {
  if (err instanceof AdminApiError) {
    const known = ERROR_TEXT[err.code];
    if (known) return known;
    if (err.status === 404 && (err.code === '' || err.code === err.message)) {
      return 'The admin API answered 404: the platform may not have the admin routes deployed yet.';
    }
    return err.message;
  }
  if (err instanceof CompetitionApiError) {
    return err.status === 0 ? 'The competitions API could not be reached.' : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function errorBox(text: string): string {
  return `<div class="adm-alert adm-alert--error" role="alert">${esc(text)}</div>`;
}

function loadingBox(text = 'Loading…'): string {
  return `<p class="adm-loading">${esc(text)}</p>`;
}

/** The owner row of an access list, as a plain user reference */
function ownerOf(access: AdminGrant[]): AdminUserRef | null {
  const owner = access.find((g) => g.role === 'owner');
  return owner ? { userId: owner.userId, name: owner.name, email: owner.email } : null;
}

/** "Name <e-mail>", or whichever of the two is known */
function userLabel(user: AdminUserRef | null | undefined): string {
  if (!user) return '';
  const name = user.name.trim();
  const email = user.email.trim();
  if (name && email && name !== email) return `${name} <${email}>`;
  return name || email || user.userId;
}

/**
 * The registry's shape of a competition, for the active-competition state.
 * An admin always has full access (`owner`) on every competition.
 */
function toPlatform(c: AdminCompetition, owner?: AdminUserRef | null): PlatformCompetition {
  const competition: PlatformCompetition = {
    id: c.id,
    code: c.code,
    name: c.name,
    date: c.startDate,
    venue: c.venue,
    access: 'owner',
  };
  if (c.createdBy) competition.createdBy = c.createdBy;
  if (c.createdUtc) competition.createdUtc = c.createdUtc;
  if (c.deletionDate) competition.deletionDate = c.deletionDate;
  const knownOwner = owner !== undefined ? owner : c.owner;
  if (knownOwner !== undefined) competition.owner = knownOwner;
  return competition;
}

/** Keep open tool tabs current after an admin change to the active competition */
function syncActive(c: AdminCompetition, owner?: AdminUserRef | null): void {
  const active = getActiveCompetition();
  if (!active || active.id !== c.id) return;
  setActiveCompetition(c.status === 'active' ? { ...active, ...toPlatform(c, owner) } : null);
}

function statusBadge(c: AdminCompetition): string {
  if (c.status === 'purged') return badge('purged', 'muted');
  if (c.status === 'deleted') return badge('deleted', 'warn');
  return badge('active', 'ok');
}

/** "past date" / "due soon" / "before event", active competitions only */
function retentionBadge(c: AdminCompetition): string {
  if (c.status !== 'active') return '';
  const info = retentionInfo(c.deletionDate, c.startDate);
  if (!info) return '';
  if (Date.parse(c.deletionDate) <= Date.now()) return badge('past date', 'error');
  if (info.dueSoon) return badge(info.daysLeft === 1 ? 'due in 1 day' : `due in ${info.daysLeft} days`, 'warn');
  if (info.beforeEvent) return badge('before event', 'info');
  return '';
}

function clockBadge(c: AdminCompetition): string {
  if (!c.clock) return badge('no clock row', 'muted');
  return c.clock.inSync ? '' : badge('clock drift', 'error');
}

function deletionDay(c: AdminCompetition): string {
  const info = retentionInfo(c.deletionDate, c.startDate);
  return info ? formatDateFi(info.day) : '';
}

/* ════════════════════════════════════════════════════════════════
   State + routing
   ════════════════════════════════════════════════════════════════ */

type View =
  | { tab: 'competitions'; id: string | null }
  | { tab: 'diagnostics' }
  | { tab: 'users' }
  | { tab: 'audit' };

interface Notice {
  kind: 'ok' | 'error';
  text: string;
  /** Trusted markup appended after the text (links built here, never data) */
  html?: string;
}

interface DetailState {
  id: string;
  data: AdminCompetitionDetail | null;
  error: string;
  notice: Notice | null;
  busy: boolean;
  files: PoolFile[] | null;
  filesError: string;
  sources: HovtpSource[] | null;
  sourcesError: string;
}

const state = {
  view: parseLocation(),
  statusFilter: 'active' as AdminStatusFilter,
  search: '',
  list: null as AdminCompetition[] | null,
  listError: '',
  listFilter: null as AdminStatusFilter | null,
  detail: null as DetailState | null,
  routerDiag: null as RouterDiagnostics | null,
  routerDiagError: '',
  platformDiag: null as PlatformDiagnostics | null,
  platformDiagError: '',
  diagLoaded: false,
  sweep: null as Record<string, unknown> | null,
  sweepError: '',
  sweepBusy: false,
  audit: [] as AuditEntry[],
  auditNext: null as string | null,
  auditError: '',
  auditLoaded: false,
  auditBusy: false,
  users: null as AdminUser[] | null,
  usersError: '',
  usersSearch: '',
};

function parseLocation(): View {
  const rest = window.location.pathname.replace(/^\/admin\/?/, '');
  const [first, second] = rest.split('/');
  if (first === 'diagnostics') return { tab: 'diagnostics' };
  if (first === 'users') return { tab: 'users' };
  if (first === 'audit') return { tab: 'audit' };
  if (first === 'competitions' && second) {
    try {
      return { tab: 'competitions', id: decodeURIComponent(second) };
    } catch (_e) {
      // fall through to the list
    }
  }
  return { tab: 'competitions', id: null };
}

function pathFor(view: View): string {
  if (view.tab === 'diagnostics') return `${ADMIN_PATH}diagnostics`;
  if (view.tab === 'users') return `${ADMIN_PATH}users`;
  if (view.tab === 'audit') return `${ADMIN_PATH}audit`;
  return view.id ? `${ADMIN_PATH}competitions/${encodeURIComponent(view.id)}` : ADMIN_PATH;
}

/** In-app navigation to an /admin/… path: pushState, then render that view */
function navigate(target: string): void {
  if (target !== window.location.pathname) window.history.pushState(null, '', target);
  state.view = parseLocation();
  renderView();
  window.scrollTo({ top: 0 });
}

window.addEventListener('popstate', () => {
  state.view = parseLocation();
  renderView();
});

/* ════════════════════════════════════════════════════════════════
   Bootstrap
   ════════════════════════════════════════════════════════════════ */

async function init() {
  const userInfo = await fetchUser();
  if (!userInfo) {
    renderSignInView(appElement, ADMIN_PATH);
    return;
  }
  renderShell(userInfo);
}

function renderShell(userInfo: UserInfo) {
  appElement.innerHTML = `
    ${renderSiteNav({ activeApp: 'admin', logoUrl: '/logo.png' })}
    <main class="auth-main adm-main" id="adm-main"></main>
    <footer class="site-footer">
      <p>Supporting the figure skating community — created with a pinch of AI ❤️</p>
    </footer>
  `;

  const userSection = document.getElementById('fst-nav-right');
  if (userSection) setupUserMenu(userSection, userInfo);
  initSiteNav();
  const competitionSlot = document.getElementById('fst-nav-competition');
  if (competitionSlot) void initCompetitionSelector(competitionSlot);

  const main = document.getElementById('adm-main')!;
  if (!userInfo.isAdmin) {
    main.innerHTML = `
      <div class="card adm-unavailable">
        <span class="micro-label">Administration</span>
        <h2>Not available</h2>
        <p>The admin panel is only available to administrators.</p>
        <p><a href="/">Back to the home page</a></p>
      </div>
    `;
    return;
  }

  main.innerHTML = `
    <header class="adm-header">
      <span class="micro-label">Administration</span>
      <h1>Admin panel</h1>
    </header>
    <nav class="adm-tabs" aria-label="Admin sections">
      <a href="${ADMIN_PATH}" class="adm-tab" data-tab="competitions">Competitions</a>
      <a href="${ADMIN_PATH}users" class="adm-tab" data-tab="users">Users</a>
      <a href="${ADMIN_PATH}diagnostics" class="adm-tab" data-tab="diagnostics">Diagnostics</a>
      <a href="${ADMIN_PATH}audit" class="adm-tab" data-tab="audit">Audit log</a>
    </nav>
    <div id="adm-view"></div>
  `;

  // In-app links: plain <a href> (so a new tab works) intercepted for pushState
  main.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="/admin/"]');
    if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(new URL(link.href).pathname);
  });

  renderView();
}

function viewRoot(): HTMLElement | null {
  return document.getElementById('adm-view');
}

function renderView(): void {
  const root = viewRoot();
  if (!root) return;
  for (const tab of document.querySelectorAll<HTMLAnchorElement>('.adm-tab')) {
    const current = tab.dataset.tab === state.view.tab;
    tab.classList.toggle('adm-tab--active', current);
    if (current) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (state.view.tab === 'diagnostics') renderDiagnostics(root);
  else if (state.view.tab === 'users') renderUsers(root);
  else if (state.view.tab === 'audit') renderAudit(root);
  else if (state.view.id) renderDetail(root, state.view.id);
  else renderList(root);
}

/* ════════════════════════════════════════════════════════════════
   Competitions — list
   ════════════════════════════════════════════════════════════════ */

const STATUS_FILTERS: { value: AdminStatusFilter; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'deleted', label: 'Deleted' },
  { value: 'purged', label: 'Purged' },
  { value: 'all', label: 'All' },
];

function renderList(root: HTMLElement): void {
  root.innerHTML = `
    <section class="card adm-card">
      <div class="adm-toolbar">
        <label class="adm-field adm-field--inline">
          <span>Status</span>
          <select id="adm-status" class="adm-input">
            ${STATUS_FILTERS.map((f) => `<option value="${f.value}">${f.label}</option>`).join('')}
          </select>
        </label>
        <label class="adm-field adm-field--grow">
          <span class="adm-sr">Search</span>
          <input id="adm-search" class="adm-input" type="search" placeholder="Search name, code, venue, owner…" autocomplete="off">
        </label>
        <button type="button" id="adm-refresh" class="btn btn-secondary btn-sm">Refresh</button>
      </div>
      <div id="adm-list-body"></div>
    </section>
  `;
  const select = root.querySelector<HTMLSelectElement>('#adm-status')!;
  const search = root.querySelector<HTMLInputElement>('#adm-search')!;
  select.value = state.statusFilter;
  search.value = state.search;

  select.addEventListener('change', () => {
    state.statusFilter = select.value as AdminStatusFilter;
    void loadList();
  });
  search.addEventListener('input', () => {
    state.search = search.value;
    renderListBody();
  });
  root.querySelector('#adm-refresh')!.addEventListener('click', () => void loadList());

  if (state.list && state.listFilter === state.statusFilter) renderListBody();
  else void loadList();
}

let listEpoch = 0;

async function loadList(): Promise<void> {
  const epoch = ++listEpoch;
  const filter = state.statusFilter;
  state.listError = '';
  const body = document.getElementById('adm-list-body');
  if (body) body.innerHTML = loadingBox('Loading competitions…');
  try {
    const list = await listAdminCompetitions(filter);
    if (epoch !== listEpoch) return;
    state.list = list;
    state.listFilter = filter;
  } catch (err) {
    if (epoch !== listEpoch) return;
    state.list = null;
    state.listFilter = null;
    state.listError = errorText(err);
  }
  renderListBody();
}

function matchesSearch(c: AdminCompetition, needle: string): boolean {
  if (!needle) return true;
  return [c.name, c.code, c.venue, c.createdBy ?? '', c.owner?.name ?? '', c.owner?.email ?? '', c.id]
    .some((field) => field.toLowerCase().includes(needle));
}

function renderListBody(): void {
  const body = document.getElementById('adm-list-body');
  if (!body) return;
  if (state.listError) {
    body.innerHTML = errorBox(state.listError);
    return;
  }
  if (!state.list) {
    body.innerHTML = loadingBox('Loading competitions…');
    return;
  }
  const needle = state.search.trim().toLowerCase();
  const rows = state.list.filter((c) => matchesSearch(c, needle));
  const count = rows.length === state.list.length
    ? `${rows.length} competition${rows.length === 1 ? '' : 's'}`
    : `${rows.length} of ${state.list.length} competitions`;
  if (rows.length === 0) {
    body.innerHTML = `<p class="adm-count">${esc(count)}</p><p class="adm-empty">No competitions match.</p>`;
    return;
  }
  body.innerHTML = `
    <p class="adm-count">${esc(count)}</p>
    <div class="adm-table-wrap">
      <table class="adm-table">
        <thead>
          <tr>
            <th>Competition</th>
            <th>Start</th>
            <th class="adm-col-owner">Owner</th>
            <th>Status</th>
            <th>Deletion</th>
            <th class="adm-col-created">Created</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(listRow).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function listRow(c: AdminCompetition): string {
  const href = pathFor({ tab: 'competitions', id: c.id });
  return `
    <tr>
      <td>
        <a class="adm-row-link" href="${attr(href)}">${esc(c.name || c.code || c.id)}</a>
        <span class="adm-mono adm-sub">${esc(c.code)}</span>
      </td>
      <td class="adm-nowrap">${esc(formatDateFi(c.startDate))}</td>
      <td class="adm-col-owner adm-break">${c.owner
        ? `${esc(c.owner.name || c.owner.email)}${c.owner.name && c.owner.email ? `<span class="adm-sub">${esc(c.owner.email)}</span>` : ''}`
        : c.owner === null ? '<span class="adm-dim">no owner</span>' : esc(c.createdBy ?? '')}</td>
      <td>${statusBadge(c)} ${clockBadge(c)}</td>
      <td class="adm-nowrap">${esc(deletionDay(c))} ${retentionBadge(c)}</td>
      <td class="adm-col-created adm-nowrap">${esc(formatDateFi(c.createdUtc))}</td>
    </tr>
  `;
}

/** Fold a changed competition into the cached list */
function updateListEntry(c: AdminCompetition): void {
  if (!state.list) return;
  const index = state.list.findIndex((x) => x.id === c.id);
  if (index < 0) return;
  if (state.listFilter !== 'all' && state.listFilter !== c.status) state.list.splice(index, 1);
  else state.list[index] = c;
}

/* ════════════════════════════════════════════════════════════════
   Competitions — detail
   ════════════════════════════════════════════════════════════════ */

// Reached only by navigation (re-renders call paintDetail), so always fresh
function renderDetail(root: HTMLElement, id: string): void {
  state.detail = {
    id,
    data: null,
    error: '',
    notice: null,
    busy: false,
    files: null,
    filesError: '',
    sources: null,
    sourcesError: '',
  };
  root.innerHTML = `${backLink()}${loadingBox('Loading competition…')}`;
  void loadDetail(id);
}

function backLink(): string {
  return `<p class="adm-back"><a href="${ADMIN_PATH}" class="btn-link">← All competitions</a></p>`;
}

/** The detail state for `id` if the user is still looking at it */
function currentDetail(id: string): DetailState | null {
  return state.detail && state.detail.id === id && state.view.tab === 'competitions' && state.view.id === id
    ? state.detail
    : null;
}

async function loadDetail(id: string, notice: Notice | null = null): Promise<void> {
  let data: AdminCompetitionDetail | null = null;
  let error = '';
  try {
    data = await getAdminCompetition(id);
  } catch (err) {
    error = errorText(err);
  }
  const detail = currentDetail(id);
  if (!detail) return;
  detail.data = data;
  detail.error = error;
  if (notice) detail.notice = notice;
  if (data) {
    updateListEntry(data.competition);
    // After an admin change (notice set), open tool tabs follow via `storage`
    if (notice) syncActive(data.competition, ownerOf(data.access));
  }
  const root = viewRoot();
  if (root) paintDetail(root, detail);
  if (data && data.competition.status === 'active') {
    void loadFiles(id);
    void loadSources(id);
  }
}

function paintDetail(root: HTMLElement, detail: DetailState): void {
  if (detail.error && !detail.data) {
    root.innerHTML = `${backLink()}${errorBox(detail.error)}`;
    return;
  }
  if (!detail.data) {
    root.innerHTML = `${backLink()}${loadingBox('Loading competition…')}`;
    return;
  }
  const { competition: c } = detail.data;
  root.innerHTML = `
    ${backLink()}
    <section class="card adm-card adm-detail">
      <div class="adm-detail-head">
        <h2>${esc(c.name || c.code)}</h2>
        <span class="adm-mono adm-code">${esc(c.code)}</span>
        ${statusBadge(c)} ${retentionBadge(c)} ${clockBadge(c)}
      </div>
      <div id="adm-notice">${noticeHtml(detail.notice)}</div>
      ${factsHtml(detail.data)}
      ${actionsHtml(c, detail.busy)}
    </section>
    ${c.status !== 'purged' ? accessHtml(detail.data.access, detail.busy) : ''}
    ${c.status === 'active' ? editFormHtml(c, detail.busy) : ''}
    ${c.status === 'deleted' ? restoreHtml(detail.busy) : ''}
    ${c.status !== 'purged' ? purgeHtml(c) : ''}
    ${c.status === 'active' ? `
      <section class="card adm-card">
        <h3>Files</h3>
        <div id="adm-files"></div>
      </section>
      <section class="card adm-card">
        <h3>FSM data sources (HOVTP)</h3>
        <div id="adm-sources"></div>
      </section>` : c.status === 'deleted' ? `
      <section class="card adm-card">
        <p class="adm-note">Files and FSM data sources are listed while the competition is active. Restore it to see them.</p>
      </section>` : ''}
    <details class="card adm-card adm-raw">
      <summary>Raw JSON</summary>
      <pre id="adm-raw" class="adm-pre"></pre>
    </details>
  `;
  root.querySelector<HTMLElement>('#adm-raw')!.textContent = jsonText({
    competition: c.raw,
    files: detail.data.files,
    hovtp: detail.data.hovtp,
    access: detail.data.access,
  });
  bindDetail(root, detail, c);
  paintFiles(detail);
  paintSources(detail);
}

function noticeHtml(notice: Notice | null): string {
  if (!notice) return '';
  const kind = notice.kind === 'ok' ? 'ok' : 'error';
  return `<div class="adm-alert adm-alert--${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${esc(notice.text)}${notice.html ?? ''}</div>`;
}

function fact(label: string, valueHtml: string): string {
  return `<div class="adm-fact"><dt>${esc(label)}</dt><dd>${valueHtml || '<span class="adm-dim">—</span>'}</dd></div>`;
}

function factsHtml(data: AdminCompetitionDetail): string {
  const c = data.competition;
  const clock = c.clock
    ? `${c.clock.inSync ? 'in sync' : 'drifted'} · ${esc(c.clock.status ?? '—')} · ${esc(formatDateFi(c.clock.deletionDate ?? ''))}`
    : 'no row';
  const hovtp = data.hovtp;
  return `
    <dl class="adm-facts">
      ${fact('Start', esc(formatDateFi(c.startDate)))}
      ${fact('End', esc(formatDateFi(c.endDate ?? '')))}
      ${fact('Venue', esc(c.venue))}
      ${fact('Owner', c.status === 'purged'
        ? ''
        : ownerOf(data.access)
          ? `<span class="adm-break">${esc(userLabel(ownerOf(data.access)))}</span>`
          : '<span class="adm-dim">no owner — only admins see it</span>')}
      ${fact('Created by', `<span class="adm-break">${esc(c.createdBy ?? '')}</span>`)}
      ${fact('Deletion date', esc(deletionDay(c)))}
      ${fact('Extended', c.extendedCount ? `${esc(c.extendedCount)} × · last ${esc(formatDateTimeFi(c.lastExtendedUtc))}` : '0 ×')}
      ${fact('Created', esc(formatDateTimeFi(c.createdUtc)))}
      ${fact('Updated', esc(formatDateTimeFi(c.updatedUtc)))}
      ${c.status !== 'active' ? fact('Deleted', `${esc(formatDateTimeFi(c.deletedUtc))}${c.deleteReason ? ` · ${esc(c.deleteReason)}` : ''}`) : ''}
      ${c.purgedUtc ? fact('Purged', esc(formatDateTimeFi(c.purgedUtc))) : ''}
      ${fact('Clock row', clock)}
      ${fact('Stored files', `${esc(data.files.count)}${data.files.bytes ? ` · ${esc(formatFileSize(data.files.bytes))}` : ''}`)}
      ${fact('HOVTP sources', `${esc(hovtp.pending)} pending · ${esc(hovtp.accepted)} accepted · ${esc(hovtp.expired)} expired · ${esc(hovtp.rejected)} rejected`)}
      ${fact('Id', `<span class="adm-mono adm-break">${esc(c.id)}</span>`)}
    </dl>
  `;
}

function actionsHtml(c: AdminCompetition, busy: boolean): string {
  if (c.status !== 'active') return '';
  const disabled = busy ? 'disabled' : '';
  return `
    <div class="adm-actions">
      <button type="button" class="btn btn-secondary btn-sm" data-action="extend" ${disabled}>Extend by a week</button>
      <button type="button" class="btn btn-secondary btn-sm" data-action="open" ${disabled}>Open in tools</button>
      <button type="button" class="btn btn-secondary btn-sm adm-btn-danger" data-action="delete" ${disabled}>Delete</button>
    </div>
  `;
}

function editFormHtml(c: AdminCompetition, busy: boolean): string {
  const tomorrow = utcDay(1);
  return `
    <section class="card adm-card">
      <h3>Edit</h3>
      <form id="adm-edit" class="adm-form" novalidate>
        <label class="adm-field"><span>Name</span><input class="adm-input" name="name" required maxlength="200"></label>
        <label class="adm-field"><span>Code</span><input class="adm-input adm-mono" name="code" maxlength="100" autocomplete="off" spellcheck="false">
          <small class="adm-hint">Renaming the code: FSM pushes that still use the old code are refused until FS Manager is reconfigured.</small></label>
        <div class="adm-form-row">
          <label class="adm-field"><span>Start date</span><input class="adm-input" type="date" name="startDate"></label>
          <label class="adm-field"><span>End date</span><input class="adm-input" type="date" name="endDate"></label>
        </div>
        <label class="adm-field"><span>Venue</span><input class="adm-input" name="venue" maxlength="200"></label>
        <div class="adm-field"><span>Created by</span>
          <span class="adm-readonly adm-break">${c.createdBy ? esc(c.createdBy) : '<span class="adm-dim">—</span>'}</span>
          <small class="adm-hint">History only. Who owns the competition is set under Access → Change owner.</small></div>
        <label class="adm-field"><span>Deletion date (UTC, tomorrow or later)</span><input class="adm-input" type="date" name="deletionDate" min="${tomorrow}"></label>
        <div class="adm-form-actions">
          <button type="submit" class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''}>Save changes</button>
          <span class="adm-form-error" id="adm-edit-error" role="alert"></span>
        </div>
      </form>
    </section>
  `;
}

const ROLE_LABEL: Record<AdminGrant['role'], string> = {
  owner: 'owner',
  write: 'can edit',
  read: 'view only',
};

/** Who has access, and the admin-only "Change owner…" picker */
function accessHtml(access: AdminGrant[], busy: boolean): string {
  const disabled = busy ? 'disabled' : '';
  const rows = access.map((g) => `
    <tr>
      <td>${esc(g.name || '—')}</td>
      <td class="adm-break">${esc(g.email)}</td>
      <td>${badge(ROLE_LABEL[g.role], g.role === 'owner' ? 'info' : g.role === 'write' ? 'ok' : 'muted')}</td>
    </tr>`).join('');
  return `
    <section class="card adm-card">
      <h3>Access</h3>
      ${ownerOf(access) ? '' : '<p class="adm-note">This competition has no owner, so only admins can see it. Give it one below.</p>'}
      ${access.length ? `
        <div class="adm-table-wrap">
          <table class="adm-table">
            <thead><tr><th>Name</th><th>E-mail</th><th>Access</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>` : ''}
      <p class="adm-note">To share it or change someone's access, open it in the tools and use <strong>Share…</strong> on the home page.</p>
      <form id="adm-owner" class="adm-form" novalidate>
        <div class="adm-field">
          <label for="adm-owner-search">Change owner…</label>
          <div class="adm-combo">
            <input id="adm-owner-search" class="adm-input" type="text" autocomplete="off" spellcheck="false"
                   placeholder="Name or e-mail" role="combobox" aria-autocomplete="list" aria-expanded="false"
                   aria-controls="adm-owner-results" aria-describedby="adm-owner-hint" ${disabled}>
            <ul id="adm-owner-results" class="adm-combo-list" role="listbox" aria-label="Matching users" hidden></ul>
          </div>
          <small class="adm-hint" id="adm-owner-hint" aria-live="polite">Type at least ${ADMIN_USER_SEARCH_MIN_CHARS} characters of a name or e-mail. The current owner keeps edit access.</small>
        </div>
        <div class="adm-form-actions">
          <button type="submit" class="btn btn-primary btn-sm" data-owner-submit disabled>Make owner</button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="owner-me" ${disabled}>Make me the owner</button>
        </div>
      </form>
    </section>
  `;
}

/** Wire the "Change owner…" type-ahead: 250 ms debounce, arrow keys + Enter, confirm */
function bindOwnerPicker(root: HTMLElement, detail: DetailState, c: AdminCompetition, access: AdminGrant[]): void {
  const form = root.querySelector<HTMLFormElement>('#adm-owner');
  if (!form) return;
  const input = form.querySelector<HTMLInputElement>('#adm-owner-search')!;
  const list = form.querySelector<HTMLUListElement>('#adm-owner-results')!;
  const hint = form.querySelector<HTMLElement>('#adm-owner-hint')!;
  const submit = form.querySelector<HTMLButtonElement>('[data-owner-submit]')!;
  const defaultHint = hint.textContent ?? '';
  const current = ownerOf(access);
  let results: AdminUserRef[] = [];
  let active = -1;
  let picked: AdminUserRef | null = null;
  let timer: number | null = null;
  let seq = 0;

  const close = (): void => {
    list.hidden = true;
    list.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const highlight = (index: number): void => {
    active = index;
    list.querySelectorAll<HTMLElement>('[role="option"]').forEach((el, i) => {
      el.classList.toggle('adm-combo-item--active', i === index);
      el.setAttribute('aria-selected', i === index ? 'true' : 'false');
      if (i === index) input.setAttribute('aria-activedescendant', el.id);
    });
  };
  const pick = (user: AdminUserRef | null): void => {
    picked = user;
    submit.disabled = !user || detail.busy;
    if (user) {
      input.value = userLabel(user);
      hint.textContent = current && current.userId === user.userId
        ? `${userLabel(user)} already owns it.`
        : `Press Make owner to hand “${c.name || c.code}” to ${userLabel(user)}.`;
      if (current && current.userId === user.userId) submit.disabled = true;
    } else {
      hint.textContent = defaultHint;
    }
  };
  const choose = (index: number): void => {
    const user = results[index];
    if (!user) return;
    close();
    pick(user);
    submit.focus();
  };
  const render = (): void => {
    if (!results.length) { close(); return; }
    list.innerHTML = results.map((u, i) => `
      <li id="adm-owner-opt-${i}" class="adm-combo-item" role="option" aria-selected="false" data-index="${i}">
        <span>${esc(u.name || u.email)}</span>${u.name && u.email ? `<span class="adm-sub">${esc(u.email)}</span>` : ''}
      </li>`).join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = -1;
    list.querySelectorAll<HTMLElement>('[data-index]').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(Number(el.dataset.index));
      });
    });
  };
  const search = async (query: string): Promise<void> => {
    const mine = ++seq;
    hint.textContent = 'Searching…';
    try {
      const found = await searchAdminUsers(query);
      if (mine !== seq) return;
      results = found;
      render();
      hint.textContent = found.length
        ? `${found.length} ${found.length === 1 ? 'match' : 'matches'} — arrow keys and Enter pick one.`
        : 'Nobody matches. Users appear once they have signed in.';
    } catch (err) {
      if (mine !== seq) return;
      results = [];
      close();
      hint.textContent = errorText(err);
    }
  };

  input.addEventListener('input', () => {
    if (picked && input.value !== userLabel(picked)) pick(null);
    if (timer !== null) window.clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < ADMIN_USER_SEARCH_MIN_CHARS) {
      seq++;
      results = [];
      close();
      if (!picked) hint.textContent = defaultHint;
      return;
    }
    timer = window.setTimeout(() => { timer = null; void search(query); }, 250);
  });
  input.addEventListener('keydown', (e) => {
    const open = !list.hidden && results.length > 0;
    if (e.key === 'ArrowDown' && open) {
      e.preventDefault();
      highlight(active < results.length - 1 ? active + 1 : 0);
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      highlight(active > 0 ? active - 1 : results.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open) choose(active >= 0 ? active : 0);
      else if (picked && !submit.disabled) form.requestSubmit();
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      close();
    }
  });
  input.addEventListener('blur', () => window.setTimeout(close, 120));

  const changeOwner = (user: AdminUserRef): void => {
    const name = c.name || c.code;
    const confirmed = window.confirm(
      `Make ${userLabel(user)} the owner of “${name}”?\n\n`
      + (current
        ? `${userLabel(current)} stays on it with edit access. `
        : 'It has no owner now. ')
      + 'The new owner can share it, and delete it.'
    );
    if (!confirmed) return;
    void runAction(detail, async () => {
      await setAdminOwner(c.id, user.userId);
      return { kind: 'ok', text: `${userLabel(user)} now owns “${name}”.` };
    });
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (picked && !detail.busy) changeOwner(picked);
  });

  root.querySelector<HTMLButtonElement>('[data-action="owner-me"]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    void getMe()
      .then((me) => {
        btn.disabled = detail.busy;
        if (current && current.userId === me.userId) {
          hint.textContent = 'You already own it.';
          return;
        }
        changeOwner({ userId: me.userId, name: me.name, email: me.email });
      })
      .catch((err: unknown) => {
        btn.disabled = detail.busy;
        hint.textContent = errorText(err);
      });
  });
}

function restoreHtml(busy: boolean): string {
  return `
    <section class="card adm-card">
      <h3>Restore</h3>
      <p class="adm-note">Brings the competition back as active and re-claims its code. If another competition took the code meanwhile, rename that one first.</p>
      <form id="adm-restore" class="adm-form adm-form--inline" novalidate>
        <label class="adm-field"><span>New deletion date (UTC)</span><input class="adm-input" type="date" name="deletionDate" min="${utcDay(1)}" value="${utcDay(7)}"></label>
        <button type="submit" class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''}>Restore</button>
      </form>
    </section>
  `;
}

function purgeHtml(c: AdminCompetition): string {
  return `
    <section class="card adm-card adm-danger">
      <h3>Purge now</h3>
      <p class="adm-note">Deletes every stored file and HOVTP source of this competition at once and leaves only a tombstone, exactly like the nightly sweep. This ignores the purge kill switch and cannot be undone.</p>
      <form id="adm-purge" class="adm-form adm-form--inline" novalidate>
        <label class="adm-field"><span>Type the code <span class="adm-mono">${esc(c.code)}</span> to confirm</span>
          <input class="adm-input adm-mono" name="confirm" autocomplete="off" spellcheck="false"></label>
        <button type="submit" class="btn btn-primary btn-sm adm-btn-destroy" disabled>Purge</button>
      </form>
    </section>
  `;
}

function bindDetail(root: HTMLElement, detail: DetailState, c: AdminCompetition): void {
  if (detail.data) bindOwnerPicker(root, detail, c, detail.data.access);

  root.querySelector('[data-action="extend"]')?.addEventListener('click', () => {
    void runAction(detail, async () => {
      await extendCompetition(c.id);
      return { kind: 'ok', text: 'The deletion date was pushed a week out.' };
    });
  });

  root.querySelector('[data-action="open"]')?.addEventListener('click', () => {
    setActiveCompetition(toPlatform(c, detail.data ? ownerOf(detail.data.access) : undefined));
    detail.notice = {
      kind: 'ok',
      text: `“${c.name || c.code}” is now the active competition in every tool: `,
      html: ' <a href="/judgepapers/">Judge Paper Creator</a> · <a href="/scoremodifier/">Score Modifier</a> · <a href="/protocolgenerator/">Protocol Generator</a>',
    };
    const box = document.getElementById('adm-notice');
    if (box) box.innerHTML = noticeHtml(detail.notice);
  });

  root.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
    const confirmed = window.confirm(
      `Delete “${c.name || c.code}”?\n\nIts code is freed at once, and its data is deleted automatically at the next midnight (UTC). Until then it can still be restored here.`
    );
    if (!confirmed) return;
    void runAction(detail, async () => {
      await deleteAdminCompetition(c.id);
      return { kind: 'ok', text: 'The competition was deleted.' };
    });
  });

  const edit = root.querySelector<HTMLFormElement>('#adm-edit');
  if (edit) {
    const field = (name: string) => edit.elements.namedItem(name) as HTMLInputElement;
    field('name').value = c.name;
    field('code').value = c.code;
    field('startDate').value = c.startDate;
    field('endDate').value = c.endDate ?? '';
    field('venue').value = c.venue;
    field('deletionDate').value = c.deletionDate.slice(0, 10);

    edit.addEventListener('submit', (e) => {
      e.preventDefault();
      const errorEl = edit.querySelector<HTMLElement>('#adm-edit-error')!;
      errorEl.textContent = '';
      const patch: AdminCompetitionPatch = {};
      const name = field('name').value.trim();
      const code = normalizeCompetitionCode(field('code').value);
      const startDate = field('startDate').value;
      const endDate = field('endDate').value;
      const venue = field('venue').value.trim();
      const deletionDate = field('deletionDate').value;

      if (!name) {
        errorEl.textContent = 'The name cannot be empty.';
        return;
      }
      if (!code) {
        errorEl.textContent = 'The code cannot be empty.';
        return;
      }
      if (name !== c.name) patch.name = name;
      if (code !== c.code) patch.code = code;
      if (startDate !== c.startDate) patch.startDate = startDate;
      if (endDate !== (c.endDate ?? '')) patch.endDate = endDate;
      if (venue !== c.venue) patch.venue = venue;
      if (deletionDate !== c.deletionDate.slice(0, 10)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(deletionDate) || deletionDate < utcDay(1)) {
          errorEl.textContent = 'The deletion date must be tomorrow (UTC) or later.';
          return;
        }
        patch.deletionDate = deletionDate;
      }
      if (Object.keys(patch).length === 0) {
        errorEl.textContent = 'Nothing has changed.';
        return;
      }
      void runAction(detail, async () => {
        await updateAdminCompetition(c.id, patch);
        return { kind: 'ok', text: `Saved: ${Object.keys(patch).join(', ')}.` };
      });
    });
  }

  const restore = root.querySelector<HTMLFormElement>('#adm-restore');
  if (restore) {
    restore.addEventListener('submit', (e) => {
      e.preventDefault();
      const date = (restore.elements.namedItem('deletionDate') as HTMLInputElement).value;
      if (date && date < utcDay(1)) {
        detail.notice = { kind: 'error', text: 'The deletion date must be tomorrow (UTC) or later.' };
        const box = document.getElementById('adm-notice');
        if (box) box.innerHTML = noticeHtml(detail.notice);
        return;
      }
      void runAction(detail, async () => {
        await restoreAdminCompetition(c.id, date || undefined);
        return { kind: 'ok', text: 'The competition was restored.' };
      });
    });
  }

  const purge = root.querySelector<HTMLFormElement>('#adm-purge');
  if (purge) {
    const input = purge.elements.namedItem('confirm') as HTMLInputElement;
    const button = purge.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const matches = () => normalizeCompetitionCode(input.value) === normalizeCompetitionCode(c.code);
    input.addEventListener('input', () => {
      button.disabled = detail.busy || !matches();
    });
    purge.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!matches() || detail.busy) return;
      const confirmed = window.confirm(
        `Purge “${c.name || c.code}” now?\n\nEvery stored file and HOVTP source is deleted immediately. This cannot be undone.`
      );
      if (!confirmed) return;
      const typed = input.value.trim();
      void runAction(detail, async () => {
        await purgeAdminCompetition(c.id, typed);
        return { kind: 'ok', text: 'The competition was purged. Only its tombstone remains.' };
      });
    });
  }
}

/** Run one detail mutation: busy state, error notice, then a fresh reload */
async function runAction(detail: DetailState, action: () => Promise<Notice>): Promise<void> {
  if (detail.busy) return;
  detail.busy = true;
  for (const el of document.querySelectorAll<HTMLButtonElement>('#adm-view button')) el.disabled = true;
  let notice: Notice;
  try {
    notice = await action();
  } catch (err) {
    detail.busy = false;
    if (!currentDetail(detail.id)) return;
    // Keep the page as it is (with whatever was typed) and say what went wrong
    detail.notice = { kind: 'error', text: errorText(err) };
    const box = document.getElementById('adm-notice');
    if (box) box.innerHTML = noticeHtml(detail.notice);
    for (const el of document.querySelectorAll<HTMLButtonElement>('#adm-view button')) el.disabled = false;
    // The purge button stays tied to the typed confirmation
    document.querySelector('#adm-purge input')?.dispatchEvent(new Event('input'));
    box?.scrollIntoView({ block: 'nearest' });
    return;
  }
  detail.busy = false;
  if (!currentDetail(detail.id)) return;
  detail.files = null;
  detail.sources = null;
  await loadDetail(detail.id, notice);
}

/* ── Files ── */

async function loadFiles(id: string): Promise<void> {
  let files: PoolFile[] | null = null;
  let error = '';
  try {
    files = await listCompetitionFiles(id);
  } catch (err) {
    error = errorText(err);
  }
  const detail = currentDetail(id);
  if (!detail) return;
  detail.files = files;
  detail.filesError = error;
  paintFiles(detail);
}

function paintFiles(detail: DetailState): void {
  const box = document.getElementById('adm-files');
  if (!box) return;
  if (detail.filesError) {
    box.innerHTML = errorBox(`Files could not be listed: ${detail.filesError}`);
    return;
  }
  if (!detail.files) {
    box.innerHTML = loadingBox('Loading files…');
    return;
  }
  if (detail.files.length === 0) {
    box.innerHTML = '<p class="adm-empty">No files.</p>';
    return;
  }
  box.innerHTML = `
    <ul class="adm-list">
      ${detail.files.map((f) => `
        <li class="adm-list-row">
          <a class="adm-break" href="${attr(competitionFileUrl(detail.id, f.name, f.source))}" target="_blank" rel="noopener">${esc(f.name)}</a>
          <span class="adm-sub">${[
            f.source === 'fsm' ? 'FSM' : 'upload',
            formatFileSize(f.size),
            formatDateTimeFi(f.uploadedUtc),
            f.sourceTool ?? '',
            f.uploadedBy ?? '',
          ].filter(Boolean).map(esc).join(' · ')}</span>
        </li>`).join('')}
    </ul>
  `;
}

/* ── HOVTP sources ── */

async function loadSources(id: string): Promise<void> {
  let sources: HovtpSource[] | null = null;
  let error = '';
  try {
    sources = await listHovtpSources(id);
  } catch (err) {
    error = errorText(err);
  }
  const detail = currentDetail(id);
  if (!detail) return;
  detail.sources = sources;
  detail.sourcesError = error;
  paintSources(detail);
}

function sourceStatusBadge(s: HovtpSource): string {
  if (s.status === 'accepted') return badge('accepted', 'ok');
  if (s.status === 'rejected') return badge('rejected', 'muted');
  if (s.status === 'expired') return badge('expired', 'warn');
  return badge('pending', 'info');
}

function paintSources(detail: DetailState): void {
  const box = document.getElementById('adm-sources');
  if (!box) return;
  if (detail.sourcesError) {
    box.innerHTML = errorBox(`Sources could not be listed: ${detail.sourcesError}`);
    return;
  }
  if (!detail.sources) {
    box.innerHTML = loadingBox('Loading sources…');
    return;
  }
  if (detail.sources.length === 0) {
    box.innerHTML = '<p class="adm-empty">No FSM data source has pushed to this competition.</p>';
    return;
  }
  box.innerHTML = `
    <ul class="adm-list">
      ${detail.sources.map((s, index) => `
        <li class="adm-list-row adm-source" data-index="${index}">
          <div class="adm-source-head">
            <span class="adm-mono">${esc(s.ip)}</span> ${sourceStatusBadge(s)}
          </div>
          <span class="adm-sub">${[s.origin, s.venue, s.discipline, s.environment].filter(Boolean).map(esc).join(' · ')}</span>
          <span class="adm-sub">${[
            `${s.messageCount} message${s.messageCount === 1 ? '' : 's'}`,
            `last ${formatDateTimeFi(s.lastSeenUtc)}`,
            s.pendingCount ? `${s.pendingCount} quarantined (${formatFileSize(s.pendingBytes)})` : '',
            s.acceptedUntilUtc ? `accepted until ${formatDateTimeFi(s.acceptedUntilUtc)}` : '',
            s.acceptedBy ? `by ${s.acceptedBy}` : '',
          ].filter(Boolean).map(esc).join(' · ')}</span>
          <div class="adm-source-actions">
            <select class="adm-input adm-input--sm" data-role="days" aria-label="Accept for">
              ${ACCEPT_DAYS.map((d) => `<option value="${d}">${d} day${d === 1 ? '' : 's'}</option>`).join('')}
            </select>
            <button type="button" class="btn btn-secondary btn-sm" data-role="accept">${s.status === 'accepted' ? 'Extend' : 'Accept'}</button>
            ${s.status === 'pending' || s.status === 'expired' ? '<button type="button" class="btn btn-secondary btn-sm adm-btn-danger" data-role="reject">Reject</button>' : ''}
            ${s.status === 'accepted' ? '<button type="button" class="btn btn-secondary btn-sm adm-btn-danger" data-role="revoke">Revoke</button>' : ''}
          </div>
        </li>`).join('')}
    </ul>
  `;

  for (const row of box.querySelectorAll<HTMLElement>('.adm-source')) {
    const source = detail.sources[Number(row.dataset.index)];
    if (!source) continue;
    row.querySelector('[data-role="accept"]')?.addEventListener('click', () => {
      const days = Number(row.querySelector<HTMLSelectElement>('[data-role="days"]')!.value) as AcceptDays;
      void runAction(detail, async () => {
        const result = await acceptHovtpSource(detail.id, source.ip, days);
        return { kind: 'ok', text: `Accepted ${source.ip} for ${days} day${days === 1 ? '' : 's'}; ${result.attached} file${result.attached === 1 ? '' : 's'} attached.` };
      });
    });
    row.querySelector('[data-role="reject"]')?.addEventListener('click', () => {
      if (!window.confirm(`Reject ${source.ip}? Its quarantined files are deleted.`)) return;
      void runAction(detail, async () => {
        await rejectHovtpSource(detail.id, source.ip);
        return { kind: 'ok', text: `Rejected ${source.ip}.` };
      });
    });
    row.querySelector('[data-role="revoke"]')?.addEventListener('click', () => {
      if (!window.confirm(`Revoke ${source.ip}? Files already attached stay; new data from it is refused.`)) return;
      void runAction(detail, async () => {
        await revokeHovtpSource(detail.id, source.ip);
        return { kind: 'ok', text: `Revoked ${source.ip}.` };
      });
    });
  }
}

/* ════════════════════════════════════════════════════════════════
   Diagnostics
   ════════════════════════════════════════════════════════════════ */

function renderDiagnostics(root: HTMLElement): void {
  root.innerHTML = `
    <div class="adm-toolbar adm-toolbar--bare">
      <button type="button" id="adm-diag-refresh" class="btn btn-secondary btn-sm">Refresh</button>
      <button type="button" id="adm-sweep" class="btn btn-secondary btn-sm">Dry-run sweep now</button>
    </div>
    <div id="adm-sweep-result"></div>
    <div class="adm-grid">
      <section class="card adm-card"><h3>Router</h3><div id="adm-diag-router"></div></section>
      <section class="card adm-card"><h3>Platform</h3><div id="adm-diag-platform"></div></section>
    </div>
  `;
  root.querySelector('#adm-diag-refresh')!.addEventListener('click', () => void loadDiagnostics());
  root.querySelector('#adm-sweep')!.addEventListener('click', () => void runSweep());
  paintSweep();
  if (state.diagLoaded) paintDiagnostics();
  else void loadDiagnostics();
}

async function loadDiagnostics(): Promise<void> {
  state.diagLoaded = true;
  state.routerDiag = null;
  state.platformDiag = null;
  state.routerDiagError = '';
  state.platformDiagError = '';
  paintDiagnostics();
  await Promise.all([
    getRouterDiagnostics().then(
      (d) => { state.routerDiag = d; },
      (err) => { state.routerDiagError = errorText(err); }
    ),
    getPlatformDiagnostics().then(
      (d) => { state.platformDiag = d; },
      (err) => { state.platformDiagError = errorText(err); }
    ),
  ]);
  if (state.view.tab === 'diagnostics') paintDiagnostics();
}

async function runSweep(): Promise<void> {
  if (state.sweepBusy) return;
  state.sweepBusy = true;
  state.sweepError = '';
  paintSweep();
  try {
    state.sweep = await runDryRunSweep();
  } catch (err) {
    state.sweep = null;
    state.sweepError = errorText(err);
  }
  state.sweepBusy = false;
  if (state.view.tab !== 'diagnostics') return;
  paintSweep();
  void loadDiagnostics(); // the run shows up in the sweep history
}

function paintSweep(): void {
  const box = document.getElementById('adm-sweep-result');
  const button = document.getElementById('adm-sweep') as HTMLButtonElement | null;
  if (button) {
    button.disabled = state.sweepBusy;
    button.textContent = state.sweepBusy ? 'Running dry-run…' : 'Dry-run sweep now';
  }
  if (!box) return;
  if (state.sweepError) {
    box.innerHTML = errorBox(`Dry-run sweep failed: ${state.sweepError}`);
    return;
  }
  if (!state.sweep) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `
    <section class="card adm-card">
      <h3>Dry-run result</h3>
      <p class="adm-note">Nothing was purged. Missing deletion dates are still backfilled, as in every sweep.</p>
      <pre class="adm-pre" id="adm-sweep-json"></pre>
    </section>
  `;
  box.querySelector<HTMLElement>('#adm-sweep-json')!.textContent = jsonText(state.sweep);
}

const BACKEND_LABELS: Record<string, string> = {
  platform: 'Platform API',
  judgepapers: 'Judge Paper Creator',
  scoremodifier: 'Score Modifier',
  protocolgenerator: 'Protocol Generator',
  gdprtool: 'GDPR Removal Tool',
  hovtp: 'HOVTP listener',
};

function backendBadge(b: BackendHealth): string {
  switch (b.status) {
    case 'ok': return badge('ok', 'ok');
    case 'no_health_route': return badge('no health route', 'muted');
    case 'not_configured': return badge('not configured', 'warn');
    case 'timeout': return badge('timeout', 'error');
    default: return badge('error', 'error');
  }
}

function yesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return '<span class="adm-dim">unknown</span>';
  return value ? badge('yes', 'ok') : badge('no', 'muted');
}

function paintDiagnostics(): void {
  const routerBox = document.getElementById('adm-diag-router');
  const platformBox = document.getElementById('adm-diag-platform');
  if (routerBox) routerBox.innerHTML = routerDiagHtml();
  if (platformBox) {
    platformBox.innerHTML = platformDiagHtml();
    platformBox.querySelectorAll<HTMLElement>('[data-sweep-index]').forEach((pre) => {
      const run = state.platformDiag?.sweeps?.[Number(pre.dataset.sweepIndex)];
      pre.textContent = jsonText(run?.summary ?? {});
    });
  }
}

function routerDiagHtml(): string {
  if (state.routerDiagError) return errorBox(state.routerDiagError);
  const d = state.routerDiag;
  if (!d) return loadingBox();
  const r = d.router;
  const changelog = r.changelog?.entries?.length
    ? r.changelog.entries.map((e) => `${esc(e.branch)}: ${esc(formatDuration(e.ageSeconds))} old${e.stale ? ' (stale)' : ''}`).join('<br>')
    : '<span class="adm-dim">not cached yet</span>';
  const targets = Object.entries(d.config?.targets ?? {});
  return `
    <dl class="adm-facts">
      ${fact('Commit', r.commit ? `<span class="adm-mono">${esc(r.commit.slice(0, 12))}</span>` : '<span class="adm-dim">unknown (no build info)</span>')}
      ${fact('Started', esc(formatDateTimeFi(r.startedUtc)))}
      ${fact('Uptime', esc(formatDuration(r.uptimeSeconds)))}
      ${fact('Node', esc(r.node))}
      ${fact('NODE_ENV', r.nodeEnv ? esc(r.nodeEnv) : badge('not set', 'warn'))}
      ${fact('Login provider', esc(d.config?.loginProvider))}
      ${fact('Sign-in tenant', d.config?.authTenantMode === 'external' ? badge('External ID', 'info') : badge('workforce', 'muted'))}
      ${fact('External ID tenants', esc(d.config?.externalTenantCount ?? 0))}
      ${fact('Admins', esc(d.config?.adminCount))}
      ${fact('DEV_FAKE_USER', d.config?.devFakeUser ? badge('active', 'error') : badge('off', 'ok'))}
      ${fact('Changelog cache', changelog)}
    </dl>
    <h4>Configuration</h4>
    <div class="adm-table-wrap">
      <table class="adm-table adm-table--compact">
        <thead><tr><th>Backend</th><th>URL set</th><th>Secret set</th></tr></thead>
        <tbody>
          ${targets.map(([name, t]) => `<tr><td>${esc(BACKEND_LABELS[name] ?? name)}</td><td>${yesNo(t.url)}</td><td>${yesNo(t.secret)}</td></tr>`).join('')}
          ${d.config?.hovtpHealthUrl !== undefined ? `<tr><td>${esc(BACKEND_LABELS.hovtp)}</td><td>${yesNo(d.config.hovtpHealthUrl)}</td><td><span class="adm-dim">n/a</span></td></tr>` : ''}
        </tbody>
      </table>
    </div>
    <h4>Health</h4>
    <div class="adm-table-wrap">
      <table class="adm-table adm-table--compact">
        <thead><tr><th>Backend</th><th>Status</th><th>HTTP</th><th>Latency</th></tr></thead>
        <tbody>
          ${(d.backends ?? []).map((b) => `
            <tr>
              <td>${esc(BACKEND_LABELS[b.name] ?? b.name)}</td>
              <td>${backendBadge(b)}</td>
              <td>${esc(b.httpStatus ?? '—')}</td>
              <td class="adm-nowrap">${b.latencyMs === null ? '—' : `${esc(b.latencyMs)} ms`}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function platformDiagHtml(): string {
  if (state.platformDiagError) return errorBox(state.platformDiagError);
  const d = state.platformDiag;
  if (!d) return loadingBox();
  const cfg = d.config ?? ({} as PlatformDiagnostics['config']);
  const counts = d.counts ?? ({} as PlatformDiagnostics['counts']);
  const comps = counts.competitions ?? { active: 0, deleted: 0, purged: 0 };
  const sources = counts.hovtpSources ?? { pending: 0, accepted: 0, expired: 0, rejected: 0 };
  const sweeps = d.sweeps ?? [];
  return `
    <dl class="adm-facts">
      ${fact('Purge', cfg.retentionPurgeEnabled ? badge('enabled', 'ok') : badge('dry-run only', 'warn'))}
      ${fact('HOVTP listener', cfg.hovtpEnabled === null || cfg.hovtpEnabled === undefined ? '<span class="adm-dim">unknown</span>' : cfg.hovtpEnabled ? badge('enabled', 'ok') : badge('disabled', 'warn'))}
      ${fact('Retention', `${esc(cfg.retentionDays)} days · extend +${esc(cfg.extensionDays)} days`)}
      ${fact('Audit retention', `${esc(cfg.auditRetentionDays)} days`)}
      ${fact('Tables', `<span class="adm-mono">${esc(cfg.clockTable)}</span> · <span class="adm-mono">${esc(cfg.adminLogTable)}</span>`)}
      ${fact('Storage', d.storage?.ok ? badge('reachable', 'ok') : `${badge('unreachable', 'error')} ${esc(d.storage?.error ?? '')}`)}
      ${fact('Competitions', `${esc(comps.active)} active · ${esc(comps.deleted)} deleted · ${esc(comps.purged)} purged`)}
      ${fact('Due within 7 days', esc(counts.dueWithin7Days))}
      ${fact('Past deletion date', counts.pastDeletionDate ? badge(String(counts.pastDeletionDate), 'error') : '0')}
      ${fact('Clock drift', counts.clockDrift ? badge(String(counts.clockDrift), 'error') : '0')}
      ${fact('HOVTP sources', `${esc(sources.pending)} pending · ${esc(sources.accepted)} accepted · ${esc(sources.expired)} expired · ${esc(sources.rejected)} rejected`)}
      ${fact('HOVTP sessions', esc(counts.hovtpSessions))}
    </dl>
    <h4>Recent sweeps</h4>
    ${sweeps.length === 0 ? '<p class="adm-empty">No sweep runs recorded yet.</p>' : `
      <ul class="adm-list">
        ${sweeps.map((run, index) => `
          <li class="adm-list-row">
            <details>
              <summary>${esc(formatDateTimeFi(run.utc))} · ${run.dryRunManual ? 'manual dry-run' : run.purgeEnabled ? 'nightly' : 'nightly (dry-run)'}</summary>
              <pre class="adm-pre" data-sweep-index="${index}"></pre>
            </details>
          </li>`).join('')}
      </ul>`}
  `;
}

/* ════════════════════════════════════════════════════════════════
   Users
   ════════════════════════════════════════════════════════════════ */

function renderUsers(root: HTMLElement): void {
  root.innerHTML = `
    <section class="card adm-card">
      <div class="adm-toolbar">
        <label class="adm-field adm-field--grow">
          <span class="adm-sr">Search</span>
          <input id="adm-users-search" class="adm-input" type="search" placeholder="Search name or e-mail…" autocomplete="off">
        </label>
        <button type="button" id="adm-users-refresh" class="btn btn-secondary btn-sm">Refresh</button>
      </div>
      <p class="adm-note">Everyone who has signed in. Someone unseen for a year who owns no live competition is removed by the nightly sweep, together with their shares.</p>
      <div id="adm-users-body"></div>
    </section>
  `;
  const search = root.querySelector<HTMLInputElement>('#adm-users-search')!;
  search.value = state.usersSearch;
  search.addEventListener('input', () => {
    state.usersSearch = search.value;
    paintUsers();
  });
  root.querySelector('#adm-users-refresh')!.addEventListener('click', () => void loadUsers());
  if (state.users) paintUsers();
  else void loadUsers();
}

async function loadUsers(): Promise<void> {
  state.usersError = '';
  state.users = null;
  paintUsers();
  try {
    state.users = await listAdminUsers();
  } catch (err) {
    state.usersError = errorText(err);
  }
  if (state.view.tab === 'users') paintUsers();
}

function paintUsers(): void {
  const body = document.getElementById('adm-users-body');
  if (!body) return;
  if (state.usersError) {
    body.innerHTML = errorBox(state.usersError);
    return;
  }
  if (!state.users) {
    body.innerHTML = loadingBox('Loading users…');
    return;
  }
  const needle = state.usersSearch.trim().toLowerCase();
  const rows = state.users
    .filter((u) => !needle || `${u.name} ${u.email} ${u.userId}`.toLowerCase().includes(needle))
    .sort((a, b) => (b.lastSeenUtc ?? '').localeCompare(a.lastSeenUtc ?? ''));
  const count = rows.length === state.users.length
    ? `${rows.length} user${rows.length === 1 ? '' : 's'}`
    : `${rows.length} of ${state.users.length} users`;
  if (!rows.length) {
    body.innerHTML = `<p class="adm-count">${esc(count)}</p><p class="adm-empty">No users match.</p>`;
    return;
  }
  body.innerHTML = `
    <p class="adm-count">${esc(count)}</p>
    <div class="adm-table-wrap">
      <table class="adm-table adm-table--wide">
        <thead>
          <tr><th>Name</th><th>E-mail</th><th>First seen</th><th>Last seen</th>
              <th class="adm-num">Owns</th><th class="adm-num">Shared with</th><th class="adm-num">Identities</th></tr>
        </thead>
        <tbody>
          ${rows.map((u) => `
            <tr>
              <td>${esc(u.name || '—')}<span class="adm-mono adm-sub" title="Platform user id">${esc(u.userId)}</span></td>
              <td class="adm-break">${esc(u.email)}</td>
              <td class="adm-nowrap">${esc(formatDateTimeFi(u.firstSeenUtc))}</td>
              <td class="adm-nowrap">${esc(formatDateTimeFi(u.lastSeenUtc))}</td>
              <td class="adm-num">${esc(u.owned)}</td>
              <td class="adm-num">${esc(u.shared)}</td>
              <td class="adm-num">${esc(u.identities)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

/* ════════════════════════════════════════════════════════════════
   Audit log
   ════════════════════════════════════════════════════════════════ */

const AUDIT_PAGE = 50;

function renderAudit(root: HTMLElement): void {
  root.innerHTML = `
    <section class="card adm-card">
      <div class="adm-toolbar adm-toolbar--bare">
        <p class="adm-note adm-grow">Every admin action and every sharing change, newest first. Kept for a year.</p>
        <button type="button" id="adm-audit-refresh" class="btn btn-secondary btn-sm">Refresh</button>
      </div>
      <div id="adm-audit-body"></div>
    </section>
  `;
  root.querySelector('#adm-audit-refresh')!.addEventListener('click', () => void loadAudit(true));
  if (state.auditLoaded) paintAudit();
  else void loadAudit(true);
}

async function loadAudit(reset: boolean): Promise<void> {
  if (state.auditBusy) return;
  state.auditBusy = true;
  state.auditError = '';
  if (reset) {
    state.audit = [];
    state.auditNext = null;
    state.auditLoaded = false;
  }
  paintAudit();
  try {
    const page = await listAudit(reset ? null : state.auditNext, AUDIT_PAGE);
    state.audit = reset ? page.entries : [...state.audit, ...page.entries];
    state.auditNext = page.next;
    state.auditLoaded = true;
  } catch (err) {
    state.auditError = errorText(err);
  }
  state.auditBusy = false;
  if (state.view.tab === 'audit') paintAudit();
}

function changesHtml(changes: AuditEntry['changes']): string {
  const fields = Object.entries(changes);
  if (fields.length === 0) return '<span class="adm-dim">—</span>';
  return `<ul class="adm-changes">${fields.map(([field, [before, after]]) =>
    `<li><span class="adm-mono">${esc(field)}</span>: ${esc(changeValue(before))} → ${esc(changeValue(after))}</li>`
  ).join('')}</ul>`;
}

function paintAudit(): void {
  const body = document.getElementById('adm-audit-body');
  if (!body) return;
  if (!state.auditLoaded && state.auditError) {
    body.innerHTML = errorBox(state.auditError);
    return;
  }
  if (!state.auditLoaded) {
    body.innerHTML = loadingBox('Loading the audit log…');
    return;
  }
  if (state.audit.length === 0) {
    body.innerHTML = '<p class="adm-empty">Nothing recorded yet.</p>';
    return;
  }
  body.innerHTML = `
    <div class="adm-table-wrap">
      <table class="adm-table adm-table--wide">
        <thead><tr><th>When</th><th>By</th><th>Action</th><th>Competition</th><th>Target</th><th>Changes</th><th>Outcome</th></tr></thead>
        <tbody>
          ${state.audit.map((e) => `
            <tr>
              <td class="adm-nowrap">${esc(formatDateTimeFi(e.utc))}</td>
              <td class="adm-break">${esc(e.actor)}</td>
              <td class="adm-mono">${esc(e.action)}</td>
              <td>${e.competitionId
                ? `<a href="${attr(pathFor({ tab: 'competitions', id: e.competitionId }))}" class="adm-mono">${esc(e.competitionCode ?? e.competitionId)}</a>`
                : esc(e.competitionCode ?? '—')}</td>
              <td class="adm-break">${e.target ? esc(e.target) : '<span class="adm-dim">—</span>'}</td>
              <td>${changesHtml(e.changes)}</td>
              <td>${e.outcome === 'ok' ? badge('ok', 'ok') : badge(e.outcome || '—', 'warn')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${state.auditError ? errorBox(state.auditError) : ''}
    ${state.auditNext ? `<p class="adm-more"><button type="button" id="adm-audit-more" class="btn btn-secondary btn-sm" ${state.auditBusy ? 'disabled' : ''}>${state.auditBusy ? 'Loading…' : 'Load more'}</button></p>` : ''}
  `;
  body.querySelector('#adm-audit-more')?.addEventListener('click', () => void loadAudit(false));
}

init();
