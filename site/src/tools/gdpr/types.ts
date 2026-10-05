// Shapes of the fs-gdpr-tool backend responses (see that repo's PROXY-CONTRACT.md).

export interface Skater {
  id: string;
  name: string;
  club: string;
  /** Placement text when not placed, e.g. "WD"; empty otherwise. */
  status: string;
  sources: string[];
  /** Ids of entries with the same name in other categories. */
  alsoIn: string[];
}

export interface Category {
  id: string;
  number: number;
  name: string;
  segments: string[];
  files: number;
  skaters: Skater[];
}

export interface ScanResponse {
  eventUrl: string;
  baseUrl: string;
  snapshot: string;
  categories: Category[];
  suggestedProtocolUrl: string | null;
  stats: { files: number; html: number; pdf: number; sharedAssets: number; missingLinks: number };
}

export interface PlanPage {
  page: number;
  type: string;
  typeLabel: string;
  action: 'remove_page' | 'redact';
  /** Indexes into the selection the plan was made for. */
  skaters: number[];
  heading: string;
}

export interface PlanResponse {
  protocolUrl: string;
  outputPath: string;
  pageCount: number;
  pages: PlanPage[];
  planHash: string;
}

export interface Occurrence {
  file: string;
  location: string;
  skater: string;
}

export interface Check {
  file: string;
  ok: boolean;
  problems: string[];
}

export interface ChangedFile {
  path: string;
  kind: string;
  skaters: string[];
  rowsRedacted?: number;
  occurrencesRedacted?: number;
  pagesRemoved?: number[];
  pagesRedacted?: number[];
}

export interface Manifest {
  skaters: { label: string; category: string }[];
  changedFiles: ChangedFile[];
  protocol: { path: string; removedPages: number[]; redactedPages: number[] } | null;
  verification: {
    ok: boolean;
    filesSearched: number;
    remainingOccurrences: Occurrence[];
    skatersNotFound: string[];
    htmlPages: Check[];
    pdfFiles: Check[];
  };
  notes: string[];
}

export interface GenerateResponse {
  ok: boolean;
  manifest: Manifest;
  zipName: string;
  zipBase64: string;
}
