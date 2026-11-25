/**
 * Unit tests for the Judge Paper Creator's missing-papers rules
 * (`site/src/judgepapers/validate.ts`): which files a segment is expected to
 * have, which scheduled segments have no papers, and what the file list and
 * the Generate prompt are told about it.
 */

import { describe, expect, it } from 'vitest';

import {
  CATEGORY_GENERAL_FILE,
  SPECIALIST_SHEET_LABEL,
  isGenerable,
  missingReport,
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

  it('marks a category with only its calculation setup (#84)', () => {
    const check = validateCategory({ 'Category General': SETUP });
    expect(check.noSegmentPapers).toBe(true);
    expect(check.isValid).toBe(false);
    expect(check.missingCount).toBe(1);
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

describe('missingReport with segments of two prefixes in one block', () => {
  it('does not count a mixed pair as something to generate', () => {
    const report = missingReport({
      structure: { 'JUNIORI Naiset': { 'Free Skating': [
        { ...files('Free Skating', ['StartListwithTimes.pdf'])[0], prefix: 'PREFIX-A' },
        { ...files('Free Skating', ['ISUPanelofJudgesandTechnicalPanel.pdf'])[0], prefix: 'PREFIX-B' },
      ] } },
    });
    expect(report.generableSegments).toBe(0);
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

  it('puts a scheduled segment without papers in its category card', () => {
    const report = missingReport({
      structure: complete,
      scheduleCheck: {
        rows: [
          scheduleRow({ name: 'JUNIORI Naiset Short Program', segment: 'Short Program', status: 'found',
                        prefix: 'PREFIX-Short Program', categoryKey: 'JUNIORI Naiset' }),
          scheduleRow({ categoryKey: 'JUNIORI Naiset' }),
          scheduleRow({ name: 'JUNIORI Miehet Free Skating', category: 'JUNIORI Miehet', status: 'notNeeded', entries: 0 }),
        ],
      },
    });
    expect(report.scheduled['JUNIORI Naiset'].map(r => r.segment)).toEqual(['Free Skating']);
    expect(report.placeholders).toEqual([]);
    expect(report.counts).toEqual({ 'JUNIORI Naiset': 1 });
    expect(report.count).toBe(1);
    expect(report.lines).toEqual([
      'JUNIORI Naiset, Free Skating (Sun 13.9. 12:10, 26 entries): no papers uploaded',
    ]);
  });

  it('gives a scheduled category with nothing uploaded a card of its own', () => {
    const report = missingReport({
      structure: complete,
      scheduleCheck: {
        rows: [
          scheduleRow({ date: '2026-09-11', startTime: '16:00', entries: 11,
                        name: 'DEBYTANTTI Tytöt Free Skating', category: 'DEBYTANTTI Tytöt' }),
          scheduleRow({ date: '2026-09-12', startTime: '9:00', entries: 11,
                        name: 'DEBYTANTTI Tytöt Short Program', category: 'DEBYTANTTI Tytöt', segment: 'Short Program' }),
          // A card the schedule points at that is not in the list: its own placeholder
          scheduleRow({ name: 'SENIORI Naiset Free Skating', category: 'SENIORI Naiset', categoryKey: 'Gone' }),
          // Text that could not be split into category and segment
          scheduleRow({ name: 'Gaala Näytös', category: '', segment: 'Gaala Näytös', date: null, startTime: null, entries: 3 }),
        ],
      },
    });
    expect(report.placeholders.map(p => [p.title, p.rows.length])).toEqual([
      ['DEBYTANTTI Tytöt', 2], ['SENIORI Naiset', 1], ['Gaala Näytös', 1],
    ]);
    expect(report.count).toBe(4);
    // In the order of the file list: by card title
    expect(report.lines).toEqual([
      'DEBYTANTTI Tytöt, Free Skating (Fri 11.9. 16:00, 11 entries): no papers uploaded',
      'DEBYTANTTI Tytöt, Short Program (Sat 12.9. 9:00, 11 entries): no papers uploaded',
      'Gaala Näytös (3 entries): no papers uploaded',
      'SENIORI Naiset, Free Skating (Sun 13.9. 12:10, 26 entries): no papers uploaded',
    ]);
  });

  it('lists cards and placeholder cards in one order', () => {
    const report = missingReport({
      structure: {
        'B-category': { 'Short Program': files('Short Program', ISU_SET) },
        'D-category': { 'Category General': SETUP },
      },
      scheduleCheck: { rows: [
        scheduleRow({ name: 'E-category Free Skating', category: 'E-category' }),
        scheduleRow({ name: 'A-category Free Skating', category: 'A-category' }),
        scheduleRow({ name: 'C-category Free Skating', category: 'C-category' }),
      ] },
    });
    expect(report.lines.map(line => line.slice(0, 10))).toEqual([
      'A-category', 'B-category', 'C-category', 'D-category', 'E-category',
    ]);
    expect(report.count).toBe(5);
  });

  it('counts a calculation-setup-only category once, by its scheduled segments when it has them', () => {
    const structure = { 'A-Silmut, Tytöt': { 'Category General': SETUP } };

    const alone = missingReport({ structure });
    expect(alone.counts).toEqual({ 'A-Silmut, Tytöt': 1 });
    expect(alone.lines).toEqual(['A-Silmut, Tytöt: no segment papers uploaded']);
    expect(alone.generableSegments).toBe(0);

    const scheduled = missingReport({
      structure,
      scheduleCheck: { rows: [
        scheduleRow({ name: 'A-SILMUT Tytöt Free Skating', category: 'A-SILMUT Tytöt', categoryKey: 'A-Silmut, Tytöt' }),
      ] },
    });
    expect(scheduled.counts).toEqual({ 'A-Silmut, Tytöt': 1 });
    expect(scheduled.count).toBe(1);
    expect(scheduled.lines).toEqual([
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
