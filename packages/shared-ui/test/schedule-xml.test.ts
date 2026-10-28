/**
 * Unit tests for the DT_SCHEDULE summary (categories, days, venue).
 *
 * The fixtures follow FS Manager's real export of competition YL110926HTL,
 * the same shape the Protocol Generator's schedule parser is tested against.
 */

import { describe, expect, it } from 'vitest';

import { isScheduleXmlName, summarizeScheduleXml } from '../src/schedule-xml.js';

function schedule(...units: Array<[string, string, string]>): string {
  const body = units
    .map(([code, start, item]) =>
      `    <Unit Code="${code}" StartDate="${start}">\n` +
      `      <ItemName Value="${item}" />\n` +
      `      <VenueDescription VenueName="Hyvinkään jäähalli" />\n` +
      '    </Unit>')
    .join('\n');
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<OdfBody CompetitionCode="YL110926HTL" DocumentType="DT_SCHEDULE">\n' +
    '  <Competition Code="FSK-------------------------------">\n' +
    `${body}\n` +
    '  </Competition>\n</OdfBody>\n';
}

const YL110926HTL = schedule(
  ['FSKWSINGLES-ADVNOV----QUAL000100--', '2026-09-11T15:00:00', 'SM-NOVIISI Tytöt Lyhytohjelma'],
  ['FSKWSINGLES-ADVNOV----FNL-000100--', '2026-09-12T13:00:00', 'SM-NOVIISI Tytöt Vapaaohjelma'],
  ['FSKWSINGLES-DEBYTW----FNL-000100--', '2026-09-12T10:30:00', 'DEBYTANTTI Tytöt'],
);

describe('summarizeScheduleXml', () => {
  it('lists categories in skating order, segments merged', () => {
    expect(summarizeScheduleXml(YL110926HTL).categories).toEqual(['SM-NOVIISI Tytöt', 'DEBYTANTTI Tytöt']);
  });

  it('reads the first and last day and the venue', () => {
    const summary = summarizeScheduleXml(YL110926HTL);
    expect([summary.firstDate, summary.lastDate, summary.venue])
      .toEqual(['2026-09-11', '2026-09-12', 'Hyvinkään jäähalli']);
  });

  it('strips English segment names too', () => {
    const xml = schedule(
      ['FSKWSINGLES-----------QUAL000100--', '2026-01-05T15:00:00', 'Women Short Program'],
      ['FSKMSINGLES-----------FNL-000100--', '2026-01-06T12:00:00', 'Men Free Skating'],
    );
    expect(summarizeScheduleXml(xml).categories).toEqual(['Women', 'Men']);
  });

  it('leaves out practice and other non-competition units', () => {
    const xml = schedule(
      ['FSKWSINGLES-----------QUAL000100--', '2026-01-04T09:00:00', 'Official Practice'],
      ['FSKWSINGLES-----------QUAL000100--', '2026-01-05T15:00:00', 'Women Short Program'],
    );
    const summary = summarizeScheduleXml(xml);
    expect(summary.categories).toEqual(['Women']);
    expect(summary.firstDate).toBe('2026-01-05');
  });

  it('merges one name skated under two codes', () => {
    const xml = schedule(
      ['FSKWSINGLES-NOVL1-----FNL-000100--', '2026-01-05T10:00:00', 'Noviisit'],
      ['FSKWSINGLES-NOVL2-----FNL-000100--', '2026-01-05T12:00:00', 'Noviisit'],
    );
    expect(summarizeScheduleXml(xml).categories).toEqual(['Noviisit']);
  });

  it('decodes entities and tolerates a namespace and single quotes', () => {
    const xml = "<odf:OdfBody DocumentType='DT_SCHEDULE'><odf:Unit Code='X' StartDate='2026-03-01T10:00:00'>" +
      "<odf:ItemName Value='Pojat &amp; Tytöt' /><odf:VenueDescription VenueName='J&#228;&#xE4;halli' />" +
      '</odf:Unit></odf:OdfBody>';
    const summary = summarizeScheduleXml(xml);
    expect(summary.categories).toEqual(['Pojat & Tytöt']);
    expect(summary.venue).toBe('Jäähalli');
  });

  it('yields empty fields for a document without units', () => {
    expect(summarizeScheduleXml('<OdfBody DocumentType="DT_SCHEDULE" />'))
      .toEqual({ categories: [], firstDate: '', lastDate: '', venue: '' });
    expect(summarizeScheduleXml('')).toEqual({ categories: [], firstDate: '', lastDate: '', venue: '' });
  });
});

describe('isScheduleXmlName', () => {
  it('matches full FS Manager schedule exports only', () => {
    expect(isScheduleXmlName('DT_SCHEDULE_FSK-------------------------------.xml')).toBe(true);
    // An update holds only the changed units
    expect(isScheduleXmlName('DT_SCHEDULE_UPDATE_FSK.xml')).toBe(false);
    expect(isScheduleXmlName('YL110926HTL_CompetitionSchedule.pdf')).toBe(false);
    expect(isScheduleXmlName('DT_PARTIC_FSK.xml')).toBe(false);
  });
});
