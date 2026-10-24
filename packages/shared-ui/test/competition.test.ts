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
  createCompetition,
  extractCompetitionList,
  getActiveCompetition,
  listCompetitions,
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
  canManageCompetition,
  competitionAccess,
  getMe,
  isReadOnlyCompetition,
  leaveCompetition,
  listAccess,
  ownerLabel,
  recentShareUsers,
  refreshActiveCompetition,
  removeAccess,
  searchHitEmail,
  searchUsers,
  setAccess,
  toUserSearchHit,
  userRefToSearchHit,
  USERS_API,
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

describe('listCompetitions / createCompetition errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const pending = { error: 'migration_pending', message: 'Sign-in with this account is not available yet.' };

  it('list keeps the registry code and message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(503, pending)));

    await expect(listCompetitions()).rejects.toMatchObject({
      name: 'CompetitionApiError',
      status: 503,
      code: 'migration_pending',
      message: pending.message,
    });
  });

  it('create shows the registry message, not the bare code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(503, pending)));

    await expect(
      createCompetition({ name: 'Cup', code: 'CUP', date: '2026-11-01', venue: '' })
    ).rejects.toMatchObject({ status: 503, code: 'migration_pending', message: pending.message });
  });

  it('list falls back to the bare status when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(500)));

    await expect(listCompetitions()).rejects.toMatchObject({
      status: 500,
      code: '',
      message: 'Competitions API returned an error (500)',
    });
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

  it('reads the owner-only refusal (403) in both body shapes', () => {
    expect(readPlatformError(403, '{"error":"platform_owner_required"}')).toBe('platform_owner_required');
    expect(readPlatformError(403, '{"error": "platform_owner_required", "message": "x"}'))
      .toBe('platform_owner_required');
    expect(readPlatformError(403, 'platform_owner_required')).toBe('platform_owner_required');
    expect(readPlatformError(403, 'platform_owner_required: only the owner may delete')).toBe('platform_owner_required');
    // The status must match: another status is not this code
    expect(readPlatformError(401, '{"error":"platform_owner_required"}')).toBeNull();
    expect(readPlatformError(410, 'platform_owner_required')).toBeNull();
    // …and it stays distinct from the view-only refusal on the same status
    expect(readPlatformError(403, 'platform_read_only')).toBe('platform_read_only');
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
    expect(isGoneCompetitionError('platform_read_only')).toBe(false);
    expect(isGoneCompetitionError('platform_owner_required')).toBe(false);
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
    expect(platformErrorMessage('platform_owner_required', 'Winter Cup')).toBe(
      "Only the competition's owner can do this."
    );
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

describe('access and owner', () => {
  const OWNER = { userId: 'u-owner', name: 'Olli Owner', email: 'olli@example.com' };

  it('maps access and owner from the API and validates them', () => {
    const shared = toPlatformCompetition({ ...COMP, access: 'read', owner: OWNER });
    expect(shared).toEqual({ ...COMP, access: 'read', owner: OWNER });
    expect(isPlatformCompetition(shared)).toBe(true);

    expect(toPlatformCompetition({ ...COMP, access: 'owner', owner: null })?.owner).toBeNull();
    // Unknown roles and broken owners are dropped, not trusted
    const junk = toPlatformCompetition({ ...COMP, access: 'admin', owner: { name: 'x' } });
    expect(junk).not.toHaveProperty('access');
    expect(junk).not.toHaveProperty('owner');

    expect(isPlatformCompetition({ ...COMP, access: 'admin' })).toBe(false);
    expect(isPlatformCompetition({ ...COMP, owner: { userId: 1 } })).toBe(false);
    expect(isPlatformCompetition({ ...COMP, owner: null })).toBe(true);
  });

  it('round-trips through storage, dropping stray owner keys', () => {
    const withOwner = {
      ...COMP, access: 'write', owner: { ...OWNER, secret: 'x' },
    } as unknown as PlatformCompetition;
    const parsed = parseActiveCompetition(serializeActiveCompetition(withOwner));
    expect(parsed).toEqual({ ...COMP, access: 'write', owner: OWNER });
    expect(parseActiveCompetition(serializeActiveCompetition({ ...COMP, owner: null }))?.owner).toBeNull();
  });

  it('reads a missing role as owner (pre-sharing selection or API)', () => {
    expect(competitionAccess(COMP)).toBe('owner');
    expect(competitionAccess(null)).toBe('owner');
    expect(isReadOnlyCompetition(COMP)).toBe(false);
    expect(isReadOnlyCompetition({ ...COMP, access: 'read' })).toBe(true);
    expect(canManageCompetition({ ...COMP, access: 'write' })).toBe(false);
    expect(canManageCompetition({ ...COMP, access: 'owner' })).toBe(true);
  });

  it('labels the owner by name, then e-mail', () => {
    expect(ownerLabel(OWNER)).toBe('Olli Owner');
    expect(ownerLabel({ ...OWNER, name: ' ' })).toBe('olli@example.com');
    expect(ownerLabel(null)).toBe('');
  });

  describe('refreshActiveCompetition', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('picks up a role change for the active competition', async () => {
      setActiveCompetition({ ...COMP, access: 'write', owner: OWNER });
      vi.stubGlobal('fetch', vi.fn(async () => response(200, [{ ...COMP, access: 'read', owner: OWNER }])));

      await refreshActiveCompetition();

      expect(getActiveCompetition()?.access).toBe('read');
    });

    it('drops a competition that is no longer shared with the caller', async () => {
      setActiveCompetition({ ...COMP, access: 'read', owner: OWNER });
      vi.stubGlobal('fetch', vi.fn(async () => response(200, [])));

      expect(await refreshActiveCompetition()).toBeNull();
      expect(getActiveCompetition()).toBeNull();
    });
  });
});

describe('sharing clients', () => {
  const ANNA = { userId: 'u-anna', name: 'Anna', email: 'anna@example.com' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listAccess GETs the access route and keeps only usable grants', async () => {
    const fetchMock = vi.fn(async () => response(200, {
      items: [
        { userId: 'u-owner', name: 'Olli', email: 'olli@example.com', role: 'owner' },
        { ...ANNA, role: 'read' },
        { userId: '', name: 'Broken', email: '', role: 'read' },
        { userId: 'u-x', name: 'X', email: '', role: 'admin' },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const grants = await listAccess('a/b');

    expect(grants.map((g) => [g.userId, g.role])).toEqual([['u-owner', 'owner'], ['u-anna', 'read']]);
    expect(fetchMock.mock.calls[0][0]).toBe(`${COMPETITIONS_API}/a%2Fb/access`);
  });

  it('listAccess surfaces owner_required with its code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      response(403, { error: 'owner_required', message: 'Only the owner can do that.' })));

    const error = await listAccess(COMP.id).catch((e: unknown) => e) as CompetitionApiError;
    expect(error).toBeInstanceOf(CompetitionApiError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('owner_required');
    expect(error.message).toBe('Only the owner can do that.');
  });

  it('setAccess PUTs the role and resolves with the grant', async () => {
    const fetchMock = vi.fn(async () => response(200, { item: { ...ANNA, role: 'write' } }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await setAccess(COMP.id, 'u-anna', 'write')).toEqual({ ...ANNA, role: 'write' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${COMPETITIONS_API}/${COMP.id}/access/u-anna`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ role: 'write' });
  });

  it('setAccess maps share errors and a bad body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      response(400, { error: 'cannot_change_owner', message: 'The owner keeps full access.' })));
    const error = await setAccess(COMP.id, 'u-owner', 'read').catch((e: unknown) => e) as CompetitionApiError;
    expect(error.code).toBe('cannot_change_owner');

    vi.stubGlobal('fetch', vi.fn(async () => response(200, { item: { userId: 'u', role: 'boss' } })));
    await expect(setAccess(COMP.id, 'u', 'read')).rejects.toBeInstanceOf(CompetitionApiError);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const offline = await setAccess(COMP.id, 'u', 'read').catch((e: unknown) => e) as CompetitionApiError;
    expect(offline.status).toBe(0);
  });

  it('removeAccess DELETEs a grant; leaveCompetition targets "me"', async () => {
    const fetchMock = vi.fn(async () => response(200, { status: 'removed', userId: 'u-me', left: true }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await leaveCompetition(COMP.id)).toEqual({ userId: 'u-me', left: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${COMPETITIONS_API}/${COMP.id}/access/me`);
    expect(init.method).toBe('DELETE');

    vi.stubGlobal('fetch', vi.fn(async () => response(200)));
    expect(await removeAccess(COMP.id, 'u-anna')).toEqual({ userId: 'u-anna', left: false });

    vi.stubGlobal('fetch', vi.fn(async () =>
      response(404, { error: 'grant_not_found', message: 'No such grant.' })));
    const error = await removeAccess(COMP.id, 'u-x').catch((e: unknown) => e) as CompetitionApiError;
    expect([error.status, error.code]).toEqual([404, 'grant_not_found']);
  });

  it('searchUsers skips short queries, encodes the query and maps hits', async () => {
    const masked = { userId: 'u-aino', name: 'Aino', email: null, emailHint: 'a•••@club.fi' };
    const fetchMock = vi.fn(async () => response(200, {
      items: [{ ...ANNA, emailHint: 'a•••@example.com' }, masked, { name: 'no id' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await searchUsers(' an ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    expect(await searchUsers('anna & co')).toEqual([
      { ...ANNA, emailHint: 'a•••@example.com' },
      masked,
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe(`${USERS_API}/search?q=anna%20%26%20co`);
  });

  it('toUserSearchHit maps a hit and reads a missing or empty e-mail as null', () => {
    expect(toUserSearchHit({ userId: 'u-1', name: 'Aino', email: null, emailHint: 'a•••@club.fi' }))
      .toEqual({ userId: 'u-1', name: 'Aino', email: null, emailHint: 'a•••@club.fi' });
    expect(toUserSearchHit({ userId: 'u-1', name: 'Aino', email: '' }))
      .toEqual({ userId: 'u-1', name: 'Aino', email: null, emailHint: '' });
    expect(toUserSearchHit({ userId: 'u-1', email: 'aino@club.fi', emailHint: 7 }))
      .toEqual({ userId: 'u-1', name: '', email: 'aino@club.fi', emailHint: '' });
    expect(toUserSearchHit({ name: 'no id', email: 'x@y.fi' })).toBeNull();
    expect(toUserSearchHit(null)).toBeNull();
    expect(toUserSearchHit('u-1')).toBeNull();
  });

  it('searchHitEmail prefers the full e-mail and falls back to the masked hint', () => {
    expect(searchHitEmail({ email: 'aino@club.fi', emailHint: 'a•••@club.fi' })).toBe('aino@club.fi');
    expect(searchHitEmail({ email: null, emailHint: 'a•••@club.fi' })).toBe('a•••@club.fi');
    expect(searchHitEmail({ email: null, emailHint: '' })).toBe('');
  });

  it('userRefToSearchHit keeps a known full e-mail', () => {
    expect(userRefToSearchHit(ANNA)).toEqual({ ...ANNA, emailHint: '' });
    expect(userRefToSearchHit({ userId: 'u-x', name: 'X', email: '' }))
      .toEqual({ userId: 'u-x', name: 'X', email: null, emailHint: '' });
  });

  it('searchUsers surfaces rate limiting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      response(429, { error: 'rate_limited', message: 'Too many searches; wait a moment.' })));
    const error = await searchUsers('anna').catch((e: unknown) => e) as CompetitionApiError;
    expect([error.status, error.code]).toEqual([429, 'rate_limited']);
  });

  it('recentShareUsers and getMe read the user routes', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/recent')
        ? response(200, { items: [ANNA] })
        : response(200, { userId: 'u-me', name: 'Me', email: 'me@example.com', isAdmin: true }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await recentShareUsers()).toEqual([ANNA]);
    expect(await getMe()).toEqual({ userId: 'u-me', name: 'Me', email: 'me@example.com', isAdmin: true });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`${USERS_API}/recent`, `${USERS_API}/me`]);
  });
});

describe('platform_read_only', () => {
  it('is recognised at 403 only, in both body shapes', () => {
    expect(readPlatformError(403, 'platform_read_only')).toBe('platform_read_only');
    expect(readPlatformError(403, '{"error":"platform_read_only"}')).toBe('platform_read_only');
    expect(readPlatformError(404, 'platform_read_only')).toBeNull();
  });

  it('keeps the selection (not a gone competition) and words it', () => {
    expect(isGoneCompetitionError('platform_read_only')).toBe(false);
    expect(platformErrorMessage('platform_read_only', 'Winter Cup')).toBe(
      'You have view-only access to “Winter Cup”. Ask the owner for write access to make changes.'
    );
    expect(platformErrorMessage('platform_read_only')).toMatch(/^You have view-only access to this competition\./);
  });
});
