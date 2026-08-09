"""The shared competition file pool: /api/competitions/{id}/files[/{name}].

The pool is the one place where files cross tool boundaries, so the two things
that must never slip are (a) the same gate as every other route and (b) the
filename: it becomes a blob path, so a name that escaped the competition's own
prefix would be a cross-competition write. Everything else here pins the wire
shape the tools read.
"""
import function_app as fa
from conftest import PROXY_SECRET, make_request, payload

PDF = b"%PDF-1.7 fake pdf bytes"
FILENAME = "FSKWSINGLES-----------QUAL000100--_SegmentResults.pdf"


# ── helpers ───────────────────────────────────────────────────────────────────

def create_competition(name="Winter Cup 2026"):
    return payload(fa._create_competition(make_request("POST", body={"name": name})))


def upload(competition_id, filename=FILENAME, data=PDF, source_tool="protocolgenerator",
           **kwargs):
    params = {"filename": filename}
    if source_tool is not None:
        params["sourceTool"] = source_tool
    params.update(kwargs.pop("params", {}))
    return fa._upload_competition_file(make_request(
        "POST", f"/api/competitions/{competition_id}/files",
        raw_body=data, params=params,
        route_params={"id": competition_id}, **kwargs))


def listing(competition_id, **kwargs):
    return fa._list_competition_files(make_request(
        "GET", f"/api/competitions/{competition_id}/files",
        route_params={"id": competition_id}, **kwargs))


def download(competition_id, name=FILENAME, **kwargs):
    return fa._download_competition_file(make_request(
        "GET", f"/api/competitions/{competition_id}/files/{name}",
        route_params={"id": competition_id, "name": name}, **kwargs))


def delete(competition_id, name=FILENAME, **kwargs):
    return fa._delete_competition_file(make_request(
        "DELETE", f"/api/competitions/{competition_id}/files/{name}",
        route_params={"id": competition_id, "name": name}, **kwargs))


def put_fsm_blob(blobs, competition_id, name, data=b"fsm bytes", metadata=None):
    """Seed a blob under the ingest-owned prefix, which no route can write."""
    blobs.upload_blob(
        name=fa.competition_fsm_prefix(competition_id) + name,
        data=data,
        overwrite=True,
        metadata=metadata or {"uploadedBy": "fsm@example.com", "sourceTool": "fsm"},
        content_settings=None,
    )


# ── auth gate ─────────────────────────────────────────────────────────────────

ROUTES = [
    ("list", fa._list_competition_files, "GET", {"route_params": {"id": "abc"}}),
    ("upload", fa._upload_competition_file, "POST",
     {"raw_body": PDF, "params": {"filename": FILENAME}, "route_params": {"id": "abc"}}),
    ("download", fa._download_competition_file, "GET",
     {"route_params": {"id": "abc", "name": FILENAME}}),
    ("delete", fa._delete_competition_file, "DELETE",
     {"route_params": {"id": "abc", "name": FILENAME}}),
]


def _assert_all_routes_401(table, blobs, **request_kwargs):
    for name, handler, method, kwargs in ROUTES:
        response = handler(make_request(method, **{**kwargs, **request_kwargs}))
        assert response.status_code == 401, f"{name} did not reject the request"
        assert payload(response)["error"] == "unauthorized", name
    assert table.calls == [], "a rejected request still hit the table"
    assert blobs.calls == [], "a rejected request still hit blob storage"


def test_file_routes_reject_a_request_without_the_proxy_secret(table, blobs):
    _assert_all_routes_401(table, blobs, proxy_secret=None)


def test_file_routes_reject_a_request_with_the_wrong_proxy_secret(table, blobs):
    _assert_all_routes_401(table, blobs, proxy_secret="not-the-secret")


def test_file_routes_reject_a_proxied_request_without_an_identity(table, blobs):
    _assert_all_routes_401(table, blobs, user_email=None)


def test_the_easy_auth_principal_name_header_identifies_the_uploader(table, blobs):
    competition = create_competition()
    response = upload(competition["id"], user_email=None,
                      headers={"x-ms-client-principal-name": "coach@example.com"})
    assert payload(response)["uploadedBy"] == "coach@example.com"


# ── upload -> list -> download roundtrip ──────────────────────────────────────

def test_upload_stores_the_file_under_the_competitions_upload_prefix(table, blobs):
    competition = create_competition()

    response = upload(competition["id"])

    assert response.status_code == 201
    assert set(blobs.blobs) == {fa.competition_upload_prefix(competition["id"]) + FILENAME}


def test_upload_returns_the_file_info_shape(table, blobs):
    competition = create_competition()

    info = payload(upload(competition["id"]))

    assert set(info) == {"name", "source", "size", "contentType",
                         "uploadedUtc", "uploadedBy", "sourceTool"}
    assert info["name"] == FILENAME
    assert info["source"] == "upload"
    assert info["size"] == len(PDF)
    assert info["contentType"] == "application/pdf"
    assert info["uploadedBy"] == "skater@example.com"
    assert info["sourceTool"] == "protocolgenerator"
    assert info["uploadedUtc"].endswith("Z")


def test_upload_records_who_uploaded_it_and_from_where(table, blobs):
    competition = create_competition()
    upload(competition["id"], filename="Käsiohjelma #1.pdf")

    blob = next(iter(blobs.blobs.values()))
    assert blob.metadata["uploadedBy"] == "skater@example.com"
    assert blob.metadata["sourceTool"] == "protocolgenerator"
    # The original name survives verbatim (percent-encoded) even when the blob
    # name had to be sanitized.
    assert blob.metadata["origName"] == "K%C3%A4siohjelma%20%231.pdf"
    assert blob.content_type == "application/pdf"


def test_uploaded_files_come_back_from_the_listing(table, blobs):
    competition = create_competition()
    upload(competition["id"])
    upload(competition["id"], filename="startlist.xml", data=b"<xml/>", source_tool="judgepapers")

    files = payload(listing(competition["id"]))["files"]

    assert [f["name"] for f in files] == [FILENAME, "startlist.xml"]
    assert [f["source"] for f in files] == ["upload", "upload"]
    assert [f["sourceTool"] for f in files] == ["protocolgenerator", "judgepapers"]
    assert [f["contentType"] for f in files] == ["application/pdf", "application/xml"]
    assert [f["size"] for f in files] == [len(PDF), len(b"<xml/>")]
    assert all(f["uploadedBy"] == "skater@example.com" for f in files)
    assert all(f["uploadedUtc"].endswith("Z") for f in files)


def test_the_listing_only_shows_this_competitions_files(table, blobs):
    mine = create_competition("Winter Cup 2026")
    theirs = create_competition("Spring Trophy")
    upload(mine["id"])
    upload(theirs["id"], filename="other.pdf")

    assert [f["name"] for f in payload(listing(mine["id"]))["files"]] == [FILENAME]


def test_an_empty_pool_lists_nothing(table, blobs):
    competition = create_competition()
    response = listing(competition["id"])
    assert response.status_code == 200
    assert payload(response) == {"files": []}


def test_download_returns_the_bytes_and_the_content_type(table, blobs):
    competition = create_competition()
    upload(competition["id"])

    response = download(competition["id"])

    assert response.status_code == 200
    assert response.get_body() == PDF
    assert response.mimetype == "application/pdf"
    assert FILENAME in response.headers["Content-Disposition"]


def test_downloading_a_missing_file_is_a_404(table, blobs):
    competition = create_competition()
    response = download(competition["id"], name="nothing-here.pdf")
    assert response.status_code == 404
    assert payload(response)["error"] == "file_not_found"


def test_file_routes_of_an_unknown_competition_are_a_404(table, blobs):
    assert listing("no-such-id").status_code == 404
    assert upload("no-such-id").status_code == 404
    assert download("no-such-id").status_code == 404
    assert delete("no-such-id").status_code == 404
    assert blobs.blobs == {}


# ── overwrite ─────────────────────────────────────────────────────────────────

def test_re_uploading_the_same_filename_replaces_the_file(table, blobs):
    competition = create_competition()
    upload(competition["id"], data=b"first version")

    response = upload(competition["id"], data=b"second version, longer",
                      source_tool="judgepapers")

    assert response.status_code == 201
    assert len(blobs.blobs) == 1
    assert download(competition["id"]).get_body() == b"second version, longer"
    listed = payload(listing(competition["id"]))["files"][0]
    assert listed["size"] == len(b"second version, longer")
    assert listed["sourceTool"] == "judgepapers"


# ── size cap ──────────────────────────────────────────────────────────────────

def test_an_oversized_body_is_rejected(table, blobs):
    competition = create_competition()

    response = upload(competition["id"], data=b"x" * (fa.POOL_MAX_FILE_SIZE + 1))

    assert response.status_code == 413
    assert payload(response)["error"] == "file_too_large"
    assert blobs.blobs == {}


def test_an_oversized_content_length_is_rejected_before_the_body_is_read(table, blobs):
    competition = create_competition()

    response = upload(competition["id"],
                      headers={"content-length": str(fa.POOL_MAX_FILE_SIZE + 1)})

    assert response.status_code == 413
    assert payload(response)["error"] == "file_too_large"
    # Refused before the competition was even looked up.
    assert ("get_entity", (fa.PK_COMPETITION, competition["id"])) not in table.calls
    assert blobs.blobs == {}


def test_an_empty_upload_is_rejected(table, blobs):
    competition = create_competition()
    response = upload(competition["id"], data=b"")
    assert response.status_code == 400
    assert payload(response)["error"] == "empty_file"
    assert blobs.blobs == {}


# ── filename sanitization ─────────────────────────────────────────────────────

def test_a_traversing_filename_cannot_escape_the_competition_prefix(table, blobs):
    competition = create_competition()

    response = upload(competition["id"], filename="../../other-competition/uploads/evil.pdf")

    assert response.status_code == 201
    assert payload(response)["name"] == "evil.pdf"
    assert set(blobs.blobs) == {fa.competition_upload_prefix(competition["id"]) + "evil.pdf"}


def test_windows_separators_are_flattened_too(table, blobs):
    competition = create_competition()

    assert payload(upload(competition["id"], filename=r"..\..\evil.pdf"))["name"] == "evil.pdf"


def test_url_and_header_breaking_characters_are_stripped(table, blobs):
    competition = create_competition()

    info = payload(upload(competition["id"], filename='we%ird#na?me"s.pdf'))

    assert info["name"] == "weirdnames.pdf"


def test_an_unsupported_extension_is_rejected(table, blobs):
    competition = create_competition()

    for filename in ("results.exe", "results.zip", "results"):
        response = upload(competition["id"], filename=filename)
        assert response.status_code == 400, filename
        assert payload(response)["error"] == "unsupported_type", filename
    assert blobs.blobs == {}


def test_every_allowed_extension_gets_its_content_type(table, blobs):
    competition = create_competition()

    for extension, content_type in fa.POOL_CONTENT_TYPES.items():
        info = payload(upload(competition["id"], filename=f"file{extension}"))
        assert info["contentType"] == content_type, extension


def test_an_overlong_filename_is_rejected(table, blobs):
    competition = create_competition()

    long_enough = "a" * (fa.MAX_FILENAME_LENGTH - 4) + ".pdf"
    too_long = "a" * (fa.MAX_FILENAME_LENGTH - 3) + ".pdf"

    assert upload(competition["id"], filename=long_enough).status_code == 201
    response = upload(competition["id"], filename=too_long)
    assert response.status_code == 400
    assert payload(response)["error"] == "invalid_filename"


def test_a_missing_or_empty_filename_is_rejected(table, blobs):
    competition = create_competition()

    for filename in (None, "", "   ", ".."):
        response = upload(competition["id"], filename=filename)
        assert response.status_code == 400, filename
        assert payload(response)["error"] == "invalid_filename", filename
    assert blobs.blobs == {}


def test_a_traversing_download_name_is_rejected(table, blobs):
    competition = create_competition()

    for name in ("../uploads/secret.pdf", "..", "sub/dir.pdf"):
        response = download(competition["id"], name=name)
        assert response.status_code == 400, name
        assert payload(response)["error"] == "invalid_filename", name


# ── delete ────────────────────────────────────────────────────────────────────

def test_delete_removes_the_file_from_the_pool(table, blobs):
    competition = create_competition()
    upload(competition["id"])

    response = delete(competition["id"])

    assert response.status_code == 200
    assert payload(response)["status"] == "deleted"
    assert blobs.blobs == {}
    assert payload(listing(competition["id"]))["files"] == []


def test_deleting_a_missing_file_is_a_404(table, blobs):
    competition = create_competition()
    response = delete(competition["id"], name="nothing-here.pdf")
    assert response.status_code == 404
    assert payload(response)["error"] == "file_not_found"


# ── the FSM prefix is readable but never writable ─────────────────────────────

def test_fsm_files_appear_in_the_listing_tagged_as_fsm(table, blobs):
    competition = create_competition()
    upload(competition["id"])
    put_fsm_blob(blobs, competition["id"], "datafeed.xml")

    files = payload(listing(competition["id"]))["files"]

    assert {(f["name"], f["source"]) for f in files} == {
        (FILENAME, "upload"), ("datafeed.xml", "fsm")}
    fsm_file = next(f for f in files if f["source"] == "fsm")
    assert fsm_file["sourceTool"] == "fsm"
    assert fsm_file["uploadedBy"] == "fsm@example.com"


def test_an_fsm_file_can_be_downloaded_by_asking_for_that_source(table, blobs):
    competition = create_competition()
    put_fsm_blob(blobs, competition["id"], "datafeed.xml", data=b"<feed/>")

    # Without ?source it looks in uploads/, where the file is not.
    assert download(competition["id"], name="datafeed.xml").status_code == 404

    response = download(competition["id"], name="datafeed.xml", params={"source": "fsm"})
    assert response.status_code == 200
    assert response.get_body() == b"<feed/>"


def test_an_fsm_file_cannot_be_deleted(table, blobs):
    competition = create_competition()
    put_fsm_blob(blobs, competition["id"], "datafeed.xml")

    response = delete(competition["id"], name="datafeed.xml", params={"source": "fsm"})

    assert response.status_code == 403
    assert payload(response)["error"] == "fsm_readonly"
    assert len(blobs.blobs) == 1


def test_an_unknown_source_is_rejected(table, blobs):
    competition = create_competition()
    assert payload(download(competition["id"], params={"source": "elsewhere"}))["error"] \
        == "invalid_source"
    assert payload(delete(competition["id"], params={"source": "elsewhere"}))["error"] \
        == "invalid_source"


# ── soft-deleted competitions ─────────────────────────────────────────────────

def test_a_soft_deleted_competition_accepts_no_new_files(table, blobs):
    competition = create_competition("Cancelled Cup")
    upload(competition["id"])
    fa._delete_competition(make_request("DELETE", route_params={"id": competition["id"]}))

    response = upload(competition["id"], filename="late-arrival.pdf")

    assert response.status_code == 409
    assert payload(response)["error"] == "competition_deleted"
    assert len(blobs.blobs) == 1


def test_a_soft_deleted_competitions_files_stay_readable(table, blobs):
    competition = create_competition("Cancelled Cup")
    upload(competition["id"])
    fa._delete_competition(make_request("DELETE", route_params={"id": competition["id"]}))

    assert listing(competition["id"]).status_code == 200
    assert [f["name"] for f in payload(listing(competition["id"]))["files"]] == [FILENAME]
    assert download(competition["id"]).status_code == 200


def test_a_soft_deleted_competitions_files_cannot_be_deleted(table, blobs):
    competition = create_competition("Cancelled Cup")
    upload(competition["id"])
    fa._delete_competition(make_request("DELETE", route_params={"id": competition["id"]}))

    response = delete(competition["id"])

    assert response.status_code == 409
    assert payload(response)["error"] == "competition_deleted"
    assert len(blobs.blobs) == 1


# ── storage misconfiguration ──────────────────────────────────────────────────

def test_a_missing_blob_client_is_a_500_not_a_crash(table, monkeypatch):
    competition = create_competition()
    monkeypatch.setattr(fa, "get_blob_service_client", lambda *a, **kw: None)

    for response in (listing(competition["id"]), upload(competition["id"]),
                     download(competition["id"]), delete(competition["id"])):
        assert response.status_code == 500
        assert payload(response)["error"] == "storage_unavailable"


def test_the_proxy_gate_is_enforced_for_file_routes(table, blobs):
    """Guards against the fixture silently stopping to set the secret."""
    assert PROXY_SECRET
    competition = create_competition()
    assert upload(competition["id"], proxy_secret=None).status_code == 401
