"""The Functions host loads `function_app` flatly from the app directory, so the
tests put that directory on sys.path and import it the same way.

The in-memory Table Storage and Blob Storage doubles every test uses live in
`fakes.py` next door — the HOVTP listener app in `infra/hovtp/` writes into the
same table and container, and shares them from there.
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


class FakeTableClient(_FakeTableClient):
    """The shared fake plus the registry-specific conveniences."""

    def competition_rows(self):
        return self.rows_with_pk(fa.PK_COMPETITION)

    def code_rows(self):
        return {rk: row for (pk, rk), row in self.rows.items() if pk == fa.PK_CODE}

    def hovtp_source_rows(self):
        return self.rows_with_pk(fa.PK_HOVTP_SOURCE)


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
    monkeypatch.setattr(fa, "get_table_client", lambda *a, **kw: client)
    # Enforce the proxy gate in tests — the real deployment always sets it.
    monkeypatch.setenv("PROXY_SHARED_SECRET", PROXY_SECRET)
    return client


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
