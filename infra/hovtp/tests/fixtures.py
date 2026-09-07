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


def pdf_message(*, document_code="FSK", document_subtype="C08",
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


# The C08 competition-schedule PDF: DocumentCode "FSK", no segment.
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

DT_SCHEDULE_BODY = odf({
    "CompetitionCode": COMPETITION_CODE_RAW,
    "DocumentCode": "FSK-------------------------------",
    "DocumentType": "DT_SCHEDULE",
    "Version": "1",
    "FeedFlag": "P",
    "Date": "2026-09-01",
    "Time": "180500000",
    "LogicalDate": "2026-09-01",
    "Source": "FSKFSK1",
}, "<Competition><Session Code=\"FSKWSINGLES\"/></Competition>")

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

# No CompetitionCode attribute at all: the code must come from the path or a header.
DT_SCHEDULE_NO_CODE_BODY = odf({
    "DocumentCode": "FSK-------------------------------",
    "DocumentType": "DT_SCHEDULE",
    "Version": "1",
    "Source": "FSKFSK1",
}, "<Competition/>")

NOT_XML_BODY = b"this is not xml at all"
NOT_ODF_BODY = b'<?xml version="1.0"?><SomethingElse Foo="bar"/>'
