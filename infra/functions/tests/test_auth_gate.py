"""The proxy-secret + forwarded-identity gate.

This Function App is publicly reachable, so the ONLY thing standing between the
registry and the internet is `_proxy_secret_ok` (proves the request came from
the router) plus a forwarded user email (proves someone signed in). Every route
must refuse both ways, and must refuse before touching storage.
"""
import function_app as fa
from conftest import PROXY_SECRET, make_request, payload

ROUTES = [
    ("list", fa._list_competitions, "GET", {}),
    ("create", fa._create_competition, "POST", {"body": {"name": "Winter Cup"}}),
    ("get", fa._get_competition, "GET", {"route_params": {"id": "abc"}}),
    ("update", fa._update_competition, "PATCH",
     {"body": {"venue": "Helsinki"}, "route_params": {"id": "abc"}}),
    ("delete", fa._delete_competition, "DELETE", {"route_params": {"id": "abc"}}),
]


def _assert_all_routes_401(table, **request_kwargs):
    for name, handler, method, kwargs in ROUTES:
        response = handler(make_request(method, **{**kwargs, **request_kwargs}))
        assert response.status_code == 401, f"{name} did not reject the request"
        assert payload(response)["error"] == "unauthorized", name
    assert table.calls == [], "a rejected request still hit storage"


def test_a_request_without_the_proxy_secret_is_rejected(table):
    _assert_all_routes_401(table, proxy_secret=None)


def test_a_request_with_the_wrong_proxy_secret_is_rejected(table):
    _assert_all_routes_401(table, proxy_secret="not-the-secret")


def test_a_proxied_request_without_an_identity_is_rejected(table):
    _assert_all_routes_401(table, user_email=None)


def test_a_correctly_proxied_request_is_accepted(table):
    response = fa._list_competitions(make_request("GET"))
    assert response.status_code == 200


def test_the_easy_auth_principal_name_header_also_identifies_the_user(table):
    request = make_request("POST", body={"name": "Winter Cup"}, user_email=None,
                           headers={"x-ms-client-principal-name": "coach@example.com"})
    assert payload(fa._create_competition(request))["createdBy"] == "coach@example.com"


def test_the_gate_is_open_when_no_shared_secret_is_configured(monkeypatch):
    """Local dev (`func start` with no PROXY_SHARED_SECRET) must still work."""
    monkeypatch.delenv("PROXY_SHARED_SECRET", raising=False)
    request = make_request("GET", proxy_secret=None)
    assert fa._proxy_secret_ok(request) is True
    assert fa.get_user_email_from_header(request) == "skater@example.com"


def test_the_gate_is_closed_when_a_secret_is_configured(monkeypatch):
    monkeypatch.setenv("PROXY_SHARED_SECRET", PROXY_SECRET)
    assert fa._proxy_secret_ok(make_request("GET", proxy_secret=None)) is False
    assert fa._proxy_secret_ok(make_request("GET", proxy_secret="wrong")) is False
    assert fa._proxy_secret_ok(make_request("GET")) is True


def test_health_needs_neither_secret_nor_identity(table):
    response = fa.health(make_request("GET", "/api/health", proxy_secret=None, user_email=None))
    assert response.status_code == 200
    assert payload(response)["status"] == "ok"
