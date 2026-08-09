/**
 * Unit tests for the Protocol Generator auto-assignment planner.
 *
 * The structure fixtures are hand-built duck-typed objects — the planner never
 * sees the real Protocol Generator types, so neither do the tests.
 */

import { describe, expect, it } from 'vitest';

import { sortCategoriesForMatching, type CategoryInfo } from '../src/category-recognition.js';
import {
  SUFFIX_SLOTS,
  applyOutcomeLocally,
  normalizeMatchName,
  planAutoAssignment,
  slotOccupant,
  stripTrailingDashes,
  type CategoryLike,
  type SegmentLike,
  type StructureLike,
} from '../src/protocol-auto-assign.js';

const CATEGORIES: CategoryInfo[] = sortCategoriesForMatching([
  {
    abbreviation: 'FSKWSINGLES',
    displayName: 'Women, Singles',
    displayNameFi: 'Naiset',
    judgingMethod: 'ISU',
    competitionType: 'Figure skating',
  },
  {
    abbreviation: 'FSKWSINGLES-ASILMW',
    displayName: 'A-Silmut, Girls',
    displayNameFi: 'A-Silmut, Tytöt',
    judgingMethod: 'ISU',
    competitionType: 'Figure skating',
  },
  {
    abbreviation: 'FSKMSINGLES',
    displayName: 'Men, Singles',
    displayNameFi: 'Miehet',
    judgingMethod: 'ISU',
    competitionType: 'Figure skating',
  },
  {
    abbreviation: 'FSKXSYNCHRONMLAIKU',
    displayName: 'Adults, Mupi L1',
    displayNameFi: 'Aikuiset, Mupi L1',
    judgingMethod: 'MUPI',
    competitionType: 'Synchronized skating',
  },
  {
    abbreviation: 'FSKXDANCE',
    displayName: 'Ice Dance',
    displayNameFi: 'Jäätanssi',
    judgingMethod: 'ISU',
    competitionType: 'Figure skating',
  },
]);

function segment(id: string, name: string, order: number): SegmentLike {
  return { id, name, order, resultsPdf: null, panelPdf: null, judgesDetailsPdf: null };
}

function category(
  id: string,
  name: string,
  code: string,
  segments: SegmentLike[]
): CategoryLike {
  return { id, name, code, titlePdf: null, totalResultsPdf: null, segments };
}

/** A fresh structure per test — every planner assertion mutates nothing */
function makeStructure(): StructureLike {
  return {
    files: {},
    categories: [
      category('c1', 'A-Silmut, Tytöt', 'FSKWSINGLES-ASILMW----', [
        segment('s1', 'Short Program', 1),
        segment('s2', 'Free Skating', 2),
      ]),
      category('c2', 'Miehet', 'FSKMSINGLES-----------', [segment('s3', 'Free Skating', 1)]),
      category('c3', 'Naiset', 'FSKWSINGLES-----------', [
        segment('s4', 'Short Program', 1),
        segment('s5', 'Free Skating', 2),
      ]),
    ],
  };
}

describe('helpers', () => {
  it('strips trailing dash padding only', () => {
    expect(stripTrailingDashes('FSKWSINGLES-ASILMW----')).toBe('FSKWSINGLES-ASILMW');
    expect(stripTrailingDashes('FSKXSYNCHRONMLAIKU--01')).toBe('FSKXSYNCHRONMLAIKU--01');
    expect(stripTrailingDashes(undefined)).toBe('');
  });

  it('folds diacritics and punctuation when comparing names', () => {
    expect(normalizeMatchName('A-Silmut, Tytöt #1')).toBe('a silmut tytot 1');
    expect(normalizeMatchName('A Silmut Tytot 1')).toBe('a silmut tytot 1');
    expect(normalizeMatchName('A-Silmut, Pojat')).not.toBe(normalizeMatchName('A-Silmut, Tytöt'));
  });

  it('keeps SegmentResults and Results as distinct suffix rows', () => {
    expect(SUFFIX_SLOTS['SegmentResults.pdf']).toEqual({ kind: 'segment', role: 'results' });
    expect(SUFFIX_SLOTS['Results.pdf']!.kind).toBe('totalResults');
  });
});

/* ── the two user-confirmed fixtures ───────────────────────────────────── */

describe('confirmed FSM filenames', () => {
  it('places a segment results sheet in the segment results slot', () => {
    const outcome = planAutoAssignment(
      'FSKWSINGLES-----------QUAL000100--_SegmentResults.pdf',
      CATEGORIES,
      makeStructure()
    );
    expect(outcome).toEqual({
      action: 'assign',
      target: { kind: 'segment', categoryId: 'c3', segmentId: 's4', role: 'results' },
    });
  });

  it('places a dash-only-segment results sheet in the category total results slot', () => {
    const outcome = planAutoAssignment(
      'FSKMSINGLES-----------------------_Results.pdf',
      CATEGORIES,
      makeStructure()
    );
    expect(outcome).toEqual({
      action: 'assign',
      target: { kind: 'totalResults', categoryId: 'c2' },
    });
  });
});

/* ── suffix table ──────────────────────────────────────────────────────── */

describe('suffix → slot', () => {
  it('routes the ISU panel sheet to the segment panel slot', () => {
    expect(
      planAutoAssignment(
        'FSKWSINGLES-ASILMW----QUAL0001--_ISUPanelofJudgesandTechnicalPanel.pdf',
        CATEGORIES,
        makeStructure()
      )
    ).toEqual({
      action: 'assign',
      target: { kind: 'segment', categoryId: 'c1', segmentId: 's1', role: 'panel' },
    });
  });

  it('routes the judges details sheet to the segment judges-details slot', () => {
    expect(
      planAutoAssignment(
        'FSKWSINGLES-ASILMW----FNL0001--_JudgesDetailsperSkater.pdf',
        CATEGORIES,
        makeStructure()
      )
    ).toEqual({
      action: 'assign',
      target: { kind: 'segment', categoryId: 'c1', segmentId: 's2', role: 'judgesDetails' },
    });
  });

  it.each([
    'FSKWSINGLES-ASILMW----QUAL0001--_JudgesSheetAll.pdf',
    'FSKWSINGLES-ASILMW----QUAL0001--_StartListwithTimes.pdf',
    'FSKWSINGLES-ASILMW----QUAL0001--_RefereeSheet.pdf',
    'FSKWSINGLES-ASILMW----QUAL0001--_TechnicalControllerSheet.pdf',
    'FSKWSINGLES-ASILMW----QUAL0001--_PlannedProgramContent.pdf',
    'FSKWSINGLES-ASILMW----QUAL0001--_CalculationSetupVerificationforReferee.pdf',
    '-------------------------_CompetitionSchedule.pdf',
  ])('leaves the known-unused export %s in the tray', (filename) => {
    expect(planAutoAssignment(filename, CATEGORIES, makeStructure())).toEqual({
      action: 'tray',
      reason: 'not-for-protocol',
    });
  });

  it('trays an unknown suffix on a recognized category', () => {
    expect(
      planAutoAssignment(
        'FSKWSINGLES-ASILMW----QUAL0001--_SomeNewExport.pdf',
        CATEGORIES,
        makeStructure()
      )
    ).toEqual({ action: 'tray', reason: 'unknown-suffix' });
  });

  it('trays a Results.pdf that carries a real segment token', () => {
    expect(
      planAutoAssignment(
        'FSKWSINGLES-ASILMW----QUAL0001--_Results.pdf',
        CATEGORIES,
        makeStructure()
      )
    ).toEqual({ action: 'tray', reason: 'unknown-suffix' });
  });

  it('trays anything the recognizer cannot parse', () => {
    const structure = makeStructure();
    expect(planAutoAssignment('scan-2026-01-05.pdf', CATEGORIES, structure)).toEqual({
      action: 'tray',
      reason: 'unrecognized',
    });
    expect(planAutoAssignment('roster.xml', CATEGORIES, structure)).toEqual({
      action: 'tray',
      reason: 'unrecognized',
    });
    expect(
      planAutoAssignment(
        'FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf',
        [],
        structure
      )
    ).toEqual({ action: 'tray', reason: 'unrecognized' });
  });
});

/* ── category matching ─────────────────────────────────────────────────── */

describe('category matching', () => {
  it('matches on the code, ignoring trailing dash padding', () => {
    const outcome = planAutoAssignment(
      'FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf',
      CATEGORIES,
      makeStructure()
    );
    expect(outcome).toMatchObject({ action: 'assign', target: { categoryId: 'c1' } });
  });

  it('routes a split file by its group number', () => {
    const structure: StructureLike = {
      files: {},
      categories: [
        category('a', 'Aikuiset, Mupi L1 #1', 'FSKXSYNCHRONMLAIKU--01', [
          segment('a1', 'Free Skating', 1),
        ]),
        category('b', 'Aikuiset, Mupi L1 #2', 'FSKXSYNCHRONMLAIKU--02', [
          segment('b1', 'Free Skating', 1),
        ]),
      ],
    };
    expect(
      planAutoAssignment(
        'FSKXSYNCHRONMLAIKU--02--FNL0001--_SegmentResults.pdf',
        CATEGORIES,
        structure
      )
    ).toMatchObject({ action: 'assign', target: { categoryId: 'b', segmentId: 'b1' } });
  });

  it('falls back to the unsplit code when the structure has no split blocks', () => {
    const structure: StructureLike = {
      files: {},
      categories: [
        category('a', 'Aikuiset, Mupi L1', 'FSKXSYNCHRONMLAIKU----', [
          segment('a1', 'Free Skating', 1),
        ]),
      ],
    };
    expect(
      planAutoAssignment(
        'FSKXSYNCHRONMLAIKU--01--FNL0001--_SegmentResults.pdf',
        CATEGORIES,
        structure
      )
    ).toMatchObject({ action: 'assign', target: { categoryId: 'a' } });
  });

  it('never lets an unsplit file land in a split block', () => {
    const structure: StructureLike = {
      files: {},
      categories: [
        category('a', 'Aikuiset, Mupi L1 #1', 'FSKXSYNCHRONMLAIKU--01', [
          segment('a1', 'Free Skating', 1),
        ]),
      ],
    };
    expect(
      planAutoAssignment(
        'FSKXSYNCHRONMLAIKU------FNL0001--_SegmentResults.pdf',
        CATEGORIES,
        structure
      )
    ).toEqual({ action: 'tray', reason: 'unrecognized' });
  });

  it('reports ambiguity when two categories share a code', () => {
    const structure: StructureLike = {
      files: {},
      categories: [
        category('a', 'A-Silmut, Tytöt', 'FSKWSINGLES-ASILMW----', [segment('a1', 'Short Program', 1)]),
        category('b', 'A-Silmut, Tytöt (2)', 'FSKWSINGLES-ASILMW--', [segment('b1', 'Short Program', 1)]),
      ],
    };
    expect(
      planAutoAssignment(
        'FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf',
        CATEGORIES,
        structure
      )
    ).toEqual({ action: 'tray', reason: 'ambiguous-category' });
  });

  it('falls back to the Finnish display name for code-less categories', () => {
    const structure: StructureLike = {
      files: {},
      categories: [
        { id: 'n1', name: 'A-Silmut, Tytöt', segments: [segment('n1s', 'Short Program', 1)] },
      ],
    };
    expect(
      planAutoAssignment(
        'FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf',
        CATEGORIES,
        structure
      )
    ).toMatchObject({ action: 'assign', target: { categoryId: 'n1' } });
  });

  it('matches a name typed without diacritics or punctuation', () => {
    const structure: StructureLike = {
      files: {},
      categories: [{ id: 'n1', name: 'A Silmut Tytot', segments: [segment('n1s', 'Short Program', 1)] }],
    };
    expect(
      planAutoAssignment(
        'FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf',
        CATEGORIES,
        structure
      )
    ).toMatchObject({ action: 'assign', target: { categoryId: 'n1' } });
  });

  it('matches the English display name too', () => {
    const structure: StructureLike = {
      files: {},
      categories: [{ id: 'n1', name: 'A-Silmut, Girls', segments: [segment('n1s', 'Short Program', 1)] }],
    };
    expect(
      planAutoAssignment(
        'FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf',
        CATEGORIES,
        structure
      )
    ).toMatchObject({ action: 'assign', target: { categoryId: 'n1' } });
  });

  it('rejects a near miss instead of guessing', () => {
    const structure: StructureLike = {
      files: {},
      categories: [{ id: 'n1', name: 'A-Silmut, Pojat', segments: [segment('n1s', 'Short Program', 1)] }],
    };
    expect(
      planAutoAssignment(
        'FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf',
        CATEGORIES,
        structure
      )
    ).toEqual({ action: 'tray', reason: 'unrecognized' });
  });

  it('matches a split display name including its #N suffix', () => {
    const structure: StructureLike = {
      files: {},
      categories: [
        { id: 'n1', name: 'Aikuiset, Mupi L1 #2', segments: [segment('n1s', 'Free Skating', 1)] },
        { id: 'n2', name: 'Aikuiset, Mupi L1 #1', segments: [segment('n2s', 'Free Skating', 1)] },
      ],
    };
    expect(
      planAutoAssignment(
        'FSKXSYNCHRONMLAIKU--02--FNL0001--_SegmentResults.pdf',
        CATEGORIES,
        structure
      )
    ).toMatchObject({ action: 'assign', target: { categoryId: 'n1' } });
  });
});

/* ── segment matching ──────────────────────────────────────────────────── */

function twoSegmentStructure(first: string, second: string): StructureLike {
  return {
    files: {},
    categories: [
      category('c1', 'A-Silmut, Tytöt', 'FSKWSINGLES-ASILMW----', [
        segment('s1', first, 1),
        segment('s2', second, 2),
      ]),
    ],
  };
}

describe('segment matching', () => {
  it('maps QUAL to the short program and FNL to the free skating', () => {
    const structure = twoSegmentStructure('Short Program', 'Free Skating');
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf', CATEGORIES, structure)
    ).toMatchObject({ target: { segmentId: 's1' } });
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW----FNL0001--_SegmentResults.pdf', CATEGORIES, structure)
    ).toMatchObject({ target: { segmentId: 's2' } });
  });

  it('maps QUAL/FNL onto the Finnish segment names', () => {
    const structure = twoSegmentStructure('Lyhytohjelma', 'Vapaaohjelma');
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf', CATEGORIES, structure)
    ).toMatchObject({ target: { segmentId: 's1' } });
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW----FNL0001--_SegmentResults.pdf', CATEGORIES, structure)
    ).toMatchObject({ target: { segmentId: 's2' } });
  });

  it('maps the ice-dance phases RD and FD', () => {
    const structure: StructureLike = {
      files: {},
      categories: [
        category('d', 'Jäätanssi', 'FSKXDANCE-------------', [
          segment('d1', 'Rytmitanssi', 1),
          segment('d2', 'Vapaatanssi', 2),
        ]),
      ],
    };
    expect(
      planAutoAssignment('FSKXDANCE----RD0001--_SegmentResults.pdf', CATEGORIES, structure)
    ).toMatchObject({ target: { segmentId: 'd1' } });
    expect(
      planAutoAssignment('FSKXDANCE----FD0001--_SegmentResults.pdf', CATEGORIES, structure)
    ).toMatchObject({ target: { segmentId: 'd2' } });
  });

  it('matches a segment name by prefix', () => {
    const structure = twoSegmentStructure('Short Program Group A', 'Free Skating Group A');
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf', CATEGORIES, structure)
    ).toMatchObject({ target: { segmentId: 's1' } });
  });

  it('resolves SEGnnn by ordinal', () => {
    const structure: StructureLike = {
      files: {},
      categories: [
        category('c1', 'A-Silmut, Tytöt', 'FSKWSINGLES-ASILMW----', [
          segment('s1', 'Osa 1', 1),
          segment('s2', 'Osa 2', 2),
          segment('s3', 'Osa 3', 3),
        ]),
      ],
    };
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW----SEG002--_SegmentResults.pdf', CATEGORIES, structure)
    ).toMatchObject({ target: { segmentId: 's2' } });
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW----SEG009--_SegmentResults.pdf', CATEGORIES, structure)
    ).toEqual({ action: 'tray', reason: 'ambiguous-segment' });
  });

  it('gives anything to a single-segment category', () => {
    const structure: StructureLike = {
      files: {},
      categories: [
        category('c1', 'A-Silmut, Tytöt', 'FSKWSINGLES-ASILMW----', [
          segment('s1', 'Pattern Dance', 1),
        ]),
      ],
    };
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf', CATEGORIES, structure)
    ).toMatchObject({ target: { segmentId: 's1' } });
    // …including a file with no segment token at all
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW--------_SegmentResults.pdf', CATEGORIES, structure)
    ).toMatchObject({ target: { segmentId: 's1' } });
  });

  it('orders two unrecognizable segment names by phase', () => {
    const structure = twoSegmentStructure('Osa 1', 'Osa 2');
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf', CATEGORIES, structure)
    ).toMatchObject({ target: { segmentId: 's1' } });
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW----FNL0001--_SegmentResults.pdf', CATEGORIES, structure)
    ).toMatchObject({ target: { segmentId: 's2' } });
  });

  it('uses the segment order, not the array order', () => {
    const structure: StructureLike = {
      files: {},
      categories: [
        category('c1', 'A-Silmut, Tytöt', 'FSKWSINGLES-ASILMW----', [
          segment('later', 'Osa 2', 2),
          segment('earlier', 'Osa 1', 1),
        ]),
      ],
    };
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf', CATEGORIES, structure)
    ).toMatchObject({ target: { segmentId: 'earlier' } });
  });

  it('trays an ambiguous segment', () => {
    const structure: StructureLike = {
      files: {},
      categories: [
        category('c1', 'A-Silmut, Tytöt', 'FSKWSINGLES-ASILMW----', [
          segment('s1', 'Osa 1', 1),
          segment('s2', 'Osa 2', 2),
          segment('s3', 'Osa 3', 3),
        ]),
      ],
    };
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf', CATEGORIES, structure)
    ).toEqual({ action: 'tray', reason: 'ambiguous-segment' });
  });

  it('trays a segment file for a multi-segment category with no segment token', () => {
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW--------_SegmentResults.pdf', CATEGORIES, makeStructure())
    ).toEqual({ action: 'tray', reason: 'ambiguous-segment' });
  });

  it('trays when two segments share the same name', () => {
    const structure = twoSegmentStructure('Short Program', 'Short Program');
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf', CATEGORIES, structure)
    ).toEqual({ action: 'tray', reason: 'ambiguous-segment' });
  });
});

/* ── title pages ───────────────────────────────────────────────────────── */

describe('title pages', () => {
  it('sends a bare category-code PDF to the category title slot', () => {
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMW----.pdf', CATEGORIES, makeStructure())
    ).toEqual({
      action: 'assign',
      target: { kind: 'categoryTitle', categoryId: 'c1' },
    });
  });

  it('routes a split title page by its group number', () => {
    const structure: StructureLike = {
      files: {},
      categories: [
        category('a', 'Aikuiset, Mupi L1 #1', 'FSKXSYNCHRONMLAIKU--01', []),
        category('b', 'Aikuiset, Mupi L1 #2', 'FSKXSYNCHRONMLAIKU--02', []),
      ],
    };
    expect(planAutoAssignment('FSKXSYNCHRONMLAIKU--02.pdf', CATEGORIES, structure)).toEqual({
      action: 'assign',
      target: { kind: 'categoryTitle', categoryId: 'b' },
    });
  });

  it('leaves the title slot alone when it already holds a manual file', () => {
    const structure = makeStructure();
    structure.categories![0]!.titlePdf = 'f-manual';
    structure.files!['f-manual'] = { filename: 'title.pdf' };
    expect(planAutoAssignment('FSKWSINGLES-ASILMW----.pdf', CATEGORIES, structure)).toEqual({
      action: 'tray',
      reason: 'slot-occupied',
    });
  });

  it('does not claim a no-underscore PDF that only starts like a category code', () => {
    expect(
      planAutoAssignment('FSKWSINGLES-ASILMWnotes.pdf', CATEGORIES, makeStructure())
    ).toEqual({ action: 'tray', reason: 'unrecognized' });
  });
});

/* ── collisions ────────────────────────────────────────────────────────── */

describe('collision policy', () => {
  const FILE = 'FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf';

  it('takes an empty slot', () => {
    expect(planAutoAssignment(FILE, CATEGORIES, makeStructure())).toMatchObject({
      action: 'assign',
    });
  });

  it('refuses a slot held by a manually placed file', () => {
    const structure = makeStructure();
    structure.categories![0]!.segments![0]!.resultsPdf = 'f1';
    structure.files!['f1'] = { filename: 'something-else.pdf' };
    expect(planAutoAssignment(FILE, CATEGORIES, structure)).toEqual({
      action: 'tray',
      reason: 'slot-occupied',
    });
  });

  it('replaces an auto-assigned file with the same name (FSM re-export)', () => {
    const structure = makeStructure();
    structure.categories![0]!.segments![0]!.resultsPdf = 'f1';
    structure.files!['f1'] = { filename: FILE, autoAssigned: true };
    expect(planAutoAssignment(FILE, CATEGORIES, structure)).toMatchObject({ action: 'assign' });
  });

  it('refuses a slot held by a different auto-assigned file', () => {
    const structure = makeStructure();
    structure.categories![0]!.segments![0]!.resultsPdf = 'f1';
    structure.files!['f1'] = {
      filename: 'FSKWSINGLES-ASILMW----QUAL0002--_SegmentResults.pdf',
      autoAssigned: true,
    };
    expect(planAutoAssignment(FILE, CATEGORIES, structure)).toEqual({
      action: 'tray',
      reason: 'slot-occupied',
    });
  });

  it('refuses a slot whose occupant is unknown to the files map', () => {
    const structure = makeStructure();
    structure.categories![0]!.segments![0]!.resultsPdf = 'ghost';
    expect(planAutoAssignment(FILE, CATEGORIES, structure)).toEqual({
      action: 'tray',
      reason: 'slot-occupied',
    });
  });

  it('reads occupants back through slotOccupant', () => {
    const structure = makeStructure();
    structure.categories![1]!.totalResultsPdf = 'f9';
    expect(slotOccupant(structure, { kind: 'totalResults', categoryId: 'c2' })).toBe('f9');
    expect(slotOccupant(structure, { kind: 'totalResults', categoryId: 'c1' })).toBeNull();
  });
});

/* ── sequential batch planning ─────────────────────────────────────────── */

describe('applyOutcomeLocally', () => {
  it('lets a batch plan without two files landing in one slot', () => {
    const structure = makeStructure();
    const first = 'FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf';
    const second = 'FSKWSINGLES-ASILMW----QUAL0002--_SegmentResults.pdf';

    const a = planAutoAssignment(first, CATEGORIES, structure);
    expect(a).toMatchObject({ action: 'assign', target: { segmentId: 's1' } });
    const fileId = applyOutcomeLocally(structure, a, first);
    expect(fileId).toBeTruthy();
    expect(structure.categories![0]!.segments![0]!.resultsPdf).toBe(fileId);

    const b = planAutoAssignment(second, CATEGORIES, structure);
    expect(b).toEqual({ action: 'tray', reason: 'slot-occupied' });
  });

  it('does not disturb sibling slots', () => {
    const structure = makeStructure();
    const short = 'FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf';
    const free = 'FSKWSINGLES-ASILMW----FNL0001--_SegmentResults.pdf';
    applyOutcomeLocally(structure, planAutoAssignment(short, CATEGORIES, structure), short);
    const outcome = planAutoAssignment(free, CATEGORIES, structure);
    expect(outcome).toMatchObject({ action: 'assign', target: { segmentId: 's2' } });
    applyOutcomeLocally(structure, outcome, free);
    expect(structure.categories![0]!.segments![1]!.resultsPdf).toBeTruthy();
  });

  it('fills category-level and title slots too', () => {
    const structure = makeStructure();
    const totals = 'FSKMSINGLES-----------------------_Results.pdf';
    applyOutcomeLocally(structure, planAutoAssignment(totals, CATEGORIES, structure), totals);
    expect(structure.categories![1]!.totalResultsPdf).toBeTruthy();

    const title = 'FSKWSINGLES-ASILMW----.pdf';
    applyOutcomeLocally(structure, planAutoAssignment(title, CATEGORIES, structure), title);
    expect(structure.categories![0]!.titlePdf).toBeTruthy();
  });

  it('ignores a tray outcome', () => {
    const structure = makeStructure();
    expect(applyOutcomeLocally(structure, { action: 'tray', reason: 'unrecognized' }, 'x.pdf')).toBeNull();
    expect(Object.keys(structure.files!)).toHaveLength(0);
  });

  it('records the planned file as auto-assigned so a re-plan replaces it', () => {
    const structure = makeStructure();
    const file = 'FSKWSINGLES-ASILMW----QUAL0001--_SegmentResults.pdf';
    applyOutcomeLocally(structure, planAutoAssignment(file, CATEGORIES, structure), file);
    expect(planAutoAssignment(file, CATEGORIES, structure)).toMatchObject({ action: 'assign' });
  });
});
