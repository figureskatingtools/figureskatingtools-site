"""Body parsing, size limits and competition-code resolution.

The listener is body-first: the URL carries no competition code, so the code is
read from `OdfBody/@CompetitionCode`, and only if that is missing from an
`X-*-Competition*` header (the HTTP headers were never captured from a real FSM
install, so they are the last resort rather than the first).
"""
import fixtures
import function_app as fa
from conftest import COMPETITION_CODE, COMPETITION_ID, head, make_request, seed_competition


def _post(**kwargs):
    kwargs.setdefault("body", fixtures.DT_SCHEDULE_BODY)
    return fa._handle_hovtp(make_request(**kwargs))


# ── the body itself ───────────────────────────────────────────────────────────

def test_a_non_xml_body_is_400(table, blobs):
    response = _post(body=fixtures.NOT_XML_BODY)

    assert response.status_code == 400
    assert head(response, "X-HOVTP-Error-Reason") == "body is not valid XML"
    assert blobs.blobs == {}


def test_a_root_that_is_not_odfbody_is_400(table, blobs):
    response = _post(body=fixtures.NOT_ODF_BODY)

    assert response.status_code == 400
    assert head(response, "X-HOVTP-Error-Reason") == "body is not an ODF message"


def test_an_empty_body_is_400(table, blobs):
    response = _post(body=b"")

    assert response.status_code == 400
    assert head(response, "X-HOVTP-Error-Reason") == "empty body"


def test_a_body_cut_inside_the_root_start_tag_is_400(table, blobs):
    # Precisely what this pins down: 60 bytes lands mid-`<OdfBody …`, so the
    # root start tag never completes and the parser never sees a root at all.
    # It is NOT evidence that truncated bodies are rejected in general — see the
    # test below for the half of the range that is accepted.
    response = _post(body=fixtures.DT_SCHEDULE_BODY[:60])

    assert response.status_code == 400
    assert head(response, "X-HOVTP-Error-Reason") == "body is not valid XML"
    assert blobs.blobs == {}


def test_a_body_cut_after_the_root_start_tag_is_accepted_today(table, blobs):
    # KNOWN GAP, deliberately left as it is: once the root start tag has closed,
    # `parse_odf` has everything it needs for a non-PDF document and breaks out
    # of `iterparse` without calling `close()`, so the truncation is never
    # detected and the half-message is stored verbatim. This test records that
    # behaviour rather than endorsing it — FSM truncating a stream mid-send
    # would leave an unusable XML in the pool. Change it together with
    # `parse_odf`, not on its own.
    response = _post(body=fixtures.DT_SCHEDULE_BODY[:300])

    assert response.status_code == 200
    assert len(blobs.blobs) == 1


def test_an_oversized_content_length_is_413_before_the_body_is_read(table, blobs):
    response = _post(content_length=fa.MAX_MESSAGE_SIZE + 1)

    assert response.status_code == 413
    assert head(response, "X-HOVTP-Error-Reason") == "message too large"
    # Nothing was looked up, so nothing was paid for either.
    assert table.calls == []
    assert blobs.blobs == {}


def test_a_bogus_content_length_is_ignored(table, blobs):
    response = _post(content_length="not-a-number")

    assert response.status_code == 200


def test_an_oversized_body_is_413(table, blobs, monkeypatch):
    monkeypatch.setattr(fa, "MAX_MESSAGE_SIZE", 32)

    response = _post(body=fixtures.DT_SCHEDULE_BODY)

    assert response.status_code == 413
    assert blobs.blobs == {}


def test_a_namespaced_odfbody_is_parsed(table, blobs):
    response = _post(body=fixtures.DT_SCHEDULE_NAMESPACED_BODY)

    assert response.status_code == 200
    assert len(blobs.blobs) == 1


# ── competition code resolution ───────────────────────────────────────────────

def test_the_code_comes_from_the_body_attribute(table, blobs):
    response = _post()

    assert response.status_code == 200
    assert list(blobs.blobs)[0].startswith(f"{COMPETITION_ID}/fsm-pending/")


def test_the_raw_capture_code_normalizes_to_the_code_row_key(table, blobs):
    # 'YL110926HTL' on the wire, 'yl110926htl' as the CODE RowKey.
    assert fa.normalize_code(fixtures.COMPETITION_CODE_RAW) == COMPETITION_CODE

    response = _post()

    assert response.status_code == 200
    assert ("CODE", COMPETITION_CODE) in table.rows


def test_a_second_competition_is_told_apart_by_the_body_code(table, blobs):
    seed_competition(table, code="other-cup", competition_id="0000-other")

    response = _post(body=fixtures.schedule_message(competition_code="Other Cup"))

    assert response.status_code == 200
    assert list(blobs.blobs)[0].startswith("0000-other/fsm-pending/")


def test_a_header_is_the_last_resort(table, blobs):
    response = _post(body=fixtures.DT_SCHEDULE_NO_CODE_BODY,
                     headers={"X-ODF-CompetitionCode": fixtures.COMPETITION_CODE_RAW})

    assert response.status_code == 200
    assert list(blobs.blobs)[0].startswith(f"{COMPETITION_ID}/fsm-pending/")


def test_no_code_anywhere_is_451(table, blobs):
    response = _post(body=fixtures.DT_SCHEDULE_NO_CODE_BODY)

    assert response.status_code == 451
    assert head(response, "X-HOVTP-Error-Reason") == "no competition code in message"
    assert blobs.blobs == {}


def test_an_unknown_code_is_451_and_stores_nothing(table, blobs):
    response = _post(body=fixtures.schedule_message(competition_code="never-heard-of-it"))

    assert response.status_code == 451
    assert head(response, "X-HOVTP-Error-Reason") == "unknown competition code never-heard-of-it"
    assert blobs.blobs == {}
    assert table.rows_in(fa.PK_HOVTP_SOURCE) == {}


def test_a_code_row_pointing_nowhere_is_451(table, blobs):
    table.create_entity({"PartitionKey": fa.PK_CODE, "RowKey": "orphan",
                         "CompetitionId": "missing-guid"})

    response = _post(body=fixtures.schedule_message(competition_code="orphan"))

    assert response.status_code == 451
    assert blobs.blobs == {}


def test_a_deleted_competition_is_451(table, blobs):
    table.rows[(fa.PK_COMPETITION, COMPETITION_ID)]["Status"] = fa.STATUS_DELETED

    response = _post()

    assert response.status_code == 451
    assert head(response, "X-HOVTP-Error-Reason") == f"competition {COMPETITION_CODE} is deleted"
    assert blobs.blobs == {}
