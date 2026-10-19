"""The proxy-secret + forwarded-identity gate.

This Function App is publicly reachable, so the ONLY thing standing between the
registry and the internet is `_proxy_secret_ok` (proves the request came from
the router; fails CLOSED) plus the router's forwarded tid/oid (proves someone
signed in, from an allowed tenant). Every route must refuse both ways, and must
refuse before touching storage.
"""
import base64
import json

import function_app as fa
from conftest import OTHER_TENANT_ID, PROXY_SECRET, TENANT_ID, make_request, payload

OTHER_OID = "11111111-2222-3333-4444-555555555555"

ROUTES = [
    ("list", fa._list_competitions, "GET", {}),
    ("create", fa._create_competition, "POST", {"body": {"name": "Winter Cup"}}),
    ("get", fa._get_competition, "GET", {"route_params": {"id": "abc"}}),
    ("update", fa._update_competition, "PATCH",
     {"body": {"venue": "Helsinki"}, "route_params": {"id": "abc"}}),
    ("delete", fa._delete_competition, "DELETE", {"route_params": {"id": "abc"}}),
    ("hovtp list", fa._list_hovtp_sources, "GET", {"route_params": {"id": "abc"}}),
    ("hovtp accept", fa._accept_hovtp_source, "POST",
     {"body": {"days": 1}, "route_params": {"id": "abc", "ip": "10.0.0.1"}}),
    ("hovtp reject", fa._deny_hovtp_source, "POST",
     {"route_params": {"id": "abc", "ip": "10.0.0.1"}}),
    ("hovtp revoke", fa._deny_hovtp_source, "DELETE",
     {"route_params": {"id": "abc", "ip": "10.0.0.1"}}),
    ("extend", fa._extend_competition, "POST", {"route_params": {"id": "abc"}}),
    ("files list", fa._list_competition_files, "GET", {"route_params": {"id": "abc"}}),
    ("files upload", fa._upload_competition_file, "POST",
     {"raw_body": b"%PDF", "params": {"filename": "a.pdf"}, "route_params": {"id": "abc"}}),
    ("files download", fa._download_competition_file, "GET",
     {"route_params": {"id": "abc", "name": "a.pdf"}}),
    ("files delete", fa._delete_competition_file, "DELETE",
     {"route_params": {"id": "abc", "name": "a.pdf"}}),
    ("access list", fa._list_access, "GET", {"route_params": {"id": "abc"}}),
    ("access set", fa._set_access, "PUT",
     {"body": {"role": "read"}, "route_params": {"id": "abc", "userId": OTHER_OID}}),
    ("access remove", fa._remove_access, "DELETE",
     {"route_params": {"id": "abc", "userId": "me"}}),
    ("users search", fa._search_users, "GET", {"params": {"q": "skater"}}),
    ("users recent", fa._recent_share_users, "GET", {}),
    ("users me", fa._current_user, "GET", {}),
]


def _assert_all_routes_401(table, **request_kwargs):
    for name, handler, method, kwargs in ROUTES:
        response = handler(make_request(method, **{**kwargs, **request_kwargs}))
        assert response.status_code == 401, f"{name} did not reject the request"
        assert payload(response)["error"] == "unauthorized", name
    assert table.calls == [], "a rejected request still hit storage"
    assert table.users.calls == [] and table.identities.calls == [] and table.access.calls == [], \
        "a rejected request still hit the user tables"


def test_a_request_without_the_proxy_secret_is_rejected(table):
    _assert_all_routes_401(table, proxy_secret=None)


def test_a_request_with_the_wrong_proxy_secret_is_rejected(table):
    _assert_all_routes_401(table, proxy_secret="not-the-secret")


def test_a_proxied_request_without_an_identity_is_rejected(table):
    _assert_all_routes_401(table, oid=None)
    _assert_all_routes_401(table, tid=None)
    _assert_all_routes_401(table, oid="not-a-guid")


def test_a_correctly_proxied_request_is_accepted(table):
    response = fa._list_competitions(make_request("GET"))
    assert response.status_code == 200


def test_spoofed_easy_auth_headers_and_bearer_tokens_identify_nobody(table):
    """Only the router's x-forwarded-user-tid/-oid count. The old fallbacks —
    X-MS-CLIENT-PRINCIPAL-NAME, the base64 principal, an unsigned JWT — are
    gone, even with the right secret."""
    principal = base64.b64encode(json.dumps({"userDetails": "coach@example.com"}).encode()).decode()
    jwt_payload = base64.urlsafe_b64encode(json.dumps(
        {"preferred_username": "coach@example.com", "oid": OTHER_OID, "tid": TENANT_ID}).encode())
    jwt = f"e30.{jwt_payload.decode().rstrip('=')}.sig"
    for headers in ({"x-ms-client-principal-name": "coach@example.com"},
                    {"x-ms-client-principal": principal},
                    {"authorization": f"Bearer {jwt}"}):
        _assert_all_routes_401(table, user_email=None, tid=None, oid=None, headers=headers)


def test_the_gate_is_closed_when_no_shared_secret_is_configured(table, monkeypatch):
    """No fail-open mode any more: an unset secret refuses everyone."""
    monkeypatch.delenv("PROXY_SHARED_SECRET", raising=False)
    assert fa._proxy_secret_ok(make_request("GET", proxy_secret=None)) is False
    assert fa._proxy_secret_ok(make_request("GET")) is False
    _assert_all_routes_401(table)
    monkeypatch.setenv("PROXY_SHARED_SECRET", "")
    _assert_all_routes_401(table, proxy_secret="")


def test_the_secret_is_compared_in_constant_time(table, monkeypatch):
    seen = []

    def spy(a, b):
        seen.append((a, b))
        return a == b

    monkeypatch.setattr(fa.hmac, "compare_digest", spy)
    assert fa._list_competitions(make_request("GET")).status_code == 200
    assert seen, "the proxy secret was not compared with hmac.compare_digest"


def test_a_tenant_outside_the_allow_list_gets_403_before_any_storage(table):
    for name, handler, method, kwargs in ROUTES:
        response = handler(make_request(method, tid=OTHER_TENANT_ID, **kwargs))
        assert response.status_code == 403, name
        assert payload(response)["error"] == "tenant_not_allowed", name
    assert table.calls == [] and table.users.calls == [] and table.identities.calls == []


def test_an_empty_tenant_allow_list_admits_nobody(table, monkeypatch):
    monkeypatch.setenv("ALLOWED_TENANT_IDS", "")
    response = fa._list_competitions(make_request("GET"))
    assert response.status_code == 403
    assert payload(response)["error"] == "tenant_not_allowed"


def test_the_tenant_allow_list_is_case_and_space_tolerant(table, monkeypatch):
    monkeypatch.setenv("ALLOWED_TENANT_IDS", f" {OTHER_TENANT_ID} , {TENANT_ID.upper()} ")
    assert fa._list_competitions(make_request("GET")).status_code == 200
    assert fa._list_competitions(make_request("GET", tid=TENANT_ID.upper())).status_code == 200


def test_the_gate_is_closed_when_a_secret_is_configured(monkeypatch):
    monkeypatch.setenv("PROXY_SHARED_SECRET", PROXY_SECRET)
    assert fa._proxy_secret_ok(make_request("GET", proxy_secret=None)) is False
    assert fa._proxy_secret_ok(make_request("GET", proxy_secret="wrong")) is False
    assert fa._proxy_secret_ok(make_request("GET")) is True


def test_health_needs_neither_secret_nor_identity(table):
    response = fa.health(make_request("GET", "/api/health", proxy_secret=None, user_email=None))
    assert response.status_code == 200
    assert payload(response)["status"] == "ok"
