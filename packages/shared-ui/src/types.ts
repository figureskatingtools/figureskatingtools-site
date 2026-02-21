/** Configuration for a tool/app listed in the site navigation */
export interface NavTool {
  /** Unique key used to identify the active tool */
  id: string;
  /** Display label in the dropdown */
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
  /** Additional tools to add beyond the defaults (optional) */
  extraTools?: NavTool[];
}
