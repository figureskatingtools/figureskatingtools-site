/**
 * Client for the platform **competition file pool**
 * (`/api/competitions/{id}/files`).
 *
 * One competition, one set of source files: whatever a tool uploads — and, in
 * time, whatever FSM pushes — lands in the same pool and every other tool can
 * import it. Uploads live under `<guid>/uploads/`, FSM pushes under
 * `<guid>/fsm/`; the listing spans both and tags each row with its `source`.
 *
 * Errors follow `competition.ts`: a `CompetitionApiError` with the HTTP status,
 * or status 0 when the API is unreachable — callers hide the pool UI rather
 * than failing the page.
 */

import { COMPETITIONS_API, CompetitionApiError } from './competition.js';

/** Where a pooled file came from */
export type PoolFileSource = 'upload' | 'fsm';

/** One file in a competition's shared pool */
export interface PoolFile {
  /** Sanitized blob name, unique within the competition */
  name: string;
  source: PoolFileSource;
  /** Size in bytes */
  size: number;
  contentType: string;
  /** Upload timestamp, ISO UTC */
  uploadedUtc: string;
  /** Email of the uploader, when the API reports it */
  uploadedBy?: string;
  /** Tool that put the file there (`judgepapers`, `protocolgenerator`, `site`) */
  sourceTool?: string;
}

/** `/api/competitions/{id}/files` */
export function competitionFilesUrl(competitionId: string): string {
  return `${COMPETITIONS_API}/${encodeURIComponent(competitionId)}/files`;
}

/**
 * Direct download URL for one pooled file — usable as an `<a href>`, since the
 * whole origin is behind the same auth gate.
 */
export function competitionFileUrl(
  competitionId: string,
  name: string,
  source?: PoolFileSource
): string {
  const base = `${competitionFilesUrl(competitionId)}/${encodeURIComponent(name)}`;
  return source && source !== 'upload' ? `${base}?source=${encodeURIComponent(source)}` : base;
}

/** Map one raw API row onto a `PoolFile`, or null when it carries no name */
export function toPoolFile(raw: unknown): PoolFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name : '';
  if (!name) return null;
  const file: PoolFile = {
    name,
    source: r.source === 'fsm' ? 'fsm' : 'upload',
    size: typeof r.size === 'number' ? r.size : 0,
    contentType: typeof r.contentType === 'string' ? r.contentType : '',
    uploadedUtc: typeof r.uploadedUtc === 'string' ? r.uploadedUtc : '',
  };
  if (typeof r.uploadedBy === 'string') file.uploadedBy = r.uploadedBy;
  if (typeof r.sourceTool === 'string') file.sourceTool = r.sourceTool;
  return file;
}

/** Pull the array of rows out of either `[…]` or `{files: […]}` */
export function extractPoolFileList(payload: unknown): PoolFile[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { files?: unknown })?.files)
      ? (payload as { files: unknown[] }).files
      : null;
  if (!rows) return [];
  return rows.map(toPoolFile).filter((f): f is PoolFile => f !== null);
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
 * `GET /api/competitions/{id}/files`.
 * Throws `CompetitionApiError` when the pool API is missing or failing.
 */
export async function listCompetitionFiles(competitionId: string): Promise<PoolFile[]> {
  let resp: Response;
  try {
    resp = await fetch(competitionFilesUrl(competitionId), {
      headers: { Accept: 'application/json' },
    });
  } catch (_e) {
    throw new CompetitionApiError(0, 'Competition files API unreachable');
  }
  if (!resp.ok) {
    throw new CompetitionApiError(
      resp.status,
      (await errorDetail(resp)) || `Competition files API returned ${resp.status}`
    );
  }
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (_e) {
    throw new CompetitionApiError(resp.status, 'Competition files API returned a non-JSON body');
  }
  return extractPoolFileList(payload);
}

/**
 * `POST /api/competitions/{id}/files?filename=…&sourceTool=…` — the file's
 * bytes are the raw request body (no multipart wrapper).
 *
 * Same filename = same logical file: the pool overwrites, matching an FSM
 * re-push. Returns the stored file's metadata.
 */
export async function uploadCompetitionFile(
  competitionId: string,
  file: File,
  sourceTool: string
): Promise<PoolFile> {
  const query = new URLSearchParams({ filename: file.name, sourceTool });
  let resp: Response;
  try {
    resp = await fetch(`${competitionFilesUrl(competitionId)}?${query.toString()}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': file.type || 'application/octet-stream',
      },
      body: file,
    });
  } catch (_e) {
    throw new CompetitionApiError(0, 'Competition files API unreachable');
  }

  if (!resp.ok) {
    throw new CompetitionApiError(
      resp.status,
      (await errorDetail(resp)) || `Could not upload "${file.name}" (${resp.status})`
    );
  }

  const stored = toPoolFile(await resp.json().catch(() => null));
  if (stored) return stored;
  // A 2xx with an unexpected body still means the bytes are stored — describe
  // what we sent rather than failing the upload.
  return {
    name: file.name,
    source: 'upload',
    size: file.size,
    contentType: file.type || 'application/octet-stream',
    uploadedUtc: new Date().toISOString(),
    sourceTool,
  };
}

/**
 * `DELETE /api/competitions/{id}/files/{name}`.
 * Uploads only — FSM-pushed files are read-only and answer 403.
 */
export async function deleteCompetitionFile(
  competitionId: string,
  name: string
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(competitionFileUrl(competitionId, name), {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
  } catch (_e) {
    throw new CompetitionApiError(0, 'Competition files API unreachable');
  }
  if (!resp.ok) {
    throw new CompetitionApiError(
      resp.status,
      (await errorDetail(resp)) || `Could not delete "${name}" (${resp.status})`
    );
  }
}
