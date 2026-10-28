/**
 * Shared display formatting helpers.
 *
 * Every human-facing date on figureskatingtools.com is Finnish: `dd.MM.yyyy`
 * (25.01.2025), zero-padded, day first. Machine-facing values — anything that
 * goes back to an API, a `<input type="date">` value or a sort key — stay ISO;
 * this module is only for what a person reads. File sizes are formatted the
 * same way: for a person scanning a list, not for arithmetic.
 *
 * DOM-free and dependency-free, so it unit tests in plain node.
 */

/** Plain `YYYY-MM-DD` (also tolerating single-digit month/day) */
const ISO_DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
/** An ISO timestamp — date part followed by `T` (or a space) and a time */
const ISO_DATETIME_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ]/;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Assemble `dd.MM.yyyy` from calendar parts */
function fiParts(day: number, month: number, year: number): string {
  return `${pad2(day)}.${pad2(month)}.${year}`;
}

/** True when the numbers really name that calendar day (rejects 2025-02-31) */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Format a date for display in Finnish `dd.MM.yyyy`.
 *
 * Accepts an ISO date (`2025-01-25`), an ISO timestamp
 * (`2025-01-25T09:30:00Z` — rendered in the viewer's local time zone) or a
 * `Date`. Date-only strings are reformatted lexically, never through `Date`,
 * so a UTC-midnight parse can never shift the day backwards.
 *
 * Anything it cannot parse comes back **unchanged**, so it is safe to wrap
 * around values that are already human text ("14.–15.2.2026", "TBA").
 * `null`/`undefined`/blank all render as `''`.
 */
export function formatDateFi(value: string | Date | null | undefined): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? ''
      : fiParts(value.getDate(), value.getMonth() + 1, value.getFullYear());
  }
  if (value === null || value === undefined) return '';

  const raw = String(value);
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const dateOnly = ISO_DATE_RE.exec(trimmed);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    return isRealDate(year, month, day) ? fiParts(day, month, year) : raw;
  }

  if (ISO_DATETIME_RE.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return fiParts(parsed.getDate(), parsed.getMonth() + 1, parsed.getFullYear());
    }
  }

  return raw;
}

/** The calendar parts of a valid ISO date, or null */
function isoParts(value: string | null | undefined): [number, number, number] | null {
  const m = ISO_DATE_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  const parts: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return isRealDate(...parts) ? parts : null;
}

/**
 * Format a date range compactly for print: `11.–12.09.2026` within a month,
 * `30.09.–01.10.2026` within a year, else both dates in full joined by an en
 * dash. An end that is missing, invalid or not after the start renders as the
 * single start date; with no valid start it is `formatDateFi(start)` (so
 * human text passes through, and blank renders as the end date or `''`).
 */
export function formatDateRangeFi(
  start: string | null | undefined,
  end: string | null | undefined
): string {
  const from = isoParts(start);
  const to = isoParts(end);
  if (!from) return String(start ?? '').trim() ? formatDateFi(start) : (to ? formatDateFi(end) : '');
  const [y1, m1, d1] = from;
  if (!to || to[0] * 10000 + to[1] * 100 + to[2] <= y1 * 10000 + m1 * 100 + d1) {
    return fiParts(d1, m1, y1);
  }
  const [y2, m2, d2] = to;
  if (y1 === y2 && m1 === m2) return `${pad2(d1)}.–${fiParts(d2, m2, y2)}`;
  if (y1 === y2) return `${pad2(d1)}.${pad2(m1)}.–${fiParts(d2, m2, y2)}`;
  return `${fiParts(d1, m1, y1)}–${fiParts(d2, m2, y2)}`;
}

/**
 * Format a byte count for a file list: `1.4 MB` / `812 kB`.
 *
 * Binary units under decimal labels, matching what a file manager shows.
 * Anything under a kilobyte still reads `1 kB` — "0 kB" would look like a
 * broken upload. An unknown or zero size comes back as `''`, so a caller's
 * `filter(Boolean)` drops the segment instead of rendering a dangling dash.
 */
export function formatFileSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

/**
 * Format a timestamp for display as Finnish `dd.MM.yyyy HH:mm`.
 *
 * The date half behaves exactly like {@link formatDateFi}; the clock half is
 * the viewer's local time, 24-hour and zero-padded. A date-only string has no
 * time to show, so it degrades to the plain `dd.MM.yyyy` form rather than
 * inventing a midnight.
 *
 * Anything it cannot parse comes back **unchanged**, and
 * `null`/`undefined`/blank all render as `''` — same contract as
 * `formatDateFi`, so it is safe to drop into a template.
 */
export function formatDateTimeFi(value: string | Date | null | undefined): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return `${fiParts(value.getDate(), value.getMonth() + 1, value.getFullYear())}`
      + ` ${pad2(value.getHours())}:${pad2(value.getMinutes())}`;
  }
  if (value === null || value === undefined) return '';

  const raw = String(value);
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // A bare calendar day carries no clock — render it as a plain date.
  if (ISO_DATE_RE.test(trimmed)) return formatDateFi(raw);

  if (ISO_DATETIME_RE.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return `${fiParts(parsed.getDate(), parsed.getMonth() + 1, parsed.getFullYear())}`
        + ` ${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`;
    }
  }

  return raw;
}
