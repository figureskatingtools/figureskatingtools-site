/**
 * Which roster XML is which: DT_PARTIC_TEAMS vs DT_PARTIC.
 *
 * The Protocol Generator's roster import wants one DT_PARTIC_TEAMS file (the
 * teams and their compositions) joined with one DT_PARTIC file (the skaters).
 * The user picks both in one file dialog, so the browser has to tell them apart
 * before posting them under the right key.
 *
 * Real FSM/ISU OdfBody exports are untidy in exactly the ways a naive substring
 * test trips over — padded attribute values (`DocumentType="DT_PARTIC_TEAMS "`),
 * single quotes, whitespace around `=`, a leading BOM, a namespaced root — and
 * some exports carry no `DocumentType` at all. So the type is read leniently and
 * then, failing that, inferred from the document's *structure*, which is what
 * the backend parsers (`dt_partic.parse_team_rosters` / `parse_participants`)
 * actually key on.
 *
 * Getting this wrong is silent: a TEAMS file posted as `particXml` parses into
 * an empty participant map and the import "succeeds" with rosters full of bare
 * athlete codes. Hence the hard rule that a file is consumed at most once.
 *
 * Everything here is pure: no DOM, no network, no file reading — the caller
 * hands over names and already-read text.
 */

/* ════════════════════════════════════════════════════════════════
   Types
   ════════════════════════════════════════════════════════════════ */

/** One selected file: its name and its already-read text content */
export interface RosterXmlFile {
  name: string;
  text: string;
}

/** What a single document turned out to be (`null` = unrecognised) */
export type RosterXmlKind = 'teams' | 'partic' | null;

/** The two XML strings the `import_rosters` body is built from ('' = absent) */
export interface RosterXmlSelection {
  teamsXml: string;
  particXml: string;
}

/* ════════════════════════════════════════════════════════════════
   Reading the document type
   ════════════════════════════════════════════════════════════════ */

/** `DocumentType` on the (possibly namespaced) OdfBody root */
const ROOT_DOC_TYPE =
  /<\s*(?:[A-Za-z_][\w.-]*:)?OdfBody\b[^>]*?\bDocumentType\s*=\s*(["'])([^"']*)\1/i;

/** `DocumentType` anywhere — last resort for shapes the root pattern misses */
const ANY_DOC_TYPE = /\bDocumentType\s*=\s*(["'])([^"']*)\1/i;

/**
 * The document's declared `DocumentType`, trimmed and upper-cased; `''` when the
 * attribute is absent. Tolerant of quoting style, padding and a namespaced root.
 */
export function readDocumentType(xml: string): string {
  const m = ROOT_DOC_TYPE.exec(xml) || ANY_DOC_TYPE.exec(xml);
  return m ? m[2].trim().toUpperCase() : '';
}

/* ════════════════════════════════════════════════════════════════
   Reading the document structure
   ════════════════════════════════════════════════════════════════ */

/** `<Composition>` — only a TEAMS document has one */
const HAS_COMPOSITION = /<\s*(?:[A-Za-z_][\w.-]*:)?Composition\b/i;
/** `<Participant …>` — the DT_PARTIC skater rows */
const HAS_PARTICIPANT = /<\s*(?:[A-Za-z_][\w.-]*:)?Participant\b/i;
/** `<Team …>` — weaker than the two above, since a participant list may name teams */
const HAS_TEAM = /<\s*(?:[A-Za-z_][\w.-]*:)?Team\b/i;

/**
 * What a roster XML looks like from the inside.
 *
 * `<Athlete>` is deliberately *not* a discriminator: a TEAMS document's
 * compositions are lists of athlete references, so it would match both files.
 * `<Composition>` is unique to TEAMS and so decides first; `<Participant>` then
 * marks a DT_PARTIC; a bare `<Team>` only counts once neither of those spoke.
 */
export function sniffRosterXmlStructure(xml: string): RosterXmlKind {
  if (HAS_COMPOSITION.test(xml)) return 'teams';
  if (HAS_PARTICIPANT.test(xml)) return 'partic';
  if (HAS_TEAM.test(xml)) return 'teams';
  return null;
}

/**
 * What one selected file is: its declared `DocumentType` when it has a usable
 * one, otherwise its structure. The filename is not consulted here — it is only
 * a tie-breaker, applied by `classifyRosterXml` to files nothing else identified.
 */
export function classifyRosterFile(file: RosterXmlFile): RosterXmlKind {
  const declared = readDocumentType(file.text);
  if (declared === 'DT_PARTIC_TEAMS') return 'teams';
  if (declared === 'DT_PARTIC') return 'partic';
  return sniffRosterXmlStructure(file.text);
}

/* ════════════════════════════════════════════════════════════════
   Classifying a whole selection
   ════════════════════════════════════════════════════════════════ */

/** Filename hints, tried in order — `DT_PARTIC_TEAMS.xml` says "teams" first */
const NAME_HINTS: { re: RegExp; kind: Exclude<RosterXmlKind, null> }[] = [
  { re: /teams/i, kind: 'teams' },
  { re: /partic/i, kind: 'partic' },
];

/**
 * Split a user's file selection into the `teamsXml` / `particXml` pair the
 * `import_rosters` route takes. Either may come back `''`:
 *
 *  * partic only — the backend re-matches against the archived roster,
 *  * teams only — imported without skater names,
 *  * both empty — nothing in the selection looked like a roster export.
 *
 * Each file is consumed at most once, so the same text is never returned under
 * both keys. Extra files of a kind already filled are ignored (first wins).
 */
export function classifyRosterXml(files: RosterXmlFile[]): RosterXmlSelection {
  const selection: RosterXmlSelection = { teamsXml: '', particXml: '' };
  const take = (kind: Exclude<RosterXmlKind, null>, text: string): boolean => {
    const key = kind === 'teams' ? 'teamsXml' : 'particXml';
    if (selection[key]) return false;
    selection[key] = text;
    return true;
  };

  // Pass 1: what each document says it is, or looks like from the inside.
  const unidentified: RosterXmlFile[] = [];
  for (const file of files) {
    const kind = classifyRosterFile(file);
    if (kind) take(kind, file.text);   // a duplicate of a filled kind is dropped,
    else unidentified.push(file);      // never re-offered to the other slot
  }

  // Pass 2: the filename, for files the content could not place.
  for (const file of unidentified) {
    const hint = NAME_HINTS.find(h => h.re.test(file.name));
    if (hint) take(hint.kind, file.text);
  }

  return selection;
}
