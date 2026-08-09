/**
 * Filename → Protocol Generator slot planning.
 *
 * Given a recognized FSM export filename (see `category-recognition.ts`) and a
 * Protocol Generator competition structure, decide where the file belongs:
 * a category/segment slot, or the upload tray with a reason the UI can explain.
 *
 * The structure is **duck-typed** (`StructureLike` & friends) on purpose — this
 * package must not depend on the Protocol Generator's `types.ts`, and the same
 * planner serves both the drop-upload flow and the competition-file-pool
 * import flow.
 *
 * Everything here is pure: no DOM, no network, no mutation of its inputs
 * (`applyOutcomeLocally` is the single, explicitly-named exception).
 */

import {
  parseFilenameGeneric,
  matchCategory,
  type CategoryInfo,
  type ParsedFilename,
} from './category-recognition.js';

/* ════════════════════════════════════════════════════════════════
   Duck-typed view of a Protocol Generator structure
   ════════════════════════════════════════════════════════════════ */

/** Which of a segment's three PDF slots a file goes into */
export type SegmentRole = 'results' | 'panel' | 'judgesDetails';

/** The slot kinds this planner can target */
export type AutoAssignKind = 'segment' | 'totalResults' | 'categoryTitle';

export interface SegmentLike {
  id: string;
  name: string;
  order?: number;
  resultsPdf?: string | null;
  panelPdf?: string | null;
  judgesDetailsPdf?: string | null;
}

export interface CategoryLike {
  id: string;
  name: string;
  /** ISU event code from a DT_SCHEDULE import; absent for PDF-parsed categories */
  code?: string;
  titlePdf?: string | null;
  totalResultsPdf?: string | null;
  segments?: SegmentLike[];
}

/** A file already registered in the structure (only the fields we inspect) */
export interface FileMetaLike {
  filename: string;
  /** Set by a previous auto-assignment — an occupant we may replace */
  autoAssigned?: boolean;
}

export interface StructureLike {
  categories?: CategoryLike[];
  /** fileId → metadata; slots hold file ids, so occupants are resolved here */
  files?: Record<string, FileMetaLike>;
}

/** Where a planned file goes — the subset of PG's `SlotTarget` we can produce */
export interface AutoAssignTarget {
  kind: AutoAssignKind;
  categoryId: string;
  segmentId?: string;
  role?: SegmentRole;
  /**
   * The ISU abbreviation the filename was recognized as. Set on every assign
   * outcome so the caller can stamp a learned `code` onto a code-less category.
   */
  categoryCode?: string;
  /** How the category was found: by its stored `code`, or by its name */
  matchedBy?: 'code' | 'name';
}

/** Why a file was left in the upload tray */
export type TrayReason =
  /** Not an FSM export we know — no category abbreviation matched */
  | 'unrecognized'
  /** A known FSM export that the protocol never uses */
  | 'not-for-protocol'
  /** Category matched, but the export kind maps to no slot */
  | 'unknown-suffix'
  /** More than one category in the structure fits */
  | 'ambiguous-category'
  /** Category found, but the segment could not be pinned down */
  | 'ambiguous-segment'
  /** The target slot already holds a file we must not displace */
  | 'slot-occupied';

export type AutoAssignOutcome =
  | { action: 'assign'; target: AutoAssignTarget }
  | { action: 'tray'; reason: TrayReason };

/* ════════════════════════════════════════════════════════════════
   Suffix → slot table
   ════════════════════════════════════════════════════════════════ */

export interface SuffixSlot {
  /** `skip` = a known FSM export the protocol has no place for */
  kind: AutoAssignKind | 'skip';
  role?: SegmentRole;
  /**
   * Only valid when the filename's segment portion is dash-only — the FSM
   * category-level total results sheet (`…-----------------_Results.pdf`)
   * has no segment token at all, while a `Results.pdf` carrying a real
   * segment token is something else and stays in the tray.
   */
  requiresCategoryLevel?: boolean;
}

/**
 * Exact match on the full suffix (everything after the last underscore), so
 * `SegmentResults.pdf` and `Results.pdf` never collide.
 */
export const SUFFIX_SLOTS: Record<string, SuffixSlot> = {
  'SegmentResults.pdf': { kind: 'segment', role: 'results' },
  'Results.pdf': { kind: 'totalResults', requiresCategoryLevel: true },
  // FSM's category cover sheet. Real exports always carry the `_ProtocolHeadPage`
  // suffix, so the no-underscore title branch below never fires for them.
  'ProtocolHeadPage.pdf': { kind: 'categoryTitle', requiresCategoryLevel: true },
  'ISUPanelofJudgesandTechnicalPanel.pdf': { kind: 'segment', role: 'panel' },
  'JudgesDetailsperSkater.pdf': { kind: 'segment', role: 'judgesDetails' },
  'JudgesSheetAll.pdf': { kind: 'skip' },
  'StartListwithTimes.pdf': { kind: 'skip' },
  'RefereeSheet.pdf': { kind: 'skip' },
  'TechnicalControllerSheet.pdf': { kind: 'skip' },
  'PlannedProgramContent.pdf': { kind: 'skip' },
  'CompetitionSchedule.pdf': { kind: 'skip' },
  'CalculationSetupVerificationforReferee.pdf': { kind: 'skip' },
};

/** Segment slot field per role */
const ROLE_FIELD: Record<SegmentRole, 'resultsPdf' | 'panelPdf' | 'judgesDetailsPdf'> = {
  results: 'resultsPdf',
  panel: 'panelPdf',
  judgesDetails: 'judgesDetailsPdf',
};

/**
 * Phase token → the segment names it can mean, English and Finnish.
 * Mirrors `_PHASE_SEGMENT` in `fs-protocolgenerator`'s `schedule_parser.py`,
 * widened with the Finnish labels the schedule parser also recognizes.
 */
const PHASE_SYNONYMS: Record<string, string[]> = {
  QUAL: ['Short Program', 'Lyhytohjelma', 'Short Dance'],
  SP: ['Short Program', 'Lyhytohjelma', 'Short Dance'],
  FNL: ['Free Skating', 'Free Program', 'Vapaaohjelma'],
  FS: ['Free Skating', 'Free Program', 'Vapaaohjelma'],
  RD: ['Rhythm Dance', 'Rytmitanssi'],
  FD: ['Free Dance', 'Vapaatanssi'],
};

/** Phase tokens that mean "the earlier of two segments" / "the later one" */
const EARLIER_PHASES = new Set(['QUAL', 'SP', 'RD']);
const LATER_PHASES = new Set(['FNL', 'FS', 'FD']);

/* ════════════════════════════════════════════════════════════════
   Normalization helpers
   ════════════════════════════════════════════════════════════════ */

/** Drop an ISU code's trailing dash padding (mirror of `strip_event`) */
export function stripTrailingDashes(code: string | null | undefined): string {
  return String(code ?? '').trim().replace(/-+$/, '');
}

/**
 * Fold a display name for comparison: casefold, drop diacritics, collapse
 * every run of non-alphanumerics into a single space. `A-Silmut, Tytöt #1`
 * and `A Silmut Tytot 1` compare equal; nothing shorter does.
 */
export function normalizeMatchName(raw: string | null | undefined): string {
  return String(raw ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Shortest token length that may match by prefix; below it, only equality */
const PREFIX_MIN_LENGTH = 4;

/** The comparison tokens of a display name, e.g. `SM-JUNIORI Naiset` → `[sm, juniori, naiset]` */
function matchTokens(raw: string | null | undefined): string[] {
  const normalized = normalizeMatchName(raw);
  return normalized ? normalized.split(' ') : [];
}

/**
 * Two tokens pair when they are equal, or when one is a prefix of the other
 * and the shorter one is at least `PREFIX_MIN_LENGTH` characters.
 *
 * This is what bridges the schedule PDF's singular Finnish forms to the
 * category table's plural ones (`noviisi`~`noviisit`, `juniori`~`juniorit`,
 * `seniori`~`seniorit`, `junior`~`juniori`) while keeping short tokens like
 * `sm`, `l1` or a split's `1`/`2` strictly exact.
 */
function tokensPair(a: string, b: string): boolean {
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length < PREFIX_MIN_LENGTH) return false;
  return long.startsWith(short);
}

/**
 * Do two display names describe the same category?
 *
 * Both sides are normalized (casefold, diacritics folded, punctuation → space)
 * and split into tokens; they match when the token multisets pair
 * **bijectively** — same token count, and every token of one side can be
 * assigned to a *distinct* token of the other under `tokensPair`.
 *
 * The equal-count requirement is what keeps near misses apart: `SM-Juniorit,
 * Miehet` (3 tokens) can never collapse onto `Juniorit, Miehet` (2 tokens),
 * so a competition running both stays unambiguous.
 */
export function matchNameTokens(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const left = matchTokens(a);
  const right = matchTokens(b);
  if (!left.length || left.length !== right.length) return false;

  // Kuhn's algorithm — the token counts here are single digits.
  const assignedTo = new Array<number>(right.length).fill(-1);
  const augment = (i: number, seen: boolean[]): boolean => {
    for (let j = 0; j < right.length; j += 1) {
      if (seen[j] || !tokensPair(left[i]!, right[j]!)) continue;
      seen[j] = true;
      if (assignedTo[j] === -1 || augment(assignedTo[j]!, seen)) {
        assignedTo[j] = i;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < left.length; i += 1) {
    if (!augment(i, new Array<boolean>(right.length).fill(false))) return false;
  }
  return true;
}

/**
 * `parseFilenameGeneric` reports a dash-only or missing segment portion as the
 * literal `Unknown` (Python parity) — that is the "category-level file" signal.
 */
function isCategoryLevel(parsed: ParsedFilename): boolean {
  return parsed.rawSegment === 'Unknown' || parsed.rawSegment === '';
}

/** The leading alphabetic token of a raw segment: `QUAL000100` → `QUAL` */
function phaseToken(rawSegment: string): string {
  const match = /^[A-Za-z]+/.exec(rawSegment);
  return match ? match[0].toUpperCase() : '';
}

/** Segments in display order, ties keeping their array order */
function orderedSegments(category: CategoryLike): SegmentLike[] {
  return [...(category.segments ?? [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0)
  );
}

/* ════════════════════════════════════════════════════════════════
   Category matching
   ════════════════════════════════════════════════════════════════ */

/**
 * Categories whose ISU code matches the filename's abbreviation.
 *
 * A structure code is `unit_code[:22]`, i.e. the abbreviation plus dash
 * padding and, for a split event, a `--NN` block suffix. Split files are
 * routed by their `#N` group number, falling back to the unsplit code when
 * the structure does not model the split.
 */
function codeHits(categories: CategoryLike[], parsed: ParsedFilename): CategoryLike[] {
  if (!parsed.categoryCode) return [];
  const plain: CategoryLike[] = [];
  const split: CategoryLike[] = [];
  for (const cat of categories) {
    const code = stripTrailingDashes(cat.code);
    if (!code || !code.startsWith(parsed.categoryCode)) continue;
    const tail = code.slice(parsed.categoryCode.length).replace(/-/g, '');
    if (tail === '') plain.push(cat);
    else if (
      parsed.splitNumber !== null &&
      /^\d+$/.test(tail) &&
      Number(tail) === parsed.splitNumber
    ) {
      split.push(cat);
    }
  }
  if (parsed.splitNumber === null) return plain;
  return split.length ? split : plain;
}

/**
 * Categories that carry no code (parsed from a schedule PDF) whose name pairs
 * token-for-token with the recognized display name, English or Finnish.
 *
 * Schedule PDFs spell categories freehand (`SM-NOVIISI Tytöt`) while the table
 * carries the registry spelling (`SM-Noviisit, Tytöt`), so plain equality found
 * nothing in the field. `matchNameTokens` bridges the inflection without ever
 * widening to substrings — a near miss still falls to the tray.
 */
function nameHits(categories: CategoryLike[], parsed: ParsedFilename): CategoryLike[] {
  const wanted = [parsed.category, parsed.categoryFi].filter(Boolean);
  if (!wanted.length) return [];
  return categories.filter(
    (cat) =>
      !stripTrailingDashes(cat.code) &&
      wanted.some((name) => matchNameTokens(name, cat.name))
  );
}

/**
 * Does a *different* table row describe `category` just as well? Uniqueness has
 * to hold in both directions: one structure category for the file's row, and
 * one row for that structure category. Otherwise a competition running both
 * `SM-Juniorit, Miehet` and `Juniorit, Miehet` could quietly take the wrong one.
 */
function nameClaimedByAnotherRow(
  category: CategoryLike,
  parsed: ParsedFilename,
  table: CategoryInfo[]
): boolean {
  return table.some(
    (row) =>
      row.abbreviation &&
      row.abbreviation !== parsed.categoryCode &&
      (matchNameTokens(row.displayName, category.name) ||
        matchNameTokens(row.displayNameFi || row.displayName, category.name))
  );
}

type Resolution<T> = { ok: T } | { fail: TrayReason };

/** A resolved category plus how we got there */
interface CategoryMatch {
  category: CategoryLike;
  matchedBy: 'code' | 'name';
}

function resolveCategory(
  structure: StructureLike,
  parsed: ParsedFilename,
  table: CategoryInfo[]
): Resolution<CategoryMatch> {
  const categories = structure.categories ?? [];
  const byCode = codeHits(categories, parsed);
  if (byCode.length === 1) return { ok: { category: byCode[0]!, matchedBy: 'code' } };
  if (byCode.length > 1) return { fail: 'ambiguous-category' };

  const byName = nameHits(categories, parsed);
  if (byName.length === 0) return { fail: 'unrecognized' };
  if (byName.length > 1) return { fail: 'ambiguous-category' };
  const hit = byName[0]!;
  if (nameClaimedByAnotherRow(hit, parsed, table)) return { fail: 'ambiguous-category' };
  return { ok: { category: hit, matchedBy: 'name' } };
}

/* ════════════════════════════════════════════════════════════════
   Segment matching
   ════════════════════════════════════════════════════════════════ */

function resolveSegment(
  category: CategoryLike,
  parsed: ParsedFilename
): Resolution<SegmentLike> {
  const segments = orderedSegments(category);
  if (!segments.length) return { fail: 'ambiguous-segment' };
  const only = segments.length === 1 ? segments[0]! : null;

  // A category-level filename has no segment token at all: only a
  // single-segment category can take it.
  if (isCategoryLevel(parsed)) {
    return only ? { ok: only } : { fail: 'ambiguous-segment' };
  }

  // `SEG003` → the third segment in display order
  const seg = /^SEG0*(\d+)$/i.exec(parsed.rawSegment.replace(/-/g, ''));
  if (seg) {
    const index = Number(seg[1]) - 1;
    const hit = segments[index];
    return hit ? { ok: hit } : { fail: 'ambiguous-segment' };
  }

  const token = phaseToken(parsed.rawSegment);
  if (!token) return only ? { ok: only } : { fail: 'ambiguous-segment' };

  // Phase-token synonyms; an unknown token is still tried against the segment
  // names verbatim.
  const candidates = (PHASE_SYNONYMS[token] ?? [token]).map(normalizeMatchName);
  const exact = segments.filter((s) => candidates.includes(normalizeMatchName(s.name)));
  if (exact.length === 1) return { ok: exact[0]! };
  if (exact.length === 0) {
    const prefixed = segments.filter((s) => {
      const name = normalizeMatchName(s.name);
      return candidates.some((c) => c && name.startsWith(c));
    });
    if (prefixed.length === 1) return { ok: prefixed[0]! };
    if (prefixed.length > 1) return { fail: 'ambiguous-segment' };
  } else {
    return { fail: 'ambiguous-segment' };
  }

  // Nothing matched by name: a single-segment category takes anything, and a
  // two-segment category is ordered short-then-free.
  if (only) return { ok: only };
  if (segments.length === 2) {
    if (EARLIER_PHASES.has(token)) return { ok: segments[0]! };
    if (LATER_PHASES.has(token)) return { ok: segments[1]! };
  }
  return { fail: 'ambiguous-segment' };
}

/* ════════════════════════════════════════════════════════════════
   Slot occupancy
   ════════════════════════════════════════════════════════════════ */

/** The file id sitting in a slot, or null when it is free */
export function slotOccupant(
  structure: StructureLike,
  target: AutoAssignTarget
): string | null {
  const category = (structure.categories ?? []).find((c) => c.id === target.categoryId);
  if (!category) return null;
  if (target.kind === 'categoryTitle') return category.titlePdf || null;
  if (target.kind === 'totalResults') return category.totalResultsPdf || null;
  const segment = (category.segments ?? []).find((s) => s.id === target.segmentId);
  if (!segment || !target.role) return null;
  return segment[ROLE_FIELD[target.role]] || null;
}

/**
 * Collision policy: an empty slot takes the file; an auto-assigned occupant
 * with the *same* filename is replaced (FSM re-exports overwrite themselves);
 * anything else — a manual placement, or another auto-assigned file — keeps
 * the slot and sends the new file to the tray.
 */
function slotAccepts(
  structure: StructureLike,
  target: AutoAssignTarget,
  filename: string
): boolean {
  const occupantId = slotOccupant(structure, target);
  if (!occupantId) return true;
  const occupant = structure.files?.[occupantId];
  if (!occupant || !occupant.autoAssigned) return false;
  return occupant.filename === filename;
}

/* ════════════════════════════════════════════════════════════════
   Planner
   ════════════════════════════════════════════════════════════════ */

/** Strip a leading path, keeping only the last `/`-separated element */
function baseName(filename: string): string {
  return filename.includes('/') ? filename.split('/').pop()! : filename;
}

/**
 * The title-page branch: a no-underscore PDF named after nothing but a
 * category code (plus dash padding and an optional split number).
 */
function planTitlePage(
  filename: string,
  categories: CategoryInfo[],
  structure: StructureLike
): AutoAssignOutcome | null {
  const stem = filename.slice(0, -'.pdf'.length);
  const matched = matchCategory(stem, categories);
  if (!matched) return null;

  const remainder = stem.slice(matched.abbreviation.length);
  const splitNumber = /^-*(\d{2})-*$/.exec(remainder);
  if (!/^-*$/.test(remainder) && !splitNumber) return null;

  const parsed: ParsedFilename = {
    filename,
    type: matched.competitionType,
    category: splitNumber
      ? `${matched.displayName} #${Number(splitNumber[1])}`
      : matched.displayName,
    categoryFi: splitNumber
      ? `${matched.displayNameFi || matched.displayName} #${Number(splitNumber[1])}`
      : matched.displayNameFi || matched.displayName,
    categoryCode: matched.abbreviation,
    judgingMethod: matched.judgingMethod,
    segment: 'Unknown',
    rawSegment: 'Unknown',
    suffix: '',
    prefix: stem,
    splitNumber: splitNumber ? Number(splitNumber[1]) : null,
  };

  const category = resolveCategory(structure, parsed, categories);
  if ('fail' in category) return { action: 'tray', reason: category.fail };

  const target: AutoAssignTarget = {
    kind: 'categoryTitle',
    categoryId: category.ok.category.id,
    categoryCode: parsed.categoryCode,
    matchedBy: category.ok.matchedBy,
  };
  if (!slotAccepts(structure, target, filename)) {
    return { action: 'tray', reason: 'slot-occupied' };
  }
  return { action: 'assign', target };
}

/**
 * Decide where `filename` belongs in `structure`.
 *
 * `categories` is the Judge Papers category table (ordered longest
 * abbreviation first — `sortCategoriesForMatching`). An empty table means
 * recognition is unavailable, and every file goes to the tray.
 */
export function planAutoAssignment(
  filename: string,
  categories: CategoryInfo[],
  structure: StructureLike
): AutoAssignOutcome {
  const name = baseName(filename);
  if (!name.endsWith('.pdf')) return { action: 'tray', reason: 'unrecognized' };

  if (!name.includes('_')) {
    return planTitlePage(name, categories, structure) ?? { action: 'tray', reason: 'unrecognized' };
  }

  const parsed = parseFilenameGeneric(name, categories);
  if (!parsed) return { action: 'tray', reason: 'unrecognized' };

  const slot = SUFFIX_SLOTS[parsed.suffix];
  if (slot?.kind === 'skip') return { action: 'tray', reason: 'not-for-protocol' };

  const category = resolveCategory(structure, parsed, categories);
  if ('fail' in category) return { action: 'tray', reason: category.fail };

  if (!slot) return { action: 'tray', reason: 'unknown-suffix' };
  if (slot.requiresCategoryLevel && !isCategoryLevel(parsed)) {
    return { action: 'tray', reason: 'unknown-suffix' };
  }

  const provenance = {
    categoryCode: parsed.categoryCode,
    matchedBy: category.ok.matchedBy,
  } as const;

  let target: AutoAssignTarget;
  if (slot.kind === 'segment') {
    const segment = resolveSegment(category.ok.category, parsed);
    if ('fail' in segment) return { action: 'tray', reason: segment.fail };
    target = {
      kind: 'segment',
      categoryId: category.ok.category.id,
      segmentId: segment.ok.id,
      role: slot.role,
      ...provenance,
    };
  } else {
    target = { kind: slot.kind, categoryId: category.ok.category.id, ...provenance };
  }

  if (!slotAccepts(structure, target, name)) {
    return { action: 'tray', reason: 'slot-occupied' };
  }
  return { action: 'assign', target };
}

let localFileSeq = 0;

/**
 * Record a planned assignment in a **working copy** of the structure, so a
 * batch of files can be planned sequentially without two of them being sent to
 * the same slot. Mutates `structure` in place — callers plan against a clone,
 * never against the structure they render.
 *
 * Returns the synthetic file id it minted, or null for a tray outcome.
 */
export function applyOutcomeLocally(
  structure: StructureLike,
  outcome: AutoAssignOutcome,
  filename: string
): string | null {
  if (outcome.action !== 'assign') return null;
  const { target } = outcome;
  const category = (structure.categories ?? []).find((c) => c.id === target.categoryId);
  if (!category) return null;

  const fileId = `fst-planned-${++localFileSeq}`;
  if (!structure.files) structure.files = {};
  structure.files[fileId] = { filename: baseName(filename), autoAssigned: true };

  if (target.kind === 'categoryTitle') {
    category.titlePdf = fileId;
  } else if (target.kind === 'totalResults') {
    category.totalResultsPdf = fileId;
  } else {
    const segment = (category.segments ?? []).find((s) => s.id === target.segmentId);
    if (!segment || !target.role) return null;
    segment[ROLE_FIELD[target.role]] = fileId;
  }
  return fileId;
}
