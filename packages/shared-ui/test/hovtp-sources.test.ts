/**
 * Unit tests for the HOVTP data-sources client.
 *
 * DOM-free like the rest of the shared-ui suite: `fetch` is stubbed with
 * `vi.stubGlobal`, so only the request the client builds and the shape it
 * hands back are under test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { COMPETITIONS_API, CompetitionApiError } from '../src/competition.js';
import {
  ACCEPT_DAYS,
  acceptHovtpSource,
  extractHovtpSourceList,
  hovtpSourceUrl,
  hovtpSourcesUrl,
  listHovtpSources,
  rejectHovtpSource,
  revokeHovtpSource,
  toHovtpSource,
} from '../src/hovtp-sources.js';

const COMP_ID = '5f6b3a1e-1c2d-4f8a-9b0c-2d3e4f5a6b7c';
const IP = '20.31.44.5';

/** One well-formed row as the platform API sends it */
const ROW = {
  ip: IP,
  origin: 'FSM1',
  venue: 'HTL',
  discipline: 'FSK',
  environment: 'Test',
  status: 'pending',
  firstSeenUtc: '2026-09-05T10:00:00Z',
  lastSeenUtc: '2026-09-05T10:12:00Z',
  messageCount: 12,
  pendingCount: 3,
  pendingBytes: 4096,
};

/** A minimal `Response` stand-in — only what the client actually reads */
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ACCEPT_DAYS', () => {
  it('offers the four windows, shortest first', () => {
    expect([...ACCEPT_DAYS]).toEqual([1, 2, 3, 7]);
  });
});

describe('toHovtpSource', () => {
  it('maps a full row', () => {
    expect(toHovtpSource({ ...ROW, acceptedUntilUtc: '2026-09-12T10:00:00Z', acceptedBy: 'a@b.c' }))
      .toEqual({
        ip: IP,
        origin: 'FSM1',
        venue: 'HTL',
        discipline: 'FSK',
        environment: 'Test',
        status: 'pending',
        firstSeenUtc: '2026-09-05T10:00:00Z',
        lastSeenUtc: '2026-09-05T10:12:00Z',
        messageCount: 12,
        pendingCount: 3,
        pendingBytes: 4096,
        acceptedUntilUtc: '2026-09-12T10:00:00Z',
        acceptedBy: 'a@b.c',
      });
  });

  it('defaults every missing field', () => {
    expect(toHovtpSource({ ip: IP })).toEqual({
      ip: IP,
      origin: '',
      venue: '',
      discipline: '',
      environment: '',
      status: 'pending',
      firstSeenUtc: '',
      lastSeenUtc: '',
      messageCount: 0,
      pendingCount: 0,
      pendingBytes: 0,
    });
  });

  it('keeps the known statuses', () => {
    for (const status of ['pending', 'accepted', 'expired', 'rejected'] as const) {
      expect(toHovtpSource({ ip: IP, status })?.status).toBe(status);
    }
  });

  it('treats an unknown status as pending, so the source still prompts', () => {
    expect(toHovtpSource({ ip: IP, status: 'quarantined' })?.status).toBe('pending');
    expect(toHovtpSource({ ip: IP, status: 42 })?.status).toBe('pending');
  });

  it('drops a row without an ip', () => {
    expect(toHovtpSource({ ...ROW, ip: '' })).toBeNull();
    expect(toHovtpSource({ origin: 'FSM1' })).toBeNull();
    expect(toHovtpSource(null)).toBeNull();
    expect(toHovtpSource('nope')).toBeNull();
  });

  it('ignores non-numeric counters', () => {
    const source = toHovtpSource({ ip: IP, messageCount: '12', pendingBytes: Number.NaN });
    expect(source?.messageCount).toBe(0);
    expect(source?.pendingBytes).toBe(0);
  });
});

describe('extractHovtpSourceList', () => {
  it('accepts a bare array', () => {
    expect(extractHovtpSourceList([ROW]).map((s) => s.ip)).toEqual([IP]);
  });

  it('accepts the {sources} envelope', () => {
    expect(extractHovtpSourceList({ sources: [ROW] }).map((s) => s.ip)).toEqual([IP]);
  });

  it('skips unusable rows', () => {
    expect(extractHovtpSourceList({ sources: [ROW, {}, null, { ip: '2001:db8::1' }] }).map((s) => s.ip))
      .toEqual([IP, '2001:db8::1']);
  });

  it('returns nothing for an unexpected payload', () => {
    expect(extractHovtpSourceList(null)).toEqual([]);
    expect(extractHovtpSourceList({ items: [ROW] })).toEqual([]);
  });
});

describe('URLs', () => {
  it('builds the collection URL', () => {
    expect(hovtpSourcesUrl(COMP_ID)).toBe(`${COMPETITIONS_API}/${COMP_ID}/hovtp/sources`);
  });

  it('percent-encodes an IPv6 address', () => {
    expect(hovtpSourceUrl(COMP_ID, '2001:db8::1')).toBe(
      `${COMPETITIONS_API}/${COMP_ID}/hovtp/sources/2001%3Adb8%3A%3A1`
    );
  });

  it('percent-encodes the competition id too', () => {
    expect(hovtpSourceUrl('a/b?c d', IP)).toBe(
      `${COMPETITIONS_API}/a%2Fb%3Fc%20d/hovtp/sources/20.31.44.5`
    );
  });
});

describe('listHovtpSources', () => {
  it('GETs the collection and maps the rows', async () => {
    const fetchMock = vi.fn(async () => response(200, { sources: [ROW] }));
    vi.stubGlobal('fetch', fetchMock);

    const sources = await listHovtpSources(COMP_ID);

    expect(sources).toHaveLength(1);
    expect(sources[0].ip).toBe(IP);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(hovtpSourcesUrl(COMP_ID));
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('surfaces a 4xx with the registry message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(409, { error: 'competition_deleted', message: 'Competition is deleted.' }))
    );

    await expect(listHovtpSources(COMP_ID)).rejects.toMatchObject({
      name: 'CompetitionApiError',
      status: 409,
      message: 'Competition is deleted.',
    });
  });

  it('falls back to the bare status when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(500)));

    await expect(listHovtpSources(COMP_ID)).rejects.toMatchObject({
      status: 500,
      message: 'HOVTP sources API returned 500',
    });
  });

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const error = await listHovtpSources(COMP_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompetitionApiError);
    expect((error as CompetitionApiError).status).toBe(0);
  });
});

describe('acceptHovtpSource', () => {
  it('POSTs the day count as JSON and reports what was attached', async () => {
    const fetchMock = vi.fn(async () =>
      response(200, { source: { ...ROW, status: 'accepted' }, attached: 3, failed: 0 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await acceptHovtpSource(COMP_ID, IP, 7);

    expect(result.attached).toBe(3);
    expect(result.source?.status).toBe('accepted');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${hovtpSourceUrl(COMP_ID, IP)}/accept`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ days: 7 });
  });

  it('encodes an IPv6 source into the path', async () => {
    const fetchMock = vi.fn(async () => response(200, { source: { ip: '2001:db8::1' }, attached: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await acceptHovtpSource(COMP_ID, '2001:db8::1', 1);

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${COMPETITIONS_API}/${COMP_ID}/hovtp/sources/2001%3Adb8%3A%3A1/accept`
    );
  });

  it('accepts a bare source body as zero attached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { ...ROW, status: 'accepted' })));

    const result = await acceptHovtpSource(COMP_ID, IP, 2);

    expect(result.source?.ip).toBe(IP);
    expect(result.attached).toBe(0);
  });

  it('surfaces a 400 with the registry message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(400, { error: 'invalid_days', message: 'days must be 1, 2, 3 or 7.' }))
    );

    await expect(acceptHovtpSource(COMP_ID, IP, 7)).rejects.toMatchObject({
      status: 400,
      message: 'days must be 1, 2, 3 or 7.',
    });
  });

  it('falls back to the bare status when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(500)));

    await expect(acceptHovtpSource(COMP_ID, IP, 1)).rejects.toMatchObject({
      status: 500,
      message: `Could not accept "${IP}" (500)`,
    });
  });

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const error = await acceptHovtpSource(COMP_ID, IP, 1).catch((e: unknown) => e);
    expect((error as CompetitionApiError).status).toBe(0);
  });
});

describe('rejectHovtpSource', () => {
  it('POSTs to the reject route', async () => {
    const fetchMock = vi.fn(async () =>
      response(200, { source: { ...ROW, status: 'rejected', pendingCount: 0 }, deleted: 3 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const source = await rejectHovtpSource(COMP_ID, IP);

    expect(source?.status).toBe('rejected');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${hovtpSourceUrl(COMP_ID, IP)}/reject`);
    expect(init.method).toBe('POST');
  });

  it('surfaces a 404 with the registry message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(404, { error: 'source_not_found', message: 'No such source.' }))
    );

    await expect(rejectHovtpSource(COMP_ID, IP)).rejects.toMatchObject({
      status: 404,
      message: 'No such source.',
    });
  });

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const error = await rejectHovtpSource(COMP_ID, IP).catch((e: unknown) => e);
    expect((error as CompetitionApiError).status).toBe(0);
  });
});

describe('revokeHovtpSource', () => {
  it('DELETEs the source route', async () => {
    const fetchMock = vi.fn(async () => response(200, { source: { ...ROW, status: 'rejected' }, deleted: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await revokeHovtpSource(COMP_ID, IP);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(hovtpSourceUrl(COMP_ID, IP));
    expect(init.method).toBe('DELETE');
  });

  it('falls back to the bare status when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(500)));

    await expect(revokeHovtpSource(COMP_ID, IP)).rejects.toMatchObject({
      status: 500,
      message: `Could not revoke "${IP}" (500)`,
    });
  });

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const error = await revokeHovtpSource(COMP_ID, IP).catch((e: unknown) => e);
    expect((error as CompetitionApiError).status).toBe(0);
  });
});
