/**
 * Unit tests for the active-competition state logic.
 *
 * Everything exercised here is deliberately DOM-free: the module reads
 * `globalThis.localStorage`, so a tiny in-memory Storage stand-in is enough
 * and the tests run in vitest's default node environment.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACTIVE_COMPETITION_KEY,
  clearActiveCompetition,
  competitionLabel,
  extractCompetitionList,
  getActiveCompetition,
  isPlatformCompetition,
  normalizeCompetitionCode,
  parseActiveCompetition,
  serializeActiveCompetition,
  setActiveCompetition,
  subscribeActiveCompetition,
  toPlatformCompetition,
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
