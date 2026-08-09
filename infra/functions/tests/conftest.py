"""The Functions host loads `function_app` flatly from the app directory, so the
tests put that directory on sys.path and import it the same way.

Also provides the in-memory Table Storage double every test uses: the routes'
whole correctness argument is about the ORDER of table operations (claim the
CODE row before writing the COMPETITION row, compensate when the second write
fails), so the fake reproduces exactly the two behaviours that matter —
create_entity raising ResourceExistsError on a duplicate key, and get_entity /
delete_entity raising ResourceNotFoundError on a missing one.

The Blob Storage double below follows the same rule: it reproduces only the
behaviours the file-pool routes depend on — prefix listing, metadata that is
returned ONLY when list_blobs was asked for it, overwrite semantics, and
ResourceNotFoundError on a missing blob.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

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


class FakeBlob:
    """One stored blob: bytes plus the properties the routes read back."""

    def __init__(self, name, data, metadata, content_type, last_modified):
        self.name = name
        self.data = bytes(data)
        self.metadata = dict(metadata or {})
        self.content_type = content_type
        self.last_modified = last_modified

    def properties(self, *, with_metadata=True):
        return SimpleNamespace(
            name=self.name,
            size=len(self.data),
            metadata=dict(self.metadata) if with_metadata else {},
            content_settings=SimpleNamespace(content_type=self.content_type),
            last_modified=self.last_modified,
        )


class FakeDownloader:
    def __init__(self, data):
        self._data = data

    def readall(self):
        return self._data


class FakeBlobClient:
    def __init__(self, container, blob_name):
        self._container = container
        self.blob_name = blob_name

    def _blob(self):
        blob = self._container.blobs.get(self.blob_name)
        if blob is None:
            raise ResourceNotFoundError("blob not found")
        return blob

    def exists(self):
        self._container.calls.append(("exists", self.blob_name))
        return self.blob_name in self._container.blobs

    def download_blob(self):
        self._container.calls.append(("download_blob", self.blob_name))
        return FakeDownloader(self._blob().data)

    def get_blob_properties(self):
        self._container.calls.append(("get_blob_properties", self.blob_name))
        return self._blob().properties()

    def delete_blob(self):
        self._container.calls.append(("delete_blob", self.blob_name))
        self._blob()
        del self._container.blobs[self.blob_name]


class FakeContainerClient:
    """Minimal azure-storage-blob ContainerClient stand-in backed by a dict."""

    def __init__(self, container_name):
        self.container_name = container_name
        self.blobs: dict[str, FakeBlob] = {}
        self.calls: list[tuple] = []
        self.fail_next_upload: Exception | None = None
        # Distinct, increasing timestamps so ordering assertions are meaningful.
        self._clock = datetime(2026, 1, 2, 10, 0, 0, tzinfo=timezone.utc)

    def _tick(self):
        self._clock += timedelta(seconds=1)
        return self._clock

    def upload_blob(self, name, data, overwrite=False, metadata=None, content_settings=None,
                    **kwargs):
        self.calls.append(("upload_blob", name))
        if self.fail_next_upload is not None:
            error, self.fail_next_upload = self.fail_next_upload, None
            raise error
        if name in self.blobs and not overwrite:
            raise ResourceExistsError("blob already exists")
        self.blobs[name] = FakeBlob(
            name, data, metadata,
            getattr(content_settings, "content_type", None),
            self._tick(),
        )

    def list_blobs(self, name_starts_with=None, include=None):
        self.calls.append(("list_blobs", name_starts_with, include))
        # Azure only returns metadata when it was explicitly requested; the fake
        # withholds it too, so a route that forgets `include` fails its test.
        with_metadata = bool(include) and "metadata" in include
        return [
            blob.properties(with_metadata=with_metadata)
            for name, blob in sorted(self.blobs.items())
            if not name_starts_with or name.startswith(name_starts_with)
        ]

    def get_blob_client(self, name):
        return FakeBlobClient(self, name)


class FakeBlobServiceClient:
    def __init__(self):
        self.containers: dict[str, FakeContainerClient] = {}

    def get_container_client(self, container_name):
        return self.containers.setdefault(container_name, FakeContainerClient(container_name))


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
