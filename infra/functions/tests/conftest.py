"""The Functions host loads `function_app` flatly from the app directory, so the
tests put that directory on sys.path and import it the same way.

Also provides the in-memory Table Storage double every test uses: the routes'
whole correctness argument is about the ORDER of table operations (claim the
CODE row before writing the COMPETITION row, compensate when the second write
fails), so the fake reproduces exactly the two behaviours that matter —
create_entity raising ResourceExistsError on a duplicate key, and get_entity /
delete_entity raising ResourceNotFoundError on a missing one.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import azure.functions as func  # noqa: E402
from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError  # noqa: E402

import function_app as fa  # noqa: E402

PROXY_SECRET = "test-proxy-secret"
USER_EMAIL = "skater@example.com"


class FakeTableClient:
    """Minimal azure-data-tables TableClient stand-in backed by a dict."""

    def __init__(self):
        self.rows: dict[tuple[str, str], dict] = {}
        # Set to an exception instance to make the NEXT create_entity blow up.
        self.fail_next_create: Exception | None = None
        self.fail_next_update: Exception | None = None
        self.calls: list[tuple] = []

    # -- API surface used by function_app --------------------------------
    def create_table(self):
        self.calls.append(("create_table",))

    def create_entity(self, entity):
        key = (entity["PartitionKey"], entity["RowKey"])
        self.calls.append(("create_entity", key))
        if self.fail_next_create is not None:
            error, self.fail_next_create = self.fail_next_create, None
            raise error
        if key in self.rows:
            raise ResourceExistsError("entity already exists")
        self.rows[key] = dict(entity)

    def get_entity(self, partition_key, row_key):
        key = (partition_key, row_key)
        self.calls.append(("get_entity", key))
        if key not in self.rows:
            raise ResourceNotFoundError("entity not found")
        return dict(self.rows[key])

    def update_entity(self, entity, mode=None):
        key = (entity["PartitionKey"], entity["RowKey"])
        self.calls.append(("update_entity", key))
        if self.fail_next_update is not None:
            error, self.fail_next_update = self.fail_next_update, None
            raise error
        if key not in self.rows:
            raise ResourceNotFoundError("entity not found")
        self.rows[key].update(entity)

    def delete_entity(self, partition_key, row_key):
        key = (partition_key, row_key)
        self.calls.append(("delete_entity", key))
        if key not in self.rows:
            raise ResourceNotFoundError("entity not found")
        del self.rows[key]

    def query_entities(self, query_filter):
        self.calls.append(("query_entities", query_filter))
        # Only `PartitionKey eq '<pk>'` is ever issued by function_app.
        wanted = query_filter.split("'")[1]
        return [dict(row) for (pk, _rk), row in self.rows.items() if pk == wanted]

    # -- test conveniences ------------------------------------------------
    def competition_rows(self):
        return [r for (pk, _), r in self.rows.items() if pk == fa.PK_COMPETITION]

    def code_rows(self):
        return {rk: r for (pk, rk), r in self.rows.items() if pk == fa.PK_CODE}


@pytest.fixture
def table(monkeypatch):
    """A fresh fake table wired into function_app.get_table_client."""
    client = FakeTableClient()
    monkeypatch.setattr(fa, "get_table_client", lambda *a, **kw: client)
    # Enforce the proxy gate in tests — the real deployment always sets it.
    monkeypatch.setenv("PROXY_SHARED_SECRET", PROXY_SECRET)
    return client


def make_request(method="GET", path="/api/competitions", *, body=None, params=None,
                 route_params=None, headers=None, proxy_secret=PROXY_SECRET,
                 user_email=USER_EMAIL):
    """Build the HttpRequest the router would have produced."""
    request_headers = {}
    if proxy_secret is not None:
        request_headers["x-proxy-secret"] = proxy_secret
    if user_email is not None:
        request_headers["x-forwarded-user-email"] = user_email
    request_headers.update(headers or {})

    raw_body = b""
    if body is not None:
        raw_body = json.dumps(body).encode("utf-8")
        request_headers.setdefault("content-type", "application/json")

    return func.HttpRequest(
        method=method,
        url=f"https://example.invalid{path}",
        headers=request_headers,
        params=params or {},
        route_params=route_params or {},
        body=raw_body,
    )


def payload(response):
    """Decode a func.HttpResponse body as JSON."""
    return json.loads(response.get_body().decode("utf-8"))
