"""One structured line per request — the only visibility we have in production.

App Insights is where the runtime questions get answered (is the logged IP the
FSM VM's public address? are 450s actually reaching the sender?), so the fields
below are a contract, and bodies and full header dumps are deliberately absent.
"""
import json
import logging

import fixtures
import function_app as fa
from conftest import COMPETITION_CODE, COMPETITION_ID, DEFAULT_IP, SESSION_ID, make_request

FIELDS = {"method", "ip", "origin", "environment", "session", "serial", "lastSerial",
          "code", "competitionId", "documentType", "documentCode", "documentSubtype",
          "outcome", "status", "reason", "bytes", "blobs"}


def _records(caplog):
    return [json.loads(message[len("hovtp "):])
            for message in caplog.messages if message.startswith("hovtp ")]


def test_a_stored_message_logs_every_field(table, blobs, caplog):
    with caplog.at_level(logging.INFO):
        fa._handle_hovtp(make_request(body=fixtures.DT_PDF_BODY,
                                      session_id=SESSION_ID, serial=1))

    record = _records(caplog)[-1]
    assert set(record) == FIELDS
    assert record["method"] == "POST"
    assert record["ip"] == DEFAULT_IP
    assert record["outcome"] == "quarantined"
    assert record["status"] == 200
    assert record["code"] == COMPETITION_CODE
    assert record["competitionId"] == COMPETITION_ID
    assert record["documentType"] == "DT_PDF"
    assert record["documentSubtype"] == "C08"
    assert record["serial"] == 1
    assert record["lastSerial"] == 1
    assert record["bytes"] == len(fixtures.DT_PDF_BODY)
    assert record["blobs"] == ["FSK_C08_Competition_Schedule.pdf"]


def test_the_body_is_never_logged(table, blobs, caplog):
    with caplog.at_level(logging.INFO):
        fa._handle_hovtp(make_request(body=fixtures.DT_PDF_BODY))

    assert fixtures.PDF_BASE64 not in "".join(caplog.messages)


def test_each_refusal_carries_its_own_outcome(table, blobs, caplog):
    cases = [
        (dict(body=fixtures.NOT_XML_BODY), "bad_request"),
        (dict(body=fixtures.schedule_message(competition_code="nope")), "unknown_code"),
        (dict(body=fixtures.DT_RESULT_BODY), "dropped"),
    ]
    for kwargs, expected in cases:
        caplog.clear()
        with caplog.at_level(logging.INFO):
            fa._handle_hovtp(make_request(**kwargs))
        assert _records(caplog)[-1]["outcome"] == expected


def test_a_disabled_receiver_logs_the_kill_switch(table, blobs, caplog, monkeypatch):
    monkeypatch.setenv("HOVTP_ENABLED", "0")
    with caplog.at_level(logging.INFO):
        fa._handle_hovtp(make_request(body=fixtures.DT_SCHEDULE_BODY))

    record = _records(caplog)[-1]
    assert (record["outcome"], record["status"]) == ("disabled", 503)


def test_an_unexpected_failure_is_a_500_not_a_crash(table, blobs, caplog, monkeypatch):
    monkeypatch.setattr(fa, "parse_odf", lambda body: 1 / 0)

    with caplog.at_level(logging.INFO):
        response = fa._handle_hovtp(make_request(body=fixtures.DT_SCHEDULE_BODY))

    assert response.status_code == 500
    record = _records(caplog)[-1]
    assert (record["outcome"], record["reason"]) == ("error", "internal error")
