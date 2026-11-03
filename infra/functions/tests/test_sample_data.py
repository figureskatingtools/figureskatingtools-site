"""The synthetic sample datasets: GET /api/sample-datasets and
POST /api/competitions/{id}/sample-data (test environment only).

The import writes static files from sample_data/ into a competition's
uploads/, skipping the upload route's birth-date stripping, so what must never
slip is (a) the SAMPLE_DATA_ENABLED gate and the usual access gate, (b) the
manifest: a path in it becomes a file read and a blob name, and (c) the
committed files themselves, which must be ones the upload route would have
stored byte for byte.
"""
import json
import os

import pytest

import function_app as fa
from conftest import ADMIN_EMAIL, USER_EMAIL, make_request, payload

READER = "reader@example.com"
WRITER = "writer@example.com"
STRANGER = "stranger@example.com"
COMMITTED_DIR = fa.SAMPLE_DATA_DIR


@pytest.fixture(autouse=True)
def _fresh_manifest_cache():
    fa._SAMPLE_MANIFEST_CACHE.clear()
    yield
    fa._SAMPLE_MANIFEST_CACHE.clear()


@pytest.fixture
def enabled(monkeypatch):
    # Bicep's string(true) is "True".
    monkeypatch.setenv("SAMPLE_DATA_ENABLED", "True")


# ── a small manifest of our own ───────────────────────────────────────────────

def write_dataset(root, manifest=None, files=None):
    """A sample_data directory with two datasets ("alpha", "beta") unless
    `manifest` says otherwise; `files` maps relative path -> bytes."""
    files = files if files is not None else {
        "datasets/alpha/alpha--_Results.pdf": b"%PDF-1.7 alpha",
        "datasets/beta/beta--_Results.pdf": b"%PDF-1.7 beta",
        "combined/alpha/DT_PARTIC_A.xml": b'<OdfBody DocumentType="DT_PARTIC"/>',
        "combined/beta/DT_PARTIC_B.xml": b'<OdfBody DocumentType="DT_PARTIC"/>',
        "combined/alpha-beta/DT_PARTIC_AB.xml": b'<OdfBody DocumentType="DT_PARTIC"/>',
    }
    manifest = manifest if manifest is not None else {
        "version": 1,
        "datasets": [
            {"id": "beta", "label": "Beta", "description": "Second"},
            {"id": "alpha", "label": "Alpha", "description": "First"},
        ],
        "combinations": {
            "alpha": ["datasets/alpha/alpha--_Results.pdf", "combined/alpha/DT_PARTIC_A.xml"],
            "beta": ["datasets/beta/beta--_Results.pdf", "combined/beta/DT_PARTIC_B.xml"],
            "alpha-beta": ["datasets/alpha/alpha--_Results.pdf",
                           "datasets/beta/beta--_Results.pdf",
                           "combined/alpha-beta/DT_PARTIC_AB.xml"],
        },
    }
    for relative, data in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return manifest


@pytest.fixture
def dataset(tmp_path, monkeypatch):
    root = tmp_path / "sample_data"
    root.mkdir()
    write_dataset(root)
    monkeypatch.setattr(fa, "SAMPLE_DATA_DIR", root)
    return root


# ── helpers ───────────────────────────────────────────────────────────────────

def create_competition(name="Winter Cup 2026"):
    return payload(fa._create_competition(make_request("POST", body={"name": name})))


def list_datasets(**kwargs):
    return fa._list_sample_datasets(make_request("GET", "/api/sample-datasets", **kwargs))


def import_data(competition_id, datasets=("alpha",), body=None, **kwargs):
    return fa._import_sample_data(make_request(
        "POST", f"/api/competitions/{competition_id}/sample-data",
        body=body if body is not None else {"datasets": list(datasets)},
        route_params={"id": competition_id}, **kwargs))


def stored(blobs, competition_id):
    prefix = fa.competition_upload_prefix(competition_id)
    return {name[len(prefix):]: blob for name, blob in blobs.blobs.items()
            if name.startswith(prefix)}


def share(table, competition_id, email, role):
    user_id = table.seed_user(email, email.split("@")[0].title())
    table.grant(competition_id, user_id, role)


# ── the gate ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("value", [None, "", "False", "false", "0", "no", "maybe"])
def test_both_routes_are_404_while_the_gate_is_off(table, blobs, dataset, monkeypatch, value):
    if value is None:
        monkeypatch.delenv("SAMPLE_DATA_ENABLED", raising=False)
    else:
        monkeypatch.setenv("SAMPLE_DATA_ENABLED", value)
    competition = create_competition()

    for response in (list_datasets(), import_data(competition["id"])):
        assert response.status_code == 404
        assert payload(response)["error"] == "not_found"
    assert stored(blobs, competition["id"]) == {}


@pytest.mark.parametrize("value", ["True", "true", "1", "yes"])
def test_the_gate_reads_bicep_booleans(monkeypatch, value):
    monkeypatch.setenv("SAMPLE_DATA_ENABLED", value)
    assert fa._sample_data_enabled() is True


def test_both_routes_still_need_a_signed_in_user(table, blobs, dataset, enabled):
    assert list_datasets(proxy_secret=None).status_code == 401
    assert import_data("abc", proxy_secret=None).status_code == 401
    assert blobs.calls == []


def test_admin_diagnostics_show_the_gate(table, blobs, admin, enabled):
    response = fa._admin_diagnostics(make_request("GET", user_email=ADMIN_EMAIL))
    assert payload(response)["config"]["sampleDataEnabled"] is True


# ── listing ───────────────────────────────────────────────────────────────────

def test_the_listing_returns_the_manifest_datasets_in_order(table, dataset, enabled):
    response = list_datasets()
    assert response.status_code == 200
    assert payload(response) == {"items": [
        {"id": "beta", "label": "Beta", "description": "Second"},
        {"id": "alpha", "label": "Alpha", "description": "First"},
    ]}


def test_a_broken_manifest_is_a_500_not_a_crash(table, dataset, enabled):
    (dataset / "manifest.json").write_text("{not json", encoding="utf-8")
    response = list_datasets()
    assert response.status_code == 500
    assert payload(response)["error"] == "sample_data_unavailable"


# ── import ────────────────────────────────────────────────────────────────────

def test_import_writes_the_combination_into_uploads(table, blobs, dataset, enabled):
    competition = create_competition()

    response = import_data(competition["id"], ["beta", "alpha"])

    assert response.status_code == 201
    files = payload(response)["files"]
    assert [f["name"] for f in files] == [
        "alpha--_Results.pdf", "beta--_Results.pdf", "DT_PARTIC_AB.xml"]
    assert all(f["source"] == "upload" and f["sourceTool"] == "sample" for f in files)
    assert all(f["uploadedBy"] == USER_EMAIL for f in files)
    assert [f["contentType"] for f in files] == [
        "application/pdf", "application/pdf", "application/xml"]

    blobs_by_name = stored(blobs, competition["id"])
    assert set(blobs_by_name) == {"alpha--_Results.pdf", "beta--_Results.pdf", "DT_PARTIC_AB.xml"}
    blob = blobs_by_name["DT_PARTIC_AB.xml"]
    assert blob.data == (dataset / "combined/alpha-beta/DT_PARTIC_AB.xml").read_bytes()
    assert blob.metadata == {"uploadedBy": USER_EMAIL, "sourceTool": "sample",
                             "origName": "DT_PARTIC_AB.xml"}
    assert blob.content_type == "application/xml"
    assert files[0]["size"] == len(b"%PDF-1.7 alpha")


def test_imported_files_show_in_the_file_listing(table, blobs, dataset, enabled):
    competition = create_competition()
    import_data(competition["id"], ["alpha"])
    listing = payload(fa._list_competition_files(make_request(
        "GET", route_params={"id": competition["id"]})))["files"]
    assert [(f["name"], f["sourceTool"]) for f in listing] == [
        ("alpha--_Results.pdf", "sample"), ("DT_PARTIC_A.xml", "sample")]


def test_import_overwrites_same_named_files(table, blobs, dataset, enabled):
    competition = create_competition()
    blobs.upload_blob(name=fa.competition_upload_prefix(competition["id"]) + "DT_PARTIC_A.xml",
                      data=b"old", overwrite=True, metadata={"uploadedBy": "x"})

    assert import_data(competition["id"], ["alpha"]).status_code == 201
    assert stored(blobs, competition["id"])["DT_PARTIC_A.xml"].data == \
        b'<OdfBody DocumentType="DT_PARTIC"/>'


def test_import_skips_the_birth_date_stripping(table, blobs, dataset, enabled, monkeypatch):
    def refuse(_body):
        raise AssertionError("sample files are trusted static assets")
    monkeypatch.setattr(fa, "_strip_upload_birth_dates", refuse)
    competition = create_competition()
    assert import_data(competition["id"], ["alpha"]).status_code == 201


@pytest.mark.parametrize("body", [
    {"datasets": []},
    {"datasets": ["gamma"]},
    {"datasets": ["alpha", "gamma"]},
    {"datasets": ["alpha", "alpha"]},
    {"datasets": "alpha"},
    {"datasets": [1]},
    {"datasets": None},
    {},
    ["alpha"],
])
def test_an_unusable_selection_is_a_400(table, blobs, dataset, enabled, body):
    competition = create_competition()
    response = import_data(competition["id"], body=body)
    assert response.status_code == 400
    assert payload(response)["error"] == "invalid_dataset"
    assert stored(blobs, competition["id"]) == {}


def test_a_deleted_competition_takes_no_sample_data(table, blobs, dataset, enabled):
    competition = create_competition()
    fa._delete_competition(make_request("DELETE", route_params={"id": competition["id"]}))

    response = import_data(competition["id"])

    assert response.status_code == 409
    assert payload(response)["error"] == "competition_deleted"
    assert stored(blobs, competition["id"]) == {}


def test_an_unknown_or_malformed_id_is_a_404(table, blobs, dataset, enabled):
    for competition_id in ("not-a-guid", "4d7e0000-0000-4000-8000-000000000000"):
        response = import_data(competition_id)
        assert response.status_code == 404
        assert payload(response)["error"] == "not_found"
    assert blobs.blobs == {}


# ── access ────────────────────────────────────────────────────────────────────

def test_a_read_only_grantee_cannot_import(table, blobs, dataset, enabled):
    competition = create_competition()
    share(table, competition["id"], READER, "read")

    response = import_data(competition["id"], user_email=READER)

    assert response.status_code == 403
    assert payload(response)["error"] == "read_only"
    assert stored(blobs, competition["id"]) == {}


def test_a_write_grantee_can_import(table, blobs, dataset, enabled):
    competition = create_competition()
    share(table, competition["id"], WRITER, "write")

    response = import_data(competition["id"], user_email=WRITER)

    assert response.status_code == 201
    assert {f["uploadedBy"] for f in payload(response)["files"]} == {WRITER}


def test_someone_without_access_gets_a_404(table, blobs, dataset, enabled):
    competition = create_competition()
    table.seed_user(STRANGER, "Stranger")

    response = import_data(competition["id"], user_email=STRANGER)

    assert response.status_code == 404
    assert payload(response)["error"] == "not_found"
    assert stored(blobs, competition["id"]) == {}


def test_an_admin_import_without_an_own_grant_is_audited(table, blobs, dataset, enabled, admin):
    competition = create_competition()
    table.seed_user(ADMIN_EMAIL, "Admin")
    table.adminlog.rows.clear()

    assert import_data(competition["id"], ["alpha", "beta"], user_email=ADMIN_EMAIL).status_code == 201

    [row] = [r for r in table.audit_rows() if r["Action"].startswith("admin.override.")]
    assert row["Action"] == "admin.override.file.upload"
    assert (row["Actor"], row["CompetitionId"]) == (ADMIN_EMAIL, competition["id"])
    assert json.loads(row["Changes"]) == {"sampleData": [None, "alpha-beta"]}


def test_an_owner_import_is_not_audited(table, blobs, dataset, enabled):
    competition = create_competition()
    table.adminlog.rows.clear()
    assert import_data(competition["id"]).status_code == 201
    assert table.audit_rows() == []


# ── manifest validation ───────────────────────────────────────────────────────

def test_the_manifest_is_loaded_once_and_cached(table, dataset, enabled):
    assert list_datasets().status_code == 200
    (dataset / "manifest.json").write_text("{not json", encoding="utf-8")
    assert list_datasets().status_code == 200


def test_combination_keys_are_the_sorted_ids():
    assert fa.sample_combination_key(["synchro", "icedance", "singles"]) == \
        "icedance-singles-synchro"


def _refused(root, match, **kwargs):
    write_dataset(root, **kwargs)
    with pytest.raises(fa.SampleManifestError, match=match):
        fa.load_sample_manifest(root)


def _manifest_with(**combination_overrides):
    manifest = {
        "version": 1,
        "datasets": [{"id": "alpha", "label": "Alpha", "description": ""}],
        "combinations": {"alpha": ["datasets/alpha/alpha--_Results.pdf"]},
    }
    manifest["combinations"].update(combination_overrides)
    return manifest


@pytest.mark.parametrize("path", [
    "../outside.pdf",
    "datasets/../../outside.pdf",
    "/etc/passwd.pdf",
    "datasets\\alpha\\alpha--_Results.pdf",
    "",
    ".",
    7,
])
def test_a_path_escaping_the_directory_is_refused(tmp_path, path):
    (tmp_path / "outside.pdf").write_bytes(b"%PDF outside")
    root = tmp_path / "sample_data"
    _refused(root, "escapes|bad path|missing", manifest=_manifest_with(alpha=[path]))


def test_a_symlink_pointing_outside_is_refused(tmp_path):
    (tmp_path / "outside.pdf").write_bytes(b"%PDF outside")
    root = tmp_path / "sample_data"
    write_dataset(root)
    os.symlink(tmp_path / "outside.pdf", root / "datasets" / "alpha" / "link.pdf")
    _refused(root, "escapes", manifest=_manifest_with(alpha=["datasets/alpha/link.pdf"]))


def test_a_missing_file_is_refused(tmp_path):
    _refused(tmp_path, "missing", manifest=_manifest_with(alpha=["datasets/alpha/nope.pdf"]))


@pytest.mark.parametrize("name", ["bad#name.pdf", "notes.txt", "noextension", 'quote".pdf'])
def test_a_name_the_upload_would_change_or_refuse_is_refused(tmp_path, name):
    files = {f"datasets/alpha/{name}": b"%PDF-1.7"}
    _refused(tmp_path, "unusable|unsupported",
             manifest=_manifest_with(alpha=[f"datasets/alpha/{name}"]), files=files)


def test_an_oversized_file_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(fa, "POOL_MAX_FILE_SIZE", 4)
    _refused(tmp_path, "too large", manifest=_manifest_with())


def test_a_repeated_basename_within_a_combination_is_refused(tmp_path):
    files = {"datasets/alpha/x.pdf": b"%PDF a", "combined/alpha/X.pdf": b"%PDF b"}
    _refused(tmp_path, "repeats",
             manifest=_manifest_with(alpha=["datasets/alpha/x.pdf", "combined/alpha/X.pdf"]),
             files=files)


def test_a_missing_or_extra_combination_is_refused(tmp_path):
    manifest = write_dataset(tmp_path)
    del manifest["combinations"]["alpha-beta"]
    _refused(tmp_path / "a", "combinations must be", manifest=manifest)
    manifest["combinations"]["alpha-beta"] = manifest["combinations"]["alpha"]
    manifest["combinations"]["beta-alpha"] = manifest["combinations"]["alpha"]
    _refused(tmp_path / "b", "combinations must be", manifest=manifest)


def test_an_empty_combination_is_refused(tmp_path):
    _refused(tmp_path, "lists no files", manifest=_manifest_with(alpha=[]))


@pytest.mark.parametrize("datasets, match", [
    ([], "no datasets"),
    ([{"id": "al-pha", "label": "A"}], "bad dataset id"),
    ([{"id": "Alpha", "label": "A"}], "bad dataset id"),
    ([{"id": "alpha", "label": ""}], "bad label"),
    ([{"id": "alpha", "label": "A", "description": 3}], "bad label"),
    ([{"id": "alpha", "label": "A"}, {"id": "alpha", "label": "B"}], "duplicate"),
    (["alpha"], "not an object"),
])
def test_bad_datasets_are_refused(tmp_path, datasets, match):
    manifest = _manifest_with()
    manifest["datasets"] = datasets
    _refused(tmp_path, match, manifest=manifest)


def test_an_unknown_version_is_refused(tmp_path):
    manifest = _manifest_with()
    manifest["version"] = 2
    _refused(tmp_path, "version", manifest=manifest)


# ── the committed dataset ─────────────────────────────────────────────────────

def _committed_files():
    manifest = fa.load_sample_manifest(COMMITTED_DIR)
    return {path for files in manifest["combinations"].values() for _name, path in files}


def test_the_committed_manifest_is_valid_and_offers_the_three_datasets():
    manifest = fa.load_sample_manifest(COMMITTED_DIR)
    assert [d["id"] for d in manifest["datasets"]] == ["synchro", "singles", "icedance"]
    assert all(d["label"] and d["description"] for d in manifest["datasets"])
    assert len(manifest["combinations"]) == 7


@pytest.mark.parametrize("path", sorted(_committed_files()), ids=lambda p: p.name)
def test_every_committed_file_is_one_the_upload_would_store_unchanged(path):
    data = path.read_bytes()
    assert data, path
    assert len(data) <= fa.POOL_MAX_FILE_SIZE
    assert fa.sanitize_pool_filename(path.name) == (path.name, "")
    assert fa._strip_upload_birth_dates(data) == data


def test_every_file_under_the_dataset_dirs_is_listed():
    """No stray file ships in the package without the manifest knowing it."""
    on_disk = {p.resolve() for sub in ("datasets", "combined")
               for p in (COMMITTED_DIR / sub).rglob("*") if p.is_file()}
    assert on_disk == _committed_files()
