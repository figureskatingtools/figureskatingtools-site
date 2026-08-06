import './style.css'
import { renderSiteNav, initSiteNav, injectSiteNavStyles, getEnvPrefix } from '@figureskatingtools/shared-ui'
import { escapeHtml, fetchUser, renderSignInView, setupUserMenu, type UserInfo } from './shell.js'

interface ChangelogEntry {
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
          <div class="card">
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

  // Load changelog
  loadChangelog();
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
    const raw = sessionStorage.getItem(CHANGELOG_CACHE_KEY);
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
    sessionStorage.setItem(CHANGELOG_CACHE_KEY, JSON.stringify({ ts: Date.now(), entries }));
  } catch (_e) {
    // sessionStorage disabled or quota exceeded — ignore
  }
}

async function loadChangelog() {
  const container = document.getElementById('changelog-entries');
  if (!container) return;

  let entries: ChangelogEntry[] | null = readChangelogCache();

  if (!entries) {
    try {
      entries = await fetchLiveChangelog();
      writeChangelogCache(entries);
    } catch (_e) {
      // Live fetch failed (offline, rate-limited, repo went private) —
      // fall back to the changelog.json generated at deploy time.
      try {
        const resp = await fetch('/changelog.json');
        if (!resp.ok) throw new Error('Not found');
        entries = (await resp.json() as ChangelogEntry[]).slice(0, CHANGELOG_DISPLAY_MAX);
      } catch (_e2) {
        container.innerHTML = '<p class="text-secondary">Changelog not available.</p>';
        return;
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
          <span class="changelog-date">${escapeHtml(entry.date)}</span>
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
