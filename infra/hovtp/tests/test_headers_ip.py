"""HOVTP header parsing and the client-IP derivation the trust model rests on.

The source IP *is* the identity here — FSM sends no credentials — so getting it
wrong either trusts the wrong host or re-prompts the operator forever.
"""
import pytest

import fixtures
import function_app as fa
from conftest import COMPETITION_ID, DEFAULT_IP, head, make_request, source_row


def _headers(**kwargs):
    return make_request(**kwargs).headers


# ── header parsing ────────────────────────────────────────────────────────────

def test_headers_are_case_insensitive_and_order_independent():
    request = make_request(headers={
        "x-hovtp-session-id": "6D4F1B9E-2C3A-4C0D-9F1E-0A1B2C3D4E5F",
        "X-HOVTP-SERIAL-NUMBER": "7",
        "x-HoVtP-oRiGiN": "FSM-1",
    })
    parsed = fa.parse_hovtp_headers(request.headers)

    assert parsed.session_id == "6d4f1b9e-2c3a-4c0d-9f1e-0a1b2c3d4e5f"
    assert parsed.serial == 7
    assert parsed.origin == "FSM-1"


def test_data_type_defaults_to_odf():
    request = make_request(headers={"X-HOVTP-Data-Type": ""})
    assert fa.parse_hovtp_headers(request.headers).data_type == "ODF"


def test_session_without_serial_is_400():
    with pytest.raises(fa.HovtpError) as caught:
        fa.parse_hovtp_headers(
            _headers(session_id="6d4f1b9e-2c3a-4c0d-9f1e-0a1b2c3d4e5f"))
    assert caught.value.status == 400
    assert caught.value.reason == "serial number missing"


def test_status_request_may_carry_a_session_without_a_serial():
    hdr = fa.parse_hovtp_headers(
        _headers(session_id="6d4f1b9e-2c3a-4c0d-9f1e-0a1b2c3d4e5f"), status_request=True)
    assert hdr.session_id == "6d4f1b9e-2c3a-4c0d-9f1e-0a1b2c3d4e5f"
    assert hdr.serial is None


def test_serial_without_session_is_400():
    with pytest.raises(fa.HovtpError) as caught:
        fa.parse_hovtp_headers(_headers(serial=3))
    assert caught.value.status == 400
    assert caught.value.reason == "session id missing"


def test_both_absent_is_tolerated():
    parsed = fa.parse_hovtp_headers(_headers())
    assert parsed.session_id == ""
    assert parsed.serial is None


def test_bad_uuid_is_400():
    with pytest.raises(fa.HovtpError) as caught:
        fa.parse_hovtp_headers(_headers(session_id="not-a-uuid", serial=1))
    assert (caught.value.status, caught.value.reason) == (400, "invalid session id")


@pytest.mark.parametrize("serial", ["0", "-1", "abc", "1.5", str(2 ** 64)])
def test_bad_serial_is_400(serial):
    with pytest.raises(fa.HovtpError) as caught:
        fa.parse_hovtp_headers(_headers(
            session_id="6d4f1b9e-2c3a-4c0d-9f1e-0a1b2c3d4e5f", serial=serial))
    assert (caught.value.status, caught.value.reason) == (400, "invalid serial number")


def test_max_uint64_serial_is_accepted():
    parsed = fa.parse_hovtp_headers(_headers(
        session_id="6d4f1b9e-2c3a-4c0d-9f1e-0a1b2c3d4e5f", serial=2 ** 64 - 1))
    assert parsed.serial == 2 ** 64 - 1


def test_data_layer_keeps_x_headers_but_not_infrastructure():
    parsed = fa.parse_hovtp_headers(_headers(headers={
        "X-ODF-Competition-Code": "YL110926HTL",
        "X-Odf-Version": "1",
        "X-Forwarded-Proto": "https",
        "X-ARR-SSL": "yes",
        "X-MS-Request-Id": "abc",
        "X-Azure-Ref": "def",
        "X-Client-IP": "10.0.0.1",
        "Content-Type": "application/xml",
    }))

    assert parsed.data_layer == {
        "x-odf-competition-code": "YL110926HTL",
        "x-odf-version": "1",
    }


# ── client IP ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("forwarded,expected", [
    ("203.0.113.10", "203.0.113.10"),
    ("203.0.113.10:51920", "203.0.113.10"),
    ("[2001:db8::1]:51920", "2001:db8::1"),
    ("2001:db8::1", "2001:db8::1"),
    ("[2001:db8::1]", "2001:db8::1"),
    ("fe80::1%eth0", "fe80::1"),
    ("[fe80::1%eth0]:443", "fe80::1"),
    ("2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"),
])
def test_client_ip_forms(forwarded, expected):
    assert fa.client_ip(_headers(client_ip=forwarded)) == expected


def test_last_forwarded_entry_wins_by_default():
    # App Service APPENDS the socket peer, so the last entry is the only one we
    # did not let the caller choose.
    headers = _headers(client_ip="1.2.3.4, 5.6.7.8, 203.0.113.10")
    assert fa.client_ip(headers, 0) == "203.0.113.10"


def test_trusted_proxy_hops_step_left():
    headers = _headers(client_ip="1.2.3.4, 198.51.100.7, 203.0.113.10")
    assert fa.client_ip(headers, 1) == "198.51.100.7"
    assert fa.client_ip(headers, 2) == "1.2.3.4"


def test_too_many_hops_falls_back_to_the_first_entry():
    headers = _headers(client_ip="1.2.3.4, 203.0.113.10")
    assert fa.client_ip(headers, 9) == "1.2.3.4"


def test_x_client_ip_is_the_fallback():
    headers = _headers(client_ip=None, headers={"X-Client-IP": "198.51.100.9:1234"})
    assert fa.client_ip(headers) == "198.51.100.9"


def test_x_azure_clientip_is_the_last_fallback():
    headers = _headers(client_ip=None, headers={"X-Azure-ClientIP": "198.51.100.11"})
    assert fa.client_ip(headers) == "198.51.100.11"


def test_garbage_forwarded_header_falls_through_to_x_client_ip():
    headers = _headers(client_ip="unknown", headers={"X-Client-IP": "198.51.100.9"})
    assert fa.client_ip(headers) == "198.51.100.9"


def test_no_client_address_is_500():
    with pytest.raises(fa.HovtpError) as caught:
        fa.client_ip(_headers(client_ip=None))
    assert (caught.value.status, caught.value.reason) == (500, "client address unavailable")


def test_no_client_address_answers_500_with_the_mandatory_headers(table, blobs):
    response = fa._handle_hovtp(make_request(
        body=fixtures.DT_SCHEDULE_BODY, client_ip=None))

    assert response.status_code == 500
    assert head(response, "X-HOVTP-Error-Reason") == "client address unavailable"
    assert head(response, "X-HOVTP-Last-Serial-Number") == "0"
    assert blobs.blobs == {}


def test_trusted_hops_setting_drives_the_stored_source(table, blobs, monkeypatch):
    monkeypatch.setenv("HOVTP_TRUSTED_PROXY_HOPS", "1")
    response = fa._handle_hovtp(make_request(
        body=fixtures.DT_SCHEDULE_BODY,
        client_ip="198.51.100.7, 203.0.113.10"))

    assert response.status_code == 200
    assert source_row(table, COMPETITION_ID, "198.51.100.7") is not None
    assert source_row(table, COMPETITION_ID, DEFAULT_IP) is None
