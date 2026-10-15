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

    def pick(table_name=fa.COMPETITIONS_TABLE, *a, **kw):
        if table_name == fa._clock_table_name():
            return client.clock
        if table_name == fa._admin_log_table_name():
            return client.adminlog
        return client

    monkeypatch.setattr(fa, "get_table_client", pick)
    # Enforce the proxy gate in tests — the real deployment always sets it.
    monkeypatch.setenv("PROXY_SHARED_SECRET", PROXY_SECRET)
    return client


@pytest.fixture
def admin(monkeypatch, table):
    """ADMIN_EMAILS configured (mixed case on purpose) on top of `table`.
    Returns the admin's e-mail for `make_request(user_email=...)`."""
    monkeypatch.setenv("ADMIN_EMAILS", f" Admin@Example.com , {OTHER_ADMIN_EMAIL}")
    return ADMIN_EMAIL


def make_request(method="GET", path="/api/competitions", *, body=None, raw_body=None,
                 params=None, route_params=None, headers=None, proxy_secret=PROXY_SECRET,
                 user_email=USER_EMAIL):
    """Build the HttpRequest the router would have produced.

    `body` is JSON-encoded; `raw_body` is passed through as-is (file uploads).
    """
    request_headers = {}
    if proxy_secret is not None:
        request_headers["x-proxy-secret"] = proxy_secret
    if user_email is not None:
        request_headers["x-forwarded-user-email"] = user_email
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
