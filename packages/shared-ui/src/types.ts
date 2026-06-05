/** A sub-navigation item within the active app's dropdown */
export interface NavSubItem {
  /** Unique key for event handling (e.g., 'competitions', 'new-competition') */
  id: string;
  /** Display label */
  label: string;
  /** Whether the item is clickable or shown as "coming soon" */
  enabled: boolean;
}

/** Configuration for a tool/app listed in the site navigation */
export interface NavTool {
  /** Unique key used to identify the active tool */
  id: string;
  /** Display label */
  label: string;
  /** Subdomain prefix (e.g., 'judgepapers') */
  subdomain: string;
  /** Whether this tool is available or coming soon */
  enabled: boolean;
}

/** Options passed to renderSiteNav */
export interface SiteNavOptions {
  /** The id of the currently active tool (or 'home' for the main site) */
  activeApp: string;
  /** Path to logo image (defaults to '/logo.png') */
  logoUrl?: string;
  /** Sub-navigation items shown in the active app's dropdown */
  appNavItems?: NavSubItem[];
  /** Additional tools to add beyond the defaults (optional) */
  extraTools?: NavTool[];
}
