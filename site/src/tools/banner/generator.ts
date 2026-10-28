/**
 * Competition Banner Generator — fully client-side SVG/raster generator for
 * Skating Finland competition banners (1200×120) plus an optional Sportity
 * 4:3 image (1600×1200).
 *
 * The SVG geometry is a verbatim port of the proven working draft; only the
 * plumbing around it (typed state, asset loading, DOM wiring) is new.
 *
 * The form is remembered per competition: with a competition selected, every
 * change is saved to it (`/api/competitions/{id}/settings/banner`) and loaded
 * again next time, by anyone it is shared with. A competition with nothing
 * saved yet starts from its own data (see `settings.ts`).
 */

import {
  CompetitionApiError,
  competitionLabel,
  getActiveCompetition,
  getToolSettings,
  isReadOnlyCompetition,
  saveToolSettings,
  subscribeActiveCompetition,
  type PlatformCompetition,
} from '@figureskatingtools/shared-ui';
import {
  MAX_REMEMBERED_LOGO_CHARS,
  MAX_TEXT,
  SIZE_RANGES,
  basePrefill,
  fallbackSettings,
  fullPrefill,
  toBannerSettings,
  type BannerSettings,
  type ClubChoice,
  type ClubEntry,
} from './settings.js';

/* ── Asset + tuning constants ── */
const RALEWAY_URL = '/tools/banner/assets/raleway.woff2';
const LOGO_URL = '/tools/banner/assets/skating-finland-logo.png';
const CLUBS_URL = '/tools/banner/logos/clubs.json';
const CLUB_LOGO_BASE = '/tools/banner/logos/';

const BANNER_W = 1200;
const BANNER_H = 120;
const SPORTITY_W = 1600;
const SPORTITY_H = 1200;

/** Grace period after `img.decode()` so the embedded webfont is really applied */
const RENDER_SETTLE_MS = 150;
/** Object URLs for downloads are revoked lazily so the browser can start the save */
const DOWNLOAD_REVOKE_MS = 5000;
/** Quiet time after the last change before it is saved to the competition */
const SAVE_DELAY_MS = 800;
/** A dropped raster logo too large to remember is scaled to fit this box */
const LOGO_MAX_PX = 800;
/** Browsers refuse `keepalive` bodies over 64 kB */
const KEEPALIVE_MAX_CHARS = 60_000;

/* ── State ── */
/** The Raleway variable font, as a data URI (embedded into every SVG) */
let raleway = '';
/** The Skating Finland logo, as a data URI */
let logo = '';
/** The selected club logo, as a data URI (null = no club logo) */
let clubLogo: string | null = null;
let clubW = 0;
let clubH = 0;
let assetsReady = false;

let previewUrl: string | null = null;
let sportityPreviewUrl: string | null = null;

/** The club logo manifest, sorted by name */
let clubs: ClubEntry[] = [];
/** Where the current club logo came from — what gets remembered */
let clubChoice: ClubChoice | null = null;
/** A club logo is being fetched or decoded — downloads wait for it */
let logoLoading = false;
/**
 * Bumped by every logo change: a logo fetch or image decode that finishes
 * after a newer change (another pick, or another competition's form) is dropped.
 */
let logoSeq = 0;

/* ── Small DOM helpers ── */
function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function input(id: string): HTMLInputElement {
  return el<HTMLInputElement>(id);
}

/** Escape the three characters that would break SVG text content */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape for interpolation into a double-quoted HTML attribute */
function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}

/* ════════════════════════════════════════════════════════════════
   Page markup
   ════════════════════════════════════════════════════════════════ */

/** The generator page (everything below the site nav) */
export function renderGeneratorPage(): string {
  const initial = basePrefill(getActiveCompetition());
  const { titleSize, dateVenueSize, categoriesSize } = SIZE_RANGES;
  return `
    <main class="auth-main banner-main">
      <header class="banner-header reveal reveal-1">
        <span class="micro-label">Tools</span>
        <h1>Competition Banner Generator</h1>
        <p class="banner-lead">
          Fill in the event details, add your club logo and download a ready-made
          competition banner — everything is generated right here in your browser.
        </p>
        <div class="banner-memory">
          <p class="banner-memory-status" id="memoryStatus" aria-live="polite"></p>
          <button type="button" class="btn btn-secondary btn-sm hidden" id="btnRefill">
            Fill in from competition
          </button>
        </div>
      </header>

      <div class="banner-sticky reveal reveal-2">
        <section class="card banner-preview-card">
          <span class="micro-label">Preview</span>
          <p class="banner-preview-status" id="previewStatus">Loading assets…</p>
          <div class="banner-previews hidden" id="previewWrap">
            <figure class="banner-preview banner-preview--wide">
              <img id="preview" alt="Competition banner preview">
              <figcaption>Banner · 1200 × 120</figcaption>
            </figure>
            <figure class="banner-preview banner-preview--sportity hidden" id="sportityPreviewWrap">
              <img id="sportityPreview" alt="Sportity image preview">
              <figcaption>Sportity · 1600 × 1200</figcaption>
            </figure>
          </div>
        </section>
      </div>

      <div class="banner-forms">
        <section class="card banner-card reveal reveal-3">
          <span class="micro-label">Banner content</span>
          <h2>Event details</h2>

          <div class="field">
            <label class="field-label" for="title">Title</label>
            <input type="text" id="title" class="field-input" maxlength="${MAX_TEXT}" value="${escAttr(initial.title)}">
            <div class="field-size">
              <span class="field-size-label">Size</span>
              <input type="range" id="titleSize" min="${titleSize.min}" max="${titleSize.max}" step="1" value="${initial.titleSize}">
              <output class="field-size-value" id="titleSizeOut">${initial.titleSize} px</output>
            </div>
          </div>

          <div class="field">
            <label class="field-label" for="dateVenue">Date &amp; venue</label>
            <input type="text" id="dateVenue" class="field-input" maxlength="${MAX_TEXT}" value="${escAttr(initial.dateVenue)}">
            <div class="field-size">
              <span class="field-size-label">Size</span>
              <input type="range" id="dateVenueSize" min="${dateVenueSize.min}" max="${dateVenueSize.max}" step="1" value="${initial.dateVenueSize}">
              <output class="field-size-value" id="dateVenueSizeOut">${initial.dateVenueSize} px</output>
            </div>
          </div>

          <div class="field">
            <label class="field-label" for="categories">Categories</label>
            <input type="text" id="categories" class="field-input" maxlength="${MAX_TEXT}" value="${escAttr(initial.categories)}">
            <div class="field-size">
              <span class="field-size-label">Size</span>
              <input type="range" id="categoriesSize" min="${categoriesSize.min}" max="${categoriesSize.max}" step="1" value="${initial.categoriesSize}">
              <output class="field-size-value" id="categoriesSizeOut">${initial.categoriesSize} px</output>
            </div>
          </div>
        </section>

        <section class="card banner-card reveal reveal-3">
          <span class="micro-label">Club logo</span>
          <h2>Organising club</h2>

          <label class="check-row">
            <input type="checkbox" id="clubBubble">
            <span>Add club logo bubble</span>
          </label>

          <div class="club-options hidden" id="clubOptions">
            <div class="field hidden" id="clubSelectWrap">
              <label class="field-label" for="clubSelect">Pick a club</label>
              <select id="clubSelect" class="field-input">
                <option value="">Select a club…</option>
              </select>
            </div>

            <div class="dropzone" id="dropZone" role="button" tabindex="0">
              <span class="dropzone-text">Drop your club logo here (or click) — JPG, PNG or SVG</span>
              <input type="file" id="fileInput" class="hidden" accept="image/jpeg,image/png,image/svg+xml">
            </div>

            <p class="field-note">
              Want your club permanently in the list? Email the logo file to
              <a href="mailto:markus@lintuala.fi">markus@lintuala.fi</a>.
            </p>
          </div>
        </section>

        <section class="card banner-card banner-card--wide reveal reveal-4">
          <span class="micro-label">Download</span>
          <h2>Get your banner</h2>

          <div class="download-primary">
            <button type="button" class="btn btn-primary" id="btnPng" disabled>
              Download PNG (1200 × 120)
            </button>
          </div>

          <div class="download-row">
            <span class="field-label">Other formats</span>
            <div class="download-buttons">
              <button type="button" class="btn btn-secondary btn-sm" id="btnSvg" disabled>SVG</button>
              <button type="button" class="btn btn-secondary btn-sm" id="btnJpeg" disabled>JPEG</button>
              <button type="button" class="btn btn-secondary btn-sm" id="btnBmp" disabled>BMP</button>
            </div>
          </div>

          <div class="download-extra">
            <label class="check-row">
              <input type="checkbox" id="sportityToggle">
              <span>Sportity image (4:3, 1600 × 1200) — for bigger competitions</span>
            </label>
            <div class="hidden" id="sportityActions">
              <button type="button" class="btn btn-secondary" id="btnSportity" disabled>
                Download Sportity JPG
              </button>
            </div>
          </div>
        </section>
      </div>
    </main>
  `;
}

/* ════════════════════════════════════════════════════════════════
   SVG builders — verbatim port of the working draft
   ════════════════════════════════════════════════════════════════ */

function buildSvg(): string {
  const clubBubble = input('clubBubble').checked;
  const cx = clubBubble ? 600 : 672;
  let bubble = clubBubble
    ? '<path d="M 1200 0 L 1035 0 C 975 24, 1035 44, 1000 72 C 970 98, 995 120, 1035 120 L 1200 120 Z" fill="#ffffff"/>'
    : '';
  const ts = +input('titleSize').value;
  const ds = +input('dateVenueSize').value;
  const cs = +input('categoriesSize').value;

  if (clubBubble && clubLogo) {
    const boxW = 100, boxH = 80;
    const s = Math.min(boxW / clubW, boxH / clubH);
    const w = clubW * s, h = clubH * s;
    const x = 1108 - w / 2, y = 60 - h / 2;
    bubble += '<image xlink:href="' + clubLogo + '" href="' + clubLogo + '" x="' + x.toFixed(1)
      + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '"/>';
  }

  return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="120" viewBox="0 0 1200 120">'
    + '<style>@font-face{font-family:&quot;Raleway&quot;;font-style:normal;font-weight:100 900;src:url(' + raleway + ') format(&quot;woff2&quot;)}text{font-feature-settings:&quot;lnum&quot; 1}</style>'
    + '<defs><linearGradient id="bg" x1="0" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#5561b3"/><stop offset="0.45" stop-color="#24338a"/><stop offset="1" stop-color="#231b52"/></linearGradient></defs>'
    + '<rect width="1200" height="150" fill="url(#bg)"/>'
    + '<path d="M 0 0 L 165 0 C 225 24, 165 44, 200 72 C 230 98, 205 120, 165 120 L 0 120 Z" fill="#ffffff"/>'
    + '<image xlink:href="' + logo + '" href="' + logo + '" x="25" y="21.5" width="107" height="77"/>'
    + bubble
    + '<text x="' + cx + '" y="' + (50 + (ts - 48) * 0.35) + '" text-anchor="middle" font-family="Raleway, Arial, sans-serif" font-weight="800" font-size="' + ts + '" letter-spacing="2" fill="#ffffff">' + esc(input('title').value) + '</text>'
    + '<text x="' + cx + '" y="78" text-anchor="middle" font-family="Raleway, Arial, sans-serif" font-weight="500" font-size="' + ds + '" letter-spacing="0.5" fill="#ffffff">' + esc(input('dateVenue').value) + '</text>'
    + '<text x="' + cx + '" y="101" text-anchor="middle" font-family="Raleway, Arial, sans-serif" font-weight="700" font-size="' + cs + '" letter-spacing="2.2" fill="#ffffff" fill-opacity="0.65">' + esc(input('categories').value) + '</text>'
    + '</svg>';
}

function buildSportitySvg(): string {
  const clubBubble = input('clubBubble').checked;
  const ts = +input('titleSize').value * 2;
  const ds = +input('dateVenueSize').value * 2;
  const cs = +input('categoriesSize').value * 2;
  const off = clubBubble ? -60 : 10;

  let club = '';
  if (clubBubble) {
    club = '<path d="M 610 1200 L 990 1200 L 990 990 Q 990 930 930 930 L 670 930 Q 610 930 610 990 Z" fill="#ffffff"/>';
    if (clubLogo) {
      const boxW = 280, boxH = 180;
      const s = Math.min(boxW / clubW, boxH / clubH);
      const w = clubW * s, h = clubH * s;
      club += '<image xlink:href="' + clubLogo + '" href="' + clubLogo + '" x="' + (800 - w / 2).toFixed(1)
        + '" y="' + (1065 - h / 2).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '"/>';
    }
  }

  return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1600" height="1200" viewBox="0 0 1600 1200">'
    + '<style>@font-face{font-family:&quot;Raleway&quot;;font-style:normal;font-weight:100 900;src:url(' + raleway + ') format(&quot;woff2&quot;)}text{font-feature-settings:&quot;lnum&quot; 1}</style>'
    + '<defs><linearGradient id="bg43" x1="0" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#5561b3"/><stop offset="0.45" stop-color="#24338a"/><stop offset="1" stop-color="#231b52"/></linearGradient></defs>'
    + '<rect width="1600" height="1200" fill="url(#bg43)"/>'
    + '<path d="M -200 900 C 300 500, 900 1300, 1800 700" fill="none" stroke="#ffffff" stroke-opacity="0.05" stroke-width="120"/>'
    + '<path d="M 590 0 L 1010 0 L 1010 470 Q 1010 530 950 530 L 650 530 Q 590 530 590 470 Z" fill="#ffffff"/>'
    + '<image xlink:href="' + logo + '" href="' + logo + '" x="650" y="145" width="300" height="215"/>'
    + club
    + '<text x="800" y="' + (700 + off + (ts - 96) * 0.35) + '" text-anchor="middle" font-family="Raleway, Arial, sans-serif" font-weight="800" font-size="' + ts + '" letter-spacing="3" fill="#ffffff">' + esc(input('title').value) + '</text>'
    + '<text x="800" y="' + (790 + off) + '" text-anchor="middle" font-family="Raleway, Arial, sans-serif" font-weight="500" font-size="' + ds + '" letter-spacing="1" fill="#ffffff">' + esc(input('dateVenue').value) + '</text>'
    + '<text x="800" y="' + (856 + off) + '" text-anchor="middle" font-family="Raleway, Arial, sans-serif" font-weight="700" font-size="' + cs + '" letter-spacing="4" fill="#ffffff" fill-opacity="0.65">' + esc(input('categories').value) + '</text>'
    + '</svg>';
}

/* ════════════════════════════════════════════════════════════════
   Preview
   ════════════════════════════════════════════════════════════════ */

function svgBlob(svg: string): Blob {
  return new Blob([svg], { type: 'image/svg+xml' });
}

function refresh(): void {
  if (!assetsReady) return;

  const nextPreview = URL.createObjectURL(svgBlob(buildSvg()));
  el<HTMLImageElement>('preview').src = nextPreview;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = nextPreview;

  const sportityOn = input('sportityToggle').checked;
  const wrap = el<HTMLElement>('sportityPreviewWrap');
  wrap.classList.toggle('hidden', !sportityOn);

  if (sportityOn) {
    const nextSportity = URL.createObjectURL(svgBlob(buildSportitySvg()));
    el<HTMLImageElement>('sportityPreview').src = nextSportity;
    if (sportityPreviewUrl) URL.revokeObjectURL(sportityPreviewUrl);
    sportityPreviewUrl = nextSportity;
  }
}

/* ════════════════════════════════════════════════════════════════
   Export
   ════════════════════════════════════════════════════════════════ */

/** Slugified base file name, derived from the banner title */
function fileName(): string {
  return input('title').value
    .toLowerCase()
    .replace(/[^a-z0-9äö]+/gi, '_')
    .replace(/^_|_$/g, '') + '_evt_header';
}

function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_MS);
}

/** Rasterize an SVG string onto a canvas of the given size */
async function renderCanvas(svg: string, width: number, height: number): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(svgBlob(svg));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // Let the embedded webfont settle before painting, otherwise the first
    // rasterization can fall back to Arial.
    await new Promise((resolve) => setTimeout(resolve, RENDER_SETTLE_MS));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, width, height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas export failed'))),
      type,
      quality
    );
  });
}

/** Hand-built 24 bpp BMP writer (canvas has no native BMP encoder) */
function canvasToBmp(canvas: HTMLCanvasElement): Blob {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(0, 0, w, h).data;

  const rowSize = w * 3 + ((4 - ((w * 3) % 4)) % 4);
  const size = 54 + rowSize * h;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint8(0, 0x42); // 'B'
  view.setUint8(1, 0x4d); // 'M'
  view.setUint32(2, size, true);
  view.setUint32(10, 54, true);   // pixel data offset
  view.setUint32(14, 40, true);   // DIB header size
  view.setInt32(18, w, true);
  view.setInt32(22, h, true);
  view.setUint16(26, 1, true);    // planes
  view.setUint16(28, 24, true);   // bits per pixel
  view.setUint32(34, rowSize * h, true);

  let p = 54;
  for (let y = h - 1; y >= 0; y--) { // BMP rows are stored bottom-up
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      bytes[p++] = data[i + 2]; // B
      bytes[p++] = data[i + 1]; // G
      bytes[p++] = data[i];     // R
    }
    p += rowSize - w * 3; // row padding
  }

  return new Blob([buffer], { type: 'image/bmp' });
}

async function downloadPng(): Promise<void> {
  const canvas = await renderCanvas(buildSvg(), BANNER_W, BANNER_H);
  save(await canvasToBlob(canvas, 'image/png'), `${fileName()}.png`);
}

async function downloadJpeg(): Promise<void> {
  const canvas = await renderCanvas(buildSvg(), BANNER_W, BANNER_H);
  save(await canvasToBlob(canvas, 'image/jpeg', 0.95), `${fileName()}.jpg`);
}

async function downloadBmp(): Promise<void> {
  const canvas = await renderCanvas(buildSvg(), BANNER_W, BANNER_H);
  save(canvasToBmp(canvas), `${fileName()}.bmp`);
}

function downloadSvg(): void {
  save(svgBlob(buildSvg()), `${fileName()}.svg`);
}

async function downloadSportity(): Promise<void> {
  const canvas = await renderCanvas(buildSportitySvg(), SPORTITY_W, SPORTITY_H);
  const name = fileName().replace('_evt_header', '') + '_sportity_4x3.jpg';
  save(await canvasToBlob(canvas, 'image/jpeg', 0.92), name);
}

/* ════════════════════════════════════════════════════════════════
   Assets & club logos
   ════════════════════════════════════════════════════════════════ */

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsDataURL(blob);
  });
}

async function fetchDataUri(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Could not load ${url} (${resp.status})`);
  return blobToDataUri(await resp.blob());
}

async function loadClubs(): Promise<ClubEntry[]> {
  try {
    const resp = await fetch(CLUBS_URL);
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!Array.isArray(data)) return [];
    return (data as ClubEntry[])
      .filter((c) => c && typeof c.name === 'string' && typeof c.file === 'string')
      .sort((a, b) => a.name.localeCompare(b.name, 'fi'));
  } catch (_e) {
    // Missing or malformed manifest — drag & drop still works
    return [];
  }
}

/** MIME type for a club logo file, derived from its extension */
function mimeForFile(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

/** Adopt a data URI as the club logo, measuring its intrinsic size first */
function setClubLogo(dataUri: string): void {
  const seq = ++logoSeq;
  setLogoLoading(true);
  const probe = new Image();
  probe.onload = () => {
    if (seq !== logoSeq) return;
    clubLogo = dataUri;
    // SVGs without intrinsic dimensions report 0 — fall back to the bubble ratio
    clubW = probe.naturalWidth || 100;
    clubH = probe.naturalHeight || 80;
    setLogoLoading(false);
    refresh();
  };
  probe.onerror = () => {
    if (seq !== logoSeq) return;
    setLogoLoading(false);
    setDropzoneText('That file could not be read — try a JPG, PNG or SVG.');
  };
  probe.src = dataUri;
}

function setDropzoneText(text: string): void {
  const label = document.querySelector<HTMLElement>('#dropZone .dropzone-text');
  if (label) label.textContent = text;
}

const DROPZONE_DEFAULT_TEXT = 'Drop your club logo here (or click) — JPG, PNG or SVG';
const ACCEPTED_LOGO_TYPES = ['image/jpeg', 'image/png', 'image/svg+xml'];

function setLogoLoading(loading: boolean): void {
  logoLoading = loading;
  updateDownloads();
}

function clearClubLogo(): void {
  logoSeq++;
  setLogoLoading(false);
  clubLogo = null;
  clubW = 0;
  clubH = 0;
  setDropzoneText(DROPZONE_DEFAULT_TEXT);
  refresh();
}

async function useClubFromManifest(file: string): Promise<void> {
  clubChoice = { file };
  const seq = ++logoSeq;
  setLogoLoading(true);
  try {
    const resp = await fetch(CLUB_LOGO_BASE + file);
    if (!resp.ok) throw new Error(`Could not load ${file}`);
    const typed = new Blob([await resp.blob()], { type: mimeForFile(file) });
    const dataUri = await blobToDataUri(typed);
    if (seq !== logoSeq) return;
    setClubLogo(dataUri);
    setDropzoneText(DROPZONE_DEFAULT_TEXT);
  } catch (_e) {
    if (seq !== logoSeq) return;
    clearClubLogo();
    setDropzoneText('That club logo could not be loaded — drop a file instead.');
  }
}

/**
 * Scale a raster logo down to fit LOGO_MAX_PX, so it can be remembered —
 * the banner never draws a club logo larger than 280 × 180.
 */
async function shrinkLogo(dataUri: string, type: string): Promise<string> {
  const img = new Image();
  img.src = dataUri;
  await img.decode();
  const scale = Math.min(1, LOGO_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return type === 'image/jpeg' ? canvas.toDataURL('image/jpeg', 0.92) : canvas.toDataURL('image/png');
}

async function useCustomFile(file: File): Promise<void> {
  if (!ACCEPTED_LOGO_TYPES.includes(file.type)) {
    setDropzoneText('Unsupported file type — please use JPG, PNG or SVG.');
    return;
  }
  // The file belongs to the competition shown when it was dropped, and it is
  // the newest logo choice only until another one is made
  const seq = loadSeq;
  const logo = ++logoSeq;
  let dataUri = await blobToDataUri(file);
  if (dataUri.length > MAX_REMEMBERED_LOGO_CHARS && file.type !== 'image/svg+xml') {
    try {
      dataUri = await shrinkLogo(dataUri, file.type);
    } catch (_e) {
      // Not decodable here — setClubLogo below reports the bad file
    }
  }
  if (seq !== loadSeq || logo !== logoSeq || !formEnabled) return;
  clubChoice = { name: file.name, dataUri };
  setClubLogo(dataUri);
  setDropzoneText(file.name);
  const select = el<HTMLSelectElement>('clubSelect');
  if (select) select.value = '';
  formChanged();
}

/* ════════════════════════════════════════════════════════════════
   Init
   ════════════════════════════════════════════════════════════════ */

const DOWNLOAD_BUTTON_IDS = ['btnPng', 'btnSvg', 'btnJpeg', 'btnBmp', 'btnSportity'];

/** Downloads only once the assets, the form and its club logo are all in place */
function updateDownloads(): void {
  setDownloadsEnabled(formEnabled && assetsReady && !logoLoading);
}

function setDownloadsEnabled(enabled: boolean): void {
  for (const id of DOWNLOAD_BUTTON_IDS) {
    const btn = el<HTMLButtonElement>(id);
    if (btn) btn.disabled = !enabled;
  }
}

/** Wire up a size slider to its px readout and the live preview */
function bindSizeSlider(sliderId: string, outputId: string): void {
  const slider = input(sliderId);
  const out = el<HTMLOutputElement>(outputId);
  slider.addEventListener('input', () => {
    out.textContent = `${slider.value} px`;
    formChanged();
  });
}

function bindClubLogoInputs(): void {
  const clubBubble = input('clubBubble');
  const clubOptions = el<HTMLElement>('clubOptions');

  clubBubble.addEventListener('change', () => {
    clubOptions.classList.toggle('hidden', !clubBubble.checked);
    formChanged();
  });

  const select = el<HTMLSelectElement>('clubSelect');
  select.addEventListener('change', () => {
    if (!select.value) {
      clubChoice = null;
      clearClubLogo();
    } else {
      void useClubFromManifest(select.value);
    }
    formChanged();
  });

  const dropZone = el<HTMLElement>('dropZone');
  const fileInput = input('fileInput');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === 'Enter' || key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void useCustomFile(file);
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dropzone--active');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dropzone--active');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dropzone--active');
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file && formEnabled) void useCustomFile(file);
  });
}

function bindDownloadButtons(): void {
  el<HTMLButtonElement>('btnPng').addEventListener('click', () => void downloadPng());
  el<HTMLButtonElement>('btnSvg').addEventListener('click', () => downloadSvg());
  el<HTMLButtonElement>('btnJpeg').addEventListener('click', () => void downloadJpeg());
  el<HTMLButtonElement>('btnBmp').addEventListener('click', () => void downloadBmp());
  el<HTMLButtonElement>('btnSportity').addEventListener('click', () => void downloadSportity());

  const sportityToggle = input('sportityToggle');
  const sportityActions = el<HTMLElement>('sportityActions');
  sportityToggle.addEventListener('change', () => {
    sportityActions.classList.toggle('hidden', !sportityToggle.checked);
    formChanged();
  });
}

/** Boot the generator: load assets, wire the form, load what the competition remembers */
export function initGenerator(): void {
  for (const id of ['title', 'dateVenue', 'categories']) {
    input(id).addEventListener('input', formChanged);
  }
  bindSizeSlider('titleSize', 'titleSizeOut');
  bindSizeSlider('dateVenueSize', 'dateVenueSizeOut');
  bindSizeSlider('categoriesSize', 'categoriesSizeOut');
  bindClubLogoInputs();
  bindDownloadButtons();
  bindMemory();

  void start();
}

async function start(): Promise<void> {
  // Nothing typed before the competition's values arrive could be kept
  setFormEnabled(false);
  await loadAssets();
  const active = getActiveCompetition();
  shownCompetitionId = active?.id ?? null;
  subscribeActiveCompetition(onActiveCompetition);
  await loadForCompetition(active);
}

async function loadAssets(): Promise<void> {
  const status = el<HTMLElement>('previewStatus');
  try {
    const [ralewayUri, logoUri, clubList] = await Promise.all([
      fetchDataUri(RALEWAY_URL),
      fetchDataUri(LOGO_URL),
      loadClubs(),
    ]);
    raleway = ralewayUri;
    logo = logoUri;
    clubs = clubList;

    if (clubs.length > 0) {
      const select = el<HTMLSelectElement>('clubSelect');
      select.innerHTML = '<option value="">Select a club…</option>'
        + clubs.map((c) => {
          const opt = document.createElement('option');
          opt.value = c.file;
          opt.textContent = c.name;
          return opt.outerHTML;
        }).join('');
      el<HTMLElement>('clubSelectWrap').classList.remove('hidden');
    }

    assetsReady = true;
    updateDownloads();
    status.classList.add('hidden');
    el<HTMLElement>('previewWrap').classList.remove('hidden');
    refresh();
  } catch (_e) {
    status.textContent = 'Banner assets could not be loaded. Please reload the page.';
    status.classList.add('banner-preview-status--error');
  }
}

/* ════════════════════════════════════════════════════════════════
   Form state ⇄ remembered settings
   ════════════════════════════════════════════════════════════════ */

const FORM_CONTROL_IDS = [
  'title', 'titleSize', 'dateVenue', 'dateVenueSize', 'categories', 'categoriesSize',
  'clubBubble', 'clubSelect', 'fileInput', 'sportityToggle', 'btnRefill',
];
let formEnabled = true;

/** Lock the form while a competition's values load, so no typing is overwritten */
function setFormEnabled(enabled: boolean): void {
  formEnabled = enabled;
  for (const id of FORM_CONTROL_IDS) {
    const control = el<HTMLInputElement>(id);
    if (control) control.disabled = !enabled;
  }
  el<HTMLElement>('dropZone').setAttribute('aria-disabled', String(!enabled));
  // A download while another competition loads would export the previous form
  updateDownloads();
}

/** The form as a settings object (a too-large dropped logo is not remembered) */
function readForm(): BannerSettings {
  const custom = clubChoice && 'dataUri' in clubChoice ? clubChoice : null;
  return {
    v: 1,
    title: input('title').value,
    titleSize: +input('titleSize').value,
    dateVenue: input('dateVenue').value,
    dateVenueSize: +input('dateVenueSize').value,
    categories: input('categories').value,
    categoriesSize: +input('categoriesSize').value,
    clubBubble: input('clubBubble').checked,
    club: custom && custom.dataUri.length > MAX_REMEMBERED_LOGO_CHARS ? null : clubChoice,
    sportity: input('sportityToggle').checked,
  };
}

function logoTooLargeToRemember(): boolean {
  return !!clubChoice && 'dataUri' in clubChoice && clubChoice.dataUri.length > MAX_REMEMBERED_LOGO_CHARS;
}

/** Put a settings object into the form and redraw */
function applyForm(settings: BannerSettings): void {
  input('title').value = settings.title;
  input('dateVenue').value = settings.dateVenue;
  input('categories').value = settings.categories;
  for (const id of ['titleSize', 'dateVenueSize', 'categoriesSize'] as const) {
    input(id).value = String(settings[id]);
    el<HTMLOutputElement>(`${id}Out`).textContent = `${settings[id]} px`;
  }
  input('clubBubble').checked = settings.clubBubble;
  el<HTMLElement>('clubOptions').classList.toggle('hidden', !settings.clubBubble);
  input('sportityToggle').checked = settings.sportity;
  el<HTMLElement>('sportityActions').classList.toggle('hidden', !settings.sportity);

  // The previous form's decoded logo goes first: whatever this one's logo
  // turns out to be, it is never shown in its place
  clubLogo = null;
  clubW = 0;
  clubH = 0;

  const select = el<HTMLSelectElement>('clubSelect');
  const club = settings.club;
  if (club && 'file' in club && clubs.some((c) => c.file === club.file)) {
    select.value = club.file;
    void useClubFromManifest(club.file);
  } else if (club && 'dataUri' in club) {
    select.value = '';
    clubChoice = club;
    setClubLogo(club.dataUri);
    setDropzoneText(club.name);
  } else {
    select.value = '';
    clubChoice = null;
    clearClubLogo();
  }
  refresh();
}

/* ════════════════════════════════════════════════════════════════
   Competition memory — load on select, save on change
   ════════════════════════════════════════════════════════════════ */

/** Where changes go: the competition shown, and whether saving is possible */
interface MemoryTarget {
  competition: PlatformCompetition;
  writable: boolean;
  /** The saved values could not be read — saving would overwrite them blind */
  loadFailed: boolean;
}

let target: MemoryTarget | null = null;
let shownCompetitionId: string | null = null;
let loadSeq = 0;
let saveTimer: number | null = null;
let lastSave: Promise<void> = Promise.resolve();
/** Saves started but not yet sent (queued behind an earlier one) */
let undispatched = 0;
/** Saves started and not yet answered */
let unsettled = 0;

function setMemoryStatus(text: string, isError = false): void {
  const status = el<HTMLElement>('memoryStatus');
  status.textContent = text;
  status.classList.toggle('banner-memory-status--error', isError);
}

function quoted(competition: PlatformCompetition): string {
  return `“${competitionLabel(competition)}”`;
}

function showRefill(visible: boolean): void {
  el<HTMLElement>('btnRefill').classList.toggle('hidden', !visible);
}

function savedStatus(t: MemoryTarget): string {
  const note = logoTooLargeToRemember()
    ? ' The club logo is too large to remember — use a smaller file.'
    : '';
  return `Saved to ${quoted(t.competition)}.${note}`;
}

/** Every user change: redraw, then save to the competition shortly after */
function formChanged(): void {
  refresh();
  if (!target?.writable) return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  setMemoryStatus('Saving…');
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void saveNow();
  }, SAVE_DELAY_MS);
}

/**
 * Save a pending change now. Switching competitions queues it like any save;
 * leaving the page sends it at once instead, because a save queued behind
 * one still on its way would only go out after the page is gone.
 */
function flushSave(leaving = false): void {
  const waiting = saveTimer !== null || (leaving && undispatched > 0);
  if (!waiting) return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  if (!leaving) {
    void saveNow();
    return;
  }
  const earlier = unsettled > 0 ? lastSave : null;
  void saveNow(true);
  if (earlier) {
    // A hidden tab may live on: once every earlier save has landed, send the
    // newest values again, so an older save finishing last cannot win
    lastSave = Promise.all([earlier, lastSave]).then(() => undefined);
    void saveNow();
  }
}

/**
 * Save the form to the current target. Saves run one after another, and each
 * reads the form when it is sent, never when it was queued — so a queued
 * save can only repeat the newest values, not bring back older ones.
 * `immediate` skips the queue (the page is closing).
 */
function saveNow(immediate = false): Promise<void> {
  const t = target;
  if (!t?.writable) return Promise.resolve();
  const previous = immediate ? Promise.resolve() : lastSave;
  undispatched++;
  unsettled++;
  lastSave = (async () => {
    await previous;
    undispatched--;
    const settings = readForm();
    // Browsers cap `keepalive` bodies at 64 kB: a save with a big logo cannot outlive the page
    const keepalive = JSON.stringify(settings).length < KEEPALIVE_MAX_CHARS;
    try {
      await saveToolSettings(t.competition.id, 'banner', { ...settings }, { keepalive });
      if (target === t && saveTimer === null) setMemoryStatus(savedStatus(t));
    } catch (e) {
      if (target === t) onSaveError(t, e);
    } finally {
      unsettled--;
    }
  })();
  return lastSave;
}

function onSaveError(t: MemoryTarget, error: unknown): void {
  const code = error instanceof CompetitionApiError ? error.code : '';
  if (code === 'read_only') {
    t.writable = false;
    showRefill(false);
    setMemoryStatus(`You have view-only access to ${quoted(t.competition)}, so your changes aren't saved.`);
  } else if (code === 'not_found' || code === 'competition_deleted') {
    t.writable = false;
    showRefill(false);
    setMemoryStatus(`${quoted(t.competition)} no longer exists or isn't shared with you, so changes aren't saved.`, true);
  } else if (code === 'settings_too_large') {
    setMemoryStatus('The club logo is too large to save — use a smaller file.', true);
  } else {
    setMemoryStatus("Your changes couldn't be saved. They will be saved with your next change.", true);
  }
}

/** Show what a competition remembers — or what its own data says, the first time */
async function loadForCompetition(competition: PlatformCompetition | null): Promise<void> {
  flushSave();
  const seq = ++loadSeq;
  target = null;
  showRefill(false);

  if (!competition) {
    applyForm(fallbackSettings());
    setFormEnabled(true);
    setMemoryStatus('Select a competition in the top bar and these values are remembered for it.');
    return;
  }

  setFormEnabled(false);
  setMemoryStatus(`Loading the values saved for ${quoted(competition)}…`);

  // A save still on its way (A → B → A) must land before A is read back
  await lastSave;
  if (seq !== loadSeq) return;

  let saved: BannerSettings | null = null;
  let loadFailed = false;
  try {
    saved = toBannerSettings((await getToolSettings(competition.id, 'banner')).settings);
  } catch (_e) {
    loadFailed = true;
  }
  if (seq !== loadSeq) return;
  const settings = saved ?? (await fullPrefill(competition, clubs));
  if (seq !== loadSeq) return;

  applyForm(settings);
  setFormEnabled(true);
  const readOnly = isReadOnlyCompetition(competition);
  target = { competition, writable: !readOnly && !loadFailed, loadFailed };
  showRefill(target.writable);

  const name = quoted(competition);
  if (loadFailed) {
    setMemoryStatus(`The values saved for ${name} couldn't be loaded, so changes aren't saved. Reload the page to try again.`, true);
  } else if (readOnly) {
    setMemoryStatus(`${saved ? `Showing the values saved for ${name}` : `Filled in from ${name}`}. You have view-only access, so your changes aren't saved.`);
  } else if (saved) {
    setMemoryStatus(`Showing the values saved for ${name}. Changes are saved automatically.`);
  } else {
    setMemoryStatus(`Filled in from ${name}. Changes are saved to it automatically.`);
  }
}

/** The nav selector (or another tab) switched competitions — or renamed this one */
function onActiveCompetition(next: PlatformCompetition | null): void {
  const nextId = next?.id ?? null;
  if (nextId !== shownCompetitionId) {
    shownCompetitionId = nextId;
    void loadForCompetition(next);
    return;
  }
  if (!target || !next) return;
  // Same competition: keep the form, follow a new name or a changed role
  target.competition = next;
  target.writable = !isReadOnlyCompetition(next) && !target.loadFailed;
  showRefill(target.writable);
}

function bindMemory(): void {
  el<HTMLButtonElement>('btnRefill').addEventListener('click', () => void refillFromCompetition());
  // A change still waiting for its save goes out as the page closes
  window.addEventListener('pagehide', () => flushSave(true));
  document.addEventListener('visibilitychange', () => {
    // A hidden tab may be discarded without a pagehide (mobile)
    if (document.visibilityState === 'hidden') flushSave(true);
  });
}

/** Replace the form with what the competition's data says, then save that */
async function refillFromCompetition(): Promise<void> {
  const t = target;
  if (!t?.writable) return;
  if (!window.confirm(`Replace the banner's text and club logo with the details of ${quoted(t.competition)}?`)) return;
  setFormEnabled(false);
  const settings = await fullPrefill(t.competition, clubs);
  // Another competition's load now owns the form lock
  if (target !== t) return;
  setFormEnabled(true);
  applyForm(settings);
  formChanged();
}
