"""Per-IP trust: quarantine, acceptance, expiry, rejection and the quotas.

FSM authenticates with nothing, so an unknown IP is neither trusted nor turned
away — its files are quarantined under `<guid>/fsm-pending/<ip>/`, invisible to
the pool listing, until an operator accepts the source in the UI. Accepted
sources write flat into `<guid>/fsm/`, which is the only layout the pool listing
walks.
"""
import fixtures
import function_app as fa
from conftest import (COMPETITION_ID, DEFAULT_IP, head, make_request, seed_source,
                      source_row)

FSM = f"{COMPETITION_ID}/fsm/"
PENDING = f"{COMPETITION_ID}/fsm-pending/{DEFAULT_IP}/"


def _post(**kwargs):
    kwargs.setdefault("body", fixtures.DT_SCHEDULE_BODY)
    return fa._handle_hovtp(make_request(**kwargs))


# ── quarantine ────────────────────────────────────────────────────────────────

def test_an_unknown_ip_is_quarantined_and_surfaces_as_pending(table, blobs):
    response = _post()

    assert response.status_code == 200
    assert list(blobs.blobs) == [
        PENDING + "DT_SCHEDULE_FSK-------------------------------.xml"]

    row = source_row(table)
    assert row["Status"] == "pending"
    assert row["Ip"] == DEFAULT_IP
    assert row["CompetitionId"] == COMPETITION_ID
    assert row["Origin"] == "FSM"
    assert row["Venue"] == "HTL"
    assert row["Discipline"] == "FSK"
    assert row["Environment"] == "Test"
    assert row["LastDataType"] == "ODF"
    assert row["LastDocumentType"] == "DT_SCHEDULE"
    assert row["MessageCount"] == 1
    assert row["PendingCount"] == 1
    assert row["PendingBytes"] == len(fixtures.DT_SCHEDULE_BODY)
    assert row["FirstSeenUtc"] == row["LastSeenUtc"]


def test_first_seen_is_never_rewritten(table, blobs):
    _post()
    first_seen = source_row(table)["FirstSeenUtc"]

    _post(body=fixtures.DT_PARTIC_BODY)

    row = source_row(table)
    assert row["FirstSeenUtc"] == first_seen
    assert row["MessageCount"] == 2
    assert row["PendingCount"] == 2


def test_a_second_ip_gets_its_own_folder_and_row(table, blobs):
    _post()
    _post(client_ip="198.51.100.4")

    assert sorted(blobs.blobs) == [
        f"{COMPETITION_ID}/fsm-pending/198.51.100.4/"
        "DT_SCHEDULE_FSK-------------------------------.xml",
        PENDING + "DT_SCHEDULE_FSK-------------------------------.xml",
    ]
    assert len(table.rows_in(fa.PK_HOVTP_SOURCE)) == 2


# ── acceptance ────────────────────────────────────────────────────────────────

def test_an_accepted_ip_writes_flat_into_the_pool(table, blobs):
    seed_source(table, status="accepted", accepted_until="2099-01-01T00:00:00Z")

    response = _post()

    assert response.status_code == 200
    assert list(blobs.blobs) == [FSM + "DT_SCHEDULE_FSK-------------------------------.xml"]
    row = source_row(table)
    assert row["Status"] == "accepted"
    assert row["PendingCount"] == 0
    assert row["PendingBytes"] == 0


def test_an_expired_acceptance_flips_back_to_pending(table, blobs):
    seed_source(table, status="accepted", accepted_until="2020-01-01T00:00:00Z")

    response = _post()

    assert response.status_code == 200
    # Quarantined again, so the UI re-prompts instead of trusting a stale decision.
    assert list(blobs.blobs) == [
        PENDING + "DT_SCHEDULE_FSK-------------------------------.xml"]
    assert source_row(table)["Status"] == "pending"


def test_an_accepted_row_without_a_window_is_treated_as_pending(table, blobs):
    seed_source(table, status="accepted", accepted_until="")

    _post()

    assert source_row(table)["Status"] == "pending"


# ── rejection ─────────────────────────────────────────────────────────────────

def test_a_rejected_source_is_451_and_only_its_counters_are_touched(table, blobs):
    seed_source(table, status="rejected", pending_count=0, pending_bytes=0,
                message_count=4)
    before = dict(source_row(table))

    response = _post()

    assert response.status_code == 451
    assert head(response, "X-HOVTP-Error-Reason") == "source not accepted"
    assert blobs.blobs == {}

    row = source_row(table)
    assert row["Status"] == "rejected"
    assert row["MessageCount"] == 5
    assert row["LastSeenUtc"] != before["LastSeenUtc"]
    assert row["PendingCount"] == before["PendingCount"]
    assert row["PendingBytes"] == before["PendingBytes"]
    assert "LastDocumentType" not in row


def test_a_rejected_source_still_commits_the_serial(table, blobs):
    seed_source(table, status="rejected")
    session_id = "6d4f1b9e-2c3a-4c0d-9f1e-0a1b2c3d4e5f"

    response = _post(session_id=session_id, serial=1)

    assert response.status_code == 451
    assert head(response, "X-HOVTP-Last-Serial-Number") == "1"
    assert table.rows[(fa.PK_HOVTP_SESSION, session_id)]["LastSerial"] == 1


# ── quotas ────────────────────────────────────────────────────────────────────

def test_the_pending_file_quota_is_451(table, blobs):
    seed_source(table, pending_count=fa.MAX_PENDING_FILES)

    response = _post()

    assert response.status_code == 451
    assert head(response, "X-HOVTP-Error-Reason") == "quarantine full"
    assert blobs.blobs == {}


def test_the_pending_byte_quota_is_451(table, blobs):
    seed_source(table, pending_bytes=fa.MAX_PENDING_BYTES)

    response = _post()

    assert response.status_code == 451
    assert head(response, "X-HOVTP-Error-Reason") == "quarantine full"


def test_the_pending_source_quota_is_451(table, blobs):
    for index in range(fa.MAX_PENDING_SOURCES):
        seed_source(table, ip=f"198.51.100.{index + 1}")

    response = _post()

    assert response.status_code == 451
    assert head(response, "X-HOVTP-Error-Reason") == "quarantine full"
    assert blobs.blobs == {}


def test_an_already_counted_pending_source_is_not_double_counted(table, blobs):
    seed_source(table, ip=DEFAULT_IP)
    for index in range(fa.MAX_PENDING_SOURCES - 1):
        seed_source(table, ip=f"198.51.100.{index + 1}")

    assert _post().status_code == 200


def test_the_source_quota_ignores_other_competitions(table, blobs):
    for index in range(fa.MAX_PENDING_SOURCES + 5):
        seed_source(table, competition_id="9999-elsewhere", ip=f"198.51.100.{index + 1}")

    assert _post().status_code == 200


def test_an_accepted_source_is_not_subject_to_the_quotas(table, blobs):
    seed_source(table, status="accepted", accepted_until="2099-01-01T00:00:00Z",
                pending_count=fa.MAX_PENDING_FILES, pending_bytes=fa.MAX_PENDING_BYTES)

    assert _post().status_code == 200


# ── environment and the kill switch ───────────────────────────────────────────

def test_an_environment_mismatch_is_accepted_and_our_environment_echoed(table, blobs):
    response = _post(headers={"X-HOVTP-Environment": "Production"})

    assert response.status_code == 200
    assert head(response, "X-HOVTP-Environment") == "Test"
    assert source_row(table)["Environment"] == "Production"
    assert len(blobs.blobs) == 1


def test_the_environment_is_echoed_from_the_setting(table, blobs, monkeypatch):
    monkeypatch.setenv("HOVTP_ENVIRONMENT", "Production")

    assert head(_post(), "X-HOVTP-Environment") == "Production"


def test_disabled_is_503_and_stores_nothing(table, blobs, monkeypatch):
    monkeypatch.setenv("HOVTP_ENABLED", "false")

    response = _post(body=fixtures.DT_PDF_BODY)

    assert response.status_code == 503
    assert head(response, "X-HOVTP-Error-Reason") == "receiver disabled"
    assert head(response, "Cache-Control") == "no-cache"
    assert blobs.blobs == {}
    assert table.writes() == []


def test_the_kill_switch_understands_the_documented_spellings(monkeypatch):
    for value in ("0", "false", "FALSE", "no", "No"):
        monkeypatch.setenv("HOVTP_ENABLED", value)
        assert fa._enabled() is False
    for value in ("1", "true", "yes", ""):
        monkeypatch.setenv("HOVTP_ENABLED", value)
        assert fa._enabled() is True
