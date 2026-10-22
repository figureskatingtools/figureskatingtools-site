/**
 * Client for the admin API.
 *
 * Two backends answer it:
 *  - the platform Function App under `/api/manage/*` (competitions and their
 *    owners, users, the dry-run sweep, platform diagnostics, the audit log) —
 *    proxied by the router only
 *    for admins, and checked again by the platform itself;
 *  - the router itself at `/admin/api/diagnostics` (build, uptime, backend
 *    health, configuration as booleans).
 *
 * Errors follow shared-ui `competition.ts`: an `AdminApiError` carrying the
 * HTTP status (0 when unreachable), the registry's machine `error` code and
 * its human `message`, so the UI can show something useful for every failure.
 */

export const MANAGE_API = '/api/manage';
export const ROUTER_DIAGNOSTICS_API = '/admin/api/diagnostics';

export type AdminStatus = 'active' | 'deleted' | 'purged';
export type AdminStatusFilter = AdminStatus | 'all';

/** The platform's mirror row of the competition in its clock table */
export interface AdminClock {
  inSync: boolean;
  deletionDate: string | null;
  status: string | null;
  purgedUtc: string | null;
}

/** A user as the platform's directory knows them */
export interface AdminUserRef {
  userId: string;
  name: string;
  email: string;
}

/** One row of a competition's access list (owner first) */
export interface AdminGrant extends AdminUserRef {
  role: 'owner' | 'write' | 'read';
}

/** A row of `GET /api/manage/users` */
export interface AdminUser extends AdminUserRef {
  firstSeenUtc: string | null;
  lastSeenUtc: string | null;
  /** Competitions this user owns */
  owned: number;
  /** Competitions shared with this user (read or write) */
  shared: number;
  /** Linked sign-in identities (Entra tenant + object id pairs) */
  identities: number;
}

/** A competition as the admin API reports it — tombstones included */
export interface AdminCompetition {
  id: string;
  code: string;
  name: string;
  /** Start date `YYYY-MM-DD` (mirrors `startDate`) */
  date: string;
  startDate: string;
  endDate: string | null;
  venue: string;
  /** E-mail of whoever created it — history only; the owner is `owner` */
  createdBy: string | null;
  /** The access owner (list rows); null when nobody owns it, undefined when not reported */
  owner?: AdminUserRef | null;
  createdUtc: string;
  updatedUtc: string;
  /** `YYYY-MM-DDT00:00:00Z` */
  deletionDate: string;
  status: AdminStatus;
  extendedCount: number;
  lastExtendedUtc: string | null;
  deleteReason: string | null;
  deletedUtc: string | null;
  purgedUtc: string | null;
  /** null when the clock table has no row for it */
  clock: AdminClock | null;
  /** The row exactly as received, for the raw JSON view */
  raw: Record<string, unknown>;
}

export interface HovtpCounts {
  pending: number;
  accepted: number;
  expired: number;
  rejected: number;
}

export interface AdminCompetitionDetail {
  competition: AdminCompetition;
  files: { count: number; bytes: number };
  hovtp: HovtpCounts;
  /** Everyone with access, owner first */
  access: AdminGrant[];
}

/** What `PUT …/{id}/owner` answers */
export interface AdminOwnerChange {
  competition: AdminCompetition;
  access: AdminGrant[];
}

/** Fields an admin can change. Only the keys present are sent. */
export interface AdminCompetitionPatch {
  name?: string;
  code?: string;
  startDate?: string;
  endDate?: string;
  venue?: string;
  /** `YYYY-MM-DD`, on or after tomorrow (UTC) */
  deletionDate?: string;
}

export interface AuditEntry {
  id: string;
  utc: string;
  actor: string;
  action: string;
  competitionId: string | null;
  competitionCode: string | null;
  /** E-mail of the user an access change was about (share, revoke, owner change) */
  target: string | null;
  changes: Record<string, [unknown, unknown]>;
  outcome: string;
}

export interface AuditPage {
  entries: AuditEntry[];
  next: string | null;
}

export type BackendStatus = 'ok' | 'error' | 'no_health_route' | 'not_configured' | 'timeout';

export interface BackendHealth {
  name: string;
  status: BackendStatus;
  httpStatus: number | null;
  latencyMs: number | null;
}

export interface RouterDiagnostics {
  router: {
    commit: string | null;
    startedUtc: string;
    uptimeSeconds: number;
    node: string;
    nodeEnv: string;
    changelog: { entries: { branch: string; ageSeconds: number; stale: boolean }[] };
  };
  config: {
    targets: Record<string, { url: boolean; secret: boolean }>;
    hovtpHealthUrl?: boolean;
    adminCount: number;
    loginProvider: string;
    externalProviderConfigured?: boolean;
    devFakeUser: boolean;
  };
  backends: BackendHealth[];
}

export interface SweepRun {
  utc: string;
  purgeEnabled: boolean;
  dryRunManual: boolean;
  summary: Record<string, unknown>;
}

export interface PlatformDiagnostics {
  config: {
    retentionPurgeEnabled: boolean;
    hovtpEnabled: boolean | null;
    retentionDays: number;
    extensionDays: number;
    clockTable: string;
    adminLogTable: string;
    auditRetentionDays: number;
  };
  storage: { ok: boolean; error: string | null };
  counts: {
    competitions: { active: number; deleted: number; purged: number };
    dueWithin7Days: number;
    pastDeletionDate: number;
    hovtpSources: HovtpCounts;
    hovtpSessions: number;
    clockDrift: number;
  };
  sweeps: SweepRun[];
}

/** A failed admin API call */
export class AdminApiError extends Error {
  readonly status: number;
  /** The machine code from `{error: …}`, '' when there was none */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
  }
}

/* ════════════════════════════════════════════════════════════════
   Mapping — defensive, every field defaulted
   ════════════════════════════════════════════════════════════════ */

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toStatus(value: unknown): AdminStatus {
  return value === 'deleted' || value === 'purged' ? value : 'active';
}

function toClock(raw: unknown): AdminClock | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    inSync: r.inSync === true,
    deletionDate: strOrNull(r.deletionDate),
    status: strOrNull(r.status),
    purgedUtc: strOrNull(r.purgedUtc),
  };
}

export function toAdminCompetition(raw: unknown): AdminCompetition | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const startDate = str(r.startDate) || str(r.date);
  return {
    id,
    code: str(r.code),
    name: str(r.name),
    date: startDate,
    startDate,
    endDate: strOrNull(r.endDate),
    venue: str(r.venue),
    createdBy: strOrNull(r.createdBy),
    createdUtc: str(r.createdUtc),
    updatedUtc: str(r.updatedUtc),
    deletionDate: str(r.deletionDate),
    status: toStatus(r.status),
    extendedCount: num(r.extendedCount),
    lastExtendedUtc: strOrNull(r.lastExtendedUtc),
    deleteReason: strOrNull(r.deleteReason),
    deletedUtc: strOrNull(r.deletedUtc),
    purgedUtc: strOrNull(r.purgedUtc),
    clock: toClock(r.clock),
    ...(r.owner === null ? { owner: null } : r.owner !== undefined ? { owner: toAdminUserRef(r.owner) } : {}),
    raw: r,
  };
}

export function toAdminUserRef(raw: unknown): AdminUserRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const userId = str(r.userId);
  if (!userId) return null;
  return { userId, name: str(r.name), email: str(r.email) };
}

export function toAdminGrant(raw: unknown): AdminGrant | null {
  const user = toAdminUserRef(raw);
  const role = (raw as { role?: unknown } | null)?.role;
  if (!user || (role !== 'owner' && role !== 'write' && role !== 'read')) return null;
  return { ...user, role };
}

function toGrantList(raw: unknown): AdminGrant[] {
  return Array.isArray(raw) ? raw.map(toAdminGrant).filter((g): g is AdminGrant => g !== null) : [];
}

export function toAdminUser(raw: unknown): AdminUser | null {
  const user = toAdminUserRef(raw);
  if (!user) return null;
  const r = raw as Record<string, unknown>;
  return {
    ...user,
    firstSeenUtc: strOrNull(r.firstSeenUtc),
    lastSeenUtc: strOrNull(r.lastSeenUtc),
    owned: num(r.owned),
    shared: num(r.shared),
    identities: num(r.identities),
  };
}

function toHovtpCounts(raw: unknown): HovtpCounts {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    pending: num(r.pending),
    accepted: num(r.accepted),
    expired: num(r.expired),
    rejected: num(r.rejected),
  };
}

function toAuditEntry(raw: unknown): AuditEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const changes: Record<string, [unknown, unknown]> = {};
  if (r.changes && typeof r.changes === 'object' && !Array.isArray(r.changes)) {
    for (const [field, pair] of Object.entries(r.changes as Record<string, unknown>)) {
      changes[field] = Array.isArray(pair) ? [pair[0], pair[1]] : [null, pair];
    }
  }
  return {
    id,
    utc: str(r.utc),
    actor: str(r.actor),
    action: str(r.action),
    competitionId: strOrNull(r.competitionId),
    competitionCode: strOrNull(r.competitionCode),
    target: strOrNull(r.target),
    changes,
    outcome: str(r.outcome),
  };
}

/* ════════════════════════════════════════════════════════════════
   Transport
   ════════════════════════════════════════════════════════════════ */

/** The registry answers `{error: <code>, message: <human text>}` */
async function failure(resp: Response, fallback: string): Promise<AdminApiError> {
  let code = '';
  let message = '';
  try {
    const payload = await resp.json();
    code = typeof payload?.error === 'string' ? payload.error : '';
    message = typeof payload?.message === 'string' ? payload.message : '';
  } catch (_e) {
    // No JSON body (a router 404, a gateway error page) — the bare status
  }
  return new AdminApiError(resp.status, code, message || code || `${fallback} (${resp.status})`);
}

async function call(
  url: string,
  fallback: string,
  init: { method?: string; body?: unknown } = {}
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'same-origin',
    });
  } catch (_e) {
    throw new AdminApiError(0, 'unreachable', 'The admin API could not be reached.');
  }
  if (!resp.ok) throw await failure(resp, fallback);
  try {
    return await resp.json();
  } catch (_e) {
    throw new AdminApiError(resp.status, 'bad_body', 'The admin API returned a non-JSON body.');
  }
}

function competitionUrl(id: string, suffix = ''): string {
  return `${MANAGE_API}/competitions/${encodeURIComponent(id)}${suffix}`;
}

function requireCompetition(payload: unknown): AdminCompetition {
  const competition = toAdminCompetition((payload as { competition?: unknown })?.competition);
  if (!competition) throw new AdminApiError(200, 'bad_body', 'The admin API returned an unexpected body.');
  return competition;
}

/* ════════════════════════════════════════════════════════════════
   Competitions
   ════════════════════════════════════════════════════════════════ */

/** `GET /api/manage/competitions?status=…` — newest first */
export async function listAdminCompetitions(status: AdminStatusFilter): Promise<AdminCompetition[]> {
  const payload = await call(
    `${MANAGE_API}/competitions?status=${encodeURIComponent(status)}`,
    'Could not list competitions'
  );
  const rows = (payload as { competitions?: unknown })?.competitions;
  if (!Array.isArray(rows)) return [];
  return rows.map(toAdminCompetition).filter((c): c is AdminCompetition => c !== null);
}

/** `GET /api/manage/competitions/{id}` */
export async function getAdminCompetition(id: string): Promise<AdminCompetitionDetail> {
  const payload = await call(competitionUrl(id), 'Could not load the competition');
  const p = payload as { files?: { count?: unknown; bytes?: unknown }; hovtp?: unknown; access?: unknown };
  return {
    competition: requireCompetition(payload),
    files: { count: num(p?.files?.count), bytes: num(p?.files?.bytes) },
    hovtp: toHovtpCounts(p?.hovtp),
    access: toGrantList(p?.access),
  };
}

/**
 * `PUT …/{id}/owner` `{userId}` — hands the competition to another user in one
 * table transaction; the previous owner keeps write access.
 */
export async function setAdminOwner(id: string, userId: string): Promise<AdminOwnerChange> {
  const payload = await call(competitionUrl(id, '/owner'), 'Could not change the owner', {
    method: 'PUT',
    body: { userId },
  });
  return {
    competition: requireCompetition(payload),
    access: toGrantList((payload as { access?: unknown })?.access),
  };
}

/** `PATCH /api/manage/competitions/{id}` — a partial update */
export async function updateAdminCompetition(
  id: string,
  patch: AdminCompetitionPatch
): Promise<AdminCompetition> {
  return requireCompetition(
    await call(competitionUrl(id), 'Could not save the competition', { method: 'PATCH', body: patch })
  );
}

/** `POST …/{id}/restore` — the platform defaults the deletion date to today + 7 */
export async function restoreAdminCompetition(
  id: string,
  deletionDate?: string
): Promise<AdminCompetition> {
  return requireCompetition(
    await call(competitionUrl(id, '/restore'), 'Could not restore the competition', {
      method: 'POST',
      body: deletionDate ? { deletionDate } : {},
    })
  );
}

/** `POST …/{id}/purge` with the typed code — answers the tombstone */
export async function purgeAdminCompetition(id: string, confirm: string): Promise<AdminCompetition> {
  return requireCompetition(
    await call(competitionUrl(id, '/purge'), 'Could not purge the competition', {
      method: 'POST',
      body: { confirm },
    })
  );
}

/** `DELETE /api/manage/competitions/{id}` — the same soft delete users get */
export async function deleteAdminCompetition(id: string): Promise<AdminCompetition> {
  return requireCompetition(
    await call(competitionUrl(id), 'Could not delete the competition', { method: 'DELETE' })
  );
}

/* ════════════════════════════════════════════════════════════════
   Users
   ════════════════════════════════════════════════════════════════ */

/** `GET /api/manage/users` — everyone who has signed in (the user directory) */
export async function listAdminUsers(): Promise<AdminUser[]> {
  const payload = await call(`${MANAGE_API}/users`, 'Could not list users');
  const rows = (payload as { users?: unknown })?.users;
  if (!Array.isArray(rows)) return [];
  return rows.map(toAdminUser).filter((u): u is AdminUser => u !== null);
}

/** Shortest query `searchAdminUsers` sends — the API answers 400 `query_too_short` below it */
export const ADMIN_USER_SEARCH_MIN_CHARS = 3;

/**
 * `GET /api/manage/users?q=` — users whose name *or* e-mail contains `query`
 * (at most 8, full e-mails, the admin themselves included). Shorter queries
 * resolve to [] without a request.
 */
export async function searchAdminUsers(query: string): Promise<AdminUserRef[]> {
  const q = String(query ?? '').trim();
  if (q.length < ADMIN_USER_SEARCH_MIN_CHARS) return [];
  const payload = await call(`${MANAGE_API}/users?q=${encodeURIComponent(q)}`, 'User search failed');
  const rows = (payload as { users?: unknown })?.users;
  if (!Array.isArray(rows)) return [];
  return rows.map(toAdminUserRef).filter((u): u is AdminUserRef => u !== null);
}

/* ════════════════════════════════════════════════════════════════
   Sweep, diagnostics, audit
   ════════════════════════════════════════════════════════════════ */

/** `POST /api/manage/sweep/dry-run` — never purges */
export async function runDryRunSweep(): Promise<Record<string, unknown>> {
  const payload = await call(`${MANAGE_API}/sweep/dry-run`, 'Could not run the sweep', {
    method: 'POST',
  });
  const summary = (payload as { summary?: unknown })?.summary;
  return summary && typeof summary === 'object' ? (summary as Record<string, unknown>) : {};
}

/** `GET /api/manage/diagnostics` */
export async function getPlatformDiagnostics(): Promise<PlatformDiagnostics> {
  return (await call(`${MANAGE_API}/diagnostics`, 'Could not load platform diagnostics')) as PlatformDiagnostics;
}

/** `GET /admin/api/diagnostics` (router-native) */
export async function getRouterDiagnostics(): Promise<RouterDiagnostics> {
  return (await call(ROUTER_DIAGNOSTICS_API, 'Could not load router diagnostics')) as RouterDiagnostics;
}

/** `GET /api/manage/audit?before=…&limit=…` — newest first */
export async function listAudit(before: string | null, limit = 50): Promise<AuditPage> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before) query.set('before', before);
  const payload = await call(`${MANAGE_API}/audit?${query.toString()}`, 'Could not load the audit log');
  const p = payload as { entries?: unknown; next?: unknown };
  return {
    entries: Array.isArray(p?.entries)
      ? p.entries.map(toAuditEntry).filter((e): e is AuditEntry => e !== null)
      : [],
    next: strOrNull(p?.next),
  };
}
