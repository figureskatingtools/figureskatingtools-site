"""The shared-secret gate in front of POST and OPTIONS /api/v1/hovtp.

FS Manager now reaches the listener through Azure Front Door + WAF -> API
Management instead of posting straight at the Function App, and the listener's
whole trust model is per-(competition, source IP) read out of X-Forwarded-For.
Counting proxy hops only means something if the request really came through
those proxies: the raw `func-fs-hovtp-*.azurewebsites.net` hostname stays
internet-reachable, so without a secret anyone who found it could forge the
chain and post as an already-accepted FSM address. APIM injects
`X-Proxy-Secret` on every forwarded request; this is the check on it.

Failing OPEN when `PROXY_SHARED_SECRET` is unset is deliberate and
load-bearing, not an oversight: `func start` locally, this suite, the window
between deploying this code and setting the app setting, and prod (which has no
publishing layer in front of it yet) all run without the secret, and a closed
gate there would silently lose a competition's feed.
"""
import json
import logging

import azure.functions as func

import fixtures
import function_app as fa
from conftest import (COMPETITION_ID, DEFAULT_IP, SESSION_ID, head, make_request,
                      mandatory_headers_present, seed_session, source_row)

SECRET = "0f4a2b6c8d1e3f507192a3b4c5d6e7f8"

PENDING = f"{COMPETITION_ID}/fsm-pending/{DEFAULT_IP}/"
SCHEDULE_BLOB = PENDING + "DT_SCHEDULE_FSK-------------------------------.xml"


def _post(**kwargs):
    kwargs.setdefault("body", fixtures.DT_SCHEDULE_BODY)
    return fa._handle_hovtp(make_request(**kwargs))


def _record(caplog):
    return [json.loads(message[len("hovtp "):])
            for message in caplog.messages if message.startswith("hovtp ")][-1]


# ── unset: the gate is not there at all ───────────────────────────────────────

def test_a_message_is_accepted_when_no_secret_is_configured(table, blobs):
    response = _post()

    assert response.status_code == 200
    assert list(blobs.blobs) == [SCHEDULE_BLOB]


def test_an_unexpected_header_is_ignored_when_no_secret_is_configured(table, blobs):
    # A sender that keeps the header after we clear the app setting (or prod,
    # which never had a publishing layer) must not be refused for having it.
    response = _post(headers={"X-Proxy-Secret": "whatever-this-is"})

    assert response.status_code == 200
    assert list(blobs.blobs) == [SCHEDULE_BLOB]


def test_an_empty_secret_setting_is_the_same_as_unset(table, blobs, monkeypatch):
    monkeypatch.setenv("PROXY_SHARED_SECRET", "   ")

    assert _post().status_code == 200


# ── set: the header decides ───────────────────────────────────────────────────

def test_the_matching_header_is_accepted(table, blobs, monkeypatch):
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)

    response = _post(headers={"X-Proxy-Secret": SECRET})

    assert response.status_code == 200
    assert list(blobs.blobs) == [SCHEDULE_BLOB]
    assert source_row(table) is not None


def test_the_header_name_is_matched_case_insensitively(table, blobs, monkeypatch):
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)

    assert _post(headers={"x-proxy-secret": SECRET}).status_code == 200


def test_a_missing_header_is_403_and_writes_nothing(table, blobs, monkeypatch):
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)

    response = _post()

    assert response.status_code == 403
    assert head(response, "X-HOVTP-Error-Reason") == "forbidden"
    assert mandatory_headers_present(response)
    assert blobs.blobs == {}
    assert table.writes() == []


def test_a_wrong_header_is_403_and_writes_nothing(table, blobs, monkeypatch):
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)

    response = _post(headers={"X-Proxy-Secret": SECRET[:-1] + "0"})

    assert response.status_code == 403
    assert head(response, "X-HOVTP-Error-Reason") == "forbidden"
    assert blobs.blobs == {}
    assert table.writes() == []


def test_the_body_is_never_parsed_when_the_secret_is_wrong(table, blobs, monkeypatch):
    # The gate runs before anything reads the message, so a forged sender
    # cannot use the error text to probe which competitions exist.
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)

    response = _post(body=b"not xml at all", headers={"X-Proxy-Secret": "nope"})

    assert response.status_code == 403
    assert head(response, "X-HOVTP-Error-Reason") == "forbidden"


# ── OPTIONS is gated too ──────────────────────────────────────────────────────

def test_options_without_the_secret_is_403_and_leaks_no_cursor(table, blobs, monkeypatch):
    # OPTIONS answers with the session's last accepted serial, which is exactly
    # what a sender needs to resynchronise — so the probe is gated as well.
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)
    seed_session(table, last_serial=42)

    response = fa._handle_hovtp(make_request("OPTIONS", session_id=SESSION_ID))

    assert response.status_code == 403
    assert head(response, "X-HOVTP-Last-Serial-Number") == "0"
    assert mandatory_headers_present(response)


def test_options_with_the_secret_still_reports_the_cursor(table, blobs, monkeypatch):
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)
    seed_session(table, last_serial=42)

    response = fa._handle_hovtp(make_request(
        "OPTIONS", session_id=SESSION_ID, headers={"X-Proxy-Secret": SECRET}))

    assert response.status_code == 200
    assert head(response, "X-HOVTP-Last-Serial-Number") == "42"


# ── what the gate must not touch ──────────────────────────────────────────────

def test_health_is_never_gated(monkeypatch):
    # The deploy workflow smoke-checks /api/health before the secret can
    # possibly be known to it.
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)

    request = func.HttpRequest(method="GET", url="https://func-fs-hovtp.invalid/api/health",
                               headers={}, params={}, route_params={}, body=b"")

    assert fa.health(request).status_code == 200


def test_the_secret_never_reaches_blob_metadata(table, blobs, monkeypatch):
    # Every non-infrastructure `X-*` header is stored as blob metadata, so the
    # header had to be added to _INFRA_HEADER_PREFIXES or our own credential
    # would be written into the competition's file pool.
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)

    _post(headers={"X-Proxy-Secret": SECRET})

    metadata = blobs.blobs[SCHEDULE_BLOB].metadata
    assert not any("proxy" in key.lower() for key in metadata)
    assert SECRET not in json.dumps(metadata)


def test_the_refusal_is_logged_as_forbidden(table, blobs, monkeypatch, caplog):
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)

    with caplog.at_level(logging.INFO):
        _post(headers={"X-Proxy-Secret": "nope"})

    record = _record(caplog)
    assert record["outcome"] == "forbidden"
    assert record["status"] == 403
    assert SECRET not in json.dumps(record)


# ── the audit field: measuring the gate before it is enforced ─────────────────
# `proxyHeader` answers "how much traffic would a set secret reject, and from
# where?" while PROXY_SHARED_SECRET is still unset in both environments. That
# only works if the field is on the requests that SUCCEED — a field that only
# ever appears on refusals measures nothing, because nothing is refused yet.


def test_the_audit_field_is_absent_when_no_header_and_no_secret(table, blobs, caplog):
    with caplog.at_level(logging.INFO):
        response = _post()

    assert response.status_code == 200
    assert _record(caplog)["proxyHeader"] == "absent"


def test_the_audit_field_is_present_when_the_header_arrives_with_no_secret_set(
        table, blobs, caplog):
    # The state that says the publishing layer is in front of this caller, so
    # turning the secret on would not cut it off. Nothing is configured to
    # compare against, so even an unrecognised value counts as present.
    with caplog.at_level(logging.INFO):
        response = _post(headers={"X-Proxy-Secret": SECRET})

    assert response.status_code == 200
    record = _record(caplog)
    assert record["proxyHeader"] == "present"
    assert SECRET not in json.dumps(record)


def test_the_audit_field_is_present_on_an_accepted_proxied_request(table, blobs, caplog,
                                                                   monkeypatch):
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)

    with caplog.at_level(logging.INFO):
        response = _post(headers={"X-Proxy-Secret": SECRET})

    assert response.status_code == 200
    record = _record(caplog)
    assert record["proxyHeader"] == "present"
    assert record["outcome"] == "quarantined"
    assert SECRET not in json.dumps(record)


def test_a_wrong_header_is_logged_as_a_mismatch_naming_the_caller(table, blobs, caplog,
                                                                  monkeypatch):
    # The refusal used to log blank origin/session/ip because the gate runs
    # before the headers are parsed — which made a 403 useless for working out
    # who the caller was. Refusing still happens before the body and before any
    # storage call; only the identification moved earlier.
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)

    with caplog.at_level(logging.INFO):
        response = _post(headers={"X-Proxy-Secret": "nope"},
                         session_id=SESSION_ID, serial=7)

    assert response.status_code == 403
    record = _record(caplog)
    assert record["proxyHeader"] == "mismatch"
    assert record["outcome"] == "forbidden"
    assert record["ip"] == DEFAULT_IP
    assert record["origin"] == "FSM"
    assert record["environment"] == "Test"
    assert record["session"] == SESSION_ID
    assert record["serial"] == 7
    assert SECRET not in json.dumps(record)
    # Identifying the caller must not have cost us the refusal's guarantees.
    assert blobs.blobs == {}
    assert table.writes() == []


def test_a_missing_header_is_logged_as_absent_on_a_refusal(table, blobs, caplog,
                                                           monkeypatch):
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)

    with caplog.at_level(logging.INFO):
        response = _post(session_id=SESSION_ID, serial=7)

    assert response.status_code == 403
    record = _record(caplog)
    assert record["proxyHeader"] == "absent"
    assert record["ip"] == DEFAULT_IP
    assert record["session"] == SESSION_ID
    assert SECRET not in json.dumps(record)


def test_garbage_headers_still_refuse_with_403_and_not_500(table, blobs, caplog,
                                                           monkeypatch):
    # Parsing the caller's headers for the log must not change the answer: a
    # session id that is not a UUID is a 400 in the normal path, and an
    # X-Forwarded-For with no address in it makes client_ip raise a 500. On the
    # refusal path both are swallowed — an unidentified caller is exactly the
    # one likely to send nonsense, and a 500 would hide the refusal.
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)

    with caplog.at_level(logging.INFO):
        response = _post(body=b"\x00\x01 not xml",
                         client_ip=None,
                         headers={"X-Proxy-Secret": "nope",
                                  "X-HOVTP-Session-Id": "not-a-uuid",
                                  "X-HOVTP-Serial-Number": "not-a-number",
                                  "X-Forwarded-For": "not-an-address"})

    assert response.status_code == 403
    assert head(response, "X-HOVTP-Error-Reason") == "forbidden"
    record = _record(caplog)
    assert record["proxyHeader"] == "mismatch"
    assert record["outcome"] == "forbidden"
    assert record["status"] == 403
    # Nothing parses, but the raw headers are still evidence about the caller,
    # so each is recovered on its own rather than lost with the parse.
    assert record["origin"] == "FSM"
    assert record["session"] == "not-a-uuid"
    assert record["serial"] is None      # typed field, never a raw string
    assert record["ip"] == ""            # client_ip found no address at all
    assert SECRET not in json.dumps(record)
    assert blobs.blobs == {}
    assert table.writes() == []


def test_one_bad_header_does_not_blank_the_others(table, blobs, caplog, monkeypatch):
    # parse_hovtp_headers is all-or-nothing, so a single malformed field used to
    # cost the whole identity: a refused caller with a perfectly good session id
    # and a non-numeric serial logged session "". That is the common shape of a
    # misconfigured sender, and the session id is the most identifying thing FS
    # Manager sends — exactly what a refusal has to keep hold of.
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)
    session = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"

    with caplog.at_level(logging.INFO):
        response = _post(body=b"<OdfBody/>",
                         headers={"X-Proxy-Secret": "nope",
                                  "X-HOVTP-Session-Id": session,
                                  "X-HOVTP-Serial-Number": "not-a-number"})

    assert response.status_code == 403
    record = _record(caplog)
    assert record["session"] == session      # kept despite the bad serial
    assert record["origin"] == "FSM"
    assert record["serial"] is None
    assert SECRET not in json.dumps(record)
    assert blobs.blobs == {}
    assert table.writes() == []


def test_options_refusals_also_name_the_caller(table, blobs, caplog, monkeypatch):
    monkeypatch.setenv("PROXY_SHARED_SECRET", SECRET)
    seed_session(table, last_serial=42)

    with caplog.at_level(logging.INFO):
        response = fa._handle_hovtp(make_request("OPTIONS", session_id=SESSION_ID))

    assert response.status_code == 403
    record = _record(caplog)
    # A status request carries the session id WITHOUT a serial; parsing it for
    # the log has to allow that or the id would be lost from the record.
    assert record["proxyHeader"] == "absent"
    assert record["session"] == SESSION_ID
    assert record["ip"] == DEFAULT_IP
