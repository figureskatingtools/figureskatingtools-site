"""HOVTP data sources: /api/competitions/{id}/hovtp/sources[/{ip}[/accept|reject]].

FSM sends no credentials, so the only thing separating a real results system
from anyone who found the listener's hostname is the operator pressing "accept"
for one IP and a fixed number of days. That makes three things load-bearing
here, and everything below pins one of them:

  * the gate — these routes decide trust, so an unauthenticated call must never
    reach storage;
  * the IP — it is both a RowKey suffix and a blob path segment, so an
    unparseable one is refused outright and an IPv6 address must canonicalise
    to exactly the spelling the listener stored;
  * the quarantine — accepting attaches every file the source already sent into
    the pool (flat, metadata intact), rejecting throws them away, and neither
    may leave the counters lying about what is still waiting.
"""
from datetime import datetime, timedelta, timezone

import pytest
from azure.storage.blob import ContentSettings

import function_app as fa
from conftest import make_request, payload

PDF = b"%PDF-1.7 fake pdf bytes"
IP = "20.31.4.7"


# ── helpers ───────────────────────────────────────────────────────────────────

def create_competition(name="Winter Cup 2026"):
    return payload(fa._create_competition(make_request("POST", body={"name": name})))


def utc(offset_days=0, offset_seconds=0):
    moment = datetime.now(timezone.utc) + timedelta(days=offset_days, seconds=offset_seconds)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def seed_source(table, competition_id, ip=IP, **columns):
    """A HOVTPSOURCE row exactly as the listener app writes it."""
    entity = {
        "PartitionKey": fa.PK_HOVTP_SOURCE,
        "RowKey": fa.hovtp_source_row_key(competition_id, ip),
        "CompetitionId": competition_id,
        "Ip": ip,
        "Origin": "FSM1",
        "Venue": "HTL",
        "Discipline": "FSK",
        "Environment": "Test",
        "Status": fa.HOVTP_STATUS_PENDING,
        "FirstSeenUtc": "2026-01-02T10:00:00Z",
        "LastSeenUtc": "2026-01-02T10:05:00Z",
        "MessageCount": 3,
        "PendingCount": 0,
        "PendingBytes": 0,
        "UpdatedUtc": "2026-01-02T10:05:00Z",
    }
    entity.update(columns)
    table.create_entity(entity)
    return entity


def seed_pending(blobs, competition_id, name, ip=IP, data=PDF, metadata=None):
    """A quarantined file, with the metadata the listener attaches to it."""
    blobs.upload_blob(
        name=fa.competition_pending_prefix(competition_id, ip) + name,
        data=data,
        overwrite=True,
        metadata=metadata or {
            "sourceTool": fa.SOURCE_TOOL_HOVTP,
            "uploadedBy": f"hovtp:{ip}",
            "hovtpIp": ip,
            "hovtpDataType": "DT_PDF",
        },
        content_settings=ContentSettings(content_type="application/pdf"),
    )


def source_row(table, competition_id, ip=IP):
    return table.rows[(fa.PK_HOVTP_SOURCE, fa.hovtp_source_row_key(competition_id, ip))]


def pool_names(blobs, competition_id, prefix=None):
    prefix = prefix if prefix is not None else fa.competition_fsm_prefix(competition_id)
    return sorted(name[len(prefix):] for name in blobs.blobs if name.startswith(prefix))


def list_sources(competition_id, **kwargs):
    return fa._list_hovtp_sources(make_request(
        "GET", f"/api/competitions/{competition_id}/hovtp/sources",
        route_params={"id": competition_id}, **kwargs))


def accept(competition_id, ip=IP, days=1, **kwargs):
    body = kwargs.pop("body", {"days": days})
    return fa._accept_hovtp_source(make_request(
        "POST", f"/api/competitions/{competition_id}/hovtp/sources/{ip}/accept",
        body=body, route_params={"id": competition_id, "ip": ip}, **kwargs))


def reject(competition_id, ip=IP, **kwargs):
    return fa._deny_hovtp_source(make_request(
        "POST", f"/api/competitions/{competition_id}/hovtp/sources/{ip}/reject",
        route_params={"id": competition_id, "ip": ip}, **kwargs))


def revoke(competition_id, ip=IP, **kwargs):
    return fa._deny_hovtp_source(make_request(
        "DELETE", f"/api/competitions/{competition_id}/hovtp/sources/{ip}",
        route_params={"id": competition_id, "ip": ip}, **kwargs))


# ── the gate ──────────────────────────────────────────────────────────────────

def test_every_source_route_refuses_an_unproxied_request(table, blobs):
    competition = create_competition()
    seed_source(table, competition["id"])
    table.calls.clear()
    blobs.calls.clear()

    for call in (list_sources, accept, reject, revoke):
        response = call(competition["id"], proxy_secret=None)
        assert response.status_code == 401, call.__name__
        assert payload(response)["error"] == "unauthorized", call.__name__

    assert table.calls == [], "a rejected request still hit the table"
    assert blobs.calls == [], "a rejected request still hit blob storage"


# ── listing ───────────────────────────────────────────────────────────────────

def test_a_competition_with_no_sources_lists_none(table):
    competition = create_competition()
    response = list_sources(competition["id"])
    assert response.status_code == 200
    assert payload(response) == {"sources": []}


def test_the_list_reports_the_stored_shape(table):
    competition = create_competition()
    seed_source(table, competition["id"], MessageCount=12, PendingCount=2, PendingBytes=4096)

    source = payload(list_sources(competition["id"]))["sources"][0]
    assert source == {
        "ip": IP,
        "origin": "FSM1",
        "venue": "HTL",
        "discipline": "FSK",
        "environment": "Test",
        "status": "pending",
        "firstSeenUtc": "2026-01-02T10:00:00Z",
        "lastSeenUtc": "2026-01-02T10:05:00Z",
        "messageCount": 12,
        "pendingCount": 2,
        "pendingBytes": 4096,
    }


def test_an_acceptance_that_has_run_out_reads_back_as_expired(table):
    competition = create_competition()
    seed_source(table, competition["id"], Status="accepted", AcceptedBy="coach@example.com",
                AcceptedUntilUtc=utc(offset_days=-1))
    seed_source(table, competition["id"], ip="10.0.0.9", Status="accepted",
                AcceptedBy="coach@example.com", AcceptedUntilUtc=utc(offset_days=2))

    by_ip = {s["ip"]: s for s in payload(list_sources(competition["id"]))["sources"]}
    assert by_ip[IP]["status"] == "expired"
    assert by_ip[IP]["acceptedBy"] == "coach@example.com"
    assert by_ip["10.0.0.9"]["status"] == "accepted"
    # Stored status is untouched — "expired" is computed at read time.
    assert source_row(table, competition["id"])["Status"] == "accepted"


def test_sources_of_other_competitions_are_not_listed(table):
    competition = create_competition()
    other = create_competition("Spring Cup 2026")
    seed_source(table, competition["id"])
    seed_source(table, other["id"], ip="10.0.0.9")

    assert [s["ip"] for s in payload(list_sources(competition["id"]))["sources"]] == [IP]
    assert [s["ip"] for s in payload(list_sources(other["id"]))["sources"]] == ["10.0.0.9"]


def test_sources_awaiting_a_decision_are_listed_first(table):
    competition = create_competition()
    seed_source(table, competition["id"], ip="10.0.0.1", Status="accepted",
                AcceptedUntilUtc=utc(offset_days=3), LastSeenUtc="2026-01-02T12:00:00Z")
    seed_source(table, competition["id"], ip="10.0.0.2", Status="pending",
                LastSeenUtc="2026-01-02T09:00:00Z")
    seed_source(table, competition["id"], ip="10.0.0.3", Status="accepted",
                AcceptedUntilUtc=utc(offset_days=-1), LastSeenUtc="2026-01-02T11:00:00Z")
    seed_source(table, competition["id"], ip="10.0.0.4", Status="rejected",
                LastSeenUtc="2026-01-02T13:00:00Z")

    listed = [(s["ip"], s["status"]) for s in payload(list_sources(competition["id"]))["sources"]]
    assert listed == [
        ("10.0.0.3", "expired"),    # needs a decision, newest of the two
        ("10.0.0.2", "pending"),
        ("10.0.0.4", "rejected"),   # decided, newest first
        ("10.0.0.1", "accepted"),
    ]


def test_listing_an_unknown_competition_is_404(table):
    assert list_sources("no-such-guid").status_code == 404


# ── the {ip} route parameter ──────────────────────────────────────────────────

@pytest.mark.parametrize("bad_ip", ["1.2.3", "../x", "", "20.31.4.7:8080", "not-an-ip",
                                    "20.31.4.7/24"])
def test_an_unparseable_ip_is_refused_before_any_lookup(table, blobs, bad_ip):
    competition = create_competition()
    table.calls.clear()

    for call in (accept, reject, revoke):
        response = call(competition["id"], ip=bad_ip)
        assert response.status_code == 400, f"{call.__name__} accepted '{bad_ip}'"
        assert payload(response)["error"] == "invalid_ip"

    assert table.calls == [], "an invalid IP still hit the table"
    assert blobs.calls == []


def test_an_ipv6_source_is_found_however_it_is_spelled(table, blobs):
    competition = create_competition()
    seed_source(table, competition["id"], ip="2001:db8::1")

    response = accept(competition["id"], ip="2001:DB8:0000::1", days=1)
    assert response.status_code == 200
    assert payload(response)["source"]["ip"] == "2001:db8::1"
    assert source_row(table, competition["id"], "2001:db8::1")["Status"] == "accepted"


def test_an_unknown_source_is_404(table):
    competition = create_competition()
    for call in (accept, reject, revoke):
        response = call(competition["id"])
        assert response.status_code == 404, call.__name__
        assert payload(response)["error"] == "source_not_found"


# ── accept ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("days", [0, 4, 30, -1, "1", 1.0, None, True])
def test_only_the_offered_windows_are_accepted(table, days):
    competition = create_competition()
    seed_source(table, competition["id"])

    response = accept(competition["id"], body={"days": days})
    assert response.status_code == 400, days
    assert payload(response)["error"] == "invalid_days"
    assert source_row(table, competition["id"])["Status"] == "pending"


def test_a_body_that_is_not_json_is_refused(table):
    competition = create_competition()
    seed_source(table, competition["id"])
    response = fa._accept_hovtp_source(make_request(
        "POST", f"/api/competitions/{competition['id']}/hovtp/sources/{IP}/accept",
        route_params={"id": competition["id"], "ip": IP}))
    assert response.status_code == 400
    assert payload(response)["error"] == "invalid_body"


@pytest.mark.parametrize("days", list(fa.HOVTP_ACCEPT_DAYS))
def test_accepting_trusts_the_source_for_that_many_days(table, blobs, days):
    competition = create_competition()
    seed_source(table, competition["id"])

    source = payload(accept(competition["id"], days=days))["source"]
    assert source["status"] == "accepted"
    assert source["acceptedBy"] == "skater@example.com"

    row = source_row(table, competition["id"])
    assert row["Status"] == "accepted"
    assert row["AcceptedBy"] == "skater@example.com"
    granted = datetime.strptime(row["AcceptedUntilUtc"], "%Y-%m-%dT%H:%M:%SZ") \
        .replace(tzinfo=timezone.utc)
    expected = datetime.now(timezone.utc) + timedelta(days=days)
    assert abs((granted - expected).total_seconds()) < 120


def test_accepting_attaches_everything_the_source_already_sent(table, blobs):
    competition = create_competition()
    seed_source(table, competition["id"], PendingCount=2, PendingBytes=999)
    seed_pending(blobs, competition["id"], "FSK_C08_Competition_Schedule.pdf")
    seed_pending(blobs, competition["id"], "DT_PARTIC_FSK.xml", data=b"<OdfBody/>")

    body = payload(accept(competition["id"], days=2))
    assert body["attached"] == 2
    assert body["failed"] == 0

    # Flat under <guid>/fsm/, which is the only shape the file pool lists.
    assert pool_names(blobs, competition["id"]) == [
        "DT_PARTIC_FSK.xml", "FSK_C08_Competition_Schedule.pdf"]
    # The quarantine is empty and the counters say so.
    assert pool_names(blobs, competition["id"],
                      fa.competition_pending_prefix(competition["id"], IP)) == []
    assert body["source"]["pendingCount"] == 0
    assert body["source"]["pendingBytes"] == 0
    row = source_row(table, competition["id"])
    assert (row["PendingCount"], row["PendingBytes"]) == (0, 0)

    attached = blobs.blobs[fa.competition_fsm_prefix(competition["id"])
                           + "FSK_C08_Competition_Schedule.pdf"]
    assert attached.data == PDF
    assert attached.content_type == "application/pdf"
    # The listener's provenance survives, plus who attached it and when.
    assert attached.metadata["sourceTool"] == fa.SOURCE_TOOL_HOVTP
    assert attached.metadata["uploadedBy"] == f"hovtp:{IP}"
    assert attached.metadata["hovtpDataType"] == "DT_PDF"
    assert attached.metadata["attachedBy"] == "skater@example.com"
    assert attached.metadata["attachedUtc"]


def test_only_this_sources_quarantine_is_attached(table, blobs):
    competition = create_competition()
    seed_source(table, competition["id"])
    seed_source(table, competition["id"], ip="10.0.0.9")
    seed_pending(blobs, competition["id"], "mine.pdf")
    seed_pending(blobs, competition["id"], "theirs.pdf", ip="10.0.0.9")

    assert payload(accept(competition["id"]))["attached"] == 1
    assert pool_names(blobs, competition["id"]) == ["mine.pdf"]
    assert pool_names(blobs, competition["id"],
                      fa.competition_pending_prefix(competition["id"], "10.0.0.9")) == \
        ["theirs.pdf"]


def test_accepting_again_extends_the_window(table, blobs):
    competition = create_competition()
    seed_source(table, competition["id"])
    first = payload(accept(competition["id"], days=1))["source"]

    # Meanwhile the listener kept sending — those files are already in the pool,
    # so a second accept is purely an extension.
    second = payload(accept(competition["id"], days=7))["source"]
    assert second["status"] == "accepted"
    assert second["acceptedUntilUtc"] > first["acceptedUntilUtc"]


def test_an_expired_source_can_be_accepted_again_and_drains_its_backlog(table, blobs):
    competition = create_competition()
    seed_source(table, competition["id"], Status="accepted",
                AcceptedUntilUtc=utc(offset_days=-1), AcceptedBy="coach@example.com",
                PendingCount=1, PendingBytes=len(PDF))
    seed_pending(blobs, competition["id"], "late.pdf")

    body = payload(accept(competition["id"], days=3))
    assert body["attached"] == 1
    assert body["source"]["status"] == "accepted"
    assert pool_names(blobs, competition["id"]) == ["late.pdf"]


def test_a_previously_rejected_source_loses_its_rejection(table, blobs):
    competition = create_competition()
    seed_source(table, competition["id"], Status="rejected",
                RejectedBy="coach@example.com", RejectedUtc="2026-01-02T11:00:00Z")

    assert payload(accept(competition["id"]))["source"]["status"] == "accepted"
    row = source_row(table, competition["id"])
    assert row["RejectedBy"] == ""
    assert row["RejectedUtc"] == ""


def test_a_file_that_cannot_be_attached_is_reported_and_left_behind(table, blobs):
    competition = create_competition()
    seed_source(table, competition["id"])
    seed_pending(blobs, competition["id"], "a-broken.pdf")
    seed_pending(blobs, competition["id"], "b-fine.pdf")
    blobs.fail_next_upload = RuntimeError("storage hiccup")

    body = payload(accept(competition["id"]))
    assert (body["attached"], body["failed"]) == (1, 1)
    # The good one landed; the failed one is still quarantined, so a second
    # accept picks it up rather than losing it.
    assert pool_names(blobs, competition["id"]) == ["b-fine.pdf"]
    assert pool_names(blobs, competition["id"],
                      fa.competition_pending_prefix(competition["id"], IP)) == ["a-broken.pdf"]
    assert body["source"]["pendingCount"] == 1
    assert body["source"]["pendingBytes"] == len(PDF)

    assert payload(accept(competition["id"]))["attached"] == 1
    assert pool_names(blobs, competition["id"]) == ["a-broken.pdf", "b-fine.pdf"]


# ── reject and revoke ─────────────────────────────────────────────────────────

def test_rejecting_marks_the_source_and_throws_the_quarantine_away(table, blobs):
    competition = create_competition()
    seed_source(table, competition["id"], PendingCount=2, PendingBytes=999)
    seed_pending(blobs, competition["id"], "one.pdf")
    seed_pending(blobs, competition["id"], "two.pdf")

    body = payload(reject(competition["id"]))
    assert body["deleted"] == 2
    assert body["source"]["status"] == "rejected"
    assert body["source"]["pendingCount"] == 0
    assert body["source"]["pendingBytes"] == 0
    assert "acceptedUntilUtc" not in body["source"]

    assert blobs.blobs == {}
    row = source_row(table, competition["id"])
    assert row["Status"] == "rejected"
    assert row["RejectedBy"] == "skater@example.com"
    assert row["RejectedUtc"]
    assert row["AcceptedUntilUtc"] == ""


def test_revoking_stops_the_source_but_keeps_the_files_it_already_delivered(table, blobs):
    competition = create_competition()
    seed_source(table, competition["id"])
    seed_pending(blobs, competition["id"], "attached.pdf")
    assert payload(accept(competition["id"]))["attached"] == 1

    seed_pending(blobs, competition["id"], "arrived-later.pdf")
    body = payload(revoke(competition["id"]))
    assert body["deleted"] == 1
    assert body["source"]["status"] == "rejected"
    # Already in the pool = already part of the competition; only the
    # not-yet-accepted quarantine goes.
    assert pool_names(blobs, competition["id"]) == ["attached.pdf"]
    assert pool_names(blobs, competition["id"],
                      fa.competition_pending_prefix(competition["id"], IP)) == []


# ── deleted competitions ──────────────────────────────────────────────────────

def test_no_source_can_be_changed_on_a_deleted_competition(table, blobs):
    competition = create_competition()
    seed_source(table, competition["id"])
    seed_pending(blobs, competition["id"], "one.pdf")
    fa._delete_competition(make_request("DELETE", route_params={"id": competition["id"]}))

    for call in (accept, reject, revoke):
        response = call(competition["id"])
        assert response.status_code == 409, call.__name__
        assert payload(response)["error"] == "competition_deleted"

    assert source_row(table, competition["id"])["Status"] == "pending"
    assert pool_names(blobs, competition["id"],
                      fa.competition_pending_prefix(competition["id"], IP)) == ["one.pdf"]
    # Reading still works — the panel has to explain why nothing can be done.
    assert list_sources(competition["id"]).status_code == 200


# ── the file pool sees the result ─────────────────────────────────────────────

def test_quarantined_files_are_invisible_until_they_are_accepted(table, blobs):
    competition = create_competition()
    seed_source(table, competition["id"])
    seed_pending(blobs, competition["id"], "FSK_C08_Competition_Schedule.pdf")

    files = payload(fa._list_competition_files(make_request(
        "GET", route_params={"id": competition["id"]})))["files"]
    assert files == []

    accept(competition["id"])

    files = payload(fa._list_competition_files(make_request(
        "GET", route_params={"id": competition["id"]})))["files"]
    assert [(f["name"], f["source"], f["sourceTool"], f["uploadedBy"]) for f in files] == [
        ("FSK_C08_Competition_Schedule.pdf", "fsm", fa.SOURCE_TOOL_HOVTP, f"hovtp:{IP}")]
    assert files[0]["contentType"] == "application/pdf"
