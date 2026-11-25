export type JudgingSystem = 'ISU';

export interface FileData {
    filename: string;
    suffix: string;
    type: string;
    category: string;
    categoryCode?: string;
    judgingMethod?: string; // "ISU" or "MUPI" — effective method for this competition
    defaultJudgingMethod?: string; // the categories table value, before any override
    judgingMethodOverridable?: boolean; // true for synchronized skating categories
    segment: string;
    raw_segment: string;
    prefix?: string;
    segment_display_name?: string;
}

/**
 * One segment of the uploaded CompetitionSchedule, as `get_competition_details`
 * returns it in `scheduleCheck.rows` (fs-judgepapers schedule_check.py).
 */
export interface ScheduleRow {
    /** YYYY-MM-DD */
    date: string | null;
    /** HH:MM */
    startTime: string | null;
    entries: number;
    /** Category + segment as the schedule prints them */
    name: string;
    /** '' when the printed text could not be split */
    category: string;
    segment: string;
    /** found = papers are uploaded; notNeeded = none, and no entries either */
    status: 'found' | 'missing' | 'notNeeded';
    prefix: string | null;
    /** The key of the row's category in `structure`, null when it has none */
    categoryKey: string | null;
}

/** What one category card is missing */
export interface CategoryCheck {
    isValid: boolean;
    /** Segment key -> the files it is missing, as shown in the list */
    missingBySegment: Record<string, string[]>;
    /** Files expected once per category (the calculation setup) */
    missingCategoryFiles: string[];
    /** The calculation setup is uploaded, but no segment has any papers */
    noSegmentPapers: boolean;
    /** Missing files, plus one for noSegmentPapers */
    missingCount: number;
}

export interface CompetitionValidationResult {
    isValid: boolean;
    missingFiles: string[];
}

export const COMMON_FILES = [
    'StartListwithTimes.pdf',
    'ISUPanelofJudgesandTechnicalPanel.pdf',
    'JudgesSheetAll.pdf',
    'RefereeSheet.pdf'
];

export const ISU_ONLY_FILES = [
    'PlannedProgramContent.pdf',
    'TechnicalControllerSheet.pdf',
    'TechnicalSpecialistSheet' // Special handling for regex/prefix
];

/** Required once per category (not per segment). */
export const CATEGORY_GENERAL_FILE = 'CalculationSetupVerificationforReferee.pdf';

/** The backend's segment key for the files a category has once */
export const CATEGORY_GENERAL_SEGMENT = 'Category General';

/** How a missing Technical Specialist sheet is listed: any one of them will do */
export const SPECIALIST_SHEET_LABEL = 'TechnicalSpecialistSheet (at least one)';

/**
 * Without these two the backend cannot produce a segment at all: the panel
 * names the people who get papers, the time schedule gives the day and the
 * running order (fs-judgepapers processor.py, step 2).
 */
const GENERATE_NEEDS = ['StartListwithTimes.pdf', 'ISUPanelofJudgesandTechnicalPanel.pdf'];

/**
 * Segments to skip during per-segment validation: meta-segments that aren't
 * actual skating segments requiring the standard file set, plus 'Unknown' —
 * the backend's bucket for files whose segment marker couldn't be parsed.
 */
const SKIP_SEGMENTS = [CATEGORY_GENERAL_SEGMENT, 'General', 'Unknown'];

/** Files of unrecognised categories: listed so they can be deleted, never checked */
export const UNCATEGORIZED = 'Uncategorized';

/**
 * Validates competition-level requirements (files needed across all categories).
 *
 * CompetitionSchedule.pdf is optional — start times are extracted from
 * StartListwithTimes.pdf per segment, so the schedule is not required.
 *
 * @param competitionFiles - array of competition-wide file objects returned
 *        by the backend in the "competitionFiles" field.
 */
export function validateCompetition(
    _competitionFiles: FileData[]
): CompetitionValidationResult {
    // No required competition-level files at this time.
    return { isValid: true, missingFiles: [] };
}

/** The files a segment is expected to have and does not, in list order */
function missingSegmentFiles(files: FileData[]): string[] {
    const missing = COMMON_FILES.filter(req => !files.some(f => f.suffix === req));

    // The judgingMethod comes from the backend (the categories table; for
    // synchronized skating it may be a per-competition override). MUPI
    // segments need the common files only.
    if (!files.some(f => f.judgingMethod === 'MUPI')) {
        for (const req of ISU_ONLY_FILES) {
            if (req === 'TechnicalSpecialistSheet') {
                // At least one: the suffix carries the specialist's number
                if (!files.some(f => f.suffix.startsWith('TechnicalSpecialistSheet'))) {
                    missing.push(SPECIALIST_SHEET_LABEL);
                }
            } else if (!files.some(f => f.suffix === req)) {
                missing.push(req);
            }
        }
    }
    return missing;
}

export function validateCategory(
    segments: Record<string, FileData[]>
): CategoryCheck {
    const missingBySegment: Record<string, string[]> = {};
    const missingCategoryFiles: string[] = [];

    const allFiles = Object.values(segments).flat();
    const hasCalcSetup = allFiles.some(f => f.suffix === CATEGORY_GENERAL_FILE);
    const realSegments = Object.keys(segments).filter(s => !SKIP_SEGMENTS.includes(s));

    // The calculation setup is required once the category has a real segment.
    // A category of unknown-segment files only has nothing to validate ...
    if (realSegments.length > 0 && !hasCalcSetup) {
        missingCategoryFiles.push(CATEGORY_GENERAL_FILE);
    }
    // ... but one that holds the calculation setup and no segment at all is
    // a category whose papers were never uploaded.
    const noSegmentPapers = hasCalcSetup && realSegments.length === 0;

    for (const segmentName of realSegments) {
        const missing = missingSegmentFiles(segments[segmentName]);
        if (missing.length) missingBySegment[segmentName] = missing;
    }

    const missingCount = Object.values(missingBySegment).reduce((n, files) => n + files.length, 0)
        + missingCategoryFiles.length + (noSegmentPapers ? 1 : 0);
    return {
        isValid: missingCount === 0,
        missingBySegment,
        missingCategoryFiles,
        noSegmentPapers,
        missingCount,
    };
}

/** True when the backend can produce papers for a segment with these files */
export function isGenerable(files: FileData[]): boolean {
    return GENERATE_NEEDS.every(req => files.some(f => f.suffix === req));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `Sun 13.9. 12:10 · 26 entries`: when a scheduled segment is skated; '' when nothing is known */
export function scheduleWhen(row: ScheduleRow, separator = ' · '): string {
    const parts: string[] = [];
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(row.date ?? '');
    if (date) {
        const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
        parts.push(`${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]} ${day}.${month}.`);
    }
    if (row.startTime) parts.push(row.startTime);
    const when = parts.join(' ');
    const entries = Number.isFinite(row.entries) && row.entries > 0
        ? `${row.entries} ${row.entries === 1 ? 'entry' : 'entries'}` : '';
    return [when, entries].filter(Boolean).join(separator);
}

/** The schedule's own name for the category of a row */
export function scheduleCategoryTitle(row: ScheduleRow): string {
    return row.category || row.name;
}

/** The schedule's own name for the segment of a row; '' when the text could not be split */
export function scheduleSegmentTitle(row: ScheduleRow): string {
    return row.category ? row.segment : '';
}

/** A scheduled category nothing is uploaded for: a card of its own in the list */
export interface PlaceholderCategory {
    title: string;
    rows: ScheduleRow[];
}

/** Everything that is missing in a competition, for the file list and the Generate prompt */
export interface MissingReport {
    /** Per category card (structure key); unrecognised files are left out */
    categories: Record<string, CategoryCheck>;
    /** Scheduled segments without papers, by the card they belong to */
    scheduled: Record<string, ScheduleRow[]>;
    /** Scheduled segments without papers whose category has no card */
    placeholders: PlaceholderCategory[];
    /** Missing things per card, as its header counts them */
    counts: Record<string, number>;
    /** Missing things in all; 0 = nothing to mark, nothing to ask */
    count: number;
    /** Segments the backend can produce; 0 = nothing to generate */
    generableSegments: number;
    /** One plain-text line per missing thing, for the prompt */
    lines: string[];
}

function missingScheduleRows(data: unknown): ScheduleRow[] {
    const rows = (data as { scheduleCheck?: { rows?: unknown } | null } | null)?.scheduleCheck?.rows;
    if (!Array.isArray(rows)) return [];
    return rows
        .filter((r): r is ScheduleRow => Boolean(r) && typeof r === 'object'
            && r.status === 'missing' && typeof r.name === 'string' && r.name !== '')
        .map(r => ({
            ...r,
            category: typeof r.category === 'string' ? r.category : '',
            segment: typeof r.segment === 'string' ? r.segment : '',
            categoryKey: typeof r.categoryKey === 'string' ? r.categoryKey : null,
        }));
}

/**
 * What a competition is missing, from a `get_competition_details` response:
 * the expected files of every uploaded segment and category, and — when a
 * CompetitionSchedule is uploaded — the scheduled segments that have no
 * papers at all (`scheduleCheck`; absent or null = no schedule to check).
 */
export function missingReport(data: unknown): MissingReport {
    const report: MissingReport = {
        categories: {}, scheduled: {}, placeholders: [], counts: {},
        count: 0, generableSegments: 0, lines: [],
    };
    const rawStructure = (data as { structure?: unknown } | null)?.structure;
    const structure = (rawStructure && typeof rawStructure === 'object' ? rawStructure : {}) as
        Record<string, Record<string, FileData[]>>;
    const keys = Object.keys(structure).filter(key => key !== UNCATEGORIZED).sort();

    for (const row of missingScheduleRows(data)) {
        if (row.categoryKey !== null && keys.includes(row.categoryKey)) {
            (report.scheduled[row.categoryKey] ??= []).push(row);
            continue;
        }
        const title = scheduleCategoryTitle(row);
        let group = report.placeholders.find(p => p.title === title);
        if (!group) report.placeholders.push(group = { title, rows: [] });
        group.rows.push(row);
    }

    const scheduledLine = (row: ScheduleRow): string => {
        const segment = scheduleSegmentTitle(row);
        const when = scheduleWhen(row, ', ');
        return `${scheduleCategoryTitle(row)}${segment ? `, ${segment}` : ''}${when ? ` (${when})` : ''}: no papers uploaded`;
    };

    // The prompt lists things in the order of the file list: cards and
    // placeholder cards together, by name (see cardOrder).
    const entries: Array<{ title: string, key?: string, placeholder?: PlaceholderCategory }> = [
        ...keys.map(key => ({ title: key, key })),
        ...report.placeholders.map(placeholder => ({ title: placeholder.title, placeholder })),
    ];
    entries.sort(cardOrder);

    for (const entry of entries) {
        if (entry.placeholder) {
            for (const row of entry.placeholder.rows) report.lines.push(scheduledLine(row));
            report.count += entry.placeholder.rows.length;
            continue;
        }
        const key = entry.title;
        const segments = structure[key];
        const check = validateCategory(segments);
        const scheduled = report.scheduled[key] ?? [];
        report.categories[key] = check;
        for (const [segment, files] of Object.entries(segments)) {
            if (isGenerable(files)) report.generableSegments += 1;
            const missing = check.missingBySegment[segment];
            if (missing) {
                report.lines.push(`${key}, ${segment}: ${missing.join(', ')}`
                    + (isGenerable(files) ? '' : ' — this segment will be left out of the papers'));
            }
        }
        for (const file of check.missingCategoryFiles) report.lines.push(`${key}: ${file}`);
        // The scheduled segments say the same thing, by name
        const generic = check.noSegmentPapers && scheduled.length === 0;
        if (generic) report.lines.push(`${key}: no segment papers uploaded`);
        for (const row of scheduled) report.lines.push(scheduledLine(row));
        report.counts[key] = check.missingCount - (check.noSegmentPapers && !generic ? 1 : 0) + scheduled.length;
        report.count += report.counts[key];
    }
    return report;
}

/** The order of the cards in the file list: by title, as `Array.prototype.sort` orders strings */
export function cardOrder(a: { title: string }, b: { title: string }): number {
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
}
