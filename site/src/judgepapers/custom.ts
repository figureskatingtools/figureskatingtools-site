/**
 * Custom generate (fs-judgepapers issue #85): print a chosen part of the
 * judging papers. The backend's `get_papers_index` returns the *papers index*
 * of the last generate run: per day the people of the day document, each
 * packet part by part with page counts. This module turns the index into the
 * selection model behind the dialog (custom-dialog.ts) and the model back
 * into the selection `generate_custom_papers` takes (fs-judgepapers
 * custom_papers.validate_selection). Pure: no DOM, no requests.
 *
 * A *unit* is the smallest tickable thing: one person's papers for one role
 * in one segment, a personal cover page, or a day's combined schedule. A
 * *group* is any tick that covers units (a day, a person, a segment for
 * everyone, a role, ...). The selection is one set of unit keys, and every
 * tick on screen is a view of that set. Something without pages is no unit:
 * its row is shown, but it can never be ticked or sent.
 */

/* ── The three choices decided with the user: one line each to flip ── */

/** What is ticked when the list opens: 'none' (the user picks), or 'all' */
export const INITIAL_SELECTION = 'none' as 'all' | 'none';
/** How Quick select groups the segments when the dialog opens: 'day' or 'category' */
export const DEFAULT_SEGMENT_GROUPING = 'day' as SegmentGrouping;
/**
 * A category gets a row of its own once it groups this many rows of a
 * person's day (and of a day in Quick select "By day"). 1 = always, so the
 * tree is strictly Day → Person → Category → Segment; with 2, a category's
 * only row of the day stands alone and reads "Category, Segment".
 */
export const CATEGORY_ROW_MIN = 1;

export type SegmentGrouping = 'day' | 'category';

/* ── The index (get_papers_index) ── */

export interface IndexSegment {
    /** YYYYMMDD */
    date: string;
    /** HH:MM; '' when the papers gave no start time */
    start: string;
    /** Category and segment as FSM printed them on the judges' sheets */
    category: string;
    segment: string;
}

/** One role of a person in one segment: the page before the segment + that role's papers */
export interface IndexPart {
    /** FSM file prefix of the segment */
    prefix: string;
    role: string;
    /** The role as the panel prints it, e.g. `Judge 3` */
    label: string;
    pages: number;
    /** `calculationSetup`, `patternDanceSkipped`, `noTraineeSheet` */
    flags: string[];
}

export interface IndexPerson {
    slug: string;
    name: string;
    pages: number;
    /** Pages of the personal cover */
    cover: number;
    /** In packet order */
    parts: IndexPart[];
}

export interface IndexDay {
    /** YYYYMMDD */
    date: string;
    pages: number;
    /** The day's combined time schedule: pages of one copy, and the copies */
    schedule: { pages: number; copies: number } | null;
    /** In print order */
    people: IndexPerson[];
}

export interface PapersIndex {
    /** The generate run the index describes; goes back with the selection */
    generation: string;
    /** ISO time of that run; '' when unknown */
    generatedUtc: string;
    segments: Map<string, IndexSegment>;
    days: IndexDay[];
}

/** The body of `generate_custom_papers`' `selection` */
export type CustomSelection = Record<string, {
    schedule: boolean;
    people: Record<string, { cover: boolean; parts: [string, string][] }>;
}>;

/** The last custom run's selection, as the backend stored it */
export interface LastSelection {
    /** ISO time; '' when unknown */
    savedUtc: string;
    /** Pages of that run; 0 when unknown */
    pages: number;
    selection: unknown;
}

/** A `get_papers_index` response */
export interface IndexAnswer {
    /** The stored index describes the papers a Generate would make right now */
    current: boolean;
    /** Why not, when not current: none | files | options | outputs | ... */
    reason: string | null;
    /** null unless current */
    index: PapersIndex | null;
    last: LastSelection | null;
    /** Files the backend re-copied from the competition file pool on this call */
    refreshedFromPool: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number =>
    (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0);

/** The index of a response, or null when it is not one (nothing is drawn from a half-read index) */
export function parseIndex(raw: unknown): PapersIndex | null {
    if (!isObject(raw) || !text(raw.generation) || !Array.isArray(raw.days)) return null;
    const segments = new Map<string, IndexSegment>();
    if (isObject(raw.segments)) {
        for (const [prefix, segment] of Object.entries(raw.segments)) {
            if (!isObject(segment)) continue;
            segments.set(prefix, {
                date: text(segment.date),
                start: text(segment.start),
                category: text(segment.category),
                segment: text(segment.segment),
            });
        }
    }
    const days: IndexDay[] = [];
    for (const day of raw.days) {
        if (!isObject(day) || !/^\d{8}$/.test(text(day.date)) || !Array.isArray(day.people)) return null;
        const people: IndexPerson[] = [];
        for (const person of day.people) {
            if (!isObject(person) || !text(person.slug) || !Array.isArray(person.parts)) return null;
            const parts: IndexPart[] = [];
            for (const part of person.parts) {
                if (!isObject(part) || !text(part.prefix) || !text(part.role)) return null;
                parts.push({
                    prefix: text(part.prefix),
                    role: text(part.role),
                    label: text(part.label),
                    pages: count(part.pages),
                    flags: Array.isArray(part.flags) ? part.flags.filter((f): f is string => typeof f === 'string') : [],
                });
            }
            people.push({
                slug: text(person.slug),
                name: text(person.name) || text(person.slug),
                pages: count(person.pages),
                cover: count(person.cover),
                parts,
            });
        }
        const schedule = isObject(day.schedule)
            ? { pages: count(day.schedule.pages), copies: count(day.schedule.copies) }
            : null;
        days.push({ date: text(day.date), pages: count(day.pages), schedule, people });
    }
    return { generation: text(raw.generation), generatedUtc: text(raw.generatedUtc), segments, days };
}

/** A `get_papers_index` response body, or null when it is not one */
export function parseIndexAnswer(raw: unknown): IndexAnswer | null {
    if (!isObject(raw) || typeof raw.current !== 'boolean') return null;
    const index = raw.current ? parseIndex(raw.index) : null;
    if (raw.current && !index) return null;
    const stored = raw.lastSelection;
    const last = isObject(stored) && isObject(stored.selection)
        ? { savedUtc: text(stored.savedUtc), pages: count(stored.pages), selection: stored.selection }
        : null;
    return {
        current: raw.current,
        reason: typeof raw.reason === 'string' ? raw.reason : null,
        index,
        last,
        refreshedFromPool: Array.isArray(raw.refreshedFromPool) ? raw.refreshedFromPool.map(String) : [],
    };
}

/* ── The model ── */

/** The keys of the units: what the selection holds */
export const unitKey = {
    part: (date: string, slug: string, prefix: string, role: string) => `${date}|${slug}|${prefix}|${role}`,
    cover: (date: string, slug: string) => `${date}|${slug}|cover`,
    schedule: (date: string) => `${date}|schedule`,
};

/** The ids of the groups: what a tick on screen stands for */
export const groupId = {
    /** Everything */
    all: 'all',
    /** Every personal cover page */
    covers: 'covers',
    /** Every day's combined schedule */
    schedules: 'schedules',
    day: (date: string) => `day:${date}`,
    /** One day's combined schedule */
    schedule: (date: string) => `sched:${date}`,
    /** One person's packet of a day */
    person: (date: string, slug: string) => `person:${date}|${slug}`,
    cover: (date: string, slug: string) => `cover:${date}|${slug}`,
    /** A category within one person's day */
    personCategory: (date: string, slug: string, category: string) => `pcat:${date}|${slug}|${category}`,
    /** One row of a person: one role in one segment */
    part: (date: string, slug: string, prefix: string, role: string) => `part:${date}|${slug}|${prefix}|${role}`,
    /** A segment, for every person */
    segment: (prefix: string) => `seg:${prefix}`,
    /** A category's segments of one day, for every person */
    dayCategory: (date: string, category: string) => `dcat:${date}|${category}`,
    /** A category's segments on every day, for every person */
    category: (category: string) => `cat:${category}`,
    /** A role, in every segment */
    role: (role: string) => `role:${role}`,
};

export interface Unit {
    key: string;
    kind: 'part' | 'cover' | 'schedule';
    date: string;
    /** Absent on a schedule */
    slug?: string;
    prefix?: string;
    role?: string;
    /** Always more than 0 */
    pages: number;
}

export interface Group {
    /** The units a tick on the group sets */
    keys: string[];
    /** Their pages */
    pages: number;
}

export interface CustomModel {
    index: PapersIndex;
    units: Map<string, Unit>;
    groups: Map<string, Group>;
}

/** Category and segment of a prefix; the prefix stands in for a segment the index does not describe */
export function segmentOf(index: PapersIndex, prefix: string): IndexSegment {
    const segment = index.segments.get(prefix);
    return {
        date: segment?.date ?? '',
        start: segment?.start ?? '',
        category: segment?.category || prefix,
        segment: segment?.segment ?? '',
    };
}

export function buildModel(index: PapersIndex): CustomModel {
    const units = new Map<string, Unit>();
    const groups = new Map<string, Group>();
    const seen = new Set<string>();
    const add = (unit: Unit, ids: string[]) => {
        if (seen.has(unit.key)) return;
        seen.add(unit.key);
        for (const id of [groupId.all, ...ids]) {
            let group = groups.get(id);
            if (!group) groups.set(id, group = { keys: [], pages: 0 });
            // A row without pages keeps its (empty) groups, so it can be shown
            if (unit.pages > 0) {
                group.keys.push(unit.key);
                group.pages += unit.pages;
            }
        }
        if (unit.pages > 0) units.set(unit.key, unit);
    };
    for (const day of index.days) {
        const date = day.date;
        if (day.schedule) {
            add({ key: unitKey.schedule(date), kind: 'schedule', date, pages: day.schedule.pages * day.schedule.copies },
                [groupId.day(date), groupId.schedule(date), groupId.schedules]);
        }
        for (const person of day.people) {
            const slug = person.slug;
            add({ key: unitKey.cover(date, slug), kind: 'cover', date, slug, pages: person.cover },
                [groupId.day(date), groupId.person(date, slug), groupId.cover(date, slug), groupId.covers]);
            for (const part of person.parts) {
                const category = segmentOf(index, part.prefix).category;
                add({
                    key: unitKey.part(date, slug, part.prefix, part.role),
                    kind: 'part', date, slug, prefix: part.prefix, role: part.role, pages: part.pages,
                }, [
                    groupId.day(date), groupId.person(date, slug), groupId.personCategory(date, slug, category),
                    groupId.part(date, slug, part.prefix, part.role), groupId.segment(part.prefix),
                    groupId.dayCategory(date, category), groupId.category(category), groupId.role(part.role),
                ]);
            }
        }
    }
    return { index, units, groups };
}

/* ── The selection ── */

export interface GroupState {
    /** Units of the group that are selected, and how many it has */
    selected: number;
    count: number;
    /** Selected pages, and the group's pages */
    pages: number;
    total: number;
    all: boolean;
    none: boolean;
    /** Partly selected: the tick is mixed */
    some: boolean;
    /** Nothing with pages: the tick is disabled */
    empty: boolean;
}

/** The tri-state of a group's tick */
export function stateOf(model: CustomModel, sel: ReadonlySet<string>, id: string): GroupState {
    const group = model.groups.get(id);
    let selected = 0;
    let pages = 0;
    for (const key of group?.keys ?? []) {
        if (!sel.has(key)) continue;
        selected++;
        pages += model.units.get(key)?.pages ?? 0;
    }
    const size = group?.keys.length ?? 0;
    return {
        selected, count: size, pages, total: group?.pages ?? 0,
        all: size > 0 && selected === size,
        none: selected === 0,
        some: selected > 0 && selected < size,
        empty: size === 0,
    };
}

/** Tick or untick units; keys that are no unit of the model are ignored */
export function setKeys(model: CustomModel, sel: Set<string>, keys: Iterable<string>, on: boolean): void {
    for (const key of keys) {
        if (!on) sel.delete(key);
        else if (model.units.has(key)) sel.add(key);
    }
}

/** Tick or untick everything a group covers */
export function setGroup(model: CustomModel, sel: Set<string>, id: string, on: boolean): void {
    setKeys(model, sel, model.groups.get(id)?.keys ?? [], on);
}

export function selectAll(model: CustomModel, sel: Set<string>): void {
    setKeys(model, sel, model.units.keys(), true);
}

export function selectNone(sel: Set<string>): void {
    sel.clear();
}

export function invertSelection(model: CustomModel, sel: Set<string>): void {
    for (const key of model.units.keys()) {
        if (sel.has(key)) sel.delete(key);
        else sel.add(key);
    }
}

/** The selection a list opens with (INITIAL_SELECTION) */
export function initialSelection(model: CustomModel, mode: 'all' | 'none' = INITIAL_SELECTION): Set<string> {
    const sel = new Set<string>();
    if (mode === 'all') selectAll(model, sel);
    return sel;
}

/** A selection carried over to another index (the papers were prepared again): what still exists stays ticked */
export function carryOver(model: CustomModel, keys: Iterable<string>): Set<string> {
    const sel = new Set<string>();
    setKeys(model, sel, keys, true);
    return sel;
}

/** The unit keys of a stored selection (the request's shape) that still exist */
export function selectionKeys(model: CustomModel, selection: unknown): string[] {
    const keys: string[] = [];
    const keep = (key: string) => { if (model.units.has(key)) keys.push(key); };
    if (!isObject(selection)) return keys;
    for (const [date, day] of Object.entries(selection)) {
        if (!isObject(day)) continue;
        if (day.schedule === true) keep(unitKey.schedule(date));
        if (!isObject(day.people)) continue;
        for (const [slug, person] of Object.entries(day.people)) {
            if (!isObject(person)) continue;
            if (person.cover === true) keep(unitKey.cover(date, slug));
            if (!Array.isArray(person.parts)) continue;
            for (const part of person.parts) {
                if (Array.isArray(part) && typeof part[0] === 'string' && typeof part[1] === 'string') {
                    keep(unitKey.part(date, slug, part[0], part[1]));
                }
            }
        }
    }
    return keys;
}

/** "Last selection": exactly what the last custom run held, as far as it still exists */
export function applyLast(model: CustomModel, sel: Set<string>, selection: unknown): void {
    sel.clear();
    setKeys(model, sel, selectionKeys(model, selection), true);
}

/** "Not in last selection": everything the last custom run did not hold */
export function applyNotInLast(model: CustomModel, sel: Set<string>, selection: unknown): void {
    selectAll(model, sel);
    setKeys(model, sel, selectionKeys(model, selection), false);
}

export interface Totals {
    /** Selected pages, of all the pages */
    pages: number;
    total: number;
    /** Person-days with something selected */
    packets: number;
    /** Days with something selected */
    days: number;
}

export function totals(model: CustomModel, sel: ReadonlySet<string>): Totals {
    const packets = new Set<string>();
    const days = new Set<string>();
    let pages = 0;
    for (const key of sel) {
        const unit = model.units.get(key);
        if (!unit) continue;
        pages += unit.pages;
        days.add(unit.date);
        if (unit.slug !== undefined) packets.add(`${unit.date}|${unit.slug}`);
    }
    return { pages, total: model.groups.get(groupId.all)?.pages ?? 0, packets: packets.size, days: days.size };
}

/** Selected cover pages of people who have nothing else selected that day */
export function loneCovers(model: CustomModel, sel: ReadonlySet<string>): string[] {
    const lone: string[] = [];
    for (const key of model.groups.get(groupId.covers)?.keys ?? []) {
        if (!sel.has(key)) continue;
        const unit = model.units.get(key);
        if (unit?.slug !== undefined && stateOf(model, sel, groupId.person(unit.date, unit.slug)).selected === 1) {
            lone.push(key);
        }
    }
    return lone;
}

/** "Leave those covers out" */
export function dropLoneCovers(model: CustomModel, sel: Set<string>): void {
    setKeys(model, sel, loneCovers(model, sel), false);
}

/** The selection in the shape `generate_custom_papers` takes; people and days with nothing ticked are left out */
export function toRequest(model: CustomModel, sel: ReadonlySet<string>): CustomSelection {
    const request: CustomSelection = {};
    for (const day of model.index.days) {
        const date = day.date;
        const schedule = sel.has(unitKey.schedule(date)) && model.units.has(unitKey.schedule(date));
        const people: CustomSelection[string]['people'] = {};
        for (const person of day.people) {
            const cover = sel.has(unitKey.cover(date, person.slug)) && model.units.has(unitKey.cover(date, person.slug));
            const parts: [string, string][] = [];
            for (const part of person.parts) {
                const key = unitKey.part(date, person.slug, part.prefix, part.role);
                if (sel.has(key) && model.units.has(key)
                        && !parts.some(([prefix, role]) => prefix === part.prefix && role === part.role)) {
                    parts.push([part.prefix, part.role]);
                }
            }
            if (cover || parts.length) people[person.slug] = { cover, parts };
        }
        if (schedule || Object.keys(people).length) request[date] = { schedule, people };
    }
    return request;
}

/* ── The person filter ── */

/** A name for comparing: no diacritics, lower case, single spaces */
export function normalizeName(value: string): string {
    return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The people whose name holds `query`, ignoring case and diacritics, as ids
 * `date|slug`; null when the query is empty (no filter).
 */
export function filterPeople(index: PapersIndex, query: string): Set<string> | null {
    const wanted = normalizeName(query);
    if (!wanted) return null;
    const hits = new Set<string>();
    for (const day of index.days) {
        for (const person of day.people) {
            if (normalizeName(person.name).includes(wanted)) hits.add(personId(day.date, person.slug));
        }
    }
    return hits;
}

/** A person's packet of one day, as the filter and the rows name it */
export const personId = (date: string, slug: string): string => `${date}|${slug}`;

/* ── What the two panes list ── */

const ROLE_ORDER: Array<[role: string, many: string, one: string]> = [
    ['judge', 'Judges', 'Judge'],
    ['referee', 'Referees', 'Referee'],
    ['technical_controller', 'Technical Controllers', 'Technical Controller'],
    ['technical_specialist_1', 'Technical Specialists 1', 'Technical Specialist'],
    ['technical_specialist_2', 'Technical Specialists 2', 'Technical Specialist'],
    ['data_operator', 'Data Operators', 'Data Operator'],
    ['replay_operator', 'Replay Operators', 'Replay Operator'],
    ['judge_trainee', 'Judge Trainees', 'Trainee'],
    ['technical_trainee', 'Technical Trainees', 'Trainee'],
];

/** `some_new_role` → `Some new role`, for a role this page does not know yet */
const roleWords = (role: string): string => {
    const words = role.replace(/_/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The roles a person holds that day, in short: `Judge · Referee` */
export function personRoles(person: IndexPerson): string {
    const names: string[] = [];
    for (const part of person.parts) {
        const name = ROLE_ORDER.find(([role]) => role === part.role)?.[2] ?? roleWords(part.role);
        if (!names.includes(name)) names.push(name);
    }
    return names.join(' · ');
}

/** What a part's flags tell the operator; '' for none */
export function partNote(part: IndexPart): string {
    const notes: string[] = [];
    if (part.flags.includes('calculationSetup')) notes.push('with the calculation setup');
    if (part.flags.includes('patternDanceSkipped')) notes.push('no papers in Pattern Dance');
    if (part.flags.includes('noTraineeSheet')) notes.push('no sheet to copy');
    return notes.join(', ');
}

export interface RoleChoice {
    group: string;
    role: string;
    label: string;
}

/** The roles the papers hold, in panel order; unknown ones last */
export function roleChoices(model: CustomModel): RoleChoice[] {
    const present: string[] = [];
    for (const day of model.index.days) {
        for (const person of day.people) {
            for (const part of person.parts) if (!present.includes(part.role)) present.push(part.role);
        }
    }
    const known = ROLE_ORDER.filter(([role]) => present.includes(role))
        .map(([role, label]) => ({ group: groupId.role(role), role, label }));
    const unknown = present.filter(role => !ROLE_ORDER.some(([known]) => known === role))
        .map(role => ({ group: groupId.role(role), role, label: roleWords(role) }));
    return [...known, ...unknown];
}

/** Items grouped by category name, categories in the order they first appear */
function byCategory<T>(items: T[], categoryOf: (item: T) => string): Array<{ name: string; items: T[] }> {
    const categories: Array<{ name: string; items: T[] }> = [];
    for (const item of items) {
        const name = categoryOf(item);
        let category = categories.find(c => c.name === name);
        if (!category) categories.push(category = { name, items: [] });
        category.items.push(item);
    }
    return categories;
}

/** One role of a person in one segment, as a row */
export interface PartRow {
    group: string;
    part: IndexPart;
    start: string;
    category: string;
    segment: string;
}

/**
 * A row under a person: a category with the person's parts of it (they read
 * "Segment"), or, only when CATEGORY_ROW_MIN is above 1, a part on its own
 * (it reads "Category, Segment").
 */
export type PersonRow =
    | { kind: 'part'; row: PartRow }
    | { kind: 'category'; group: string; name: string; rows: PartRow[] };

/** A person's rows of a day below the cover page; `minRows` (CATEGORY_ROW_MIN) decides the category rows */
export function personRows(index: PapersIndex, date: string, person: IndexPerson,
                           minRows: number = CATEGORY_ROW_MIN): PersonRow[] {
    const rows: PartRow[] = [];
    for (const part of person.parts) {
        const group = groupId.part(date, person.slug, part.prefix, part.role);
        if (rows.some(row => row.group === group)) continue;
        const segment = segmentOf(index, part.prefix);
        rows.push({ group, part, start: segment.start, category: segment.category, segment: segment.segment });
    }
    return byCategory(rows, row => row.category).flatMap((category): PersonRow[] =>
        category.items.length >= minRows
            ? [{
                kind: 'category',
                group: groupId.personCategory(date, person.slug, category.name),
                name: category.name,
                rows: category.items,
            }]
            : category.items.map(row => ({ kind: 'part', row })));
}

/** A segment in Quick select: one tick sets it for every person */
export interface QuickSegment {
    group: string;
    prefix: string;
    /** The day its papers are in */
    date: string;
    start: string;
    category: string;
    segment: string;
    /** People with papers in it */
    people: number;
}

export type QuickDayRow =
    | { kind: 'segment'; segment: QuickSegment }
    | { kind: 'category'; group: string; name: string; segments: QuickSegment[] };

export interface QuickDay {
    date: string;
    rows: QuickDayRow[];
}

export interface QuickCategory {
    group: string;
    name: string;
    segments: QuickSegment[];
}

/** Every segment the papers hold, in running order (day, then start time) */
function quickSegments(model: CustomModel): QuickSegment[] {
    const segments = new Map<string, QuickSegment>();
    const order: string[] = [];
    for (const day of model.index.days) {
        for (const person of day.people) {
            for (const part of person.parts) {
                if (segments.has(part.prefix)) continue;
                const segment = segmentOf(model.index, part.prefix);
                const group = groupId.segment(part.prefix);
                const people = new Set((model.groups.get(group)?.keys ?? []).map(key => {
                    const unit = model.units.get(key);
                    return `${unit?.date}|${unit?.slug}`;
                }));
                segments.set(part.prefix, {
                    group, prefix: part.prefix, date: day.date, start: segment.start,
                    category: segment.category, segment: segment.segment, people: people.size,
                });
                order.push(part.prefix);
            }
        }
    }
    // A segment without a start time goes after the day's timed ones; ties keep the papers' order
    const when = (s: QuickSegment) => `${s.date} ${s.start || '99:99'}`;
    return order.map(prefix => segments.get(prefix)!)
        .map((segment, at) => ({ segment, at }))
        .sort((a, b) => when(a.segment).localeCompare(when(b.segment)) || a.at - b.at)
        .map(({ segment }) => segment);
}

/** Quick select "By day": Day → Category → Segment; `minRows` as in personRows */
export function quickByDay(model: CustomModel, minRows: number = CATEGORY_ROW_MIN): QuickDay[] {
    const segments = quickSegments(model);
    return model.index.days
        .map(day => ({
            date: day.date,
            rows: byCategory(segments.filter(s => s.date === day.date), s => s.category)
                .flatMap((category): QuickDayRow[] => category.items.length >= minRows
                    ? [{
                        kind: 'category',
                        group: groupId.dayCategory(day.date, category.name),
                        name: category.name,
                        segments: category.items,
                    }]
                    : category.items.map(segment => ({ kind: 'segment', segment }))),
        }))
        .filter(day => day.rows.length > 0);
}

/** Quick select "By category": Category → its segments on every day */
export function quickByCategory(model: CustomModel): QuickCategory[] {
    return byCategory(quickSegments(model), s => s.category)
        .map(category => ({ group: groupId.category(category.name), name: category.name, segments: category.items }));
}

/* ── Wording ── */

/** `2034` → `2 034` (a no-break space, so a number never wraps) */
export function formatCount(n: number): string {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** `1 packet`, `38 packets` */
export function plural(n: number, one: string, many: string): string {
    return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** What a tick's page column reads: `61 p`, or `47 / 61 p` when partly selected */
export function pagesText(state: GroupState): string {
    return state.some ? `${formatCount(state.pages)} / ${formatCount(state.total)} p` : `${formatCount(state.total)} p`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `20260313` → `Fri 13 Mar`; anything else comes back as it is */
export function dayLabel(date: string): string {
    if (!/^\d{8}$/.test(date)) return date;
    const day = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))));
    if (Number.isNaN(day.getTime())) return date;
    return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
}

/** An ISO time as `26 Nov 14:02` in the user's time zone; '' when it is none */
export function timeLabel(iso: string): string {
    const time = new Date(iso);
    if (!iso || Number.isNaN(time.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${time.getDate()} ${MONTHS[time.getMonth()]} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}
