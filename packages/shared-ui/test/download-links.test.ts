/**
 * Unit tests for the short-lived download link helpers. Plain node
 * environment: `openFreshDownload` gets a stubbed `window`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DOWNLOAD_DETAILS_MAX_AGE_MS,
  isDownloadLinkStale,
  openFreshDownload,
  usableDownloadUrl,
} from '../src/download-links.js';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const SAS = 'https://stfs.blob.core.windows.net/generated/a.pdf?sv=1&se=2026-10-17T12%3A15%3A00Z&sig=x';

describe('usableDownloadUrl', () => {
  it('passes http(s) and same-origin URLs through', () => {
    expect(usableDownloadUrl(SAS)).toBe(SAS);
    expect(usableDownloadUrl(' http://localhost:10000/x.pdf ')).toBe('http://localhost:10000/x.pdf');
    expect(usableDownloadUrl('/judgepapers/api/x.pdf')).toBe('/judgepapers/api/x.pdf');
  });

  it('rejects missing, stringified-null and non-http values', () => {
    for (const bad of [null, undefined, '', '  ', 'null', 'undefined', 42, {}, 'javascript:alert(1)', 'data:text/html,x']) {
      expect(usableDownloadUrl(bad)).toBeNull();
    }
  });
});

describe('isDownloadLinkStale', () => {
  const in5min = new Date(NOW + 5 * 60_000).toISOString();

  it('is fresh shortly after the fetch with time left on the link', () => {
    expect(isDownloadLinkStale(NOW - 60_000, in5min, NOW)).toBe(false);
    expect(isDownloadLinkStale(NOW - 60_000, null, NOW)).toBe(false);
  });

  it('is stale once the listing is over 10 minutes old', () => {
    expect(isDownloadLinkStale(NOW - DOWNLOAD_DETAILS_MAX_AGE_MS, null, NOW)).toBe(false);
    expect(isDownloadLinkStale(NOW - DOWNLOAD_DETAILS_MAX_AGE_MS - 1, in5min, NOW)).toBe(true);
  });

  it('is stale within a minute of the link expiring, or after', () => {
    expect(isDownloadLinkStale(NOW, new Date(NOW + 61_000).toISOString(), NOW)).toBe(false);
    expect(isDownloadLinkStale(NOW, new Date(NOW + 60_000).toISOString(), NOW)).toBe(true);
    expect(isDownloadLinkStale(NOW, '2026-10-17T11:00:00Z', NOW)).toBe(true);
  });

  it('treats an unknown fetch time as stale and ignores an unparsable expiration', () => {
    expect(isDownloadLinkStale(0, in5min, NOW)).toBe(true);
    expect(isDownloadLinkStale(Number.NaN, in5min, NOW)).toBe(true);
    expect(isDownloadLinkStale(NOW, 'soon', NOW)).toBe(false);
  });
});

describe('openFreshDownload', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubWindow(tab: { opener: unknown; closed: boolean; location: { href: string }; close: () => void } | null) {
    const open = vi.fn((url?: string) => (url ? null : tab));
    const assign = vi.fn();
    vi.stubGlobal('window', { open, location: { assign } });
    return { open, assign };
  }

  it('opens a blank tab at once and points it at the fresh URL', async () => {
    const tab = { opener: {} as unknown, closed: false, location: { href: '' }, close: vi.fn() };
    const { open } = stubWindow(tab);
    const onUnavailable = vi.fn();
    const opened = await openFreshDownload({ newTab: true, refresh: async () => SAS, onUnavailable });
    expect(opened).toBe(true);
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe(SAS);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('closes the blank tab and reports when no URL comes back', async () => {
    const tab = { opener: null, closed: false, location: { href: '' }, close: vi.fn() };
    stubWindow(tab);
    const onUnavailable = vi.fn();
    expect(await openFreshDownload({ newTab: true, refresh: async () => null, onUnavailable })).toBe(false);
    expect(tab.close).toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it('treats a failed refresh like a missing URL', async () => {
    const tab = { opener: null, closed: false, location: { href: '' }, close: vi.fn() };
    stubWindow(tab);
    const onUnavailable = vi.fn();
    const refresh = async () => { throw new Error('network'); };
    expect(await openFreshDownload({ newTab: true, refresh, onUnavailable })).toBe(false);
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it('navigates the current tab for a same-tab link', async () => {
    const { open, assign } = stubWindow(null);
    expect(await openFreshDownload({ newTab: false, refresh: async () => SAS, onUnavailable: vi.fn() })).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith(SAS);
  });

  it('falls back to a direct open when the blank tab was blocked', async () => {
    const { open } = stubWindow(null);
    expect(await openFreshDownload({ newTab: true, refresh: async () => SAS, onUnavailable: vi.fn() })).toBe(true);
    expect(open).toHaveBeenLastCalledWith(SAS, '_blank', 'noopener');
  });
});
