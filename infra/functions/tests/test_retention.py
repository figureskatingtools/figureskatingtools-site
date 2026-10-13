"""Retention: one platform clock.

The privacy notice promises that a competition's data is deleted 60 days after
the competition is created, extendable one week at a time. The COMPETITION row
owns that date (`DeletionDate`) and the nightly `retention_sweep` enforces it
for everything the platform holds — pool blobs, FSM pushes, quarantine, HOVTP
trust rows and the e-mail addresses on the row itself. The tool Function Apps
read the same row, so the column names and the tombstone shape are a contract.
"""
from datetime import datetime, timedelta, timezone

import pytest

import function_app as fa
from conftest import USER_EMAIL, make_request, payload

PDF = b"%PDF-1.7 fake pdf bytes"


# ── helpers ───────────────────────────────────────────────────────────────────

def midnight(moment):
    return datetime(moment.year, moment.month, moment.day, tzinfo=timezone.utc)


def utc(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def today():
    return midnight(datetime.now(timezone.utc))


def create(name="Winter Cup 2026", **fields):
    body = {"name": name, **fields}
    return payload(fa._create_competition(make_request("POST", body=body)))


def extend(competition_id, **kwargs):
    return fa._extend_competition(
        make_request("POST", route_params={"id": competition_id}, **kwargs))


def delete(competition_id):
    return fa._delete_competition(make_request("DELETE", route_params={"id": competition_id}))


def seed_competition(table, competition_id, code=None, **columns):
    """A COMPETITION row (+ its CODE row) written straight into the table."""
    code = code or f"code-{competition_id}"
    entity = {
        "PartitionKey": fa.PK_COMPETITION,
        "RowKey": competition_id,
        "Code": code,
        "Name": f"Competition {competition_id}",
        "StartDate": "2026-01-17",
        "EndDate": "",
        "Venue": "Helsinki",
        "CreatedBy": USER_EMAIL,
        "CreatedUtc": "2026-01-02T10:00:00Z",
        "UpdatedUtc": "2026-01-02T10:00:00Z",
        "Status": fa.STATUS_ACTIVE,
    }
    entity.update(columns)
    entity = {k: v for k, v in entity.items() if v is not None}
    table.create_entity(entity)
    table.create_entity({"PartitionKey": fa.PK_CODE, "RowKey": code,
                         "CompetitionId": competition_id, "CreatedUtc": entity["CreatedUtc"]})
    return entity


def seed_source(table, competition_id, ip="20.31.4.7"):
    table.create_entity({
        "PartitionKey": fa.PK_HOVTP_SOURCE,
        "RowKey": fa.hovtp_source_row_key(competition_id, ip),
        "CompetitionId": competition_id,
        "Ip": ip,
        "Status": fa.HOVTP_STATUS_ACCEPTED,
        "AcceptedBy": USER_EMAIL,
    })


def seed_blob(blobs, name):
    blobs.upload_blob(name=name, data=PDF, overwrite=True)


def row(table, competition_id):
    return table.rows[(fa.PK_COMPETITION, competition_id)]


def sweep(now=None, purge=True):
    return fa._run_retention_sweep(now or datetime.now(timezone.utc), purge)


def no_email_anywhere(entity):
    return not any("@" in str(value) for value in entity.values())


EXPIRED = "2026-01-01T00:00:00Z"


# ── the date itself ───────────────────────────────────────────────────────────

def test_create_sets_the_deletion_date_to_midnight_utc_60_days_out(table):
    created = create()

    expected = utc(today() + timedelta(days=60))
    assert created["deletionDate"] == expected
    assert row(table, created["id"])["DeletionDate"] == expected


def test_the_deletion_date_is_exposed_on_get_and_list(table):
    created = create()

    fetched = payload(fa._get_competition(make_request("GET", route_params={"id": created["id"]})))
    listed = payload(fa._list_competitions(make_request("GET")))

    assert fetched["deletionDate"] == created["deletionDate"]
    assert listed[0]["deletionDate"] == created["deletionDate"]


def test_an_old_row_without_a_date_gets_the_legacy_floor(table):
    seed_competition(table, "old", CreatedUtc="2026-01-02T10:00:00Z")

    fetched = payload(fa._get_competition(make_request("GET", route_params={"id": "old"})))

    assert fetched["deletionDate"] == fa.LEGACY_DELETION_FLOOR


def test_a_recent_row_without_a_date_keeps_its_60_days_when_later_than_the_floor(table):
    created = datetime(2026, 10, 1, 15, 30, tzinfo=timezone.utc)
    seed_competition(table, "recent", CreatedUtc=utc(created))

    fetched = payload(fa._get_competition(make_request("GET", route_params={"id": "recent"})))

    assert fetched["deletionDate"] == "2026-11-30T00:00:00Z"
    assert fetched["deletionDate"] > fa.LEGACY_DELETION_FLOOR


def test_patch_and_put_ignore_a_client_supplied_deletion_date(table):
    created = create()

    for method in ("PATCH", "PUT"):
        response = fa._update_competition(make_request(
            method, route_params={"id": created["id"]},
            body={"deletionDate": "2099-01-01T00:00:00Z", "DeletionDate": "2099-01-01T00:00:00Z",
                  "venue": "Tampere"}))
        assert response.status_code == 200
        assert payload(response)["deletionDate"] == created["deletionDate"]

    assert row(table, created["id"])["DeletionDate"] == created["deletionDate"]


# ── extend ────────────────────────────────────────────────────────────────────

def test_extend_adds_seven_days_to_the_current_date(table):
    created = create()

    response = extend(created["id"])

    assert response.status_code == 200
    expected = utc(today() + timedelta(days=67))
    assert payload(response)["deletionDate"] == expected
    stored = row(table, created["id"])
    assert stored["DeletionDate"] == expected
    assert stored["ExtendedCount"] == 1
    assert stored["LastExtendedUtc"]


def test_extend_has_no_cap(table):
    created = create()
    for _ in range(5):
        extend(created["id"])

    assert row(table, created["id"])["DeletionDate"] == utc(today() + timedelta(days=60 + 35))
    assert row(table, created["id"])["ExtendedCount"] == 5


def test_an_overdue_competition_is_extended_from_today(table):
    seed_competition(table, "late", DeletionDate=EXPIRED)

    response = extend("late")

    assert payload(response)["deletionDate"] == utc(today() + timedelta(days=7))


def test_extend_does_not_record_who_extended(table):
    created = create()
    extend(created["id"], user_email="other@example.com")

    stored = row(table, created["id"])
    assert "other@example.com" not in [str(v) for v in stored.values()]


def test_extend_of_an_unknown_or_deleted_competition_is_a_404(table):
    created = create()
    delete(created["id"])

    assert extend("no-such-id").status_code == 404
    assert extend(created["id"]).status_code == 404


def test_extend_requires_a_user(table):
    created = create()

    assert extend(created["id"], user_email=None).status_code == 401
    assert extend(created["id"], proxy_secret="wrong").status_code == 401
    assert row(table, created["id"])["DeletionDate"] == created["deletionDate"]


def test_two_racing_extends_both_count(table):
    created = create()

    def competing_extend(client, key):
        # Another browser's extend lands between our read and our write.
        current = fa._parse_utc(client.rows[key]["DeletionDate"])
        client.update_entity({"PartitionKey": key[0], "RowKey": key[1],
                              "DeletionDate": utc(current + timedelta(days=7)),
                              "ExtendedCount": 1})

    table.before_conditional_update = competing_extend
    response = extend(created["id"])

    assert response.status_code == 200
    assert payload(response)["deletionDate"] == utc(today() + timedelta(days=74))
    assert row(table, created["id"])["ExtendedCount"] == 2


# ── manual delete ─────────────────────────────────────────────────────────────

def test_delete_pulls_the_date_to_the_next_midnight_and_records_no_email(table):
    created = create()

    response = delete(created["id"])

    assert response.status_code == 200
    stored = row(table, created["id"])
    assert stored["DeletionDate"] == utc(today() + timedelta(days=1))
    assert stored["DeleteReason"] == "user"
    assert "DeletedBy" not in stored
    assert payload(response)["deletionDate"] == stored["DeletionDate"]


def test_delete_never_pushes_an_earlier_date_later(table):
    seed_competition(table, "late", DeletionDate=EXPIRED)

    delete("late")

    assert row(table, "late")["DeletionDate"] == EXPIRED


def test_a_manually_deleted_competition_is_purged_that_night(table, blobs):
    created = create()
    seed_blob(blobs, f"{created['id']}/uploads/a.pdf")
    delete(created["id"])

    tonight = today() + timedelta(days=1, hours=3)
    summary = sweep(tonight)

    assert summary["purged"] == 1
    assert blobs.blobs == {}
    stored = row(table, created["id"])
    assert stored["PurgedUtc"]
    assert stored["DeleteReason"] == "user"


# ── sweep: purge ──────────────────────────────────────────────────────────────

def test_purge_removes_blobs_sources_code_and_emails(table, blobs):
    seed_competition(table, "gone", code="gone-cup", DeletionDate=EXPIRED,
                     DeletedBy=USER_EMAIL, ExtendedCount=2)
    seed_source(table, "gone")
    seed_source(table, "gone", ip="20.31.4.8")
    for name in ("uploads/a.pdf", "fsm/b.xml", "fsm-pending/20.31.4.7/c.pdf"):
        seed_blob(blobs, f"gone/{name}")

    summary = sweep()

    assert summary["purged"] == 1
    assert blobs.blobs == {}
    assert table.hovtp_source_rows() == []
    assert table.code_rows() == {}

    stone = row(table, "gone")
    assert stone["Status"] == "deleted"
    assert stone["PurgedUtc"]
    assert stone["DeleteReason"] == fa.AUTO_CLEANUP_ACTOR
    assert "CreatedBy" not in stone and "DeletedBy" not in stone
    assert no_email_anywhere(stone)
    # What stays: identity, timeline and usage counts.
    assert (stone["Name"], stone["Code"], stone["StartDate"], stone["Venue"]) == \
        ("Competition gone", "gone-cup", "2026-01-17", "Helsinki")
    assert stone["CreatedUtc"] == "2026-01-02T10:00:00Z"
    assert stone["DeletionDate"] == EXPIRED
    assert stone["ExtendedCount"] == 2


def test_the_blob_prefix_boundary_holds(table, blobs):
    seed_competition(table, "comp-1", DeletionDate=EXPIRED)
    seed_competition(table, "comp-10", DeletionDate="2099-01-01T00:00:00Z")
    seed_blob(blobs, "comp-1/uploads/a.pdf")
    seed_blob(blobs, "comp-10/uploads/b.pdf")
    seed_blob(blobs, "comp-1.pdf")

    sweep()

    assert sorted(blobs.blobs) == ["comp-1.pdf", "comp-10/uploads/b.pdf"]
    assert row(table, "comp-10")["Status"] == "active"


def test_a_reused_code_row_survives_the_purge(table, blobs):
    seed_competition(table, "old", code="winter-cup", DeletionDate=EXPIRED,
                     Status=fa.STATUS_DELETED)
    # The code was freed at delete time and claimed by a new competition.
    table.rows[(fa.PK_CODE, "winter-cup")]["CompetitionId"] = "new"

    sweep()

    assert table.code_rows()["winter-cup"]["CompetitionId"] == "new"
    assert row(table, "old")["PurgedUtc"]


def test_a_competition_that_is_not_due_is_untouched(table, blobs):
    seed_competition(table, "live", DeletionDate="2099-01-01T00:00:00Z")
    seed_source(table, "live")
    seed_blob(blobs, "live/uploads/a.pdf")

    summary = sweep()

    assert summary["purged"] == 0
    assert list(blobs.blobs) == ["live/uploads/a.pdf"]
    assert row(table, "live")["CreatedBy"] == USER_EMAIL
    assert len(table.hovtp_source_rows()) == 1


def test_the_deletion_date_itself_is_the_cut_off(table, blobs):
    seed_competition(table, "edge", DeletionDate="2026-12-12T00:00:00Z")

    assert sweep(datetime(2026, 12, 11, 23, 59, tzinfo=timezone.utc))["purged"] == 0
    assert sweep(datetime(2026, 12, 12, 3, 0, tzinfo=timezone.utc))["purged"] == 1


def test_an_extend_landing_during_the_sweep_wins(table, blobs):
    seed_competition(table, "saved", DeletionDate=EXPIRED)
    seed_blob(blobs, "saved/uploads/a.pdf")

    def operator_extends(client, key):
        client.update_entity({"PartitionKey": key[0], "RowKey": key[1],
                              "DeletionDate": "2099-01-01T00:00:00Z"})

    table.before_conditional_update = operator_extends
    summary = sweep()

    assert summary["purged"] == 0
    assert row(table, "saved")["Status"] == "active"
    assert list(blobs.blobs) == ["saved/uploads/a.pdf"]


def test_dry_run_deletes_nothing_but_still_backfills(table, blobs):
    seed_competition(table, "old")                    # no DeletionDate, long expired
    seed_competition(table, "due", DeletionDate=EXPIRED)
    seed_source(table, "due")
    seed_blob(blobs, "due/uploads/a.pdf")
    table.create_entity({"PartitionKey": fa.PK_HOVTP_SESSION, "RowKey": "s1",
                         "UpdatedUtc": "2026-01-01T00:00:00Z"})

    summary = sweep(datetime(2026, 12, 1, 3, 0, tzinfo=timezone.utc), purge=False)

    assert summary["backfilled"] == 1
    assert summary["would_purge"] == 2
    assert summary["purged"] == 0
    assert summary["sessions_would_delete"] == 1
    assert row(table, "old")["DeletionDate"] == fa.LEGACY_DELETION_FLOOR
    assert row(table, "due")["Status"] == "active"
    assert row(table, "due")["CreatedBy"] == USER_EMAIL
    assert list(blobs.blobs) == ["due/uploads/a.pdf"]
    assert len(table.hovtp_source_rows()) == 1
    assert (fa.PK_HOVTP_SESSION, "s1") in table.rows
    assert set(table.code_rows()) == {"code-old", "code-due"}


def test_backfill_does_not_overwrite_an_existing_date(table, blobs):
    seed_competition(table, "set", DeletionDate="2099-01-01T00:00:00Z")

    assert sweep()["backfilled"] == 0
    assert row(table, "set")["DeletionDate"] == "2099-01-01T00:00:00Z"


def test_a_failed_step_leaves_no_tombstone_and_is_retried(table, blobs):
    seed_competition(table, "flaky", DeletionDate=EXPIRED)
    seed_blob(blobs, "flaky/uploads/a.pdf")
    blobs.fail_next_delete = RuntimeError("blob storage exploded")

    first = sweep()

    assert (first["purged"], first["failed"]) == (0, 1)
    stored = row(table, "flaky")
    assert stored["Status"] == "deleted"          # already refused by HOVTP / extend
    assert "PurgedUtc" not in stored
    assert list(blobs.blobs) == ["flaky/uploads/a.pdf"]

    second = sweep()

    assert second["purged"] == 1
    assert blobs.blobs == {}
    assert row(table, "flaky")["PurgedUtc"]
    assert no_email_anywhere(row(table, "flaky"))


def test_running_twice_is_safe(table, blobs):
    seed_competition(table, "gone", DeletionDate=EXPIRED)
    seed_blob(blobs, "gone/uploads/a.pdf")
    now = datetime.now(timezone.utc)

    assert sweep(now)["purged"] == 1
    stone = dict(row(table, "gone"))

    again = sweep(now + timedelta(minutes=1))

    assert (again["purged"], again["failed"]) == (0, 0)
    assert row(table, "gone") == stone


def test_a_late_hovtp_write_is_resweeped_for_two_days(table, blobs):
    seed_competition(table, "gone", DeletionDate=EXPIRED)
    now = datetime.now(timezone.utc)
    sweep(now)

    # A push that resolved the competition before the purge lands afterwards.
    seed_blob(blobs, "gone/fsm/late.xml")
    seed_source(table, "gone")
    summary = sweep(now + timedelta(days=1))

    assert summary["resweeps"] == 1
    assert blobs.blobs == {}
    assert table.hovtp_source_rows() == []

    seed_blob(blobs, "gone/fsm/much-later.xml")
    assert sweep(now + timedelta(days=3))["resweeps"] == 0


# ── sweep: sessions ───────────────────────────────────────────────────────────

def test_idle_hovtp_sessions_are_deleted(table, blobs):
    now = datetime(2026, 12, 1, 3, 0, tzinfo=timezone.utc)
    table.create_entity({"PartitionKey": fa.PK_HOVTP_SESSION, "RowKey": "stale",
                         "UpdatedUtc": utc(now - timedelta(days=31)), "Ip": "20.31.4.7"})
    table.create_entity({"PartitionKey": fa.PK_HOVTP_SESSION, "RowKey": "fresh",
                         "UpdatedUtc": utc(now - timedelta(days=5)), "Ip": "20.31.4.7"})

    summary = sweep(now)

    assert summary["sessions_deleted"] == 1
    assert [k for (pk, k) in table.rows if pk == fa.PK_HOVTP_SESSION] == ["fresh"]


# ── timer adapter ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("value, expected", [
    ("true", True), ("True", True), ("1", True),
    ("false", False), ("False", False), ("", False), (None, False),
])
def test_purge_is_off_unless_the_setting_says_true(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("RETENTION_PURGE_ENABLED", raising=False)
    else:
        monkeypatch.setenv("RETENTION_PURGE_ENABLED", value)
    assert fa._purge_enabled() is expected


# ── the clock table the tools read ────────────────────────────────────────────
# The tools' only window on the platform: `retentionclock` holds DeletionDate,
# Status and PurgedUtc per competition and nothing else (no e-mails, no IPs).

CLOCK_KEYS = {"PartitionKey", "RowKey", "DeletionDate", "Status", "PurgedUtc"}


def clock(table, competition_id):
    return table.clock_rows().get(competition_id.lower())


def test_create_mirrors_only_the_three_clock_columns(table):
    created = create()

    assert clock(table, created["id"]) == {
        "PartitionKey": "COMPETITION", "RowKey": created["id"],
        "DeletionDate": created["deletionDate"], "Status": "active",
    }


def test_extend_and_delete_update_the_clock(table):
    created = create()

    extend(created["id"])
    assert clock(table, created["id"])["DeletionDate"] == utc(today() + timedelta(days=67))

    delete(created["id"])
    mirrored = clock(table, created["id"])
    assert mirrored["Status"] == "deleted"
    assert mirrored["DeletionDate"] == utc(today() + timedelta(days=1))
    assert "PurgedUtc" not in mirrored


def test_purge_gives_the_tools_their_verdict(table, blobs):
    seed_competition(table, "gone", DeletionDate=EXPIRED, DeletedBy=USER_EMAIL)

    sweep()

    mirrored = clock(table, "gone")
    assert mirrored["Status"] == "deleted"
    assert mirrored["PurgedUtc"] == row(table, "gone")["PurgedUtc"]
    assert set(mirrored) <= CLOCK_KEYS
    assert no_email_anywhere(mirrored)


def test_the_sweep_reconciles_missing_and_drifted_clock_rows(table, blobs):
    seed_competition(table, "old")                                       # no date, no clock row
    seed_competition(table, "live", DeletionDate="2099-01-01T00:00:00Z")
    table.clock.upsert_entity({"PartitionKey": "COMPETITION", "RowKey": "live",
                               "DeletionDate": "2000-01-01T00:00:00Z", "Status": "deleted",
                               "Stray": "x"})
    tonight = datetime(2026, 10, 14, 3, 0, tzinfo=timezone.utc)

    summary = sweep(tonight, purge=False)

    # "old" is mirrored by its backfill; the reconcile fixes the drifted "live".
    assert (summary["backfilled"], summary["clock_synced"]) == (1, 1)
    assert clock(table, "old") == {"PartitionKey": "COMPETITION", "RowKey": "old",
                                   "DeletionDate": fa.LEGACY_DELETION_FLOOR, "Status": "active"}
    # Replaced, not merged: the stray column is gone too.
    assert clock(table, "live") == {"PartitionKey": "COMPETITION", "RowKey": "live",
                                    "DeletionDate": "2099-01-01T00:00:00Z", "Status": "active"}
    # Nothing left to fix: the next run writes nothing.
    assert sweep(tonight + timedelta(minutes=5), purge=False)["clock_synced"] == 0


def test_a_failed_clock_write_never_fails_the_api_and_is_healed_nightly(table, blobs):
    real_upsert = table.clock.upsert_entity
    broken = {"on": True}

    def flaky_upsert(*args, **kwargs):
        if broken["on"]:
            raise RuntimeError("table storage exploded")
        return real_upsert(*args, **kwargs)

    table.clock.upsert_entity = flaky_upsert
    response = fa._create_competition(make_request("POST", body={"name": "Winter Cup"}))

    assert response.status_code == 201
    created = payload(response)
    assert table.clock_rows() == {}

    broken["on"] = False
    sweep()

    assert clock(table, created["id"])["DeletionDate"] == created["deletionDate"]


def test_a_rename_racing_the_purge_does_not_leak_a_code_row(table, blobs, monkeypatch):
    seed_competition(table, "gone", code="old-code", DeletionDate=EXPIRED)
    real_delete_sources = fa._delete_hovtp_sources

    def rename_lands_mid_purge(client, competition_id):
        # A PATCH that read the row before it was marked deleted claims a new
        # code and merges it in after the purge already released the old one.
        client.create_entity({"PartitionKey": fa.PK_CODE, "RowKey": "new-code",
                              "CompetitionId": competition_id})
        client.update_entity({"PartitionKey": fa.PK_COMPETITION, "RowKey": competition_id,
                              "Code": "new-code"})
        return real_delete_sources(client, competition_id)

    monkeypatch.setattr(fa, "_delete_hovtp_sources", rename_lands_mid_purge)

    assert sweep()["purged"] == 1
    assert table.code_rows() == {}
    assert row(table, "gone")["Code"] == "new-code"


def test_a_change_between_the_fresh_read_and_the_tombstone_retries_next_night(
        table, blobs, monkeypatch):
    seed_competition(table, "gone", code="gone-code", DeletionDate=EXPIRED)
    real_delete_blobs = fa._delete_competition_blobs

    def arm_race(container, competition_id):
        def late_write(client, key):
            client.update_entity({"PartitionKey": key[0], "RowKey": key[1], "Venue": "Tampere"})
        # The next ETag-conditional write is the tombstone replace.
        table.before_conditional_update = late_write
        return real_delete_blobs(container, competition_id)

    monkeypatch.setattr(fa, "_delete_competition_blobs", arm_race)
    first = sweep()

    assert (first["purged"], first["failed"]) == (0, 1)
    assert "PurgedUtc" not in row(table, "gone")
    assert "PurgedUtc" not in clock(table, "gone")

    monkeypatch.setattr(fa, "_delete_competition_blobs", real_delete_blobs)

    assert sweep()["purged"] == 1
    assert row(table, "gone")["PurgedUtc"]
    assert clock(table, "gone")["PurgedUtc"] == row(table, "gone")["PurgedUtc"]
