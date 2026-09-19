/**
 * Client for the platform **HOVTP data sources**
 * (`/api/competitions/{id}/hovtp/sources`).
 *
 * FS Manager pushes ODF messages and PDFs straight at the HOVTP listener, but
 * it sends no credentials: trust is per source IP, and that IP changes. A new
 * IP is *quarantined* — its files are kept aside and the competition owner is
 * asked to accept the source for 1, 2, 3 or 7 days. Accepting attaches every
 * quarantined file to the competition's file pool; rejecting throws them away
 * (the source can still be accepted later); revoking keeps the files already
 * attached but refuses new data.
 *
 * Errors follow `competition.ts`: a `CompetitionApiError` with the HTTP status,
 * or status 0 when the API is unreachable — callers hide the section rather
 * than failing the page.
 */

import { COMPETITIONS_API, CompetitionApiError } from './competition.js';

/**
 * Where a source stands right now.
 *
 * `expired` is computed by the API from an accepted source's window having
 * run out — the UI re-prompts exactly like a new source.
 */
export type HovtpSourceStatus = 'pending' | 'accepted' | 'expired' | 'rejected';

/** How long a source can be accepted for, in days */
export type AcceptDays = 1 | 2 | 3 | 7;

/** The acceptance windows offered in the UI, shortest first */
export const ACCEPT_DAYS: readonly AcceptDays[] = [1, 2, 3, 7];

/** One HOVTP sender seen for a competition */
export interface HovtpSource {
  /** Canonical client IP — the identity of the source */
  ip: string;
  /** `X-HOVTP-Origin` last seen from this IP */
  origin: string;
  /** `X-HOVTP-Venue` last seen from this IP */
  venue: string;
  /** `X-HOVTP-Discipline` last seen from this IP */
  discipline: string;
  /** `X-HOVTP-Environment` last seen from this IP (`Production` / `Test`) */
  environment: string;
  status: HovtpSourceStatus;
  /** First message from this IP for this competition, ISO UTC */
  firstSeenUtc: string;
  /** Most recent message from this IP, ISO UTC */
  lastSeenUtc: string;
  /** Messages received from this IP for this competition */
  messageCount: number;
  /** Quarantined files waiting to be attached */
  pendingCount: number;
  /** Total size of the quarantined files, in bytes */
  pendingBytes: number;
  /** End of the acceptance window, ISO UTC — accepted/expired sources only */
  acceptedUntilUtc?: string;
  /** Email of whoever accepted the source, when the API reports it */
  acceptedBy?: string;
}

/** What an accept call reports back: the updated row and what it attached */
export interface AcceptHovtpSourceResult {
  source: HovtpSource | null;
  /** Quarantined files moved into the competition's pool */
  attached: number;
}

/** `/api/competitions/{id}/hovtp/sources` */
export function hovtpSourcesUrl(competitionId: string): string {
  return `${COMPETITIONS_API}/${encodeURIComponent(competitionId)}/hovtp/sources`;
}

/**
 * `/api/competitions/{id}/hovtp/sources/{ip}` — the IP is percent-encoded,
 * so an IPv6 address's colons survive the path segment.
 */
export function hovtpSourceUrl(competitionId: string, ip: string): string {
  return `${hovtpSourcesUrl(competitionId)}/${encodeURIComponent(ip)}`;
}

function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Map one raw API row onto a `HovtpSource`, or null when it carries no IP */
export function toHovtpSource(raw: unknown): HovtpSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ip = stringOrEmpty(r.ip);
  if (!ip) return null;
  const status = r.status;
  const source: HovtpSource = {
    ip,
    origin: stringOrEmpty(r.origin),
    venue: stringOrEmpty(r.venue),
    discipline: stringOrEmpty(r.discipline),
    environment: stringOrEmpty(r.environment),
    // An unknown status is treated as a fresh prompt rather than hidden
    status:
      status === 'accepted' || status === 'expired' || status === 'rejected'
        ? status
        : 'pending',
    firstSeenUtc: stringOrEmpty(r.firstSeenUtc),
    lastSeenUtc: stringOrEmpty(r.lastSeenUtc),
    messageCount: numberOr0(r.messageCount),
    pendingCount: numberOr0(r.pendingCount),
    pendingBytes: numberOr0(r.pendingBytes),
  };
  if (typeof r.acceptedUntilUtc === 'string') source.acceptedUntilUtc = r.acceptedUntilUtc;
  if (typeof r.acceptedBy === 'string') source.acceptedBy = r.acceptedBy;
  return source;
}

/** Pull the array of rows out of either `[…]` or `{sources: […]}` */
export function extractHovtpSourceList(payload: unknown): HovtpSource[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { sources?: unknown })?.sources)
      ? (payload as { sources: unknown[] }).sources
      : null;
  if (!rows) return [];
  return rows.map(toHovtpSource).filter((s): s is HovtpSource => s !== null);
}

/** The registry answers `{error: <code>, message: <human text>}` */
async function errorDetail(resp: Response): Promise<string> {
  try {
    const payload = await resp.json();
    return (
      (typeof payload?.message === 'string' && payload.message) ||
      (typeof payload?.error === 'string' && payload.error) ||
      ''
    );
  } catch (_e) {
    // No JSON body — the caller falls back to the bare status
    return '';
  }
}

/**
 * `GET /api/competitions/{id}/hovtp/sources`.
 * Throws `CompetitionApiError` when the sources API is missing or failing.
 */
export async function listHovtpSources(competitionId: string): Promise<HovtpSource[]> {
  let resp: Response;
  try {
    resp = await fetch(hovtpSourcesUrl(competitionId), {
      headers: { Accept: 'application/json' },
    });
  } catch (_e) {
    throw new CompetitionApiError(0, 'HOVTP sources API unreachable');
  }
  if (!resp.ok) {
    throw new CompetitionApiError(
      resp.status,
      (await errorDetail(resp)) || `HOVTP sources API returned ${resp.status}`
    );
  }
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (_e) {
    throw new CompetitionApiError(resp.status, 'HOVTP sources API returned a non-JSON body');
  }
  return extractHovtpSourceList(payload);
}

/**
 * `POST /api/competitions/{id}/hovtp/sources/{ip}/accept` with
 * `{"days": 1|2|3|7}`.
 *
 * Also the extend/re-accept call: a source that is accepted, expired or
 * rejected gets a fresh window from now. Every quarantined file from the IP
 * moves into the competition's pool, which is what `attached` counts.
 */
export async function acceptHovtpSource(
  competitionId: string,
  ip: string,
  days: AcceptDays
): Promise<AcceptHovtpSourceResult> {
  let resp: Response;
  try {
    resp = await fetch(`${hovtpSourceUrl(competitionId, ip)}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ days }),
    });
  } catch (_e) {
    throw new CompetitionApiError(0, 'HOVTP sources API unreachable');
  }
  if (!resp.ok) {
    throw new CompetitionApiError(
      resp.status,
      (await errorDetail(resp)) || `Could not accept "${ip}" (${resp.status})`
    );
  }
  const payload = await resp.json().catch(() => null);
  const wrapper = payload && typeof payload === 'object'
    ? (payload as { source?: unknown; attached?: unknown })
    : null;
  return {
    // A bare source object is accepted too — the row is what matters
    source: toHovtpSource(wrapper?.source ?? payload),
    attached: numberOr0(wrapper?.attached),
  };
}

/**
 * `POST /api/competitions/{id}/hovtp/sources/{ip}/reject` — the quarantined
 * files are deleted; the row stays so the source can be accepted later.
 */
export async function rejectHovtpSource(
  competitionId: string,
  ip: string
): Promise<HovtpSource | null> {
  return postSourceAction(
    `${hovtpSourceUrl(competitionId, ip)}/reject`,
    'POST',
    `Could not reject "${ip}"`
  );
}

/**
 * `DELETE /api/competitions/{id}/hovtp/sources/{ip}` — revoke: files already
 * attached to the competition stay, new data from the IP is refused.
 */
export async function revokeHovtpSource(
  competitionId: string,
  ip: string
): Promise<HovtpSource | null> {
  return postSourceAction(
    hovtpSourceUrl(competitionId, ip),
    'DELETE',
    `Could not revoke "${ip}"`
  );
}

/** Shared body of the two row-state calls that answer `{source: …}` */
async function postSourceAction(
  url: string,
  method: 'POST' | 'DELETE',
  failure: string
): Promise<HovtpSource | null> {
  let resp: Response;
  try {
    resp = await fetch(url, { method, headers: { Accept: 'application/json' } });
  } catch (_e) {
    throw new CompetitionApiError(0, 'HOVTP sources API unreachable');
  }
  if (!resp.ok) {
    throw new CompetitionApiError(
      resp.status,
      (await errorDetail(resp)) || `${failure} (${resp.status})`
    );
  }
  const payload = await resp.json().catch(() => null);
  const wrapper = payload && typeof payload === 'object'
    ? (payload as { source?: unknown })
    : null;
  return toHovtpSource(wrapper?.source ?? payload);
}
