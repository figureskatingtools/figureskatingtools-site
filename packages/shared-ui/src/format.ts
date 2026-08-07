/**
 * Shared display formatting helpers.
 *
 * Every human-facing date on figureskatingtools.com is Finnish: `dd.MM.yyyy`
 * (25.01.2025), zero-padded, day first. Machine-facing values — anything that
 * goes back to an API, a `<input type="date">` value or a sort key — stay ISO;
 * this module is only for what a person reads.
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
