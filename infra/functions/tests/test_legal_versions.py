"""TERMS_VERSION / PRIVACY_VERSION match the published documents.

The platform records which version a user accepted (test_terms_acceptance.py),
so the constants must be the dates the pages show. Every `<time
data-version="terms|privacy" datetime="…">` in the terms of use, the privacy
notice and its Finnish translation must carry the current constant: bump the
constants and the pages together.
"""
import os
import re

import pytest

import function_app as fa

PUBLIC = os.path.join(os.path.dirname(__file__), "..", "..", "..", "site", "public")
PAGES = {
    "terms/index.html": {"terms", "privacy"},
    "privacy/index.html": {"terms", "privacy"},
    "tietosuoja/index.html": {"terms", "privacy"},
}
# The hero "Last updated" line of each page is its own document's version.
OWN_VERSION = {"terms/index.html": "terms", "privacy/index.html": "privacy",
               "tietosuoja/index.html": "privacy"}
_TIME_RE = re.compile(r'<time datetime="([^"]+)" data-version="(terms|privacy)">')


def _versions(page):
    with open(os.path.join(PUBLIC, page), encoding="utf-8") as handle:
        html = handle.read()
    return html, _TIME_RE.findall(html)


@pytest.mark.parametrize("page", sorted(PAGES))
def test_every_version_on_the_page_is_the_current_one(page):
    _html, found = _versions(page)
    current = {"terms": fa.TERMS_VERSION, "privacy": fa.PRIVACY_VERSION}
    assert {kind for _date, kind in found} == PAGES[page]
    for date, kind in found:
        assert date == current[kind], f"{page}: {kind} {date} != {current[kind]}"


@pytest.mark.parametrize("page", sorted(PAGES))
def test_the_last_updated_line_names_the_page_s_own_version(page):
    html, _found = _versions(page)
    hero = html.split('<p class="updated">', 1)[1].split("</p>", 1)[0]
    assert f'data-version="{OWN_VERSION[page]}"' in hero
