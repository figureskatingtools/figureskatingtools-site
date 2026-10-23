"""Birth dates never reach the pool from an FSM participant file.

Nothing on the site uses a skater's date of birth, so `DT_PARTIC` and
`DT_PARTIC_TEAMS` lose their `BirthDate` attributes and elements before they
are stored — and only those: the tools parse these files, so every other byte
must survive. A file that cannot be cleaned is refused, never stored as is.
"""
import pytest

import fixtures
import function_app as fa
from conftest import COMPETITION_ID, DEFAULT_IP, head, make_request

PENDING = f"{COMPETITION_ID}/fsm-pending/{DEFAULT_IP}/"


def _post(body):
    return fa._handle_hovtp(make_request(body=body))


def _only(blobs):
    assert len(blobs.blobs) == 1, sorted(blobs.blobs)
    return next(iter(blobs.blobs.values()))


# ── the function itself ───────────────────────────────────────────────────────

def test_participant_birth_dates_go_and_nothing_else_changes():
    """Attribute (both quote styles, any case, spaced `=`) and element forms."""
    stripped = fa.strip_birth_dates(fixtures.DT_PARTIC_BIRTHDATES_BODY)

    assert stripped == fixtures.DT_PARTIC_BIRTHDATES_STRIPPED
    assert b"2012-03-04" not in stripped
    assert b"2011-12-31" not in stripped
    assert b"2013-01-15" not in stripped


def test_team_member_birth_dates_go_namespaced_or_not():
    stripped = fa.strip_birth_dates(fixtures.DT_PARTIC_TEAMS_BIRTHDATES_BODY)

    assert stripped == fixtures.DT_PARTIC_TEAMS_BIRTHDATES_STRIPPED


def test_a_file_without_birth_dates_comes_back_as_the_same_bytes():
    assert fa.strip_birth_dates(fixtures.DT_PARTIC_BODY) is fixtures.DT_PARTIC_BODY


def test_stripping_twice_changes_nothing_more():
    once = fa.strip_birth_dates(fixtures.DT_PARTIC_BIRTHDATES_BODY)

    assert fa.strip_birth_dates(once) is once


def test_a_value_containing_a_closing_bracket_or_the_word_survives():
    body = (b'<OdfBody DocumentType="DT_PARTIC"><Participant Code="1" '
            b'Note="a > b, BirthDate=\'x\'" BirthDate="2012-03-04" X=\'1\'/></OdfBody>')

    assert fa.strip_birth_dates(body) == (
        b'<OdfBody DocumentType="DT_PARTIC"><Participant Code="1" '
        b'Note="a > b, BirthDate=\'x\'" X=\'1\'/></OdfBody>')


def test_a_cdata_section_mentioning_a_birth_date_is_text_and_stays():
    body = (b'<OdfBody><Participant Code="1" BirthDate="2012-03-04"/>'
            b'<![CDATA[<Participant BirthDate="1"/>]]></OdfBody>')

    assert fa.strip_birth_dates(body) == (
        b'<OdfBody><Participant Code="1"/>'
        b'<![CDATA[<Participant BirthDate="1"/>]]></OdfBody>')


def test_a_nested_birth_date_element_goes_whole():
    body = (b'<OdfBody><P Code="1"><BirthDate Precision="day"><Y>2012</Y>'
            b'<BirthDate/></BirthDate>tail</P></OdfBody>')

    assert fa.strip_birth_dates(body) == b'<OdfBody><P Code="1">tail</P></OdfBody>'


def test_a_namespace_declaration_named_like_it_is_not_a_birth_date():
    body = b'<OdfBody xmlns:BirthDate="urn:x"><BirthDate:P Code="1"/></OdfBody>'

    assert fa.strip_birth_dates(body) is body


def test_unreachable_birth_dates_raise_instead_of_passing_through():
    with pytest.raises(fa.BirthDateError):
        fa.strip_birth_dates(fixtures.DT_PARTIC_UTF16_BIRTHDATES_BODY)


def test_a_broken_strip_is_caught_by_the_reparse(monkeypatch):
    monkeypatch.setattr(fa, "_remove_birth_date_markup", lambda data: data[:-20])

    with pytest.raises(fa.BirthDateError):
        fa.strip_birth_dates(fixtures.DT_PARTIC_BIRTHDATES_BODY)


def test_a_strip_that_touches_anything_else_is_caught(monkeypatch):
    real = fa._remove_birth_date_markup
    monkeypatch.setattr(fa, "_remove_birth_date_markup",
                        lambda data: real(data).replace(b'GivenName="Aino"', b'GivenName="X"'))

    with pytest.raises(fa.BirthDateError):
        fa.strip_birth_dates(fixtures.DT_PARTIC_BIRTHDATES_BODY)


def test_not_xml_raises():
    with pytest.raises(fa.BirthDateError):
        fa.strip_birth_dates(b"not xml")


# A DTD could keep a birth date out of the strip's reach: the date of
# `BirthDate="&dob;"` stays in the entity declaration once the attribute is gone.
DTD_BIRTHDATE_BODY = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<!DOCTYPE OdfBody [<!ENTITY dob "2012-03-04">]>\n'
    f'<OdfBody CompetitionCode="{fixtures.COMPETITION_CODE_RAW}" DocumentType="DT_PARTIC">'
    '<Competition><Participant Code="1" BirthDate="&dob;"/></Competition></OdfBody>\n'
).encode("utf-8")


@pytest.mark.parametrize("body", [
    DTD_BIRTHDATE_BODY,
    # No birth date in sight: a DTD alone is enough to refuse the file.
    b'<!DOCTYPE OdfBody><OdfBody DocumentType="DT_PARTIC"><P Code="1"/></OdfBody>',
    b'<!DOCTYPE OdfBody SYSTEM "odf.dtd"><OdfBody DocumentType="DT_PARTIC"/>',
    # Nor can the entity carry the element itself.
    b'<!DOCTYPE OdfBody [<!ENTITY e "<BirthDate>2012</BirthDate>">]><OdfBody>&e;</OdfBody>',
])
def test_a_file_with_a_dtd_is_refused(body):
    with pytest.raises(fa.BirthDateError, match="DTD"):
        fa.strip_birth_dates(body)


def test_a_file_without_a_dtd_still_parses_as_before():
    assert fa.strip_birth_dates(b'<OdfBody><P Code="&amp;"/></OdfBody>') == \
        b'<OdfBody><P Code="&amp;"/></OdfBody>'


# ── through the listener ──────────────────────────────────────────────────────

@pytest.mark.parametrize("body, expected", [
    (fixtures.DT_PARTIC_BIRTHDATES_BODY, fixtures.DT_PARTIC_BIRTHDATES_STRIPPED),
    (fixtures.DT_PARTIC_TEAMS_BIRTHDATES_BODY, fixtures.DT_PARTIC_TEAMS_BIRTHDATES_STRIPPED),
])
def test_a_pushed_participant_file_is_stored_without_birth_dates(table, blobs, body, expected):
    response = _post(body)

    assert response.status_code == 200
    blob = _only(blobs)
    assert blob.name.startswith(PENDING + "DT_PARTIC")
    assert blob.data == expected
    assert blob.content_type == "application/xml"


def test_a_participant_file_without_birth_dates_is_stored_byte_for_byte(table, blobs):
    _post(fixtures.DT_PARTIC_BODY)

    assert _only(blobs).data == fixtures.DT_PARTIC_BODY


def test_other_document_types_are_never_touched(table, blobs):
    _post(fixtures.DT_SCHEDULE_WITH_BIRTHDATE_BODY)

    assert _only(blobs).data == fixtures.DT_SCHEDULE_WITH_BIRTHDATE_BODY


def test_a_participant_file_that_cannot_be_cleaned_is_refused_and_not_stored(table, blobs):
    response = _post(fixtures.DT_PARTIC_UTF16_BIRTHDATES_BODY)

    assert response.status_code == 451
    assert head(response, "X-HOVTP-Error-Reason") == "birth dates could not be removed"
    assert blobs.blobs == {}


def test_a_pushed_participant_file_with_a_dtd_is_refused_and_not_stored(table, blobs):
    response = _post(DTD_BIRTHDATE_BODY)

    assert response.status_code == 451
    assert head(response, "X-HOVTP-Error-Reason") == "birth dates could not be removed"
    assert blobs.blobs == {}


@pytest.mark.parametrize("body", [
    fixtures.DT_PARTIC_BODY.replace(b"<OdfBody ", b"<OdfBody Note=\"a & b\" "),
    fixtures.DT_PARTIC_BODY.replace(b"<OdfBody ", b"<OdfBody BROKEN "),
    b"\n" + fixtures.DT_PARTIC_BODY,
])
def test_a_push_whose_header_does_not_parse_is_refused_and_not_stored(table, blobs, body):
    """The listener reads the type from the root tag, so it never stores one it cannot read."""
    response = _post(body)

    assert response.status_code == 400
    assert blobs.blobs == {}


def test_the_participant_types_are_the_allowlisted_ones_and_their_updates():
    assert {"DT_PARTIC", "DT_PARTIC_TEAMS"} <= fa.PARTICIPANT_DOCUMENT_TYPES
    assert {t for t in fa.PARTICIPANT_DOCUMENT_TYPES if not t.endswith("_UPDATE")} == \
        {t for t in fa.DEFAULT_ALLOWED_DOCUMENT_TYPES.split(",") if t.startswith("DT_PARTIC")}
