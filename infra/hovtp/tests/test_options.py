"""OPTIONS is the sender's status / keep-alive probe.

Spec §4.3 requires it to be side-effect free, which for us means a very
specific thing: it may READ the session cursor, but it must not create the
session row, must not touch a trust row and must not write a blob. FSM probes
on a timer; a probe that created rows would invent sources nobody ever sent
data from.
"""
import function_app as fa
from conftest import SESSION_ID, head, make_request, mandatory_headers_present, seed_session


def test_options_returns_200_with_the_mandatory_headers(table, blobs):
    response = fa._handle_hovtp(make_request("OPTIONS"))

    assert response.status_code == 200
    assert mandatory_headers_present(response)
    assert head(response, "X-HOVTP-Environment") == "Test"
    assert head(response, "X-HOVTP-Keep-Alive-Interval") == "60"
    assert head(response, "X-HOVTP-Error-Reason") is None


def test_options_has_no_side_effects(table, blobs):
    seed_session(table, last_serial=4)
    table.calls.clear()

    response = fa._handle_hovtp(make_request("OPTIONS", session_id=SESSION_ID))

    assert response.status_code == 200
    assert table.writes() == []
    assert blobs.blobs == {}
    assert blobs.calls == []


def test_options_reports_the_last_accepted_serial(table, blobs):
    seed_session(table, last_serial=42)

    response = fa._handle_hovtp(make_request("OPTIONS", session_id=SESSION_ID))

    assert head(response, "X-HOVTP-Last-Serial-Number") == "42"


def test_options_reports_zero_for_an_unknown_session(table, blobs):
    response = fa._handle_hovtp(make_request(
        "OPTIONS", session_id="11111111-2222-4333-8444-555555555555"))

    assert head(response, "X-HOVTP-Last-Serial-Number") == "0"


def test_options_without_a_session_reports_zero_and_reads_nothing(table, blobs):
    response = fa._handle_hovtp(make_request("OPTIONS"))

    assert head(response, "X-HOVTP-Last-Serial-Number") == "0"
    assert table.calls == []


def test_options_validates_headers(table, blobs):
    response = fa._handle_hovtp(make_request("OPTIONS", serial=3))

    assert response.status_code == 400
    assert head(response, "X-HOVTP-Error-Reason") == "session id missing"
    assert mandatory_headers_present(response)


def test_options_when_disabled_is_503_but_still_carries_the_headers(table, blobs, monkeypatch):
    monkeypatch.setenv("HOVTP_ENABLED", "false")

    response = fa._handle_hovtp(make_request("OPTIONS", session_id=SESSION_ID, serial=1))

    assert response.status_code == 503
    assert head(response, "X-HOVTP-Error-Reason") == "receiver disabled"
    assert mandatory_headers_present(response)
    assert table.writes() == []


def test_keep_alive_header_is_omitted_when_disabled(table, blobs, monkeypatch):
    monkeypatch.setenv("HOVTP_KEEP_ALIVE_SECONDS", "0")

    response = fa._handle_hovtp(make_request("OPTIONS"))

    assert head(response, "X-HOVTP-Keep-Alive-Interval") is None


def test_options_carries_the_session_id_without_a_serial_number(table, blobs):
    """Spec §4.2: the status request has a Session-Id but NO Serial-Number.

    The first deployed build answered this exact request 400 "serial number
    missing", which would have made FSM see the receiver as down forever.
    """
    seed_session(table, last_serial=7)
    table.calls.clear()

    response = fa._handle_hovtp(make_request("OPTIONS", session_id=SESSION_ID))

    assert response.status_code == 200
    assert head(response, "X-HOVTP-Last-Serial-Number") == "7"
    assert table.writes() == []


def test_options_with_a_serial_number_is_still_tolerated(table, blobs):
    seed_session(table, last_serial=7)

    response = fa._handle_hovtp(make_request("OPTIONS", session_id=SESSION_ID, serial=8))

    assert response.status_code == 200
    assert head(response, "X-HOVTP-Last-Serial-Number") == "7"
