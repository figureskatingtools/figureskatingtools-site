"""GET /api/competitions and GET /api/competitions/{id}.

The list is what the nav's competition selector renders, so soft-deleted rows
must not leak into it and the newest competition has to come first.
"""
import function_app as fa
from conftest import make_request, payload


def create(table, name, **fields):
    body = {"name": name}
    body.update(fields)
    return payload(fa._create_competition(make_request("POST", body=body)))


def listing(**kwargs):
    return payload(fa._list_competitions(make_request("GET", **kwargs)))


def test_an_empty_registry_lists_nothing(table):
    assert listing() == []


def test_list_returns_a_bare_array_of_competitions(table):
    create(table, "Winter Cup 2026", date="2026-01-17")

    competitions = listing()
    assert isinstance(competitions, list) and len(competitions) == 1
    assert set(competitions[0]) == {
        "id", "code", "name", "date", "endDate", "venue",
        "createdBy", "createdUtc", "updatedUtc", "status",
    }


def test_list_is_newest_first_by_date(table):
    create(table, "Old Cup", date="2025-03-01")
    create(table, "Next Cup", date="2026-11-20")
    create(table, "Mid Cup", date="2026-01-17")

    assert [c["name"] for c in listing()] == ["Next Cup", "Mid Cup", "Old Cup"]


def test_list_hides_soft_deleted_competitions(table):
    kept = create(table, "Winter Cup 2026")
    gone = create(table, "Cancelled Cup")
    fa._delete_competition(make_request("DELETE", route_params={"id": gone["id"]}))

    assert [c["id"] for c in listing()] == [kept["id"]]


def test_list_can_include_deleted_competitions_on_request(table):
    gone = create(table, "Cancelled Cup")
    fa._delete_competition(make_request("DELETE", route_params={"id": gone["id"]}))

    included = listing(params={"includeDeleted": "true"})
    assert [c["status"] for c in included] == ["deleted"]


def test_get_by_id_returns_the_competition(table):
    created = create(table, "Winter Cup 2026", venue="Helsinki Ice Hall")

    response = fa._get_competition(make_request("GET", route_params={"id": created["id"]}))
    assert response.status_code == 200
    assert payload(response) == created


def test_get_by_unknown_id_is_a_404(table):
    response = fa._get_competition(make_request("GET", route_params={"id": "no-such-id"}))
    assert response.status_code == 404
    assert payload(response)["error"] == "not_found"


def test_get_still_resolves_a_soft_deleted_competition(table):
    # Tools that stored the GUID must keep being able to resolve it.
    created = create(table, "Cancelled Cup")
    fa._delete_competition(make_request("DELETE", route_params={"id": created["id"]}))

    fetched = payload(fa._get_competition(make_request("GET", route_params={"id": created["id"]})))
    assert fetched["status"] == "deleted"
