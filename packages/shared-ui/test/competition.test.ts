/**
 * Unit tests for the active-competition state logic.
 *
 * Everything exercised here is deliberately DOM-free: the module reads
 * `globalThis.localStorage`, so a tiny in-memory Storage stand-in is enough
 * and the tests run in vitest's default node environment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACTIVE_COMPETITION_KEY,
  clearActiveCompetition,
  competitionLabel,
  COMPETITIONS_API,
  CompetitionApiError,
  deleteCompetition,
  extendCompetition,
  extractCompetitionList,
  getActiveCompetition,
  isPlatformCompetition,
  normalizeCompetitionCode,
  isGoneCompetitionError,
  parseActiveCompetition,
  platformErrorMessage,
  readPlatformError,
  retentionInfo,
  serializeActiveCompetition,
  setActiveCompetition,
  subscribeActiveCompetition,
  syncCompetitionSnapshot,
  toPlatformCompetition,
  updateCompetition,
  type PlatformCompetition,
} from '../src/competition.js';

/** Minimal in-memory `Storage` — enough for the two methods the module uses */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

/** A minimal `Response` stand-in — only what the API client actually reads */
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

const COMP: PlatformCompetition = {
  id: '5f6b3a1e-1c2d-4f8a-9b0c-2d3e4f5a6b7c',
  code: 'winter-cup-2026',
  name: 'Winter Cup 2026',
  date: '2026-02-14',
  venue: 'Ice Arena, Helsinki',
};

let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: store,
    configurable: true,
    writable: true,
  });
});

describe('normalizeCompetitionCode', () => {
  it('slugifies a display name', () => {
    expect(normalizeCompetitionCode('Winter Cup 2026')).toBe('winter-cup-2026');
  });

  it('collapses runs of punctuation and trims the edges', () => {
    expect(normalizeCompetitionCode('  --Spring/Trophy__2027!! ')).toBe('spring-trophy-2027');
  });

  it('strips diacritics rather than dropping the letters', () => {
    expect(normalizeCompetitionCode('Jäähalli Cup')).toBe('jaahalli-cup');
  });

  it('is idempotent and safe on empty input', () => {
    expect(normalizeCompetitionCode('winter-cup-2026')).toBe('winter-cup-2026');
    expect(normalizeCompetitionCode('')).toBe('');
    expect(normalizeCompetitionCode(undefined as unknown as string)).toBe('');
  });
});

describe('shape validation', () => {
  it('accepts a well-formed competition', () => {
    expect(isPlatformCompetition(COMP)).toBe(true);
    expect(isPlatformCompetition({ ...COMP, createdBy: 'a@b.c' })).toBe(true);
  });

  it('rejects missing ids, missing codes and wrong types', () => {
    expect(isPlatformCompetition(null)).toBe(false);
    expect(isPlatformCompetition('nope')).toBe(false);
    expect(isPlatformCompetition({ ...COMP, id: '' })).toBe(false);
    expect(isPlatformCompetition({ ...COMP, code: undefined })).toBe(false);
    expect(isPlatformCompetition({ ...COMP, date: 20260214 })).toBe(false);
    expect(isPlatformCompetition({ ...COMP, createdBy: 42 })).toBe(false);
  });

  it('round-trips through serialize/parse and drops stray keys', () => {
    const withJunk = { ...COMP, secret: 'nope' } as unknown as PlatformCompetition;
    const parsed = parseActiveCompetition(serializeActiveCompetition(withJunk));
    expect(parsed).toEqual(COMP);
    expect(parsed).not.toHaveProperty('secret');
  });

  it('returns null for malformed stored JSON', () => {
    expect(parseActiveCompetition(null)).toBeNull();
    expect(parseActiveCompetition('')).toBeNull();
    expect(parseActiveCompetition('{not json')).toBeNull();
    expect(parseActiveCompetition('{"id":"x"}')).toBeNull();
  });
});

describe('toPlatformCompetition / extractCompetitionList', () => {
  it('maps the registry startDate onto the client date field', () => {
    const mapped = toPlatformCompetition({
      id: COMP.id,
      code: COMP.code,
      name: COMP.name,
      startDate: '2026-02-14',
      venue: COMP.venue,
      status: 'active',
    });
    expect(mapped).toEqual(COMP);
  });

  it('defaults optional fields and falls back to the code as name', () => {
    expect(toPlatformCompetition({ id: 'g', code: 'c' })).toEqual({
      id: 'g',
      code: 'c',
      name: 'c',
      date: '',
      venue: '',
    });
  });

  it('rejects rows without an id or code', () => {
    expect(toPlatformCompetition({ code: 'c' })).toBeNull();
    expect(toPlatformCompetition({ id: 'g' })).toBeNull();
    expect(toPlatformCompetition('nope')).toBeNull();
  });

  it('reads both the bare array and the {competitions: []} envelope', () => {
    expect(extractCompetitionList([COMP])).toEqual([COMP]);
    expect(extractCompetitionList({ competitions: [COMP] })).toEqual([COMP]);
    expect(extractCompetitionList({ message: 'nope' })).toEqual([]);
    expect(extractCompetitionList([COMP, { code: 'broken' }])).toEqual([COMP]);
  });
});

describe('active competition state', () => {
  it('starts empty', () => {
    expect(getActiveCompetition()).toBeNull();
  });

  it('persists under the versioned key and reads back', () => {
    setActiveCompetition(COMP);
    expect(store.getItem(ACTIVE_COMPETITION_KEY)).toBe(serializeActiveCompetition(COMP));
    expect(getActiveCompetition()).toEqual(COMP);
  });

  it('clears the key on clearActiveCompetition', () => {
    setActiveCompetition(COMP);
    clearActiveCompetition();
    expect(store.getItem(ACTIVE_COMPETITION_KEY)).toBeNull();
    expect(getActiveCompetition()).toBeNull();
  });

  it('refuses to store a malformed competition', () => {
    setActiveCompetition({ id: '', code: '' } as PlatformCompetition);
    expect(getActiveCompetition()).toBeNull();
  });

  it('ignores a corrupted stored value instead of throwing', () => {
    store.setItem(ACTIVE_COMPETITION_KEY, '{{{');
    expect(getActiveCompetition()).toBeNull();
  });

  it('survives storage being unavailable', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(() => setActiveCompetition(COMP)).not.toThrow();
    expect(getActiveCompetition()).toBeNull();
  });
});

describe('subscribe / notify', () => {
  it('notifies subscribers on select and on clear', () => {
    const seen: (PlatformCompetition | null)[] = [];
    const unsubscribe = subscribeActiveCompetition((c) => seen.push(c));

    setActiveCompetition(COMP);
    clearActiveCompetition();

    expect(seen).toEqual([COMP, null]);
    unsubscribe();
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeActiveCompetition(listener);
    setActiveCompetition(COMP);
    unsubscribe();
    clearActiveCompetition();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps notifying the other subscribers when one throws', () => {
    const good = vi.fn();
    const unsubBad = subscribeActiveCompetition(() => {
      throw new Error('boom');
    });
    const unsubGood = subscribeActiveCompetition(good);

    expect(() => setActiveCompetition(COMP)).not.toThrow();
    expect(good).toHaveBeenCalledWith(COMP);

    unsubBad();
    unsubGood();
  });
});

describe('competitionLabel', () => {
  it('prefers the name and falls back to the code', () => {
    expect(competitionLabel(COMP)).toBe('Winter Cup 2026');
    expect(competitionLabel({ ...COMP, name: '   ' })).toBe('winter-cup-2026');
  });
});

describe('deleteCompetition', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('DELETEs the id-scoped route and resolves on 200', async () => {
    const fetchMock = vi.fn(async () =>
      response(200, { id: COMP.id, code: COMP.code, status: 'deleted' })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteCompetition(COMP.id)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${COMPETITIONS_API}/${COMP.id}`);
    expect(init.method).toBe('DELETE');
  });

  it('percent-encodes the id into the path', async () => {
    const fetchMock = vi.fn(async () => response(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await deleteCompetition('a/b?c d');

    expect(fetchMock.mock.calls[0][0]).toBe(`${COMPETITIONS_API}/a%2Fb%3Fc%20d`);
  });

  it('surfaces a non-2xx status with the registry message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(404, { error: 'not_found', message: 'Competition not found.' }))
    );

    await expect(deleteCompetition(COMP.id)).rejects.toMatchObject({
      name: 'CompetitionApiError',
      status: 404,
      message: 'Competition not found.',
    });
  });

  it('falls back to the bare status when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(500)));

    await expect(deleteCompetition(COMP.id)).rejects.toMatchObject({
      status: 500,
      message: 'Could not delete competition (500)',
    });
  });

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const error = await deleteCompetition(COMP.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompetitionApiError);
    expect((error as CompetitionApiError).status).toBe(0);
  });
});

describe('updateCompetition', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PATCHes only the given keys, with the date and code in registry shape', async () => {
    const fetchMock = vi.fn(async () => response(200, { id: COMP.id, code: 'winter-cup' }));
    vi.stubGlobal('fetch', fetchMock);

    await updateCompetition(COMP.id, { code: 'Winter Cup', date: '2026-03-01' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${COMPETITIONS_API}/${COMP.id}`);
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      code: 'winter-cup',
      startDate: '2026-03-01',
    });
  });

  it('resolves with the mapped competition', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(200, {
          id: COMP.id,
          code: 'spring-cup-2026',
          name: 'Spring Cup 2026',
          startDate: '2026-04-02',
          venue: 'Ice Arena, Tampere',
          createdBy: 'organizer@example.com',
        })
      )
    );

    await expect(updateCompetition(COMP.id, { name: 'Spring Cup 2026' })).resolves.toEqual({
      id: COMP.id,
      code: 'spring-cup-2026',
      name: 'Spring Cup 2026',
      date: '2026-04-02',
      venue: 'Ice Arena, Tampere',
      createdBy: 'organizer@example.com',
    });
  });

  it('surfaces a code conflict as 409 naming the normalized code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(409, { error: 'code_in_use', message: 'in use', code: 'spring-cup' })
      )
    );

    const error = await updateCompetition(COMP.id, { code: 'Spring Cup' }).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(CompetitionApiError);
    expect((error as CompetitionApiError).status).toBe(409);
    expect((error as CompetitionApiError).message).toContain('spring-cup');
  });

  it('surfaces a 404 with the registry message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(404, { error: 'not_found', message: 'Competition not found.' }))
    );

    await expect(updateCompetition(COMP.id, { name: 'x' })).rejects.toMatchObject({
      status: 404,
      message: 'Competition not found.',
    });
  });

  it('falls back to the bare status when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(500)));

    await expect(updateCompetition(COMP.id, { name: 'x' })).rejects.toMatchObject({
      status: 500,
      message: 'Could not update competition (500)',
    });
  });

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const error = await updateCompetition(COMP.id, { name: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompetitionApiError);
    expect((error as CompetitionApiError).status).toBe(0);
  });

  it('rejects an unexpected success body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, {})));

    await expect(updateCompetition(COMP.id, { name: 'x' })).rejects.toBeInstanceOf(
      CompetitionApiError
    );
  });
});

describe('deletionDate', () => {
  const DATED: PlatformCompetition = { ...COMP, deletionDate: '2026-12-12T00:00:00Z' };

  it('is accepted, mapped from the API and must be a string', () => {
    expect(isPlatformCompetition(DATED)).toBe(true);
    expect(isPlatformCompetition({ ...COMP, deletionDate: 42 })).toBe(false);
    expect(toPlatformCompetition({ ...COMP, deletionDate: '2026-12-12T00:00:00Z' })).toEqual(DATED);
    expect(toPlatformCompetition({ ...COMP, deletionDate: '' })).toEqual(COMP);
  });

  it('round-trips through storage so other tabs see an extend', () => {
    const parsed = parseActiveCompetition(serializeActiveCompetition(DATED));
    expect(parsed).toEqual(DATED);

    setActiveCompetition(DATED);
    expect(getActiveCompetition()?.deletionDate).toBe('2026-12-12T00:00:00Z');
    expect(JSON.parse(store.getItem(ACTIVE_COMPETITION_KEY) ?? '{}').deletionDate)
      .toBe('2026-12-12T00:00:00Z');
  });

  it('is left out of storage when unknown', () => {
    expect(JSON.parse(serializeActiveCompetition(COMP))).not.toHaveProperty('deletionDate');
  });
});

describe('extendCompetition', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the extend route and resolves with the updated competition', async () => {
    const fetchMock = vi.fn(async () =>
      response(200, { ...COMP, startDate: COMP.date, deletionDate: '2026-12-19T00:00:00Z' })
    );
    vi.stubGlobal('fetch', fetchMock);

    const extended = await extendCompetition('a/b');

    expect(extended).toEqual({ ...COMP, deletionDate: '2026-12-19T00:00:00Z' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${COMPETITIONS_API}/a%2Fb/extend`);
    expect(init.method).toBe('POST');
  });

  it('surfaces the API error message and status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(404, { error: 'not_found', message: 'Competition not found.' }))
    );

    const error = await extendCompetition(COMP.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompetitionApiError);
    expect((error as CompetitionApiError).status).toBe(404);
    expect((error as CompetitionApiError).message).toBe('Competition not found.');
  });

  it('maps a network failure to status 0 and a bad body to an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const offline = await extendCompetition(COMP.id).catch((e: unknown) => e);
    expect((offline as CompetitionApiError).status).toBe(0);

    vi.stubGlobal('fetch', vi.fn(async () => response(200, {})));
    await expect(extendCompetition(COMP.id)).rejects.toBeInstanceOf(CompetitionApiError);

    vi.stubGlobal('fetch', vi.fn(async () => response(500)));
    const failed = await extendCompetition(COMP.id).catch((e: unknown) => e);
    expect((failed as CompetitionApiError).status).toBe(500);
  });
});

describe('retentionInfo', () => {
  const NOW = new Date('2026-12-01T10:00:00Z');

  it('returns null without a usable date', () => {
    expect(retentionInfo(undefined, '', NOW)).toBeNull();
    expect(retentionInfo('', '', NOW)).toBeNull();
    expect(retentionInfo('not a date', '', NOW)).toBeNull();
  });

  it('counts whole days and flags the last week', () => {
    expect(retentionInfo('2026-12-31T00:00:00Z', '', NOW)).toEqual({
      day: '2026-12-31', daysLeft: 30, dueSoon: false, beforeEvent: false,
    });
    expect(retentionInfo('2026-12-09T00:00:00Z', '', NOW)?.dueSoon).toBe(false);
    expect(retentionInfo('2026-12-08T00:00:00Z', '', NOW)).toMatchObject({ daysLeft: 7, dueSoon: true });
    expect(retentionInfo('2026-12-02T00:00:00Z', '', NOW)).toMatchObject({ daysLeft: 1, dueSoon: true });
  });

  it('never goes negative once the date has passed', () => {
    expect(retentionInfo('2026-11-01T00:00:00Z', '', NOW)).toMatchObject({ daysLeft: 0, dueSoon: true });
  });

  it('flags a deletion date on or before the competition start', () => {
    expect(retentionInfo('2026-12-31T00:00:00Z', '2027-01-10', NOW)?.beforeEvent).toBe(true);
    expect(retentionInfo('2026-12-31T00:00:00Z', '2026-12-31', NOW)?.beforeEvent).toBe(true);
    expect(retentionInfo('2026-12-31T00:00:00Z', '2026-12-30', NOW)?.beforeEvent).toBe(false);
    expect(retentionInfo('2026-12-31T00:00:00Z', 'TBA', NOW)?.beforeEvent).toBe(false);
  });

  it('uses the UTC calendar day of the deletion instant', () => {
    expect(retentionInfo('2026-12-31T00:00:00Z', '', NOW)?.day).toBe('2026-12-31');
  });
});

describe('platform errors from the tool backends', () => {
  it('reads plain-text and JSON bodies', () => {
    expect(readPlatformError(410, 'platform_deleted')).toBe('platform_deleted');
    expect(readPlatformError(410, 'platform_deleted: competition was purged')).toBe('platform_deleted');
    expect(readPlatformError(410, '{"error":"platform_deleted"}')).toBe('platform_deleted');
    expect(readPlatformError(404, '{"error": "platform_not_found", "message": "x"}')).toBe('platform_not_found');
    expect(readPlatformError(404, 'platform_not_found')).toBe('platform_not_found');
    expect(readPlatformError(503, ' platform_unavailable\n')).toBe('platform_unavailable');
    expect(readPlatformError(400, 'platform_id_required')).toBe('platform_id_required');
  });

  it('ignores other codes, free text and a status that does not match', () => {
    expect(readPlatformError(404, 'Competition not found')).toBeNull();
    expect(readPlatformError(404, '{"error":"not_found"}')).toBeNull();
    expect(readPlatformError(500, 'platform_deleted')).toBeNull();
    expect(readPlatformError(410, 'the platform_deleted flag')).toBeNull();
    expect(readPlatformError(410, '')).toBeNull();
  });

  it('marks deleted and not-found as gone', () => {
    expect(isGoneCompetitionError('platform_deleted')).toBe(true);
    expect(isGoneCompetitionError('platform_not_found')).toBe(true);
    expect(isGoneCompetitionError('platform_unavailable')).toBe(false);
    expect(isGoneCompetitionError(null)).toBe(false);
  });

  it('words every code readably', () => {
    expect(platformErrorMessage('platform_deleted', 'Winter Cup')).toBe(
      '“Winter Cup” has been deleted, together with its data. '
      + 'Choose or create another competition in the top bar.'
    );
    expect(platformErrorMessage('platform_not_found')).toMatch(/^The selected competition no longer exists/);
    expect(platformErrorMessage('platform_unavailable')).toBe(
      "The competition registry can't be reached right now, try again shortly."
    );
    expect(platformErrorMessage('platform_id_required')).toBe('Select a competition in the top bar first.');
  });
});

describe('syncCompetitionSnapshot', () => {
  const OTHER: PlatformCompetition = { ...COMP, id: 'other', code: 'other-cup', name: 'Other Cup' };

  it('updates the matching entry in place, keeping fields the stored copy lacks', () => {
    const list: PlatformCompetition[] = [
      { ...COMP, createdUtc: '2026-10-01T10:00:00Z', deletionDate: '2026-11-30T00:00:00Z' },
      OTHER,
    ];
    const extended = { ...COMP, deletionDate: '2026-12-07T00:00:00Z' };

    expect(syncCompetitionSnapshot(list, extended)).toBe(true);
    expect(list[0]).toEqual({
      ...COMP, createdUtc: '2026-10-01T10:00:00Z', deletionDate: '2026-12-07T00:00:00Z',
    });
    expect(list[1]).toBe(OTHER);
  });

  it('so re-picking the entry no longer writes the stale date back', () => {
    const list: PlatformCompetition[] = [{ ...COMP, deletionDate: '2026-11-30T00:00:00Z' }];
    setActiveCompetition({ ...COMP, deletionDate: '2026-12-07T00:00:00Z' });
    syncCompetitionSnapshot(list, getActiveCompetition());

    setActiveCompetition(list[0]);   // what a click on the menu item does

    expect(getActiveCompetition()?.deletionDate).toBe('2026-12-07T00:00:00Z');
  });

  it('reports no change for null, an unknown id or identical data', () => {
    const list: PlatformCompetition[] = [{ ...COMP }];
    expect(syncCompetitionSnapshot(list, null)).toBe(false);
    expect(syncCompetitionSnapshot(list, OTHER)).toBe(false);
    expect(syncCompetitionSnapshot(list, { ...COMP })).toBe(false);
  });
});
