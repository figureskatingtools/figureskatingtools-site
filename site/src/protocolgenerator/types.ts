// Shape of the competition structure document returned by the backend
// (mirrors infra/functions/structure.py).

export type Discipline = 'single' | 'pair' | 'dance' | 'synchro';
export type FileKind = 'pdf' | 'image' | 'xml' | 'other';
export type SegmentRole = 'results' | 'panel' | 'judgesDetails';

export interface FileMeta {
  filename: string;
  kind: FileKind;
  size: number;
  uploadedAt: string;
  blob?: string;
  /** Placed into its slot by filename recognition, not by hand — shown as the
   * `auto` pill and cleared server-side as soon as the user drags the chip. */
  autoAssigned?: boolean;
  /** Name of the competition-pool file this copy was imported from. */
  poolName?: string;
}

export interface PageRef {
  mode: 'default' | 'custom';
  fileId: string | null;
}

export interface Podium {
  photo: string | null;
  names: string[];
}

/** How much of a roster a team page prints. 'none' keeps the page but drops the
 * skater list. */
export type NameMode = 'full' | 'firstNames' | 'none';

/** One free-typed row printed on a team page ("Theme: Spies"). The rows are a
 * flat per-team list, printed in stored order. */
export interface TeamTextField {
  id: string;
  label: string;
  value: string;
}

/** Team-page settings resolved to a value — what a level hands the one below it.
 * Competition-wide they are absent on data written before the setting existed,
 * which means pages on and full names. */
export interface TeamPageSettings {
  enabled: boolean;
  nameMode: NameMode;
}

export interface Team {
  id: string;
  code: string;
  event: string;
  org: string;
  name: string;
  photo: string | null;
  /** Accreditation picture bulk-imported from a ZIP — used at generation only
   * when the team has no competition (kiss'n'cry) photo. */
  photoFallback?: string | null;
  members: string[];
  /** Team-page overrides; null/absent = inherit the category's setting (which in
   * turn inherits the competition-wide one). */
  pageEnabled?: boolean | null;
  nameMode?: NameMode | null;
  textFields?: TeamTextField[];
}

export interface Segment {
  id: string;
  name: string;
  order: number;
  /** Competition units that performed this segment (auto-filled from the results
   * PDF, user-correctable; null = unknown). Feeds the information-page counts. */
  unitCount: number | null;
  resultsPdf: string | null;
  panelPdf: string | null;
  judgesDetailsPdf: string | null;
}

export interface Category {
  id: string;
  name: string;
  code?: string;
  discipline: Discipline;
  order: number;
  /** Team-page defaults for this category's teams; null/absent = inherit the
   * competition-wide setting. A default, never a copy: changing it moves every
   * team that has not overridden it. */
  pageEnabled?: boolean | null;
  nameMode?: NameMode | null;
  titlePdf: string | null;
  podium: Podium;
  totalResultsPdf: string | null;
  teams: Team[];
  segments: Segment[];
}

/** A registered team the matcher could not place into a category. */
export interface RosterUnmatched {
  name: string;
  org: string;
  eventLabel: string;
  reason: string;
}

/** A team that registered for an event but appears in no result sheet. */
export interface RosterWithdrawn {
  name: string;
  org: string;
  eventLabel: string;
}

/** Outcome of the last roster import (or automatic re-match), persisted in
 * metadata.json so the UI can show it long after the import request. */
export interface RosterImport {
  at: string;
  imported: number;
  moved: number;
  unmatched: RosterUnmatched[];
  withdrawn: RosterWithdrawn[];
}

export interface EventInfo {
  title: string;
  organization: string;
  authorization: string;
  city: string;
  rink: string;
  dates: string;
}

export interface Structure {
  id: string;
  name: string;
  createdBy: string;
  createdDate: string;
  event: EventInfo;
  coverPage: PageRef;
  lastPage: PageRef;
  header: PageRef;
  footer: PageRef;
  footerEnabled: boolean;
  teamPages?: TeamPageSettings;
  scheduleParsed: boolean;
  files: Record<string, FileMeta>;
  categories: Category[];
  rosterImport?: RosterImport;
  schedule?: any[];
}

// A slot target — where a file can be dropped (matches structure.assign_file).
export interface SlotTarget {
  kind:
    | 'cover'
    | 'lastPage'
    | 'header'
    | 'footer'
    | 'tray'
    | 'categoryTitle'
    | 'totalResults'
    | 'podiumPhoto'
    | 'teamPhoto'
    | 'teamPhotoFallback'
    | 'segment';
  categoryId?: string;
  segmentId?: string;
  teamId?: string;
  role?: SegmentRole;
}

export interface CompetitionDetails {
  structure: Structure;
  unassigned: string[];
  generatedFiles: GeneratedFile[];
  /** Auto-deletion date (ISO), when the backend reports one — drives the
   * "Auto-deletes … · Extend" line. Absent on older backends. */
  deletionDate?: string;
}

export interface GeneratedFile {
  fileName: string;
  url: string;
  description: string;
  expiration: string;
  size: number | string;
}
