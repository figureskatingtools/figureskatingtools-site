/**
 * Unit tests for the Judge Paper Creator's missing-papers rules
 * (`site/src/judgepapers/validate.ts`): which files a segment is expected to
 * have once it has any, which scheduled segments are merely not uploaded yet
 * and which are missing, and what the file list and the Generate prompt are
 * told about it.
 */

import { describe, expect, it } from 'vitest';

import {
  CATEGORY_GENERAL_FILE,
  SPECIALIST_SHEET_LABEL,
  isGenerable,
  missingReport,
  prefixChecks,
  scheduleWhen,
  validateCategory,
  type FileData,
  type ScheduleRow,
} from '../../src/judgepapers/validate.js';

const ISU_SET = [
  'StartListwithTimes.pdf',
  'ISUPanelofJudgesandTechnicalPanel.pdf',
  'JudgesSheetAll.pdf',
  'RefereeSheet.pdf',
  'PlannedProgramContent.pdf',
  'TechnicalControllerSheet.pdf',
  'TechnicalSpecialistSheet1.pdf',
];
const MUPI_SET = ISU_SET.slice(0, 4);

/** The files of one segment, as get_competition_details lists them */
function files(segment: string, suffixes: string[], method = 'ISU'): FileData[] {
  return suffixes.map(suffix => ({
    filename: `X_${suffix}`,
    suffix,
    type: 'Figure skating',
    category: 'JUNIORI Naiset',
    judgingMethod: method,
    segment,
    raw_segment: segment,
    prefix: `PREFIX-${segment}`,
  }));
}

const SETUP = files('Category General', [CATEGORY_GENERAL_FILE]);

function scheduleRow(over: Partial<ScheduleRow>): ScheduleRow {
  return {
    date: '2026-09-13',
    startTime: '12:10',
    entries: 26,
    name: 'JUNIORI Naiset Free Skating',
    category: 'JUNIORI Naiset',
    segment: 'Free Skating',
    status: 'missing',
    prefix: null,
    categoryKey: null,
    ...over,
  };
}

describe('validateCategory', () => {
  it('accepts a complete ISU category', () => {
    const check = validateCategory({
      'Short Program': files('Short Program', ISU_SET),
      'Category General': SETUP,
    });
    expect(check).toEqual({
      isValid: true, missingBySegment: {}, missingCategoryFiles: [], noSegmentPapers: false, missingCount: 0,
    });
  });

  it('lists the missing files of each segment', () => {
    const check = validateCategory({
      'Short Program': files('Short Program', ISU_SET.filter(f => f !== 'RefereeSheet.pdf')),
      'Free Skating': files('Free Skating', ['StartListwithTimes.pdf']),
      'Category General': SETUP,
    });
    expect(check.isValid).toBe(false);
    expect(check.missingBySegment).toEqual({
      'Short Program': ['RefereeSheet.pdf'],
      'Free Skating': [
        'ISUPanelofJudgesandTechnicalPanel.pdf', 'JudgesSheetAll.pdf', 'RefereeSheet.pdf',
        'PlannedProgramContent.pdf', 'TechnicalControllerSheet.pdf', SPECIALIST_SHEET_LABEL,
      ],
    });
    expect(check.missingCount).toBe(7);
  });

  it('needs only the common files for MUPI', () => {
    const check = validateCategory({
      'Free Skating': files('Free Skating', MUPI_SET, 'MUPI'),
      'Category General': SETUP,
    });
    expect(check.isValid).toBe(true);
  });

  it('takes any one Technical Specialist sheet', () => {
    const second = ISU_SET.map(f => (f === 'TechnicalSpecialistSheet1.pdf' ? 'TechnicalSpecialistSheet2.pdf' : f));
    expect(validateCategory({ SP: files('SP', second), 'Category General': SETUP }).isValid).toBe(true);
  });

  it('expects the calculation setup once per category', () => {
    const check = validateCategory({ 'Short Program': files('Short Program', ISU_SET) });
    expect(check.missingCategoryFiles).toEqual([CATEGORY_GENERAL_FILE]);
    expect(check.missingBySegment).toEqual({});
    expect(check.missingCount).toBe(1);
    expect(check.isValid).toBe(false);
  });

  it('expects nothing of a category with only its calculation setup, and says so', () => {
    const check = validateCategory({ 'Category General': SETUP });
    expect(check.noSegmentPapers).toBe(true);
    expect(check.isValid).toBe(true);
    expect(check.missingCount).toBe(0);
  });

  it('checks only the segments that have a file: one segment is a whole category', () => {
    // No Short Program anywhere, and nothing says there should be one
    const check = validateCategory({
      'Free Skating': files('Free Skating', ISU_SET),
      'Category General': SETUP,
    });
    expect(check).toMatchObject({ isValid: true, missingBySegment: {}, missingCount: 0 });
  });

  it('has nothing to say about files whose segment is unknown', () => {
    const check = validateCategory({ Unknown: files('Unknown', ['Something.pdf']) });
    expect(check.isValid).toBe(true);
    expect(check.noSegmentPapers).toBe(false);
  });
});

describe('isGenerable', () => {
  it('needs the panel and the time schedule', () => {
    expect(isGenerable(files('SP', ['StartListwithTimes.pdf', 'ISUPanelofJudgesandTechnicalPanel.pdf']))).toBe(true);
    expect(isGenerable(files('SP', ISU_SET.filter(f => f !== 'StartListwithTimes.pdf')))).toBe(false);
    expect(isGenerable(files('SP', ISU_SET.filter(f => f !== 'ISUPanelofJudgesandTechnicalPanel.pdf')))).toBe(false);
    expect(isGenerable([])).toBe(false);
  });

  it('needs both for the same FSM prefix', () => {
    // Two segments under one printed name: a panel of one, a time schedule of the other
    const mixed = [
      { ...files('SP', ['StartListwithTimes.pdf'])[0], prefix: 'PREFIX-A' },
      { ...files('SP', ['ISUPanelofJudgesandTechnicalPanel.pdf'])[0], prefix: 'PREFIX-B' },
    ];
    expect(isGenerable(mixed)).toBe(false);
    expect(isGenerable([...mixed, { ...files('SP', ['StartListwithTimes.pdf'])[0], prefix: 'PREFIX-B' }])).toBe(true);
  });

  it('reads the prefix from the file name when the response has none', () => {
    const bare = (filename: string): FileData => {
      const file = files('SP', [filename.slice(filename.lastIndexOf('_') + 1)])[0];
      delete file.prefix;
      return { ...file, filename };
    };
    expect(isGenerable([bare('A_StartListwithTimes.pdf'), bare('A_ISUPanelofJudgesandTechnicalPanel.pdf')])).toBe(true);
    expect(isGenerable([bare('A_StartListwithTimes.pdf'), bare('B_ISUPanelofJudgesandTechnicalPanel.pdf')])).toBe(false);
  });
});

describe('two FSM segments printed under one name', () => {
  const withPrefix = (prefix: string, suffixes: string[]): FileData[] =>
    files('Free Skating', suffixes).map(file => ({ ...file, prefix }));

  it('does not count a mixed pair as something to generate', () => {
    const report = missingReport({
      structure: { 'JUNIORI Naiset': { 'Free Skating': [
        ...withPrefix('PREFIX-A', ['StartListwithTimes.pdf']),
        ...withPrefix('PREFIX-B', ['ISUPanelofJudgesandTechnicalPanel.pdf']),
      ] } },
    });
    expect(report.generableSegments).toBe(0);
  });

  it('checks each on its own: a complete one does not cover for the other', () => {
    const block = [
      ...withPrefix('PREFIX-A', ISU_SET),
      ...withPrefix('PREFIX-B', ['StartListwithTimes.pdf', 'ISUPanelofJudgesandTechnicalPanel.pdf']),
    ];
    expect(prefixChecks(block)).toEqual([
      { prefix: 'PREFIX-A', missing: [], generable: true },
      { prefix: 'PREFIX-B', generable: true, missing: [
        'JudgesSheetAll.pdf', 'RefereeSheet.pdf', 'PlannedProgramContent.pdf',
        'TechnicalControllerSheet.pdf', SPECIALIST_SHEET_LABEL,
      ] },
    ]);

    const structure = { 'JUNIORI Naiset': { 'Free Skating': block, 'Category General': SETUP } };
    const check = validateCategory(structure['JUNIORI Naiset']);
    expect(check.isValid).toBe(false);
    // Each missing file says which of the two it belongs to
    expect(check.missingBySegment['Free Skating']).toEqual([
      'JudgesSheetAll.pdf (PREFIX-B)', 'RefereeSheet.pdf (PREFIX-B)', 'PlannedProgramContent.pdf (PREFIX-B)',
      'TechnicalControllerSheet.pdf (PREFIX-B)', `${SPECIALIST_SHEET_LABEL} (PREFIX-B)`,
    ]);

    const report = missingReport({ structure });
    expect(report.count).toBe(5);
    expect(report.generableSegments).toBe(2);
    expect(report.lines).toEqual([
      'JUNIORI Naiset, Free Skating (PREFIX-B): JudgesSheetAll.pdf, RefereeSheet.pdf, PlannedProgramContent.pdf, '
        + `TechnicalControllerSheet.pdf, ${SPECIALIST_SHEET_LABEL}`,
    ]);
  });

  it('says which of the two is left out', () => {
    const report = missingReport({
      structure: { 'JUNIORI Naiset': {
        'Free Skating': [
          ...withPrefix('PREFIX-A', ISU_SET),
          ...withPrefix('PREFIX-B', ISU_SET.filter(f => f !== 'StartListwithTimes.pdf')),
        ],
        'Category General': SETUP,
      } },
    });
    expect(report.lines).toEqual([
      'JUNIORI Naiset, Free Skating (PREFIX-B): StartListwithTimes.pdf — this segment will be left out of the papers',
    ]);
    expect(report.generableSegments).toBe(1);
  });
});

describe('scheduleWhen', () => {
  it('gives the weekday, date, start time and entries', () => {
    expect(scheduleWhen(scheduleRow({}))).toBe('Sun 13.9. 12:10 · 26 entries');
    expect(scheduleWhen(scheduleRow({ date: '2026-09-11', startTime: '16:00', entries: 1 }), ', '))
      .toBe('Fri 11.9. 16:00, 1 entry');
  });

  it('leaves out what is not known', () => {
    expect(scheduleWhen(scheduleRow({ date: null, startTime: null, entries: 0 }))).toBe('');
    expect(scheduleWhen(scheduleRow({ date: 'soon', entries: 4 }))).toBe('12:10 · 4 entries');
  });
});

describe('missingReport', () => {
  const complete = {
    'JUNIORI Naiset': {
      'Short Program': files('Short Program', ISU_SET),
      'Category General': SETUP,
    },
  };

  it('finds nothing in a complete competition', () => {
    const report = missingReport({ structure: complete, scheduleCheck: null });
    expect(report.count).toBe(0);
    expect(report.lines).toEqual([]);
    expect(report.placeholders).toEqual([]);
    expect(report.generableSegments).toBe(1);
    expect(report.counts).toEqual({ 'JUNIORI Naiset': 0 });
    expect(report.pending).toEqual({ 'JUNIORI Naiset': 0 });
  });

  it('works without a scheduleCheck key (an older backend)', () => {
    expect(missingReport({ structure: complete }).count).toBe(0);
  });

  it('survives a response that is not there', () => {
    expect(missingReport(null)).toMatchObject({ count: 0, generableSegments: 0, lines: [] });
    expect(missingReport({ structure: null, scheduleCheck: { rows: 'x' } }).count).toBe(0);
  });

  it('lists missing files, and says when a segment is left out', () => {
    const report = missingReport({
      structure: {
        'JUNIORI Naiset': {
          'Short Program': files('Short Program', ISU_SET.filter(f => f !== 'RefereeSheet.pdf')),
          'Free Skating': files('Free Skating', ISU_SET.filter(f => f !== 'ISUPanelofJudgesandTechnicalPanel.pdf')),
        },
      },
    });
    expect(report.lines).toEqual([
      'JUNIORI Naiset, Short Program: RefereeSheet.pdf',
      'JUNIORI Naiset, Free Skating: ISUPanelofJudgesandTechnicalPanel.pdf — this segment will be left out of the papers',
      `JUNIORI Naiset: ${CATEGORY_GENERAL_FILE}`,
    ]);
    expect(report.count).toBe(3);
    expect(report.counts).toEqual({ 'JUNIORI Naiset': 3 });
    expect(report.generableSegments).toBe(1);
  });

  /** A segment of another category whose papers are uploaded: its day is being prepared */
  const found = (over: Partial<ScheduleRow> = {}): ScheduleRow => scheduleRow({
    name: 'JUNIORI Naiset Short Program', segment: 'Short Program', status: 'found',
    prefix: 'PREFIX-Short Program', categoryKey: 'JUNIORI Naiset', date: '2026-09-12', startTime: '10:00', ...over,
  });
  const flags = (segments: Array<{ row: ScheduleRow, expected: boolean }>): Array<[string, boolean]> =>
    segments.map(s => [s.row.segment, s.expected]);

  it('notes a later segment of an uploaded category without calling it missing', () => {
    const report = missingReport({
      structure: complete,
      scheduleCheck: {
        rows: [
          found(),
          // Same day as the uploaded Short Program, and still not expected
          scheduleRow({ categoryKey: 'JUNIORI Naiset', date: '2026-09-12', startTime: '17:00' }),
          scheduleRow({ name: 'JUNIORI Miehet Free Skating', category: 'JUNIORI Miehet', status: 'notNeeded', entries: 0 }),
        ],
      },
    });
    expect(flags(report.scheduled['JUNIORI Naiset'])).toEqual([['Free Skating', false]]);
    expect(report.placeholders).toEqual([]);
    expect(report.counts).toEqual({ 'JUNIORI Naiset': 0 });
    expect(report.pending).toEqual({ 'JUNIORI Naiset': 1 });
    expect(report.categories['JUNIORI Naiset'].isValid).toBe(true);
    expect(report.count).toBe(0);
    expect(report.lines).toEqual([]);
  });

  it('marks the first segment of a forgotten category on a day that has papers (#84)', () => {
    const report = missingReport({
      structure: complete,
      scheduleCheck: {
        rows: [
          found(),
          scheduleRow({ date: '2026-09-12', startTime: '16:00', entries: 11,
                        name: 'DEBYTANTTI Tytöt Short Program', category: 'DEBYTANTTI Tytöt', segment: 'Short Program' }),
          // Its Free Skating waits for the result: quiet, even on that same day
          scheduleRow({ date: '2026-09-12', startTime: '19:00', entries: 11,
                        name: 'DEBYTANTTI Tytöt Free Skating', category: 'DEBYTANTTI Tytöt' }),
        ],
      },
    });
    expect(report.placeholders.map(p => [p.title, flags(p.segments)])).toEqual([
      ['DEBYTANTTI Tytöt', [['Short Program', true], ['Free Skating', false]]],
    ]);
    expect(report.count).toBe(1);
    expect(report.lines).toEqual([
      'DEBYTANTTI Tytöt, Short Program (Sat 12.9. 16:00, 11 entries): no papers uploaded',
    ]);
  });

  it('takes the first segment by day and start time, not by its place in the schedule list', () => {
    const report = missingReport({
      structure: complete,
      scheduleCheck: {
        rows: [
          found(),
          scheduleRow({ date: '2026-09-13', startTime: '9:00', name: 'SENIORI Naiset Free Skating', category: 'SENIORI Naiset' }),
          scheduleRow({ date: '2026-09-12', startTime: '18:30', name: 'SENIORI Naiset Rhythm', category: 'SENIORI Naiset', segment: 'Rhythm' }),
          scheduleRow({ date: '2026-09-12', startTime: '8:15', name: 'SENIORI Naiset Short Program', category: 'SENIORI Naiset', segment: 'Short Program' }),
        ],
      },
    });
    expect(flags(report.placeholders[0].segments)).toEqual([
      ['Free Skating', false], ['Rhythm', false], ['Short Program', true],
    ]);
  });

  it('leaves a category alone when it starts on a day nothing is uploaded for', () => {
    const report = missingReport({
      structure: complete,
      scheduleCheck: {
        rows: [
          found(),
          // Day 2 only: its papers are made during day 1
          scheduleRow({ name: 'SENIORI Naiset Free Skating', category: 'SENIORI Naiset', date: '2026-09-13' }),
          // A card the schedule points at that is not in the list: its own placeholder
          scheduleRow({ name: 'NOVIISI Tytöt Free Skating', category: 'NOVIISI Tytöt', categoryKey: 'Gone', date: '2026-09-13' }),
          // Text that could not be split into category and segment, and no day
          scheduleRow({ name: 'Gaala Näytös', category: '', segment: 'Gaala Näytös', date: null, startTime: null, entries: 3 }),
        ],
      },
    });
    expect(report.placeholders.map(p => [p.title, p.segments.map(s => s.expected)])).toEqual([
      ['SENIORI Naiset', [false]], ['NOVIISI Tytöt', [false]], ['Gaala Näytös', [false]],
    ]);
    expect(report.count).toBe(0);
    expect(report.lines).toEqual([]);
  });

  it('expects nothing from the schedule while no segment at all is uploaded', () => {
    const report = missingReport({
      structure: {},
      scheduleCheck: { rows: [scheduleRow({}), scheduleRow({ name: 'SENIORI Naiset Free Skating', category: 'SENIORI Naiset' })] },
    });
    expect(report.placeholders.flatMap(p => p.segments.map(s => s.expected))).toEqual([false, false]);
    expect(report.count).toBe(0);
  });

  it('lists cards and placeholder cards in one order', () => {
    const report = missingReport({
      structure: {
        'B-category': { 'Short Program': files('Short Program', ISU_SET) },
        'D-category': { 'Category General': SETUP },
      },
      scheduleCheck: { rows: [
        found({ name: 'B-category Short Program', category: 'B-category', categoryKey: 'B-category', date: '2026-09-13' }),
        scheduleRow({ name: 'E-category Free Skating', category: 'E-category' }),
        scheduleRow({ name: 'A-category Free Skating', category: 'A-category' }),
        scheduleRow({ name: 'C-category Free Skating', category: 'C-category' }),
        scheduleRow({ name: 'D-category Free Skating', category: 'D-category', categoryKey: 'D-category' }),
      ] },
    });
    expect(report.lines.map(line => line.slice(0, 10))).toEqual([
      'A-category', 'B-category', 'C-category', 'D-category', 'E-category',
    ]);
    expect(report.count).toBe(5);
  });

  it('treats a calculation-setup-only category like one with nothing uploaded', () => {
    const setupOnly = { 'A-Silmut, Tytöt': { 'Category General': SETUP } };
    const row = scheduleRow({ name: 'A-SILMUT Tytöt Free Skating', category: 'A-SILMUT Tytöt', categoryKey: 'A-Silmut, Tytöt' });

    // No schedule: nothing says its papers should be here
    const alone = missingReport({ structure: setupOnly });
    expect(alone.categories['A-Silmut, Tytöt'].noSegmentPapers).toBe(true);
    expect(alone.counts).toEqual({ 'A-Silmut, Tytöt': 0 });
    expect(alone.pending).toEqual({ 'A-Silmut, Tytöt': 0 });
    expect(alone.lines).toEqual([]);
    expect(alone.generableSegments).toBe(0);

    // Scheduled, but nothing is uploaded for that day
    const later = missingReport({ structure: setupOnly, scheduleCheck: { rows: [found(), row] } });
    expect(later.counts).toEqual({ 'A-Silmut, Tytöt': 0 });
    expect(later.pending).toEqual({ 'A-Silmut, Tytöt': 1 });
    expect(later.count).toBe(0);

    // Scheduled on a day another category has papers for: forgotten
    const forgotten = missingReport({
      structure: { ...setupOnly, ...complete },
      scheduleCheck: { rows: [found({ date: '2026-09-13' }), row] },
    });
    expect(forgotten.counts).toEqual({ 'A-Silmut, Tytöt': 1, 'JUNIORI Naiset': 0 });
    expect(forgotten.pending['A-Silmut, Tytöt']).toBe(0);
    expect(forgotten.count).toBe(1);
    expect(forgotten.lines).toEqual([
      'A-SILMUT Tytöt, Free Skating (Sun 13.9. 12:10, 26 entries): no papers uploaded',
    ]);
  });

  it('expects nothing of unrecognised files', () => {
    const report = missingReport({
      structure: { Uncategorized: { Files: files('Files', ['StartListwithTimes.pdf', 'ISUPanelofJudgesandTechnicalPanel.pdf']) } },
      scheduleCheck: { rows: [scheduleRow({ categoryKey: 'Uncategorized' })] },
    });
    expect(report.categories).toEqual({});
    expect(report.generableSegments).toBe(0);
    // The scheduled segment is still missing: a card of its own
    expect(report.placeholders.map(p => p.title)).toEqual(['JUNIORI Naiset']);
  });
});
