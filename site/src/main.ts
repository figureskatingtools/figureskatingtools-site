import './style.css'
import {
  renderSiteNav,
  initSiteNav,
  injectSiteNavStyles,
  getEnvPrefix,
  initCompetitionSelector,
  openCreateCompetitionDialog,
  listCompetitions,
  deleteCompetition,
  CompetitionApiError,
  refreshActiveCompetition,
  getActiveCompetition,
  setActiveCompetition,
  subscribeActiveCompetition,
  competitionLabel,
  formatDateFi,
  listCompetitionFiles,
  deleteCompetitionFile,
  competitionFileUrl,
  type PlatformCompetition,
  type PoolFile,
} from '@figureskatingtools/shared-ui'
import { escapeHtml, fetchUser, renderSignInView, setupUserMenu, type UserInfo } from './shell.js'

interface ChangelogEntry {
  /** Commit day, ISO `YYYY-MM-DD` — stored ISO (cache + changelog.json),
   *  formatted to `dd.MM.yyyy` only when rendered */
  date: string;
  title: string;
  description: string;
  tool: string;
  sha: string;
  author: string;
  /** Full ISO committer timestamp — internal sort key, never rendered */
  iso?: string;
}

interface ChangelogSource {
  repo: string;
  tool: string;
}

const appElement = document.querySelector<HTMLDivElement>('#app')!;

// Inject shared nav styles immediately
injectSiteNavStyles();

async function init() {
  // 1. Check auth via SWA's built-in endpoint
  const userInfo = await fetchUser();

  if (!userInfo) {
    renderSignInView(appElement);
  } else {
    renderAuthenticatedView(userInfo);
  }
}

function renderAuthenticatedView(userInfo: UserInfo) {
  appElement.innerHTML = `
    ${renderSiteNav({ activeApp: 'home', logoUrl: '/logo.png' })}

    <main class="auth-main">
      <div class="auth-layout">
        <div class="welcome-panel reveal reveal-1">
          <div class="card" id="competition-panel">
            <span class="micro-label">Competition</span>
            <p class="text-secondary">Loading competitions…</p>
          </div>
        </div>
        <div class="changelog-panel reveal reveal-2">
          <div class="card">
            <span class="micro-label">Changelog</span>
            <h2>What's New</h2>
            <div id="changelog-entries">
              <p class="text-secondary">Loading changelog...</p>
            </div>
          </div>
        </div>
      </div>
    </main>

    <footer class="site-footer">
      <p>&copy; ${new Date().getFullYear()} Figure Skating Tools</p>
    </footer>
  `;

  // Setup user menu
  const userSection = document.getElementById('fst-nav-right');
  if (userSection) {
    setupUserMenu(userSection, userInfo);
  }

  initSiteNav();

  // Competition selector in the nav + the competition-centric home panel
  const competitionSlot = document.getElementById('fst-nav-competition');
  if (competitionSlot) {
    void initCompetitionSelector(competitionSlot);
  }
  void loadCompetitionPanel();
  subscribeActiveCompetition(() => renderCompetitionPanel(knownCompetitions));

  // Load changelog
  loadChangelog();
}

/* ════════════════════════════════════════════════════════════════
   Competition panel
   ════════════════════════════════════════════════════════════════ */

/** Tools an active competition can be opened in, in nav order */
const COMPETITION_TOOLS = [
  { label: 'Judge Paper Creator', path: '/judgepapers/' },
  { label: 'Score Modifier', path: '/scoremodifier/' },
  { label: 'Protocol Generator', path: '/protocolgenerator/' },
  { label: 'Banner Generator', path: '/tools/banner/' },
];

/** How many competitions the "Recent" list shows */
const RECENT_COMPETITIONS = 5;

/**
 * The last competition list we managed to load.
 * `null` means the platform API is unavailable — the panel then falls back to
 * the plain welcome card so the site keeps working without the registry.
 */
let knownCompetitions: PlatformCompetition[] | null = null;

/** Last failed panel action, shown inline until the next one succeeds */
let panelError: string | null = null;

async function loadCompetitionPanel(): Promise<void> {
  // Drops a competition that has been deleted and picks up renames
  await refreshActiveCompetition();
  try {
    knownCompetitions = await listCompetitions();
  } catch (_e) {
    knownCompetitions = null;
  }
  renderCompetitionPanel(knownCompetitions);
}

function renderCompetitionPanel(competitions: PlatformCompetition[] | null): void {
  const container = document.getElementById('competition-panel');
  if (!container) return;

  if (competitions === null) {
    container.innerHTML = welcomeCardHtml();
    return;
  }

  const active = getActiveCompetition();
  const recent = competitions
    .filter((c) => !active || c.id !== active.id)
    .slice(0, RECENT_COMPETITIONS);

  container.innerHTML = `
    <span class="micro-label">Competition</span>
    ${active ? activeCompetitionHtml(active) : noCompetitionHtml()}
    <div class="comp-recent">
      <h3 class="comp-recent-title">Recent competitions</h3>
      ${recent.length > 0
        ? `<ul class="comp-recent-list">${recent.map((c) => `
            <li class="comp-recent-row">
              <button type="button" class="comp-recent-item" data-competition-id="${escapeHtml(c.id)}">
                <span class="comp-recent-name">${escapeHtml(competitionLabel(c))}</span>
                <span class="comp-recent-meta">${escapeHtml([c.code, formatDateFi(c.date), c.venue].filter(Boolean).join(' · '))}</span>
                ${createdLineHtml(c, 'comp-recent-created')}
              </button>
              <button type="button" class="comp-delete" data-delete-competition-id="${escapeHtml(c.id)}">×</button>
            </li>`).join('')}</ul>`
        : '<p class="text-secondary comp-recent-empty">Nothing else yet.</p>'}
    </div>
    ${panelError ? `<p class="comp-error" role="alert">${escapeHtml(panelError)}</p>` : ''}
    <div class="comp-actions">
      <button type="button" class="btn btn-secondary btn-sm" id="comp-create">New competition…</button>
      ${active
        ? `<button type="button" class="btn-link comp-delete-link" data-delete-competition-id="${escapeHtml(active.id)}">Delete this competition</button>`
        : ''}
    </div>
  `;

  container.querySelectorAll<HTMLButtonElement>('[data-competition-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-competition-id');
      const picked = competitions.find((c) => c.id === id) ?? null;
      panelError = null;
      setActiveCompetition(picked); // the subscription re-renders the panel
    });
  });

  // Deletion is a rare admin action: quiet control, confirm dialog, inline error
  container.querySelectorAll<HTMLButtonElement>('[data-delete-competition-id]').forEach((btn) => {
    const id = btn.getAttribute('data-delete-competition-id');
    const target = (active && active.id === id ? active : null)
      ?? competitions.find((c) => c.id === id)
      ?? null;
    if (!target) return;
    const label = competitionLabel(target);
    // Set as properties (not interpolated markup) — names may contain quotes
    btn.title = `Delete ${label}`;
    btn.setAttribute('aria-label', `Delete ${label}`);
    btn.addEventListener('click', () => {
      void handleDeleteCompetition(target, btn);
    });
  });

  document.getElementById('comp-create')?.addEventListener('click', () => {
    void openCreateCompetitionDialog().then((created) => {
      if (!created) return;
      panelError = null;
      knownCompetitions = [created, ...(knownCompetitions ?? [])];
      setActiveCompetition(created);
    });
  });

  if (active) void renderCompetitionFiles(active.id);
}

/* ── Competition files (the shared file pool) ───────────────────────────────
   Every tool uploads the competition's source files into one pool, so the home
   panel is where you see — and clean up — everything that belongs to the
   selected competition. FSM-pushed files are read-only, hence upload-only
   deletion. The whole section is optional: a pool API that is missing, failing
   or empty renders nothing at all. */

/** `1.4 MB` / `812 kB` / `— ` for an unknown size */
function formatFileSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

async function renderCompetitionFiles(competitionId: string): Promise<void> {
  const host = document.getElementById('comp-files');
  if (!host) return;

  let files: PoolFile[];
  try {
    files = await listCompetitionFiles(competitionId);
  } catch (_e) {
    host.innerHTML = '';
    return;
  }
  // The selection may have changed while the listing was in flight
  if (getActiveCompetition()?.id !== competitionId) return;
  if (!files.length) { host.innerHTML = ''; return; }

  host.innerHTML = `
    <h3 class="comp-recent-title">Competition files</h3>
    <ul class="comp-files-list">${files.map((f) => {
      const meta = [formatFileSize(f.size), f.sourceTool || f.source, formatDateFi(f.uploadedUtc)]
        .filter(Boolean).join(' · ');
      return `
        <li class="comp-file-row">
          <a class="comp-file-link" href="${escapeHtml(competitionFileUrl(competitionId, f.name, f.source))}"
             target="_blank" rel="noopener noreferrer">
            <span class="comp-file-name">${escapeHtml(f.name)}</span>
            <span class="comp-file-meta">${escapeHtml(meta)}</span>
          </a>
          ${f.source === 'upload'
            ? `<button type="button" class="comp-delete comp-file-delete" data-delete-file="${escapeHtml(f.name)}">×</button>`
            : ''}
        </li>`;
    }).join('')}</ul>
  `;

  host.querySelectorAll<HTMLButtonElement>('[data-delete-file]').forEach((btn) => {
    const name = btn.getAttribute('data-delete-file')!;
    btn.title = `Delete ${name}`;
    btn.setAttribute('aria-label', `Delete ${name}`);
    btn.addEventListener('click', async () => {
      if (!window.confirm(`Delete "${name}" from this competition's files?`)) return;
      btn.disabled = true;
      try {
        await deleteCompetitionFile(competitionId, name);
      } catch (err: unknown) {
        btn.disabled = false;
        panelError = err instanceof CompetitionApiError
          ? `Could not delete "${name}": ${err.message}`
          : `Could not delete "${name}". Please try again.`;
        renderCompetitionPanel(knownCompetitions);
        return;
      }
      await renderCompetitionFiles(competitionId);
    });
  });
}

/**
 * Remove a competition from the platform registry.
 *
 * The registry deletes softly and frees the code; each tool keeps its own
 * uploaded data until that tool's own auto-deletion window expires, which the
 * confirmation spells out.
 */
async function handleDeleteCompetition(
  competition: PlatformCompetition,
  trigger: HTMLButtonElement
): Promise<void> {
  const label = competitionLabel(competition);
  const confirmed = window.confirm(
    `Delete "${label}" (${competition.code}) from the competition registry?\n\n`
    + 'It disappears from every tool\'s competition selector and the code becomes '
    + 'free to use again. Files you already uploaded in a tool are not touched — '
    + 'each tool keeps them until its own automatic deletion removes them.'
  );
  if (!confirmed) return;

  panelError = null;
  trigger.disabled = true;

  try {
    await deleteCompetition(competition.id);
  } catch (err: unknown) {
    trigger.disabled = false;
    panelError = err instanceof CompetitionApiError
      ? `Could not delete "${label}": ${err.message}`
      : `Could not delete "${label}". Please try again.`;
    renderCompetitionPanel(knownCompetitions);
    return;
  }

  knownCompetitions = (knownCompetitions ?? []).filter((c) => c.id !== competition.id);

  const active = getActiveCompetition();
  if (active && active.id === competition.id) {
    setActiveCompetition(null); // the subscription re-renders the panel
    return;
  }
  renderCompetitionPanel(knownCompetitions);
}

/**
 * "Created <date> by <email>" line — the registry keeps every competition row
 * forever (deleted ones just flip status), so this doubles as the provenance
 * used later for statistical reporting.
 */
function createdLineHtml(c: PlatformCompetition, cls: string): string {
  if (!c.createdBy && !c.createdUtc) return '';
  const pretty = formatDateFi(c.createdUtc);
  const text = ['Created', pretty, c.createdBy ? `by ${c.createdBy}` : ''].filter(Boolean).join(' ');
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

function activeCompetitionHtml(active: PlatformCompetition): string {
  const meta = [formatDateFi(active.date), active.venue].filter(Boolean).join(' · ');
  return `
    <h2 class="comp-name">${escapeHtml(competitionLabel(active))}</h2>
    <p class="comp-code"><span class="comp-code-tag">${escapeHtml(active.code)}</span>${meta ? ` ${escapeHtml(meta)}` : ''}</p>
    ${createdLineHtml(active, 'comp-created')}
    <div class="comp-open">
      <span class="comp-open-label">Open in</span>
      <div class="comp-open-links">
        ${COMPETITION_TOOLS.map(
          (t) => `<a class="btn btn-secondary btn-sm" href="${t.path}">${t.label}</a>`
        ).join('')}
      </div>
    </div>
    <div class="comp-files" id="comp-files"></div>
  `;
}

function noCompetitionHtml(): string {
  return `
    <h2>No competition selected</h2>
    <p>
      Pick a competition from the selector in the navigation bar — every tool
      then prefills from it. You can always keep working without one.
    </p>
  `;
}

/** The pre-registry welcome card, still used when the platform API is absent */
function welcomeCardHtml(): string {
  return `
    <span class="micro-label">Welcome</span>
    <h2>Welcome to figureskatingtools.com</h2>
    <p>
      Please use the tools nicely and do not harm anyone.
    </p>
    <p>
      All bugs and feature requests should be reported to
      <a href="https://github.com/figureskatingtools" target="_blank" rel="noopener noreferrer">GitHub</a>.
    </p>
    <p>
      In case of inquiries, contact
      <a href="mailto:markus@lintuala.fi">markus@lintuala.fi</a>.
    </p>
  `;
}

const CHANGELOG_DISPLAY_INITIAL = 4;  // entries shown before "Show more"
const CHANGELOG_DISPLAY_MAX = 20;     // entries shown after "Show more"
const GH_PER_PAGE = 20;               // commits fetched per repo (>= CHANGELOG_DISPLAY_MAX)
const CHANGELOG_CACHE_KEY = 'changelog-cache-v1';
const CHANGELOG_CACHE_TTL_MS = 5 * 60 * 1000; // be gentle on GitHub's 60 req/hr unauthenticated limit

/** Branch whose commits feed "What's New": test env -> test, prod -> main, localhost -> test */
function changelogBranch(): string {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return 'test';
  return getEnvPrefix() === 'test.' ? 'test' : 'main';
}

/**
 * Preferred source: the router's cached, merged commit feed (same origin).
 * One GitHub round-trip per branch per 10 minutes for the whole site instead
 * of four per browser, so nobody burns the 60 req/hr unauthenticated limit.
 * Absent under `vite dev`, where there is no router — hence the fallbacks.
 */
async function fetchProxiedChangelog(): Promise<ChangelogEntry[]> {
  const resp = await fetch(`/changelog-live?branch=${encodeURIComponent(changelogBranch())}`);
  if (!resp.ok) throw new Error(`changelog-live ${resp.status}`);
  const entries = await resp.json();
  if (!Array.isArray(entries)) throw new Error('Unexpected changelog-live payload');
  return entries.slice(0, CHANGELOG_DISPLAY_MAX);
}

/** Fetch recent commits for one source repo from the public GitHub API */
async function fetchRepoCommits(source: ChangelogSource, branch: string): Promise<ChangelogEntry[]> {
  const url = `https://api.github.com/repos/${source.repo}/commits`
    + `?sha=${encodeURIComponent(branch)}&per_page=${GH_PER_PAGE}`;
  const resp = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!resp.ok) throw new Error(`GitHub ${resp.status} for ${source.repo}`);
  const commits = await resp.json();
  // Rate-limit responses are a JSON object {message, ...}, not an array
  if (!Array.isArray(commits)) throw new Error(`Unexpected GitHub payload for ${source.repo}`);
  return commits.map((c: any) => {
    const message: string = c?.commit?.message ?? '';
    const lines = message.split('\n');
    const iso: string = c?.commit?.committer?.date ?? c?.commit?.author?.date ?? '';
    return {
      sha: (c?.sha ?? '').substring(0, 7),
      date: iso.substring(0, 10),
      iso,
      title: lines[0] ?? '',
      description: lines.slice(1).join('\n').replace(/^\n+/, '').trim(),
      author: c?.commit?.author?.name ?? '',
      tool: source.tool,
    };
  });
}

/**
 * Fetch the newest commits live from all source repos and merge them.
 * All-or-nothing: if any repo fails we throw (and fall back to the
 * build-time changelog.json) rather than silently dropping a tool.
 */
async function fetchLiveChangelog(): Promise<ChangelogEntry[]> {
  const sourcesResp = await fetch('/changelog-sources.json');
  if (!sourcesResp.ok) throw new Error('changelog sources unavailable');
  const sources: ChangelogSource[] = await sourcesResp.json();
  const branch = changelogBranch();
  const perRepo = await Promise.all(sources.map(s => fetchRepoCommits(s, branch)));
  const merged = perRepo.flat();
  merged.sort((a, b) => {
    const byIso = (b.iso ?? '').localeCompare(a.iso ?? ''); // newest first
    if (byIso !== 0) return byIso;
    const byTool = a.tool.localeCompare(b.tool); // deterministic same-timestamp tiebreak
    return byTool !== 0 ? byTool : a.sha.localeCompare(b.sha);
  });
  return merged.slice(0, CHANGELOG_DISPLAY_MAX);
}

function readChangelogCache(): ChangelogEntry[] | null {
  try {
    const raw = localStorage.getItem(CHANGELOG_CACHE_KEY);
    if (!raw) return null;
    const { ts, entries } = JSON.parse(raw);
    if (typeof ts !== 'number' || !Array.isArray(entries)) return null;
    if (Date.now() - ts > CHANGELOG_CACHE_TTL_MS) return null;
    return entries;
  } catch (_e) {
    return null;
  }
}

function writeChangelogCache(entries: ChangelogEntry[]): void {
  try {
    localStorage.setItem(CHANGELOG_CACHE_KEY, JSON.stringify({ ts: Date.now(), entries }));
  } catch (_e) {
    // localStorage disabled or quota exceeded — ignore
  }
}

/**
 * Cache → router proxy → direct GitHub → build-time snapshot.
 * Each step is strictly staler than the one before it, so the panel degrades
 * instead of disappearing.
 */
async function loadChangelog() {
  const container = document.getElementById('changelog-entries');
  if (!container) return;

  let entries: ChangelogEntry[] | null = readChangelogCache();

  if (!entries) {
    try {
      entries = await fetchProxiedChangelog();
      writeChangelogCache(entries);
    } catch (_e) {
      try {
        // No router (vite dev) or it could not reach GitHub either.
        entries = await fetchLiveChangelog();
        writeChangelogCache(entries);
      } catch (_e2) {
        // Offline, rate-limited or a repo went private — fall back to the
        // changelog.json generated at deploy time.
        try {
          const resp = await fetch('/changelog.json');
          if (!resp.ok) throw new Error('Not found');
          entries = (await resp.json() as ChangelogEntry[]).slice(0, CHANGELOG_DISPLAY_MAX);
        } catch (_e3) {
          container.innerHTML = '<p class="text-secondary">Changelog not available.</p>';
          return;
        }
      }
    }
  }

  if (entries.length === 0) {
    container.innerHTML = '<p class="text-secondary">No changelog entries yet.</p>';
    return;
  }

  renderChangelog(container, entries, false);
}

function renderChangelog(container: HTMLElement, entries: ChangelogEntry[], showAll: boolean) {
  const visible = entries.slice(0, showAll ? CHANGELOG_DISPLAY_MAX : CHANGELOG_DISPLAY_INITIAL);

  container.innerHTML = visible.map((entry, i) => {
    const toolBadge = entry.tool
      ? `<span class="changelog-badge changelog-badge--${entry.tool.toLowerCase().replace(/\s+/g, '-')}">${escapeHtml(entry.tool)}</span>`
      : '';
    const hasLongDesc = entry.description && entry.description.length > 150;
    const shortDesc = hasLongDesc ? entry.description.substring(0, 150) + '...' : entry.description;

    return `
      <div class="changelog-entry">
        <div class="changelog-meta">
          <span class="changelog-date">${escapeHtml(formatDateFi(entry.date))}</span>
          ${toolBadge}
        </div>
        <h3 class="changelog-title">${escapeHtml(entry.title)}</h3>
        ${entry.description ? `
          <p class="changelog-desc" id="changelog-desc-${i}">${escapeHtml(shortDesc)}</p>
          ${hasLongDesc ? `
            <button class="btn-link changelog-toggle" data-index="${i}" data-expanded="false">Read more</button>
            <p class="changelog-desc-full hidden" id="changelog-full-${i}">${escapeHtml(entry.description)}</p>
          ` : ''}
        ` : ''}
      </div>
    `;
  }).join('') + (entries.length > CHANGELOG_DISPLAY_INITIAL
    ? `<button class="btn-link changelog-showmore">${showAll ? 'Show less' : 'Show more'}</button>`
    : '');

  // Toggle handlers
  container.querySelectorAll('.changelog-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = (btn as HTMLElement).dataset.index!;
      const expanded = (btn as HTMLElement).dataset.expanded === 'true';
      const shortEl = document.getElementById(`changelog-desc-${idx}`);
      const fullEl = document.getElementById(`changelog-full-${idx}`);
      if (shortEl && fullEl) {
        if (expanded) {
          shortEl.classList.remove('hidden');
          fullEl.classList.add('hidden');
          btn.textContent = 'Read more';
          (btn as HTMLElement).dataset.expanded = 'false';
        } else {
          shortEl.classList.add('hidden');
          fullEl.classList.remove('hidden');
          btn.textContent = 'Show less';
          (btn as HTMLElement).dataset.expanded = 'true';
        }
      }
    });
  });

  // Show more / Show less for the whole panel
  container.querySelector('.changelog-showmore')?.addEventListener('click', () => {
    renderChangelog(container, entries, !showAll);
  });
}

init();
