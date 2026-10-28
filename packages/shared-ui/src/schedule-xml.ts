/**
 * What a DT_SCHEDULE says about a competition at a glance.
 *
 * FS Manager pushes its schedule (`DT_SCHEDULE…xml`, an ISU OdfBody) into the
 * competition file pool. Each `<Unit>` is one segment of one category:
 *
 *   <Unit Code="FSKWSINGLES-ADVNOV----QUAL000100--" StartDate="2026-09-11T15:00:00">
 *     <ItemName Value="SM-NOVIISI Tytöt Lyhytohjelma" />
 *     <VenueDescription VenueName="Hyvinkään jäähalli" />
 *   </Unit>
 *
 * The summary is what a banner or a header needs: the categories in schedule
 * order (the segment stripped off the item name, units of one category code
 * merged), the first and last competition day, and the venue. The Protocol
 * Generator's `schedule_parser.parse_schedule_xml` reads the same document for
 * its full category structure; the segment names here follow its list.
 *
 * Pure and regex-based like `roster-xml.ts`: no DOM, so it tests in plain node.
 */

/** A schedule reduced to what is printed about the competition */
export interface ScheduleSummary {
  /** Category names in the order they first skate, without duplicates */
  categories: string[];
  /** First and last competition day, ISO `YYYY-MM-DD` ('' when unknown) */
  firstDate: string;
  lastDate: string;
  /** The first venue named ('' when none) */
  venue: string;
}

/** Segment names that end an ItemName — longest match wins */
const SEGMENTS = [
  'Short Program', 'Free Skating', 'Free Program', 'Rhythm Dance', 'Free Dance',
  'Pattern Dance', 'Short Dance', 'Lyhytohjelma', 'Vapaaohjelma',
].sort((a, b) => b.length - a.length);

/** Units that are not part of the competition itself (practice, draw, …) */
const NON_COMPETITION = [
  'meeting', 'practice', 'draw', 'dinner', 'ceremony', 'opening', 'banquet',
  'kokous', 'harjoitus', 'arvonta', 'palkinto',
];

/** The category prefix of an ISU unit code (`FSKWSINGLES-ADVNOV----`) */
const CATEGORY_CODE_LENGTH = 22;

const UNIT_RE =
  /<\s*(?:[A-Za-z_][\w.-]*:)?Unit\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/\s*>|>([\s\S]*?)<\s*\/\s*(?:[A-Za-z_][\w.-]*:)?Unit\s*>)/g;
const ITEM_NAME_RE = /<\s*(?:[A-Za-z_][\w.-]*:)?ItemName\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i;
const VENUE_RE = /<\s*(?:[A-Za-z_][\w.-]*:)?VenueDescription\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i;
const ISO_DAY_RE = /^(\d{4}-\d{2}-\d{2})/;

/** Decode the five predefined entities and numeric character references */
function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, ref: string) => {
    const lower = ref.toLowerCase();
    if (lower.startsWith('#x')) return codePoint(parseInt(lower.slice(2), 16), whole);
    if (lower.startsWith('#')) return codePoint(parseInt(lower.slice(1), 10), whole);
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[lower] ?? whole;
  });
}

function codePoint(value: number, fallback: string): string {
  try {
    return String.fromCodePoint(value);
  } catch (_e) {
    return fallback;
  }
}

/** One attribute's decoded, trimmed value out of a tag's attribute text */
function attr(attrs: string, name: string): string {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? decodeXml(m[1] ?? m[2] ?? '').replace(/\s+/g, ' ').trim() : '';
}

/** `SM-NOVIISI Tytöt Lyhytohjelma` → `SM-NOVIISI Tytöt` */
function categoryOf(item: string): string {
  const lower = item.toLowerCase();
  for (const segment of SEGMENTS) {
    if (lower.endsWith(segment.toLowerCase())) {
      const rest = item.slice(0, item.length - segment.length).trim();
      if (rest) return rest;
    }
  }
  return item;
}

function isCompetitionItem(item: string): boolean {
  const lower = item.toLowerCase();
  return !NON_COMPETITION.some((word) => lower.includes(word));
}

/**
 * Summarise a DT_SCHEDULE document. Anything it cannot read is simply left
 * out, so a document without units yields empty fields rather than an error.
 */
export function summarizeScheduleXml(xml: string): ScheduleSummary {
  const groups = new Map<string, { name: string; start: string }>();
  const days: string[] = [];
  let venue = '';

  for (const m of String(xml ?? '').matchAll(UNIT_RE)) {
    const attrs = m[1] ?? '';
    const inner = m[3] ?? '';
    const itemTag = ITEM_NAME_RE.exec(inner);
    const item = itemTag ? attr(itemTag[1], 'Value') : '';
    if (!item || !isCompetitionItem(item)) continue;

    const start = attr(attrs, 'StartDate');
    const day = ISO_DAY_RE.exec(start)?.[1] ?? '';
    if (day) days.push(day);

    if (!venue) {
      const venueTag = VENUE_RE.exec(inner);
      if (venueTag) venue = attr(venueTag[1], 'VenueName');
    }

    const name = categoryOf(item);
    const code = attr(attrs, 'Code');
    const key = code.length >= CATEGORY_CODE_LENGTH ? code.slice(0, CATEGORY_CODE_LENGTH) : `name:${name}`;
    const known = groups.get(key);
    if (!known) groups.set(key, { name, start });
    else if (start && (!known.start || start < known.start)) known.start = start;
  }

  const ordered = [...groups.values()].sort((a, b) =>
    (a.start || '￿').localeCompare(b.start || '￿')
  );
  const categories: string[] = [];
  for (const { name } of ordered) {
    if (!categories.includes(name)) categories.push(name);
  }
  days.sort();
  return {
    categories,
    firstDate: days[0] ?? '',
    lastDate: days[days.length - 1] ?? '',
    venue,
  };
}

/**
 * Whether a pool file name looks like FS Manager's schedule XML
 * (`DT_SCHEDULE_FSK….xml`, also a `DT_SCHEDULE_UPDATE`).
 */
export function isScheduleXmlName(name: string): boolean {
  return /DT_SCHEDULE/i.test(name) && /\.xml$/i.test(name);
}
