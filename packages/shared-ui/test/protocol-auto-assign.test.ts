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
  matchNameTokens,
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

  it('routes the protocol head page to the category title slot', () => {
    expect(SUFFIX_SLOTS['ProtocolHeadPage.pdf']).toEqual({
      kind: 'categoryTitle',
      requiresCategoryLevel: true,
    });
  });
});

/* ── token pairing ─────────────────────────────────────────────────────── */

describe('matchNameTokens', () => {
  it('pairs a schedule PDF spelling with the registry spelling', () => {
    expect(matchNameTokens('SM-Noviisit, Tytöt', 'SM-NOVIISI Tytöt')).toBe(true);
    expect(matchNameTokens('SM-Juniorit, Miehet', 'SM-JUNIORI Miehet')).toBe(true);
    expect(matchNameTokens('SM-Juniorit, Naiset', 'SM-JUNIORI Naiset')).toBe(true);
    expect(matchNameTokens('SM-Seniorit, Naiset', 'SM-SENIORI Naiset')).toBe(true);
    expect(matchNameTokens('SM-Seniorit, Miehet', 'SM-SENIORI Miehet')).toBe(true);
  });

  it('requires the same number of tokens', () => {
    expect(matchNameTokens('Juniorit, Miehet', 'SM-JUNIORI Miehet')).toBe(false);
    expect(matchNameTokens('Noviisit, Tytöt', 'SM-Noviisit, Tytöt')).toBe(false);
    expect(matchNameTokens('Junior, Men', 'SM-JUNIORI Miehet')).toBe(false);
  });

  it('never pairs different words', () => {
    expect(matchNameTokens('SM-Noviisit, Pojat', 'SM-NOVIISI Tytöt')).toBe(false);
    expect(matchNameTokens('Junior Ice Dance', 'SM-JUNIORI Jäätanssi')).toBe(false);
    expect(matchNameTokens('A-Silmut, Pojat', 'A-Silmut, Tytöt')).toBe(false);
  });

  it('demands exact equality for tokens shorter than four characters', () => {
    expect(matchNameTokens('SM Naiset', 'SMK Naiset')).toBe(false);
    expect(matchNameTokens('Aikuiset, Mupi L1 #1', 'Aikuiset, Mupi L1 #2')).toBe(false);
    expect(matchNameTokens('Aikuiset, Mupi L1 #2', 'Aikuiset, Mupi L1 #2')).toBe(true);
    // …and lets a four-character stem through
    expect(matchNameTokens('Juniori Naiset', 'Juni Naiset')).toBe(true);
  });

  it('pairs bijectively — two tokens may not share one partner', () => {
    expect(matchNameTokens('Junior Juniori', 'Juniori Naiset')).toBe(false);
    expect(matchNameTokens('Junior Juniori', 'Juniorit Juniori')).toBe(true);
  });

  it('rejects an empty name outright', () => {
    expect(matchNameTokens('', '')).toBe(false);
    expect(matchNameTokens('Naiset', undefined)).toBe(false);
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
      target: {
        kind: 'segment',
        categoryId: 'c3',
        segmentId: 's4',
        role: 'results',
        categoryCode: 'FSKWSINGLES',
        matchedBy: 'code',
      },
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
      target: {
        kind: 'totalResults',
        categoryId: 'c2',
        categoryCode: 'FSKMSINGLES',
        matchedBy: 'code',
      },
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
      target: {
        kind: 'segment',
        categoryId: 'c1',
        segmentId: 's1',
        role: 'panel',
        categoryCode: 'FSKWSINGLES-ASILMW',
        matchedBy: 'code',
      },
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
      target: {
        kind: 'segment',
        categoryId: 'c1',
        segmentId: 's2',
        role: 'judgesDetails',
        categoryCode: 'FSKWSINGLES-ASILMW',
        matchedBy: 'code',
      },
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
      target: {
        kind: 'categoryTitle',
        categoryId: 'c1',
        categoryCode: 'FSKWSINGLES-ASILMW',
        matchedBy: 'code',
      },
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
      target: {
        kind: 'categoryTitle',
        categoryId: 'b',
        categoryCode: 'FSKXSYNCHRONMLAIKU',
        matchedBy: 'code',
      },
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

/* ── field data: the kktest competition ────────────────────────────────────
 *
 * A real competition whose structure was parsed from a PDF schedule, so every
 * category carries `code: ''` and matching has to go through the names. The
 * table rows and filenames below are verbatim from that competition.
 * ────────────────────────────────────────────────────────────────────────── */

const KK_CATEGORIES: CategoryInfo[] = sortCategoriesForMatching([
  { abbreviation: 'FSKMSINGLES', displayName: 'Senior, Men', displayNameFi: 'SM-Seniorit, Miehet', judgingMethod: 'ISU', competitionType: 'Figure skating' },
  { abbreviation: 'FSKMSINGLES-ADVNOV', displayName: 'Advanced Novice, Men', displayNameFi: 'SM-Noviisit, Pojat', judgingMethod: 'ISU', competitionType: 'Figure skating' },
  { abbreviation: 'FSKMSINGLES-JUNIOR', displayName: 'Junior, Men', displayNameFi: 'SM-Juniorit, Miehet', judgingMethod: 'ISU', competitionType: 'Figure skating' },
  { abbreviation: 'FSKWSINGLES', displayName: 'Senior, Women', displayNameFi: 'SM-Seniorit, Naiset', judgingMethod: 'ISU', competitionType: 'Figure skating' },
  { abbreviation: 'FSKWSINGLES-ADVNOV', displayName: 'Advanced Novice, Women', displayNameFi: 'SM-Noviisit, Tytöt', judgingMethod: 'ISU', competitionType: 'Figure skating' },
  { abbreviation: 'FSKWSINGLES-JUNIOR', displayName: 'Junior, Women', displayNameFi: 'SM-Juniorit, Naiset', judgingMethod: 'ISU', competitionType: 'Figure skating' },
  { abbreviation: 'FSKXICEDANCEJUNIOR', displayName: 'Junior Ice Dance', displayNameFi: 'Junior Ice Dance', judgingMethod: 'ISU', competitionType: 'Figure skating' },
  // …and the neighbouring rows of the same table, which must not be dragged in
  { abbreviation: 'FSKWSINGLES-ASILMW', displayName: 'A-Silmut, Girls', displayNameFi: 'A-Silmut, Tytöt', judgingMethod: 'ISU', competitionType: 'Figure skating' },
  { abbreviation: 'FSKMSINGLES-KJUNIM', displayName: 'Juniors, Men', displayNameFi: 'Juniorit, Miehet', judgingMethod: 'ISU', competitionType: 'Figure skating' },
  { abbreviation: 'FSKWSINGLES-KNOVIW', displayName: 'Novices, Girls', displayNameFi: 'Noviisit, Tytöt', judgingMethod: 'ISU', competitionType: 'Figure skating' },
  { abbreviation: 'FSKXSYNCHRONMLTULO', displayName: 'Tulokkaat', displayNameFi: 'Tulokkaat', judgingMethod: 'MUPI', competitionType: 'Synchronized skating' },
]);

/** Every category code-less, exactly as the schedule parser leaves them */
function pdfCategory(id: string, name: string, first: string, second: string): CategoryLike {
  return {
    id,
    name,
    code: '',
    titlePdf: null,
    totalResultsPdf: null,
    segments: [segment(`${id}a`, first, 1), segment(`${id}b`, second, 2)],
  };
}

function kkStructure(): StructureLike {
  return {
    files: {},
    categories: [
      pdfCategory('kk1', 'SM-NOVIISI Tytöt', 'Short Program', 'Free Skating'),
      pdfCategory('kk2', 'SM-JUNIORI Naiset', 'Short Program', 'Free Skating'),
      pdfCategory('kk3', 'SM-JUNIORI Miehet', 'Short Program', 'Free Skating'),
      pdfCategory('kk4', 'SM-SENIORI Miehet', 'Short Program', 'Free Skating'),
      pdfCategory('kk5', 'SM-SENIORI Naiset', 'Short Program', 'Free Skating'),
      pdfCategory('kk6', 'SM-JUNIORI Jäätanssi', 'Rhythm Dance', 'Free Dance'),
    ],
  };
}

describe('kktest — a schedule-parsed structure with no category codes', () => {
  it('places the senior men panel sheet on the free skating segment (FNL-000100)', () => {
    expect(
      planAutoAssignment(
        'FSKMSINGLES-----------FNL-000100--_ISUPanelofJudgesandTechnicalPanel.pdf',
        KK_CATEGORIES,
        kkStructure()
      )
    ).toEqual({
      action: 'assign',
      target: {
        kind: 'segment',
        categoryId: 'kk4',
        segmentId: 'kk4b',
        role: 'panel',
        categoryCode: 'FSKMSINGLES',
        matchedBy: 'name',
      },
    });
  });

  it('places the junior men QUAL segment results on the short program', () => {
    expect(
      planAutoAssignment(
        'FSKMSINGLES-JUNIOR----QUAL000100--_SegmentResults.pdf',
        KK_CATEGORIES,
        kkStructure()
      )
    ).toEqual({
      action: 'assign',
      target: {
        kind: 'segment',
        categoryId: 'kk3',
        segmentId: 'kk3a',
        role: 'results',
        categoryCode: 'FSKMSINGLES-JUNIOR',
        matchedBy: 'name',
      },
    });
  });

  it('places the junior men protocol head page in the category title slot', () => {
    expect(
      planAutoAssignment(
        'FSKMSINGLES-JUNIOR----------------_ProtocolHeadPage.pdf',
        KK_CATEGORIES,
        kkStructure()
      )
    ).toEqual({
      action: 'assign',
      target: {
        kind: 'categoryTitle',
        categoryId: 'kk3',
        categoryCode: 'FSKMSINGLES-JUNIOR',
        matchedBy: 'name',
      },
    });
  });

  it('places the senior men Results sheet in the total results slot', () => {
    expect(
      planAutoAssignment(
        'FSKMSINGLES-----------------------_Results.pdf',
        KK_CATEGORIES,
        kkStructure()
      )
    ).toEqual({
      action: 'assign',
      target: {
        kind: 'totalResults',
        categoryId: 'kk4',
        categoryCode: 'FSKMSINGLES',
        matchedBy: 'name',
      },
    });
  });

  it.each([
    ['FSKWSINGLES-ADVNOV----QUAL000100--_SegmentResults.pdf', 'kk1', 'kk1a'],
    ['FSKWSINGLES-ADVNOV----FNL-000100--_SegmentResults.pdf', 'kk1', 'kk1b'],
    ['FSKWSINGLES-JUNIOR----QUAL000100--_SegmentResults.pdf', 'kk2', 'kk2a'],
    ['FSKWSINGLES-JUNIOR----FNL-000100--_SegmentResults.pdf', 'kk2', 'kk2b'],
    ['FSKMSINGLES-JUNIOR----FNL-000100--_SegmentResults.pdf', 'kk3', 'kk3b'],
    ['FSKMSINGLES-----------QUAL000100--_SegmentResults.pdf', 'kk4', 'kk4a'],
    ['FSKWSINGLES-----------QUAL000100--_SegmentResults.pdf', 'kk5', 'kk5a'],
    ['FSKWSINGLES-----------FNL-000100--_SegmentResults.pdf', 'kk5', 'kk5b'],
  ])('routes %s to %s / %s', (filename, categoryId, segmentId) => {
    expect(planAutoAssignment(filename, KK_CATEGORIES, kkStructure())).toMatchObject({
      action: 'assign',
      target: { categoryId, segmentId, matchedBy: 'name' },
    });
  });

  it.each([
    'FSKXICEDANCEJUNIOR----FNL-000100--_SegmentResults.pdf',
    'FSKXICEDANCEJUNIOR----RD-000100--_SegmentResults.pdf',
    'FSKXICEDANCEJUNIOR----------------_ProtocolHeadPage.pdf',
    'FSKXICEDANCEJUNIOR----------------_Results.pdf',
  ])('leaves the ice dance export %s in the tray rather than guessing', (filename) => {
    // `Junior Ice Dance` shares only its junior~juniori token with
    // `SM-JUNIORI Jäätanssi`, so nothing pairs and nothing is mis-assigned.
    expect(planAutoAssignment(filename, KK_CATEGORIES, kkStructure())).toEqual({
      action: 'tray',
      reason: 'unrecognized',
    });
  });

  it('has no home for the men advanced novice files this competition never ran', () => {
    expect(
      planAutoAssignment(
        'FSKMSINGLES-ADVNOV----QUAL000100--_SegmentResults.pdf',
        KK_CATEGORIES,
        kkStructure()
      )
    ).toEqual({ action: 'tray', reason: 'unrecognized' });
  });

  it('plans the whole drop in one pass without two files sharing a slot', () => {
    const structure = kkStructure();
    const drop = [
      'FSKMSINGLES-----------FNL-000100--_ISUPanelofJudgesandTechnicalPanel.pdf',
      'FSKMSINGLES-----------QUAL000100--_SegmentResults.pdf',
      'FSKMSINGLES-----------FNL-000100--_SegmentResults.pdf',
      'FSKMSINGLES-----------------------_Results.pdf',
      'FSKMSINGLES-----------------------_ProtocolHeadPage.pdf',
    ];
    for (const filename of drop) {
      const outcome = planAutoAssignment(filename, KK_CATEGORIES, structure);
      expect(outcome).toMatchObject({ action: 'assign', target: { categoryId: 'kk4' } });
      expect(applyOutcomeLocally(structure, outcome, filename)).toBeTruthy();
    }
    const senior = structure.categories![3]!;
    expect(senior.titlePdf).toBeTruthy();
    expect(senior.totalResultsPdf).toBeTruthy();
    expect(senior.segments![0]!.resultsPdf).toBeTruthy();
    expect(senior.segments![1]!.resultsPdf).toBeTruthy();
    expect(senior.segments![1]!.panelPdf).toBeTruthy();
  });
});

/* ── near misses that must stay near misses ────────────────────────────── */

describe('name matching never widens into a guess', () => {
  it('keeps SM-JUNIORI Miehet away from the plain Juniorit, Miehet row', () => {
    const structure: StructureLike = {
      files: {},
      categories: [pdfCategory('only', 'SM-JUNIORI Miehet', 'Short Program', 'Free Skating')],
    };
    expect(
      planAutoAssignment(
        'FSKMSINGLES-KJUNIM----QUAL000100--_SegmentResults.pdf',
        KK_CATEGORIES,
        structure
      )
    ).toEqual({ action: 'tray', reason: 'unrecognized' });
  });

  it('keeps Noviisit, Tytöt and SM-Noviisit, Tytöt as two different categories', () => {
    const structure: StructureLike = {
      files: {},
      categories: [
        pdfCategory('kansallinen', 'Noviisit, Tytöt', 'Short Program', 'Free Skating'),
        pdfCategory('sm', 'SM-NOVIISI Tytöt', 'Short Program', 'Free Skating'),
      ],
    };
    expect(
      planAutoAssignment(
        'FSKWSINGLES-KNOVIW----QUAL000100--_SegmentResults.pdf',
        KK_CATEGORIES,
        structure
      )
    ).toMatchObject({ action: 'assign', target: { categoryId: 'kansallinen' } });
    expect(
      planAutoAssignment(
        'FSKWSINGLES-ADVNOV----QUAL000100--_SegmentResults.pdf',
        KK_CATEGORIES,
        structure
      )
    ).toMatchObject({ action: 'assign', target: { categoryId: 'sm' } });
  });

  it('trays a category two different table rows describe equally well', () => {
    const table: CategoryInfo[] = sortCategoriesForMatching([
      { abbreviation: 'FSKWSINGLES-JUNIOR', displayName: 'Junior, Women', displayNameFi: 'Juniorit, Naiset', judgingMethod: 'ISU', competitionType: 'Figure skating' },
      { abbreviation: 'FSKWSINGLES-KJUNIW', displayName: 'Juniors, Women', displayNameFi: 'Juniori, Naiset', judgingMethod: 'ISU', competitionType: 'Figure skating' },
    ]);
    const structure: StructureLike = {
      files: {},
      categories: [pdfCategory('n1', 'Juniorit, Naiset', 'Short Program', 'Free Skating')],
    };
    expect(
      planAutoAssignment(
        'FSKWSINGLES-JUNIOR----QUAL000100--_SegmentResults.pdf',
        table,
        structure
      )
    ).toEqual({ action: 'tray', reason: 'ambiguous-category' });
  });

  it('still trays a structure where two categories fit the same file', () => {
    const structure: StructureLike = {
      files: {},
      categories: [
        pdfCategory('a', 'SM-JUNIORI Naiset', 'Short Program', 'Free Skating'),
        pdfCategory('b', 'SM-Juniorit, Naiset', 'Short Program', 'Free Skating'),
      ],
    };
    expect(
      planAutoAssignment(
        'FSKWSINGLES-JUNIOR----QUAL000100--_SegmentResults.pdf',
        KK_CATEGORIES,
        structure
      )
    ).toEqual({ action: 'tray', reason: 'ambiguous-category' });
  });
});
