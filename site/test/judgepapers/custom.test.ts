/**
 * Unit tests for the Judge Paper Creator's Custom generate model
 * (`site/src/judgepapers/custom.ts`): the units and groups built from the
 * backend's papers index, the tri-state of every tick, the quick selections,
 * the totals, lone covers, the person filter and the selection sent to
 * `generate_custom_papers`. Every name is made up.
 */

import { describe, expect, it } from 'vitest';

import {
  CATEGORY_ROW_MIN,
  DEFAULT_SEGMENT_GROUPING,
  INITIAL_SELECTION,
  applyLast,
  applyNotInLast,
  buildModel,
  carryOver,
  dayLabel,
  dropLoneCovers,
  filterPeople,
  formatCount,
  groupId,
  initialSelection,
  invertSelection,
  loneCovers,
  normalizeName,
  pagesText,
  parseIndex,
  parseIndexAnswer,
  partNote,
  personRoles,
  personRows,
  plural,
  quickByCategory,
  quickByDay,
  roleChoices,
  selectAll,
  selectNone,
  selectionKeys,
  setGroup,
  setKeys,
  stateOf,
  timeLabel,
  toRequest,
  totals,
  unitKey,
  type CustomModel,
  type PapersIndex,
} from '../../src/judgepapers/custom.js';

const FRI = '20260313';
const SAT = '20260314';
const JW_SP = 'JUNIORWOMEN-QUAL';
const JW_FS = 'JUNIORWOMEN-FNL';
const NM_FS = 'NOVICEMEN-FNL';
const SW_SP = 'SENIORWOMEN-QUAL';

/** The index as get_papers_index returns it: two days, a schedule on the first */
function rawIndex() {
  return {
    generation: 'gen-1',
    generatedUtc: '2026-03-12T12:02:00Z',
    segments: {
      [JW_SP]: { date: FRI, start: '10:30', end: '12:00', category: 'Junior Women', segment: 'Short Program' },
      [JW_FS]: { date: FRI, start: '15:10', end: '17:00', category: 'Junior Women', segment: 'Free Skating' },
      [NM_FS]: { date: FRI, start: '12:00', end: '13:00', category: 'Novice Men', segment: 'Free Skating' },
      [SW_SP]: { date: SAT, start: '09:00', end: '11:00', category: 'Senior Women', segment: 'Short Program' },
    },
    days: [
      {
        date: FRI,
        pages: 95,
        schedule: { pages: 2, copies: 3 },
        people: [
          {
            slug: 'aino_lehtovaara', name: 'Aino LEHTOVAARA', pages: 40, cover: 1,
            parts: [
              { prefix: JW_SP, role: 'judge', label: 'Judge 3', pages: 14, intro: 1, flags: [] },
              { prefix: NM_FS, role: 'judge', label: 'Judge 1', pages: 12, intro: 1, flags: [] },
              { prefix: JW_FS, role: 'judge', label: 'Judge 3', pages: 13, intro: 1, flags: [] },
            ],
          },
          {
            slug: 'marja_tuomivaara', name: 'Marja TUOMIVAARA', pages: 38, cover: 1,
            parts: [
              { prefix: JW_SP, role: 'referee', label: 'Referee', pages: 20, intro: 1, flags: ['calculationSetup'] },
              // Two roles in one segment: a row each
              { prefix: NM_FS, role: 'referee', label: 'Referee', pages: 9, intro: 1, flags: [] },
              { prefix: NM_FS, role: 'judge', label: 'Judge 2', pages: 8, intro: 0, flags: [] },
            ],
          },
          {
            slug: 'vaino_akerlund', name: 'Väinö ÅKERLUND', pages: 11, cover: 1,
            parts: [
              { prefix: JW_SP, role: 'data_operator', label: 'Data Operator', pages: 10, intro: 1, flags: [] },
              // Nothing to print for this role in this segment
              { prefix: JW_FS, role: 'data_operator', label: 'Data Operator', pages: 0, intro: 0, flags: ['patternDanceSkipped'] },
            ],
          },
        ],
      },
      {
        date: SAT,
        pages: 29,
        schedule: null,
        people: [
          {
            slug: 'aino_lehtovaara', name: 'Aino LEHTOVAARA', pages: 14, cover: 1,
            parts: [{ prefix: SW_SP, role: 'judge', label: 'Judge 5', pages: 13, intro: 1, flags: [] }],
          },
          {
            slug: 'milla_karvonen', name: 'Milla KARVONEN', pages: 15, cover: 1,
            parts: [{ prefix: SW_SP, role: 'judge_trainee', label: 'Judge Trainee', pages: 14, intro: 1, flags: [] }],
          },
        ],
      },
    ],
  };
}

function setup(): { index: PapersIndex; model: CustomModel; sel: Set<string> } {
  const index = parseIndex(rawIndex())!;
  return { index, model: buildModel(index), sel: new Set<string>() };
}

const AINO_FRI_SP = unitKey.part(FRI, 'aino_lehtovaara', JW_SP, 'judge');
const AINO_FRI_FS = unitKey.part(FRI, 'aino_lehtovaara', JW_FS, 'judge');
const AINO_FRI_NM = unitKey.part(FRI, 'aino_lehtovaara', NM_FS, 'judge');
const AINO_FRI_COVER = unitKey.cover(FRI, 'aino_lehtovaara');

describe('the decided defaults', () => {
  it('opens with nothing ticked, segments by day, and always a category row', () => {
    expect(INITIAL_SELECTION).toBe('none');
    expect(DEFAULT_SEGMENT_GROUPING).toBe('day');
    expect(CATEGORY_ROW_MIN).toBe(1);
  });
});

describe('parseIndex', () => {
  it('reads the index of a response', () => {
    const index = parseIndex(rawIndex())!;
    expect(index.generation).toBe('gen-1');
    expect(index.days.map(d => d.date)).toEqual([FRI, SAT]);
    expect(index.segments.get(JW_SP)).toEqual({ date: FRI, start: '10:30', category: 'Junior Women', segment: 'Short Program' });
    expect(index.days[0].schedule).toEqual({ pages: 2, copies: 3 });
    expect(index.days[1].schedule).toBeNull();
  });

  it('gives null for anything that is not an index', () => {
    expect(parseIndex(null)).toBeNull();
    expect(parseIndex({ generation: 'g' })).toBeNull();
    expect(parseIndex({ generation: '', days: [] })).toBeNull();
    expect(parseIndex({ generation: 'g', days: [{ date: '2026-03-13', people: [] }] })).toBeNull();
    expect(parseIndex({ generation: 'g', days: [{ date: FRI, people: [{ name: 'No Slug', parts: [] }] }] })).toBeNull();
  });

  it('reads missing counts, start times and labels as empty', () => {
    const index = parseIndex({
      generation: 'g',
      segments: { P: { date: FRI, start: null, category: 'Cat', segment: null } },
      days: [{ date: FRI, schedule: null, people: [{ slug: 's', name: 'S', parts: [{ prefix: 'P', role: 'judge' }] }] }],
    })!;
    expect(index.segments.get('P')).toEqual({ date: FRI, start: '', category: 'Cat', segment: '' });
    expect(index.days[0].people[0]).toMatchObject({ cover: 0, pages: 0 });
    expect(index.days[0].people[0].parts[0]).toEqual({ prefix: 'P', role: 'judge', label: '', pages: 0, flags: [] });
  });
});

describe('parseIndexAnswer', () => {
  it('reads a current answer with its last selection', () => {
    const answer = parseIndexAnswer({
      current: true, reason: null, index: rawIndex(),
      lastSelection: { savedUtc: '2026-03-12T13:00:00Z', pages: 27, selection: { [FRI]: { schedule: true, people: {} } } },
      refreshedFromPool: [],
    })!;
    expect(answer.current).toBe(true);
    expect(answer.index?.generation).toBe('gen-1');
    expect(answer.last).toEqual({ savedUtc: '2026-03-12T13:00:00Z', pages: 27, selection: { [FRI]: { schedule: true, people: {} } } });
  });

  it('reads an answer that is not current', () => {
    const answer = parseIndexAnswer({ current: false, reason: 'files', index: null, lastSelection: null, refreshedFromPool: ['A.pdf'] })!;
    expect(answer).toEqual({ current: false, reason: 'files', index: null, last: null, refreshedFromPool: ['A.pdf'] });
  });

  it('gives null for a current answer without a usable index, and for other bodies', () => {
    expect(parseIndexAnswer({ current: true, index: null })).toBeNull();
    expect(parseIndexAnswer({ index: rawIndex() })).toBeNull();
    expect(parseIndexAnswer('ok')).toBeNull();
  });
});

describe('buildModel', () => {
  it('keys the units by day, person, segment and role', () => {
    const { model } = setup();
    expect([...model.units.keys()].sort()).toEqual([
      `${FRI}|schedule`,
      `${FRI}|aino_lehtovaara|cover`,
      `${FRI}|aino_lehtovaara|${JW_SP}|judge`,
      `${FRI}|aino_lehtovaara|${NM_FS}|judge`,
      `${FRI}|aino_lehtovaara|${JW_FS}|judge`,
      `${FRI}|marja_tuomivaara|cover`,
      `${FRI}|marja_tuomivaara|${JW_SP}|referee`,
      `${FRI}|marja_tuomivaara|${NM_FS}|referee`,
      `${FRI}|marja_tuomivaara|${NM_FS}|judge`,
      `${FRI}|vaino_akerlund|cover`,
      `${FRI}|vaino_akerlund|${JW_SP}|data_operator`,
      `${SAT}|aino_lehtovaara|cover`,
      `${SAT}|aino_lehtovaara|${SW_SP}|judge`,
      `${SAT}|milla_karvonen|cover`,
      `${SAT}|milla_karvonen|${SW_SP}|judge_trainee`,
    ].sort());
    expect(model.units.get(`${FRI}|schedule`)).toMatchObject({ kind: 'schedule', pages: 6 });
  });

  it('counts the pages of every group', () => {
    const { model } = setup();
    const pages = (id: string) => model.groups.get(id)?.pages;
    expect(pages(groupId.all)).toBe(95 + 29);
    expect(pages(groupId.day(FRI))).toBe(95);
    expect(pages(groupId.day(SAT))).toBe(29);
    expect(pages(groupId.schedule(FRI))).toBe(6);
    expect(pages(groupId.schedules)).toBe(6);
    expect(pages(groupId.covers)).toBe(5);
    expect(pages(groupId.person(FRI, 'aino_lehtovaara'))).toBe(40);
    expect(pages(groupId.cover(FRI, 'aino_lehtovaara'))).toBe(1);
    expect(pages(groupId.personCategory(FRI, 'aino_lehtovaara', 'Junior Women'))).toBe(27);
    expect(pages(groupId.part(FRI, 'aino_lehtovaara', JW_SP, 'judge'))).toBe(14);
    expect(pages(groupId.segment(JW_SP))).toBe(14 + 20 + 10);
    expect(pages(groupId.segment(NM_FS))).toBe(12 + 9 + 8);
    expect(pages(groupId.dayCategory(FRI, 'Junior Women'))).toBe(14 + 13 + 20 + 10);
    expect(pages(groupId.category('Junior Women'))).toBe(14 + 13 + 20 + 10);
    expect(pages(groupId.role('judge'))).toBe(14 + 12 + 13 + 8 + 13);
    expect(pages(groupId.role('referee'))).toBe(29);
    expect(pages(groupId.role('judge_trainee'))).toBe(14);
  });

  it('keeps a part without pages out of the units, with an empty group for its row', () => {
    const { model } = setup();
    expect(model.units.has(unitKey.part(FRI, 'vaino_akerlund', JW_FS, 'data_operator'))).toBe(false);
    expect(model.groups.get(groupId.part(FRI, 'vaino_akerlund', JW_FS, 'data_operator'))).toEqual({ keys: [], pages: 0 });
    expect(model.groups.get(groupId.person(FRI, 'vaino_akerlund'))?.keys).toHaveLength(2);
  });

  it('gives a day without a schedule no schedule group', () => {
    const { model } = setup();
    expect(model.groups.has(groupId.schedule(SAT))).toBe(false);
  });
});

describe('stateOf', () => {
  it('is none, some or all, with the selected and total pages', () => {
    const { model, sel } = setup();
    const person = groupId.person(FRI, 'aino_lehtovaara');
    expect(stateOf(model, sel, person)).toMatchObject({ none: true, some: false, all: false, pages: 0, total: 40, empty: false });

    setKeys(model, sel, [AINO_FRI_SP, AINO_FRI_COVER], true);
    expect(stateOf(model, sel, person)).toMatchObject({ none: false, some: true, all: false, selected: 2, count: 4, pages: 15, total: 40 });
    expect(pagesText(stateOf(model, sel, person))).toBe('15 / 40 p');

    setGroup(model, sel, person, true);
    expect(stateOf(model, sel, person)).toMatchObject({ none: false, some: false, all: true, pages: 40, total: 40 });
    expect(pagesText(stateOf(model, sel, person))).toBe('40 p');
  });

  it('marks a group without pages as empty: never all, never some', () => {
    const { model, sel } = setup();
    selectAll(model, sel);
    const empty = stateOf(model, sel, groupId.part(FRI, 'vaino_akerlund', JW_FS, 'data_operator'));
    expect(empty).toMatchObject({ empty: true, all: false, some: false, none: true, total: 0 });
    expect(stateOf(model, sel, 'no-such-group')).toMatchObject({ empty: true, none: true });
  });

  it('shows the same selection through every group that covers it', () => {
    const { model, sel } = setup();
    setGroup(model, sel, groupId.segment(JW_SP), true);
    expect(stateOf(model, sel, groupId.segment(JW_SP)).all).toBe(true);
    expect(stateOf(model, sel, groupId.part(FRI, 'aino_lehtovaara', JW_SP, 'judge')).all).toBe(true);
    expect(stateOf(model, sel, groupId.personCategory(FRI, 'aino_lehtovaara', 'Junior Women'))).toMatchObject({ some: true, pages: 14, total: 27 });
    expect(stateOf(model, sel, groupId.dayCategory(FRI, 'Junior Women')).some).toBe(true);
    expect(stateOf(model, sel, groupId.role('data_operator')).all).toBe(true);
    expect(stateOf(model, sel, groupId.role('judge')).some).toBe(true);
    expect(stateOf(model, sel, groupId.day(SAT)).none).toBe(true);
    // A segment tick never touches cover pages
    expect(stateOf(model, sel, groupId.covers).none).toBe(true);
  });
});

describe('setting and clearing', () => {
  it('ignores keys that are no unit, and units without pages', () => {
    const { model, sel } = setup();
    setKeys(model, sel, ['nothing|here', unitKey.part(FRI, 'vaino_akerlund', JW_FS, 'data_operator'), AINO_FRI_SP], true);
    expect([...sel]).toEqual([AINO_FRI_SP]);
    setKeys(model, sel, [AINO_FRI_SP, 'nothing|here'], false);
    expect(sel.size).toBe(0);
  });

  it('selects all, none and the inverse', () => {
    const { model, sel } = setup();
    selectAll(model, sel);
    expect(sel.size).toBe(model.units.size);
    expect(stateOf(model, sel, groupId.all)).toMatchObject({ all: true, pages: 124 });

    setGroup(model, sel, groupId.day(SAT), false);
    invertSelection(model, sel);
    expect(stateOf(model, sel, groupId.day(SAT)).all).toBe(true);
    expect(stateOf(model, sel, groupId.day(FRI)).none).toBe(true);

    selectNone(sel);
    expect(stateOf(model, sel, groupId.all).none).toBe(true);
  });

  it('opens with nothing ticked, or with everything when the switch says so', () => {
    const { model } = setup();
    expect(initialSelection(model).size).toBe(0);
    expect(initialSelection(model, 'all').size).toBe(model.units.size);
  });

  it('carries a selection over to another index by key', () => {
    const { model } = setup();
    const raw = rawIndex();
    raw.generation = 'gen-2';
    raw.days[0].people.shift();   // Aino is no longer on Friday's panel
    const next = buildModel(parseIndex(raw)!);
    const carried = carryOver(next, [AINO_FRI_SP, AINO_FRI_COVER, unitKey.schedule(FRI), unitKey.cover(SAT, 'milla_karvonen')]);
    expect([...carried].sort()).toEqual([unitKey.schedule(FRI), unitKey.cover(SAT, 'milla_karvonen')].sort());
    expect(model.units.has(AINO_FRI_SP)).toBe(true);
  });
});

describe('the last selection', () => {
  const last = {
    [FRI]: {
      schedule: true,
      people: {
        aino_lehtovaara: { cover: true, parts: [[JW_FS, 'judge'], ['GONE-FNL', 'judge']] },
        somebody_else: { cover: true, parts: [[JW_FS, 'judge']] },
      },
    },
    '20260320': { schedule: true, people: {} },
  };

  it('gives the keys that still exist', () => {
    const { model } = setup();
    expect(selectionKeys(model, last).sort()).toEqual([unitKey.schedule(FRI), AINO_FRI_COVER, AINO_FRI_FS].sort());
    expect(selectionKeys(model, null)).toEqual([]);
    expect(selectionKeys(model, { [FRI]: { schedule: 'yes', people: { aino_lehtovaara: { cover: 1, parts: 'all' } } } })).toEqual([]);
  });

  it('"Last selection" replaces the selection with it', () => {
    const { model, sel } = setup();
    setGroup(model, sel, groupId.day(SAT), true);
    applyLast(model, sel, last);
    expect([...sel].sort()).toEqual([unitKey.schedule(FRI), AINO_FRI_COVER, AINO_FRI_FS].sort());
  });

  it('"Not in last selection" is everything else', () => {
    const { model, sel } = setup();
    applyNotInLast(model, sel, last);
    expect(sel.size).toBe(model.units.size - 3);
    expect(sel.has(AINO_FRI_FS)).toBe(false);
    expect(sel.has(AINO_FRI_SP)).toBe(true);
    expect(stateOf(model, sel, groupId.day(SAT)).all).toBe(true);
  });
});

describe('totals', () => {
  it('counts pages, packets (person-days) and days', () => {
    const { model, sel } = setup();
    expect(totals(model, sel)).toEqual({ pages: 0, total: 124, packets: 0, days: 0 });

    setKeys(model, sel, [AINO_FRI_SP, AINO_FRI_NM, unitKey.cover(SAT, 'aino_lehtovaara')], true);
    expect(totals(model, sel)).toEqual({ pages: 27, total: 124, packets: 2, days: 2 });

    // A schedule is pages and a day, but nobody's packet
    selectNone(sel);
    setGroup(model, sel, groupId.schedules, true);
    expect(totals(model, sel)).toEqual({ pages: 6, total: 124, packets: 0, days: 1 });
  });
});

describe('lone covers', () => {
  it('finds the covers of people with nothing else selected, and drops them', () => {
    const { model, sel } = setup();
    setGroup(model, sel, groupId.covers, true);
    setGroup(model, sel, groupId.segment(JW_SP), true);
    // Friday's three people all have the segment; Saturday's two have only their cover
    expect(loneCovers(model, sel).sort()).toEqual([
      unitKey.cover(SAT, 'aino_lehtovaara'), unitKey.cover(SAT, 'milla_karvonen'),
    ].sort());

    dropLoneCovers(model, sel);
    expect(loneCovers(model, sel)).toEqual([]);
    expect(sel.has(AINO_FRI_COVER)).toBe(true);
    expect(totals(model, sel)).toMatchObject({ packets: 3, days: 1 });
  });

  it('has none when nothing or everything is selected', () => {
    const { model, sel } = setup();
    expect(loneCovers(model, sel)).toEqual([]);
    selectAll(model, sel);
    expect(loneCovers(model, sel)).toEqual([]);
  });
});

describe('filterPeople', () => {
  it('ignores case and diacritics', () => {
    const { index } = setup();
    expect(filterPeople(index, '')).toBeNull();
    expect(filterPeople(index, '   ')).toBeNull();
    expect([...filterPeople(index, 'akerl')!]).toEqual([`${FRI}|vaino_akerlund`]);
    expect([...filterPeople(index, 'VÄINÖ')!]).toEqual([`${FRI}|vaino_akerlund`]);
    expect([...filterPeople(index, 'vaino  aker')!]).toEqual([`${FRI}|vaino_akerlund`]);
    expect([...filterPeople(index, 'lehto')!].sort()).toEqual([`${FRI}|aino_lehtovaara`, `${SAT}|aino_lehtovaara`]);
    expect(filterPeople(index, 'nobody')!.size).toBe(0);
  });

  it('normalizes a name', () => {
    expect(normalizeName('  Väinö   ÅKERLUND ')).toBe('vaino akerlund');
  });
});

describe('toRequest', () => {
  it('gives the selection in the backend shape, without people and days that have nothing ticked', () => {
    const { model, sel } = setup();
    setKeys(model, sel, [
      unitKey.schedule(FRI), AINO_FRI_COVER, AINO_FRI_FS, AINO_FRI_SP,
      unitKey.part(FRI, 'marja_tuomivaara', NM_FS, 'judge'),
    ], true);
    expect(toRequest(model, sel)).toEqual({
      [FRI]: {
        schedule: true,
        people: {
          // Parts in packet order
          aino_lehtovaara: { cover: true, parts: [[JW_SP, 'judge'], [JW_FS, 'judge']] },
          marja_tuomivaara: { cover: false, parts: [[NM_FS, 'judge']] },
        },
      },
    });
  });

  it('keeps a day that has only its schedule', () => {
    const { model, sel } = setup();
    setGroup(model, sel, groupId.schedules, true);
    expect(toRequest(model, sel)).toEqual({ [FRI]: { schedule: true, people: {} } });
  });

  it('never sends a part without pages or a key the index does not hold', () => {
    const { model } = setup();
    const sel = new Set([
      unitKey.part(FRI, 'vaino_akerlund', JW_FS, 'data_operator'),
      unitKey.schedule(SAT),
      'stale|key',
      unitKey.part(SAT, 'milla_karvonen', SW_SP, 'judge_trainee'),
    ]);
    expect(toRequest(model, sel)).toEqual({
      [SAT]: { schedule: false, people: { milla_karvonen: { cover: false, parts: [[SW_SP, 'judge_trainee']] } } },
    });
  });

  it('is empty when nothing is ticked', () => {
    const { model, sel } = setup();
    expect(toRequest(model, sel)).toEqual({});
  });

  it('round-trips through selectionKeys', () => {
    const { model, sel } = setup();
    setGroup(model, sel, groupId.role('judge'), true);
    setGroup(model, sel, groupId.covers, true);
    const again = new Set(selectionKeys(model, toRequest(model, sel)));
    expect([...again].sort()).toEqual([...sel].sort());
  });
});

describe('personRows', () => {
  it('always puts a category row above its segment rows', () => {
    const { index } = setup();
    const aino = index.days[0].people[0];
    const rows = personRows(index, FRI, aino);
    expect(rows.map(r => r.kind)).toEqual(['category', 'category']);
    expect(rows.map(r => r.kind === 'category' && r.name)).toEqual(['Junior Women', 'Novice Men']);
    const junior = rows[0];
    if (junior.kind !== 'category') throw new Error('expected a category row');
    expect(junior.group).toBe(groupId.personCategory(FRI, 'aino_lehtovaara', 'Junior Women'));
    expect(junior.rows.map(r => [r.start, r.segment, r.part.label])).toEqual([
      ['10:30', 'Short Program', 'Judge 3'], ['15:10', 'Free Skating', 'Judge 3'],
    ]);
    // Also for the only segment of a category that day
    const novice = rows[1];
    if (novice.kind !== 'category') throw new Error('expected a category row');
    expect(novice.rows).toHaveLength(1);
    expect(novice.rows[0].group).toBe(groupId.part(FRI, 'aino_lehtovaara', NM_FS, 'judge'));
  });

  it('gives a person with two roles in a segment a row for each', () => {
    const { index } = setup();
    const rows = personRows(index, FRI, index.days[0].people[1]);
    const novice = rows.find(r => r.kind === 'category' && r.name === 'Novice Men');
    if (novice?.kind !== 'category') throw new Error('expected a category row');
    expect(novice.rows.map(r => r.part.label)).toEqual(['Referee', 'Judge 2']);
  });

  it('can be flipped back: a category row only where it groups two or more rows', () => {
    const { index } = setup();
    const rows = personRows(index, FRI, index.days[0].people[0], 2);
    expect(rows.map(r => r.kind)).toEqual(['category', 'part']);
    const single = rows[1];
    if (single.kind !== 'part') throw new Error('expected a part row');
    expect([single.row.category, single.row.segment]).toEqual(['Novice Men', 'Free Skating']);
  });
});

describe('Quick select lists', () => {
  it('lists the segments by day in running order, always under a category row', () => {
    const { model } = setup();
    const days = quickByDay(model);
    expect(days.map(d => d.date)).toEqual([FRI, SAT]);
    expect(days[0].rows.map(r => r.kind)).toEqual(['category', 'category']);
    const [junior, novice] = days[0].rows;
    if (junior.kind !== 'category' || novice.kind !== 'category') throw new Error('expected category rows');
    expect(junior.group).toBe(groupId.dayCategory(FRI, 'Junior Women'));
    expect(junior.segments.map(s => [s.start, s.segment, s.people])).toEqual([
      ['10:30', 'Short Program', 3], ['15:10', 'Free Skating', 1],
    ]);
    expect(novice.segments.map(s => [s.group, s.people])).toEqual([[groupId.segment(NM_FS), 2]]);
    const senior = days[1].rows[0];
    if (senior.kind !== 'category') throw new Error('expected a category row');
    expect(senior.segments.map(s => s.prefix)).toEqual([SW_SP]);
  });

  it('can be flipped back in Quick select too', () => {
    const { model } = setup();
    expect(quickByDay(model, 2)[0].rows.map(r => r.kind)).toEqual(['category', 'segment']);
  });

  it('lists the segments by category across the days', () => {
    const { model } = setup();
    const categories = quickByCategory(model);
    expect(categories.map(c => c.name)).toEqual(['Junior Women', 'Novice Men', 'Senior Women']);
    expect(categories[0].group).toBe(groupId.category('Junior Women'));
    expect(categories[0].segments.map(s => s.prefix)).toEqual([JW_SP, JW_FS]);
    expect(categories[2].segments.map(s => s.date)).toEqual([SAT]);
  });

  it('lists the roles the papers hold, in panel order', () => {
    const { model } = setup();
    expect(roleChoices(model).map(r => r.label)).toEqual(['Judges', 'Referees', 'Data Operators', 'Judge Trainees']);
    expect(roleChoices(model)[0].group).toBe(groupId.role('judge'));
  });

  it('names a role it does not know from its key', () => {
    const raw = rawIndex();
    raw.days[1].people[0].parts[0].role = 'video_referee';
    const model = buildModel(parseIndex(raw)!);
    expect(roleChoices(model).map(r => r.label)).toContain('Video referee');
  });
});

describe('wording', () => {
  it('describes a person and a part', () => {
    const { index } = setup();
    expect(personRoles(index.days[0].people[1])).toBe('Referee · Judge');
    expect(personRoles(index.days[1].people[1])).toBe('Trainee');
    expect(partNote(index.days[0].people[1].parts[0])).toBe('with the calculation setup');
    expect(partNote(index.days[0].people[2].parts[1])).toBe('no papers in Pattern Dance');
    expect(partNote(index.days[0].people[0].parts[0])).toBe('');
  });

  it('formats counts, days and times', () => {
    expect(formatCount(512)).toBe('512');
    expect(formatCount(2034)).toBe('2 034');
    expect(formatCount(1234567)).toBe('1 234 567');
    expect(plural(1, 'packet', 'packets')).toBe('1 packet');
    expect(plural(38, 'packet', 'packets')).toBe('38 packets');
    expect(dayLabel(FRI)).toBe('Fri 13 Mar');
    expect(dayLabel('someday')).toBe('someday');
    // Shown in the user's own time zone
    expect(timeLabel(new Date(2026, 10, 26, 14, 2).toISOString())).toBe('26 Nov 14:02');
    expect(timeLabel('')).toBe('');
    expect(timeLabel('not a time')).toBe('');
  });
});
