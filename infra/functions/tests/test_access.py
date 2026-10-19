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
import uuid
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


def test_search_matches_names_only_and_masks_strangers_emails(world, table):
    stranger_id = table.seed_user("joonas.ahonen@club.fi", "Joonas Åhonen")
    for q in ("åhon", "JOONAS", "Joonas Åh"):
        assert payload(search(q))["items"] == [{
            "userId": stranger_id, "name": "Joonas Åhonen",
            "email": None, "emailHint": "j\u2022\u2022\u2022@club.fi"}], q
    # Never by a fragment of the e-mail: neither the local part nor the domain.
    for q in ("joonas.ahonen", "club.fi", "ahonen@", "@club.fi", "example.com"):
        assert payload(search(q))["items"] == [], q
    # Never yourself.
    assert USER_ID not in [i["userId"] for i in payload(search("skater"))["items"]]
    assert payload(search("skater", email=READER))["items"][0]["userId"] == USER_ID


def test_people_you_share_with_get_their_full_email(world, table):
    # The owner shares with READER/WRITER/GRANTEE: full e-mails both ways.
    items = {i["userId"]: i for i in payload(search("reader"))["items"]}
    assert items[world["ids"][READER]]["email"] == READER
    assert items[world["ids"][READER]]["emailHint"] == "r\u2022\u2022\u2022@example.com"
    assert payload(search("skater", email=READER))["items"][0]["email"] == USER_EMAIL
    # Two grantees of the same competition share it too (any role).
    assert payload(search("writer", email=GRANTEE))["items"][0]["email"] == WRITER
    # STRANGER shares nothing with anyone.
    assert payload(search("skater", email=STRANGER))["items"][0]["email"] is None
    assert payload(search("stranger"))["items"][0]["email"] is None


def test_a_full_email_finds_exactly_that_user(world, table):
    stranger_id = table.seed_user("joonas.ahonen@club.fi", "Joonas Åhonen")
    for q in ("joonas.ahonen@club.fi", "Joonas.Ahonen@CLUB.fi", "  joonas.ahonen@club.fi "):
        assert payload(search(q))["items"] == [{
            "userId": stranger_id, "name": "Joonas Åhonen",
            "email": "joonas.ahonen@club.fi", "emailHint": "j\u2022\u2022\u2022@club.fi"}], q
    # Exact only: no prefix, no substring, no look-alike folding.
    for q in ("joonas.ahonen@club.f", "oonas.ahonen@club.fi", "joonas.ahonen@club.fi.x",
              "joonas.ahonen@club\u212a.fi", "j@club.fi", "a@b@club.fi"):
        assert payload(search(q))["items"] == [], q
    # A two-character address is still a full address.
    table.seed_user("a@b", "Tiny")
    assert [i["email"] for i in payload(search("a@b"))["items"]] == ["a@b"]
    # Your own address finds nobody.
    assert payload(search(USER_EMAIL))["items"] == []


def test_search_needs_three_characters_and_returns_at_most_eight(world, table):
    for i in range(12):
        table.seed_user(f"coach{i:02}@example.com", f"Coach {i:02}")
    response = search("co")
    assert (response.status_code, payload(response)["error"]) == (400, "query_too_short")
    assert payload(search("   c  "))["error"] == "query_too_short"
    assert len(payload(search("coach"))["items"]) == 8


def test_search_ignores_the_rate_rows_in_the_users_table(world, table):
    search("reader")
    assert (fa.PK_SEARCH_RATE, USER_ID) in table.users.rows
    table.users.rows[(fa.PK_SEARCH_RATE, "9e9e9e9e-0000-4000-8000-000000000000")] = {
        "PartitionKey": fa.PK_SEARCH_RATE, "RowKey": "9e9e9e9e-0000-4000-8000-000000000000",
        "DisplayName": "reader impostor", "Email": "impostor@example.com"}
    table.users.etags[(fa.PK_SEARCH_RATE, "9e9e9e9e-0000-4000-8000-000000000000")] = "x"
    ids = [i["userId"] for i in payload(search("reader"))["items"]]
    assert ids == [world["ids"][READER]]


def test_search_is_rate_limited_per_user(world, table):
    for _ in range(fa.USER_SEARCH_RATE_LIMIT):
        assert search("reader").status_code == 200
    limited = search("reader")
    assert (limited.status_code, payload(limited)["error"]) == (429, "rate_limited")
    # Someone else is not affected.
    assert search("reader", email=WRITER).status_code == 200
    # Shared across instances: the counter is a row, not process memory.
    row = table.users.rows[(fa.PK_SEARCH_RATE, USER_ID)]
    assert row["MinuteCount"] == fa.USER_SEARCH_RATE_LIMIT


def test_the_rate_limit_windows_reset_per_minute_and_per_day(world, monkeypatch):
    clock = [1_000_000.0]
    monkeypatch.setattr(fa, "_search_now", lambda: clock[0])
    for _ in range(fa.USER_SEARCH_RATE_LIMIT):
        search("reader")
    assert search("reader").status_code == 429
    clock[0] += fa.USER_SEARCH_RATE_WINDOW_SECONDS
    assert search("reader").status_code == 200

    # The daily cap holds even when every minute stays under its limit.
    done = fa.USER_SEARCH_RATE_LIMIT + 1
    while done < fa.USER_SEARCH_DAILY_LIMIT:
        clock[0] += fa.USER_SEARCH_RATE_WINDOW_SECONDS
        for _ in range(min(fa.USER_SEARCH_RATE_LIMIT, fa.USER_SEARCH_DAILY_LIMIT - done)):
            assert search("reader").status_code == 200
            done += 1
    clock[0] += fa.USER_SEARCH_RATE_WINDOW_SECONDS
    limited = search("reader")
    assert (limited.status_code, payload(limited)["error"]) == (429, "rate_limited")
    clock[0] = 1_000_000.0 + fa.USER_SEARCH_DAY_WINDOW_SECONDS
    assert search("reader").status_code == 200


def test_concurrent_searches_are_both_counted(world, table):
    first = [True]
    original = table.users.update_entity

    def racing_update(entity, **kwargs):
        if first[0] and entity.get("PartitionKey") == fa.PK_SEARCH_RATE:
            first[0] = False
            # Another instance counts a search of the same user in between.
            key = (fa.PK_SEARCH_RATE, entity["RowKey"])
            table.users.rows[key] = {**table.users.rows[key],
                                     "MinuteCount": table.users.rows[key]["MinuteCount"] + 1,
                                     "DayCount": table.users.rows[key]["DayCount"] + 1}
            table.users.etags[key] = "other-instance"
        return original(entity, **kwargs)

    search("reader")
    table.users.update_entity = racing_update
    assert search("reader").status_code == 200
    row = table.users.rows[(fa.PK_SEARCH_RATE, USER_ID)]
    assert (row["MinuteCount"], row["DayCount"]) == (3, 3)


def test_an_unreadable_rate_counter_fails_closed(world, table):
    table.users.get_entity = lambda **kw: (_ for _ in ()).throw(RuntimeError("boom"))
    response = search("reader")
    assert (response.status_code, payload(response)["error"]) == (500, "internal_error")


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

def gid(name):
    """A stable lowercase GUID per test label (competition ids are GUIDs)."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"competition:{name}"))


MINE, MINE_DELETED, OWNED, THEIRS, PURGED, LATER, ORPHAN, NEW = (
    gid(n) for n in ("mine", "mine-deleted", "owned", "theirs", "purged", "later", "orphan",
                     "new"))


def seed_legacy(table, competition_id, created_by, **columns):
    table.create_entity({
        "PartitionKey": fa.PK_COMPETITION, "RowKey": competition_id, "Code": competition_id,
        "Name": competition_id, "CreatedBy": created_by, "CreatedUtc": "2026-01-02T10:00:00Z",
        "Status": fa.STATUS_ACTIVE, **columns,
    })


def test_a_new_user_claims_their_unowned_legacy_competitions_once(table):
    seed_legacy(table, MINE, "Legacy@Example.com")
    seed_legacy(table, MINE_DELETED, "legacy@example.com", Status=fa.STATUS_DELETED)
    seed_legacy(table, OWNED, "legacy@example.com")
    table.grant(OWNED, USER_ID, "owner")
    seed_legacy(table, THEIRS, "someone@example.com")
    seed_legacy(table, PURGED, "legacy@example.com", PurgedUtc="2026-02-01T03:00:00Z")

    me = payload(fa._current_user(make_request("GET", user_email="legacy@example.com")))

    assert table.access_rows(MINE) == {me["userId"]: "owner"}
    assert table.access_rows(MINE_DELETED) == {me["userId"]: "owner"}
    assert table.access_rows(OWNED) == {USER_ID: "owner"}
    assert table.access_rows(THEIRS) == {}
    assert table.access_rows(PURGED) == {}
    claims = [row for row in table.audit_rows() if row["Action"] == "access.claim"]
    assert {row["CompetitionId"] for row in claims} == {MINE, MINE_DELETED}
    # Marked, and the ownership sentinel names the claimant.
    assert table.rows[(fa.PK_COMPETITION, MINE)]["LegacyClaimedUtc"]
    assert "LegacyClaimedUtc" not in table.rows[(fa.PK_COMPETITION, OWNED)]
    assert table.access.rows[(MINE, fa.OWNER_LOCK_ROW_KEY)]["OwnerUserId"] == me["userId"]

    # Only at user creation: a later legacy row is not claimed by an existing user.
    seed_legacy(table, LATER, "legacy@example.com")
    fa._current_user(make_request("GET", user_email="legacy@example.com"))
    assert table.access_rows(LATER) == {}
    assert [c["id"] for c in listing(user_email="legacy@example.com")] == [MINE]


def test_no_email_claims_nothing(table):
    seed_legacy(table, gid("blank"), "")
    fa._current_user(make_request("GET", user_email=None))
    assert table.access_rows(gid("blank")) == {}


def test_only_competitions_created_before_the_cutoff_are_claimable(table):
    cutoff = fa._parse_utc(fa.LEGACY_CLAIM_CUTOFF)
    seed_legacy(table, gid("before"), "legacy@example.com",
                CreatedUtc=fa._utc_text(cutoff - timedelta(seconds=1)))
    seed_legacy(table, gid("at"), "legacy@example.com", CreatedUtc=fa.LEGACY_CLAIM_CUTOFF)
    seed_legacy(table, gid("after"), "legacy@example.com",
                CreatedUtc=fa._utc_text(cutoff + timedelta(days=3)))
    seed_legacy(table, gid("undated"), "legacy@example.com", CreatedUtc="")
    me = payload(fa._current_user(make_request("GET", user_email="legacy@example.com")))
    assert table.access_rows(gid("before")) == {me["userId"]: "owner"}
    for label in ("at", "after", "undated"):
        assert table.access_rows(gid(label)) == {}, label


def test_the_cutoff_is_no_later_than_the_rollout():
    # Must be <= the prod rollout of the access model (see LEGACY_CLAIM_CUTOFF).
    assert fa.LEGACY_CLAIM_CUTOFF == "2026-10-19T09:30:00Z"


def test_a_claimed_row_is_never_claimed_again_even_after_its_owner_is_gone(table):
    seed_legacy(table, MINE, "legacy@example.com")
    first = payload(fa._current_user(make_request("GET", user_email="legacy@example.com")))
    assert table.access_rows(MINE) == {first["userId"]: "owner"}
    # The owner disappears entirely (as the inactive-user sweep would do it)…
    table.access.delete_entity(MINE, first["userId"])
    for key in [k for k in table.identities.rows if table.identities.rows[k]["UserId"]
                == first["userId"]]:
        del table.identities.rows[key]
    table.users.delete_entity(fa.PK_USER, first["userId"])
    # …and the same e-mail signs in again under a new identity: no claim.
    second = payload(fa._current_user(make_request(
        "GET", user_email="legacy@example.com", oid="7a7a7a7a-0000-4000-8000-000000000001")))
    assert second["userId"] != first["userId"]
    assert table.access_rows(MINE) == {}
    # Even with the mark gone, the ownership sentinel still refuses a claim.
    del table.rows[(fa.PK_COMPETITION, MINE)]["LegacyClaimedUtc"]
    assert fa._claim_legacy_competitions(second["userId"], "legacy@example.com") == 0
    assert table.access_rows(MINE) == {}


def test_a_lookalike_email_claims_nothing(table):
    seed_legacy(table, MINE, "kim@example.com")
    fa._current_user(make_request("GET", user_email="\u212aim@example.com"))
    assert table.access_rows(MINE) == {}


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
    # Sentinel + new owner + the old owner's demotion, all in one transaction.
    assert writes[0] == ("submit_transaction", 3)
    assert table.access.rows[(world["id"], fa.OWNER_LOCK_ROW_KEY)]["OwnerUserId"] == reader
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
    seed_legacy(table, ORPHAN, "gone@example.com")
    assert set_owner(ORPHAN, world["ids"][STRANGER]).status_code == 200
    assert table.access_rows(ORPHAN) == {world["ids"][STRANGER]: "owner"}
    [audit] = table.audit_rows()
    assert audit["Changes"] == f'{{"owner": [null, "{STRANGER}"]}}'


def owners(table, competition_id):
    return sorted(uid for uid, role in table.access_rows(competition_id).items() if role == "owner")


def test_a_legacy_claim_racing_an_owner_swap_leaves_one_owner(world, table):
    """The claim lands between the swap's read and its transaction: the swap
    loses the sentinel insert, re-reads and demotes the claimant."""
    seed_legacy(table, ORPHAN, "legacy@example.com")
    claimant = table.seed_user("legacy@example.com", "Legacy")
    original = table.access.submit_transaction
    raced = []

    def claim_first(operations):
        if not raced:
            raced.append(True)
            assert fa._claim_legacy_competitions(claimant, "legacy@example.com") == 1
        return original(operations)

    table.access.submit_transaction = claim_first
    response = set_owner(ORPHAN, world["ids"][STRANGER])
    assert response.status_code == 200
    assert owners(table, ORPHAN) == [world["ids"][STRANGER]]
    assert table.access_rows(ORPHAN)[claimant] == "write"
    lock = table.access.rows[(ORPHAN, fa.OWNER_LOCK_ROW_KEY)]
    assert lock["OwnerUserId"] == world["ids"][STRANGER]


def test_an_owner_swap_racing_a_legacy_claim_wins_and_the_claim_backs_off(world, table):
    """The swap lands between the claim's owner check and its transaction:
    the claim's sentinel insert fails and it claims nothing."""
    seed_legacy(table, ORPHAN, "legacy@example.com")
    claimant = table.seed_user("legacy@example.com", "Legacy")
    original = table.access.submit_transaction
    raced = []

    def swap_first(operations):
        if not raced:
            raced.append(True)
            assert set_owner(ORPHAN, world["ids"][STRANGER]).status_code == 200
        return original(operations)

    table.access.submit_transaction = swap_first
    assert fa._claim_legacy_competitions(claimant, "legacy@example.com") == 0
    assert owners(table, ORPHAN) == [world["ids"][STRANGER]]
    assert claimant not in table.access_rows(ORPHAN)
    assert not [r for r in table.audit_rows() if r["Action"] == "access.claim"]


def test_two_concurrent_owner_swaps_leave_one_owner(world, table):
    original = table.access.submit_transaction
    raced = []

    def other_swap_first(operations):
        if not raced:
            raced.append(True)
            assert set_owner(world["id"], world["ids"][WRITER]).status_code == 200
        return original(operations)

    table.access.submit_transaction = other_swap_first
    assert set_owner(world["id"], world["ids"][READER]).status_code == 200
    assert owners(table, world["id"]) == [world["ids"][READER]]
    rows = table.access_rows(world["id"])
    assert rows[USER_ID] == "write" and rows[world["ids"][WRITER]] == "write"


def test_a_swap_demotes_every_existing_owner_row(world, table):
    # A state no current code path produces, e.g. rows from before the sentinel.
    table.grant(world["id"], world["ids"][GRANTEE], "owner")
    assert len(owners(table, world["id"])) == 2
    assert set_owner(world["id"], world["ids"][READER]).status_code == 200
    rows = table.access_rows(world["id"])
    assert owners(table, world["id"]) == [world["ids"][READER]]
    assert rows[USER_ID] == "write" and rows[world["ids"][GRANTEE]] == "write"


def test_create_writes_the_owner_and_the_sentinel_together(table):
    table.access.calls.clear()
    competition = create()
    # (The fake records the transaction's own inserts after it.)
    assert [c for c in table.access.calls if c[0] in ("submit_transaction", "upsert_entity",
                                                      "update_entity")] \
        == [("submit_transaction", 2)]
    assert table.access.rows[(competition["id"], fa.OWNER_LOCK_ROW_KEY)]["OwnerUserId"] == USER_ID
    # Nobody can claim it later: the sentinel exists from the start.
    table.rows[(fa.PK_COMPETITION, competition["id"])]["CreatedUtc"] = "2026-01-02T10:00:00Z"
    table.access.delete_entity(competition["id"], USER_ID)
    other = table.seed_user("second-identity@example.com", "Same Person")
    assert fa._claim_legacy_competitions(other, USER_EMAIL) == 0
    assert table.access_rows(competition["id"]) == {}


def test_owner_swap_validation(world, table):
    assert payload(set_owner(world["id"], "nope"))["error"] == "invalid_user"
    unknown = set_owner(world["id"], "5e5e5e5e-0000-4000-8000-000000000000")
    assert (unknown.status_code, payload(unknown)["error"]) == (404, "user_not_found")
    assert set_owner("no-such", world["ids"][READER]).status_code == 404
    assert set_owner(world["id"] + "\n", world["ids"][READER]).status_code == 404
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


# ── inactive users: re-read right before deleting ─────────────────────────────

def test_a_user_seen_during_the_sweep_is_kept(table, blobs):
    idle = table.seed_user("idle@example.com", last_seen=LONG_AGO)
    live = create("Live Cup")
    table.grant(live["id"], idle, "read")
    original = table.users.get_entity

    def signed_in_meanwhile(partition_key, row_key):
        # The scan saw the old LastSeenUtc; the user signs in before the re-read.
        if (partition_key, row_key) == (fa.PK_USER, idle):
            table.users.rows[(fa.PK_USER, idle)]["LastSeenUtc"] = fa._utc_text(NOW)
        return original(partition_key=partition_key, row_key=row_key)

    table.users.get_entity = signed_in_meanwhile
    summary = fa._run_retention_sweep(NOW, True)
    assert summary["users_deleted"] == 0
    assert (fa.PK_USER, idle) in table.users.rows
    assert table.access_rows(live["id"])[idle] == "read"


def test_the_users_row_delete_is_etag_conditional(table, blobs):
    idle = table.seed_user("idle@example.com", last_seen=LONG_AGO)
    original = table.users.delete_entity

    def touched_meanwhile(partition_key, row_key, **kwargs):
        if (partition_key, row_key) == (fa.PK_USER, idle):
            assert kwargs.get("etag"), "the users row delete must be conditional"
            table.users.etags[(fa.PK_USER, idle)] = "touched-by-a-sign-in"
        return original(partition_key, row_key, **kwargs)

    table.users.delete_entity = touched_meanwhile
    summary = fa._run_retention_sweep(NOW, True)
    assert summary["users_deleted"] == 0
    assert (fa.PK_USER, idle) in table.users.rows


def test_the_sweep_removes_the_users_search_rate_row(table, blobs):
    idle = table.seed_user("idle@example.com", last_seen=LONG_AGO)
    table.users.upsert_entity({"PartitionKey": fa.PK_SEARCH_RATE, "RowKey": idle,
                               "MinuteStart": 1.0, "MinuteCount": 1, "DayStart": 1.0,
                               "DayCount": 1})
    assert fa._run_retention_sweep(NOW, True)["users_deleted"] == 1
    assert (fa.PK_SEARCH_RATE, idle) not in table.users.rows
    assert (fa.PK_USER, idle) not in table.users.rows


# ── competition ids: one spelling ─────────────────────────────────────────────

@pytest.mark.parametrize("route", list(ROUTES))
def test_only_the_lowercase_guid_reaches_storage(world, table, route):
    for bad in (world["id"] + "\n", world["id"] + " ", " " + world["id"], world["id"] + "x",
                world["id"].replace("-", ""), "{" + world["id"] + "}",
                world["id"][:-1] + "K", ""):
        response = call_route({**world, "id": bad}, route, USER_EMAIL)
        assert (response.status_code, payload(response)["error"]) == (404, "not_found"), \
            (route, bad)


def test_an_uppercase_guid_is_the_same_competition(world, table):
    response = fa._get_competition(make_request("GET", route_params={"id": world["id"].upper()}))
    assert response.status_code == 200
    assert payload(response)["id"] == world["id"]


def test_admin_routes_take_only_the_normalised_id(world, table):
    for bad in (world["id"] + "\n", "../" + world["id"], "x"):
        response = fa._admin_get_competition(make_request(
            "GET", route_params={"id": bad}, user_email=ADMIN_EMAIL))
        assert (response.status_code, payload(response)["error"]) == (404, "not_found"), bad


# ── e-mail: printable ASCII before lowercasing ────────────────────────────────

def test_a_kelvin_sign_email_is_no_email_and_never_an_admin(table, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAILS", "kim@example.com, Kate@example.com")
    assert fa._admin_emails() == frozenset({"kim@example.com"})
    lookalike = make_request("GET", user_email="KIM@example.com")
    assert fa._forwarded_identity(lookalike)[2] == ""
    me = payload(fa._current_user(lookalike))
    assert (me["email"], me["isAdmin"]) == ("", False)
    assert payload(fa._admin_list_competitions(lookalike))["error"] == "admin_required"
    real = make_request("GET", user_email="KIM@Example.com")
    assert fa._forwarded_identity(real)[2] == "kim@example.com"
    assert payload(fa._current_user(real))["isAdmin"] is True
    # Over-long is no e-mail either (never truncated into someone else's).
    long_email = "a" * 250 + "@x.fi"
    assert fa._forwarded_identity(make_request("GET", user_email=long_email))[2] == ""


# ── admin override audit ──────────────────────────────────────────────────────

def override_rows(table):
    return [row for row in table.audit_rows() if row["Action"].startswith("admin.override.")]


EXPECTED_OVERRIDE = {
    "patch": "admin.override.competition.update",
    "put": "admin.override.competition.update",
    "extend": "admin.override.competition.extend",
    "upload": "admin.override.file.upload",
    "delete file": "admin.override.file.delete",
    "hovtp accept": "admin.override.hovtp.accept",
    "hovtp reject": "admin.override.hovtp.reject",
    "hovtp revoke": "admin.override.hovtp.revoke",
    "delete": "admin.override.competition.delete",
    "access set": "admin.override.access.grant",
    "access revoke": "admin.override.access.revoke",
}


@pytest.mark.parametrize("route", list(ROUTES))
def test_an_admin_write_without_an_own_grant_is_audited(world, table, route):
    response = call_route(world, route, ADMIN_EMAIL)
    assert response.status_code in (200, 201)
    rows = override_rows(table)
    if route not in EXPECTED_OVERRIDE:
        assert rows == [], route   # reads are not audited
        return
    [row] = rows
    assert row["Action"] == EXPECTED_OVERRIDE[route]
    assert (row["Actor"], row["CompetitionId"]) == (ADMIN_EMAIL, world["id"])


@pytest.mark.parametrize("route", sorted(EXPECTED_OVERRIDE))
def test_an_admin_with_an_own_good_enough_grant_is_not_an_override(world, table, route):
    table.grant(world["id"], world["ids"][ADMIN_EMAIL],
                "owner" if ROUTES[route][3] == "owner" else "write")
    if ROUTES[route][3] == "owner":
        table.access.delete_entity(world["id"], USER_ID)
    response = call_route(world, route, ADMIN_EMAIL)
    assert response.status_code in (200, 201)
    assert override_rows(table) == []


def test_an_admin_with_only_read_access_writing_is_an_override(world, table):
    table.grant(world["id"], world["ids"][ADMIN_EMAIL], "read")
    assert call_route(world, "extend", ADMIN_EMAIL).status_code == 200
    [row] = override_rows(table)
    assert row["Action"] == "admin.override.competition.extend"


def test_a_refused_admin_write_is_not_audited(world, table):
    response = fa._update_competition(make_request(
        "PATCH", route_params={"id": world["id"]}, body={"name": ""}, user_email=ADMIN_EMAIL))
    assert response.status_code == 400
    assert override_rows(table) == []


def test_admin_leaving_is_not_an_override(world, table):
    table.grant(world["id"], world["ids"][ADMIN_EMAIL], "read")
    response = fa._remove_access(make_request(
        "DELETE", route_params={"id": world["id"], "userId": "me"}, user_email=ADMIN_EMAIL))
    assert response.status_code == 200
    assert override_rows(table) == []


# ── admin user search (the Change owner picker) ───────────────────────────────

def test_the_admin_user_search_matches_name_or_email_with_full_emails(world, table):
    def admin_search(q):
        return fa._admin_list_users(make_request("GET", params={"q": q}, user_email=ADMIN_EMAIL))

    users = payload(admin_search("example.com"))["users"]
    assert len(users) <= fa.USER_SEARCH_MAX_RESULTS
    assert all(u["email"].endswith("@example.com") for u in users)
    found = payload(admin_search("READ"))["users"]
    assert [u["email"] for u in found] == [READER]
    # The admin themselves is listed (Make me the owner has its own button too).
    assert [u["email"] for u in payload(admin_search("admin@"))["users"]] == [ADMIN_EMAIL]
    short = admin_search("ab")
    assert (short.status_code, payload(short)["error"]) == (400, "query_too_short")
    assert payload(fa._admin_list_users(make_request(
        "GET", params={"q": "reader"})))["error"] == "admin_required"
