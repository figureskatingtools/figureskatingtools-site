import './style.css'
import {
    renderSiteNav,
    initSiteNav,
    injectSiteNavStyles,
    initCompetitionSelector,
    getActiveCompetition,
    subscribeActiveCompetition,
    competitionLabel,
    formatDateFi,
    listCompetitionFiles,
    uploadCompetitionFile,
    type CategoryInfo,
    type PoolFile,
} from '@figureskatingtools/shared-ui';
import {
    escapeHtml,
    fetchUser,
    loginUrl,
    setupUserMenu,
    type UserInfo,
} from '../shell.js';
import { validateCategory, validateCompetition } from './validate';
import { renderHelpTrigger, filesHelpHtml, initHelp } from './help';

// Inject the shared figureskatingtools.com nav styles once at startup
injectSiteNavStyles();

/** This app's own path — where Easy Auth returns the user after sign-in */
const APP_PATH = '/judgepapers/';

/**
 * Every judgepapers backend call goes through the router, which strips the
 * `/judgepapers` prefix and proxies to the tool's Function App (whose routes
 * keep the default `/api` prefix — no backend change).
 */
const API_BASE = '/judgepapers/api';

// `CategoryInfo` is the shared shape of one `categories` table row — the same
// type the filename recognizer in shared-ui consumes.

// Module-level categories cache, loaded once from the API
let categoriesCache: CategoryInfo[] = [];

// Language setting: 'fi' (Finnish, default) or 'en' (English)
let currentLanguage: 'fi' | 'en' = 'fi';

async function loadCategoriesCache() {
    try {
        const resp = await fetch(`${API_BASE}/get_categories`);
        if (resp.ok) {
            categoriesCache = await resp.json();
        }
    } catch (_e) {
        console.warn('Failed to load categories');
    }
}

/**
 * Get the localized category name from file data in the structure.
 * The structure keys are English displayName values. Files within contain
 * categoryFi for Finnish names.
 */
function getLocalizedCategoryName(categoryKey: string, segments: Record<string, any[]>): string {
    if (currentLanguage === 'fi') {
        // Try to find categoryFi from any file in this category
        for (const segFiles of Object.values(segments)) {
            for (const file of segFiles) {
                if (file.categoryFi) return file.categoryFi;
            }
        }
    }
    return categoryKey;
}

function isMupiCategory(categoryCode: string): boolean {
    const cat = categoriesCache.find(c => c.abbreviation === categoryCode);
    return cat?.judgingMethod === 'MUPI';
}

const appElement = document.querySelector<HTMLDivElement>('#app')!;

// Initial basic layout structure. The site nav (shared across all
// figureskatingtools.com apps) is rendered into #site-nav-container by init()
// once the auth state is known.
appElement.innerHTML = `
  <div id="site-nav-container"></div>

  <main>
    <div id="loading-view" class="loading-screen">
      <h2>Authenticating...</h2>
      <p>Please wait while we verify your credentials.</p>
    </div>

    <div id="error-view" class="error-screen hidden">
        <!-- Error content injected dynamically -->
    </div>

    <div id="landing-view" class="hidden">
      <div class="card landing-card reveal">
        <span class="micro-label">Judge Paper Creator</span>
        <h2>Create Judging Papers with Ease</h2>
        <p class="lead">
          This application provides an easy way to create judging papers for figure skating competitions.
          Simply upload the PDF exports from <strong>Figure Skating Manager</strong>, and we handle the rest.
        </p>
        <div class="landing-contact">
            <p>
                To access the application, please contact the administrator:
            </p>
             <a href="mailto:markus@lintuala.fi">markus@lintuala.fi</a>
        </div>
        <div style="margin-top: 2rem;">
            <a href="${loginUrl(APP_PATH)}" class="btn btn-primary">Sign In to Continue</a>
        </div>
      </div>
    </div>

    <div id="main-content" class="hidden">
      <!-- Modal Container -->
      <div id="modal-overlay" class="modal-overlay hidden">
        <div class="modal">
            <h3 id="modal-title">Confirm Action</h3>
            <p id="modal-message" class="modal-message">Are you sure?</p>

            <div id="modal-extra-content" style="margin-bottom: 1.5rem;">
                <!-- Dynamic Content like Checkbox -->
            </div>

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

      <div id="view-competition-details" class="hidden">
        <div class="card reveal">
             <div class="view-header">
                <div class="view-header-lead">
                    <h2 id="comp-detail-title">Competition Name</h2>
                </div>
                <div class="retention" id="retention"></div>
            </div>

            <div class="detail-grid">
                <!-- Info Box -->
                <div class="info-panel">
                    <h3 class="micro-label info-panel-title">Competition Details</h3>

                    <div class="info-field">
                        <span class="info-field-label">Name</span>
                        <div id="info-comp-name" class="info-field-value info-field-value--name">-</div>
                    </div>

                    <div class="info-field">
                        <span class="info-field-label">Type</span>
                        <div id="info-comp-type" class="info-field-value">-</div>
                    </div>

                    <div class="info-field">
                        <span class="info-field-label">Dates</span>
                        <div id="info-comp-dates" class="info-field-value">-</div>
                    </div>
                </div>

                <!-- Upload Area -->
                <div id="comp-upload-area" class="upload-area" style="flex: 1; margin: 0; display: flex; flex-direction: column; justify-content: center; align-items: center;">
                    <div class="upload-title-row">
                        <p class="upload-title">Drag & Drop PDF files here</p>
                        ${renderHelpTrigger('help-files', 'Which files do I need?', filesHelpHtml(), 'help-wrap--right')}
                    </div>
                    <p class="upload-or">or</p>
                    <button id="browse-files-btn" class="btn btn-sm btn-primary">Browse Files</button>
                    <input type="file" id="file-input" multiple accept=".pdf" style="display: none;">
                    <div id="upload-status" class="upload-status"></div>
                </div>
            </div>

            <!-- Files the competition already has in the shared pool (uploaded
                 in another tool) but this tool has not imported yet -->
            <div id="pool-import-container"></div>

            <div id="comp-files-container">
                <p class="text-muted">Loading files...</p>
            </div>

            <div id="action-container" class="action-container">
                 <div id="generated-files-list" class="generated-files-list">
                      <!-- Generated files injected here -->
                 </div>

                 <div id="right-panel" class="right-panel">
                      <div id="options-area" class="options-area">
                          <!-- Options injected here -->
                      </div>
                      <button id="btn-generate" class="btn btn-primary btn-generate" disabled>
                         Generate Papers
                      </button>
                 </div>
            </div>
        </div>
      </div>
    </div>
  </main>
`;

// Helper to switch views
function showView(viewId: string) {
    const views = ['view-pick-competition', 'view-competition-details'];
    views.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            if (id === viewId) el.classList.remove('hidden');
            else el.classList.add('hidden');
        }
    });
}

/* ════════════════════════════════════════════════════════════════
   Active competition (the site-wide selection from the nav)

   Judge Paper Creator has no competition list of its own any more: the
   competition selected in the nav is resolved into this tool's own record
   (`/resolve_competition` creates or adopts it on first use) and that record is
   the whole app.
   ════════════════════════════════════════════════════════════════ */

/** Platform competition GUID this tool is currently bound to */
let boundPlatformId: string | null = null;
/** Guards against an out-of-order resolve when the selection changes mid-flight */
let bindToken = 0;
/**
 * Set once the shared competition file pool proves unusable for the current
 * competition — the pool API is unreachable, the tool backend has no platform
 * storage configured (503) or this record is not bound (409). Uploads then take
 * the direct route exactly as they did before the pool existed.
 */
let poolDisabled = false;

/**
 * Upload one PDF.
 *
 * With a platform competition bound the bytes go to the shared competition file
 * pool first and are imported from there, so every tool sees the same file. Any
 * pool trouble falls back to this tool's own upload route — the file always
 * lands here, it is just not shared.
 */
async function uploadJudgePaperFile(file: File, competitionId: string): Promise<boolean> {
    if (boundPlatformId && !poolDisabled) {
        let poolName: string | null = null;
        try {
            poolName = (await uploadCompetitionFile(boundPlatformId, file, 'judgepapers')).name;
        } catch (_e) {
            poolDisabled = true;
        }
        if (poolName) {
            try {
                const resp = await fetch(
                    `${API_BASE}/import_platform_file?competition=${encodeURIComponent(competitionId)}`
                    + `&name=${encodeURIComponent(poolName)}`,
                    { method: 'POST' });
                if (resp.ok) return true;
                // 503 = pool not configured for this tool, 409 = record not bound:
                // the feature is simply off, so stop trying for this competition.
                if (resp.status === 503 || resp.status === 409) poolDisabled = true;
            } catch (_e) {
                // fall through to the direct upload
            }
        }
    }

    const url = `${API_BASE}/upload_file?competition=${encodeURIComponent(competitionId)}`
        + `&filename=${encodeURIComponent(file.name)}`;
    const resp = await fetch(url, { method: 'POST', body: file });
    return resp.ok;
}

/** Render one card into the "pick a competition" view */
function renderBindCard(html: string) {
    showView('view-pick-competition');
    const body = document.getElementById('bind-body');
    if (body) body.innerHTML = html;
}

/** Nothing selected — point at the nav selector, no error, no noise */
function showPickCompetition() {
    renderBindCard(`
        <span class="micro-label">Judge Paper Creator</span>
        <h2 style="margin-bottom: 0.75rem;">No competition selected</h2>
        <p class="bind-lead">Choose or create a competition from the selector in the top bar —
          every tool works on the same selected competition.</p>
        <h3 style="font-size: 1.05rem; margin-bottom: 0.5rem;">How to use:</h3>
        <ol class="howto-list">
            <li>Select the competition in the top bar; this tool opens its workspace automatically.</li>
            <li><strong>Upload the PDF exports</strong> from <em>Figure Skating Manager</em> ${renderHelpTrigger('help-files-welcome', 'Which files do I need?', filesHelpHtml())}<br><span class="howto-caution">Export <strong>PlannedProgramContent</strong>, not <strong>PlannedProgramContentChecklist</strong> &mdash; they look similar but the Checklist won't work.</span></li>
            <li>The system validates the files and ensures all required documents are present.</li>
            <li>Once validated, click <strong>Generate Papers</strong> to create the combined PDF booklets and ZIP archives.</li>
            <li>Download the generated files using the links that appear. You can also copy the links to share them.</li>
        </ol>
        <div class="card-footnote">
            <p>
                <strong>Feedback & Support:</strong><br>
                Please report any bugs or send feature requests to: <a href="mailto:markus@lintuala.fi">markus@lintuala.fi</a>
            </p>
        </div>`);
}

/** Resolve in flight */
function showBindLoading(name: string) {
    renderBindCard(`
        <span class="micro-label">Judge Paper Creator</span>
        <h2 style="margin-bottom: 0.75rem;">Opening ${escapeHtml(name)}…</h2>
        <p class="bind-lead"><span class="spinner spinner--ink"></span>Linking the selected competition to this tool.</p>`);
}

/** Resolve failed — readable message plus a retry */
function showBindError(message: string) {
    renderBindCard(`
        <span class="micro-label">Judge Paper Creator</span>
        <h2 style="margin-bottom: 0.75rem;">Could not open the competition</h2>
        <p class="bind-lead text-error">${escapeHtml(message)}</p>
        <button id="btn-bind-retry" class="btn btn-primary btn-sm">Retry</button>`);
    document.getElementById('btn-bind-retry')
        ?.addEventListener('click', () => void bindActiveCompetition(true));
}

/**
 * Opens a resolved competition in the detail view. Assigned by `init()` — the
 * detail-view machinery is scoped inside it, the binding flow is not.
 */
let openBoundCompetition: ((id: string, name: string) => Promise<void>) | null = null;

/**
 * Bind this tool to the active platform competition.
 *
 * No selection → the quiet "pick a competition" card. Same GUID as the current
 * binding → nothing to do (the subscription fires on every storage change).
 * Otherwise resolve the platform GUID into this tool's competition folder and
 * open it.
 */
async function bindActiveCompetition(force = false): Promise<void> {
    const active = getActiveCompetition();
    const token = ++bindToken;

    if (!active) {
        boundPlatformId = null;
        showPickCompetition();
        return;
    }

    if (!force && active.id === boundPlatformId) return;

    // Pool availability is per competition (a tool record may be unbound), so a
    // new selection starts from a clean slate.
    poolDisabled = false;

    const label = competitionLabel(active);
    showBindLoading(label);

    try {
        const resp = await fetch(`${API_BASE}/resolve_competition`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platformId: active.id, name: label }),
        });
        if (!resp.ok) {
            throw new Error((await resp.text()).trim() || `The tool API returned ${resp.status}.`);
        }
        const data = await resp.json();
        if (token !== bindToken) return;   // selection changed while we waited
        if (!data?.id) throw new Error('The tool API returned no competition id.');
        boundPlatformId = active.id;
        if (openBoundCompetition) await openBoundCompetition(data.id, data.name || label);
    } catch (e) {
        if (token !== bindToken) return;
        boundPlatformId = null;
        showBindError(e instanceof Error ? e.message : 'Network error.');
    }
}

/* ── retention ── */

/** `dd.MM.yyyy`, or the `-` sentinel this UI uses for "no usable date". */
function fmtDate(value: string | null | undefined): string {
    if (!value || value === '-') return '-';
    const pretty = formatDateFi(value);
    // formatDateFi hands unparsable input straight back — that means "no date" here
    return /^\d{2}\.\d{2}\.\d{4}$/.test(pretty) ? pretty : '-';
}

/**
 * Compact "Auto-deletes <date> [· Extend]" line in the competition header.
 *
 * Only rendered when the backend actually reports a deletion date on
 * `get_competition_details` (or returns a fresh one from the extend route) —
 * with no date available the line stays empty. The Extend button surfaces only
 * during the last 7 days before deletion; each press pushes the date a week
 * out (no cap), so it simply reappears when the new date draws near.
 */
const EXTEND_VISIBLE_MS = 7 * 24 * 3600 * 1000;

function renderRetention(competitionId: string | null, date?: string | null) {
    const el = document.getElementById('retention');
    if (!el) return;
    const pretty = date ? fmtDate(date) : '';
    if (!competitionId || !pretty || pretty === '-') { el.innerHTML = ''; return; }
    const due = date ? new Date(date).getTime() : NaN;
    const dueSoon = Number.isFinite(due) && due - Date.now() <= EXTEND_VISIBLE_MS;
    el.innerHTML = `<span class="retention-date">Auto-deletes ${escapeHtml(pretty)}</span>${dueSoon ? `
        <span class="retention-sep">·</span>
        <button class="btn btn-xs btn-ghost" id="btn-extend">Extend</button>` : ''}`;
    document.getElementById('btn-extend')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-extend') as HTMLButtonElement | null;
        if (btn) { btn.disabled = true; btn.textContent = 'Extending…'; }
        try {
            const resp = await fetch(
                `${API_BASE}/extend_competition_deletion?id=${encodeURIComponent(competitionId)}`,
                { method: 'POST' });
            if (!resp.ok) throw new Error(String(resp.status));
            const data = await resp.json();
            renderRetention(competitionId, data.deletionDate);
        } catch (_e) {
            if (btn) { btn.disabled = false; btn.textContent = 'Extend'; }
            alert('Failed to extend the deletion date.');
        }
    });
}

async function init() {
  // Question-mark popovers (the shell template is already in the DOM)
  initHelp();

  const loadingView = document.getElementById('loading-view')!;
  const errorView = document.getElementById('error-view')!;
  const landingView = document.getElementById('landing-view')!;
  const mainContent = document.getElementById('main-content')!;
  const navContainer = document.getElementById('site-nav-container')!;

  try {
    // 1. Get Auth Info — the router flattens the Easy Auth principal onto
    //    /userinfo; the shared shell owns that call for every app on the site.
    const user: UserInfo | null = await fetchUser();

    // 2. Render the shared site nav. There is no in-app dropdown any more —
    // the nav's competition selector is what switches workspaces.
    navContainer.innerHTML = renderSiteNav({
        activeApp: 'judgepapers',
        logoUrl: '/logo.png',
    });
    initSiteNav();
    const userSection = document.getElementById('fst-nav-right')!;

    if (!user) {
        // Not authenticated
        userSection.innerHTML = `<a href="${loginUrl(APP_PATH)}" class="btn btn-primary btn-sm">Sign In</a>`;
        loadingView.classList.add('hidden');
        landingView.classList.remove('hidden');
        return;
    }

    // 3. Setup User Menu (shared shell — sign-out goes through logoutUrl())
    setupUserMenu(userSection, user);

    // 4. Cross-tool competition selector, in its nav slot. Renders nothing
    //    when the platform competitions API is not available.
    const competitionSlot = document.getElementById('fst-nav-competition');
    if (competitionSlot) void initCompetitionSelector(competitionSlot);

    // 5. Auth Success - Show Content
    // Easy Auth on the router already gated us; reaching here means signed in.
    loadingView.classList.add('hidden');
    mainContent.classList.remove('hidden');

    // Load categories cache from API (table-driven config)
    await loadCategoriesCache();

    // Keep the tool bound to the nav's competition selector — including changes
    // made in another tab. The subscription never fires on subscribe itself, so
    // init() does the first bind explicitly.
    subscribeActiveCompetition(() => void bindActiveCompetition());

    // List Details Logic
    let currentCompetitionData: any = null;
    let isGlobalValid = false;

    function renderCompetitionView() {
        const container = document.getElementById('comp-files-container');
        if (!container || !currentCompetitionData) return;
        
        isGlobalValid = true; // Assume true, invalidate if any issue found
        
        const structure = currentCompetitionData.structure;
        const competitionFiles = currentCompetitionData.competitionFiles || [];

        if (Object.keys(structure).length === 0 && competitionFiles.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <p>No processed files found.</p>
                    <p class="empty-hint">Upload PDFs to get started.</p>
                </div>
            `;
            isGlobalValid = false;
            updateGenerateButton();
            return;
        }

        let html = '';
        const categories = Object.keys(structure).sort();

        // Check alerts
        if (currentCompetitionData.alerts && currentCompetitionData.alerts.length > 0) {
            isGlobalValid = false;
        }

        // Competition-level validation (e.g., CompetitionSchedule required)
        const compValidation = validateCompetition(competitionFiles);
        if (!compValidation.isValid) {
            isGlobalValid = false;
            html += `
                <div class="alert-missing">
                    <h5>Missing Competition Files:</h5>
                    <ul>
                        ${compValidation.missingFiles.map(f => `<li>${f}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        // Show competition-wide files (e.g. CompetitionSchedule) in their own section
        if (competitionFiles.length > 0) {
            html += `
                <div class="category-card">
                    <div class="category-header category-header--static is-valid">
                        <div class="category-head-lead">
                            <span class="status-mark">✓</span>
                            <span class="category-title">Competition Files</span>
                        </div>
                    </div>
                    <div class="category-content">
                        <div class="file-list">
                            ${competitionFiles.map((file: any) => `
                                <div class="file-row">
                                    <span title="${escapeHtml(file.suffix)}">${escapeHtml(file.filename)}</span>
                                    <button class="file-delete-btn delete-file-btn" data-filename="${escapeHtml(file.filename)}" title="Delete File">×</button>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
            `;
        }

        for (const category of categories) {
            const segments = structure[category];
            // System is always ISU for Figure Skating now.
            // 'Uncategorized' holds files with an unrecognized category prefix —
            // show them so the user can delete them, but don't demand the
            // standard file set or block Generate on them.
            const validation = category === 'Uncategorized'
                ? { isValid: true, missingFiles: [] as string[] }
                : validateCategory(segments);
            
            if (!validation.isValid) {
                isGlobalValid = false;
            }
            
            const validityClass = validation.isValid ? 'is-valid' : 'is-invalid';
            const statusIcon = validation.isValid ? '✓' : '⚠︎';
            const isCollapsed = validation.isValid;

            // Check for competition name conflict
            let catCompNameHtml = '';
            if (currentCompetitionData.alerts && currentCompetitionData.alerts.length > 0) {
                 let detectedName = '';
                 // Find comp name in any file of this category
                 for (const segment of Object.values(segments)) {
                     for (const file of (segment as any[])) {
                         if (file.competition_name) {
                             detectedName = file.competition_name;
                             break;
                         }
                     }
                     if (detectedName) break;
                 }
                 if (detectedName) {
                    catCompNameHtml = `<span class="category-conflict">Competition name: ${escapeHtml(detectedName)}</span>`;
                 }
            }
            
            const displayCategory = getLocalizedCategoryName(category, segments) || category || '(Unspecified Category)';
            
            // Check if this specific category should be tagged MUPI
            // Now driven by the categories table via the backend's judgingMethod field
            let isMupi = false;
            // Check from the file data if judgingMethod is available (enriched by backend)
            for (const segment of Object.values(segments)) {
                for (const file of (segment as any[])) {
                     if (file.judgingMethod === 'MUPI') {
                         isMupi = true;
                         break;
                     }
                }
                if (isMupi) break;
            }
            // Fallback: check via the categories cache using categoryCode
            if (!isMupi) {
                for (const segment of Object.values(segments)) {
                    for (const file of (segment as any[])) {
                        if (file.categoryCode && isMupiCategory(file.categoryCode)) {
                            isMupi = true;
                            break;
                        }
                    }
                    if (isMupi) break;
                }
            }

            html += `
                <div class="category-card">
                    <!-- Header -->
                    <div class="category-header ${validityClass}" data-category="${category}">
                        <div class="category-head-lead">
                             <span class="status-mark">${statusIcon}</span>
                             <span class="category-title">${escapeHtml(displayCategory)}</span>
                             ${isMupi ? '<span class="tag-mupi">MUPI</span>' : ''}
                             ${catCompNameHtml}
                        </div>
                        <div class="category-head-tail">
                            ${ validation.missingFiles.length > 0 ? `<span class="missing-count">${validation.missingFiles.length} missing</span>` : '' }
                            <span class="toggle-icon">${isCollapsed ? '▾' : '▴'}</span>
                        </div>
                    </div>

                    <!-- Content -->
                    <div class="category-content" id="content-${category.replace(/\s+/g, '-')}" style="display: ${isCollapsed ? 'none' : 'block'};">

                        <!-- Missing Files Warning -->
                        ${!validation.isValid ? `
                            <div class="alert-missing">
                                <h5>Missing Files:</h5>
                                <ul>
                                    ${validation.missingFiles.map(f => `<li>${f}</li>`).join('')}
                                </ul>
                            </div>
                        ` : ''}

                        <!-- Segments -->
            `;

            for (const [segment, files] of Object.entries(segments as any)) {
                html += `
                    <div class="segment-block">
                        <h4 class="segment-title">${segment}</h4>
                        <div class="file-list">
                `;

                (files as any[]).forEach((file: any) => {
                    html += `
                        <div class="file-row">
                            <span title="${escapeHtml(file.suffix)}">${escapeHtml(file.filename)}</span>
                            <button class="file-delete-btn delete-file-btn" data-filename="${escapeHtml(file.filename)}" title="Delete File">×</button>
                        </div>
                    `;
                });

                html += `</div></div>`;
            }
            
            html += `</div></div>`; // Close category-content and outer div
        }
        
        container.innerHTML = html;
        
        // Attach delete-file-btn event listeners (replaces inline onclick)
        document.querySelectorAll('.delete-file-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const filename = (e.currentTarget as HTMLElement).dataset.filename!;
                (window as any).promptDeleteFile(filename);
            });
        });

        // Header click logic
        document.querySelectorAll('.category-header').forEach(header => {
            header.addEventListener('click', (e) => {
                const cat = (e.currentTarget as HTMLElement).getAttribute('data-category');
                if (cat) {
                     const content = document.getElementById(`content-${cat.replace(/\s+/g, '-')}`);
                     if (content) {
                         const isHidden = content.style.display === 'none';
                         content.style.display = isHidden ? 'block' : 'none';
                         
                         // Update arrow
                         const arrow = (e.currentTarget as HTMLElement).querySelector('.toggle-icon');
                         if(arrow) arrow.textContent = isHidden ? '▴' : '▾';
                     }
                }
            });
        });
        
        updateGenerateButton();
    }

    function updateGenerateButton() {
        const btn = document.getElementById('btn-generate') as HTMLButtonElement;
        if (btn) {
            btn.disabled = !isGlobalValid;
        }
    }

    // Generate Handler
    document.getElementById('btn-generate')?.addEventListener('click', async () => {
        if (!currentCompetitionData || !isGlobalValid) return;
        
        const btn = document.getElementById('btn-generate') as HTMLButtonElement;
        const originalText = 'Generate Papers';
        
        // Start Loading
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>Generating...';

        // Collect Options
        // Toggle Logic Inversion:
        // UI Checkbox = "Use Time Schedule"
        // Backend 'segmentCover' = "Use Generated Cover Page"
        // So: Checked (Time Schedule) -> False (No Generated Cover)
        //     Unchecked (Cover Page)  -> True (Generated Cover)
        
        const globalToggle = document.getElementById('global-use-time-schedule') as HTMLInputElement;
        const segmentToggles = document.querySelectorAll('.time-schedule-toggle') as NodeListOf<HTMLInputElement>;
        
        const options: any = {
            globalSegmentCover: globalToggle ? !globalToggle.checked : false,
            segmentCovers: {},
            language: currentLanguage
        };
        
        if (segmentToggles) {
            segmentToggles.forEach(t => {
                const prefix = t.getAttribute('data-prefix');
                if (prefix) {
                    options.segmentCovers[prefix] = !t.checked;
                }
            });
        }
        
        try {
            const resp = await fetch(`${API_BASE}/generate_judging_papers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workingFolder: currentCompetitionData.id,
                    options: options
                })
            });

            if (resp.ok) {
                 // Success Animation
                 btn.innerHTML = 'Completed!';
                 btn.classList.add('btn-success');
                 
                 setTimeout(() => {
                     btn.innerHTML = originalText;
                     btn.classList.remove('btn-success');
                     btn.disabled = false;
                     loadCompetitionDetails(currentCompetitionData.id);
                 }, 3000);
            } else {
                const errText = await resp.text();
                openErrorModal('Generation Failed', `An error occurred while generating papers:<br><br>${errText}`);
                // Reset immediately on error
                btn.innerHTML = originalText;
                btn.disabled = false; 
            }
        } catch (_e) {
            openErrorModal('Generation Error', 'Network error or server unreachable.');
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });

    // Global handler
    (window as any).promptDeleteFile = (filename: string) => {
         if (!currentCompetitionData) return;
         openDeleteFileModal(filename, currentCompetitionData.id);
    };

    async function loadCompetitionDetails(id: string) {
        const container = document.getElementById('comp-files-container')!;
        container.innerHTML = '<p class="text-muted">Scanning files...</p>';

        try {
            const resp = await fetch(`${API_BASE}/get_competition_details?id=${encodeURIComponent(id)}`);
            if (!resp.ok) throw new Error('Failed to load details');
            
            const data = await resp.json();
            currentCompetitionData = data;

            // Retention line — only when the backend reports a deletion date
            renderRetention(id, data.deletionDate);

            // Update Info Box with extracted data
            if (data.fullName && data.fullName !== '-') {
                 document.getElementById('info-comp-name')!.textContent = data.fullName;
            } else {
                 document.getElementById('info-comp-name')!.textContent = data.name; // Fallback to folder name
            }

            // Process metadata
            document.getElementById('info-comp-type')!.textContent = data.type || '-';
            
            // ISO dates render Finnish; free-text ranges ("14.–15.2.2026") pass through
            document.getElementById('info-comp-dates')!.textContent = formatDateFi(data.date) || '-';
            
            const nameEl = document.getElementById('info-comp-name')!;

            // Check for alerts
            if (data.alerts && data.alerts.length > 0) {
                 const alertMsg = data.alerts.join('<br>');
                 openErrorModal('Configuration Error', alertMsg);

                 nameEl.textContent = 'Error! Multiple file names found! FIX THESE!';
                 nameEl.classList.add('info-field-value--alert');
            } else {
                 nameEl.classList.remove('info-field-value--alert');
            }
            
            // Set language from competition settings
            currentLanguage = data.language || 'fi';
            
            updateOptionsView(data);
            renderCompetitionView();

            // Render Generated Files
            const genContainer = document.getElementById('generated-files-list');
            if (genContainer) {
                 if (data.generatedFiles && data.generatedFiles.length > 0) {
                     genContainer.innerHTML = data.generatedFiles.map((f: any) => {
                         let dateDisplay = '';
                         try {
                             // Try to extract date from filename (YYYYMMDD)
                             const match = f.fileName.match(/(\d{4})(\d{2})(\d{2})/);
                             if (match) {
                                 const [_, y, m, d] = match;
                                 dateDisplay = `${d}.${m}.${y}`;
                             }
                         } catch (e) {}
                         
                         // Expiration
                         const expStr = fmtDate(f.expiration);
                         
                         // Size
                         let sizeStr = '';
                         if (f.size) {
                             const size = parseInt(f.size);
                             if (size > 1024 * 1024) {
                                  sizeStr = (size / (1024 * 1024)).toFixed(1) + ' MB';
                             } else {
                                  sizeStr = (size / 1024).toFixed(0) + ' KB';
                             }
                         }

                         const safeUrl = f.url;
                         const safeFileName = escapeHtml(f.fileName);
                         const safeDescription = escapeHtml(f.description);
                         const safeJudgePapersPath = escapeHtml('judgePapers/' + f.fileName);

                         return `
                            <div class="gen-file">
                                <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="gen-file-link">
                                    <div class="gen-file-head">
                                        <span class="gen-file-desc">
                                            ${safeDescription}
                                            ${dateDisplay ? `<span class="gen-file-date">${escapeHtml(dateDisplay)}</span>` : ''}
                                        </span>
                                        <div class="gen-file-badges">
                                            ${sizeStr ? `<span class="gen-badge">${escapeHtml(sizeStr)}</span>` : ''}
                                            <span class="gen-badge">Exp: ${escapeHtml(expStr)}</span>
                                        </div>
                                    </div>
                                    <div class="gen-file-name">
                                        ${safeFileName}
                                    </div>
                                </a>
                                <button class="icon-btn icon-btn--copy copy-link-btn" data-url="${safeUrl}" title="Copy Link to Clipboard">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                </button>
                                <button class="icon-btn icon-btn--danger delete-gen-file-btn" data-filename="${safeJudgePapersPath}" title="Delete File">
                                    ×
                                </button>
                            </div>
                         `;
                     }).join('');

                     // Attach copy-link event listeners
                     document.querySelectorAll('.copy-link-btn').forEach(btn => {
                         btn.addEventListener('click', (e) => {
                             e.stopPropagation();
                             const url = (e.currentTarget as HTMLElement).dataset.url!;
                             const el = e.currentTarget as HTMLElement;
                             navigator.clipboard.writeText(url).then(() => {
                                 const originalHTML = el.innerHTML;
                                 el.innerHTML = '✓';
                                 el.classList.add('is-copied');
                                 setTimeout(() => {
                                     el.innerHTML = originalHTML;
                                     el.classList.remove('is-copied');
                                 }, 2000);
                             }).catch(() => {});
                         });
                     });

                     // Attach delete-gen-file event listeners
                     document.querySelectorAll('.delete-gen-file-btn').forEach(btn => {
                         btn.addEventListener('click', () => {
                             const filename = (btn as HTMLElement).dataset.filename!;
                             (window as any).promptDeleteFile(filename);
                         });
                     });
                 } else {
                     genContainer.innerHTML = '';
                 }
            }

            // Shared-pool files this tool has not imported yet (renders nothing
            // when the pool is unavailable or everything is already here).
            void renderPoolImport(id);

        } catch (_e) {
            container.innerHTML = '<p class="text-error">Error loading files.</p>';
        }
    }

    function updateOptionsView(data: any) {
        const optionsArea = document.getElementById('options-area');
        if (!optionsArea) return;

        // Determine if Figure Skating
        // If Figure Skating, default "Use Time Schedule" to FALSE (i.e. use Cover Page)
        const isFigureSkating = (data.type && data.type.includes('Figure skating')) || false;
        const defaultUseTimeSchedule = !isFigureSkating;
        
        // Find all segments
        const segments: { prefix: string, label: string }[] = [];
        
        // structure: { category: { segment: [files] } }
        if (data.structure) {
            for (const cat in data.structure) {
                if (cat === 'Uncategorized') continue;

                // Lookup friendly name using localized category name from file data
                const friendlyCatName = getLocalizedCategoryName(cat, data.structure[cat]);

                for (const seg in data.structure[cat]) {
                    const files = data.structure[cat][seg];
                    const startList = files.find((f: any) => f.suffix.includes('StartListwithTimes'));
                    if (startList) {
                        // Extract prefix from filename
                        const prefix = startList.filename.replace('_StartListwithTimes.pdf', '');
                        segments.push({
                            prefix: prefix,
                            label: `${friendlyCatName} - ${seg}`
                        });
                    }
                }
            }
        }

        if (segments.length === 0) {
             optionsArea.innerHTML = '<p class="text-muted" style="font-size: 0.9rem; margin: 0;">No segments detected yet.</p>';
             return;
        }

        optionsArea.innerHTML = `
            <h3 class="options-title">Global Settings</h3>

            <div class="option-row">
                <label class="option-check">
                    <input type="checkbox" id="use-english-names" ${currentLanguage === 'en' ? 'checked' : ''}>
                    <span>Use English category names</span>
                </label>
            </div>

            <div class="option-row">
                <label class="option-check">
                    <input type="checkbox" id="global-use-time-schedule" ${defaultUseTimeSchedule ? 'checked' : ''}>
                    <span>Use Time Schedule as a Segment cover page</span>
                </label>
            </div>

            <div class="option-advanced">
                <button id="toggle-advanced-options" class="btn btn-ghost btn-xs" style="padding-left: 0;">Show Per-Segment Settings ▸</button>
                <div id="segment-options-list" class="segment-options-list hidden">
                    ${segments.map(s => `
                        <label class="segment-option">
                            <input type="checkbox" class="time-schedule-toggle" data-prefix="${s.prefix}" ${defaultUseTimeSchedule ? 'checked' : ''}>
                            <span>${s.label}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
        `;

        // Logic for Toggles
        const globalToggle = document.getElementById('global-use-time-schedule') as HTMLInputElement;
        const segmentToggles = document.querySelectorAll('.time-schedule-toggle') as NodeListOf<HTMLInputElement>;
        const listContainer = document.getElementById('segment-options-list')!;
        const toggleBtn = document.getElementById('toggle-advanced-options')!;

        // Language toggle
        const langToggle = document.getElementById('use-english-names') as HTMLInputElement;
        langToggle?.addEventListener('change', async () => {
            currentLanguage = langToggle.checked ? 'en' : 'fi';
            // Persist language to backend
            if (currentCompetitionData) {
                try {
                    await fetch(`${API_BASE}/save_competition_settings`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            id: currentCompetitionData.id,
                            settings: { language: currentLanguage }
                        })
                    });
                } catch (_e) {
                    console.warn('Failed to save language setting');
                }
            }
            // Re-render to reflect new language
            updateOptionsView(data);
            renderCompetitionView();
        });

        globalToggle.addEventListener('change', () => {
             const isChecked = globalToggle.checked;
             segmentToggles.forEach(t => t.checked = isChecked);
        });
        
        // Listen to individual toggles to update global
        segmentToggles.forEach(t => {
            t.addEventListener('change', () => {
                const allChecked = Array.from(segmentToggles).every(Toggle => Toggle.checked);
                if (!t.checked) {
                    globalToggle.checked = false;
                } else if (allChecked) {
                    globalToggle.checked = true;
                }
            });
        });
        
        toggleBtn.addEventListener('click', () => {
            const isHidden = listContainer.classList.contains('hidden');
            if (isHidden) {
                listContainer.classList.remove('hidden');
                toggleBtn.textContent = 'Hide Per-Segment Settings ▾';
            } else {
                listContainer.classList.add('hidden');
                toggleBtn.textContent = 'Show Per-Segment Settings ▸';
            }
        });
    }

    /** Every filename this competition already holds — competition-wide files
     *  plus every category/segment file. Used to hide pool files already here. */
    function existingFilenames(): Set<string> {
        const names = new Set<string>();
        if (!currentCompetitionData) return names;
        (currentCompetitionData.competitionFiles || []).forEach((f: any) => {
            if (f?.filename) names.add(f.filename);
        });
        Object.values(currentCompetitionData.structure || {}).forEach((segments: any) => {
            Object.values(segments || {}).forEach((segFiles: any) => {
                (segFiles as any[]).forEach(f => { if (f?.filename) names.add(f.filename); });
            });
        });
        return names;
    }

    /**
     * "Import from competition files" — the pool files this tool does not have
     * yet. Renders nothing at all when there is no pool, no binding or nothing
     * left to import, so the view is unchanged for standalone use.
     */
    async function renderPoolImport(competitionId: string) {
        const host = document.getElementById('pool-import-container');
        if (!host) return;
        host.innerHTML = '';
        if (!boundPlatformId || poolDisabled) return;

        let files: PoolFile[];
        try {
            files = await listCompetitionFiles(boundPlatformId);
        } catch (_e) {
            return;   // pool unavailable — degrade to no section
        }

        const have = existingFilenames();
        const pending = files.filter(f => f.name.toLowerCase().endsWith('.pdf') && !have.has(f.name));
        if (!pending.length) return;

        host.innerHTML = `
            <div class="pool-import">
                <div class="pool-import-head">
                    <span class="pool-import-title">Competition files</span>
                    <button id="btn-pool-import" class="btn btn-xs btn-primary">Import selected</button>
                </div>
                <p class="pool-import-sub">Uploaded for this competition in another tool — import them here to use them.</p>
                <div class="pool-file-list">
                    ${pending.map(f => `
                        <label class="pool-file">
                            <input type="checkbox" class="pool-file-check" value="${escapeHtml(f.name)}" checked>
                            <span class="pool-file-name">${escapeHtml(f.name)}</span>
                            ${f.sourceTool ? `<span class="pool-file-src">${escapeHtml(f.sourceTool)}</span>` : ''}
                        </label>`).join('')}
                </div>
            </div>`;

        document.getElementById('btn-pool-import')?.addEventListener('click', async () => {
            const btn = document.getElementById('btn-pool-import') as HTMLButtonElement;
            const chosen = Array.from(document.querySelectorAll<HTMLInputElement>('.pool-file-check'))
                .filter(c => c.checked).map(c => c.value);
            if (!chosen.length) return;
            btn.disabled = true;
            btn.textContent = 'Importing…';

            let failed = 0;
            for (const name of chosen) {
                try {
                    const resp = await fetch(
                        `${API_BASE}/import_platform_file?competition=${encodeURIComponent(competitionId)}`
                        + `&name=${encodeURIComponent(name)}`,
                        { method: 'POST' });
                    if (!resp.ok) {
                        failed++;
                        if (resp.status === 503 || resp.status === 409) { poolDisabled = true; break; }
                    }
                } catch (_e) {
                    failed++;
                }
            }

            const statusEl = document.getElementById('upload-status');
            if (statusEl) {
                statusEl.innerHTML = `<span style="color: var(--success-color);">Imported ${chosen.length - failed} file(s).</span>`
                    + (failed ? ` <span style="color: var(--error-color);">Failed: ${failed}</span>` : '');
            }
            await loadCompetitionDetails(competitionId);
        });
    }

    async function handleFiles(files: FileList, competitionId: string) {
        const statusEl = document.getElementById('upload-status')!;
        let successCount = 0;
        let errors: string[] = [];

        statusEl.innerHTML = `<span style="color: var(--text-secondary);">Uploading ${files.length} files...</span>`;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
                errors.push(`${file.name}: Not a PDF`);
                continue;
            }

            try {
                if (await uploadJudgePaperFile(file, competitionId)) {
                    successCount++;
                } else {
                    errors.push(`${file.name}: Upload failed`);
                }
            } catch (e) {
                errors.push(`${file.name}: Error`);
            }
        }
        
        let msg = `<span style="color: var(--success-color);">Uploaded ${successCount} files.</span>`;
        if (errors.length > 0) {
            msg += ` <span style="color: var(--error-color);">Errors: ${errors.length}</span>`;
        }
        statusEl.innerHTML = msg;
        
        if (successCount > 0) {
             loadCompetitionDetails(competitionId);
        }
    }

    async function openCompetition(id: string, name: string) {
        showView('view-competition-details');
        const titleEl = document.getElementById('comp-detail-title')!;

        titleEl.textContent = name;
        renderRetention(id, null);   // cleared until the details payload arrives

        // Update Info Box
        document.getElementById('info-comp-name')!.textContent = name;
        // Placeholder values for now
        document.getElementById('info-comp-type')!.textContent = '-'; 
        document.getElementById('info-comp-dates')!.textContent = '-';
        
        // Setup Upload Area
        const dropArea = document.getElementById('comp-upload-area')!;
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        const browseBtn = document.getElementById('browse-files-btn')!;
        const statusEl = document.getElementById('upload-status')!;

        // Reset status
        statusEl.innerHTML = '';
        statusEl.className = '';

        browseBtn.onclick = (e) => { e.preventDefault(); fileInput.click(); };
        
        fileInput.onchange = async (e) => {
            const files = (e.target as HTMLInputElement).files;
            if (files && files.length > 0) await handleFiles(files, id);
            fileInput.value = '';
        };
        
        dropArea.ondragover = (e) => { e.preventDefault(); dropArea.classList.add('dragover'); };
        dropArea.ondragleave = (e) => { e.preventDefault(); dropArea.classList.remove('dragover'); };
        dropArea.ondrop = (e) => {
            e.preventDefault();
            dropArea.classList.remove('dragover');
            if (e.dataTransfer && e.dataTransfer.files.length > 0) {
                handleFiles(e.dataTransfer.files, id);
            }
        };

        // Initialize Options Area if not present
        let optionsArea = document.getElementById('options-area');
        // No longer dynamically creating, as it is in the static template now
        if (optionsArea) optionsArea.innerHTML = ''; // Clear old on load

        loadCompetitionDetails(id);
    }

    // Hand the detail view to the module-level binding flow (the first bind runs
    // at the end of init(), once every listener below is attached).
    openBoundCompetition = openCompetition;

    // Modal Logic
    const modalOverlay = document.getElementById('modal-overlay')!;
    const modalTitle = document.getElementById('modal-title')!;
    const modalMessage = document.getElementById('modal-message')!;
    const modalExtra = document.getElementById('modal-extra-content')!;
    const modalCancel = document.getElementById('modal-cancel')!;
    const modalConfirm = document.getElementById('modal-confirm')!;

    // Only files are deletable from the app now — competitions come and go with
    // the platform registry and auto-delete on their retention date.
    type DeleteAction = { type: 'FILE', filename: string, competition: string };

    let pendingAction: DeleteAction | null = null;

    function openDeleteFileModal(filename: string, competition: string) {
        pendingAction = { type: 'FILE', filename, competition };
        modalTitle.textContent = `Delete File?`;
        modalMessage.innerHTML = `Are you sure you want to delete <strong>${escapeHtml(filename)}</strong>?`;
        modalExtra.innerHTML = ''; // No checkbox for single file

        modalConfirm.textContent = 'Delete';
        modalConfirm.classList.remove('btn-primary');
        modalConfirm.classList.add('btn-danger');
        (modalConfirm as HTMLButtonElement).disabled = false;

        modalOverlay.classList.remove('hidden');
    }

    function openErrorModal(title: string, message: string) {
        modalTitle.textContent = title;
        modalMessage.innerHTML = message;
        modalExtra.innerHTML = '';
        
        modalCancel.classList.add('hidden'); // Hide cancel
        modalConfirm.textContent = 'OK';
        modalConfirm.classList.remove('btn-danger', 'btn-primary'); 
        modalConfirm.classList.add('btn-primary');
        (modalConfirm as HTMLButtonElement).disabled = false;
        
        pendingAction = null; // No action to take on confirm
        
        modalOverlay.classList.remove('hidden');
    }

    modalCancel.addEventListener('click', () => {
        modalOverlay.classList.add('hidden');
        pendingAction = null;
    });

    modalConfirm.addEventListener('click', async () => {
        if (!pendingAction) {
            // Just close if no action (e.g. Alert mode)
            modalOverlay.classList.add('hidden');
            // Restore Cancel button capability
            modalCancel.classList.remove('hidden'); 
            return;
        }
        
        const btn = modalConfirm as HTMLButtonElement;
        const originalText = btn.textContent;
        btn.textContent = 'Deleting...';
        btn.disabled = true;

        try {
            const resp = await fetch(`${API_BASE}/delete_file?competition=${encodeURIComponent(pendingAction.competition)}&filename=${encodeURIComponent(pendingAction.filename)}`, {
                method: 'DELETE'
            });
            if (resp.ok) {
                modalOverlay.classList.add('hidden');
                if (currentCompetitionData) loadCompetitionDetails(currentCompetitionData.id);
            } else {
                alert('Failed to delete file.');
            }
        } catch (_error) {
            alert('Error deleting item');
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    });

    // Everything is wired — open whatever competition the nav has selected.
    await bindActiveCompetition();

  } catch (_err) {
      loadingView.classList.add('hidden');
      errorView.classList.remove('hidden');
      errorView.innerHTML = `<h2>Error</h2><p>Failed to initialize application.</p>`;
  }
}

// Start
init();
