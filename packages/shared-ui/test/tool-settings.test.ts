/**
 * Unit tests for the remembered tool settings client.
 *
 * `fetch` is stubbed with `vi.stubGlobal`, as in the other client suites.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompetitionApiError } from '../src/competition.js';
import { getToolSettings, saveToolSettings, toToolSettings, toolSettingsUrl } from '../src/tool-settings.js';

const COMP_ID = '5f6b3a1e-1c2d-4f8a-9b0c-2d3e4f5a6b7c';

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toolSettingsUrl', () => {
  it('builds the settings route of one competition and tool', () => {
    expect(toolSettingsUrl(COMP_ID, 'banner')).toBe(`/api/competitions/${COMP_ID}/settings/banner`);
  });
});

describe('toToolSettings', () => {
  it('keeps an object and reads anything else as not saved', () => {
    expect(toToolSettings({ settings: { a: 1 }, updatedUtc: 'T' })).toEqual({ settings: { a: 1 }, updatedUtc: 'T' });
    for (const settings of [null, [1], 'x', 3]) {
      expect(toToolSettings({ settings }).settings).toBeNull();
    }
    expect(toToolSettings(null)).toEqual({ settings: null, updatedUtc: '' });
  });
});

describe('getToolSettings / saveToolSettings', () => {
  it('reads the saved object', async () => {
    const fetchMock = vi.fn(async () => response(200, { tool: 'banner', settings: { v: 1 }, updatedUtc: 'T' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getToolSettings(COMP_ID, 'banner')).toEqual({ settings: { v: 1 }, updatedUtc: 'T' });
    expect(fetchMock).toHaveBeenCalledWith(toolSettingsUrl(COMP_ID, 'banner'), expect.anything());
  });

  it('PUTs {settings} as JSON', async () => {
    const fetchMock = vi.fn(async () => response(200, { tool: 'banner', settings: { v: 1 }, updatedUtc: 'T' }));
    vi.stubGlobal('fetch', fetchMock);
    await saveToolSettings(COMP_ID, 'banner', { v: 1 }, { keepalive: true });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ settings: { v: 1 } });
    expect(init.keepalive).toBe(true);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('carries the API error code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(403, { error: 'read_only', message: 'View only.' })));
    const error = await saveToolSettings(COMP_ID, 'banner', {}).catch((e) => e);
    expect(error).toBeInstanceOf(CompetitionApiError);
    expect([error.status, error.code, error.message]).toEqual([403, 'read_only', 'View only.']);
  });

  it('maps a network failure onto status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const error = await getToolSettings(COMP_ID, 'banner').catch((e) => e);
    expect(error.status).toBe(0);
  });
});
