"""PUT/PATCH and DELETE /api/competitions/{id}.

A code rename has to move the uniqueness reservation without ever leaving the
registry in a state where two competitions answer to one code, or where a code
is reserved by nobody. Delete is soft — the row stays resolvable — but it must
release the code so it can be reused.
"""
import function_app as fa
from conftest import make_request, payload


def create(name, **fields):
    body = {"name": name}
    body.update(fields)
    return payload(fa._create_competition(make_request("POST", body=body)))


def update(competition_id, body, method="PATCH"):
    return fa._update_competition(
        make_request(method, body=body, route_params={"id": competition_id}))


def delete(competition_id):
    return fa._delete_competition(
        make_request("DELETE", route_params={"id": competition_id}))


# ── plain field updates ───────────────────────────────────────────────────────

def test_update_changes_only_the_fields_present_in_the_body(table):
    created = create("Winter Cup 2026", date="2026-01-17", venue="Helsinki Ice Hall")

    updated = payload(update(created["id"], {"venue": "Tampere Ice Hall"}))

    assert updated["venue"] == "Tampere Ice Hall"
    assert (updated["name"], updated["date"], updated["code"]) == \
        ("Winter Cup 2026", "2026-01-17", "winter-cup-2026")
    assert updated["updatedUtc"] >= created["updatedUtc"]


def test_update_accepts_put_as_well_as_patch(table):
    created = create("Winter Cup 2026")
    assert update(created["id"], {"name": "Winter Cup"}, method="PUT").status_code == 200


def test_update_rejects_a_blank_name_and_a_bad_date(table):
    created = create("Winter Cup 2026")

    assert payload(update(created["id"], {"name": "  "}))["error"] == "invalid_name"
    assert payload(update(created["id"], {"date": "tomorrow"}))["error"] == "invalid_date"
    # Nothing was written.
    assert table.competition_rows()[0]["Name"] == "Winter Cup 2026"


def test_update_of_an_unknown_id_is_a_404(table):
    response = update("no-such-id", {"venue": "Helsinki"})
    assert response.status_code == 404


def test_a_soft_deleted_competition_cannot_be_updated(table):
    created = create("Cancelled Cup")
    delete(created["id"])
    assert update(created["id"], {"venue": "Helsinki"}).status_code == 404


# ── code rename ───────────────────────────────────────────────────────────────

def test_renaming_the_code_moves_the_reservation(table):
    created = create("Winter Cup 2026")

    updated = payload(update(created["id"], {"code": "winter-cup-26"}))

    assert updated["code"] == "winter-cup-26"
    assert set(table.code_rows()) == {"winter-cup-26"}
    assert table.code_rows()["winter-cup-26"]["CompetitionId"] == created["id"]


def test_the_freed_code_can_be_claimed_again(table):
    created = create("Winter Cup 2026")
    update(created["id"], {"code": "winter-cup-26"})

    reused = create("Winter Cup 2026")
    assert reused["code"] == "winter-cup-2026"
    assert set(table.code_rows()) == {"winter-cup-26", "winter-cup-2026"}


def test_renaming_onto_a_taken_code_is_a_409_and_changes_nothing(table):
    first = create("Winter Cup 2026")
    second = create("Spring Trophy")

    response = update(second["id"], {"code": "winter-cup-2026", "venue": "Helsinki"})

    assert response.status_code == 409
    assert payload(response)["code"] == "winter-cup-2026"
    # Neither the code nor the other field moved.
    assert table.code_rows()["winter-cup-2026"]["CompetitionId"] == first["id"]
    reread = payload(fa._get_competition(make_request("GET", route_params={"id": second["id"]})))
    assert (reread["code"], reread["venue"]) == ("spring-trophy", "")


def test_renaming_to_the_same_code_is_not_treated_as_a_rename(table):
    created = create("Winter Cup 2026")

    updated = payload(update(created["id"], {"code": "WINTER CUP 2026", "venue": "Helsinki"}))

    assert updated["code"] == "winter-cup-2026"
    assert updated["venue"] == "Helsinki"
    assert set(table.code_rows()) == {"winter-cup-2026"}


def test_a_failed_rename_write_releases_the_newly_claimed_code(table):
    created = create("Winter Cup 2026")
    table.fail_next_update = RuntimeError("table storage exploded")

    response = update(created["id"], {"code": "winter-cup-26"})

    assert response.status_code == 500
    # The new reservation was compensated; the old one still stands.
    assert set(table.code_rows()) == {"winter-cup-2026"}
    assert table.competition_rows()[0]["Code"] == "winter-cup-2026"


def test_an_empty_code_is_rejected(table):
    created = create("Winter Cup 2026")
    assert payload(update(created["id"], {"code": "---"}))["error"] == "invalid_code"


# ── soft delete ───────────────────────────────────────────────────────────────

def test_delete_is_soft_and_releases_the_code(table):
    created = create("Cancelled Cup")

    response = delete(created["id"])

    assert response.status_code == 200
    assert payload(response)["status"] == "deleted"
    # The row survives...
    row = table.competition_rows()[0]
    assert row["Status"] == "deleted"
    assert row["DeletedBy"] == "skater@example.com"
    # ...but the code is free.
    assert table.code_rows() == {}


def test_the_code_of_a_deleted_competition_can_be_reused(table):
    first = create("Winter Cup 2026")
    delete(first["id"])

    second = create("Winter Cup 2026")
    assert second["code"] == "winter-cup-2026"
    assert second["id"] != first["id"]
    assert len(table.competition_rows()) == 2


def test_deleting_twice_is_idempotent(table):
    created = create("Cancelled Cup")
    delete(created["id"])

    response = delete(created["id"])
    assert response.status_code == 200
    assert payload(response)["status"] == "deleted"


def test_delete_of_an_unknown_id_is_a_404(table):
    assert delete("no-such-id").status_code == 404


def test_a_failed_delete_leaves_the_competition_active(table):
    created = create("Cancelled Cup")
    table.fail_next_update = RuntimeError("table storage exploded")

    assert delete(created["id"]).status_code == 500
    assert table.competition_rows()[0]["Status"] == "active"
    assert set(table.code_rows()) == {"cancelled-cup"}
