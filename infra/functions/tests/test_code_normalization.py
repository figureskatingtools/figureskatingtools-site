"""`normalize_code` — the function that decides when two codes are "the same".

It has to produce a legal Table Storage RowKey (no /, \\, #, ? or control
characters) from arbitrary operator input, and it is the future FSM ingest's
lookup key, so its output must be stable and predictable.
"""
import pytest

import function_app as fa


@pytest.mark.parametrize("raw, expected", [
    ("Winter Cup 2026", "winter-cup-2026"),
    ("  Winter  Cup  2026  ", "winter-cup-2026"),
    ("WINTER CUP 2026", "winter-cup-2026"),
    ("winter-cup-2026", "winter-cup-2026"),
    ("Winter/Cup#2026?", "winter-cup-2026"),
    ("--winter--cup--", "winter-cup"),
    ("SM-kilpailut 2026", "sm-kilpailut-2026"),
    # Diacritics fold to their base letter, exactly like the TypeScript client.
    ("Jyväskylä Cup", "jyvaskyla-cup"),
    ("Tampereen Jäähalli", "tampereen-jaahalli"),
    ("2026", "2026"),
])
def test_codes_normalize_to_a_stable_slug(raw, expected):
    assert fa.normalize_code(raw) == expected


@pytest.mark.parametrize("raw", ["", "   ", "---", "!!!", "///", None])
def test_input_with_nothing_usable_normalizes_to_empty(raw):
    assert fa.normalize_code(raw) == ""


def test_a_long_code_is_truncated_without_a_trailing_dash():
    code = fa.normalize_code("a" * 60 + " " + "b" * 20)
    assert len(code) <= fa.MAX_CODE_LENGTH
    assert not code.endswith("-")


def test_normalized_codes_are_legal_table_row_keys():
    illegal = set("/\\#?")
    for raw in ["Winter/Cup", "a#b", "x?y", "back\\slash"]:
        assert not (illegal & set(fa.normalize_code(raw)))


def test_the_blob_prefixes_are_keyed_by_guid():
    guid = "3f2b9c1e-0000-4000-8000-000000000001"
    assert fa.competition_upload_prefix(guid) == f"{guid}/uploads/"
    assert fa.competition_fsm_prefix(guid) == f"{guid}/fsm/"
