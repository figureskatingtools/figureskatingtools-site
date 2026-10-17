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

/**
 * The caller's role on a competition. `read` = view and download only,
 * `write` = everything except deleting and sharing, `owner` = everything
 * (admins always read as `owner`).
 */
export type CompetitionAccess = 'owner' | 'write' | 'read';

/** A role that can be granted to someone else */
export type ShareRole = 'read' | 'write';

/** A signed-in user of the site, as the platform's user directory knows them */
export interface UserRef {
  /** Platform-internal user id (GUID) — never an e-mail */
  userId: string;
  /** Display name ('' when unknown) */
  name: string;
  /** E-mail ('' when unknown) */
  email: string;
}

/** One row of a competition's access list */
export interface AccessGrant extends UserRef {
  role: CompetitionAccess;
}

/** The signed-in user as the platform sees them (`GET /api/users/me`) */
export interface PlatformMe extends UserRef {
  isAdmin: boolean;
}

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
  /** Creation timestamp (ISO UTC), when the API reports it */
  createdUtc?: string;
  /**
   * When the platform deletes the competition's data — midnight UTC as
   * `YYYY-MM-DDT00:00:00Z`. Server-owned: 60 days after creation, moved only
   * by `extendCompetition` (and pulled to the next midnight by a delete).
   */
  deletionDate?: string;
  /**
   * The caller's role. Absent from an older API (and from a selection stored
   * before sharing existed) — read that as `owner`, the pre-sharing behaviour;
   * the backends enforce the real role either way.
   */
  access?: CompetitionAccess;
  /** The owner, or null for a legacy competition nobody has claimed yet */
  owner?: UserRef | null;
}

/** Fields accepted when creating a competition */
export interface NewCompetitionInput {
  name: string;
  code: string;
  date?: string;
  venue?: string;
}

/** Fields accepted when editing a competition — only the keys present are sent */
export interface UpdateCompetitionInput {
  name?: string;
  code?: string;
  date?: string;
  venue?: string;
}

/** localStorage key holding the active competition */
export const ACTIVE_COMPETITION_KEY = 'fst:active-competition:v1';

/** Base path of the platform competitions API (same origin, behind the router) */
export const COMPETITIONS_API = '/api/competitions';

/** Base path of the platform user directory API (share picker, `me`) */
export const USERS_API = '/api/users';

/** Shortest query `searchUsers` sends — the API answers 400 below it */
export const USER_SEARCH_MIN_CHARS = 3;

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

const ACCESS_VALUES: readonly CompetitionAccess[] = ['owner', 'write', 'read'];

/** True for one of the three roles */
export function isCompetitionAccess(value: unknown): value is CompetitionAccess {
  return typeof value === 'string' && (ACCESS_VALUES as readonly string[]).includes(value);
}

/** Map a raw `{userId, name, email}` object; null when it has no user id */
export function toUserRef(raw: unknown): UserRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const userId = typeof r.userId === 'string' ? r.userId : '';
  if (!userId) return null;
  return {
    userId,
    name: typeof r.name === 'string' ? r.name : '',
    email: typeof r.email === 'string' ? r.email : '',
  };
}

/** Map a raw grant row; null when the user id or the role is unusable */
export function toAccessGrant(raw: unknown): AccessGrant | null {
  const user = toUserRef(raw);
  const role = (raw as { role?: unknown } | null)?.role;
  if (!user || !isCompetitionAccess(role)) return null;
  return { ...user, role };
}

function isUserRefShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const u = value as Record<string, unknown>;
  return typeof u.userId === 'string' && typeof u.name === 'string' && typeof u.email === 'string';
}

/** The caller's effective role — `owner` when the API did not say */
export function competitionAccess(competition: PlatformCompetition | null | undefined): CompetitionAccess {
  return competition?.access ?? 'owner';
}

/** View and download only: every write control is hidden for this competition */
export function isReadOnlyCompetition(competition: PlatformCompetition | null | undefined): boolean {
  return competitionAccess(competition) === 'read';
}

/** Owner (or admin): may delete the competition and manage who it is shared with */
export function canManageCompetition(competition: PlatformCompetition | null | undefined): boolean {
  return competitionAccess(competition) === 'owner';
}

/** Short label for the owner: name, falling back to the e-mail */
export function ownerLabel(owner: UserRef | null | undefined): string {
  if (!owner) return '';
  return owner.name.trim() || owner.email.trim();
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
    (c.createdBy === undefined || typeof c.createdBy === 'string') &&
    (c.createdUtc === undefined || typeof c.createdUtc === 'string') &&
    (c.deletionDate === undefined || typeof c.deletionDate === 'string') &&
    (c.access === undefined || isCompetitionAccess(c.access)) &&
    (c.owner === undefined || c.owner === null || isUserRefShape(c.owner))
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
  if (typeof r.createdUtc === 'string') competition.createdUtc = r.createdUtc;
  if (typeof r.deletionDate === 'string' && r.deletionDate) competition.deletionDate = r.deletionDate;
  if (isCompetitionAccess(r.access)) competition.access = r.access;
  if (r.owner === null) competition.owner = null;
  else if (r.owner !== undefined) {
    const owner = toUserRef(r.owner);
    if (owner) competition.owner = owner;
  }
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

/**
 * Serialize for storage — only the known fields, never stray keys.
 * `deletionDate` is included so an extend in one tab reaches every other tab
 * through the `storage` event; `access` and `owner` likewise, so a role the
 * owner changes reaches every open tool once the selection is refreshed.
 */
export function serializeActiveCompetition(competition: PlatformCompetition): string {
  const { id, code, name, date, venue, createdBy, deletionDate, access, owner } = competition;
  const stored: Record<string, unknown> = { id, code, name, date, venue };
  if (createdBy !== undefined) stored.createdBy = createdBy;
  if (deletionDate !== undefined) stored.deletionDate = deletionDate;
  if (access !== undefined) stored.access = access;
  if (owner === null) stored.owner = null;
  else if (owner) stored.owner = { userId: owner.userId, name: owner.name, email: owner.email };
  return JSON.stringify(stored);
}

/** How close a deletion date is — see `retentionInfo` */
export interface RetentionInfo {
  /** The deletion day, ISO `YYYY-MM-DD` (UTC — the platform's calendar day) */
  day: string;
  /** Whole days until the deletion date; 0 once it is today or past */
  daysLeft: number;
  /** Deletion is at most `RETENTION_WARN_DAYS` away */
  dueSoon: boolean;
  /** Deletion falls on or before the competition's start date */
  beforeEvent: boolean;
}

/** Days before deletion from which the UI warns (and nudges to extend) */
export const RETENTION_WARN_DAYS = 7;

const DAY_MS = 24 * 3600 * 1000;

/**
 * Pure summary of a deletion date for display. `null` when there is no usable
 * date (older API, or a malformed value) — callers then show nothing.
 *
 * The clock counts from creation, so for a competition created long before
 * the event the deletion date can fall before the competition itself —
 * `beforeEvent` lets the UI say so.
 */
export function retentionInfo(
  deletionDate: string | null | undefined,
  startDate: string | null | undefined,
  now: Date = new Date()
): RetentionInfo | null {
  if (!deletionDate) return null;
  const due = Date.parse(deletionDate);
  if (!Number.isFinite(due)) return null;
  const day = new Date(due).toISOString().slice(0, 10);
  const daysLeft = Math.max(0, Math.ceil((due - now.getTime()) / DAY_MS));
  const start = /^\d{4}-\d{2}-\d{2}$/.test(startDate ?? '') ? (startDate as string) : '';
  return {
    day,
    daysLeft,
    dueSoon: daysLeft <= RETENTION_WARN_DAYS,
    beforeEvent: start !== '' && day <= start,
  };
}

/**
 * Fold the active competition into a list snapshot (the nav selector's menu,
 * the home panel's recent list). Without it an Extend, a rename or a change
 * arriving from another tab leaves the snapshot stale — and picking that
 * entry again would write the stale copy back as the active competition.
 * Mutates `list` in place; true when an entry changed.
 */
export function syncCompetitionSnapshot(
  list: PlatformCompetition[],
  active: PlatformCompetition | null
): boolean {
  if (!active) return false;
  const index = list.findIndex((c) => c.id === active.id);
  if (index < 0) return false;
  // Spread keeps what the stored copy lacks (createdUtc) from the list entry
  const merged = { ...list[index], ...active };
  if (JSON.stringify(merged) === JSON.stringify(list[index])) return false;
  list[index] = merged;
  return true;
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
  /** The API's machine code (`read_only`, `user_not_found`, …), '' when unknown */
  readonly code: string;

  constructor(status: number, message: string, code = '') {
    super(message);
    this.name = 'CompetitionApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Turn a failed response into a `CompetitionApiError`, preferring the
 * registry's `{error: <code>, message: <human text>}` body.
 */
async function errorFromResponse(resp: Response, fallback: string): Promise<CompetitionApiError> {
  let code = '';
  let message = '';
  try {
    const payload = await resp.json();
    code = typeof payload?.error === 'string' ? payload.error : '';
    message = typeof payload?.message === 'string' ? payload.message : '';
  } catch (_e) {
    // No JSON body — fall back to the bare status
  }
  return new CompetitionApiError(resp.status, message || code || `${fallback} (${resp.status})`, code);
}

/** `fetch` that maps a network failure onto status 0 */
async function callApi(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
    });
  } catch (_e) {
    throw new CompetitionApiError(0, 'Competitions API unreachable');
  }
}

/** Parse a JSON success body, or throw */
async function jsonBody(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch (_e) {
    throw new CompetitionApiError(resp.status, 'Competitions API returned a non-JSON body');
  }
}

/** Pull `{items: […]}` through `map`, dropping unusable rows */
function itemsOf<T>(payload: unknown, map: (raw: unknown) => T | null): T[] {
  const rows = (payload as { items?: unknown })?.items;
  if (!Array.isArray(rows)) return [];
  return rows.map(map).filter((x): x is T => x !== null);
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
 * `DELETE /api/competitions/{id}`.
 *
 * The registry deletes **softly**: the row survives with `status: "deleted"`
 * (so a tool that stored the GUID keeps resolving it) but drops out of the
 * list and frees its code for reuse. Deleting twice is not an error.
 *
 * Resolves on success; throws `CompetitionApiError` otherwise (404 when the
 * competition is already gone, 0 when the API is unreachable).
 */
export async function deleteCompetition(id: string): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(`${COMPETITIONS_API}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
  } catch (_e) {
    throw new CompetitionApiError(0, 'Competitions API unreachable');
  }

  if (!resp.ok) {
    let detail = '';
    try {
      const payload = await resp.json();
      // The registry answers `{error: <code>, message: <human text>}`
      detail =
        (typeof payload?.message === 'string' && payload.message) ||
        (typeof payload?.error === 'string' && payload.error) ||
        '';
    } catch (_e) {
      // No JSON body — fall back to the bare status
    }
    throw new CompetitionApiError(
      resp.status,
      detail || `Could not delete competition (${resp.status})`
    );
  }
}

/**
 * `PATCH /api/competitions/{id}`.
 *
 * A partial update: only the keys present in `input` are sent, so an edit form
 * can post just what the user actually changed. Renaming the **code** moves the
 * registry's `CODE` row, which is what makes a 409 possible here too —
 * surfaced as a `CompetitionApiError` with `status === 409`.
 *
 * Resolves with the full competition as the registry now stores it.
 */
export async function updateCompetition(
  id: string,
  input: UpdateCompetitionInput
): Promise<PlatformCompetition> {
  const body: Record<string, string> = {};
  if ('name' in input) body.name = (input.name ?? '').trim();
  if ('code' in input) body.code = normalizeCompetitionCode(input.code ?? '');
  if ('date' in input) body.startDate = (input.date ?? '').trim();
  if ('venue' in input) body.venue = (input.venue ?? '').trim();

  let resp: Response;
  try {
    resp = await fetch(`${COMPETITIONS_API}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
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
      // The registry answers `{error: <code>, message: <human text>}`
      detail =
        (typeof payload?.message === 'string' && payload.message) ||
        (typeof payload?.error === 'string' && payload.error) ||
        '';
    } catch (_e) {
      // No JSON body — fall back to the bare status
    }
    throw new CompetitionApiError(
      resp.status,
      detail || `Could not update competition (${resp.status})`
    );
  }

  const updated = toPlatformCompetition(await resp.json());
  if (!updated) {
    throw new CompetitionApiError(resp.status, 'Competitions API returned an unexpected body');
  }
  return updated;
}

/**
 * `POST /api/competitions/{id}/extend`.
 *
 * Pushes the competition's deletion date a week out (from the current date,
 * or from today when that has already passed). No cap — each press is one
 * more week. Resolves with the competition as the registry now stores it, so
 * the caller can hand it to `setActiveCompetition` and every tab follows.
 *
 * Throws `CompetitionApiError` (404 when the competition is deleted or
 * unknown, 0 when the API is unreachable).
 */
export async function extendCompetition(id: string): Promise<PlatformCompetition> {
  let resp: Response;
  try {
    resp = await fetch(`${COMPETITIONS_API}/${encodeURIComponent(id)}/extend`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
  } catch (_e) {
    throw new CompetitionApiError(0, 'Competitions API unreachable');
  }

  if (!resp.ok) {
    let detail = '';
    try {
      const payload = await resp.json();
      detail =
        (typeof payload?.message === 'string' && payload.message) ||
        (typeof payload?.error === 'string' && payload.error) ||
        '';
    } catch (_e) {
      // No JSON body — fall back to the bare status
    }
    throw new CompetitionApiError(
      resp.status,
      detail || `Could not extend the deletion date (${resp.status})`
    );
  }

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (_e) {
    throw new CompetitionApiError(resp.status, 'Competitions API returned a non-JSON body');
  }
  const extended = toPlatformCompetition(payload);
  if (!extended) {
    throw new CompetitionApiError(resp.status, 'Competitions API returned an unexpected body');
  }
  return extended;
}

/* ════════════════════════════════════════════════════════════════
   Sharing — access list and the user directory
   ════════════════════════════════════════════════════════════════ */

function accessUrl(competitionId: string, userId?: string): string {
  const base = `${COMPETITIONS_API}/${encodeURIComponent(competitionId)}/access`;
  return userId === undefined ? base : `${base}/${encodeURIComponent(userId)}`;
}

/**
 * `GET /api/competitions/{id}/access` (owner/admin) — everyone with access,
 * owner first. 403 `owner_required` for anyone else.
 */
export async function listAccess(competitionId: string): Promise<AccessGrant[]> {
  const resp = await callApi(accessUrl(competitionId));
  if (!resp.ok) throw await errorFromResponse(resp, 'Could not load who has access');
  return itemsOf(await jsonBody(resp), toAccessGrant);
}

/**
 * `PUT /api/competitions/{id}/access/{userId}` — share with someone, or change
 * their role. The owner row and yourself cannot be targeted (400).
 */
export async function setAccess(
  competitionId: string,
  userId: string,
  role: ShareRole
): Promise<AccessGrant> {
  const resp = await callApi(accessUrl(competitionId, userId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!resp.ok) throw await errorFromResponse(resp, 'Could not share the competition');
  const grant = toAccessGrant((await jsonBody(resp) as { item?: unknown })?.item);
  if (!grant) throw new CompetitionApiError(resp.status, 'Competitions API returned an unexpected body');
  return grant;
}

/** What `removeAccess` reports back */
export interface RemoveAccessResult {
  userId: string;
  /** True when the caller removed their own access (left the competition) */
  left: boolean;
}

/**
 * `DELETE /api/competitions/{id}/access/{userId}` — the owner takes someone's
 * access away; `userId` `'me'` is a grantee leaving (see `leaveCompetition`).
 */
export async function removeAccess(competitionId: string, userId: string): Promise<RemoveAccessResult> {
  const resp = await callApi(accessUrl(competitionId, userId), { method: 'DELETE' });
  if (!resp.ok) throw await errorFromResponse(resp, 'Could not remove the access');
  let payload: Record<string, unknown> = {};
  try {
    payload = (await resp.json()) ?? {};
  } catch (_e) {
    // The removal happened; the body is a courtesy
  }
  return {
    userId: typeof payload.userId === 'string' ? payload.userId : userId,
    left: payload.left === true,
  };
}

/** A grantee removes their own access to a competition shared with them */
export function leaveCompetition(competitionId: string): Promise<RemoveAccessResult> {
  return removeAccess(competitionId, 'me');
}

/**
 * `GET /api/users/search?q=` — signed-in users whose name or e-mail contains
 * `query` (at most 8, never yourself). Queries shorter than
 * `USER_SEARCH_MIN_CHARS` resolve to [] without a request; 429
 * `rate_limited` surfaces as a `CompetitionApiError`.
 */
export async function searchUsers(query: string): Promise<UserRef[]> {
  const q = String(query ?? '').trim();
  if (q.length < USER_SEARCH_MIN_CHARS) return [];
  const resp = await callApi(`${USERS_API}/search?q=${encodeURIComponent(q)}`);
  if (!resp.ok) throw await errorFromResponse(resp, 'User search failed');
  return itemsOf(await jsonBody(resp), toUserRef);
}

/** `GET /api/users/recent` — people you have shared with before (quick picks) */
export async function recentShareUsers(): Promise<UserRef[]> {
  const resp = await callApi(`${USERS_API}/recent`);
  if (!resp.ok) throw await errorFromResponse(resp, 'Could not load recent people');
  return itemsOf(await jsonBody(resp), toUserRef);
}

/** `GET /api/users/me` — the platform's view of the signed-in user */
export async function getMe(): Promise<PlatformMe> {
  const resp = await callApi(`${USERS_API}/me`);
  if (!resp.ok) throw await errorFromResponse(resp, 'Could not load your account');
  const payload = await jsonBody(resp);
  const user = toUserRef(payload);
  if (!user) throw new CompetitionApiError(resp.status, 'Competitions API returned an unexpected body');
  return { ...user, isAdmin: (payload as { isAdmin?: unknown }).isAdmin === true };
}

/* ════════════════════════════════════════════════════════════════
   Tool backend errors about the platform competition
   ════════════════════════════════════════════════════════════════ */

/**
 * Machine codes the tool backends answer when the platform competition behind
 * a request is the problem (they read the platform's clock row and access
 * tables directly).
 */
export type PlatformErrorCode =
  | 'platform_id_required'
  | 'platform_not_found'
  | 'platform_deleted'
  | 'platform_read_only'
  | 'platform_unavailable';

const PLATFORM_ERROR_STATUS: Record<PlatformErrorCode, number> = {
  platform_id_required: 400,
  platform_not_found: 404,
  platform_deleted: 410,
  platform_read_only: 403,
  platform_unavailable: 503,
};

/**
 * Recognise one of those codes in a failed tool response. Tools answer either
 * a plain-text body that starts with the code (Judge Papers, Score Modifier)
 * or JSON `{"error": "<code>"}` (Protocol Generator); the HTTP status must
 * match too, so free text that merely mentions a code is not misread.
 */
export function readPlatformError(status: number, body: string): PlatformErrorCode | null {
  const text = String(body ?? '').trim();
  let code = '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === 'string') code = parsed.error;
  } catch (_e) {
    code = text.split(/[^a-z_]/, 1)[0];
  }
  if (!(code in PLATFORM_ERROR_STATUS)) return null;
  const known = code as PlatformErrorCode;
  return PLATFORM_ERROR_STATUS[known] === status ? known : null;
}

/**
 * True for the codes after which the selection should be dropped.
 * `platform_read_only` is not one: the competition is still there, the caller
 * just may not change it.
 */
export function isGoneCompetitionError(code: PlatformErrorCode | null): boolean {
  return code === 'platform_deleted' || code === 'platform_not_found';
}

/** The one wording every tool shows for these codes */
export function platformErrorMessage(code: PlatformErrorCode, label = ''): string {
  const name = label.trim() ? `“${label.trim()}”` : 'The selected competition';
  switch (code) {
    case 'platform_deleted':
      return `${name} has been deleted, together with its data. ` +
        'Choose or create another competition in the top bar.';
    case 'platform_not_found':
      return `${name} no longer exists, or it is no longer shared with you. ` +
        'Choose or create another competition in the top bar.';
    case 'platform_read_only':
      return `You have view-only access to ${label.trim() ? name : 'this competition'}. ` +
        'Ask the owner for write access to make changes.';
    case 'platform_unavailable':
      return "The competition registry can't be reached right now, try again shortly.";
    case 'platform_id_required':
      return 'Select a competition in the top bar first.';
  }
}

/**
 * Re-read the active competition from the registry on app init: keeps a
 * renamed competition current — its `access` and `owner` too, so a role the
 * owner changed takes effect — and drops one that has been deleted or is no
 * longer shared with the caller.
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
