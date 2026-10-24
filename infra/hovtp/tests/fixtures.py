"""ODF message bodies, shaped after the real FS Manager captures.

Competition `YL110926HTL` (Youth League, Helsinki, 11.09.2026). The attribute
sets and element nesting are copied from the captures; only the PDF payload is
shrunk to the smallest possible valid file, `%PDF-1.4\n%%EOF`, so the fixtures
stay readable.

Two facts these fixtures exist to pin down:

  * the competition code lives ONLY on `OdfBody` — the `<Competition>` element
    carries no Code attribute, so a parser that looked there would find nothing;
  * a PDF arrives as an ODF message (`DocumentType="DT_PDF"`), with the report
    code in `DocumentSubtype`, the human title in
    `ExtendedInfo Code="REPORT_TITLE"` and the file base64 in `<PDFData>`.
"""

PDF_BASE64 = "JVBERi0xLjQKJSVFT0Y="
PDF_BYTES = b"%PDF-1.4\n%%EOF"
NOT_A_PDF_BASE64 = "SnVzdCBhIHRleHQgZmlsZSwgbm90IGEgUERGIGF0IGFsbCEh"

COMPETITION_CODE_RAW = "YL110926HTL"


def odf(attributes: dict, inner: str = "") -> bytes:
    """`<OdfBody …>` with the given attributes and body, as FSM would send it."""
    rendered = " ".join(f'{key}="{value}"' for key, value in attributes.items())
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        f"<OdfBody {rendered}>{inner}</OdfBody>\n"
    ).encode("utf-8")


def pdf_message(*, document_code="FSK-------------------------------", document_subtype="C08",
                report_title="Competition Schedule", pdf_base64=PDF_BASE64,
                include_pdf_data=True, competition_code=COMPETITION_CODE_RAW) -> bytes:
    inner = (
        "<Competition>"
        "<ExtendedInfos>"
        '<ExtendedInfo Code="REPORT_ORDER" Value="1"/>'
        f'<ExtendedInfo Code="REPORT_TITLE" Value="{report_title}"/>'
        "</ExtendedInfos>"
        + (f"<PDFData>{pdf_base64}</PDFData>" if include_pdf_data else "")
        + "</Competition>"
    )
    return odf({
        "CompetitionCode": competition_code,
        "DocumentCode": document_code,
        "DocumentType": "DT_PDF",
        "DocumentSubtype": document_subtype,
        "Version": "1",
        "FeedFlag": "P",
        "Date": "2026-09-01",
        "Time": "213419798",
        "LogicalDate": "2026-09-01",
        "Source": "FSKFSK1",
    }, inner)


# The C08 competition-schedule PDF: the padded discipline-level DocumentCode, no segment.
DT_PDF_BODY = pdf_message()

# The C73A1 segment-results PDF: the long padded segment DocumentCode.
DT_PDF_SEGMENT_BODY = pdf_message(
    document_code="FSKWSINGLES-ADVNOV----FNL-000100--",
    document_subtype="C73A1",
    report_title="Segment Results",
)

# Re-sent after every skater — the message the allowlist exists to drop.
DT_RESULT_BODY = odf({
    "CompetitionCode": COMPETITION_CODE_RAW,
    "DocumentCode": "FSKWSINGLES-ADVNOV----FNL-000100--",
    "DocumentType": "DT_RESULT",
    "Version": "1",
    "ResultStatus": "LIVE",
    "FeedFlag": "P",
    "Date": "2026-09-01",
    "Time": "213419798",
    "LogicalDate": "2026-09-01",
    "Source": "FSKFSK1",
}, "<Competition><Result/></Competition>")

DT_PARTIC_BODY = odf({
    "CompetitionCode": COMPETITION_CODE_RAW,
    "DocumentCode": "FSK-------------------------------",
    "DocumentType": "DT_PARTIC",
    "Version": "1",
    "FeedFlag": "P",
    "Date": "2026-09-01",
    "Time": "180000000",
    "LogicalDate": "2026-09-01",
    "Source": "FSKFSK1",
}, "<Competition><Participant Code=\"1234567\"/></Competition>")

def schedule_message(*, competition_code=COMPETITION_CODE_RAW) -> bytes:
    """A DT_SCHEDULE message for an arbitrary competition code."""
    return odf({
        "CompetitionCode": competition_code,
        "DocumentCode": "FSK-------------------------------",
        "DocumentType": "DT_SCHEDULE",
        "Version": "1",
        "FeedFlag": "P",
        "Date": "2026-09-01",
        "Time": "180500000",
        "LogicalDate": "2026-09-01",
        "Source": "FSKFSK1",
    }, "<Competition><Session Code=\"FSKWSINGLES\"/></Competition>")


DT_SCHEDULE_BODY = schedule_message()

DT_SCHEDULE_UPDATE_BODY = odf({
    "CompetitionCode": COMPETITION_CODE_RAW,
    "DocumentCode": "FSK-------------------------------",
    "DocumentType": "DT_SCHEDULE_UPDATE",
    "Version": "2",
    "FeedFlag": "P",
    "Date": "2026-09-01",
    "Time": "213419798",
    "LogicalDate": "2026-09-01",
    "Source": "FSKFSK1",
}, "<Competition><Session Code=\"FSKWSINGLES\"/></Competition>")

# Same message with a default namespace declared — FSM installations differ, and
# the parser must not care.
DT_SCHEDULE_NAMESPACED_BODY = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<OdfBody xmlns="http://www.swisstiming.com/odf" '
    f'CompetitionCode="{COMPETITION_CODE_RAW}" '
    'DocumentCode="FSK-------------------------------" '
    'DocumentType="DT_SCHEDULE" Version="1" Source="FSKFSK1">'
    "<Competition/></OdfBody>\n"
).encode("utf-8")

# No CompetitionCode attribute at all: the code must come from a header.
DT_SCHEDULE_NO_CODE_BODY = odf({
    "DocumentCode": "FSK-------------------------------",
    "DocumentType": "DT_SCHEDULE",
    "Version": "1",
    "Source": "FSKFSK1",
}, "<Competition/>")

NOT_XML_BODY = b"this is not xml at all"
NOT_ODF_BODY = b'<?xml version="1.0"?><SomethingElse Foo="bar"/>'


# ── participant files with birth dates ────────────────────────────────────────
# The ODF participant shape: `BirthDate` as an attribute of `<Participant>` (the
# common form) and of a team member's `<Description>`, written with either quote
# style, plus the element form. The invented names stand in for minors' real
# ones. Each `_STRIPPED` twin is written out by hand: it is the input with only
# the birth dates gone, every other byte (spacing, quotes, order) untouched.

_PARTIC_HEAD = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    f'<OdfBody CompetitionCode="{COMPETITION_CODE_RAW}" '
    'DocumentCode="FSK-------------------------------" DocumentType="DT_PARTIC" '
    'Version="1" FeedFlag="P" Date="2026-09-01" Time="180000000" '
    'LogicalDate="2026-09-01" Source="FSKFSK1">\n'
    '  <Competition>\n'
)

DT_PARTIC_BIRTHDATES_BODY = (
    _PARTIC_HEAD
    + '    <Participant Code="1234567" Parent="1234567" Status="ACTIVE" GivenName="Aino" '
      'FamilyName="Koskinen " PrintName="KOSKINEN Aino" Gender="W" Organisation="FIN" '
      'BirthDate="2012-03-04" Current="true">\n'
      '      <Discipline Code="FSK-------------------------------">\n'
      '        <RegisteredEvent Event="FSKWSINGLES-ADVNOV----------------"/>\n'
      '      </Discipline>\n'
      '    </Participant>\n'
      "    <Participant Code='1234568' GivenName='Bertil' FamilyName='Ahlberg' "
      "birthdate = '2011-12-31' Organisation='SWE'/>\n"
      '    <Participant Code="1234569" GivenName="Cecilia" FamilyName="Lindgren">\n'
      '      <BirthDate>2013-01-15</BirthDate>\n'
      '      <!-- BirthDate="this comment is not a birth date and stays" -->\n'
      '    </Participant>\n'
      '  </Competition>\n'
      '</OdfBody>\n'
).encode("utf-8")

DT_PARTIC_BIRTHDATES_STRIPPED = (
    _PARTIC_HEAD
    + '    <Participant Code="1234567" Parent="1234567" Status="ACTIVE" GivenName="Aino" '
      'FamilyName="Koskinen " PrintName="KOSKINEN Aino" Gender="W" Organisation="FIN" '
      'Current="true">\n'
      '      <Discipline Code="FSK-------------------------------">\n'
      '        <RegisteredEvent Event="FSKWSINGLES-ADVNOV----------------"/>\n'
      '      </Discipline>\n'
      '    </Participant>\n'
      "    <Participant Code='1234568' GivenName='Bertil' FamilyName='Ahlberg' "
      "Organisation='SWE'/>\n"
      '    <Participant Code="1234569" GivenName="Cecilia" FamilyName="Lindgren">\n'
      '      \n'
      '      <!-- BirthDate="this comment is not a birth date and stays" -->\n'
      '    </Participant>\n'
      '  </Competition>\n'
      '</OdfBody>\n'
).encode("utf-8")

_TEAMS_HEAD = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<OdfBody xmlns="http://www.swisstiming.com/odf" xmlns:st="http://www.swisstiming.com/ext" '
    f'CompetitionCode="{COMPETITION_CODE_RAW}" '
    'DocumentCode="FSK-------------------------------" DocumentType="DT_PARTIC_TEAMS" '
    'Version="1" Source="FSKFSK1">\n'
    '  <Competition>\n'
    '    <Team Code="SYNCHRO0001" Organisation="BHK " Name="Blue Herons " Gender="X">\n'
    '      <RegisteredEvent Event="" />\n'
    '      <RegisteredEvent Event="FSKXSYNCHRONMLTULO----------------" />\n'
    '      <Composition>\n'
)

DT_PARTIC_TEAMS_BIRTHDATES_BODY = (
    _TEAMS_HEAD
    + '        <Athlete Code="1234567" Order="1">\n'
      '          <Description GivenName="Aino" FamilyName="Koskinen" BirthDate="2012-03-04" '
      'Gender="W"/>\n'
      '        </Athlete>\n'
      "        <Athlete Code=\"1234568\" Order=\"2\"><Description st:BirthDate='2011-12-31' "
      "GivenName='Bertil'/></Athlete>\n"
      '      </Composition>\n'
      '    </Team>\n'
      '  </Competition>\n'
      '</OdfBody>\n'
).encode("utf-8")

DT_PARTIC_TEAMS_BIRTHDATES_STRIPPED = (
    _TEAMS_HEAD
    + '        <Athlete Code="1234567" Order="1">\n'
      '          <Description GivenName="Aino" FamilyName="Koskinen" '
      'Gender="W"/>\n'
      '        </Athlete>\n'
      "        <Athlete Code=\"1234568\" Order=\"2\"><Description "
      "GivenName='Bertil'/></Athlete>\n"
      '      </Composition>\n'
      '    </Team>\n'
      '  </Competition>\n'
      '</OdfBody>\n'
).encode("utf-8")

# Not a participant file, so not touched even though it (artificially) has one.
DT_SCHEDULE_WITH_BIRTHDATE_BODY = odf({
    "CompetitionCode": COMPETITION_CODE_RAW,
    "DocumentCode": "FSK-------------------------------",
    "DocumentType": "DT_SCHEDULE",
    "Version": "1",
    "Source": "FSKFSK1",
}, '<Competition><Session Code="FSKWSINGLES" BirthDate="2012-03-04"/></Competition>')

# A participant file whose birth dates the byte-level pass cannot reach (UTF-16,
# so no ASCII pattern matches): must be refused, never stored as it came.
DT_PARTIC_UTF16_BIRTHDATES_BODY = (
    '<?xml version="1.0" encoding="utf-16"?>\n'
    f'<OdfBody CompetitionCode="{COMPETITION_CODE_RAW}" '
    'DocumentCode="FSK-------------------------------" DocumentType="DT_PARTIC" '
    'Version="1" Source="FSKFSK1"><Competition>'
    '<Participant Code="1234567" BirthDate="2012-03-04"/></Competition></OdfBody>\n'
).encode("utf-16")
