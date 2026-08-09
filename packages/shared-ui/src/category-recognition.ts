/**
 * FSM export filename recognition — competition category, segment and export
 * kind read straight out of the filename.
 *
 * ── LOCKSTEP ────────────────────────────────────────────────────────────────
 * This module is a faithful port of `match_category` and
 * `parse_filename_generic` in **`fs-judgepapers/infra/functions/categories.py`**.
 * Both sides consume the same `categories` Azure Table (Judge Papers serves it
 * as `GET /judgepapers/api/get_categories`), so a behaviour change on one side
 * must be mirrored on the other — the same rule that ties
 * `normalizeCompetitionCode` here to `normalize_code` in the platform API.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The recognized filename shape is:
 *
 *     {ABBREVIATION}{DASHES}{OPTIONAL_SPLIT_DIGITS}{SEGMENT_PART}--_{SUFFIX}.pdf
 *
 * Nothing here touches the DOM, storage or the network: it is a pure function
 * of a filename plus the category table.
 */

/** One row of the `categories` table, as served by `get_categories` */
export interface CategoryInfo {
  /** Filename prefix / ISU event code, e.g. `FSKWSINGLES-ASILMW` */
  abbreviation: string;
  /** English display name, e.g. `A-Silmut, Girls` */
  displayName: string;
  /** Finnish display name, e.g. `A-Silmut, Tytöt` */
  displayNameFi: string;
  /** `ISU` or `MUPI` */
  judgingMethod: string;
  /** Competition type (the table's PartitionKey), e.g. `Figure skating` */
  competitionType: string;
}

/** Everything a recognized filename tells us */
export interface ParsedFilename {
  /** The filename with any leading path stripped */
  filename: string;
  /** Competition type of the matched category */
  type: string;
  /** English display name, with ` #N` appended for split groups */
  category: string;
  /** Finnish display name, with ` #N` appended for split groups */
  categoryFi: string;
  /** The matched abbreviation (empty for the competition-wide schedule) */
  categoryCode: string;
  /** `ISU` / `MUPI` (empty for the competition-wide schedule) */
  judgingMethod: string;
  /** Segment identifier, or the literal `Unknown` when there is none */
  segment: string;
  /** Same as `segment` — kept separate for parity with the Python dict */
  rawSegment: string;
  /** Everything after the last underscore, e.g. `SegmentResults.pdf` */
  suffix: string;
  /** Everything before the last underscore */
  prefix: string;
  /** Split/group number when the filename carries one, else null */
  splitNumber: number | null;
}

/**
 * Order categories for `matchCategory`: longest abbreviation first, so the
 * most specific prefix wins. Mirrors the sort `load_categories` applies before
 * handing its rows to `match_category`; returns a new array.
 */
export function sortCategoriesForMatching(categories: CategoryInfo[]): CategoryInfo[] {
  return [...categories].sort((a, b) => b.abbreviation.length - a.abbreviation.length);
}

/**
 * The category whose abbreviation is a prefix of `filename`.
 *
 * Like the Python original this walks the list in order and returns the first
 * hit — callers must pass a list ordered by `sortCategoriesForMatching` (the
 * `get_categories` API already does) for longest-prefix semantics.
 */
export function matchCategory(
  filename: string,
  categories: CategoryInfo[]
): CategoryInfo | null {
  for (const cat of categories) {
    if (cat.abbreviation && filename.startsWith(cat.abbreviation)) return cat;
  }
  return null;
}

/** Strip a leading path, keeping only the last `/`-separated element */
function baseName(filename: string): string {
  return filename.includes('/') ? filename.split('/').pop()! : filename;
}

/** Drop leading dashes (Python `str.lstrip('-')`) */
function lstripDashes(value: string): string {
  return value.replace(/^-+/, '');
}

/** Drop leading and trailing dashes (Python `str.strip('-')`) */
function stripDashes(value: string): string {
  return value.replace(/^-+/, '').replace(/-+$/, '');
}

/** The 2-digit split/group number at the front of a remainder, if any */
function leadingSplitNumber(remainder: string): number | null {
  const stripped = lstripDashes(remainder);
  return /^\d{2}/.test(stripped) ? Number(stripped.slice(0, 2)) : null;
}

/**
 * Parse an FSM export filename against the category table.
 * Returns null when the file is not a PDF, carries no underscore, or matches
 * no category abbreviation.
 */
export function parseFilenameGeneric(
  filename: string,
  categories: CategoryInfo[]
): ParsedFilename | null {
  const name = baseName(filename);

  if (!name.endsWith('.pdf')) return null;

  // Competition-wide schedule: the prefix is all dashes, so no category can
  // ever match it.
  if (name.includes('_CompetitionSchedule.pdf')) {
    return {
      filename: name,
      type: 'Competition',
      category: 'Competition',
      categoryFi: 'Competition',
      categoryCode: '',
      judgingMethod: '',
      segment: 'General',
      rawSegment: 'General',
      suffix: 'CompetitionSchedule.pdf',
      prefix: name.split('_CompetitionSchedule.pdf').join(''),
      splitNumber: null,
    };
  }

  const matched = matchCategory(name, categories);
  if (!matched) return null;

  // Suffix is everything after the LAST underscore
  const underscore = name.lastIndexOf('_');
  if (underscore === -1) return null;
  const prefix = name.slice(0, underscore);
  const suffix = name.slice(underscore + 1);

  // The part between the abbreviation and the suffix separator
  const remainder = prefix.slice(matched.abbreviation.length);

  const splitNumber = leadingSplitNumber(remainder);

  // Keep the full segment identifier (`QUAL0001PK` vs `QUAL0002PK`) rather
  // than collapsing it to its phase token — ice-dance pattern dances would
  // otherwise merge into one bucket.
  let segStripped = stripDashes(remainder);
  if (splitNumber !== null && /^\d{2}/.test(segStripped)) {
    segStripped = lstripDashes(segStripped.slice(2));
  }

  let segment = 'Unknown';
  if (suffix.includes('CalculationSetupVerificationforReferee')) {
    segment = 'Category General';
  } else if (segStripped) {
    segment = segStripped;
  }

  let category = matched.displayName;
  let categoryFi = matched.displayNameFi || matched.displayName;
  if (splitNumber !== null) {
    category = `${category} #${splitNumber}`;
    categoryFi = `${categoryFi} #${splitNumber}`;
  }

  return {
    filename: name,
    type: matched.competitionType,
    category,
    categoryFi,
    categoryCode: matched.abbreviation,
    judgingMethod: matched.judgingMethod,
    segment,
    rawSegment: segment,
    suffix,
    prefix,
    splitNumber,
  };
}
