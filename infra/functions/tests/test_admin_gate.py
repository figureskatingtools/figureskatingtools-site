"""The admin gate (`_require_admin`) in front of every /api/manage/* route.

The router already 403s non-admins, but this Function App's hostname is public,
so the platform decides again from its own ADMIN_EMAILS. Unlike the user gate
it fails CLOSED: an unset PROXY_SHARED_SECRET means nobody gets in, and the
identity is taken only from the router's X-Forwarded-User-Email. Every refusal
must happen before any storage is touched.
"""
import function_app as fa
from conftest import ADMIN_EMAIL, OTHER_ADMIN_EMAIL, USER_EMAIL, make_request, payload

ROUTES = [
    ("list", fa._admin_list_competitions, "GET", {}),
    ("get", fa._admin_get_competition, "GET", {"route_params": {"id": "abc"}}),
    ("update", fa._admin_update_competition, "PATCH",
     {"body": {"venue": "Helsinki"}, "route_params": {"id": "abc"}}),
    ("delete", fa._admin_delete_competition, "DELETE", {"route_params": {"id": "abc"}}),
    ("restore", fa._admin_restore_competition, "POST", {"route_params": {"id": "abc"}}),
    ("purge", fa._admin_purge_competition, "POST",
     {"body": {"confirm": "abc"}, "route_params": {"id": "abc"}}),
    ("sweep dry-run", fa._admin_sweep_dry_run, "POST", {}),
    ("diagnostics", fa._admin_diagnostics, "GET", {}),
    ("audit", fa._admin_audit_log, "GET", {}),
]


def _assert_all_routes(table, status, error, **request_kwargs):
    for name, handler, method, kwargs in ROUTES:
        response = handler(make_request(method, **{**kwargs, **request_kwargs}))
        assert response.status_code == status, f"{name}: {response.status_code}"
        assert payload(response)["error"] == error, name
    assert table.calls == [], "a rejected request still hit the registry"
    assert table.clock.calls == [], "a rejected request still hit the clock table"
    assert table.adminlog.calls == [], "a rejected request still hit the admin log"


def test_the_gate_fails_closed_when_no_shared_secret_is_configured(admin, table, monkeypatch):
    """The user gate fails open without a secret (local dev); this one never does."""
    monkeypatch.delenv("PROXY_SHARED_SECRET", raising=False)
    _assert_all_routes(table, 401, "unauthorized", user_email=admin, proxy_secret=None)
    _assert_all_routes(table, 401, "unauthorized", user_email=admin, proxy_secret="")


def test_a_missing_proxy_secret_is_rejected(admin, table):
    _assert_all_routes(table, 401, "unauthorized", user_email=admin, proxy_secret=None)


def test_a_mismatched_proxy_secret_is_rejected(admin, table):
    _assert_all_routes(table, 401, "unauthorized", user_email=admin, proxy_secret="not-the-secret")


def test_a_signed_in_non_admin_gets_403(admin, table):
    _assert_all_routes(table, 403, "admin_required", user_email=USER_EMAIL)


def test_a_request_without_an_identity_gets_403(admin, table):
    _assert_all_routes(table, 403, "admin_required", user_email=None)


def test_an_empty_admin_list_means_nobody_is_an_admin(table, monkeypatch):
    monkeypatch.delenv("ADMIN_EMAILS", raising=False)
    _assert_all_routes(table, 403, "admin_required", user_email=ADMIN_EMAIL)
    monkeypatch.setenv("ADMIN_EMAILS", " , ,")
    _assert_all_routes(table, 403, "admin_required", user_email=ADMIN_EMAIL)


def test_the_identity_comes_only_from_the_forwarded_header(admin, table):
    """The user gate also trusts X-MS-* and unverified JWTs; the admin gate must not."""
    request = make_request("GET", user_email=None,
                           headers={"x-ms-client-principal-name": ADMIN_EMAIL})
    assert fa._admin_list_competitions(request).status_code == 403

    jwt = "e30.eyJwcmVmZXJyZWRfdXNlcm5hbWUiOiJhZG1pbkBleGFtcGxlLmNvbSJ9.sig"
    request = make_request("GET", user_email=None, headers={"authorization": f"Bearer {jwt}"})
    assert fa._admin_list_competitions(request).status_code == 403


def test_the_admin_match_is_case_insensitive(admin, table):
    for email in ("ADMIN@EXAMPLE.COM", "admin@example.com", "  Admin@Example.Com  "):
        response = fa._admin_list_competitions(make_request("GET", user_email=email))
        assert response.status_code == 200, email


def test_every_listed_admin_gets_in(admin, table):
    response = fa._admin_list_competitions(make_request("GET", user_email=OTHER_ADMIN_EMAIL))
    assert response.status_code == 200


def test_the_gate_returns_the_lowercased_admin_email(admin, table):
    assert fa._require_admin(make_request("GET", user_email="ADMIN@example.COM")) == ADMIN_EMAIL


def test_the_secret_is_compared_in_constant_time(admin, table, monkeypatch):
    seen = []

    def spy(a, b):
        seen.append((a, b))
        return a == b

    monkeypatch.setattr(fa.hmac, "compare_digest", spy)
    assert fa._require_admin(make_request("GET", user_email=admin)) == ADMIN_EMAIL
    assert seen, "the proxy secret was not compared with hmac.compare_digest"


def test_the_user_routes_are_unchanged_for_admins_and_non_admins(admin, table):
    """The admin gate is additive: the existing routes still only need sign-in."""
    for email in (USER_EMAIL, ADMIN_EMAIL):
        assert fa._list_competitions(make_request("GET", user_email=email)).status_code == 200
