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

    record = [json.loads(message[len("hovtp "):])
              for message in caplog.messages if message.startswith("hovtp ")][-1]
    assert record["outcome"] == "forbidden"
    assert record["status"] == 403
    assert SECRET not in json.dumps(record)
