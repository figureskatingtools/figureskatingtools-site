/**
 * The test environment's sample datasets: the two API clients and the create
 * dialog's fieldset (DOM-free — the dialog renders the fieldset from
 * `sampleDatasetsFieldsetHtml`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMPETITIONS_API,
  CompetitionApiError,
  importSampleData,
  listSampleDatasets,
  SAMPLE_DATASETS_API,
} from '../src/competition.js';
import { sampleDatasetsFieldsetHtml } from '../src/competition-selector.js';

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  } as Response;
}

const ID = '5f6b3a1e-1c2d-4f8a-9b0c-2d3e4f5a6b7c';
const DATASETS = [
  { id: 'synchro', label: 'Synchronized skating', description: 'Junior and novice teams' },
  { id: 'singles', label: 'Singles', description: 'Women and men' },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listSampleDatasets', () => {
  it('GETs the platform list and maps its items', async () => {
    const fetchMock = vi.fn(async () => response(200, { items: DATASETS }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listSampleDatasets()).resolves.toEqual(DATASETS);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(SAMPLE_DATASETS_API);
  });

  it('drops unusable rows and defaults a missing description', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, {
      items: [{ id: 'singles', label: 'Singles' }, { id: '', label: 'x' }, { id: 'a' }, null],
    })));
    await expect(listSampleDatasets()).resolves.toEqual([
      { id: 'singles', label: 'Singles', description: '' },
    ]);
  });

  it('resolves to [] on a 404 (every environment but test)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(404, { error: 'not_found' })));
    await expect(listSampleDatasets()).resolves.toEqual([]);
  });

  it('resolves to [] on any other failure, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(500)));
    await expect(listSampleDatasets()).resolves.toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(listSampleDatasets()).resolves.toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => response(200)));
    await expect(listSampleDatasets()).resolves.toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { items: 'nope' })));
    await expect(listSampleDatasets()).resolves.toEqual([]);
  });
});

describe('importSampleData', () => {
  it('POSTs the chosen ids to the competition', async () => {
    const fetchMock = vi.fn(async () => response(201, { files: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(importSampleData(ID, ['synchro', 'singles'])).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${COMPETITIONS_API}/${ID}/sample-data`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ datasets: ['synchro', 'singles'] });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('throws CompetitionApiError with the API code and message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      response(400, { error: 'invalid_dataset', message: 'Choose one or more.' })));

    const err = await importSampleData(ID, ['nope']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CompetitionApiError);
    expect((err as CompetitionApiError).status).toBe(400);
    expect((err as CompetitionApiError).code).toBe('invalid_dataset');
    expect((err as CompetitionApiError).message).toBe('Choose one or more.');
  });

  it('maps a network failure to status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const err = await importSampleData(ID, ['synchro']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CompetitionApiError);
    expect((err as CompetitionApiError).status).toBe(0);
  });
});

describe('sampleDatasetsFieldsetHtml', () => {
  it('renders nothing when the platform offers no datasets', () => {
    expect(sampleDatasetsFieldsetHtml([])).toBe('');
  });

  it('renders one unticked checkbox per dataset', () => {
    const html = sampleDatasetsFieldsetHtml(DATASETS);
    expect(html).toContain('Sample data (test environment only)');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain('value="synchro"');
    expect(html).toContain('value="singles"');
    expect(html).not.toContain('checked');
    expect(html).toContain('Junior and novice teams');
  });

  it('escapes what the API sends', () => {
    const html = sampleDatasetsFieldsetHtml([
      { id: 'x"><b', label: '<script>', description: '&' },
    ]);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('x"><b');
    expect(html).toContain('&lt;script&gt;');
  });
});
