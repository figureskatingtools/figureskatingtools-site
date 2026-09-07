"""`normalize_code` must be identical in both Function Apps.

This app resolves a competition CODE row that the platform API wrote. If the two
normalizations ever drift, FSM's messages start 451-ing against a competition
that plainly exists in the UI — the kind of bug that only shows up mid-event.
The platform's TS/Python parity is tested over there; this pins the Python copy
byte-for-byte, so a change on either side has to be made on both.
"""
import importlib.util
import inspect
import os

import function_app as fa

PLATFORM_PATH = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", "functions", "function_app.py"))

VECTORS = [
    "YL110926HTL",
    "Jyväskylä Cup",
    "ÅÄÖ/2026#x?",
    "Winter Cup 2026",
    "winter-cup-2026",
    "  spaced  out  ",
    "---",
    "",
    "ÉLAN 2026",
    "a" * 120,
    "Ärlig/Öppen — Tävling",
]


def _platform_module():
    spec = importlib.util.spec_from_file_location("platform_function_app", PLATFORM_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_platform_module_is_where_we_think_it_is():
    assert os.path.isfile(PLATFORM_PATH), PLATFORM_PATH


def test_normalize_code_is_byte_identical():
    platform = _platform_module()

    assert inspect.getsource(fa.normalize_code) == inspect.getsource(platform.normalize_code)
    assert fa.MAX_CODE_LENGTH == platform.MAX_CODE_LENGTH


def test_normalize_code_agrees_on_every_vector():
    platform = _platform_module()

    for value in VECTORS:
        assert fa.normalize_code(value) == platform.normalize_code(value), value


def test_the_capture_code_normalizes_as_documented():
    assert fa.normalize_code("YL110926HTL") == "yl110926htl"
    assert fa.normalize_code("Jyväskylä Cup") == "jyvaskyla-cup"
    assert fa.normalize_code("ÅÄÖ/2026#x?") == "aao-2026-x"


def test_the_shared_storage_contract_matches_the_platform():
    platform = _platform_module()

    assert fa.COMPETITIONS_TABLE == platform.COMPETITIONS_TABLE
    assert fa.PK_COMPETITION == platform.PK_COMPETITION
    assert fa.PK_CODE == platform.PK_CODE
    assert fa.STATUS_DELETED == platform.STATUS_DELETED
    assert fa.DATA_CONTAINER == platform.DATA_CONTAINER
    assert fa.competition_fsm_prefix("abc") == platform.competition_fsm_prefix("abc")


def test_the_copied_helpers_are_byte_identical():
    platform = _platform_module()

    for name in ("sanitize_pool_filename", "_ascii_metadata", "_iso_utc", "_now_utc",
                 "get_table_client", "get_blob_service_client", "_get_container_client",
                 "_pool_content_type"):
        assert inspect.getsource(getattr(fa, name)) == \
               inspect.getsource(getattr(platform, name)), name
