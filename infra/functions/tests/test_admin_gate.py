"""The admin gate (`_require_admin`) in front of every /api/manage/* route.

The router already 403s non-admins, but this Function App's hostname is public,
so the platform checks again. Like the user gate it fails CLOSED: an unset
PROXY_SHARED_SECRET means nobody gets in, the router's X-Forwarded-User-Tid/-Oid
must be present with an allowed tenant, and admin comes only from the router's
X-Forwarded-User-Admin: 1 (sent for the Site.Admin app role) — no e-mail list.
Every refusal must happen before any storage is touched.
"""
import function_app as fa
from conftest import ADMIN_EMAIL, OTHER_TENANT_ID, TENANT_ID, USER_EMAIL, make_request, oid_for, payload

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
    """No secret configured: nobody gets in (the user gate behaves the same)."""
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


def test_without_the_admin_header_nobody_is_an_admin(table):
    """Not even the e-mail that used to be in ADMIN_EMAILS."""
    _assert_all_routes(table, 403, "admin_required", user_email=ADMIN_EMAIL, admin=False)


def test_the_admin_header_must_be_exactly_1(table):
    for value in ("true", "yes", "0", "", "11"):
        _assert_all_routes(table, 403, "admin_required", user_email=ADMIN_EMAIL, admin=False,
                           headers={"x-forwarded-user-admin": value})


def test_the_admin_header_with_a_missing_or_wrong_secret_is_401(table):
    _assert_all_routes(table, 401, "unauthorized", user_email=ADMIN_EMAIL, admin=True, proxy_secret=None)
    _assert_all_routes(table, 401, "unauthorized", user_email=ADMIN_EMAIL, admin=True,
                       proxy_secret="not-the-secret")


def test_the_admin_header_from_a_disallowed_tenant_is_403(table):
    _assert_all_routes(table, 403, "tenant_not_allowed", user_email=ADMIN_EMAIL, admin=True,
                       tid=OTHER_TENANT_ID)


def test_the_admin_header_without_tid_or_oid_is_401(table):
    _assert_all_routes(table, 401, "unauthorized", user_email=ADMIN_EMAIL, admin=True, tid=None)
    _assert_all_routes(table, 401, "unauthorized", user_email=ADMIN_EMAIL, admin=True, oid=None)


def test_the_admin_header_with_a_valid_identity_gets_in_whatever_the_email(table):
    for email in (ADMIN_EMAIL, USER_EMAIL, None):
        response = fa._admin_list_competitions(make_request("GET", user_email=email, admin=True))
        assert response.status_code == 200, email


def test_the_identity_comes_only_from_the_forwarded_header(admin, table):
    """X-MS-* headers and unverified JWTs are never an identity."""
    request = make_request("GET", user_email=None,
                           headers={"x-ms-client-principal-name": ADMIN_EMAIL})
    assert fa._admin_list_competitions(request).status_code == 403

    jwt = "e30.eyJwcmVmZXJyZWRfdXNlcm5hbWUiOiJhZG1pbkBleGFtcGxlLmNvbSJ9.sig"
    request = make_request("GET", user_email=None, headers={"authorization": f"Bearer {jwt}"})
    assert fa._admin_list_competitions(request).status_code == 403


def test_the_gate_returns_the_lowercased_admin_email(table):
    assert fa._require_admin(make_request("GET", user_email="ADMIN@example.COM", admin=True)) == ADMIN_EMAIL


def test_without_an_email_the_gate_returns_the_identity_key(table):
    actor = fa._require_admin(make_request("GET", user_email=None, admin=True))
    assert actor == f"{TENANT_ID}_{oid_for('anonymous')}"


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
