/**
 * Competition Banner Generator — fully client-side SVG/raster generator for
 * Skating Finland competition banners (1200×120) plus an optional Sportity
 * 4:3 image (1600×1200).
 *
 * The SVG geometry is a verbatim port of the proven working draft; only the
 * plumbing around it (typed state, asset loading, DOM wiring) is new.
 */

import { getActiveCompetition } from '@figureskatingtools/shared-ui';

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

/** One entry of the club logo manifest */
interface ClubEntry {
  name: string;
  file: string;
}

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

/* ── Defaults, prefilled from the active competition when there is one ── */

const FALLBACK_TITLE = 'WINTER CUP 2026';
const FALLBACK_DATE_VENUE = '14.–15.2.2026  |  Ice Arena, Helsinki';

/** Banner title default — the active competition's name, shouted */
function defaultTitle(): string {
  const active = getActiveCompetition();
  const name = active?.name.trim();
  return name ? name.toUpperCase() : FALLBACK_TITLE;
}

/** Date & venue default — `date  |  venue` from the active competition */
function defaultDateVenue(): string {
  const active = getActiveCompetition();
  if (!active) return FALLBACK_DATE_VENUE;
  const parts = [active.date.trim(), active.venue.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join('  |  ') : FALLBACK_DATE_VENUE;
}

/* ════════════════════════════════════════════════════════════════
   Page markup
   ════════════════════════════════════════════════════════════════ */

/** The generator page (everything below the site nav) */
export function renderGeneratorPage(): string {
  return `
    <main class="auth-main banner-main">
      <header class="banner-header reveal reveal-1">
        <span class="micro-label">Tools</span>
        <h1>Competition Banner Generator</h1>
        <p class="banner-lead">
          Fill in the event details, add your club logo and download a ready-made
          competition banner — everything is generated right here in your browser.
        </p>
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
            <input type="text" id="title" class="field-input" value="${escAttr(defaultTitle())}">
            <div class="field-size">
              <span class="field-size-label">Size</span>
              <input type="range" id="titleSize" min="24" max="60" step="1" value="48">
              <output class="field-size-value" id="titleSizeOut">48 px</output>
            </div>
          </div>

          <div class="field">
            <label class="field-label" for="dateVenue">Date &amp; venue</label>
            <input type="text" id="dateVenue" class="field-input" value="${escAttr(defaultDateVenue())}">
            <div class="field-size">
              <span class="field-size-label">Size</span>
              <input type="range" id="dateVenueSize" min="14" max="32" step="1" value="22">
              <output class="field-size-value" id="dateVenueSizeOut">22 px</output>
            </div>
          </div>

          <div class="field">
            <label class="field-label" for="categories">Categories</label>
            <input type="text" id="categories" class="field-input" value="SENIORS  ·  JUNIORS  ·  NOVICES">
            <div class="field-size">
              <span class="field-size-label">Size</span>
              <input type="range" id="categoriesSize" min="10" max="22" step="1" value="14">
              <output class="field-size-value" id="categoriesSizeOut">14 px</output>
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
  const probe = new Image();
  probe.onload = () => {
    clubLogo = dataUri;
    // SVGs without intrinsic dimensions report 0 — fall back to the bubble ratio
    clubW = probe.naturalWidth || 100;
    clubH = probe.naturalHeight || 80;
    refresh();
  };
  probe.onerror = () => {
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

async function useClubFromManifest(file: string): Promise<void> {
  try {
    const resp = await fetch(CLUB_LOGO_BASE + file);
    if (!resp.ok) throw new Error(`Could not load ${file}`);
    const typed = new Blob([await resp.blob()], { type: mimeForFile(file) });
    setClubLogo(await blobToDataUri(typed));
    setDropzoneText(DROPZONE_DEFAULT_TEXT);
  } catch (_e) {
    setDropzoneText('That club logo could not be loaded — drop a file instead.');
  }
}

async function useCustomFile(file: File): Promise<void> {
  if (!ACCEPTED_LOGO_TYPES.includes(file.type)) {
    setDropzoneText('Unsupported file type — please use JPG, PNG or SVG.');
    return;
  }
  setClubLogo(await blobToDataUri(file));
  setDropzoneText(file.name);
  const select = el<HTMLSelectElement>('clubSelect');
  if (select) select.value = '';
}

/* ════════════════════════════════════════════════════════════════
   Init
   ════════════════════════════════════════════════════════════════ */

const DOWNLOAD_BUTTON_IDS = ['btnPng', 'btnSvg', 'btnJpeg', 'btnBmp', 'btnSportity'];

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
  const sync = (): void => {
    out.textContent = `${slider.value} px`;
    refresh();
  };
  slider.addEventListener('input', sync);
  sync();
}

function bindClubLogoInputs(): void {
  const clubBubble = input('clubBubble');
  const clubOptions = el<HTMLElement>('clubOptions');

  clubBubble.addEventListener('change', () => {
    clubOptions.classList.toggle('hidden', !clubBubble.checked);
    refresh();
  });

  const select = el<HTMLSelectElement>('clubSelect');
  select.addEventListener('change', () => {
    if (!select.value) {
      clubLogo = null;
      clubW = 0;
      clubH = 0;
      setDropzoneText(DROPZONE_DEFAULT_TEXT);
      refresh();
      return;
    }
    void useClubFromManifest(select.value);
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
    if (file) void useCustomFile(file);
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
    refresh();
  });
}

/** Boot the generator: load assets, wire the form, render the first preview */
export function initGenerator(): void {
  for (const id of ['title', 'dateVenue', 'categories']) {
    input(id).addEventListener('input', refresh);
  }
  bindSizeSlider('titleSize', 'titleSizeOut');
  bindSizeSlider('dateVenueSize', 'dateVenueSizeOut');
  bindSizeSlider('categoriesSize', 'categoriesSizeOut');
  bindClubLogoInputs();
  bindDownloadButtons();

  void loadAssets();
}

async function loadAssets(): Promise<void> {
  const status = el<HTMLElement>('previewStatus');
  try {
    const [ralewayUri, logoUri, clubs] = await Promise.all([
      fetchDataUri(RALEWAY_URL),
      fetchDataUri(LOGO_URL),
      loadClubs(),
    ]);
    raleway = ralewayUri;
    logo = logoUri;

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
    setDownloadsEnabled(true);
    status.classList.add('hidden');
    el<HTMLElement>('previewWrap').classList.remove('hidden');
    refresh();
  } catch (_e) {
    status.textContent = 'Banner assets could not be loaded. Please reload the page.';
    status.classList.add('banner-preview-status--error');
  }
}
