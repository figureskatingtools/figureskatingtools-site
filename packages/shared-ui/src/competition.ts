/**
 * Central "active competition" concept shared by every tool on
 * figureskatingtools.com.
 *
 * Two independent layers live here:
 *
 *  1. **Client state** — the competition the user is currently working on.
 *     Persisted in `localStorage` under `fst:active-competition:v1` and
 *     synced across tabs through the `storage` event. Pure enough to unit
 *     test: nothing in this layer touches the DOM.
 *  2. **API client** — a thin wrapper over the platform competitions API
 *     (`/api/competitions`). Every call degrades gracefully: callers are
 *     expected to keep working when the API is not there yet.
 *
 * The active competition is always an *enhancement* (prefill, association),
 * never a blocker — tools must keep working standalone with none selected.
 */

/** A competition as stored in the platform registry */
export interface PlatformCompetition {
  /** Platform-wide GUID — the stable internal id */
  id: string;
  /** Human-facing unique code (normalized, e.g. 'winter-cup-2026') */
  code: string;
  /** Display name */
  name: string;
  /** Start date, ISO `YYYY-MM-DD` (may be empty) */
  date: string;
  /** Venue / rink (may be empty) */
  venue: string;
  /** Email of the creator, when the API reports it */
  createdBy?: string;
}

/** Fields accepted when creating a competition */
export interface NewCompetitionInput {
  name: string;
  code: string;
  date?: string;
  venue?: string;
}

/** localStorage key holding the active competition */
export const ACTIVE_COMPETITION_KEY = 'fst:active-competition:v1';

/** Base path of the platform competitions API (same origin, behind the router) */
export const COMPETITIONS_API = '/api/competitions';

/* ════════════════════════════════════════════════════════════════
   Pure helpers — no DOM, no storage, no network
   ════════════════════════════════════════════════════════════════ */

/**
 * Normalize a competition code: lowercase, non-alphanumerics collapsed into
 * single dashes, trimmed. Also used to auto-slug a code from the name.
 */
export function normalizeCompetitionCode(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Type guard for a well-formed competition object */
export function isPlatformCompetition(value: unknown): value is PlatformCompetition {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === 'string' && c.id.length > 0 &&
    typeof c.code === 'string' && c.code.length > 0 &&
    typeof c.name === 'string' &&
    typeof c.date === 'string' &&
    typeof c.venue === 'string' &&
    (c.createdBy === undefined || typeof c.createdBy === 'string')
  );
}

/**
 * Map one raw API row onto a `PlatformCompetition`.
 * The registry stores `startDate`/`endDate`; the clients only care about the
 * start date, and every optional string field defaults to ''.
 */
export function toPlatformCompetition(raw: unknown): PlatformCompetition | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  const code = typeof r.code === 'string' ? r.code : '';
  if (!id || !code) return null;
  const date =
    (typeof r.date === 'string' && r.date) ||
    (typeof r.startDate === 'string' && r.startDate) ||
    '';
  const competition: PlatformCompetition = {
    id,
    code,
    name: typeof r.name === 'string' ? r.name : code,
    date,
    venue: typeof r.venue === 'string' ? r.venue : '',
  };
  if (typeof r.createdBy === 'string') competition.createdBy = r.createdBy;
  return competition;
}

/** Parse the stored JSON blob, returning null for anything malformed */
export function parseActiveCompetition(raw: string | null): PlatformCompetition | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isPlatformCompetition(parsed) ? parsed : null;
  } catch (_e) {
    return null;
  }
}

/** Serialize for storage — only the known fields, never stray keys */
export function serializeActiveCompetition(competition: PlatformCompetition): string {
  const { id, code, name, date, venue, createdBy } = competition;
  return JSON.stringify(
    createdBy === undefined
      ? { id, code, name, date, venue }
      : { id, code, name, date, venue, createdBy }
  );
}

/** Human label for a competition — name, falling back to the code */
export function competitionLabel(competition: PlatformCompetition): string {
  return competition.name?.trim() || competition.code;
}

/* ════════════════════════════════════════════════════════════════
   Active-competition state
   ════════════════════════════════════════════════════════════════ */

type Listener = (competition: PlatformCompetition | null) => void;

const listeners = new Set<Listener>();
let storageListenerAttached = false;

/** The Storage implementation to use, or null when unavailable/blocked */
function storage(): Storage | null {
  try {
    const store = (globalThis as { localStorage?: Storage }).localStorage;
    return store ?? null;
  } catch (_e) {
    // Storage access can throw outright in locked-down browser settings
    return null;
  }
}

/** The competition the user is currently working on (null = none selected) */
export function getActiveCompetition(): PlatformCompetition | null {
  const store = storage();
  if (!store) return null;
  try {
    return parseActiveCompetition(store.getItem(ACTIVE_COMPETITION_KEY));
  } catch (_e) {
    return null;
  }
}

/** Select a competition (or pass null to clear) and notify every subscriber */
export function setActiveCompetition(competition: PlatformCompetition | null): void {
  const store = storage();
  const next = competition && isPlatformCompetition(competition) ? competition : null;
  if (store) {
    try {
      if (next) store.setItem(ACTIVE_COMPETITION_KEY, serializeActiveCompetition(next));
      else store.removeItem(ACTIVE_COMPETITION_KEY);
    } catch (_e) {
      // Quota or private-mode failure — keep going with in-memory notification
    }
  }
  notify(next);
}

/** Clear the selection */
export function clearActiveCompetition(): void {
  setActiveCompetition(null);
}

function notify(competition: PlatformCompetition | null): void {
  for (const listener of [...listeners]) {
    try {
      listener(competition);
    } catch (_e) {
      // A broken subscriber must not take the others down
    }
  }
}

/**
 * Subscribe to active-competition changes (this tab *and* other tabs).
 * Returns an unsubscribe function.
 */
export function subscribeActiveCompetition(listener: Listener): () => void {
  listeners.add(listener);
  attachStorageListener();
  return () => {
    listeners.delete(listener);
  };
}

function attachStorageListener(): void {
  if (storageListenerAttached) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  storageListenerAttached = true;
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== null && event.key !== ACTIVE_COMPETITION_KEY) return;
    notify(getActiveCompetition());
  });
}

/* ════════════════════════════════════════════════════════════════
   API client
   ════════════════════════════════════════════════════════════════ */

/** An error carrying the HTTP status of a failed competitions API call */
export class CompetitionApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CompetitionApiError';
    this.status = status;
  }
}

/** Pull the array of rows out of either `[…]` or `{competitions: […]}` */
export function extractCompetitionList(payload: unknown): PlatformCompetition[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { competitions?: unknown })?.competitions)
      ? (payload as { competitions: unknown[] }).competitions
      : null;
  if (!rows) return [];
  return rows
    .map(toPlatformCompetition)
    .filter((c): c is PlatformCompetition => c !== null);
}

/**
 * `GET /api/competitions`.
 * Throws `CompetitionApiError` when the platform API is missing or failing —
 * callers use that to hide competition UI entirely.
 */
export async function listCompetitions(): Promise<PlatformCompetition[]> {
  let resp: Response;
  try {
    resp = await fetch(COMPETITIONS_API, { headers: { Accept: 'application/json' } });
  } catch (_e) {
    throw new CompetitionApiError(0, 'Competitions API unreachable');
  }
  if (!resp.ok) {
    throw new CompetitionApiError(resp.status, `Competitions API returned ${resp.status}`);
  }
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (_e) {
    throw new CompetitionApiError(resp.status, 'Competitions API returned a non-JSON body');
  }
  return extractCompetitionList(payload);
}

/**
 * `POST /api/competitions`.
 * A duplicate code comes back as HTTP 409 — surfaced as a
 * `CompetitionApiError` with `status === 409`.
 */
export async function createCompetition(
  input: NewCompetitionInput
): Promise<PlatformCompetition> {
  const body = {
    name: input.name.trim(),
    code: normalizeCompetitionCode(input.code || input.name),
    startDate: (input.date ?? '').trim(),
    venue: (input.venue ?? '').trim(),
  };

  let resp: Response;
  try {
    resp = await fetch(COMPETITIONS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (_e) {
    throw new CompetitionApiError(0, 'Competitions API unreachable');
  }

  if (resp.status === 409) {
    throw new CompetitionApiError(409, `Competition code "${body.code}" is already in use.`);
  }
  if (!resp.ok) {
    let detail = '';
    try {
      const payload = await resp.json();
      detail = typeof payload?.error === 'string' ? payload.error : '';
    } catch (_e) {
      // No JSON body — fall back to the bare status
    }
    throw new CompetitionApiError(resp.status, detail || `Could not create competition (${resp.status})`);
  }

  const created = toPlatformCompetition(await resp.json());
  if (!created) throw new CompetitionApiError(resp.status, 'Competitions API returned an unexpected body');
  return created;
}

/**
 * Re-read the active competition from the registry on app init: keeps a
 * renamed competition current and drops one that has been deleted.
 * Silently does nothing when the API is unavailable.
 */
export async function refreshActiveCompetition(): Promise<PlatformCompetition | null> {
  const current = getActiveCompetition();
  if (!current) return null;
  let all: PlatformCompetition[];
  try {
    all = await listCompetitions();
  } catch (_e) {
    // Offline or API not deployed — keep whatever we have
    return current;
  }
  const fresh = all.find((c) => c.id === current.id) ?? null;
  if (!fresh) {
    clearActiveCompetition();
    return null;
  }
  if (serializeActiveCompetition(fresh) !== serializeActiveCompetition(current)) {
    setActiveCompetition(fresh);
  }
  return fresh;
}
