"""Serial-number bookkeeping (spec §6.2).

Two rules drive everything here: serial 1 always resets the session (that is how
FSM restarts a feed), and the sender gives up after ten consecutive 450s — so a
gap is a warning, not a refusal, unless HOVTP_STRICT_SERIAL says otherwise.

The ordering rule is the other half: the blobs AND the source row are written
BEFORE the serial is committed, so a failed write leaves the cursor where it was
and FSM's resend is accepted instead of meeting a false duplicate.

The third rule only shows up under concurrency: FSM opens several connections on
one session, so the cursor must only ever move forward. Serial 1 is the single
exception, because it is a deliberate reset.
"""
import fixtures
import function_app as fa
from conftest import (DEFAULT_IP, SESSION_ID, concurrent_writer, head, make_request,
                      seed_session, session_row, source_row)


def _post(**kwargs):
    kwargs.setdefault("body", fixtures.DT_SCHEDULE_BODY)
    return fa._handle_hovtp(make_request(**kwargs))


def test_serial_one_creates_the_session(table, blobs):
    response = _post(session_id=SESSION_ID, serial=1)

    assert response.status_code == 200
    assert head(response, "X-HOVTP-Last-Serial-Number") == "1"
    row = session_row(table)
    assert row["LastSerial"] == 1
    assert row["Ip"] == DEFAULT_IP
    assert row["CreatedUtc"] and row["UpdatedUtc"]


def test_serial_one_resets_an_existing_session(table, blobs):
    seed_session(table, last_serial=99)

    response = _post(session_id=SESSION_ID, serial=1)

    assert response.status_code == 200
    assert session_row(table)["LastSerial"] == 1


def test_the_next_serial_is_accepted(table, blobs):
    seed_session(table, last_serial=4)

    response = _post(session_id=SESSION_ID, serial=5)

    assert response.status_code == 200
    assert head(response, "X-HOVTP-Last-Serial-Number") == "5"
    assert session_row(table)["LastSerial"] == 5


def test_duplicate_serial_is_450_and_stores_nothing(table, blobs):
    seed_session(table, last_serial=5)

    response = _post(session_id=SESSION_ID, serial=5)

    assert response.status_code == 450
    assert head(response, "X-HOVTP-Error-Reason") == "duplicate serial 5, last accepted 5"
    assert head(response, "X-HOVTP-Last-Serial-Number") == "5"
    assert blobs.blobs == {}
    assert session_row(table)["LastSerial"] == 5
    assert table.rows_in(fa.PK_HOVTP_SOURCE) == {}


def test_an_older_serial_is_450_too(table, blobs):
    seed_session(table, last_serial=9)

    response = _post(session_id=SESSION_ID, serial=3)

    assert response.status_code == 450
    assert head(response, "X-HOVTP-Last-Serial-Number") == "9"


def test_a_gap_is_accepted_leniently(table, blobs):
    seed_session(table, last_serial=4)

    response = _post(session_id=SESSION_ID, serial=9)

    assert response.status_code == 200
    assert session_row(table)["LastSerial"] == 9
    assert len(blobs.blobs) == 1


def test_a_gap_is_450_under_strict_serial(table, blobs, monkeypatch):
    monkeypatch.setenv("HOVTP_STRICT_SERIAL", "true")
    seed_session(table, last_serial=4)

    response = _post(session_id=SESSION_ID, serial=9)

    assert response.status_code == 450
    assert head(response, "X-HOVTP-Error-Reason") == "serial gap, expected 5"
    assert head(response, "X-HOVTP-Last-Serial-Number") == "4"
    assert blobs.blobs == {}


def test_an_etag_conflict_is_retried(table, blobs):
    seed_session(table, last_serial=4)
    table.fail_updates = 1

    response = _post(session_id=SESSION_ID, serial=5)

    assert response.status_code == 200
    assert session_row(table)["LastSerial"] == 5
    updates = [call for call in table.calls if call[0] == "update_entity"]
    assert len(updates) == 2


def test_the_commit_is_etag_conditional(table, blobs, monkeypatch):
    seed_session(table, last_serial=4)
    seen = {}
    original = table.update_entity

    def spy(entity, mode=None, etag=None, match_condition=None):
        seen["etag"] = etag
        seen["match_condition"] = match_condition
        return original(entity, mode=mode, etag=etag, match_condition=match_condition)

    monkeypatch.setattr(table, "update_entity", spy)
    _post(session_id=SESSION_ID, serial=5)

    assert seen["etag"]
    assert seen["match_condition"] is fa.MatchConditions.IfNotModified


def test_a_never_settling_conflict_still_answers_200(table, blobs):
    seed_session(table, last_serial=4)
    table.fail_updates = 99

    response = _post(session_id=SESSION_ID, serial=5)

    # The blobs are already stored; refusing here would only make FSM resend
    # data we hold. The serial is reported as accepted and logged as unwritten.
    assert response.status_code == 200
    assert len(blobs.blobs) == 1


def test_no_session_headers_still_stores_and_reports_zero(table, blobs):
    response = _post()

    assert response.status_code == 200
    assert head(response, "X-HOVTP-Last-Serial-Number") == "0"
    assert table.rows_in(fa.PK_HOVTP_SESSION) == {}
    assert len(blobs.blobs) == 1


def test_a_failed_upload_leaves_the_serial_uncommitted(table, blobs):
    seed_session(table, last_serial=4)
    blobs.fail_next_upload = RuntimeError("storage is having a day")

    response = _post(session_id=SESSION_ID, serial=5)

    assert response.status_code == 500
    assert session_row(table)["LastSerial"] == 4


def test_a_failed_source_write_leaves_the_serial_uncommitted(table, blobs):
    # The blobs are only half the bookkeeping. Committing the serial before the
    # source row would let a failed row write strand the quarantined files: no
    # row means no listing and no `accept` in the UI, while the resend that
    # could still fix it is answered 450 duplicate.
    seed_session(table, last_serial=4)
    table.fail_next_create = RuntimeError("the table is having a day")

    response = _post(session_id=SESSION_ID, serial=5)

    assert response.status_code == 500
    assert session_row(table)["LastSerial"] == 4
    assert table.rows_in(fa.PK_HOVTP_SOURCE) == {}

    response = _post(session_id=SESSION_ID, serial=5)

    # The resend replays onto the same deterministic blob name (overwrite=True),
    # so nothing is duplicated and nothing is double-counted.
    assert response.status_code == 200
    assert session_row(table)["LastSerial"] == 5
    assert len(blobs.blobs) == 1
    assert source_row(table)["PendingCount"] == 1


def test_a_cursor_another_writer_moved_ahead_is_not_written_back(table, blobs):
    # The handler read 4 before uploading; while the upload ran, the connection
    # carrying serial 6 committed. Our etag is FRESH — nothing conflicts — so
    # only re-reading the value inside the commit keeps 5 from overwriting 6.
    seed_session(table, last_serial=6)

    assert fa.commit_serial(table, SESSION_ID, 5, DEFAULT_IP, "2026-09-01T21:05:00Z") == 6

    assert session_row(table)["LastSerial"] == 6
    assert [call for call in table.calls if call[0] == "update_entity"] == []


def test_a_concurrent_commit_survives_our_retry(table, blobs):
    # Same race, this time with the other writer landing after we read: the etag
    # conflicts, we retry, and the retry must not replay the stale 5 it carries.
    seed_session(table, last_serial=4)
    table.concurrent_writer = concurrent_writer(fa.PK_HOVTP_SESSION, SESSION_ID,
                                                LastSerial=6)

    response = _post(session_id=SESSION_ID, serial=5)

    assert response.status_code == 200
    assert session_row(table)["LastSerial"] == 6
    # Reporting 5 here would ask FSM to resend a serial we already hold.
    assert head(response, "X-HOVTP-Last-Serial-Number") == "6"


def test_serial_one_still_resets_a_cursor_that_is_ahead(table, blobs):
    # The forward-only rule must not swallow the reset: serial 1 is how FSM
    # restarts the feed, and it wins over any cursor it finds.
    seed_session(table, last_serial=6)
    table.concurrent_writer = concurrent_writer(fa.PK_HOVTP_SESSION, SESSION_ID,
                                                LastSerial=9)

    response = _post(session_id=SESSION_ID, serial=1)

    assert response.status_code == 200
    assert session_row(table)["LastSerial"] == 1
    assert head(response, "X-HOVTP-Last-Serial-Number") == "1"
