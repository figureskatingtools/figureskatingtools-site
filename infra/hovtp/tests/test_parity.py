"""The code shared with the platform API must be identical in both Function Apps.

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
                 "_data_account_name", "get_table_client", "get_blob_service_client",
                 "_get_container_client", "_pool_content_type"):
        assert inspect.getsource(getattr(fa, name)) == \
               inspect.getsource(getattr(platform, name)), name


def test_the_birth_date_removal_is_byte_identical():
    """FSM pushes and user uploads must clean a participant file the same way:
    one copy that drifted would let birth dates in through the other door."""
    platform = _platform_module()

    for name in ("strip_birth_dates", "_remove_birth_date_markup", "_is_birth_date_name",
                 "_has_birth_date", "_birth_date_free_shape"):
        assert inspect.getsource(getattr(fa, name)) == \
               inspect.getsource(getattr(platform, name)), name
    assert fa.PARTICIPANT_DOCUMENT_TYPES == platform.PARTICIPANT_DOCUMENT_TYPES
    assert fa._XML_MARKUP_RE.pattern == platform._XML_MARKUP_RE.pattern
    assert fa._XML_MARKUP_RE.flags == platform._XML_MARKUP_RE.flags
    assert fa._XML_ATTRIBUTE_RE.pattern == platform._XML_ATTRIBUTE_RE.pattern


def test_the_whole_birth_date_section_is_byte_identical():
    """Belt and braces: the section as a whole, comments included."""
    marker = "# ── birth dates out of participant files ──"

    def section(path):
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        start = text.index(marker)
        end = text.index("\n# ── ", start + len(marker))
        return text[start:end]

    assert section(fa.__file__) == section(PLATFORM_PATH)


def test_the_data_account_is_resolved_independently_of_the_host_account(monkeypatch):
    """The listener has its OWN host storage account, so the account holding
    `competition-data` + the `competitions` table must be named explicitly.

    If this ever falls back to AzureWebJobsStorage__accountName while
    COMPETITION_DATA_ACCOUNT is set, the listener writes competition files and
    trust rows into its empty host account and FSM starts seeing
    `451 unknown competition code` for competitions that plainly exist.
    """
    monkeypatch.setenv("COMPETITION_DATA_ACCOUNT", "stfsplatdata")
    monkeypatch.setenv("AzureWebJobsStorage__accountName", "stfshovtphost")

    assert fa._data_account_name() == "stfsplatdata"


def test_the_data_account_falls_back_to_the_host_account(monkeypatch):
    """Single-account setups (the platform app, and local dev) keep working."""
    monkeypatch.delenv("COMPETITION_DATA_ACCOUNT", raising=False)
    monkeypatch.setenv("AzureWebJobsStorage__accountName", "stfsplatonly")

    assert fa._data_account_name() == "stfsplatonly"


def test_the_data_account_is_empty_when_neither_setting_is_present(monkeypatch):
    """No account name at all ⇒ the clients fall through to AzureWebJobsStorage
    (the Azurite connection string used locally), not to a bogus endpoint."""
    monkeypatch.delenv("COMPETITION_DATA_ACCOUNT", raising=False)
    monkeypatch.delenv("AzureWebJobsStorage__accountName", raising=False)

    assert fa._data_account_name() == ""
