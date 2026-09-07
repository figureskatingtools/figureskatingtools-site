"""What ends up in the competition file pool, and under what name.

A PDF arrives wrapped in ODF. Storing the wrapper would put an unopenable .xml
next to every report, so only the decoded PDF is kept — and its name is rebuilt
from the ODF attributes plus the report title, because FSM's DocumentCode alone
('FSK', or a 34-character padded segment code) tells a human nothing.
"""
import base64

import fixtures
import function_app as fa
from conftest import COMPETITION_ID, DEFAULT_IP, head, make_request

PENDING = f"{COMPETITION_ID}/fsm-pending/{DEFAULT_IP}/"


def _post(**kwargs):
    kwargs.setdefault("body", fixtures.DT_SCHEDULE_BODY)
    return fa._handle_hovtp(make_request(**kwargs))


def _only(blobs):
    assert len(blobs.blobs) == 1, sorted(blobs.blobs)
    return next(iter(blobs.blobs.values()))


# ── DT_PDF ────────────────────────────────────────────────────────────────────

def test_dt_pdf_stores_only_the_decoded_pdf(table, blobs):
    response = _post(body=fixtures.DT_PDF_BODY)

    assert response.status_code == 200
    blob = _only(blobs)
    assert blob.name == PENDING + "FSK-------------------------------_CompetitionSchedule.pdf"
    assert blob.data == fixtures.PDF_BYTES
    assert blob.content_type == "application/pdf"


def test_dt_pdf_metadata_records_the_odf_attributes_and_the_report_title(table, blobs):
    _post(body=fixtures.DT_PDF_BODY, session_id="6d4f1b9e-2c3a-4c0d-9f1e-0a1b2c3d4e5f",
          serial=7)

    metadata = _only(blobs).metadata
    assert metadata["source"] == "hovtp"
    assert metadata["sourceTool"] == "hovtp"
    assert metadata["uploadedBy"] == f"hovtp:{DEFAULT_IP}"
    assert metadata["hovtpIp"] == DEFAULT_IP
    assert metadata["hovtpOrigin"] == "FSM"
    assert metadata["hovtpSerial"] == "7"
    assert metadata["hovtpSessionId"] == "6d4f1b9e-2c3a-4c0d-9f1e-0a1b2c3d4e5f"
    assert metadata["hovtpDataType"] == "ODF"
    assert metadata["hovtpEnvironment"] == "Test"
    assert metadata["hovtpVenue"] == "HTL"
    assert metadata["hovtpDiscipline"] == "FSK"
    assert metadata["receivedUtc"].endswith("Z")
    assert metadata["odf_documenttype"] == "DT_PDF"
    assert metadata["odf_documentsubtype"] == "C08"
    assert metadata["odf_competitioncode"] == fixtures.COMPETITION_CODE_RAW
    assert metadata["report_title"] == "Competition Schedule"


def test_the_segment_report_is_named_like_fs_managers_own_export(table, blobs):
    """Judge Papers parses `<padded RSC>_<CompactTitle>.pdf`, FS Manager's export shape."""
    _post(body=fixtures.DT_PDF_SEGMENT_BODY)

    assert _only(blobs).name == (
        PENDING + "FSKWSINGLES-ADVNOV----FNL-000100--_SegmentResults.pdf")


def test_a_pdf_without_a_report_title_falls_back_to_code_and_subtype(table, blobs):
    _post(body=fixtures.pdf_message(report_title=""))

    assert _only(blobs).name == PENDING + "FSK-------------------------------_C08.pdf"


def test_invalid_base64_is_451(table, blobs):
    response = _post(body=fixtures.pdf_message(pdf_base64="not base64 @@@@"))

    assert response.status_code == 451
    assert head(response, "X-HOVTP-Error-Reason") == "PDFData is not valid base64"
    assert blobs.blobs == {}


def test_a_payload_that_is_not_a_pdf_is_451(table, blobs):
    response = _post(body=fixtures.pdf_message(pdf_base64=fixtures.NOT_A_PDF_BASE64))

    assert response.status_code == 451
    assert head(response, "X-HOVTP-Error-Reason") == "PDFData is not a PDF"
    assert blobs.blobs == {}


def test_a_dt_pdf_without_pdfdata_is_451(table, blobs):
    response = _post(body=fixtures.pdf_message(include_pdf_data=False))

    assert response.status_code == 451
    assert head(response, "X-HOVTP-Error-Reason") == "DT_PDF without PDFData"
    assert blobs.blobs == {}


def test_base64_split_over_lines_still_decodes(table, blobs):
    wrapped = "\n  ".join([fixtures.PDF_BASE64[:8], fixtures.PDF_BASE64[8:]])
    _post(body=fixtures.pdf_message(pdf_base64="\n  " + wrapped + "\n"))

    assert _only(blobs).data == fixtures.PDF_BYTES


def test_an_unusable_document_name_is_451(table, blobs):
    response = _post(body=fixtures.pdf_message(document_code="-", document_subtype="",
                                               report_title=""))

    assert response.status_code == 451
    assert head(response, "X-HOVTP-Error-Reason") == "unusable document name"


# ── ODF XML ───────────────────────────────────────────────────────────────────

def test_an_odf_message_is_stored_as_the_raw_xml_it_arrived_as(table, blobs):
    _post(body=fixtures.DT_PARTIC_BODY)

    blob = _only(blobs)
    assert blob.name == PENDING + "DT_PARTIC_FSK-------------------------------.xml"
    assert blob.data == fixtures.DT_PARTIC_BODY
    assert blob.content_type == "application/xml"


def test_a_resent_bulk_message_overwrites_in_place(table, blobs):
    _post(body=fixtures.DT_SCHEDULE_BODY)
    _post(body=fixtures.DT_SCHEDULE_BODY)

    assert len(blobs.blobs) == 1
    assert [call for call in blobs.calls if call[0] == "upload_blob"] == [
        ("upload_blob", PENDING + "DT_SCHEDULE_FSK-------------------------------.xml"),
    ] * 2


def test_an_update_message_is_stamped_so_increments_are_kept(table, blobs):
    _post(body=fixtures.DT_SCHEDULE_UPDATE_BODY)

    assert _only(blobs).name == (
        PENDING + "DT_SCHEDULE_UPDATE_FSK-------------------------------"
                  "_20260901213419798.xml")


def test_an_update_without_a_timestamp_falls_back_to_the_serial(table, blobs):
    body = fixtures.odf({
        "CompetitionCode": fixtures.COMPETITION_CODE_RAW,
        "DocumentCode": "FSK",
        "DocumentType": "DT_SCHEDULE_UPDATE",
    }, "<Competition/>")

    _post(body=body, session_id="6d4f1b9e-2c3a-4c0d-9f1e-0a1b2c3d4e5f", serial=12)

    assert _only(blobs).name == PENDING + "DT_SCHEDULE_UPDATE_FSK_12.xml"


def test_a_document_subcode_is_part_of_the_name(table, blobs):
    body = fixtures.odf({
        "CompetitionCode": fixtures.COMPETITION_CODE_RAW,
        "DocumentCode": "FSK",
        "DocumentSubcode": "SEG1",
        "DocumentType": "DT_SCHEDULE",
    }, "<Competition/>")

    _post(body=body)

    assert _only(blobs).name == PENDING + "DT_SCHEDULE_FSK_SEG1.xml"


# ── metadata legality ─────────────────────────────────────────────────────────

def test_metadata_keys_are_legal_and_capped(table, blobs):
    attributes = {"CompetitionCode": fixtures.COMPETITION_CODE_RAW,
                  "DocumentCode": "FSK", "DocumentType": "DT_SCHEDULE"}
    attributes.update({f"Attr{index:02d}": f"value-{index}" for index in range(30)})
    headers = {f"X-Odf-Extra-{index:02d}": "x" * 40 for index in range(30)}
    headers["X-Odf-Very-Long"] = "y" * 5000

    _post(body=fixtures.odf(attributes, "<Competition/>"), headers=headers)

    metadata = _only(blobs).metadata
    assert all(fa._METADATA_KEY_RE.match(key) for key in metadata)
    assert all(value.isascii() and len(value) <= 256 for value in metadata.values())
    assert len(metadata) <= 12 + fa.MAX_EXTRA_METADATA_KEYS
    assert sum(len(k) + len(v) for k, v in metadata.items()) <= fa.MAX_METADATA_BYTES


def test_non_ascii_metadata_is_transliterated_not_dropped(table, blobs):
    body = fixtures.odf({
        "CompetitionCode": fixtures.COMPETITION_CODE_RAW,
        "DocumentCode": "FSK",
        "DocumentType": "DT_SCHEDULE",
        "VenueName": "Jyväskylä",
    }, "<Competition/>")

    _post(body=body)

    assert _only(blobs).metadata["odf_venuename"].startswith("Jyv")


def test_x_odf_headers_are_recorded_but_the_body_wins_the_code(table, blobs):
    response = _post(body=fixtures.DT_SCHEDULE_BODY,
                     headers={"X-ODF-CompetitionCode": "SOME-OTHER-CUP"})

    assert response.status_code == 200
    blob = _only(blobs)
    # The body's code decided where the file went...
    assert blob.name.startswith(f"{COMPETITION_ID}/")
    # ...but the header is preserved for forensics.
    assert blob.metadata["x_odf_competitioncode"] == "SOME-OTHER-CUP"


def test_infrastructure_headers_never_reach_the_metadata(table, blobs):
    _post(headers={"X-ARR-SSL": "yes", "X-MS-Request-Id": "abc",
                   "X-Forwarded-Proto": "https"})

    metadata = _only(blobs).metadata
    assert not [key for key in metadata if key.startswith(("x_arr", "x_ms", "x_forwarded"))]


def test_the_stored_pdf_is_byte_identical_to_the_base64_payload(table, blobs):
    _post(body=fixtures.DT_PDF_BODY)

    assert _only(blobs).data == base64.b64decode(fixtures.PDF_BASE64, validate=True)
