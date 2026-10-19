/**
 * Short-lived download links from the tool backends.
 *
 * The tools hand out read-only SAS links to generated files that expire 15
 * minutes after the listing was fetched (`expiration`, ISO), and either value
 * is null when signing failed. A page left open would otherwise offer dead
 * links, so a click on a link that is old — the listing is over
 * `DOWNLOAD_DETAILS_MAX_AGE_MS` old, or the link expires within
 * `DOWNLOAD_EXPIRY_MARGIN_MS` — re-fetches the listing first and opens the
 * fresh link (`openFreshDownload`).
 */

/** A listing older than this re-fetches before a download link is followed */
export const DOWNLOAD_DETAILS_MAX_AGE_MS = 10 * 60 * 1000;

/** A link this close to its `expiration` (or past it) counts as stale */
export const DOWNLOAD_EXPIRY_MARGIN_MS = 60 * 1000;

/** The hint shown in place of a link the backend could not sign */
export const DOWNLOAD_LINK_UNAVAILABLE = 'Link unavailable — reload the page';

/**
 * The URL to put in an `href`, or null when there is none to offer: missing,
 * empty, the strings "null"/"undefined" (a value that went through string
 * interpolation), or a scheme other than http(s) — never `javascript:`.
 */
export function usableDownloadUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null;
  try {
    const parsed = new URL(trimmed, 'https://figureskatingtools.invalid/');
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  } catch (_e) {
    return null;
  }
  return trimmed;
}

/**
 * Whether a link from a listing fetched at `fetchedAt` (epoch ms) should be
 * re-fetched before it is followed: the listing is over 10 minutes old, or the
 * link's `expiration` is within a minute or already past. An unknown fetch
 * time counts as stale; a missing or unparsable `expiration` leaves only the
 * age rule.
 */
export function isDownloadLinkStale(
  fetchedAt: number,
  expiration: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return true;
  if (now - fetchedAt > DOWNLOAD_DETAILS_MAX_AGE_MS) return true;
  if (expiration) {
    const expires = Date.parse(expiration);
    if (Number.isFinite(expires) && expires - now <= DOWNLOAD_EXPIRY_MARGIN_MS) return true;
  }
  return false;
}

export interface FreshDownloadOptions {
  /** Re-fetch the listing and return this item's new URL (null: none, or the item is gone) */
  refresh: () => Promise<string | null | undefined>;
  /** The link normally opens in a new tab (`target="_blank"`) */
  newTab: boolean;
  /** Called when no fresh link could be had — show the "unavailable" hint */
  onUnavailable: () => void;
}

/**
 * Follow a download link after re-fetching it. Call it straight from the click
 * handler (after `preventDefault`): for a new-tab link it opens a blank tab
 * while the click still counts as a user gesture, so popup blockers let it
 * through, then points that tab at the fresh URL — or closes it again when
 * there is none. Resolves true when a URL was opened.
 */
export async function openFreshDownload(options: FreshDownloadOptions): Promise<boolean> {
  let tab: Window | null = null;
  if (options.newTab) {
    tab = window.open('', '_blank');
    // The blob host gets no handle back to this page (what rel="noopener" did)
    if (tab) {
      try { tab.opener = null; } catch (_e) { /* not ours to change */ }
    }
  }
  let url: string | null = null;
  try {
    url = usableDownloadUrl(await options.refresh());
  } catch (_e) {
    url = null;
  }
  if (!url) {
    tab?.close();
    options.onUnavailable();
    return false;
  }
  if (!options.newTab) {
    window.location.assign(url);
  } else if (tab && !tab.closed) {
    tab.location.href = url;
  } else {
    // The blank tab was blocked or closed meanwhile: one more try
    window.open(url, '_blank', 'noopener');
  }
  return true;
}
