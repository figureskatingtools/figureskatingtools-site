"""Terms acceptance: the sign-up checkbox's claim, recorded once per user.

The router forwards X-Forwarded-User-Terms-Accepted: 1 when the sign-in
carries the External ID sign-up's `termsAccepted` claim. The platform writes
the current TERMS_VERSION / PRIVACY_VERSION and the time on the users row the
first time it sees that, never overwrites them, and never refuses anyone for
a missing record (workforce sign-ins have no claim).
"""
import pytest
from azure.core.exceptions import ResourceModifiedError

import function_app as fa
from conftest import USER_ID, make_request, payload

ACCEPTED = {"x-forwarded-user-terms-accepted": "1"}


def _user_row(table, user_id=USER_ID):
    return table.users.rows[(fa.PK_USER, user_id)]


# ── terms_outdated ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("accepted, current, outdated", [
    ("2026-10-22", "2026-10-22", False),
    ("2026-12-01", "2026-10-22", False),   # newer than ours: not outdated
    ("2026-10-21", "2026-10-22", True),
    ("2025-12-31", "2026-01-01", True),
    (None, "2026-10-22", True),             # no record at all
    ("", "2026-10-22", True),
    ("22.10.2026", "2026-10-22", True),     # malformed counts as missing
    ("2026-10-22T00:00:00Z", "2026-10-22", True),
    (" 2026-10-22 ", "2026-10-22", False),
])
def test_terms_outdated(accepted, current, outdated):
    assert fa.terms_outdated(accepted, current) is outdated


def test_terms_outdated_defaults_to_the_current_version():
    assert fa.terms_outdated(fa.TERMS_VERSION) is False
    assert fa.terms_outdated("2000-01-01") is True


def test_the_versions_are_dates():
    assert fa._LEGAL_VERSION_RE.fullmatch(fa.TERMS_VERSION)
    assert fa._LEGAL_VERSION_RE.fullmatch(fa.PRIVACY_VERSION)


# ── recording ─────────────────────────────────────────────────────────────────

def test_a_new_user_with_the_claim_gets_the_current_versions(table):
    me = payload(fa._current_user(make_request("GET", user_email="new@example.com",
                                               headers=ACCEPTED)))
    row = _user_row(table, me["userId"])
    assert row["TermsVersion"] == fa.TERMS_VERSION
    assert row["PrivacyVersion"] == fa.PRIVACY_VERSION
    assert row["TermsAcceptedUtc"] == row["FirstSeenUtc"]


def test_a_new_user_without_the_claim_is_created_without_a_record(table):
    me = payload(fa._current_user(make_request("GET", user_email="workforce@example.com")))
    row = _user_row(table, me["userId"])
    assert "TermsVersion" not in row and "TermsAcceptedUtc" not in row


@pytest.mark.parametrize("value", ["0", "true", "", "yes", "11"])
def test_only_the_exact_header_value_counts(table, value):
    fa._current_user(make_request("GET", headers={"x-forwarded-user-terms-accepted": value}))
    assert "TermsVersion" not in _user_row(table)


def test_an_existing_user_is_recorded_on_the_first_request_with_the_claim(table):
    assert "TermsVersion" not in _user_row(table)
    response = fa._current_user(make_request("GET", headers=ACCEPTED))
    assert response.status_code == 200
    row = _user_row(table)
    assert (row["TermsVersion"], row["PrivacyVersion"]) == (fa.TERMS_VERSION, fa.PRIVACY_VERSION)
    assert row["TermsAcceptedUtc"]
    # The rest of the row is untouched.
    assert row["Email"] == "skater@example.com" and row["FirstSeenUtc"] == "2026-01-01T10:00:00Z"


def test_an_existing_record_is_never_overwritten(table, monkeypatch):
    """An old checkbox must never turn into acceptance of newer terms."""
    table.users.update_entity({"PartitionKey": fa.PK_USER, "RowKey": USER_ID,
                               "TermsVersion": "2026-01-01", "PrivacyVersion": "2026-01-01",
                               "TermsAcceptedUtc": "2026-01-01T09:00:00Z"})
    monkeypatch.setattr(fa, "TERMS_VERSION", "2027-01-01")
    fa._current_user(make_request("GET", headers=ACCEPTED))
    row = _user_row(table)
    assert (row["TermsVersion"], row["TermsAcceptedUtc"]) == ("2026-01-01", "2026-01-01T09:00:00Z")
    assert fa.terms_outdated(row["TermsVersion"]) is True


def test_a_recorded_user_costs_one_read_per_process(table):
    fa._current_user(make_request("GET", headers=ACCEPTED))
    table.users.calls.clear()
    for _ in range(3):
        fa._current_user(make_request("GET", headers=ACCEPTED))
    assert [c for c in table.users.calls if c[0] in ("get_entity", "update_entity")] == []


def test_a_concurrent_write_is_skipped_and_retried_later(table, monkeypatch):
    original = table.users.update_entity
    fail = [True]

    def racing(entity, *args, **kwargs):
        if "TermsVersion" in entity and fail[0]:
            fail[0] = False
            raise ResourceModifiedError("etag mismatch")
        return original(entity, *args, **kwargs)

    monkeypatch.setattr(table.users, "update_entity", racing)
    assert fa._current_user(make_request("GET", headers=ACCEPTED)).status_code == 200
    assert "TermsVersion" not in _user_row(table)
    fa._current_user(make_request("GET", headers=ACCEPTED))
    assert _user_row(table)["TermsVersion"] == fa.TERMS_VERSION


def test_a_failing_record_never_blocks_the_request(table, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("storage down")

    monkeypatch.setattr(table.users, "update_entity", broken)
    response = fa._current_user(make_request("GET", headers=ACCEPTED))
    assert response.status_code == 200
    assert "TermsVersion" not in _user_row(table)
