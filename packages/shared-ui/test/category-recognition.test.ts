/**
 * Unit tests for the FSM filename recognizer.
 *
 * These lock in parity with `fs-judgepapers/infra/functions/categories.py`
 * (`match_category` / `parse_filename_generic`) — the two must not drift.
 */

import { describe, expect, it } from 'vitest';

import {
  matchCategory,
  parseFilenameGeneric,
  sortCategoriesForMatching,
  type CategoryInfo,
} from '../src/category-recognition.js';

const RAW_CATEGORIES: CategoryInfo[] = [
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
];

/** The order `get_categories` serves: longest abbreviation first */
const CATEGORIES = sortCategoriesForMatching(RAW_CATEGORIES);

describe('sortCategoriesForMatching', () => {
  it('orders by abbreviation length, longest first, without mutating the input', () => {
    const lengths = CATEGORIES.map((c) => c.abbreviation.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
    expect(RAW_CATEGORIES[0]!.abbreviation).toBe('FSKWSINGLES');
  });
});

describe('matchCategory', () => {
  it('picks the longest prefix when the list is sorted', () => {
    const hit = matchCategory('FSKWSINGLES-ASILMW-----QUAL0001--_SegmentResults.pdf', CATEGORIES);
    expect(hit?.abbreviation).toBe('FSKWSINGLES-ASILMW');
  });

  it('walks the list in order — an unsorted list can match the short prefix first', () => {
    const hit = matchCategory(
      'FSKWSINGLES-ASILMW-----QUAL0001--_SegmentResults.pdf',
      RAW_CATEGORIES
    );
    expect(hit?.abbreviation).toBe('FSKWSINGLES');
  });

  it('returns null when nothing matches', () => {
    expect(matchCategory('SOMETHINGELSE_Results.pdf', CATEGORIES)).toBeNull();
  });
});

describe('parseFilenameGeneric', () => {
  it('parses a segment results sheet, longest prefix winning', () => {
    const parsed = parseFilenameGeneric(
      'FSKWSINGLES-ASILMW-----QUAL0001--_SegmentResults.pdf',
      CATEGORIES
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.categoryCode).toBe('FSKWSINGLES-ASILMW');
    expect(parsed!.category).toBe('A-Silmut, Girls');
    expect(parsed!.categoryFi).toBe('A-Silmut, Tytöt');
    expect(parsed!.judgingMethod).toBe('ISU');
    expect(parsed!.type).toBe('Figure skating');
    expect(parsed!.segment).toBe('QUAL0001');
    expect(parsed!.rawSegment).toBe('QUAL0001');
    expect(parsed!.suffix).toBe('SegmentResults.pdf');
    expect(parsed!.prefix).toBe('FSKWSINGLES-ASILMW-----QUAL0001--');
    expect(parsed!.splitNumber).toBeNull();
  });

  it('keeps the full segment identifier, digits and all', () => {
    const parsed = parseFilenameGeneric(
      'FSKWSINGLES-----------QUAL000100--_SegmentResults.pdf',
      CATEGORIES
    );
    expect(parsed!.categoryCode).toBe('FSKWSINGLES');
    expect(parsed!.segment).toBe('QUAL000100');
  });

  it('reports a dash-only segment portion as Unknown', () => {
    const parsed = parseFilenameGeneric(
      'FSKMSINGLES-----------------------_Results.pdf',
      CATEGORIES
    );
    expect(parsed!.categoryCode).toBe('FSKMSINGLES');
    expect(parsed!.segment).toBe('Unknown');
    expect(parsed!.rawSegment).toBe('Unknown');
    expect(parsed!.suffix).toBe('Results.pdf');
  });

  it('detects a split group and appends #N to both display names', () => {
    const parsed = parseFilenameGeneric(
      'FSKXSYNCHRONMLAIKU--01-----_Results.pdf',
      CATEGORIES
    );
    expect(parsed!.splitNumber).toBe(1);
    expect(parsed!.category).toBe('Adults, Mupi L1 #1');
    expect(parsed!.categoryFi).toBe('Aikuiset, Mupi L1 #1');
    expect(parsed!.judgingMethod).toBe('MUPI');
    // The split digits are not part of the segment
    expect(parsed!.segment).toBe('Unknown');
  });

  it('strips the split group off the front of a segment token', () => {
    const parsed = parseFilenameGeneric(
      'FSKXSYNCHRONMLAIKU--02--FNL0001--_SegmentResults.pdf',
      CATEGORIES
    );
    expect(parsed!.splitNumber).toBe(2);
    expect(parsed!.segment).toBe('FNL0001');
    expect(parsed!.category).toBe('Adults, Mupi L1 #2');
  });

  it('maps a calculation-setup sheet to the Category General segment', () => {
    const parsed = parseFilenameGeneric(
      'FSKWSINGLES-ASILMW-----QUAL0001--_CalculationSetupVerificationforReferee.pdf',
      CATEGORIES
    );
    expect(parsed!.segment).toBe('Category General');
    expect(parsed!.rawSegment).toBe('Category General');
  });

  it('recognizes the competition-wide schedule with no category at all', () => {
    const parsed = parseFilenameGeneric(
      '-------------------------_CompetitionSchedule.pdf',
      CATEGORIES
    );
    expect(parsed).toEqual({
      filename: '-------------------------_CompetitionSchedule.pdf',
      type: 'Competition',
      category: 'Competition',
      categoryFi: 'Competition',
      categoryCode: '',
      judgingMethod: '',
      segment: 'General',
      rawSegment: 'General',
      suffix: 'CompetitionSchedule.pdf',
      prefix: '-------------------------',
      splitNumber: null,
    });
  });

  it('strips a leading path', () => {
    const parsed = parseFilenameGeneric(
      'uploads/2026/FSKMSINGLES-----------------------_Results.pdf',
      CATEGORIES
    );
    expect(parsed!.filename).toBe('FSKMSINGLES-----------------------_Results.pdf');
  });

  it('returns null for a non-PDF', () => {
    expect(
      parseFilenameGeneric('FSKWSINGLES-ASILMW-----QUAL0001--_SegmentResults.xlsx', CATEGORIES)
    ).toBeNull();
  });

  it('returns null for a filename with no underscore', () => {
    expect(parseFilenameGeneric('FSKWSINGLES-ASILMW----.pdf', CATEGORIES)).toBeNull();
  });

  it('returns null when no abbreviation matches', () => {
    expect(parseFilenameGeneric('MYSTERY-----QUAL0001--_SegmentResults.pdf', CATEGORIES)).toBeNull();
  });

  it('returns null when the category table is empty', () => {
    expect(
      parseFilenameGeneric('FSKWSINGLES-ASILMW-----QUAL0001--_SegmentResults.pdf', [])
    ).toBeNull();
  });

  it('falls back to the English name when the table has no Finnish one', () => {
    const parsed = parseFilenameGeneric('FSKMSINGLES--01---_Results.pdf', [
      {
        abbreviation: 'FSKMSINGLES',
        displayName: 'Men, Singles',
        displayNameFi: '',
        judgingMethod: 'ISU',
        competitionType: 'Figure skating',
      },
    ]);
    expect(parsed!.categoryFi).toBe('Men, Singles #1');
  });
});
