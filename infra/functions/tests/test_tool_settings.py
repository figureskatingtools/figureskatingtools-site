"""A browser tool's remembered settings: /api/competitions/{id}/settings/{tool}.

The banner generator runs entirely in the browser, so what someone typed into
it would be gone with the tab. The platform keeps one opaque JSON object per
competition and tool instead, under the competition's own blob prefix: shared
like the competition itself (read to load, write to save), never in the file
pool, and deleted with everything else when the competition goes. The access
matrix for both routes lives in test_access.py.
"""
import json

import function_app as fa
from conftest import make_request, payload

SETTINGS = {"v": 1, "title": "WINTER CUP 2026", "titleSize": 48, "clubBubble": True,
            "club": {"file": "htl.png"}}


def create_competition(name="Winter Cup 2026"):
    return payload(fa._create_competition(make_request("POST", body={"name": name})))


def get(competition_id, tool="banner", **kwargs):
    return fa._get_tool_settings(make_request(
        "GET", f"/api/competitions/{competition_id}/settings/{tool}",
        route_params={"id": competition_id, "tool": tool}, **kwargs))


def put(competition_id, settings=SETTINGS, tool="banner", **kwargs):
    if "raw_body" not in kwargs and "body" not in kwargs:
        kwargs["body"] = {"settings": settings}
    return fa._put_tool_settings(make_request(
        "PUT", f"/api/competitions/{competition_id}/settings/{tool}",
        route_params={"id": competition_id, "tool": tool}, **kwargs))


def test_nothing_saved_reads_as_null(table, blobs):
    cid = create_competition()["id"]
    response = get(cid)
    assert response.status_code == 200
    assert payload(response) == {"tool": "banner", "settings": None, "updatedUtc": ""}


def test_saved_settings_read_back(table, blobs):
    cid = create_competition()["id"]
    saved = put(cid)
    assert saved.status_code == 200
    assert payload(saved)["settings"] == SETTINGS

    got = payload(get(cid))
    assert got["settings"] == SETTINGS
    assert got["updatedUtc"]


def test_a_save_replaces_the_whole_object(table, blobs):
    cid = create_competition()["id"]
    put(cid)
    put(cid, {"v": 1, "title": "SPRING"})
    assert payload(get(cid))["settings"] == {"v": 1, "title": "SPRING"}


def test_settings_live_under_the_competition_prefix_outside_the_pool(table, blobs):
    cid = create_competition()["id"]
    put(cid)
    name = f"{cid}/settings/banner.json"
    assert json.loads(blobs.blobs[name].data) == SETTINGS

    files = payload(fa._list_competition_files(make_request(
        "GET", route_params={"id": cid})))["files"]
    assert files == []


def test_no_personal_data_is_stored_with_them(table, blobs):
    cid = create_competition()["id"]
    put(cid)
    blob = blobs.blobs[f"{cid}/settings/banner.json"]
    assert not blob.metadata


def test_an_unknown_tool_is_a_404(table, blobs):
    cid = create_competition()["id"]
    for handler in (get, put):
        response = handler(cid, tool="judgepapers")
        assert (response.status_code, payload(response)["error"]) == (404, "unknown_tool")
    assert not [n for n in blobs.blobs if "/settings/" in n]


def test_the_tool_name_never_becomes_a_path(table, blobs):
    cid = create_competition()["id"]
    for tool in ("../banner", "banner/x", "BANNER/..", ""):
        assert put(cid, tool=tool).status_code == 404, tool
    assert not [n for n in blobs.blobs if "/settings/" in n]


def test_the_body_must_carry_a_settings_object(table, blobs):
    cid = create_competition()["id"]
    for body in ({}, {"settings": None}, {"settings": [1, 2]}, {"settings": "x"}):
        response = put(cid, body=body)
        assert (response.status_code, payload(response)["error"]) == (400, "invalid_settings"), body
    response = put(cid, raw_body=b"not json")
    assert payload(response)["error"] == "invalid_settings"


def test_oversized_settings_are_refused(table, blobs):
    cid = create_competition()["id"]
    response = put(cid, {"logo": "x" * fa.TOOL_SETTINGS_MAX_BYTES})
    assert (response.status_code, payload(response)["error"]) == (413, "settings_too_large")
    assert payload(get(cid))["settings"] is None


def test_a_deleted_competition_is_read_only(table, blobs):
    cid = create_competition()["id"]
    put(cid)
    fa._delete_competition(make_request("DELETE", route_params={"id": cid}))

    response = put(cid, {"v": 1})
    assert (response.status_code, payload(response)["error"]) == (409, "competition_deleted")
    assert payload(get(cid))["settings"] == SETTINGS


def test_unreadable_stored_settings_read_as_null(table, blobs):
    cid = create_competition()["id"]
    blobs.upload_blob(name=f"{cid}/settings/banner.json", data=b"[1, 2", overwrite=True)
    assert payload(get(cid))["settings"] is None


def test_purge_removes_them(table, blobs):
    cid = create_competition()["id"]
    put(cid)
    deleted, ok = fa._delete_competition_blobs(blobs, cid)
    assert ok and deleted == 1
    assert payload(get(cid))["settings"] is None
