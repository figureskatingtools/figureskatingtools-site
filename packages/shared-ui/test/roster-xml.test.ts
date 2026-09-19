/**
 * Unit tests for the roster XML classifier.
 *
 * The XML below is invented — real exports carry minors' names — and reproduces
 * only the *shape* of DT_PARTIC_TEAMS / DT_PARTIC, including the untidiness the
 * classifier exists for: padded attribute values, single quotes, a leading BOM
 * and a namespaced root.
 *
 * The rule that matters most is that a TEAMS document must never come back as
 * `particXml`: the backend parses it into an empty participant map, so the
 * import would "succeed" with rosters full of bare athlete codes.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyRosterFile,
  classifyRosterXml,
  readDocumentType,
  sniffRosterXmlStructure,
  type RosterXmlFile,
} from '../src/roster-xml.js';

const TEAMS_BODY = `
  <Competition>
    <Team Code="SYNCHRO0001" Organisation="BHK " Name="Blue Herons ">
      <RegisteredEvent Event="FSKXSYNCHRONMLTULO----------------" />
      <Composition>
        <Athlete Code="A0001" Order="1" />
        <Athlete Code="A0002" Order="2" />
      </Composition>
    </Team>
  </Competition>`;

const PARTIC_BODY = `
  <Competition>
    <Participant Code="A0001" GivenName="Aino" FamilyName="Koskinen " />
    <Participant Code="A0002" GivenName="Bertil" FamilyName="Ahlberg" />
  </Competition>`;

const TEAMS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OdfBody DocumentType="DT_PARTIC_TEAMS">${TEAMS_BODY}
</OdfBody>
`;

const PARTIC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OdfBody DocumentType="DT_PARTIC">${PARTIC_BODY}
</OdfBody>
`;

const teams = (text = TEAMS_XML): RosterXmlFile => ({ name: 'DT_PARTIC_TEAMS.xml', text });
const partic = (text = PARTIC_XML): RosterXmlFile => ({ name: 'DT_PARTIC.xml', text });

/** A TEAMS document whose `DocumentType` is written in some untidy way */
const teamsDeclaredAs = (attr: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<OdfBody ${attr}>${TEAMS_BODY}\n</OdfBody>\n`;

describe('readDocumentType', () => {
  it('reads a tidy declaration', () => {
    expect(readDocumentType(TEAMS_XML)).toBe('DT_PARTIC_TEAMS');
    expect(readDocumentType(PARTIC_XML)).toBe('DT_PARTIC');
  });

  it('is empty when the attribute is absent', () => {
    expect(readDocumentType(`<OdfBody>${TEAMS_BODY}</OdfBody>`)).toBe('');
  });

  it('trims a padded value and upper-cases it', () => {
    expect(readDocumentType(teamsDeclaredAs('DocumentType="dt_partic_teams "')))
      .toBe('DT_PARTIC_TEAMS');
  });
});

describe('sniffRosterXmlStructure', () => {
  it('reads Composition as TEAMS even though athletes appear in both', () => {
    expect(sniffRosterXmlStructure(`<OdfBody>${TEAMS_BODY}</OdfBody>`)).toBe('teams');
  });

  it('reads Participant rows as PARTIC', () => {
    expect(sniffRosterXmlStructure(`<OdfBody>${PARTIC_BODY}</OdfBody>`)).toBe('partic');
  });

  it('recognises nothing in an unrelated document', () => {
    expect(sniffRosterXmlStructure('<OdfBody DocumentType="DT_SCHEDULE"><Unit /></OdfBody>'))
      .toBeNull();
  });
});

describe('classifyRosterFile', () => {
  it('tolerates whitespace, single quotes, padding and a BOM', () => {
    expect(classifyRosterFile(teams(teamsDeclaredAs('DocumentType = "DT_PARTIC_TEAMS"'))))
      .toBe('teams');
    expect(classifyRosterFile(teams(teamsDeclaredAs("DocumentType='DT_PARTIC_TEAMS'"))))
      .toBe('teams');
    expect(classifyRosterFile(teams(teamsDeclaredAs('DocumentType="DT_PARTIC_TEAMS "'))))
      .toBe('teams');
    expect(classifyRosterFile(teams('﻿' + TEAMS_XML))).toBe('teams');
  });

  it('tolerates a namespaced root', () => {
    const namespaced = `<?xml version="1.0"?>
<odf:OdfBody xmlns:odf="http://www.odf.org" DocumentType="DT_PARTIC_TEAMS">
  <odf:Competition>
    <odf:Team Code="T1" Name="Blue Herons">
      <odf:Composition><odf:Athlete Code="A0001" /></odf:Composition>
    </odf:Team>
  </odf:Competition>
</odf:OdfBody>`;
    expect(classifyRosterFile(teams(namespaced))).toBe('teams');
    // …and still, with the declaration stripped, from its structure alone.
    expect(classifyRosterFile(teams(namespaced.replace(' DocumentType="DT_PARTIC_TEAMS"', ''))))
      .toBe('teams');
  });

  it('falls back to the structure for an unrecognised declaration', () => {
    expect(classifyRosterFile(teams(teamsDeclaredAs('DocumentType="DT_PARTIC_TEAMS_V2"'))))
      .toBe('teams');
  });
});

describe('classifyRosterXml', () => {
  it('classifies the canonical pair in either selection order', () => {
    expect(classifyRosterXml([teams(), partic()]))
      .toEqual({ teamsXml: TEAMS_XML, particXml: PARTIC_XML });
    expect(classifyRosterXml([partic(), teams()]))
      .toEqual({ teamsXml: TEAMS_XML, particXml: PARTIC_XML });
  });

  it('classifies untidy TEAMS variants alongside a tidy PARTIC', () => {
    for (const attr of [
      'DocumentType = "DT_PARTIC_TEAMS"',
      "DocumentType='DT_PARTIC_TEAMS'",
      'DocumentType="DT_PARTIC_TEAMS "',
    ]) {
      const text = teamsDeclaredAs(attr);
      expect(classifyRosterXml([partic(), teams(text)]))
        .toEqual({ teamsXml: text, particXml: PARTIC_XML });
    }
    const bom = '﻿' + TEAMS_XML;
    expect(classifyRosterXml([teams(bom), partic()]))
      .toEqual({ teamsXml: bom, particXml: PARTIC_XML });
  });

  it('never returns the TEAMS text as particXml', () => {
    // Even when the filenames are useless and the declarations are missing.
    const bare = (text: string, name: string): RosterXmlFile => ({ name, text });
    const teamsBare = `<OdfBody>${TEAMS_BODY}</OdfBody>`;
    const particBare = `<OdfBody>${PARTIC_BODY}</OdfBody>`;
    const result = classifyRosterXml([bare(teamsBare, 'a.xml'), bare(particBare, 'b.xml')]);
    expect(result).toEqual({ teamsXml: teamsBare, particXml: particBare });

    // A second TEAMS file is dropped, not promoted into the empty PARTIC slot.
    const two = classifyRosterXml([teams(), { name: 'partic-export.xml', text: TEAMS_XML }]);
    expect(two.teamsXml).toBe(TEAMS_XML);
    expect(two.particXml).toBe('');
  });

  it('leaves teamsXml empty for a partic-only selection', () => {
    expect(classifyRosterXml([partic()])).toEqual({ teamsXml: '', particXml: PARTIC_XML });
  });

  it('leaves particXml empty for a teams-only selection', () => {
    expect(classifyRosterXml([teams()])).toEqual({ teamsXml: TEAMS_XML, particXml: '' });
  });

  it('classifies nothing in an unrelated XML', () => {
    const schedule = { name: 'schedule.xml', text: '<OdfBody DocumentType="DT_SCHEDULE"><Unit /></OdfBody>' };
    expect(classifyRosterXml([schedule])).toEqual({ teamsXml: '', particXml: '' });
    expect(classifyRosterXml([])).toEqual({ teamsXml: '', particXml: '' });
  });

  it('uses the filename only for files the content could not place', () => {
    const blank = '<OdfBody><Competition /></OdfBody>';
    expect(classifyRosterXml([{ name: 'DT_PARTIC_TEAMS.xml', text: blank }]))
      .toEqual({ teamsXml: blank, particXml: '' });
    expect(classifyRosterXml([{ name: 'DT_PARTIC.xml', text: blank }]))
      .toEqual({ teamsXml: '', particXml: blank });
  });
});
