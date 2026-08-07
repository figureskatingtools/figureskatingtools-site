/**
 * Unit tests for the shared display formatters.
 *
 * `formatDateFi` is deliberately DOM-free and time-zone-safe for date-only
 * input, so plain vitest in the default node environment is enough.
 */

import { describe, expect, it } from 'vitest';

import { formatDateFi } from '../src/format.js';

describe('formatDateFi', () => {
  it('formats an ISO date as dd.MM.yyyy', () => {
    expect(formatDateFi('2025-01-25')).toBe('25.01.2025');
  });

  it('zero-pads single-digit days and months', () => {
    expect(formatDateFi('2026-02-14')).toBe('14.02.2026');
    expect(formatDateFi('2026-2-4')).toBe('04.02.2026');
  });

  it('does not shift a date-only value across time zones', () => {
    // Parsed lexically, never through Date — a UTC-midnight parse in a
    // negative offset would otherwise render the previous day.
    expect(formatDateFi('2026-01-01')).toBe('01.01.2026');
    expect(formatDateFi('2025-12-31')).toBe('31.12.2025');
  });

  it('formats an ISO timestamp', () => {
    // The clock part is dropped; the day comes from local time.
    expect(formatDateFi('2025-01-25T12:00:00Z')).toBe('25.01.2025');
    expect(formatDateFi('2025-03-09T08:15:00')).toBe('09.03.2025');
    expect(formatDateFi('2025-03-09 08:15:00')).toBe('09.03.2025');
  });

  it('formats a Date object', () => {
    expect(formatDateFi(new Date(2025, 0, 25, 13, 45))).toBe('25.01.2025');
  });

  it('accepts surrounding whitespace', () => {
    expect(formatDateFi('  2025-01-25  ')).toBe('25.01.2025');
  });

  it('renders empty input as an empty string', () => {
    expect(formatDateFi('')).toBe('');
    expect(formatDateFi('   ')).toBe('');
    expect(formatDateFi(null)).toBe('');
    expect(formatDateFi(undefined)).toBe('');
  });

  it('returns an invalid Date as an empty string', () => {
    expect(formatDateFi(new Date('nope'))).toBe('');
  });

  it('returns unparsable input unchanged', () => {
    expect(formatDateFi('TBA')).toBe('TBA');
    expect(formatDateFi('14.–15.2.2026')).toBe('14.–15.2.2026');
    expect(formatDateFi('25.01.2025')).toBe('25.01.2025');
    expect(formatDateFi('2025/01/25')).toBe('2025/01/25');
  });

  it('rejects a calendar day that does not exist', () => {
    expect(formatDateFi('2025-02-31')).toBe('2025-02-31');
    expect(formatDateFi('2025-13-01')).toBe('2025-13-01');
  });

  it('keeps a leap day', () => {
    expect(formatDateFi('2024-02-29')).toBe('29.02.2024');
  });
});
