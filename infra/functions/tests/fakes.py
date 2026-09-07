"""In-memory Table Storage and Blob Storage doubles shared by the test suites.

They live in their own module (rather than inside `conftest.py`) because the
HOVTP listener app in `infra/hovtp/` drives the *same* storage layout — the
`competitions` table and the `competition-data` container — and must be tested
against the same behaviours. Its conftest puts this directory on `sys.path` and
imports `fakes`.

The doubles reproduce only what the routes actually depend on, so a route that
gets the storage contract wrong fails a test:

  * `create_entity` raises `ResourceExistsError` on a duplicate key and
    `get_entity`/`delete_entity` raise `ResourceNotFoundError` on a missing one
    — the registry's whole correctness argument is about the ORDER of table
    operations (claim the CODE row before writing the COMPETITION row,
    compensate when the second write fails).
  * every row carries an etag, and `update_entity(..., etag=,
    match_condition=)` raises `ResourceModifiedError` when it no longer matches
    — the listener's serial-number bookkeeping is optimistic-concurrency based.
  * `query_entities` understands the two filters the apps issue:
    `PartitionKey eq '<pk>'` with an optional `RowKey ge '<a>' and RowKey lt
    '<b>'` range.
  * blobs support prefix listing, metadata that is returned ONLY when
    `list_blobs` was asked for it, overwrite semantics, and
    `ResourceNotFoundError` on a missing blob.
"""
import re
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from azure.core import MatchConditions
from azure.core.exceptions import (
    ResourceExistsError,
    ResourceModifiedError,
    ResourceNotFoundError,
)


class FakeEntity(dict):
    """A dict with `.metadata['etag']`, like azure-data-tables' TableEntity."""

    def __init__(self, mapping=None, metadata=None):
        super().__init__(mapping or {})
        self._metadata = dict(metadata or {})

    @property
    def metadata(self):
        return self._metadata


class FakeTableClient:
    """Minimal azure-data-tables TableClient stand-in backed by a dict."""

    def __init__(self):
        self.rows: dict[tuple[str, str], dict] = {}
        self.etags: dict[tuple[str, str], str] = {}
        # Set to an exception instance to make the NEXT call blow up.
        self.fail_next_create: Exception | None = None
        self.fail_next_update: Exception | None = None
        self.calls: list[tuple] = []
        self._etag_seq = 0

    # -- internals --------------------------------------------------------
    def _next_etag(self) -> str:
        self._etag_seq += 1
        return f'W/"datetime\'fake-{self._etag_seq}\'"'

    def _store(self, key, row):
        self.rows[key] = row
        self.etags[key] = self._next_etag()

    # -- API surface used by the apps -------------------------------------
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
        self._store(key, dict(entity))

    def get_entity(self, partition_key, row_key):
        key = (partition_key, row_key)
        self.calls.append(("get_entity", key))
        if key not in self.rows:
            raise ResourceNotFoundError("entity not found")
        return FakeEntity(self.rows[key], {"etag": self.etags[key]})

    def update_entity(self, entity, mode=None, etag=None, match_condition=None):
        key = (entity["PartitionKey"], entity["RowKey"])
        self.calls.append(("update_entity", key))
        if self.fail_next_update is not None:
            error, self.fail_next_update = self.fail_next_update, None
            raise error
        if key not in self.rows:
            raise ResourceNotFoundError("entity not found")
        if etag is not None and match_condition in (MatchConditions.IfNotModified, None):
            if etag != self.etags.get(key):
                raise ResourceModifiedError("etag mismatch")
        if _is_replace(mode):
            self._store(key, dict(entity))
        else:
            merged = dict(self.rows[key])
            merged.update(entity)
            self._store(key, merged)

    def upsert_entity(self, entity, mode=None):
        key = (entity["PartitionKey"], entity["RowKey"])
        self.calls.append(("upsert_entity", key))
        if key not in self.rows or _is_replace(mode):
            self._store(key, dict(entity))
            return
        merged = dict(self.rows[key])
        merged.update(entity)
        self._store(key, merged)

    def delete_entity(self, partition_key, row_key):
        key = (partition_key, row_key)
        self.calls.append(("delete_entity", key))
        if key not in self.rows:
            raise ResourceNotFoundError("entity not found")
        del self.rows[key]
        self.etags.pop(key, None)

    def query_entities(self, query_filter, select=None, **kwargs):
        self.calls.append(("query_entities", query_filter))
        wanted_pk, row_key_ge, row_key_lt = _parse_filter(query_filter)
        results = []
        for (pk, rk), row in sorted(self.rows.items()):
            if wanted_pk is not None and pk != wanted_pk:
                continue
            if row_key_ge is not None and rk < row_key_ge:
                continue
            if row_key_lt is not None and rk >= row_key_lt:
                continue
            results.append(FakeEntity(row, {"etag": self.etags[(pk, rk)]}))
        return results

    # -- test conveniences ------------------------------------------------
    def rows_with_pk(self, partition_key):
        return [row for (pk, _rk), row in self.rows.items() if pk == partition_key]


def _is_replace(mode) -> bool:
    value = getattr(mode, "value", mode)
    return isinstance(value, str) and value.lower() == "replace"


def _parse_filter(query_filter: str):
    """`PartitionKey eq 'x'[ and RowKey ge 'a' and RowKey lt 'b']` -> parts."""
    partition_key = None
    match = re.search(r"PartitionKey eq '([^']*)'", query_filter)
    if match:
        partition_key = match.group(1)

    def _bound(operator):
        found = re.search(rf"RowKey {operator} '([^']*)'", query_filter)
        return found.group(1) if found else None

    return partition_key, _bound("ge"), _bound("lt")


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
        if self._container.fail_next_download is not None:
            error = self._container.fail_next_download
            self._container.fail_next_download = None
            raise error
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
        self.fail_next_download: Exception | None = None
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
