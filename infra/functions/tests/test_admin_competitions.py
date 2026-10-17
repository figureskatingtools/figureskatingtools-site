"""The admin competition API: /api/manage/competitions/*.

Admins see every COMPETITION row (tombstones included), can move the deletion
date to any day from tomorrow on, restore a soft-deleted competition, purge one
now, and change its owner. Each write keeps the retention clock in step, since
the tools act on that table alone.
"""
from datetime import datetime, timedelta, timezone

import function_app as fa
from conftest import USER_EMAIL, make_request, payload

PDF = b"%PDF-1.7 fake pdf bytes"


# ── helpers ───────────────────────────────────────────────────────────────────

def today():
    now = datetime.now(timezone.utc)
    return datetime(now.year, now.month, now.day, tzinfo=timezone.utc)


def day(offset):
    return (today() + timedelta(days=offset)).strftime("%Y-%m-%d")


def midnight_text(offset):
    return f"{day(offset)}T00:00:00Z"


def create(name="Winter Cup 2026", **fields):
    return payload(fa._create_competition(make_request("POST", body={"name": name, **fields})))


def user_delete(competition_id):
    return fa._delete_competition(make_request("DELETE", route_params={"id": competition_id}))


def call(handler, admin, method, competition_id=None, **kwargs):
    route_params = {"id": competition_id} if competition_id else {}
    return handler(make_request(method, route_params=route_params, user_email=admin, **kwargs))


def admin_list(admin, status=None):
    params = {"status": status} if status else {}
    return call(fa._admin_list_competitions, admin, "GET", params=params)


def admin_get(admin, competition_id):
    return call(fa._admin_get_competition, admin, "GET", competition_id)


def admin_patch(admin, competition_id, body):
    return call(fa._admin_update_competition, admin, "PATCH", competition_id, body=body)


def admin_restore(admin, competition_id, body=None):
    return call(fa._admin_restore_competition, admin, "POST", competition_id, body=body)


def admin_purge(admin, competition_id, confirm):
    return call(fa._admin_purge_competition, admin, "POST", competition_id,
                body={"confirm": confirm})


def admin_delete(admin, competition_id):
    return call(fa._admin_delete_competition, admin, "DELETE", competition_id)


def row(table, competition_id):
    return table.rows[(fa.PK_COMPETITION, competition_id)]


def purged(table, admin, name="Gone Cup"):
    created = create(name)
    assert admin_purge(admin, created["id"], created["code"]).status_code == 200
    return created


# ── list ──────────────────────────────────────────────────────────────────────

def test_the_list_includes_active_deleted_and_purged_competitions(admin, table, blobs):
    active = create("Active Cup")
    deleted = create("Deleted Cup")
    user_delete(deleted["id"])
    gone = purged(table, admin)

    listed = payload(admin_list(admin))["competitions"]

    by_id = {c["id"]: c for c in listed}
    assert by_id[active["id"]]["status"] == "active"
    assert by_id[deleted["id"]]["status"] == "deleted"
    assert by_id[gone["id"]]["status"] == "purged"
    assert by_id[gone["id"]]["purgedUtc"]
    # The user list hides all but the active one.
    assert [c["id"] for c in payload(fa._list_competitions(make_request("GET")))] == [active["id"]]


def test_the_status_filter(admin, table, blobs):
    active = create("Active Cup")
    deleted = create("Deleted Cup")
    user_delete(deleted["id"])
    gone = purged(table, admin)

    def ids(status):
        return {c["id"] for c in payload(admin_list(admin, status))["competitions"]}

    assert ids("active") == {active["id"]}
    assert ids("deleted") == {deleted["id"]}
    assert ids("purged") == {gone["id"]}
    assert ids("all") == {active["id"], deleted["id"], gone["id"]}
    assert ids("ALL") == ids("all")


def test_an_unknown_status_filter_is_400(admin, table):
    response = admin_list(admin, "everything")
    assert response.status_code == 400
    assert payload(response)["error"] == "invalid_status"


def test_the_admin_wire_shape(admin, table):
    created = create("Shape Cup", date="2026-12-01", venue="Helsinki")

    competition = payload(admin_list(admin))["competitions"][0]

    assert competition["id"] == created["id"]
    assert competition["date"] == competition["startDate"] == "2026-12-01"
    assert competition["endDate"] is None
    assert competition["createdBy"] == USER_EMAIL
    assert competition["status"] == "active"
    assert competition["extendedCount"] == 0
    assert competition["lastExtendedUtc"] is None
    assert competition["deleteReason"] is None
    assert competition["deletedUtc"] is None
    assert competition["purgedUtc"] is None
    assert competition["deletionDate"] == created["deletionDate"]
    assert competition["clock"] == {"inSync": True, "deletionDate": created["deletionDate"],
                                    "status": "active", "purgedUtc": None}


def test_a_drifted_or_missing_clock_row_shows(admin, table):
    drifted = create("Drift Cup")
    missing = create("Missing Cup")
    table.clock.rows[(fa.PK_COMPETITION, drifted["id"])]["DeletionDate"] = "2030-01-01T00:00:00Z"
    del table.clock.rows[(fa.PK_COMPETITION, missing["id"])]

    by_id = {c["id"]: c for c in payload(admin_list(admin))["competitions"]}

    assert by_id[drifted["id"]]["clock"]["inSync"] is False
    assert by_id[missing["id"]]["clock"] is None


# ── detail ────────────────────────────────────────────────────────────────────

def test_the_detail_counts_files_and_hovtp_sources(admin, table, blobs):
    created = create()
    competition_id = created["id"]
    for name in ("uploads/a.pdf", "fsm/b.xml", "fsm-pending/20.31.4.7/c.pdf"):
        blobs.upload_blob(name=f"{competition_id}/{name}", data=PDF, overwrite=True)
    blobs.upload_blob(name=f"{competition_id}x/uploads/other.pdf", data=PDF, overwrite=True)
    for ip, status, until in (("20.31.4.7", "pending", ""), ("20.31.4.8", "accepted", "2099-01-01T00:00:00Z"),
                              ("20.31.4.9", "accepted", "2020-01-01T00:00:00Z"),
                              ("20.31.4.10", "rejected", "")):
        table.create_entity({"PartitionKey": fa.PK_HOVTP_SOURCE,
                             "RowKey": fa.hovtp_source_row_key(competition_id, ip),
                             "Ip": ip, "Status": status, "AcceptedUntilUtc": until})

    body = payload(admin_get(admin, competition_id))

    assert body["competition"]["id"] == competition_id
    assert body["files"] == {"count": 3, "bytes": 3 * len(PDF)}
    assert body["hovtp"] == {"pending": 1, "accepted": 1, "expired": 1, "rejected": 1}


def test_the_detail_of_an_unknown_competition_is_404(admin, table, blobs):
    response = admin_get(admin, "nope")
    assert response.status_code == 404
    assert payload(response)["error"] == "not_found"


# ── PATCH: deletion date, owner, the shared edit fields ───────────────────────

def test_a_deletion_date_before_tomorrow_is_rejected(admin, table):
    created = create()
    before = dict(row(table, created["id"]))

    for value in (day(0), day(-1), midnight_text(0), "2020-01-01", "tomorrow", "2026-02-30",
                  f"{day(5)}T12:00:00Z", 20261201, None):
        response = admin_patch(admin, created["id"], {"deletionDate": value})
        assert response.status_code == 400, value
        assert payload(response)["error"] == "invalid_deletion_date", value

    assert row(table, created["id"]) == before
    assert table.audit_rows() == []


def test_a_valid_deletion_date_is_written_and_synced_into_the_clock(admin, table):
    created = create()

    response = admin_patch(admin, created["id"], {"deletionDate": day(1)})

    assert response.status_code == 200
    competition = payload(response)["competition"]
    assert competition["deletionDate"] == midnight_text(1)
    assert row(table, created["id"])["DeletionDate"] == midnight_text(1)
    assert table.clock_rows()[created["id"]]["DeletionDate"] == midnight_text(1)
    assert competition["clock"]["inSync"] is True


def test_any_later_deletion_date_is_allowed_in_either_format(admin, table):
    created = create()

    assert admin_patch(admin, created["id"], {"deletionDate": "2099-12-31T00:00:00Z"}).status_code == 200
    assert table.clock_rows()[created["id"]]["DeletionDate"] == "2099-12-31T00:00:00Z"
    assert admin_patch(admin, created["id"], {"deletionDate": day(400)}).status_code == 200
    assert row(table, created["id"])["DeletionDate"] == midnight_text(400)


def test_the_user_patch_still_ignores_a_deletion_date(admin, table):
    created = create()
    fa._update_competition(make_request("PATCH", route_params={"id": created["id"]},
                                        body={"deletionDate": "2099-01-01"}))
    assert row(table, created["id"])["DeletionDate"] == created["deletionDate"]


def test_created_by_is_read_only_history(admin, table):
    """The owner is the competitionaccess owner row (PUT …/owner); CreatedBy
    only records who created it, so the admin PATCH refuses to touch it."""
    created = create()
    for value in (" owner@example.com ", "", None, 42):
        response = admin_patch(admin, created["id"], {"createdBy": value, "venue": "Tampere"})
        assert response.status_code == 400, value
        assert payload(response)["error"] == "created_by_read_only"
    assert row(table, created["id"])["CreatedBy"] == USER_EMAIL
    assert row(table, created["id"])["Venue"] == ""
    assert table.audit_rows() == []


def test_the_shared_fields_get_the_same_validation_and_code_move(admin, table):
    created = create("Winter Cup 2026")
    other = create("Spring Cup 2026")

    assert payload(admin_patch(admin, created["id"], {"name": ""}))["error"] == "invalid_name"
    assert payload(admin_patch(admin, created["id"], {"date": "17.1.2026"}))["error"] == "invalid_date"
    assert payload(admin_patch(admin, created["id"], {"code": "!!"}))["error"] == "invalid_code"
    conflict = admin_patch(admin, created["id"], {"code": other["code"]})
    assert conflict.status_code == 409
    assert payload(conflict)["error"] == "code_in_use"

    renamed = payload(admin_patch(admin, created["id"], {"code": "Winter Cup Renamed",
                                                         "startDate": "2026-02-01",
                                                         "venue": "Tampere"}))["competition"]
    assert renamed["code"] == "winter-cup-renamed"
    assert renamed["startDate"] == "2026-02-01"
    assert renamed["venue"] == "Tampere"
    assert set(table.code_rows()) == {"winter-cup-renamed", other["code"]}
    assert table.code_rows()["winter-cup-renamed"]["CompetitionId"] == created["id"]


def test_patch_on_a_deleted_or_unknown_competition(admin, table):
    created = create()
    user_delete(created["id"])

    deleted = admin_patch(admin, created["id"], {"deletionDate": day(3)})
    assert deleted.status_code == 409
    assert payload(deleted)["error"] == "deleted"
    assert admin_patch(admin, "nope", {"venue": "x"}).status_code == 404


def test_patch_retries_on_a_concurrent_write(admin, table):
    """An extend that lands between read and write must not be lost — and the
    retry recomputes the code claim instead of leaking a CODE row."""
    created = create()

    def competing_extend(client, key):
        client.rows[key]["ExtendedCount"] = 5
        client.etags[key] = client._next_etag()

    table.before_conditional_update = competing_extend
    response = admin_patch(admin, created["id"], {"code": "renamed-cup", "deletionDate": day(9)})

    assert response.status_code == 200
    stored = row(table, created["id"])
    assert stored["ExtendedCount"] == 5
    assert stored["Code"] == "renamed-cup"
    assert stored["DeletionDate"] == midnight_text(9)
    assert set(table.code_rows()) == {"renamed-cup"}


# ── restore ───────────────────────────────────────────────────────────────────

def test_restore_brings_a_soft_deleted_competition_back(admin, table):
    created = create()
    user_delete(created["id"])
    assert created["code"] not in table.code_rows()

    response = admin_restore(admin, created["id"])

    assert response.status_code == 200
    competition = payload(response)["competition"]
    assert competition["status"] == "active"
    assert competition["deleteReason"] is None
    assert competition["deletedUtc"] is None
    assert competition["deletionDate"] == midnight_text(fa.RESTORE_DEFAULT_DAYS)
    assert table.code_rows()[created["code"]]["CompetitionId"] == created["id"]
    clock = table.clock_rows()[created["id"]]
    assert (clock["Status"], clock["DeletionDate"]) == ("active", midnight_text(7))
    # Back in the user list too.
    assert [c["id"] for c in payload(fa._list_competitions(make_request("GET")))] == [created["id"]]


def test_restore_takes_a_deletion_date_from_the_body(admin, table):
    created = create()
    user_delete(created["id"])

    response = admin_restore(admin, created["id"], {"deletionDate": day(30)})

    assert payload(response)["competition"]["deletionDate"] == midnight_text(30)
    bad = admin_restore(admin, created["id"], {"deletionDate": day(0)})
    assert bad.status_code == 400
    assert payload(bad)["error"] == "invalid_deletion_date"


def test_restore_refuses_when_the_code_was_taken_meanwhile(admin, table):
    created = create("Winter Cup 2026")
    user_delete(created["id"])
    create("Winter Cup 2026")   # the freed code is reused

    response = admin_restore(admin, created["id"])

    assert response.status_code == 409
    assert payload(response)["error"] == "code_in_use"
    assert row(table, created["id"])["Status"] == "deleted"
    assert table.clock_rows()[created["id"]]["Status"] == "deleted"


def test_restore_succeeds_once_renamed_out_of_the_conflict(admin, table):
    """The admin's way out of code_in_use: rename isn't possible on a deleted
    row, so the other competition gets renamed instead, then restore works."""
    created = create("Winter Cup 2026")
    user_delete(created["id"])
    taker = create("Winter Cup 2026")
    assert admin_restore(admin, created["id"]).status_code == 409

    admin_patch(admin, taker["id"], {"code": "winter-cup-2026-b"})

    assert admin_restore(admin, created["id"]).status_code == 200


def test_restore_of_a_purged_competition_is_409(admin, table, blobs):
    gone = purged(table, admin)
    response = admin_restore(admin, gone["id"])
    assert response.status_code == 409
    assert payload(response)["error"] == "purged"


def test_restore_of_an_active_competition_is_409(admin, table):
    created = create()
    response = admin_restore(admin, created["id"])
    assert response.status_code == 409
    assert payload(response)["error"] == "not_deleted"
    assert admin_restore(admin, "nope").status_code == 404


# ── purge ─────────────────────────────────────────────────────────────────────

def test_purge_needs_the_code_typed_to_confirm(admin, table, blobs):
    created = create()
    before = dict(row(table, created["id"]))

    for confirm in ("wrong-code", "", None):
        response = admin_purge(admin, created["id"], confirm)
        assert response.status_code == 400
        assert payload(response)["error"] == "confirm_mismatch"

    assert row(table, created["id"]) == before


def test_purge_leaves_a_tombstone_like_the_sweep(admin, table, blobs, monkeypatch):
    # The kill switch guards the unattended sweep, not an explicit admin purge.
    monkeypatch.setenv("RETENTION_PURGE_ENABLED", "false")
    created = create("Winter Cup 2026")
    competition_id = created["id"]
    blobs.upload_blob(name=f"{competition_id}/uploads/a.pdf", data=PDF, overwrite=True)
    table.create_entity({"PartitionKey": fa.PK_HOVTP_SOURCE,
                         "RowKey": fa.hovtp_source_row_key(competition_id, "20.31.4.7"),
                         "Ip": "20.31.4.7", "AcceptedBy": USER_EMAIL})

    # normalize_code on the confirmation: the display spelling works too.
    response = admin_purge(admin, competition_id, "WINTER cup 2026")

    assert response.status_code == 200
    competition = payload(response)["competition"]
    assert competition["status"] == "purged"
    assert competition["purgedUtc"]
    assert competition["createdBy"] is None
    assert competition["deleteReason"] == "user"
    stone = row(table, competition_id)
    assert not any("@" in str(value) for value in stone.values())
    assert stone["PurgedUtc"] and stone["Status"] == "deleted"
    assert blobs.blobs == {}
    assert table.hovtp_source_rows() == []
    assert created["code"] not in table.code_rows()
    clock = table.clock_rows()[competition_id]
    assert clock["Status"] == "deleted" and clock["PurgedUtc"] == stone["PurgedUtc"]
    assert competition["clock"]["inSync"] is True


def test_purge_of_an_already_soft_deleted_competition(admin, table, blobs):
    created = create()
    user_delete(created["id"])

    response = admin_purge(admin, created["id"], created["code"])

    assert payload(response)["competition"]["status"] == "purged"


def test_a_second_purge_is_409(admin, table, blobs):
    gone = purged(table, admin)
    response = admin_purge(admin, gone["id"], gone["code"])
    assert response.status_code == 409
    assert payload(response)["error"] == "purged"


def test_a_failed_purge_is_500_and_leaves_no_tombstone(admin, table, blobs):
    created = create()
    blobs.upload_blob(name=f"{created['id']}/uploads/a.pdf", data=PDF, overwrite=True)
    blobs.fail_next_delete = RuntimeError("blob service down")

    response = admin_purge(admin, created["id"], created["code"])

    assert response.status_code == 500
    assert payload(response)["error"] == "purge_failed"
    assert "PurgedUtc" not in row(table, created["id"])
    assert row(table, created["id"])["Status"] == "deleted"


# ── restore vs purge, restore vs restore ──────────────────────────────────────

def on_conditional_update_of(table, competition_id, action):
    """Run `action` just before the next conditional write to this
    competition's row lands (re-armed past writes to other rows)."""
    key = (fa.PK_COMPETITION, competition_id)

    def hook(client, written):
        if written != key:
            client.before_conditional_update = hook
            return
        action()

    table.before_conditional_update = hook


def test_a_restore_landing_before_the_purge_claim_wins(admin, table, blobs, monkeypatch):
    """The sweep read the deleted row; a restore lands before its first write.
    The purge's claim is conditional even for a deleted row, so it backs off
    and the restored competition keeps its files and code."""
    monkeypatch.setenv("RETENTION_PURGE_ENABLED", "true")
    created = create()
    blobs.upload_blob(name=f"{created['id']}/uploads/a.pdf", data=PDF, overwrite=True)
    user_delete(created["id"])
    restored = []
    on_conditional_update_of(table, created["id"],
                             lambda: restored.append(admin_restore(admin, created["id"])))

    summary = fa._run_retention_sweep(today() + timedelta(days=1, hours=3), True)

    assert restored[0].status_code == 200
    assert summary["purged"] == 0
    assert row(table, created["id"])["Status"] == "active"
    assert "PurgingUtc" not in row(table, created["id"])
    assert f"{created['id']}/uploads/a.pdf" in blobs.blobs
    assert table.code_rows()[created["code"]]["CompetitionId"] == created["id"]


def test_restore_refuses_once_a_purge_has_started(admin, table, blobs):
    """A purge that failed halfway has already deleted things: its claim
    (PurgingUtc) stays, restore says so, and the next sweep finishes it."""
    created = create()
    blobs.upload_blob(name=f"{created['id']}/uploads/a.pdf", data=PDF, overwrite=True)
    blobs.fail_next_delete = RuntimeError("blob service down")
    assert admin_purge(admin, created["id"], created["code"]).status_code == 500

    response = admin_restore(admin, created["id"])

    assert response.status_code == 409
    assert payload(response)["error"] == "purging"
    assert row(table, created["id"])["Status"] == "deleted"
    assert created["code"] not in table.code_rows()


def test_a_purge_landing_during_a_restore_releases_the_restore_claim(admin, table, blobs):
    """Restore claimed the CODE row, then a purge completes before restore's
    own write: restore loses the ETag race, sees the tombstone, frees the code
    it claimed and answers 409 — no reservation is left on a purged row."""
    created = create()
    user_delete(created["id"])
    purges = []
    on_conditional_update_of(table, created["id"],
                             lambda: purges.append(admin_purge(admin, created["id"], created["code"])))

    response = admin_restore(admin, created["id"])

    assert payload(purges[0])["competition"]["status"] == "purged"
    assert response.status_code == 409
    assert payload(response)["error"] == "purged"
    assert created["code"] not in table.code_rows()


def test_overlapping_restores_keep_the_code_reservation(admin, table):
    """A claims the code; B adopts that claim and restores first; A loses the
    ETag race. A must not roll back the CODE row B's active competition now
    relies on."""
    created = create()
    user_delete(created["id"])
    second = []
    on_conditional_update_of(table, created["id"],
                             lambda: second.append(admin_restore(admin, created["id"])))

    first = admin_restore(admin, created["id"])

    assert second[0].status_code == 200
    assert first.status_code == 409
    assert payload(first)["error"] == "not_deleted"
    assert row(table, created["id"])["Status"] == "active"
    assert table.code_rows()[created["code"]]["CompetitionId"] == created["id"]


# ── delete + dry-run ──────────────────────────────────────────────────────────

def test_admin_delete_is_the_user_delete_and_409s_the_second_time(admin, table):
    created = create()

    first = admin_delete(admin, created["id"])

    assert first.status_code == 200
    competition = payload(first)["competition"]
    assert competition["status"] == "deleted"
    assert competition["deleteReason"] == "user"
    assert competition["deletionDate"] == midnight_text(1)
    assert created["code"] not in table.code_rows()
    assert table.clock_rows()[created["id"]]["Status"] == "deleted"
    second = admin_delete(admin, created["id"])
    assert second.status_code == 409
    assert payload(second)["error"] == "deleted"


def test_the_dry_run_sweep_never_purges(admin, table, blobs, monkeypatch):
    monkeypatch.setenv("RETENTION_PURGE_ENABLED", "true")
    created = create()
    table.rows[(fa.PK_COMPETITION, created["id"])]["DeletionDate"] = "2026-01-01T00:00:00Z"
    blobs.upload_blob(name=f"{created['id']}/uploads/a.pdf", data=PDF, overwrite=True)

    response = call(fa._admin_sweep_dry_run, admin, "POST")

    assert response.status_code == 200
    summary = payload(response)["summary"]
    assert summary["would_purge"] == 1
    assert summary["purged"] == 0
    assert row(table, created["id"])["Status"] == "active"
    assert blobs.blobs != {}
