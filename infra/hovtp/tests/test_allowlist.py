"""The document-type allowlist.

FSM re-sends DT_RESULT after every single skater. Storing those would bury the
handful of files an official actually wants under thousands of revisions, so
anything off the allowlist is answered 200 (the transport was fine — refusing
would make FSM retry forever) and dropped. The one thing that still happens is
the trust row: a brand-new IP whose first message is a result must still surface
in the UI, or the operator never gets the chance to accept it.
"""
import fixtures
import function_app as fa
from conftest import (COMPETITION_ID, DEFAULT_IP, SESSION_ID, head, make_request,
                      seed_source, session_row, source_row)


def _post(**kwargs):
    kwargs.setdefault("body", fixtures.DT_RESULT_BODY)
    return fa._handle_hovtp(make_request(**kwargs))


def test_dt_result_is_answered_200_and_stored_nowhere(table, blobs):
    response = _post()

    assert response.status_code == 200
    assert head(response, "X-HOVTP-Error-Reason") is None
    assert blobs.blobs == {}


def test_dt_result_from_an_unknown_ip_still_creates_the_pending_source(table, blobs):
    _post()

    row = source_row(table)
    assert row["Status"] == "pending"
    assert row["LastDocumentType"] == "DT_RESULT"
    assert row["MessageCount"] == 1
    # ...but nothing is quarantined, so the counters stay at zero.
    assert row["PendingCount"] == 0
    assert row["PendingBytes"] == 0


def test_dt_result_commits_the_serial_so_the_feed_keeps_flowing(table, blobs):
    _post(session_id=SESSION_ID, serial=1)

    assert session_row(table)["LastSerial"] == 1
    assert head(_post(session_id=SESSION_ID, serial=1), "X-HOVTP-Last-Serial-Number") == "1"


def test_dt_result_does_not_downgrade_an_accepted_source(table, blobs):
    seed_source(table, status="accepted", accepted_until="2099-01-01T00:00:00Z",
                pending_count=3, pending_bytes=300)

    _post()

    row = source_row(table)
    assert row["Status"] == "accepted"
    assert row["PendingCount"] == 3
    assert row["PendingBytes"] == 300
    assert row["MessageCount"] == 2
    assert row["LastDocumentType"] == "DT_RESULT"


def test_the_allowlist_can_be_widened_by_setting(table, blobs, monkeypatch):
    monkeypatch.setenv("HOVTP_ALLOWED_DOCUMENT_TYPES", "DT_RESULT")

    response = _post()

    assert response.status_code == 200
    assert list(blobs.blobs) == [
        f"{COMPETITION_ID}/fsm-pending/{DEFAULT_IP}/"
        "DT_RESULT_FSKWSINGLES-ADVNOV----FNL-000100--.xml"
    ]
    assert source_row(table)["PendingCount"] == 1


def test_narrowing_the_allowlist_drops_a_default_type(table, blobs, monkeypatch):
    monkeypatch.setenv("HOVTP_ALLOWED_DOCUMENT_TYPES", "DT_PDF")

    response = _post(body=fixtures.DT_SCHEDULE_BODY)

    assert response.status_code == 200
    assert blobs.blobs == {}


def test_the_default_allowlist_is_the_documented_five():
    assert fa._allowed_document_types() == {
        "DT_PDF", "DT_PARTIC", "DT_PARTIC_TEAMS", "DT_SCHEDULE", "DT_SCHEDULE_UPDATE",
    }
