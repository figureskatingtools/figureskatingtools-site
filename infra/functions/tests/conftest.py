"""The Functions host loads `function_app` flatly from the app directory, so the
tests put that directory on sys.path and import it the same way.

The in-memory Table Storage and Blob Storage doubles every test uses live in
`fakes.py` next door. The HOVTP listener app in `infra/hovtp/` writes into the
same table and container but is tested with its own copy of the doubles (see
`infra/hovtp/tests/conftest.py`).
"""
import json
import os
import sys
import uuid
from urllib.parse import quote

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import azure.functions as func  # noqa: E402

import function_app as fa  # noqa: E402
from fakes import (  # noqa: E402,F401  (re-exported for the test modules)
    FakeBlob,
    FakeBlobClient,
    FakeBlobServiceClient,
    FakeContainerClient,
    FakeDownloader,
    FakeEntity,
)
from fakes import FakeTableClient as _FakeTableClient  # noqa: E402

PROXY_SECRET = "test-proxy-secret"
USER_EMAIL = "skater@example.com"
ADMIN_EMAIL = "admin@example.com"
OTHER_ADMIN_EMAIL = "second-admin@example.com"
# The deployment tenant (ALLOWED_TENANT_IDS) and one that is not allowed.
TENANT_ID = "72f988bf-86f1-41af-91ab-2d7cd011db47"
OTHER_TENANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
# The default user is pre-seeded under this platform userId (see `table`).
USER_ID = "0f0f0f0f-0000-4000-8000-000000000001"
_DEFAULT = object()


def oid_for(email) -> str:
    """Each test e-mail is its own Entra object (a deterministic oid), so
    `make_request(user_email=X)` is "user X" all through a test."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"oid:{(email or '').strip().lower()}"))


class FakeTableClient(_FakeTableClient):
    """The shared fake plus the registry-specific conveniences."""

    def competition_rows(self):
        return self.rows_with_pk(fa.PK_COMPETITION)

    def code_rows(self):
        return {rk: row for (pk, rk), row in self.rows.items() if pk == fa.PK_CODE}

    def hovtp_source_rows(self):
        return self.rows_with_pk(fa.PK_HOVTP_SOURCE)

    def clock_rows(self):
        """The `retentionclock` mirror (a separate table — see the fixture)."""
        return {rk: row for (pk, rk), row in self.clock.rows.items() if pk == fa.PK_COMPETITION}

    def audit_rows(self):
        """AUDIT rows of the `adminlog` table, newest first (RowKey order)."""
        return [row for (pk, _rk), row in sorted(self.adminlog.rows.items()) if pk == fa.PK_AUDIT]

    def sweep_rows(self):
        """SWEEP rows of the `adminlog` table, newest first (RowKey order)."""
        return [row for (pk, _rk), row in sorted(self.adminlog.rows.items()) if pk == fa.PK_SWEEP]

    def access_rows(self, competition_id):
        """{userId: Role} of one competition's competitionaccess partition."""
        return {rk: row.get("Role") for (pk, rk), row in self.access.rows.items()
                if pk == competition_id.lower()}

    def user_id(self, email):
        """The platform userId the e-mail's (test) identity resolved to, or None."""
        link = self.identities.rows.get((fa.PK_IDENTITY, f"{TENANT_ID}_{oid_for(email)}"))
        return link["UserId"] if link else None

    def grant(self, competition_id, user_id=USER_ID, role="owner"):
        """Seed a competitionaccess row directly."""
        self.access.upsert_entity({
            "PartitionKey": competition_id.lower(), "RowKey": user_id, "Role": role,
            "GrantedBy": user_id, "GrantedUtc": "2026-01-02T10:00:00Z",
        })

    def seed_user(self, email, name="", user_id=None, last_seen="2026-01-02T10:00:00Z"):
        """Seed a users row + its identity link, as if `email` had signed in."""
        user_id = user_id or str(uuid.uuid5(uuid.NAMESPACE_URL, f"user:{email}"))
        self.users.upsert_entity({
            "PartitionKey": fa.PK_USER, "RowKey": user_id, "Email": email.lower(),
            "DisplayName": name, "FirstSeenUtc": "2026-01-01T10:00:00Z", "LastSeenUtc": last_seen,
        })
        self.identities.upsert_entity({
            "PartitionKey": fa.PK_IDENTITY, "RowKey": f"{TENANT_ID}_{oid_for(email)}",
            "UserId": user_id, "Tid": TENANT_ID, "Oid": oid_for(email), "Provider": "entra",
            "CreatedUtc": "2026-01-01T10:00:00Z",
        })
        return user_id


@pytest.fixture(autouse=True)
def _fresh_process_caches():
    """The LastSeen throttle and the search rate limit are per-process state."""
    fa._LAST_SEEN_WRITES.clear()
    fa._SEARCH_HITS.clear()
    yield
    fa._LAST_SEEN_WRITES.clear()
    fa._SEARCH_HITS.clear()


@pytest.fixture
def blobs(monkeypatch):
    """The fake `competition-data` container wired into get_blob_service_client."""
    service = FakeBlobServiceClient()
    monkeypatch.setattr(fa, "get_blob_service_client", lambda *a, **kw: service)
    return service.get_container_client(fa.DATA_CONTAINER)


@pytest.fixture
def table(monkeypatch):
    """A fresh fake table wired into function_app.get_table_client."""
    client = FakeTableClient()
    # The retention clock lives in its own table; same PK/RK shape as the
    # COMPETITION rows, so it must not share the registry's fake.
    client.clock = _FakeTableClient()
    # The admin log (AUDIT + SWEEP rows) is a third table of its own.
    client.adminlog = _FakeTableClient()
    # The access model: users (PII), useridentities and competitionaccess.
    client.users = _FakeTableClient()
    client.identities = _FakeTableClient()
    client.access = _FakeTableClient()

    def pick(table_name=fa.COMPETITIONS_TABLE, *a, **kw):
        if table_name == fa._clock_table_name():
            return client.clock
        if table_name == fa._admin_log_table_name():
            return client.adminlog
        if table_name == fa._users_table_name():
            return client.users
        if table_name == fa._user_identities_table_name():
            return client.identities
        if table_name == fa._access_table_name():
            return client.access
        return client

    monkeypatch.setattr(fa, "get_table_client", pick)
    # The gate fails closed: the real deployment always sets both.
    monkeypatch.setenv("PROXY_SHARED_SECRET", PROXY_SECRET)
    monkeypatch.setenv("ALLOWED_TENANT_IDS", TENANT_ID)
    # The default user has signed in before, under a known userId.
    client.seed_user(USER_EMAIL, "Skater Person", user_id=USER_ID)
    client.users.calls.clear()
    client.identities.calls.clear()
    return client


@pytest.fixture
def admin(monkeypatch, table):
    """ADMIN_EMAILS configured (mixed case on purpose) on top of `table`.
    Returns the admin's e-mail for `make_request(user_email=...)`."""
    monkeypatch.setenv("ADMIN_EMAILS", f" Admin@Example.com , {OTHER_ADMIN_EMAIL}")
    return ADMIN_EMAIL


def make_request(method="GET", path="/api/competitions", *, body=None, raw_body=None,
                 params=None, route_params=None, headers=None, proxy_secret=PROXY_SECRET,
                 user_email=USER_EMAIL, tid=TENANT_ID, oid=_DEFAULT, name=None):
    """Build the HttpRequest the router would have produced.

    The identity headers follow the router: tid + oid (by default the
    e-mail's own deterministic oid), the e-mail, and the percent-encoded
    name. Pass tid=None / oid=None to leave one out.
    `body` is JSON-encoded; `raw_body` is passed through as-is (file uploads).
    """
    if oid is _DEFAULT:
        oid = oid_for(user_email or "anonymous")
    request_headers = {}
    if proxy_secret is not None:
        request_headers["x-proxy-secret"] = proxy_secret
    if tid is not None:
        request_headers["x-forwarded-user-tid"] = tid
    if oid is not None:
        request_headers["x-forwarded-user-oid"] = oid
    if user_email is not None:
        request_headers["x-forwarded-user-email"] = user_email
    if name is not None:
        request_headers["x-forwarded-user-name"] = quote(name, safe="")
    request_headers.update(headers or {})

    payload_bytes = b""
    if raw_body is not None:
        payload_bytes = raw_body
    elif body is not None:
        payload_bytes = json.dumps(body).encode("utf-8")
        request_headers.setdefault("content-type", "application/json")

    return func.HttpRequest(
        method=method,
        url=f"https://example.invalid{path}",
        headers=request_headers,
        params=params or {},
        route_params=route_params or {},
        body=payload_bytes,
    )


def payload(response):
    """Decode a func.HttpResponse body as JSON."""
    return json.loads(response.get_body().decode("utf-8"))
