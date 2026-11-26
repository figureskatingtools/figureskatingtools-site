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
    /** found = papers are uploaded; missing = none; notNeeded = none, and no entries either */
    status: 'found' | 'missing' | 'notNeeded';
    prefix: string | null;
    /** The key of the row's category in `structure`, null when it has none */
    categoryKey: string | null;
}

/** What one category card is missing */
export interface CategoryCheck {
    isValid: boolean;
    /**
     * Segment key -> the files it is missing, as shown in the list. Each
     * carries its FSM prefix, `RefereeSheet.pdf (PREFIX)`, when the block
     * holds several FSM segments.
     */
    missingBySegment: Record<string, string[]>;
    /** Files expected once per category (the calculation setup) */
    missingCategoryFiles: string[];
    /**
     * The calculation setup is uploaded, but no segment has any papers yet.
     * Nothing is expected of such a category by its files alone (isValid
     * stays true); the competition schedule may say otherwise, see missingReport.
     */
    noSegmentPapers: boolean;
    /** Missing files */
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

/** The FSM file prefix of a file: everything before the last `_` of its name */
function filePrefix(file: FileData): string {
    return file.prefix ?? file.filename.slice(0, Math.max(file.filename.lastIndexOf('_'), 0));
}

/**
 * One FSM segment inside a displayed segment block: the files of one file
 * prefix. A block normally holds one. It holds several when FSM prints two
 * segments under one name, and then each is checked on its own: the backend
 * reads every sheet by its own prefix, so one segment's sheets never stand in
 * for another's, and a panel never pairs with another prefix's time schedule.
 */
export interface PrefixCheck {
    prefix: string;
    /** The files it is expected to have and does not, in list order */
    missing: string[];
    /** The backend can produce it: its panel and its time schedule are there */
    generable: boolean;
}

/** The files one FSM segment is expected to have and does not, in list order */
function missingOfPrefix(files: FileData[]): string[] {
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

/** The FSM segments of a displayed segment block, in the order their first files appear */
export function prefixChecks(files: FileData[]): PrefixCheck[] {
    const groups = new Map<string, FileData[]>();
    for (const file of files) {
        const prefix = filePrefix(file);
        if (!groups.has(prefix)) groups.set(prefix, []);
        groups.get(prefix)!.push(file);
    }
    return [...groups].map(([prefix, group]) => ({
        prefix,
        missing: missingOfPrefix(group),
        generable: GENERATE_NEEDS.every(req => group.some(f => f.suffix === req)),
    }));
}

export function validateCategory(
    segments: Record<string, FileData[]>
): CategoryCheck {
    const missingBySegment: Record<string, string[]> = {};
    const missingCategoryFiles: string[] = [];

    const allFiles = Object.values(segments).flat();
    const hasCalcSetup = allFiles.some(f => f.suffix === CATEGORY_GENERAL_FILE);
    const realSegments = Object.keys(segments).filter(s => !SKIP_SEGMENTS.includes(s));

    // Papers are expected only where some are uploaded: a segment is checked
    // once it has a file of its own, and the calculation setup is required
    // once the category has such a segment. The papers of later segments
    // often cannot be made before the earlier ones are skated, so a segment
    // with nothing uploaded is never "missing" here.
    if (realSegments.length > 0 && !hasCalcSetup) {
        missingCategoryFiles.push(CATEGORY_GENERAL_FILE);
    }
    const noSegmentPapers = hasCalcSetup && realSegments.length === 0;

    for (const segmentName of realSegments) {
        const checks = prefixChecks(segments[segmentName]);
        // A block of several FSM segments says whose file each missing one is
        const missing = checks.flatMap(part =>
            part.missing.map(label => (checks.length > 1 ? `${label} (${part.prefix})` : label)));
        if (missing.length) missingBySegment[segmentName] = missing;
    }

    const missingCount = Object.values(missingBySegment).reduce((n, files) => n + files.length, 0)
        + missingCategoryFiles.length;
    return {
        isValid: missingCount === 0,
        missingBySegment,
        missingCategoryFiles,
        noSegmentPapers,
        missingCount,
    };
}

/** True when the backend can produce papers for at least one FSM segment of these files */
export function isGenerable(files: FileData[]): boolean {
    return prefixChecks(files).some(part => part.generable);
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

/** A segment of the competition schedule that has no papers, as the file list shows it */
export interface ScheduledSegment {
    row: ScheduleRow;
    /**
     * true = its papers should be here: marked missing, and asked about before
     * generating. false = a quiet "not uploaded yet" note. See missingReport.
     */
    expected: boolean;
}

/** A scheduled category nothing is uploaded for: a card of its own in the list */
export interface PlaceholderCategory {
    title: string;
    segments: ScheduledSegment[];
}

/** Everything that is missing in a competition, for the file list and the Generate prompt */
export interface MissingReport {
    /** Per category card (structure key); unrecognised files are left out */
    categories: Record<string, CategoryCheck>;
    /** Scheduled segments without papers, by the card they belong to */
    scheduled: Record<string, ScheduledSegment[]>;
    /** Scheduled segments without papers whose category has no card */
    placeholders: PlaceholderCategory[];
    /** Missing things per card, as its header counts them */
    counts: Record<string, number>;
    /** Scheduled segments per card that are not uploaded yet and not missing either */
    pending: Record<string, number>;
    /** Missing things in all; 0 = nothing to mark, nothing to ask */
    count: number;
    /** FSM segments the backend can produce; 0 = nothing to generate */
    generableSegments: number;
    /** One plain-text line per missing thing, for the prompt */
    lines: string[];
}

function scheduleRows(data: unknown): ScheduleRow[] {
    const rows = (data as { scheduleCheck?: { rows?: unknown } | null } | null)?.scheduleCheck?.rows;
    if (!Array.isArray(rows)) return [];
    return rows
        .filter((r): r is ScheduleRow => Boolean(r) && typeof r === 'object'
            && typeof r.name === 'string' && r.name !== '')
        .map(r => ({
            ...r,
            date: typeof r.date === 'string' && r.date !== '' ? r.date : null,
            startTime: typeof r.startTime === 'string' && r.startTime !== '' ? r.startTime : null,
            category: typeof r.category === 'string' ? r.category : '',
            segment: typeof r.segment === 'string' ? r.segment : '',
            categoryKey: typeof r.categoryKey === 'string' ? r.categoryKey : null,
        }));
}

/** Minutes from midnight of an `HH:MM` start time; a row without one sorts last */
function startMinutes(row: ScheduleRow): number {
    const time = /^(\d{1,2}):(\d{2})/.exec(row.startTime ?? '');
    return time ? Number(time[1]) * 60 + Number(time[2]) : Number.POSITIVE_INFINITY;
}

/** The earliest of these rows by day and start time; undefined when none has a day */
function firstScheduled(rows: ScheduleRow[]): ScheduleRow | undefined {
    let first: ScheduleRow | undefined;
    for (const row of rows) {
        if (row.date === null) continue;
        if (!first || row.date < first.date!
            || (row.date === first.date && startMinutes(row) < startMinutes(first))) {
            first = row;
        }
    }
    return first;
}

/** True when a category has papers of at least one skating segment */
function hasSegmentPapers(segments: Record<string, FileData[]> | undefined): boolean {
    return Object.keys(segments ?? {}).some(segment => !SKIP_SEGMENTS.includes(segment));
}

/**
 * What a competition is missing, from a `get_competition_details` response.
 *
 * Papers are expected only where some are uploaded, because a competition is
 * rarely uploaded in one go: the papers of a later segment (a Free Skating
 * in reverse order of the Short Program's result) are made once the earlier
 * one is skated, and often only the first day exists before the competition.
 *
 * - A segment with at least one file of its own is expected to have all its
 *   files; the calculation setup is expected once the category has such a
 *   segment. These are the missing files.
 * - A segment of the uploaded CompetitionSchedule with no papers
 *   (`scheduleCheck`; absent or null = no schedule) is a quiet "not uploaded
 *   yet" note, with one exception, the forgotten category of issue #84: when
 *   NO segment of a category has papers, its first scheduled segment is
 *   missing if it is skated on a day for which papers of another category
 *   are uploaded. A first segment needs no earlier result, so on a day that
 *   is being prepared it should be there. Later segments of that category,
 *   and categories that start on a day nothing is uploaded for, stay quiet.
 *
 * Only missing things count, are listed for the prompt and mark a card.
 */
export function missingReport(data: unknown): MissingReport {
    const report: MissingReport = {
        categories: {}, scheduled: {}, placeholders: [], counts: {}, pending: {},
        count: 0, generableSegments: 0, lines: [],
    };
    const rawStructure = (data as { structure?: unknown } | null)?.structure;
    const structure = (rawStructure && typeof rawStructure === 'object' ? rawStructure : {}) as
        Record<string, Record<string, FileData[]>>;
    const keys = Object.keys(structure).filter(key => key !== UNCATEGORIZED).sort();

    const rows = scheduleRows(data);
    // The days being prepared: a segment skated that day has its papers here
    const uploadedDays = new Set(rows.filter(row => row.status === 'found').map(row => row.date));

    const byCard: Record<string, ScheduleRow[]> = {};
    const byTitle: Array<{ title: string, rows: ScheduleRow[] }> = [];
    for (const row of rows) {
        if (row.status !== 'missing') continue;
        if (row.categoryKey !== null && keys.includes(row.categoryKey)) {
            (byCard[row.categoryKey] ??= []).push(row);
            continue;
        }
        const title = scheduleCategoryTitle(row);
        let group = byTitle.find(g => g.title === title);
        if (!group) byTitle.push(group = { title, rows: [] });
        group.rows.push(row);
    }

    /** The rows of one card, in schedule order, each with whether its papers should be here */
    const scheduledSegments = (cardRows: ScheduleRow[], started: boolean): ScheduledSegment[] => {
        const first = started ? undefined : firstScheduled(cardRows);
        const expected = first && uploadedDays.has(first.date) ? first : undefined;
        return cardRows.map(row => ({ row, expected: row === expected }));
    };

    for (const key of Object.keys(byCard)) {
        report.scheduled[key] = scheduledSegments(byCard[key], hasSegmentPapers(structure[key]));
    }
    report.placeholders = byTitle.map(group => ({
        title: group.title, segments: scheduledSegments(group.rows, false),
    }));

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
            const expected = entry.placeholder.segments.filter(segment => segment.expected);
            for (const segment of expected) report.lines.push(scheduledLine(segment.row));
            report.count += expected.length;
            continue;
        }
        const key = entry.title;
        const segments = structure[key];
        const check = validateCategory(segments);
        const scheduled = report.scheduled[key] ?? [];
        report.categories[key] = check;
        for (const [segment, files] of Object.entries(segments)) {
            const parts = prefixChecks(files);
            report.generableSegments += parts.filter(part => part.generable).length;
            if (!check.missingBySegment[segment]) continue;   // nothing missing, or not a skating segment
            for (const part of parts) {
                if (!part.missing.length) continue;
                report.lines.push(`${key}, ${segment}${parts.length > 1 ? ` (${part.prefix})` : ''}: ${part.missing.join(', ')}`
                    + (part.generable ? '' : ' — this segment will be left out of the papers'));
            }
        }
        for (const file of check.missingCategoryFiles) report.lines.push(`${key}: ${file}`);
        const expected = scheduled.filter(segment => segment.expected);
        for (const segment of expected) report.lines.push(scheduledLine(segment.row));
        report.counts[key] = check.missingCount + expected.length;
        report.pending[key] = scheduled.length - expected.length;
        report.count += report.counts[key];
    }
    return report;
}

/** The order of the cards in the file list: by title, as `Array.prototype.sort` orders strings */
export function cardOrder(a: { title: string }, b: { title: string }): number {
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
}
