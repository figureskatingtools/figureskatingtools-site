"""Private competitions with sharing: users, grants and the access check.

Every competition is visible only to its owner and the users it is shared
with (read or write); only the owner or an admin manages shares; only an
admin moves the ownership. The identity is the router's tid/oid — never the
e-mail — resolved to an internal userId. These tests pin down:

  * the route matrix — every /api/competitions* route against {none, read,
    write, owner, admin}, with "none" a 404 that writes nothing anywhere;
  * the share routes, the users directory routes and their limits;
  * user resolution (first request, the insert race, the hourly LastSeen);
  * the one-time legacy owner claim;
  * the admin owner swap as one table transaction;
  * retention: purge drops the grants, inactive users are removed.
"""
import copy
from datetime import datetime, timedelta, timezone

import pytest
from azure.core.exceptions import ResourceExistsError

import function_app as fa
from conftest import (
    ADMIN_EMAIL,
    TENANT_ID,
    USER_EMAIL,
    USER_ID,
    make_request,
    oid_for,
    payload,
)

READER = "reader@example.com"
WRITER = "writer@example.com"
STRANGER = "stranger@example.com"
GRANTEE = "grantee@example.com"
IP = "20.31.4.7"
PDF = b"%PDF-1.7 fake pdf bytes"


# ── helpers ───────────────────────────────────────────────────────────────────

def create(name="Winter Cup 2026", **kwargs):
    response = fa._create_competition(make_request("POST", body={"name": name}, **kwargs))
    assert response.status_code == 201
    return payload(response)


def listing(**kwargs):
    return payload(fa._list_competitions(make_request("GET", **kwargs)))


def snapshot(table, blobs):
    """Every table row and blob, for the "wrote nothing" assertions."""
    return copy.deepcopy({
        "competitions": table.rows, "clock": table.clock.rows, "adminlog": table.adminlog.rows,
        "users": table.users.rows, "identities": table.identities.rows,
        "access": table.access.rows, "blobs": {k: v.data for k, v in blobs.blobs.items()},
    })


@pytest.fixture
def world(table, blobs, monkeypatch):
    """One competition owned by the default user, shared read with READER and
    write with WRITER and read with GRANTEE; STRANGER has signed in but has no
    access; ADMIN_EMAIL is an admin with no grant. Plus one uploaded file and
    one pending HOVTP source, so every route has something to act on."""
    monkeypatch.setenv("ADMIN_EMAILS", ADMIN_EMAIL)
    competition = create()
    cid = competition["id"]
    ids = {email: table.seed_user(email, email.split("@")[0].title())
           for email in (READER, WRITER, STRANGER, GRANTEE, ADMIN_EMAIL)}
    table.grant(cid, ids[READER], "read")
    table.grant(cid, ids[WRITER], "write")
    table.grant(cid, ids[GRANTEE], "read")
    blobs.upload_blob(name=fa.competition_upload_prefix(cid) + "a.pdf", data=PDF,
                      overwrite=True, metadata={"uploadedBy": USER_EMAIL})
    table.create_entity({
        "PartitionKey": fa.PK_HOVTP_SOURCE, "RowKey": fa.hovtp_source_row_key(cid, IP),
        "CompetitionId": cid, "Ip": IP, "Status": fa.HOVTP_STATUS_PENDING,
        "LastSeenUtc": "2026-01-02T10:05:00Z",
    })
    table.adminlog.rows.clear()
    return {"id": cid, "code": competition["code"], "ids": ids}


# ── the route matrix ──────────────────────────────────────────────────────────

ROUTES = {
    # name: (handler, method, kwargs builder, need)
    "get": (fa._get_competition, "GET", lambda w: {}, "read"),
    "list files": (fa._list_competition_files, "GET", lambda w: {}, "read"),
    "download": (fa._download_competition_file, "GET",
                 lambda w: {"route_params": {"name": "a.pdf"}}, "read"),
    "hovtp list": (fa._list_hovtp_sources, "GET", lambda w: {}, "read"),
    "patch": (fa._update_competition, "PATCH", lambda w: {"body": {"venue": "Tampere"}}, "write"),
    "put": (fa._update_competition, "PUT", lambda w: {"body": {"venue": "Tampere"}}, "write"),
    "extend": (fa._extend_competition, "POST", lambda w: {}, "write"),
    "upload": (fa._upload_competition_file, "POST",
               lambda w: {"raw_body": PDF, "params": {"filename": "b.pdf"}}, "write"),
    "delete file": (fa._delete_competition_file, "DELETE",
                    lambda w: {"route_params": {"name": "a.pdf"}}, "write"),
    "hovtp accept": (fa._accept_hovtp_source, "POST",
                     lambda w: {"body": {"days": 1}, "route_params": {"ip": IP}}, "write"),
    "hovtp reject": (fa._deny_hovtp_source, "POST", lambda w: {"route_params": {"ip": IP}}, "write"),
    "hovtp revoke": (fa._deny_hovtp_source, "DELETE", lambda w: {"route_params": {"ip": IP}}, "write"),
    "delete": (fa._delete_competition, "DELETE", lambda w: {}, "owner"),
    "access list": (fa._list_access, "GET", lambda w: {}, "owner"),
    "access set": (fa._set_access, "PUT", lambda w: {
        "body": {"role": "write"}, "route_params": {"userId": w["ids"][STRANGER]}}, "owner"),
    "access revoke": (fa._remove_access, "DELETE",
                      lambda w: {"route_params": {"userId": w["ids"][GRANTEE]}}, "owner"),
}

CALLERS = {"none": STRANGER, "read": READER, "write": WRITER, "owner": USER_EMAIL,
           "admin": ADMIN_EMAIL}
RANK = {"none": 0, "read": 1, "write": 2, "owner": 3, "admin": 3}


def call_route(world, route, email):
    handler, method, build, _need = ROUTES[route]
    kwargs = build(world)
    route_params = {"id": world["id"], **kwargs.pop("route_params", {})}
    return handler(make_request(method, route_params=route_params, user_email=email, **kwargs))


@pytest.mark.parametrize("caller", list(CALLERS))
@pytest.mark.parametrize("route", list(ROUTES))
def test_the_route_matrix(world, table, blobs, route, caller):
    need = ROUTES[route][3]
    # The gate's hourly LastSeen refresh is the caller's own bookkeeping, not
    # the route's: let it happen first, then nothing at all may change.
    fa._current_user(make_request("GET", user_email=CALLERS[caller]))
    before = snapshot(table, blobs)

    response = call_route(world, route, CALLERS[caller])

    if RANK[caller] >= RANK[need]:
        assert response.status_code in (200, 201), (route, caller, response.get_body())
        return
    body = payload(response)
    if caller == "none":
        # Existence never leaks, and nothing anywhere is written.
        assert (response.status_code, body["error"]) == (404, "not_found"), route
    elif need == "owner":
        assert (response.status_code, body["error"]) == (403, "owner_required"), route
    else:
        assert (response.status_code, body["error"]) == (403, "read_only"), route
    assert snapshot(table, blobs) == before, f"{route} by {caller} wrote something"


@pytest.mark.parametrize("route", list(ROUTES))
def test_an_unknown_competition_is_the_same_404_as_no_access(world, table, route):
    world = {**world, "id": "8a9b6c3d-0000-4000-8000-00000000abcd"}
    response = call_route(world, route, USER_EMAIL)
    assert (response.status_code, payload(response)["error"]) == (404, "not_found")


def test_a_competition_id_outside_the_key_alphabet_is_a_404(world):
    for bad in ("a/b", "x'y", "a#b", "a" * 101):
        response = fa._get_competition(make_request("GET", route_params={"id": bad}))
        assert response.status_code == 404, bad


def test_every_competition_response_carries_access_and_owner(world):
    for email, access in ((READER, "read"), (WRITER, "write"), (USER_EMAIL, "owner"),
                          (ADMIN_EMAIL, "owner")):
        got = payload(fa._get_competition(make_request(
            "GET", route_params={"id": world["id"]}, user_email=email)))
        assert got["access"] == access, email
        assert got["owner"] == {"userId": USER_ID, "name": "Skater Person", "email": USER_EMAIL}


def test_a_reader_can_download_but_not_upload_or_extend(world, blobs):
    download = fa._download_competition_file(make_request(
        "GET", route_params={"id": world["id"], "name": "a.pdf"}, user_email=READER))
    assert download.get_body() == PDF
    extend = fa._extend_competition(make_request(
        "POST", route_params={"id": world["id"]}, user_email=READER))
    assert payload(extend)["error"] == "read_only"


# ── list filtering ────────────────────────────────────────────────────────────

def test_the_list_holds_own_and_shared_competitions_only(world, table):
    other = create("Other Cup", user_email=STRANGER)

    assert [c["id"] for c in listing()] == [world["id"]]
    assert {c["id"]: c["access"] for c in listing(user_email=READER)} == {world["id"]: "read"}
    assert {c["id"]: c["access"] for c in listing(user_email=STRANGER)} == {other["id"]: "owner"}
    shared = listing(user_email=WRITER)[0]
    assert shared["access"] == "write"
    assert shared["owner"]["email"] == USER_EMAIL


def test_an_admins_own_list_stays_personal(world):
    """Everything is in /api/manage; the home page shows own + shared only."""
    assert listing(user_email=ADMIN_EMAIL) == []
    mine = create("Admin Cup", user_email=ADMIN_EMAIL)
    assert [c["id"] for c in listing(user_email=ADMIN_EMAIL)] == [mine["id"]]


def test_deleted_shared_competitions_follow_include_deleted(world):
    fa._delete_competition(make_request("DELETE", route_params={"id": world["id"]}))
    assert listing(user_email=READER) == []
    assert [c["status"] for c in listing(user_email=READER, params={"includeDeleted": "1"})] \
        == ["deleted"]


def test_a_dangling_grant_is_skipped(world, table):
    table.grant("4d7e0000-0000-4000-8000-000000000000", USER_ID, "owner")
    assert [c["id"] for c in listing()] == [world["id"]]


# ── create ────────────────────────────────────────────────────────────────────

def test_create_makes_the_caller_the_owner(table):
    created = create()
    assert table.access_rows(created["id"]) == {USER_ID: "owner"}
    row = table.access.rows[(created["id"], USER_ID)]
    assert row["GrantedBy"] == USER_ID and row["GrantedUtc"]
    assert created["access"] == "owner"
    assert created["owner"]["userId"] == USER_ID


def test_a_failed_owner_write_undoes_the_create(table):
    table.access.fail_next_create = RuntimeError("table storage exploded")
    response = fa._create_competition(make_request("POST", body={"name": "Winter Cup 2026"}))
    assert response.status_code == 500
    assert table.competition_rows() == []
    assert table.code_rows() == {}
    # …and the code is free for the retry.
    assert create().get("code") == "winter-cup-2026"


# ── share routes ──────────────────────────────────────────────────────────────

def share(world, user_id, role, email=USER_EMAIL):
    return fa._set_access(make_request(
        "PUT", route_params={"id": world["id"], "userId": user_id}, body={"role": role},
        user_email=email))


def unshare(world, user_id, email=USER_EMAIL):
    return fa._remove_access(make_request(
        "DELETE", route_params={"id": world["id"], "userId": user_id}, user_email=email))


def test_the_owner_grants_and_changes_a_role_and_both_are_audited(world, table):
    stranger = world["ids"][STRANGER]

    granted = share(world, stranger, "read")
    assert granted.status_code == 200
    assert payload(granted)["item"] == {"userId": stranger, "name": "Stranger",
                                        "email": STRANGER, "role": "read"}
    row = table.access.rows[(world["id"], stranger)]
    assert (row["Role"], row["GrantedBy"]) == ("read", USER_ID)

    assert payload(share(world, stranger, "write"))["item"]["role"] == "write"
    # The same role again is a no-op.
    assert share(world, stranger, "write").status_code == 200

    grant, change = reversed(table.audit_rows())
    assert (grant["Action"], grant["Actor"], grant["Target"]) == ("access.grant", USER_EMAIL, STRANGER)
    assert grant["Changes"] == '{"role": [null, "read"]}'
    assert change["Action"] == "access.change"
    assert change["Changes"] == '{"role": ["read", "write"]}'
    assert len(table.audit_rows()) == 2


def test_an_admin_can_share_too(world, table):
    assert share(world, world["ids"][STRANGER], "read", email=ADMIN_EMAIL).status_code == 200
    assert table.audit_rows()[0]["Actor"] == ADMIN_EMAIL


def test_share_validation(world, table):
    stranger = world["ids"][STRANGER]
    for role in ("owner", "admin", None, 1):
        assert payload(share(world, stranger, role))["error"] == "invalid_role"
    assert payload(share(world, "not-a-guid", "read"))["error"] == "invalid_user"
    unknown = share(world, "5e5e5e5e-0000-4000-8000-000000000000", "read")
    assert (unknown.status_code, payload(unknown)["error"]) == (404, "user_not_found")
    assert payload(share(world, USER_ID, "read"))["error"] == "cannot_target_self"
    assert payload(share(world, "me", "read"))["error"] == "cannot_target_self"
    # The owner row cannot be targeted, not even by an admin.
    owner = share(world, USER_ID, "read", email=ADMIN_EMAIL)
    assert payload(owner)["error"] == "cannot_change_owner"
    assert table.access_rows(world["id"])[USER_ID] == "owner"
    assert table.audit_rows() == []


def test_sharing_a_deleted_competition_is_refused(world):
    fa._delete_competition(make_request("DELETE", route_params={"id": world["id"]}))
    response = share(world, world["ids"][STRANGER], "read")
    assert (response.status_code, payload(response)["error"]) == (409, "competition_deleted")


def test_the_owner_revokes_and_a_grantee_leaves(world, table):
    revoked = unshare(world, world["ids"][GRANTEE])
    assert payload(revoked) == {"status": "removed", "userId": world["ids"][GRANTEE], "left": False}
    left = unshare(world, "me", email=READER)
    assert payload(left)["left"] is True
    assert set(table.access_rows(world["id"])) == {USER_ID, world["ids"][WRITER]}

    leave, revoke = table.audit_rows()
    assert (revoke["Action"], revoke["Actor"], revoke["Target"]) == \
        ("access.revoke", USER_EMAIL, GRANTEE)
    assert revoke["Changes"] == '{"role": ["read", null]}'
    assert (leave["Action"], leave["Actor"], leave["Target"]) == ("access.leave", READER, READER)
    # The reader is gone for good.
    assert fa._get_competition(make_request(
        "GET", route_params={"id": world["id"]}, user_email=READER)).status_code == 404


def test_leaving_by_explicit_id_works_too(world, table):
    assert unshare(world, world["ids"][WRITER], email=WRITER).status_code == 200
    assert world["ids"][WRITER] not in table.access_rows(world["id"])


def test_remove_access_refusals(world, table):
    # A writer cannot remove someone else.
    response = unshare(world, world["ids"][GRANTEE], email=WRITER)
    assert (response.status_code, payload(response)["error"]) == (403, "owner_required")
    # The owner cannot leave, nor be removed by an admin.
    assert payload(unshare(world, "me"))["error"] == "cannot_change_owner"
    assert payload(unshare(world, USER_ID, email=ADMIN_EMAIL))["error"] == "cannot_change_owner"
    # Nobody to remove.
    missing = unshare(world, world["ids"][STRANGER])
    assert (missing.status_code, payload(missing)["error"]) == (404, "grant_not_found")
    # No access at all: 404 not_found like everywhere.
    assert payload(unshare(world, "me", email=STRANGER))["error"] == "not_found"
    assert payload(unshare(world, "nope"))["error"] == "invalid_user"
    assert len(table.access_rows(world["id"])) == 4


def test_the_access_list(world):
    items = payload(fa._list_access(make_request(
        "GET", route_params={"id": world["id"]})))["items"]
    assert items[0] == {"userId": USER_ID, "name": "Skater Person", "email": USER_EMAIL,
                        "role": "owner"}
    assert [(item["email"], item["role"]) for item in items[1:]] == [
        (WRITER, "write"), (GRANTEE, "read"), (READER, "read")]


# ── users directory ───────────────────────────────────────────────────────────

def search(q, email=USER_EMAIL):
    return fa._search_users(make_request("GET", "/api/users/search", params={"q": q},
                                         user_email=email))


def test_search_matches_name_or_email_and_never_yourself(world, table):
    table.seed_user("joonas.ahonen@example.com", "Joonas Åhonen")
    assert [i["email"] for i in payload(search("åhon"))["items"]] == ["joonas.ahonen@example.com"]
    assert [i["email"] for i in payload(search("JOONAS"))["items"]] == ["joonas.ahonen@example.com"]
    items = payload(search("example.com"))["items"]
    assert USER_EMAIL not in [i["email"] for i in items]
    assert set(items[0]) == {"userId", "name", "email"}
    assert payload(search("skater", email=READER))["items"][0]["userId"] == USER_ID


def test_search_needs_three_characters_and_returns_at_most_eight(world, table):
    for i in range(12):
        table.seed_user(f"coach{i:02}@example.com", f"Coach {i:02}")
    response = search("co")
    assert (response.status_code, payload(response)["error"]) == (400, "query_too_short")
    assert payload(search("   c  "))["error"] == "query_too_short"
    assert len(payload(search("coach"))["items"]) == 8


def test_search_is_rate_limited_per_user(world):
    for _ in range(fa.USER_SEARCH_RATE_LIMIT):
        assert search("reader").status_code == 200
    limited = search("reader")
    assert (limited.status_code, payload(limited)["error"]) == (429, "rate_limited")
    # Someone else is not affected.
    assert search("reader", email=WRITER).status_code == 200


def test_the_rate_limit_window_slides(world, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(fa.time, "monotonic", lambda: clock[0])
    for _ in range(fa.USER_SEARCH_RATE_LIMIT):
        search("reader")
    assert search("reader").status_code == 429
    clock[0] += fa.USER_SEARCH_RATE_WINDOW_SECONDS
    assert search("reader").status_code == 200


def test_recent_lists_who_you_shared_your_own_competitions_with(world, table):
    items = payload(fa._recent_share_users(make_request("GET")))["items"]
    assert {i["email"] for i in items} == {READER, WRITER, GRANTEE}
    # A grantee's "recent" holds nobody: they own nothing.
    assert payload(fa._recent_share_users(make_request("GET", user_email=READER)))["items"] == []


def test_me(world):
    me = payload(fa._current_user(make_request("GET", user_email=READER)))
    assert me == {"userId": world["ids"][READER], "name": "", "email": READER, "isAdmin": False}
    admin = payload(fa._current_user(make_request("GET", user_email=ADMIN_EMAIL)))
    assert admin["isAdmin"] is True


# ── user resolution ───────────────────────────────────────────────────────────

def test_the_first_request_creates_the_user_and_the_identity_link(table):
    oid = oid_for("new@example.com")
    me = payload(fa._current_user(make_request("GET", user_email="New@Example.com ",
                                               name="Nöel Üser")))
    user_id = me["userId"]
    assert me["email"] == "new@example.com" and me["name"] == "Nöel Üser"
    user = table.users.rows[(fa.PK_USER, user_id)]
    assert (user["Email"], user["DisplayName"]) == ("new@example.com", "Nöel Üser")
    assert user["FirstSeenUtc"] and user["LastSeenUtc"]
    link = table.identities.rows[(fa.PK_IDENTITY, f"{TENANT_ID}_{oid}")]
    assert (link["UserId"], link["Tid"], link["Oid"], link["Provider"]) == \
        (user_id, TENANT_ID, oid, "entra")

    # The same identity is the same user, whatever the e-mail says now.
    again = payload(fa._current_user(make_request("GET", user_email="renamed@example.com",
                                                  oid=oid)))
    assert again["userId"] == user_id
    assert len(table.users.rows) == 2   # the seeded default user + this one


def test_the_same_email_under_another_oid_is_another_user(table):
    other = payload(fa._current_user(make_request("GET", oid="99999999-0000-4000-8000-000000000000")))
    assert other["userId"] != USER_ID


def test_concurrent_first_requests_converge_on_one_user(table):
    """Two first requests of one identity: the loser of the identity insert
    drops its own users row and adopts the winner's userId."""
    winner = "7a7a7a7a-0000-4000-8000-000000000000"
    original = table.identities.create_entity

    def racing_create(entity):
        if entity["PartitionKey"] == fa.PK_IDENTITY and winner not in str(table.users.rows):
            table.users.create_entity({"PartitionKey": fa.PK_USER, "RowKey": winner,
                                       "Email": "racer@example.com"})
            original({**entity, "UserId": winner})
        return original(entity)

    table.identities.create_entity = racing_create
    me = payload(fa._current_user(make_request("GET", user_email="racer@example.com")))

    assert me["userId"] == winner
    assert [rk for (_pk, rk) in table.users.rows if rk != USER_ID] == [winner]


def test_last_seen_is_refreshed_at_most_hourly(table, monkeypatch):
    clock = [5000.0]
    monkeypatch.setattr(fa.time, "monotonic", lambda: clock[0])
    row = table.users.rows[(fa.PK_USER, USER_ID)]

    fa._current_user(make_request("GET", name="Skater P."))
    first = row_now = table.users.rows[(fa.PK_USER, USER_ID)]
    assert first["LastSeenUtc"] != row["LastSeenUtc"]
    assert row_now["DisplayName"] == "Skater P."
    writes = [c for c in table.users.calls if c[0] == "upsert_entity"]

    clock[0] += 60
    fa._current_user(make_request("GET", name="Changed Again"))
    assert [c for c in table.users.calls if c[0] == "upsert_entity"] == writes

    clock[0] += fa.LAST_SEEN_REFRESH_SECONDS
    fa._current_user(make_request("GET", name="Changed Again"))
    assert table.users.rows[(fa.PK_USER, USER_ID)]["DisplayName"] == "Changed Again"


def test_a_missing_name_or_email_never_blanks_the_stored_one(table):
    me = payload(fa._current_user(make_request("GET", user_email=None, oid=oid_for(USER_EMAIL))))
    assert me["userId"] == USER_ID
    row = table.users.rows[(fa.PK_USER, USER_ID)]
    assert (row["Email"], row["DisplayName"]) == (USER_EMAIL, "Skater Person")
    assert row["LastSeenUtc"] != "2026-01-02T10:00:00Z"   # it was refreshed all the same


# ── legacy owner claim ────────────────────────────────────────────────────────

def seed_legacy(table, competition_id, created_by, **columns):
    table.create_entity({
        "PartitionKey": fa.PK_COMPETITION, "RowKey": competition_id, "Code": competition_id,
        "Name": competition_id, "CreatedBy": created_by, "CreatedUtc": "2026-01-02T10:00:00Z",
        "Status": fa.STATUS_ACTIVE, **columns,
    })


def test_a_new_user_claims_their_unowned_legacy_competitions_once(table):
    seed_legacy(table, "mine", "Legacy@Example.com")
    seed_legacy(table, "mine-deleted", "legacy@example.com", Status=fa.STATUS_DELETED)
    seed_legacy(table, "owned", "legacy@example.com")
    table.grant("owned", USER_ID, "owner")
    seed_legacy(table, "theirs", "someone@example.com")
    seed_legacy(table, "purged", "legacy@example.com", PurgedUtc="2026-02-01T03:00:00Z")

    me = payload(fa._current_user(make_request("GET", user_email="legacy@example.com")))

    assert table.access_rows("mine") == {me["userId"]: "owner"}
    assert table.access_rows("mine-deleted") == {me["userId"]: "owner"}
    assert table.access_rows("owned") == {USER_ID: "owner"}
    assert table.access_rows("theirs") == {}
    assert table.access_rows("purged") == {}
    claims = [row for row in table.audit_rows() if row["Action"] == "access.claim"]
    assert {row["CompetitionId"] for row in claims} == {"mine", "mine-deleted"}

    # Only at user creation: a later legacy row is not claimed by an existing user.
    seed_legacy(table, "later", "legacy@example.com")
    fa._current_user(make_request("GET", user_email="legacy@example.com"))
    assert table.access_rows("later") == {}
    assert [c["id"] for c in listing(user_email="legacy@example.com")] == ["mine"]


def test_no_email_claims_nothing(table):
    seed_legacy(table, "blank", "")
    fa._current_user(make_request("GET", user_email=None))
    assert table.access_rows("blank") == {}


# ── admin: owner swap, detail, list, users ───────────────────────────────────

def set_owner(cid, user_id, email=ADMIN_EMAIL):
    return fa._admin_set_owner(make_request(
        "PUT", route_params={"id": cid}, body={"userId": user_id}, user_email=email))


def test_the_owner_swap_is_one_transaction(world, table):
    reader = world["ids"][READER]
    table.access.calls.clear()

    response = set_owner(world["id"], reader)

    assert response.status_code == 200
    rows = table.access_rows(world["id"])
    assert rows[reader] == "owner" and rows[USER_ID] == "write"
    assert list(rows.values()).count("owner") == 1
    writes = [c for c in table.access.calls if c[0] in ("submit_transaction", "upsert_entity",
                                                        "update_entity", "create_entity")]
    assert writes[0] == ("submit_transaction", 2)
    body = payload(response)
    assert body["access"][0]["userId"] == reader and body["access"][0]["role"] == "owner"
    admin_id = table.user_id(ADMIN_EMAIL)
    assert table.access.rows[(world["id"], reader)]["GrantedBy"] == admin_id
    # The former owner keeps write access and loses the owner routes.
    assert payload(fa._delete_competition(make_request(
        "DELETE", route_params={"id": world["id"]})))["error"] == "owner_required"


def test_a_failed_swap_changes_nothing(world, table):
    def conflicting_write(client, key):
        client.rows[key] = {**client.rows[key], "Role": "owner"}
        client.etags[key] = "changed"

    before = dict(table.access_rows(world["id"]))
    # Every attempt loses its race: nothing is half-applied.
    original = table.access.submit_transaction

    def always_racing(operations):
        table.access.before_conditional_update = conflicting_write
        return original(operations)

    table.access.submit_transaction = always_racing
    response = set_owner(world["id"], world["ids"][READER])
    assert (response.status_code, payload(response)["error"]) == (409, "conflict")
    assert table.access_rows(world["id"]) == before
    assert table.audit_rows() == []


def test_a_swap_racing_a_grant_change_retries(world, table):
    def concurrent_change(client, key):
        client.etags[key] = "changed-meanwhile"

    table.access.before_conditional_update = concurrent_change
    assert set_owner(world["id"], world["ids"][WRITER]).status_code == 200
    assert table.access_rows(world["id"])[world["ids"][WRITER]] == "owner"
    assert table.access_rows(world["id"])[USER_ID] == "write"


def test_an_unowned_legacy_competition_gets_its_first_owner(world, table):
    seed_legacy(table, "orphan", "gone@example.com")
    assert set_owner("orphan", world["ids"][STRANGER]).status_code == 200
    assert table.access_rows("orphan") == {world["ids"][STRANGER]: "owner"}
    [audit] = table.audit_rows()
    assert audit["Changes"] == f'{{"owner": [null, "{STRANGER}"]}}'


def test_owner_swap_validation(world, table):
    assert payload(set_owner(world["id"], "nope"))["error"] == "invalid_user"
    unknown = set_owner(world["id"], "5e5e5e5e-0000-4000-8000-000000000000")
    assert (unknown.status_code, payload(unknown)["error"]) == (404, "user_not_found")
    assert set_owner("no-such", world["ids"][READER]).status_code == 404
    assert payload(set_owner(world["id"], world["ids"][READER], email=USER_EMAIL))["error"] \
        == "admin_required"
    # The current owner again: a no-op.
    assert set_owner(world["id"], USER_ID).status_code == 200
    assert table.audit_rows() == []


def test_a_purged_competition_has_no_owner_to_change(world, table, blobs):
    fa._admin_purge_competition(make_request(
        "POST", route_params={"id": world["id"]}, body={"confirm": world["code"]},
        user_email=ADMIN_EMAIL))
    response = set_owner(world["id"], world["ids"][READER])
    assert (response.status_code, payload(response)["error"]) == (409, "purged")


def test_admin_detail_list_and_users(world, table, blobs):
    detail = payload(fa._admin_get_competition(make_request(
        "GET", route_params={"id": world["id"]}, user_email=ADMIN_EMAIL)))
    assert [(a["email"], a["role"]) for a in detail["access"]][0] == (USER_EMAIL, "owner")
    assert len(detail["access"]) == 4

    listed = payload(fa._admin_list_competitions(make_request("GET", user_email=ADMIN_EMAIL)))
    [competition] = listed["competitions"]
    assert competition["owner"] == {"userId": USER_ID, "name": "Skater Person", "email": USER_EMAIL}

    users = payload(fa._admin_list_users(make_request("GET", user_email=ADMIN_EMAIL)))["users"]
    by_email = {u["email"]: u for u in users}
    assert (by_email[USER_EMAIL]["owned"], by_email[USER_EMAIL]["shared"]) == (1, 0)
    assert (by_email[READER]["owned"], by_email[READER]["shared"]) == (0, 1)
    assert by_email[STRANGER]["identities"] == 1
    assert set(by_email[READER]) == {"userId", "name", "email", "firstSeenUtc", "lastSeenUtc",
                                     "owned", "shared", "identities"}
    assert payload(fa._admin_list_users(make_request("GET")))["error"] == "admin_required"


def test_the_admin_gate_needs_the_forwarded_identity_and_tenant(world, table):
    no_oid = fa._admin_list_competitions(make_request("GET", user_email=ADMIN_EMAIL, oid=None))
    assert (no_oid.status_code, payload(no_oid)["error"]) == (401, "unauthorized")
    foreign = fa._admin_list_competitions(make_request(
        "GET", user_email=ADMIN_EMAIL, tid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))
    assert (foreign.status_code, payload(foreign)["error"]) == (403, "tenant_not_allowed")


# ── retention ─────────────────────────────────────────────────────────────────

def test_soft_delete_and_restore_keep_the_grants(world, table):
    before = table.access_rows(world["id"])
    fa._delete_competition(make_request("DELETE", route_params={"id": world["id"]}))
    assert table.access_rows(world["id"]) == before
    fa._admin_restore_competition(make_request(
        "POST", route_params={"id": world["id"]}, user_email=ADMIN_EMAIL))
    assert table.access_rows(world["id"]) == before
    assert payload(fa._get_competition(make_request(
        "GET", route_params={"id": world["id"]}, user_email=READER)))["status"] == "active"


def test_a_purge_deletes_the_grants(world, table, blobs):
    fa._delete_competition(make_request("DELETE", route_params={"id": world["id"]}))
    tomorrow = datetime.now(timezone.utc) + timedelta(days=1, hours=3)
    summary = fa._run_retention_sweep(tomorrow, True)
    assert summary["purged"] == 1
    assert table.access_rows(world["id"]) == {}
    assert listing() == []


def test_an_admin_purge_deletes_the_grants(world, table, blobs):
    response = fa._admin_purge_competition(make_request(
        "POST", route_params={"id": world["id"]}, body={"confirm": world["code"]},
        user_email=ADMIN_EMAIL))
    assert response.status_code == 200
    assert table.access_rows(world["id"]) == {}


def test_a_failed_grant_delete_leaves_no_tombstone(world, table, blobs):
    table.access.fail_next_delete = RuntimeError("boom")
    fa._delete_competition(make_request("DELETE", route_params={"id": world["id"]}))
    summary = fa._run_retention_sweep(datetime.now(timezone.utc) + timedelta(days=1, hours=3), True)
    assert summary["failed"] == 1
    assert not table.rows[(fa.PK_COMPETITION, world["id"])].get("PurgedUtc")


def test_the_resweep_catches_a_late_grant(world, table, blobs):
    fa._delete_competition(make_request("DELETE", route_params={"id": world["id"]}))
    now = datetime.now(timezone.utc) + timedelta(days=1, hours=3)
    fa._run_retention_sweep(now, True)
    table.grant(world["id"], world["ids"][READER], "read")   # landed after the purge
    summary = fa._run_retention_sweep(now + timedelta(days=1), True)
    assert summary["resweeps"] == 1
    assert table.access_rows(world["id"]) == {}


LONG_AGO = "2025-01-01T00:00:00Z"
NOW = datetime(2026, 10, 17, 3, 0, tzinfo=timezone.utc)


def test_inactive_users_who_own_nothing_live_are_removed(table, blobs):
    idle = table.seed_user("idle@example.com", last_seen=LONG_AGO)
    owner = table.seed_user("idle-owner@example.com", last_seen=LONG_AGO)
    recent = table.seed_user("recent@example.com", last_seen="2026-10-01T00:00:00Z")
    stale_owner = table.seed_user("stale-owner@example.com", last_seen=LONG_AGO)
    live = create("Live Cup")
    table.grant(live["id"], idle, "read")
    table.grant(live["id"], owner, "owner")
    # An owner row whose competition is long gone keeps nobody.
    table.grant("3c3c3c3c-0000-4000-8000-000000000000", stale_owner, "owner")

    summary = fa._run_retention_sweep(NOW, True)

    assert summary["users_deleted"] == 2
    remaining = {rk for (_pk, rk) in table.users.rows}
    assert remaining == {USER_ID, owner, recent}
    assert idle not in table.access_rows(live["id"])
    assert not any(row["UserId"] in (idle, stale_owner) for row in table.identities.rows.values())
    assert table.access_rows("3c3c3c3c-0000-4000-8000-000000000000") == {}


def test_the_inactive_user_sweep_obeys_the_kill_switch(table, blobs):
    idle = table.seed_user("idle@example.com", last_seen=LONG_AGO)
    summary = fa._run_retention_sweep(NOW, False)
    assert (summary["users_deleted"], summary["users_would_delete"]) == (0, 1)
    assert (fa.PK_USER, idle) in table.users.rows


def test_a_failed_grant_delete_keeps_the_user_for_tomorrow(table, blobs):
    idle = table.seed_user("idle@example.com", last_seen=LONG_AGO)
    live = create("Live Cup")
    table.grant(live["id"], idle, "read")
    table.access.fail_next_delete = RuntimeError("boom")
    summary = fa._run_retention_sweep(NOW, True)
    assert summary["users_deleted"] == 0
    assert (fa.PK_USER, idle) in table.users.rows


def test_a_removed_user_who_returns_starts_afresh(table, blobs):
    table.seed_user("idle@example.com", last_seen=LONG_AGO)
    fa._run_retention_sweep(NOW, True)
    me = payload(fa._current_user(make_request("GET", user_email="idle@example.com")))
    assert me["userId"] and (fa.PK_USER, me["userId"]) in table.users.rows


def test_a_competing_identity_insert_without_a_winner_row_is_an_error(table, monkeypatch):
    """Defensive: the identity insert conflicts but the row is unreadable."""
    def conflict(entity):
        raise ResourceExistsError("exists")

    table.identities.create_entity = conflict
    monkeypatch.setattr(table.identities, "get_entity",
                        lambda **kw: {"UserId": ""})
    response = fa._current_user(make_request("GET", user_email="ghost@example.com"))
    assert response.status_code == 500
    assert all(rk == USER_ID for (_pk, rk) in table.users.rows)
