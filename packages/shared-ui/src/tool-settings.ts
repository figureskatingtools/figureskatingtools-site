/**
 * Client for a tool's remembered settings on a competition
 * (`/api/competitions/{id}/settings/{tool}`).
 *
 * A browser-only tool (the banner generator) keeps what was typed into it as
 * one JSON object per competition, shared like the competition itself: read
 * access loads it, write access saves it. The platform stores it opaquely, so
 * the tool validates the shape it reads back.
 *
 * Errors follow `competition.ts`: a `CompetitionApiError` carrying the HTTP
 * status and the API's machine code (`read_only`, `not_found`,
 * `competition_deleted`, `settings_too_large`, …), or status 0 when the API
 * is unreachable.
 */

import { COMPETITIONS_API, CompetitionApiError } from './competition.js';

/** Tools the platform keeps settings for */
export type SettingsTool = 'banner';

/** One stored settings object (`settings: null` = nothing saved yet) */
export interface ToolSettings {
  settings: Record<string, unknown> | null;
  /** When it was last saved, ISO UTC ('' when never) */
  updatedUtc: string;
}

/** `/api/competitions/{id}/settings/{tool}` */
export function toolSettingsUrl(competitionId: string, tool: SettingsTool): string {
  return `${COMPETITIONS_API}/${encodeURIComponent(competitionId)}/settings/${encodeURIComponent(tool)}`;
}

/** Map an API body onto `ToolSettings`, treating anything odd as "not saved" */
export function toToolSettings(raw: unknown): ToolSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const settings = r.settings;
  return {
    settings:
      settings && typeof settings === 'object' && !Array.isArray(settings)
        ? (settings as Record<string, unknown>)
        : null,
    updatedUtc: typeof r.updatedUtc === 'string' ? r.updatedUtc : '',
  };
}

async function send(url: string, init: RequestInit, fallback: string): Promise<ToolSettings> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
    });
  } catch (_e) {
    throw new CompetitionApiError(0, 'Competitions API unreachable');
  }
  if (!resp.ok) {
    let code = '';
    let message = '';
    try {
      const payload = await resp.json();
      code = typeof payload?.error === 'string' ? payload.error : '';
      message = typeof payload?.message === 'string' ? payload.message : '';
    } catch (_e) {
      // No JSON body — fall back to the bare status
    }
    throw new CompetitionApiError(resp.status, message || code || `${fallback} (${resp.status})`, code);
  }
  try {
    return toToolSettings(await resp.json());
  } catch (_e) {
    throw new CompetitionApiError(resp.status, 'Competitions API returned a non-JSON body');
  }
}

/** `GET` — the saved settings, `settings: null` when there are none yet */
export function getToolSettings(competitionId: string, tool: SettingsTool): Promise<ToolSettings> {
  return send(toolSettingsUrl(competitionId, tool), {}, 'Could not load the saved settings');
}

/**
 * `PUT` — replace the saved settings. `keepalive` lets a save started while
 * the page is being closed finish (browsers cap such bodies at 64 kB).
 */
export function saveToolSettings(
  competitionId: string,
  tool: SettingsTool,
  settings: Record<string, unknown>,
  options: { keepalive?: boolean } = {}
): Promise<ToolSettings> {
  return send(
    toolSettingsUrl(competitionId, tool),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
      keepalive: options.keepalive === true,
    },
    'Could not save the settings'
  );
}
