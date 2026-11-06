#!/usr/bin/env python3
"""Local leak check: no real name from the reference exports in the sample data.

Not run in CI. The reference FS Manager exports that the layouts were learned
from hold real people's data, so they never leave the developer's machine
(default ~/fs-samples/refs, override with --refs). This script reads them at
runtime, collects every person, club and team name and every competition
name and venue they carry, and asserts that none of them appears in any
generated file's name, PDF text or XML. No name is written into this script.

    .venv/bin/python check_leaks.py           # prints counts only
    .venv/bin/python check_leaks.py --show    # also prints what leaked (local use)

Sources: DT_PARTIC / DT_PARTIC_TEAMS / DT_SCHEDULE, the panel PDFs' role
lines, judges' and technical sheets, start lists, results, judges' details and
protocol head pages. A full name must not appear anywhere; a family name, club
or team name of 4+ characters must not appear as a whole word. Shorter tokens
and a few generic words (below) are skipped, since they also occur in labels.
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import re
import sys
import warnings
import xml.etree.ElementTree as ET
from pathlib import Path

warnings.filterwarnings("ignore")
logging.getLogger("pypdf").setLevel(logging.ERROR)
HERE = Path(__file__).resolve().parent

ROLE_RE = re.compile(r"^(Referee|Judge No\.?\s*\d+|Technical Controller:?|Technical Specialist\s*\d?:?|"
                     r"Data Operator|Replay Operator)\s{2,}(.+)$")
TITLE_RE = re.compile(r"^(Ms\.|Mr\.|Dr\.)\s*")
TIME = r"\d{1,2}[.:]\d{2}[.:]\d{2}"
START_ROW_RE = re.compile(rf"^\s*{TIME}\s*-\s*{TIME}\s+(\d+)\s+(.+)$")
RANK_ROW_RE = re.compile(r"^\s*(\d{1,2})\s{2,}(\D.*)$")
NUMERIC = re.compile(r"^[\d.,:/+\-()]+$")
# Generic words that may appear in names and labels alike; never checked alone.
GENERIC = {
    "skating", "club", "team", "junior", "senior", "novice", "advanced", "basic", "ice", "dance",
    "free", "short", "program", "synchro", "synchronized", "arena", "rink", "hall", "competition",
    "trophy", "cup", "women", "men", "girls", "boys", "ladies", "figure", "skaters", "skate",
    "warm-up", "group", "resurfacing", "total", "score", "segment", "results", "referee",
    "judge", "technical", "controller", "specialist", "operator", "data", "replay", "nation",
    "name", "music", "coach", "notes", "page", "printed", "legend", "rank", "points", "current",
}


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().casefold()


class Names:
    def __init__(self):
        self.full = set()      # full names, competition names, venues: substring match
        self.words = set()     # family names, clubs, team-name words: whole-word match

    def person(self, text: str):
        """'Given FAMILY' (or a couple 'A B / C D'): the full name, and the
        family name (FSM prints it in capitals) as a word."""
        text = TITLE_RE.sub("", text.strip()).strip(" ,")
        text = re.sub(r",\s*[A-Z]{3}$", "", text)  # 'Name, FIN' signature lines
        for part in text.split(" / "):
            tokens = [t for t in part.split() if not NUMERIC.match(t)]
            if len(tokens) >= 2 and not {t.casefold() for t in tokens} <= GENERIC:
                self.full.add(norm(" ".join(tokens)))
                for t in tokens:
                    if t.isupper():
                        self.word(t)

    def club(self, token: str):
        token = token.strip()
        if token and " " not in token and len(token) <= 10 and any(c.isupper() for c in token):
            self.word(token)

    def word(self, token: str):
        token = token.strip(" ,.;:()")
        if len(token) >= 4 and token.casefold() not in GENERIC and not NUMERIC.match(token):
            self.words.add(token.casefold())

    def phrase(self, text: str):
        text = norm(text)
        if len(text) >= 4 and not set(text.split()) <= GENERIC:
            self.full.add(text)


def pdf_lines(path):
    from pypdf import PdfReader
    for page in PdfReader(str(path)).pages:
        for line in (page.extract_text(extraction_mode="layout") or "").split("\n"):
            if line.strip():
                yield line


def columns(line):
    return [c for c in re.split(r"\s{2,}", line.strip()) if c]


def competitor(names: Names, cols, strict=False):
    """A start-list / results row's columns: competitor (skater, couple or team), club last.
    `strict` (sheets that also list elements): only 'Given FAMILY' style names count."""
    if not cols or re.search(r"\d", cols[0]) or re.match(r"(?i)warm|ice resurfacing", cols[0]):
        return
    if strict and not any(t.isupper() and len(t) > 1 for t in cols[0].split()[1:]):
        return
    first = re.sub(r"^\d+\s+", "", cols[0])
    if any(t.isupper() and len(t) > 1 for t in first.split()):
        names.person(first)
    else:
        names.phrase(first)  # a team name
    if len(cols) > 1:
        names.club(cols[-1] if len(cols[-1].split()) == 1 else cols[1].split()[0])


def collect(refs: Path) -> Names:
    names = Names()
    for path in sorted(refs.rglob("*")):
        if not path.is_file():
            continue
        name = path.name
        if name.endswith(".xml"):
            root = ET.parse(path).getroot()
            if root.get("CompetitionCode"):
                names.word(root.get("CompetitionCode"))
            for el in root.iter():
                tag = el.tag.split("}")[-1]
                if tag == "Participant":
                    given, family = el.get("GivenName") or "", el.get("FamilyName") or ""
                    names.person(f"{given} {family}")
                    for attr in ("PrintName", "TVName", "PSCBLongName", "PassportGivenName"):
                        if el.get(attr):
                            names.person(el.get(attr))
                    names.word(family)
                    names.club(el.get("Organisation") or "")
                elif tag == "Team":
                    names.phrase(el.get("Name") or "")
                    names.club(el.get("Organisation") or "")
                elif tag in ("Session", "VenueDescription"):
                    for attr in ("VenueName", "LocationName"):
                        if el.get(attr):
                            names.phrase(el.get(attr))
            continue
        if not name.endswith(".pdf"):
            continue
        lines = list(pdf_lines(path))
        first = lines[0].strip() if lines else ""
        for line in lines:
            stripped = line.strip()
            m = ROLE_RE.match(stripped)
            if m:
                names.person(columns(m.group(2))[0])
                continue
            m = START_ROW_RE.match(line)
            if m:
                competitor(names, columns(m.group(2)))
                continue
            m = RANK_ROW_RE.match(line)
            if m and any(s in name for s in ("Results", "JudgesSheetAll", "JudgesDetails", "RefereeSheet",
                                             "PlannedProgram", "Technical")):
                competitor(names, [c for c in columns(m.group(2)) if not NUMERIC.match(c)],
                           strict="Results" not in name)
                continue
            if re.search(r",\s*[A-Z]{3}\s*$", stripped):
                for col in columns(stripped):
                    if re.search(r",\s*[A-Z]{3}$", col):
                        names.person(col)
        if first and ("JudgesSheetAll" in name or "Sheet" in name):
            names.phrase(first)  # the competition name
        if "ProtocolHeadPage" in name and len(lines) > 1:
            names.phrase(columns(lines[1])[0])
        if "CompetitionSchedule" in name and first and "SCHEDULE" not in first:
            names.phrase(first)
    return names


def generated_texts(root: Path):
    import pymupdf as fitz
    import json
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    paths = sorted({p for files in manifest["combinations"].values() for p in files})
    on_disk = sorted(str(p.relative_to(root)) for sub in ("datasets", "combined")
                     for p in (root / sub).rglob("*") if p.is_file())
    for rel in sorted(set(paths) | set(on_disk)):
        path = root / rel
        if path.suffix == ".pdf":
            doc = fitz.open(str(path))
            text = "\n".join(page.get_text() for page in doc)
            doc.close()
        else:
            text = path.read_text("utf-8")
        yield rel, f"{rel}\n{text}"
    yield "manifest.json", (root / "manifest.json").read_text("utf-8")
    # the generator's name pools and the docs, too
    for name in ("generate.py", "verify_parsers.py", "README.md"):
        yield name, (HERE / name).read_text("utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Check the sample data for names from the references.")
    parser.add_argument("--refs", type=Path, default=Path.home() / "fs-samples" / "refs")
    parser.add_argument("--dir", type=Path, default=HERE, help="sample_data tree to check (default: here)")
    parser.add_argument("--show", action="store_true", help="print leaked names (never paste them anywhere)")
    args = parser.parse_args(argv)
    if not args.refs.is_dir():
        print(f"reference folder not found: {args.refs}")
        return 2
    names = collect(args.refs)
    word_res = [(w, re.compile(r"(?<![\w])" + re.escape(w) + r"(?![\w])")) for w in sorted(names.words)]
    passed = failed = 0
    for rel, text in generated_texts(args.dir.resolve()):
        haystack = norm(text)
        leaks = [n for n in names.full if n in haystack] + [w for w, rx in word_res if rx.search(haystack)]
        if leaks:
            failed += 1
            digest = ", ".join(hashlib.sha256(x.encode()).hexdigest()[:8] for x in sorted(leaks))
            print(f"FAIL {rel}: {len(leaks)} reference name(s) [{digest}]")
            if args.show:
                print("     ", sorted(leaks))
        else:
            passed += 1
    print(f"reference names: {len(names.full)} full, {len(names.words)} single words")
    print(f"files: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
