"""Entra External ID readiness (phase B): an identity of the external tenant
becomes a new platform user only with EXTERNAL_NEW_USERS_ENABLED on (test).

  * off: a new external identity gets 503 migration_pending and writes nothing;
  * on: it becomes a new user (Provider entra-external), with no legacy claim;
  * an external identity that already has a useridentities row works as today;
  * workforce identities are untouched, also with EXTERNAL_TENANT_IDS set;
  * the tenant allow-list still applies first.
"""
import copy

import pytest

import function_app as fa
from conftest import TENANT_ID, USER_EMAIL, USER_ID, make_request, oid_for, payload

EXTERNAL_TENANT_ID = "380073b3-804e-4cc7-bfcc-843637630d04"
EXTERNAL_EMAIL = "skater@gmail.com"


@pytest.fixture
def external(monkeypatch, table):
    """The external tenant configured as the deployment does it: allowed, and
    named in EXTERNAL_TENANT_IDS (mixed case and spaces on purpose)."""
    monkeypatch.setenv("ALLOWED_TENANT_IDS", f"{TENANT_ID},{EXTERNAL_TENANT_ID}")
    monkeypatch.setenv("EXTERNAL_TENANT_IDS", f" {EXTERNAL_TENANT_ID.upper()} ")
    return table


def tables(table):
    return copy.deepcopy({"users": table.users.rows, "identities": table.identities.rows,
                          "access": table.access.rows, "competitions": table.rows})


def test_the_provider_constant_is_stable():
    assert fa.IDENTITY_PROVIDER_ENTRA_EXTERNAL == "entra-external"
    assert fa.IDENTITY_PROVIDER_ENTRA == "entra"


def test_external_tenant_ids_are_a_trimmed_lowercased_set(monkeypatch):
    monkeypatch.setenv("EXTERNAL_TENANT_IDS", f" {EXTERNAL_TENANT_ID.upper()} ,, ")
    assert fa._external_tenant_ids() == frozenset({EXTERNAL_TENANT_ID})
    monkeypatch.delenv("EXTERNAL_TENANT_IDS")
    assert fa._external_tenant_ids() == frozenset()


@pytest.mark.parametrize("call", [
    lambda: fa._list_competitions(make_request("GET", user_email=EXTERNAL_EMAIL, tid=EXTERNAL_TENANT_ID)),
    lambda: fa._create_competition(make_request("POST", body={"name": "Winter Cup"},
                                                user_email=EXTERNAL_EMAIL, tid=EXTERNAL_TENANT_ID)),
])
def test_a_new_external_identity_gets_503_migration_pending_and_writes_nothing(external, call):
    before = tables(external)
    response = call()
    assert response.status_code == 503
    assert payload(response)["error"] == "migration_pending"
    assert tables(external) == before
    assert not any(call_[0] != "get_entity" for call_ in external.users.calls)


def test_a_new_external_identity_never_runs_the_legacy_claim(external, monkeypatch):
    claimed = []
    monkeypatch.setattr(fa, "_claim_legacy_competitions", lambda *a: claimed.append(a))
    response = fa._list_competitions(make_request("GET", user_email=USER_EMAIL, tid=EXTERNAL_TENANT_ID))
    assert response.status_code == 503
    assert claimed == []


def test_an_external_identity_with_a_row_resolves_as_today(external):
    oid = oid_for(EXTERNAL_EMAIL)
    external.identities.upsert_entity({
        "PartitionKey": fa.PK_IDENTITY, "RowKey": f"{EXTERNAL_TENANT_ID}_{oid}",
        "UserId": USER_ID, "Tid": EXTERNAL_TENANT_ID, "Oid": oid,
        "Provider": fa.IDENTITY_PROVIDER_ENTRA_EXTERNAL, "CreatedUtc": "2026-10-22T10:00:00Z",
    })
    response = fa._current_user(make_request("GET", "/api/users/me", user_email=EXTERNAL_EMAIL,
                                       tid=EXTERNAL_TENANT_ID, oid=oid))
    assert response.status_code == 200
    assert payload(response)["userId"] == USER_ID


def test_workforce_identities_still_create_users_with_the_external_tenant_configured(external):
    response = fa._list_competitions(make_request("GET", user_email="newcomer@example.com"))
    assert response.status_code == 200
    user_id = external.user_id("newcomer@example.com")
    assert user_id
    link = external.identities.rows[(fa.PK_IDENTITY, f"{TENANT_ID}_{oid_for('newcomer@example.com')}")]
    assert link["Provider"] == fa.IDENTITY_PROVIDER_ENTRA


@pytest.mark.parametrize("value, enabled", [
    ("", False), ("false", False), ("False", False), ("true", True), ("TRUE", True), ("1", True),
])
def test_the_new_users_setting(monkeypatch, value, enabled):
    monkeypatch.setenv("EXTERNAL_NEW_USERS_ENABLED", value)
    assert fa._external_new_users_enabled() is enabled


def test_with_new_users_enabled_a_new_external_identity_becomes_a_user(external, monkeypatch):
    monkeypatch.setenv("EXTERNAL_NEW_USERS_ENABLED", "true")
    claimed = []
    monkeypatch.setattr(fa, "_claim_legacy_competitions", lambda *a: claimed.append(a))
    oid = oid_for(EXTERNAL_EMAIL)
    response = fa._list_competitions(make_request("GET", user_email=EXTERNAL_EMAIL,
                                                  tid=EXTERNAL_TENANT_ID, oid=oid))
    assert response.status_code == 200
    link = external.identities.rows[(fa.PK_IDENTITY, f"{EXTERNAL_TENANT_ID}_{oid}")]
    assert link["Provider"] == fa.IDENTITY_PROVIDER_ENTRA_EXTERNAL
    assert external.users.rows[(fa.PK_USER, link["UserId"])]["Email"] == EXTERNAL_EMAIL
    assert claimed == []


def test_with_new_users_enabled_a_new_external_identity_can_create_a_competition(external, monkeypatch):
    monkeypatch.setenv("EXTERNAL_NEW_USERS_ENABLED", "true")
    response = fa._create_competition(make_request("POST", body={"name": "Winter Cup"},
                                                   user_email=EXTERNAL_EMAIL, tid=EXTERNAL_TENANT_ID))
    assert response.status_code == 201
    assert payload(response)["access"] == "owner"


def test_the_tenant_allow_list_is_checked_before_migration_pending(table, monkeypatch):
    # Named as external but not allowed: the router's 403 wins, nothing is read.
    monkeypatch.setenv("EXTERNAL_TENANT_IDS", EXTERNAL_TENANT_ID)
    response = fa._list_competitions(make_request("GET", user_email=EXTERNAL_EMAIL, tid=EXTERNAL_TENANT_ID))
    assert response.status_code == 403
    assert payload(response)["error"] == "tenant_not_allowed"
    assert table.identities.calls == [] and table.users.calls == []
