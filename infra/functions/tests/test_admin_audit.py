"""The admin log (`adminlog` table): audit rows, sweep runs, their retention,
and the diagnostics view that reads them.

AUDIT rows hold the admin's e-mail, so the privacy notice promises they are
kept for a year; the nightly sweep enforces that. SWEEP rows are the "last
runs" list in diagnostics and are kept for 30 days.
"""
import json
import logging
from datetime import datetime, timedelta, timezone

import function_app as fa
from conftest import ADMIN_EMAIL, USER_EMAIL, make_request, payload


# ── helpers ───────────────────────────────────────────────────────────────────

def day(offset):
    now = datetime.now(timezone.utc)
    return (datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
            + timedelta(days=offset)).strftime("%Y-%m-%d")


def create(name="Winter Cup 2026", **fields):
    return payload(fa._create_competition(make_request("POST", body={"name": name, **fields})))


def call(handler, method, competition_id=None, user_email="ADMIN@example.com", **kwargs):
    route_params = {"id": competition_id} if competition_id else {}
    return handler(make_request(method, route_params=route_params, user_email=user_email, **kwargs))


def changes(audit_row):
    return json.loads(audit_row["Changes"])


def seed_log_row(table, partition_key, moment, **columns):
    table.adminlog.create_entity({"PartitionKey": partition_key,
                                  "RowKey": fa._admin_log_key(moment),
                                  "Utc": fa._utc_text(moment), **columns})


def audit_page(**params):
    return call(fa._admin_audit_log, "GET", params=params)


# ── audit rows ────────────────────────────────────────────────────────────────

def test_an_update_writes_one_audit_row_with_only_the_changed_fields(admin, table):
    created = create("Winter Cup 2026", venue="Helsinki")

    call(fa._admin_update_competition, "PATCH", created["id"],
         body={"name": "Winter Cup 2026", "venue": "Tampere", "deletionDate": day(10)})

    [audit] = table.audit_rows()
    assert audit["Actor"] == ADMIN_EMAIL   # lowercased by the gate
    assert audit["Action"] == "competition.update"
    assert audit["CompetitionId"] == created["id"]
    assert audit["CompetitionCode"] == created["code"]
    assert audit["Outcome"] == "ok"
    assert changes(audit) == {
        "venue": ["Helsinki", "Tampere"],
        "deletionDate": [created["deletionDate"], f"{day(10)}T00:00:00Z"],
    }


def test_an_owner_change_is_audited_with_both_addresses(admin, table):
    created = create()
    new_owner = table.seed_user("new-owner@example.com", "New Owner")
    call(fa._admin_set_owner, "PUT", created["id"], body={"userId": new_owner})
    [audit] = table.audit_rows()
    assert audit["Action"] == "competition.owner"
    assert audit["Actor"] == ADMIN_EMAIL
    assert audit["Target"] == "new-owner@example.com"
    assert changes(audit) == {"owner": [USER_EMAIL, "new-owner@example.com"]}


def test_a_no_op_update_writes_no_audit_row(admin, table):
    created = create("Winter Cup 2026")
    call(fa._admin_update_competition, "PATCH", created["id"], body={"name": "Winter Cup 2026"})
    assert table.audit_rows() == []


def test_a_rejected_admin_action_writes_no_audit_row(admin, table):
    created = create()
    call(fa._admin_update_competition, "PATCH", created["id"], body={"deletionDate": day(0)})
    call(fa._admin_restore_competition, "POST", created["id"])
    call(fa._admin_purge_competition, "POST", created["id"], body={"confirm": "nope"})
    call(fa._admin_update_competition, "PATCH", created["id"], body={"venue": "x"},
         user_email=USER_EMAIL)
    assert table.audit_rows() == []


def test_every_mutation_is_audited_with_its_action(admin, table, blobs):
    created = create()
    competition_id = created["id"]

    call(fa._admin_delete_competition, "DELETE", competition_id)
    call(fa._admin_restore_competition, "POST", competition_id)
    call(fa._admin_purge_competition, "POST", competition_id, body={"confirm": created["code"]})
    call(fa._admin_sweep_dry_run, "POST")

    actions = [row["Action"] for row in reversed(table.audit_rows())]   # oldest first
    assert actions == ["competition.delete", "competition.restore",
                       "competition.purge", "sweep.dryrun"]
    by_action = {row["Action"]: row for row in table.audit_rows()}
    assert changes(by_action["competition.delete"])["status"] == ["active", "deleted"]
    assert changes(by_action["competition.restore"])["status"] == ["deleted", "active"]
    # The purge row holds the status change only — no owner e-mail outlives the tombstone.
    assert changes(by_action["competition.purge"]) == {"status": ["active", "purged"]}
    assert by_action["sweep.dryrun"]["CompetitionId"] == ""


def test_a_failed_audit_write_does_not_undo_the_action(admin, table, caplog):
    created = create()
    table.adminlog.fail_next_create = RuntimeError("table service down")

    with caplog.at_level(logging.ERROR):
        response = call(fa._admin_update_competition, "PATCH", created["id"],
                        body={"venue": "Tampere"})

    assert response.status_code == 200
    assert table.rows[(fa.PK_COMPETITION, created["id"])]["Venue"] == "Tampere"
    assert table.audit_rows() == []
    assert any("admin log" in record.getMessage() for record in caplog.records
               if record.levelno == logging.ERROR)


# ── GET /api/manage/audit ─────────────────────────────────────────────────────

def test_the_audit_log_is_paged_newest_first(admin, table):
    start = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)
    for minute in range(5):
        seed_log_row(table, fa.PK_AUDIT, start + timedelta(minutes=minute),
                     Actor=ADMIN_EMAIL, Action="competition.update", Outcome="ok",
                     CompetitionId="", CompetitionCode=f"c{minute}", Changes="{}")

    first = payload(audit_page(limit="2"))
    second = payload(audit_page(limit="2", before=first["next"]))
    third = payload(audit_page(limit="2", before=second["next"]))

    codes = [e["competitionCode"] for page in (first, second, third) for e in page["entries"]]
    assert codes == ["c4", "c3", "c2", "c1", "c0"]
    assert third["next"] is None
    entry = first["entries"][0]
    assert entry["actor"] == ADMIN_EMAIL
    assert entry["competitionId"] is None
    assert entry["changes"] == {}
    assert entry["utc"] == "2026-10-01T12:04:00Z"


def test_an_exact_page_has_no_next(admin, table):
    for minute in range(2):
        seed_log_row(table, fa.PK_AUDIT, datetime(2026, 10, 1, 12, minute, tzinfo=timezone.utc),
                     Action="competition.update")
    assert payload(audit_page(limit="2"))["next"] is None
    assert len(payload(audit_page())["entries"]) == 2


def test_the_audit_page_limit_and_cursor_are_validated(admin, table):
    for limit in ("0", "201", "-1", "ten"):
        response = audit_page(limit=limit)
        assert response.status_code == 400, limit
        assert payload(response)["error"] == "invalid_limit"
    assert audit_page(limit="200").status_code == 200
    table.adminlog.calls.clear()
    bad = audit_page(before="x' or PartitionKey eq 'SWEEP")
    assert bad.status_code == 400
    assert table.adminlog.calls == []


def test_an_empty_audit_log(admin, table):
    assert payload(audit_page()) == {"entries": [], "next": None}


# ── retention of the admin log ────────────────────────────────────────────────

def test_the_sweep_prunes_audit_rows_after_365_days(admin, table):
    now = datetime(2027, 6, 1, 3, 0, tzinfo=timezone.utc)
    seed_log_row(table, fa.PK_AUDIT, now - timedelta(days=366), Action="old")
    seed_log_row(table, fa.PK_AUDIT, now - timedelta(days=364), Action="recent")

    summary = fa._run_retention_sweep(now, True)

    assert summary["audit_pruned"] == 1
    assert [row["Action"] for row in table.audit_rows()] == ["recent"]


def test_the_sweep_prunes_sweep_rows_after_30_days(admin, table):
    now = datetime(2027, 6, 1, 3, 0, tzinfo=timezone.utc)
    seed_log_row(table, fa.PK_SWEEP, now - timedelta(days=31), Summary="{}")
    seed_log_row(table, fa.PK_SWEEP, now - timedelta(days=29), Summary="{}")

    summary = fa._run_retention_sweep(now, True)

    assert summary["sweeps_pruned"] == 1
    # The 29-day-old row plus the row of this very run.
    assert len(table.sweep_rows()) == 2


def test_the_kill_switch_also_holds_the_admin_log_prune(admin, table):
    now = datetime(2027, 6, 1, 3, 0, tzinfo=timezone.utc)
    seed_log_row(table, fa.PK_AUDIT, now - timedelta(days=400), Action="old")

    summary = fa._run_retention_sweep(now, False)

    assert (summary["audit_pruned"], summary["audit_would_prune"]) == (0, 1)
    assert len(table.audit_rows()) == 1


# ── sweep runs ────────────────────────────────────────────────────────────────

def test_every_sweep_run_is_recorded(admin, table, blobs):
    now = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=1)

    nightly = fa._run_retention_sweep(now, True)
    call(fa._admin_sweep_dry_run, "POST")

    manual, night = table.sweep_rows()   # newest first
    assert (night["PurgeEnabled"], night["DryRunManual"]) == (True, False)
    assert json.loads(night["Summary"]) == nightly
    assert night["Utc"] == fa._utc_text(now)
    assert (manual["PurgeEnabled"], manual["DryRunManual"]) == (False, True)


def test_diagnostics_lists_the_last_ten_sweeps_newest_first(admin, table):
    start = datetime(2027, 6, 1, 3, 0, tzinfo=timezone.utc)
    for offset in range(12):
        fa._run_retention_sweep(start + timedelta(hours=offset), True)

    sweeps = payload(call(fa._admin_diagnostics, "GET"))["sweeps"]

    assert len(sweeps) == fa.SWEEP_HISTORY
    assert sweeps[0]["utc"] == "2027-06-01T14:00:00Z"
    assert sweeps[-1]["utc"] == "2027-06-01T05:00:00Z"
    assert sweeps[0]["purgeEnabled"] is True and sweeps[0]["dryRunManual"] is False
    assert "purged" in sweeps[0]["summary"]


# ── diagnostics ───────────────────────────────────────────────────────────────

def test_diagnostics_reports_config_and_counts(admin, table, blobs, monkeypatch):
    monkeypatch.setenv("RETENTION_PURGE_ENABLED", "True")
    monkeypatch.setenv("HOVTP_ENABLED", "False")
    soon = create("Soon Cup")
    table.rows[(fa.PK_COMPETITION, soon["id"])]["DeletionDate"] = f"{day(3)}T00:00:00Z"
    overdue = create("Overdue Cup")
    table.rows[(fa.PK_COMPETITION, overdue["id"])]["DeletionDate"] = "2026-01-01T00:00:00Z"
    create("Later Cup")
    deleted = create("Deleted Cup")
    fa._delete_competition(make_request("DELETE", route_params={"id": deleted["id"]}))
    gone = create("Gone Cup")
    call(fa._admin_purge_competition, "POST", gone["id"], body={"confirm": gone["code"]})
    table.create_entity({"PartitionKey": fa.PK_HOVTP_SOURCE, "RowKey": f"{soon['id']}_20.31.4.7",
                         "Status": "pending"})
    table.create_entity({"PartitionKey": fa.PK_HOVTP_SESSION, "RowKey": "s1"})

    body = payload(call(fa._admin_diagnostics, "GET"))

    assert body["config"] == {
        "retentionPurgeEnabled": True, "hovtpEnabled": False,
        "retentionDays": 60, "extensionDays": 7, "clockTable": "retentionclock",
        "adminLogTable": "adminlog", "auditRetentionDays": 365,
        "usersTable": "users", "userIdentitiesTable": "useridentities",
        "competitionAccessTable": "competitionaccess", "allowedTenantCount": 1,
        "externalTenantCount": 0, "externalNewUsersEnabled": False, "inactiveUserDays": 365,
    }
    assert body["storage"] == {"ok": True, "error": None}
    counts = body["counts"]
    assert counts["competitions"] == {"active": 3, "deleted": 1, "purged": 1}
    assert counts["dueWithin7Days"] == 1
    # Only the overdue row: the soft-deleted one is due at the next midnight.
    assert counts["pastDeletionDate"] == 1
    assert counts["hovtpSources"] == {"pending": 1, "accepted": 0, "expired": 0, "rejected": 0}
    assert counts["hovtpSessions"] == 1
    # Two rows were edited straight in the table without their clock rows.
    assert counts["clockDrift"] == 2


def test_hovtp_enabled_is_null_when_not_configured(admin, table, monkeypatch):
    monkeypatch.delenv("HOVTP_ENABLED", raising=False)
    assert payload(call(fa._admin_diagnostics, "GET"))["config"]["hovtpEnabled"] is None


def test_diagnostics_reports_unavailable_storage(admin, monkeypatch):
    monkeypatch.setattr(fa, "get_table_client", lambda *a, **kw: None)
    body = payload(call(fa._admin_diagnostics, "GET"))
    assert body["storage"]["ok"] is False
    assert body["storage"]["error"]
