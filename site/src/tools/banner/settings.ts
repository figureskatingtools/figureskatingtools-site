/**
 * What the banner generator remembers per competition, and how a fresh form
 * is filled in from the competition's own data.
 *
 * The settings travel through the platform (`/api/competitions/{id}/settings/
 * banner`), which stores them opaquely, so everything read back is validated
 * here: a bad field falls back to its default, never breaks the page.
 */

import {
  formatDateRangeFi,
  isScheduleXmlName,
  listCompetitionFiles,
  competitionFileUrl,
  summarizeScheduleXml,
  type PlatformCompetition,
  type PoolFile,
  type ScheduleSummary,
} from '@figureskatingtools/shared-ui';

/** A club logo from the bundled list, or one the user dropped in */
export type ClubChoice = { file: string } | { name: string; dataUri: string };

export interface BannerSettings {
  v: 1;
  title: string;
  titleSize: number;
  dateVenue: string;
  dateVenueSize: number;
  categories: string;
  categoriesSize: number;
  clubBubble: boolean;
  club: ClubChoice | null;
  sportity: boolean;
}

/** One entry of the club logo manifest */
export interface ClubEntry {
  name: string;
  abbreviation?: string;
  file: string;
}

/** Slider ranges — the markup and the validation share them */
export const SIZE_RANGES = {
  titleSize: { min: 24, max: 60, initial: 48 },
  dateVenueSize: { min: 14, max: 32, initial: 22 },
  categoriesSize: { min: 10, max: 22, initial: 14 },
} as const;

const FALLBACK_TITLE = 'WINTER CUP 2026';
const FALLBACK_DATE_VENUE = '14.–15.02.2026  |  Ice Arena, Helsinki';
const FALLBACK_CATEGORIES = 'SENIORS  ·  JUNIORS  ·  NOVICES';

const DATE_VENUE_SEPARATOR = '  |  ';
const CATEGORY_SEPARATOR = '  ·  ';

/** Longest text per field — the inputs' maxlength too, so nothing saved is cut on reload */
export const MAX_TEXT = 300;
/** A remembered custom logo must fit the platform's 1 MB settings cap */
export const MAX_REMEMBERED_LOGO_CHARS = 900_000;
const LOGO_DATA_URI_RE = /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;

/* ── validation ── */

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : fallback;
}

function size(value: unknown, key: keyof typeof SIZE_RANGES): number {
  const range = SIZE_RANGES[key];
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : range.initial;
  return Math.min(range.max, Math.max(range.min, n));
}

function club(value: unknown): ClubChoice | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.file === 'string' && /^[\w.-]+$/.test(r.file)) return { file: r.file };
  if (
    typeof r.dataUri === 'string' &&
    r.dataUri.length <= MAX_REMEMBERED_LOGO_CHARS &&
    LOGO_DATA_URI_RE.test(r.dataUri)
  ) {
    return { name: text(r.name, 'Club logo'), dataUri: r.dataUri };
  }
  return null;
}

/** Saved settings as read back from the platform, or null when unusable */
export function toBannerSettings(raw: Record<string, unknown> | null): BannerSettings | null {
  if (!raw || raw.v !== 1) return null;
  const defaults = fallbackSettings();
  return {
    v: 1,
    title: text(raw.title, defaults.title),
    titleSize: size(raw.titleSize, 'titleSize'),
    dateVenue: text(raw.dateVenue, defaults.dateVenue),
    dateVenueSize: size(raw.dateVenueSize, 'dateVenueSize'),
    categories: text(raw.categories, defaults.categories),
    categoriesSize: size(raw.categoriesSize, 'categoriesSize'),
    clubBubble: raw.clubBubble === true,
    club: club(raw.club),
    sportity: raw.sportity === true,
  };
}

/* ── prefill ── */

/** The example banner shown with no competition selected */
export function fallbackSettings(): BannerSettings {
  return {
    v: 1,
    title: FALLBACK_TITLE,
    titleSize: SIZE_RANGES.titleSize.initial,
    dateVenue: FALLBACK_DATE_VENUE,
    dateVenueSize: SIZE_RANGES.dateVenueSize.initial,
    categories: FALLBACK_CATEGORIES,
    categoriesSize: SIZE_RANGES.categoriesSize.initial,
    clubBubble: false,
    club: null,
    sportity: false,
  };
}

function dateVenueLine(start: string, end: string, venue: string): string {
  // The banner is print-facing text, so the dates go on it Finnish
  const parts = [formatDateRangeFi(start, end), venue.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join(DATE_VENUE_SEPARATOR) : FALLBACK_DATE_VENUE;
}

/** What the registry entry alone tells: name, start date, venue */
export function basePrefill(competition: PlatformCompetition | null): BannerSettings {
  const settings = fallbackSettings();
  if (!competition) return settings;
  const name = competition.name.trim();
  if (name) settings.title = name.toUpperCase();
  settings.dateVenue = dateVenueLine(competition.date, '', competition.venue);
  return settings;
}

/**
 * The organising club from an FS Manager competition code: `YL110926HTL` is
 * series, date (ddMMyy) and the club's abbreviation. Only an unambiguous
 * match in the logo list counts.
 */
export function clubFromCode(code: string, clubs: ClubEntry[]): ClubEntry | null {
  const m = /^[a-z]{1,6}\d{6}([a-z]{2,8})$/i.exec(code.trim());
  if (!m) return null;
  const abbr = m[1].toLowerCase();
  const hits = clubs.filter((c) => (c.abbreviation ?? '').toLowerCase() === abbr);
  return hits.length === 1 ? hits[0] : null;
}

/** The newest DT_SCHEDULE XML in the competition's file pool, summarised */
async function poolSchedule(competitionId: string): Promise<ScheduleSummary | null> {
  let files: PoolFile[];
  try {
    files = await listCompetitionFiles(competitionId);
  } catch (_e) {
    return null;
  }
  const newest = files
    .filter((f) => isScheduleXmlName(f.name))
    .sort((a, b) => b.uploadedUtc.localeCompare(a.uploadedUtc))[0];
  if (!newest) return null;
  try {
    const resp = await fetch(competitionFileUrl(competitionId, newest.name, newest.source));
    if (!resp.ok) return null;
    return summarizeScheduleXml(await resp.text());
  } catch (_e) {
    return null;
  }
}

/**
 * Everything the competition can tell: the registry entry, the schedule FS
 * Manager sent (categories, last day, venue) and the club in its code.
 */
export async function fullPrefill(
  competition: PlatformCompetition,
  clubs: ClubEntry[]
): Promise<BannerSettings> {
  const settings = basePrefill(competition);
  const schedule = await poolSchedule(competition.id);
  if (schedule) {
    const start = competition.date || schedule.firstDate;
    const end = schedule.lastDate > start ? schedule.lastDate : '';
    settings.dateVenue = dateVenueLine(start, end, competition.venue || schedule.venue);
    if (schedule.categories.length > 0) {
      settings.categories = schedule.categories
        .map((c) => c.toUpperCase())
        .join(CATEGORY_SEPARATOR)
        .slice(0, MAX_TEXT);
    }
  }
  const organiser = clubFromCode(competition.code, clubs);
  if (organiser) {
    settings.clubBubble = true;
    settings.club = { file: organiser.file };
  }
  return settings;
}
