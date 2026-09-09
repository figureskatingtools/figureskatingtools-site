"""The Functions host loads `function_app` flatly from the app directory, so the
tests put that directory on sys.path and import it the same way.

The storage doubles below are deliberately a SELF-CONTAINED copy of the platform
app's (infra/functions/tests/conftest.py) rather than an import: the two apps
deploy independently, and a test suite that reached across into the other app's
tests would break the moment either is packaged on its own.

They are extended for what the listener actually depends on and the platform
routes do not:

  * per-row etags, so the etag-conditional serial commit can be exercised
    (including a forced ResourceModifiedError and the retry that follows),
  * `upsert_entity` with MERGE semantics — the trust row is written blind,
  * `query_entities` with a `RowKey ge/lt` range, which is how the pending
    sources of one competition are counted.
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import azure.functions as func  # noqa: E402
from azure.core.exceptions import (  # noqa: E402
    ResourceExistsError,
    ResourceModifiedError,
    ResourceNotFoundError,
)

import function_app as fa  # noqa: E402

DEFAULT_IP = "203.0.113.10"
COMPETITION_ID = "3f2b0000-0000-4000-8000-000000000001"
COMPETITION_CODE = "yl110926htl"
SESSION_ID = "6d4f1b9e-2c3a-4c0d-9f1e-0a1b2c3d4e5f"

_FILTER_RE = re.compile(r"(PartitionKey|RowKey)\s+(eq|ge|gt|le|lt)\s+'([^']*)'")


class FakeEntity(dict):
    """A dict that also carries `.metadata['etag']`, like azure.data.tables."""

    def __init__(self, data, etag):
        super().__init__(data)
        self.metadata = {"etag": etag}


class FakeTableClient:
    """Minimal azure-data-tables TableClient stand-in backed by a dict."""

    def __init__(self):
        self.rows: dict[tuple[str, str], dict] = {}
        self.etags: dict[tuple[str, str], str] = {}
        self.calls: list[tuple] = []
        self._etag_seq = 0
        # Set to an exception instance to make the NEXT call of that kind blow up.
        self.fail_next_create: Exception | None = None
        self.fail_next_upsert: Exception | None = None
        # Make the first N update_entity calls raise ResourceModifiedError, as a
        # concurrent writer on the same session row would.
        self.fail_updates = 0

    # -- API surface used by function_app --------------------------------
    def _next_etag(self) -> str:
        self._etag_seq += 1
        return f"W/\"etag-{self._etag_seq}\""

    def _store(self, key, entity):
        self.rows[key] = dict(entity)
        self.etags[key] = self._next_etag()

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
        self._store(key, entity)

    def get_entity(self, partition_key, row_key):
        key = (partition_key, row_key)
        self.calls.append(("get_entity", key))
        if key not in self.rows:
            raise ResourceNotFoundError("entity not found")
        return FakeEntity(self.rows[key], self.etags[key])

    def update_entity(self, entity, mode=None, etag=None, match_condition=None):
        key = (entity["PartitionKey"], entity["RowKey"])
        self.calls.append(("update_entity", key))
        if self.fail_updates > 0:
            self.fail_updates -= 1
            raise ResourceModifiedError("etag mismatch")
        if key not in self.rows:
            raise ResourceNotFoundError("entity not found")
        if etag is not None and etag != self.etags[key]:
            raise ResourceModifiedError("etag mismatch")
        merged = dict(self.rows[key])
        merged.update(entity)
        self._store(key, merged)

    def upsert_entity(self, entity, mode=None):
        key = (entity["PartitionKey"], entity["RowKey"])
        self.calls.append(("upsert_entity", key))
        if self.fail_next_upsert is not None:
            error, self.fail_next_upsert = self.fail_next_upsert, None
            raise error
        merged = dict(self.rows.get(key, {}))
        merged.update(entity)
        self._store(key, merged)

    def delete_entity(self, partition_key, row_key):
        key = (partition_key, row_key)
        self.calls.append(("delete_entity", key))
        if key not in self.rows:
            raise ResourceNotFoundError("entity not found")
        del self.rows[key]
        self.etags.pop(key, None)

    def query_entities(self, query_filter):
        self.calls.append(("query_entities", query_filter))
        clauses = _FILTER_RE.findall(query_filter)
        results = []
        for (pk, rk), row in sorted(self.rows.items()):
            value = {"PartitionKey": pk, "RowKey": rk}
            if all(_matches(value[field], op, operand) for field, op, operand in clauses):
                results.append(FakeEntity(row, self.etags[(pk, rk)]))
        return results

    # -- test conveniences ------------------------------------------------
    def rows_in(self, partition_key):
        return {rk: row for (pk, rk), row in self.rows.items() if pk == partition_key}

    def writes(self):
        """Every mutating call, in order — used to prove OPTIONS is read-only."""
        return [call for call in self.calls
                if call[0] in ("create_entity", "update_entity", "upsert_entity",
                               "delete_entity", "create_table")]


def _matches(value, op, operand) -> bool:
    return {
        "eq": value == operand,
        "ge": value >= operand,
        "gt": value > operand,
        "le": value <= operand,
        "lt": value < operand,
    }[op]


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
        self._clock = datetime(2026, 9, 1, 21, 0, 0, tzinfo=timezone.utc)

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


# ── fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def clean_settings(monkeypatch):
    """Every HOVTP_* setting back to its documented default for each test."""
    for name in ("HOVTP_ENABLED", "HOVTP_ENVIRONMENT", "HOVTP_STRICT_SERIAL",
                 "HOVTP_KEEP_ALIVE_SECONDS", "HOVTP_TRUSTED_PROXY_HOPS",
                 "HOVTP_ALLOWED_DOCUMENT_TYPES"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def blobs(monkeypatch):
    """The fake `competition-data` container wired into get_blob_service_client."""
    service = FakeBlobServiceClient()
    monkeypatch.setattr(fa, "get_blob_service_client", lambda *a, **kw: service)
    return service.get_container_client(fa.DATA_CONTAINER)


@pytest.fixture
def table(monkeypatch):
    """A fresh fake table, pre-seeded with the capture's competition."""
    client = FakeTableClient()
    monkeypatch.setattr(fa, "get_table_client", lambda *a, **kw: client)
    seed_competition(client)
    client.calls.clear()
    return client


# ── helpers ───────────────────────────────────────────────────────────────────

def seed_competition(table_client, code=COMPETITION_CODE, competition_id=COMPETITION_ID,
                     status="active"):
    table_client.create_entity({
        "PartitionKey": fa.PK_CODE,
        "RowKey": code,
        "CompetitionId": competition_id,
        "CreatedUtc": "2026-08-01T09:00:00Z",
    })
    table_client.create_entity({
        "PartitionKey": fa.PK_COMPETITION,
        "RowKey": competition_id,
        "Code": code,
        "Name": "Youth League Helsinki",
        "Status": status,
    })


def seed_source(table_client, *, ip=DEFAULT_IP, competition_id=COMPETITION_ID,
                status="pending", accepted_until="", pending_count=0, pending_bytes=0,
                message_count=1):
    table_client.create_entity({
        "PartitionKey": fa.PK_HOVTP_SOURCE,
        "RowKey": fa.source_row_key(competition_id, ip),
        "CompetitionId": competition_id,
        "Ip": ip,
        "Origin": "FSM",
        "Venue": "HTL",
        "Discipline": "FSK",
        "Environment": "Test",
        "Status": status,
        "FirstSeenUtc": "2026-09-01T20:00:00Z",
        "LastSeenUtc": "2026-09-01T20:00:00Z",
        "MessageCount": message_count,
        "PendingCount": pending_count,
        "PendingBytes": pending_bytes,
        "AcceptedUntilUtc": accepted_until,
        "AcceptedBy": "operator@example.com" if status == "accepted" else "",
    })


def seed_session(table_client, session_id=SESSION_ID, last_serial=1, ip=DEFAULT_IP):
    table_client.create_entity({
        "PartitionKey": fa.PK_HOVTP_SESSION,
        "RowKey": session_id,
        "LastSerial": last_serial,
        "Ip": ip,
        "CreatedUtc": "2026-09-01T20:00:00Z",
        "UpdatedUtc": "2026-09-01T20:00:00Z",
    })


def make_request(method="POST", *, body=b"", path=None, headers=None,
                 session_id=None, serial=None, client_ip=DEFAULT_IP, params=None,
                 content_length=None):
    """Build the HttpRequest the Functions host would have produced."""
    request_headers = {
        "X-HOVTP-Origin": "FSM",
        "X-HOVTP-Environment": "Test",
        "X-HOVTP-Venue": "HTL",
        "X-HOVTP-Discipline": "FSK",
        "X-HOVTP-Data-Type": "ODF",
    }
    if client_ip is not None:
        request_headers["X-Forwarded-For"] = client_ip
    if session_id is not None:
        request_headers["X-HOVTP-Session-Id"] = session_id
    if serial is not None:
        request_headers["X-HOVTP-Serial-Number"] = str(serial)
    if content_length is not None:
        request_headers["Content-Length"] = str(content_length)
    request_headers.update(headers or {})

    return func.HttpRequest(
        method=method,
        url=f"https://func-fs-hovtp.invalid{path or '/api/v1/hovtp'}",
        headers=request_headers,
        params=params or {},
        route_params={},
        body=body,
    )


def head(response, name):
    """One response header, case-insensitively."""
    for key, value in response.headers.items():
        if key.lower() == name.lower():
            return value
    return None


def mandatory_headers_present(response):
    return (head(response, "Cache-Control") == "no-cache"
            and head(response, "X-HOVTP-Environment") is not None
            and head(response, "X-HOVTP-Last-Serial-Number") is not None)


def source_row(table_client, competition_id=COMPETITION_ID, ip=DEFAULT_IP):
    return table_client.rows.get(
        (fa.PK_HOVTP_SOURCE, fa.source_row_key(competition_id, ip)))


def session_row(table_client, session_id=SESSION_ID):
    return table_client.rows.get((fa.PK_HOVTP_SESSION, session_id))


def payload(response):
    return json.loads(response.get_body().decode("utf-8"))
