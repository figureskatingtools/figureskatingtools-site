"""POST /api/competitions — code uniqueness is the whole point of this endpoint.

The registry's contract with every tool is "one competition code, one GUID,
forever". That is enforced by writing the CODE row BEFORE the COMPETITION row,
so a losing racer fails on an atomic insert instead of on a read-then-write
check. These tests pin down that ordering, the 409 it produces, and the
compensation that stops a failed second write from stranding the reservation.
"""
import function_app as fa
from conftest import make_request, payload


def create(body, **kwargs):
    return fa._create_competition(make_request("POST", body=body, **kwargs))


def test_create_returns_the_competition_with_a_guid_and_slugged_code(table):
    response = create({"name": "Winter Cup 2026", "date": "2026-01-17",
                       "venue": "Helsinki Ice Hall"})

    assert response.status_code == 201
    competition = payload(response)
    assert competition["code"] == "winter-cup-2026"
    assert competition["name"] == "Winter Cup 2026"
    assert competition["date"] == "2026-01-17"
    assert competition["venue"] == "Helsinki Ice Hall"
    assert competition["status"] == "active"
    assert competition["createdBy"] == "skater@example.com"
    assert len(competition["id"]) == 36 and competition["id"].count("-") == 4

    # Both row kinds landed, and the CODE row points at the new GUID.
    assert len(table.competition_rows()) == 1
    assert table.code_rows()["winter-cup-2026"]["CompetitionId"] == competition["id"]


def test_the_code_row_is_written_before_the_competition_row(table):
    create({"name": "Spring Trophy"})

    creates = [call[1] for call in table.calls if call[0] == "create_entity"]
    assert creates[0][0] == fa.PK_CODE
    assert creates[1][0] == fa.PK_COMPETITION


def test_an_explicit_code_overrides_the_name_slug(table):
    competition = payload(create({"name": "Winter Cup 2026", "code": "WC 2026"}))
    assert competition["code"] == "wc-2026"


def test_a_duplicate_code_is_a_409_and_writes_nothing(table):
    create({"name": "Winter Cup 2026"})

    response = create({"name": "Winter Cup 2026", "venue": "Somewhere else"})

    assert response.status_code == 409
    body = payload(response)
    assert body["error"] == "code_in_use"
    assert body["code"] == "winter-cup-2026"
    # The first competition is untouched and no orphan row appeared.
    assert len(table.competition_rows()) == 1
    assert table.competition_rows()[0]["Venue"] == ""


def test_a_differently_spelled_duplicate_still_collides(table):
    create({"name": "Winter Cup 2026"})
    assert create({"name": "  WINTER  cup 2026 !!"}).status_code == 409


def test_a_failed_competition_write_releases_the_code_reservation(table):
    # First insert (the CODE row) succeeds, the second one blows up.
    original_create = table.create_entity
    state = {"seen": 0}

    def flaky(entity):
        state["seen"] += 1
        if state["seen"] == 2:
            raise RuntimeError("table storage exploded")
        return original_create(entity)

    table.create_entity = flaky

    response = create({"name": "Winter Cup 2026"})

    assert response.status_code == 500
    assert payload(response)["error"] == "internal_error"
    # Compensated: the code is free again, so a retry can succeed.
    assert table.code_rows() == {}
    assert table.competition_rows() == []

    table.create_entity = original_create
    assert create({"name": "Winter Cup 2026"}).status_code == 201


def test_a_name_only_of_punctuation_is_rejected_before_touching_storage(table):
    response = create({"name": "!!!"})
    assert response.status_code == 400
    assert payload(response)["error"] == "invalid_code"
    assert table.rows == {}


def test_a_missing_name_is_a_400(table):
    assert payload(create({"venue": "Helsinki"}))["error"] == "invalid_name"
    assert payload(create({"name": "   "}))["error"] == "invalid_name"


def test_a_malformed_date_is_a_400(table):
    assert payload(create({"name": "Cup", "date": "17.1.2026"}))["error"] == "invalid_date"
    assert payload(create({"name": "Cup", "date": "2026-02-31"}))["error"] == "invalid_date"
    assert table.rows == {}


def test_an_empty_date_is_allowed(table):
    competition = payload(create({"name": "Cup", "date": "", "endDate": ""}))
    assert (competition["date"], competition["endDate"]) == ("", "")


def test_a_non_object_body_is_a_400(table):
    response = fa._create_competition(make_request("POST", body=["nope"]))
    assert response.status_code == 400
    assert payload(response)["error"] == "invalid_body"
