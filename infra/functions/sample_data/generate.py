#!/usr/bin/env python3
"""Generate the synthetic sample datasets (FS Manager-style files).

Everything written here is invented: the competition, venue, clubs, teams,
skaters, officials, music titles, element lists, GOEs, marks and scores. Only
the *shape* follows FS Manager (FSM): file names, page layout, column order and
labels, so that the site's tools read the files like a real FSM export:

- Judge Paper Creator (judges' sheets, panels, start lists, schedule),
- Protocol Generator (schedule, results, panels, judges' details, rosters),
- Score Modifier (judges' details per skater),
- the banner tool (DT_SCHEDULE).

The output is deterministic: a fixed seed, reportlab's `invariant=1` and fixed
"printed" stamps. Running it twice gives identical files.

    python3 -m venv .venv && .venv/bin/pip install -r requirements-sampledata.txt
    .venv/bin/python generate.py            # rewrites datasets/, combined/, manifest.json
    .venv/bin/python generate.py --out DIR  # writes the same tree under DIR instead

The rules behind the numbers (2026-27 season, ISU Judging System):
- base values from the small SOV table below; an under-rotated jump ("<") is
  worth 80 %; jumps in the highlight-distribution window ("x": the last jump
  element of a short program, the last three of a free skating) are worth 1.1 x;
- nine judges; a panel value is the trimmed mean (highest and lowest dropped);
- singles and synchro GOE is the trimmed mean grade x 10 % of the SOV base value
  (choreographic elements 0.50 per grade); ice dance uses a GOE step per element;
- program components: trimmed mean of the nine marks, rounded to two decimals,
  times the segment factor, rounded again;
- a fall is -1.00; segment score = TES + PCS + deductions.
"""

from __future__ import annotations

import argparse
import io
import json
import random
import shutil
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from itertools import combinations
from pathlib import Path
from xml.sax.saxutils import quoteattr

from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

HERE = Path(__file__).resolve().parent
SEED = 20261017
PAGE_W, PAGE_H = 595.0, 842.0
DATASET_IDS = ("synchro", "singles", "icedance")
COMPETITION_PREFIX = "FSK" + "-" * 31  # FSM's competition-level document code (34 chars)

# ── the fictional competition ─────────────────────────────────────────────────

COMPETITION_NAME = "Sample Autumn Trophy 2026"
VENUE = "Sampleton Ice Arena"
DAY1, DAY2 = date(2026, 10, 17), date(2026, 10, 18)  # Saturday, Sunday
UTC_OFFSET = "+02:00"
ORGANISER = "STSC"
COMPETITION_CODE = "SAMPLE" + DAY1.strftime("%d%m%y") + ORGANISER
PAPERS_PRINTED = datetime(2026, 10, 14, 20, 15)  # pre-competition papers

# Invented clubs: (abbreviation, name, ISU nation code). Abbreviations are single
# tokens (Score Modifier and the results parsers read the club as one word).
CLUBS = [
    ("STSC", "Sampleton Skating Club", "FIN"),
    ("NWFSC", "Northwind Figure Skating Club", "SWE"),
    ("ARIC", "Aurora Rink Club", "NOR"),
    ("BLSC", "Bluelake Skating Club", "EST"),
    ("CRIA", "Cedar Ridge Ice Academy", "CAN"),
    ("GFSC", "Glenfield Figure Skating Club", "GBR"),
    ("HVSK", "Havnvik Skoyteklubb", "NOR"),
    ("LCPG", "Lumiere Club de Patinage", "FRA"),
    ("EVMB", "Eisverein Mondberg", "AUT"),
    ("RVSC", "Rivervale Skating Club", "USA"),
    ("SPSK", "Silverpine Skridskoklubb", "SWE"),
    ("VDGC", "Valdoro Ghiaccio Club", "ITA"),
]

OFFICIAL_NATIONS = ["FIN", "SWE", "NOR", "DEN", "EST", "LAT", "GER", "NED", "AUT",
                    "SUI", "GBR", "CAN", "ITA", "FRA", "ESP", "POL", "CZE", "HUN"]

# Mixed-origin name pools; every person gets a unique full name.
FEMALE_GIVEN = [
    "Alba", "Amelie", "Astrid", "Bianca", "Camille", "Chiara", "Daria", "Elodie",
    "Emilia", "Freya", "Greta", "Hedda", "Ilse", "Ines", "Isla", "Josefine",
    "Klara", "Lea", "Lena", "Livia", "Marit", "Mila", "Nora", "Olivia",
    "Paula", "Rosa", "Selma", "Sofia", "Tilde", "Vera", "Wilma", "Ylva", "Zoe",
    "Elsa", "Ronja", "Iris", "Matilda", "Signe", "Edith", "Agnes", "Thea",
    "Fanny", "Ingrid", "Juno", "Kaia", "Liv", "Mira", "Saga", "Siri", "Stella",
    "Tove", "Alma", "Ebba", "Ella", "Ida", "Julia", "Lucia", "Malin", "Nina",
    "Elin", "Felicia", "Hilda", "Leonie", "Marta", "Noa", "Romy", "Aurelia",
    "Beatrix", "Cecilie", "Dagny", "Estelle", "Fiona", "Gemma", "Helena",
    "Imke", "Jolene", "Karin", "Lorena", "Mireille", "Nadia", "Oriana", "Petra",
    "Renata", "Solveig", "Talia", "Ursula", "Valentina", "Yasmin", "Zelda",
]
MALE_GIVEN = [
    "Anton", "Arvid", "Bastian", "Casper", "Dario", "Elias", "Emil", "Felix",
    "Gustav", "Hugo", "Ivar", "Jonas", "Kasper", "Leon", "Lukas", "Matteo",
    "Milo", "Nils", "Oskar", "Pavel", "Rasmus", "Samuel", "Teo", "Viktor",
    "William", "Aksel", "Benno", "Joel", "Linus", "Mats", "Otto", "Sven",
    "Adrian", "Bruno", "Cedric", "Dominic", "Fabian", "Gideon", "Henrik",
]
SURNAMES = [
    "Ashford", "Bellamy", "Blackwell", "Bramley", "Carver", "Calloway", "Dunmore",
    "Ellery", "Fairfax", "Garnett", "Hadley", "Hollis", "Kingsley", "Langford",
    "Marlowe", "Northcott", "Oakes", "Pembrook", "Radcliffe", "Selwyn",
    "Thornbury", "Underhill", "Wexford", "Whitlock", "Yardley", "Ainsworth",
    "Brightwell", "Cresswell", "Dorrington", "Everleigh", "Farrow", "Galloway",
    "Hartigan", "Ivesdale", "Jessop", "Kendrick", "Lockridge", "Merriweather",
    "Netherby", "Ormsby", "Prescott", "Quarrington", "Rowntree", "Stanhope",
    "Tolliver", "Upshaw", "Winslow", "Archambault", "Beaumont", "Chastain",
    "Delaunay", "Duvernoy", "Fontaine", "Garnier", "Lacombe", "Peyrac",
    "Rousselot", "Sabatier", "Tessier", "Vauclair", "Villeneuve", "Lemaire",
    "Boisvert", "Courtois", "Delorme", "Albertini", "Benedetti", "Castellani",
    "Donatelli", "Ferraro", "Galvani", "Lombardi", "Mancuso", "Navarra",
    "Orsini", "Pellegrini", "Rinaldi", "Salvatori", "Tornabene", "Valcarcel",
    "Zanetti", "Abrantes", "Cordero", "Esparza", "Montalvo", "Quintero",
    "Robledo", "Saavedra", "Varela", "Achterberg", "Bremer", "Dankwart",
    "Eichhorn", "Falkenrath", "Grunwald", "Hellwig", "Imhof", "Kesselring",
    "Lindenau", "Mertens", "Oosterhuis", "Rademaker", "Steinhauer", "Terhorst",
    "Vogelsang", "Westerhoff", "Zellweger", "Brandauer", "Hoogland", "Aasland",
    "Bjerke", "Dahlby", "Fjeldstad", "Grimstad", "Haugen", "Kvale", "Lervik",
    "Mykland", "Nordby", "Ostvik", "Rasmusen", "Skovgaard", "Tveit",
    "Vestergaard", "Haldorsen", "Bartos", "Kalnins", "Lazarev", "Petrauskas",
    "Sokolov", "Varga", "Horvath", "Kowalczyk", "Zielinska", "Moravec",
    "Ashcombe", "Bellweather", "Carrow", "Danvers", "Easterby", "Fenwick",
    "Gosling", "Hawthorne", "Ingleby", "Juniper", "Kittredge", "Lowther",
    "Mapplethorpe", "Nettleton", "Ogilvie", "Pennington", "Quayle", "Redgrave",
    "Sutcliffe", "Treadwell", "Vandermeer", "Wainwright",
]
MUSIC = [
    "Nocturne in Blue", "Winter Lanterns", "Northern Lights Suite", "Tango of the Tide",
    "Clockwork Waltz", "Glass Garden", "Paper Moon Overture", "Silver Thread",
    "Ember and Ash", "Midnight Carousel", "Harbour Song", "Velvet Storm",
    "First Snowfall", "Lighthouse", "Starlit Avenue", "The Long Road Home",
    "Copper Sky", "Dance of the Marionettes", "Moonrise Kingdom Suite", "Aurora Theme",
]
SYNCHRO_TEAMS = {  # category code -> [(club, team name)]
    "FSKXSYNCHRONJUNIOR": [
        ("NWFSC", "Nordic Lanterns"), ("STSC", "Aurora Pulse"), ("BLSC", "Crystal Tide"),
        ("CRIA", "Velvet Comets"), ("SPSK", "Harbour Lights"), ("GFSC", "Ember Waves"),
    ],
    "FSKXSYNCHRONADVNOV": [
        ("NWFSC", "Little Lanterns"), ("STSC", "Frost Sparks"), ("ARIC", "Tidal Twinkles"),
        ("RVSC", "Snow Finches"), ("VDGC", "Glacier Pups"),
    ],
}
FORBIDDEN_SUBSTRINGS = ("rank", "page", "legend", "executed")  # Score Modifier anchors

# ── rules: categories, segments, factors, timing ─────────────────────────────

@dataclass(frozen=True)
class SegmentRule:
    key: str            # "SP", "FS", "RD", "FD"
    name: str           # as FSM prints it in mixed case
    phase: str          # file-name segment part
    factor: Decimal     # program component factor
    perf: int           # seconds of skating
    intro: int
    judging: int
    warmup: int         # 0 = no warm-up groups
    resurfacing: int
    elements: int       # rows printed in the element table of the judges' sheet


SP = "QUAL000100"
FNL = "FNL-000100"

CATEGORIES = {
    "FSKWSINGLES-JUNIOR": dict(
        dataset="singles", name="Junior Women", discipline="singles", gender="F",
        entries=8, groups=(4, 4), segments=(
            SegmentRule("SP", "Short Program", SP, Decimal("1.33"), 160, 30, 165, 360, 900, 7),
            SegmentRule("FS", "Free Skating", FNL, Decimal("2.67"), 210, 30, 170, 360, 900, 10),
        )),
    "FSKMSINGLES-JUNIOR": dict(
        dataset="singles", name="Junior Men", discipline="singles", gender="M",
        entries=5, groups=(5,), segments=(
            SegmentRule("SP", "Short Program", SP, Decimal("1.67"), 160, 30, 165, 360, 900, 7),
            SegmentRule("FS", "Free Skating", FNL, Decimal("3.33"), 210, 30, 170, 360, 900, 10),
        )),
    "FSKXICEDANCEJUNIOR": dict(
        dataset="icedance", name="Junior Ice Dance", discipline="dance", gender="X",
        entries=5, groups=(5,), segments=(
            SegmentRule("RD", "Rhythm Dance", SP, Decimal("1.33"), 170, 30, 180, 300, 900, 5),
            SegmentRule("FD", "Free Dance", FNL, Decimal("2.00"), 210, 30, 210, 300, 900, 8),
        )),
    "FSKXSYNCHRONJUNIOR": dict(
        dataset="synchro", name="Junior Synchronized Skating", discipline="synchro", gender="X",
        entries=6, groups=(3, 3), segments=(
            SegmentRule("SP", "Short Program", SP, Decimal("1.33"), 170, 60, 130, 0, 1200, 5),
            SegmentRule("FS", "Free Skating", FNL, Decimal("2.67"), 210, 60, 180, 0, 1200, 7),
        )),
    "FSKXSYNCHRONADVNOV": dict(
        dataset="synchro", name="Advanced Novice Synchronized Skating", discipline="synchro",
        gender="X", entries=5, groups=(5,), segments=(
            SegmentRule("FS", "Free Skating", FNL, Decimal("2.67"), 180, 60, 180, 0, 1200, 6),
        )),
}

# Running order over the two days: (category code, segment key)
RUNNING_ORDER = {
    DAY1: [("FSKWSINGLES-JUNIOR", "SP"), ("FSKMSINGLES-JUNIOR", "SP"),
           ("FSKXICEDANCEJUNIOR", "RD"), ("FSKXSYNCHRONJUNIOR", "SP")],
    DAY2: [("FSKXSYNCHRONADVNOV", "FS"), ("FSKWSINGLES-JUNIOR", "FS"),
           ("FSKMSINGLES-JUNIOR", "FS"), ("FSKXICEDANCEJUNIOR", "FD"),
           ("FSKXSYNCHRONJUNIOR", "FS")],
}
DAY_START = {DAY1: (9, 0), DAY2: (9, 0)}

# PCS mark ranges (weakest .. strongest competitor)
PCS_RANGE = {"singles": (4.25, 7.25), "dance": (4.0, 6.75), "synchro": (5.0, 8.25)}
PCS_RANGE_NOVICE = (4.0, 6.75)

# ── the scale of values (2026-27; values as FSM prints them) ─────────────────

JUMP_BV = {
    "1T": "0.40", "1S": "0.40", "1Lo": "0.50", "1F": "0.50", "1Lz": "0.60", "1A": "1.10",
    "2T": "1.30", "2S": "1.30", "2Lo": "1.70", "2F": "1.80", "2Lz": "2.10", "2A": "3.30",
    "3T": "4.20", "3S": "4.30", "3Lo": "4.90", "3F": "5.30", "3Lz": "5.90", "3A": "8.00",
}
LEVELLED_BV = {  # code -> {level: base value}
    "FCSp": {1: "2.30", 2: "2.80", 3: "3.40", 4: "3.80"},
    "FSSp": {2: "2.80", 3: "3.10", 4: "3.60"},
    "LSp": {2: "2.30", 3: "2.90", 4: "3.20"},
    "SSp": {2: "1.90", 3: "2.50", 4: "3.00"},
    "CSSp": {3: "3.10", 4: "3.60"},
    "CCoSp": {1: "2.40", 2: "3.00", 3: "3.60", 4: "4.20"},
    "StSq": {1: "1.90", 2: "2.70", 3: "3.50", 4: "4.10"},
    # synchronized skating
    "PB": {1: "3.50", 2: "4.50", 3: "5.50", 4: "6.50"},
    "ME": {2: "4.50", 3: "6.00", 4: "7.00"},
    "TwE": {3: "6.00", 4: "7.00"},
    "SySp": {2: "4.50", 3: "6.00", 4: "7.00"},
    "Pa": {3: "6.00", 4: "7.00"},
    "TrE": {3: "4.00", 4: "5.00"},
}
FIXED_BV = {  # executed code -> base value
    "ChSq1": "3.50", "ChSp1": "3.50", "CrL1": "4.00", "CrD1": "4.00",
    "I4+pi4": "7.50", "I4+pi3": "7.00", "I3+pi4": "7.25", "I3+pi3": "6.75",
    "I4+pi2": "6.25", "I3+pi2": "6.00", "I2+pi3": "5.75",
    "NHE4+sB": "5.00", "NHE3+sB": "3.00",
    "NHEB+s1": "0.75", "NHEB+s2": "2.25", "NHEB+s3": "4.00", "NHEB+s4": "6.00",
    "NHE4+s1": "5.25", "NHE4+s2": "6.75", "NHE4+s3": "7.50", "NHE3+s1": "3.25", "NHE3+s2": "6.50",
}
# Ice dance: executed code -> (base value, GOE value per positive grade, per negative grade)
DANCE_SOV = {
    "SqTwW4+SqTwM4": ("7.34", "0.80", "0.80"),
    "1WW1+kpYNNN": ("3.50", "0.53", "0.53"), "1WW1+kpNYNN": ("3.50", "0.53", "0.53"),
    "1WWB+kpNNNN": ("2.50", "0.38", "0.38"),
    "2WW1+kpNNYN": ("3.50", "0.53", "0.53"), "2WW1+kpYNNN": ("3.50", "0.53", "0.53"),
    "2WWB+kpNNNN": ("2.50", "0.38", "0.38"),
    "MiStW1+MiStM1": ("6.96", "1.04", "1.04"),
    "DiStW1+DiStM1": ("6.96", "1.04", "1.04"),
    "RoLi4": ("5.45", "0.48", "0.48"), "RoLi2": ("3.95", "0.48", "0.48"),
    "SlLi3": ("4.70", "0.48", "0.48"), "CuLi3": ("4.70", "0.48", "0.48"),
    "CuLi4+RoLi3": ("10.15", "0.96", "0.96"),
    "OFTW1+OFTM1": ("4.84", "0.72", "0.72"), "OFTW2+OFTM1": ("5.09", "0.72", "0.72"),
    "OFTW1+OFTM2": ("5.09", "0.72", "0.72"),
    "SyTwW1+SyTwM2": ("5.09", "0.72", "0.72"), "SyTwW2+SyTwM1": ("5.09", "0.72", "0.72"),
    "DSp1": ("3.75", "0.56", "0.56"), "DSp2": ("4.50", "0.56", "0.56"),
    "ChSl1": ("1.10", "0.83", "0.22"), "ChSt1": ("1.10", "0.83", "0.22"),
    "ChLi1": ("1.10", "0.83", "0.22"), "ChSp1": ("1.10", "0.83", "0.22"),
}

JUMP_NAMES = {"T": "Toeloop", "S": "Salchow", "Lo": "Loop", "F": "Flip", "Lz": "Lutz", "A": "Axel"}
ROTATIONS = {"1": "Single", "2": "Double", "3": "Triple", "4": "Quad"}
DESCRIPTIONS = {
    "FCSp": "Fly. Camel Spin", "FSSp": "Flying Sit Spin", "LSp": "Layback Spin",
    "SSp": "Sit Spin", "CSSp": "Change Foot Sit Spin", "CCoSp": "Change Foot Comb. Spin",
    "StSq": "Step Sequence", "ChSq": "Choreographic Sequence", "ChSp": "Choreographic Spin",
    "PB": "Pivoting Block Element", "ME": "Move Element", "TwE": "Twizzle Element",
    "I": "Intersection Element", "NHE": "No Hold Element", "SySp": "Synchronized Spin Element",
    "Pa": "Pair Element", "TrE": "Traveling Element", "CrL": "Creative Lift Element",
    "CrD": "Creative Dance Element",
    "SqTw": "Sequential Twizzles", "1WW": "Pattern Dance Element, Section 1",
    "2WW": "Pattern Dance Element, Section 2", "MiSt": "Midline Step Sequence",
    "DiSt": "Diagonal Step Sequence", "OFT": "One Foot Turns Sequence",
    "SyTw": "Synchronized Twizzles", "DSp": "Dance Spin", "RoLi": "Rotational Lift",
    "SlLi": "Straight Line Lift", "CuLi": "Curve Lift", "CuLi+RoLi": "Combination Lift",
    "ChSl": "Choreographic Sliding Movement", "ChSt": "Choreographic Character Step Sequence",
    "ChLi": "Choreographic Dance Lift",
}

# Program layouts per category and segment. Singles: a jump element is a jump
# spec ("3Lz+2T", "3S+2A+SEQ"); a spin/step is its code. Synchro and dance:
# planned codes. The order of each layout is the order skated.
SINGLES_SP = {
    "F": [["3Lz+2T", "2A", "FCSp", "3F", "LSp", "StSq", "CCoSp"],
          ["2A", "3S+3T", "LSp", "3Lz", "FCSp", "StSq", "CCoSp"],
          ["3Lo+2T", "3Lz", "FCSp", "2A", "SSp", "CCoSp", "StSq"],
          ["3T+3T", "2A", "SSp", "3Lz", "StSq", "FCSp", "CCoSp"],
          ["2Lz", "3S+2T", "FCSp", "2A", "LSp", "StSq", "CCoSp"]],
    "M": [["3F+3T", "3Lz", "FCSp", "2A", "CSSp", "StSq", "CCoSp"],
          ["2A", "3Lz+2T", "CSSp", "3F", "FCSp", "StSq", "CCoSp"],
          ["3Lz", "3S+3T", "FCSp", "StSq", "2A", "CCoSp", "CSSp"],
          ["3Lo+2T", "2A", "CSSp", "3Lz", "StSq", "FCSp", "CCoSp"]],
}
SINGLES_FS = {
    "F": [["3Lz+2T", "3F", "2A", "FCSp", "3Lo", "3S+2A+SEQ", "ChSq", "3T", "CCoSp", "ChSp"],
          ["3F+3T", "3Lz", "FSSp", "2A+2T", "3Lo", "ChSq", "3S", "2A", "CCoSp", "ChSp"],
          ["2A", "3T+2T+2Lo", "3S", "FCSp", "3Lo", "ChSp", "3T+2A+SEQ", "ChSq", "2Lz", "CCoSp"],
          ["3S+2T", "3Lo", "2A", "FCSp", "3T", "ChSq", "2Lz+2T", "2F", "CCoSp", "ChSp"],
          ["3Lz", "2A+3T", "3F", "FSSp", "ChSq", "3Lo+2T+2Lo", "3S", "2A", "ChSp", "CCoSp"]],
    "M": [["3Lz+3T", "3F", "2A", "FSSp", "3Lo", "3S+2A+SEQ", "ChSq", "3Lz", "CCoSp", "ChSp"],
          ["3F+2T", "3Lz", "3Lo", "FCSp", "2A+2T", "ChSq", "3S", "3T", "CCoSp", "ChSp"],
          ["2A", "3Lz+2T+2Lo", "3F", "FCSp", "3S", "ChSp", "3T+2A+SEQ", "ChSq", "3Lo", "CCoSp"],
          ["3Lo", "3F+3T", "3Lz", "FSSp", "ChSq", "2A", "3S+2T", "3T", "ChSp", "CCoSp"]],
}
SYNCHRO_LAYOUTS = {
    ("FSKXSYNCHRONJUNIOR", "SP"): ["PB", "ME", "TwE", "I", "NHE"],
    ("FSKXSYNCHRONJUNIOR", "FS"): ["CrL", "SySp", "I", "NHE", "Pa", "TrE", "CrD"],
    ("FSKXSYNCHRONADVNOV", "FS"): ["TrE", "PB", "ME", "SySp", "NHE", "I"],
}
DANCE_LAYOUTS = {
    "RD": [["SqTw", "1WW", "2WW", "MiSt", "RoLi"], ["RoLi", "1WW", "2WW", "MiSt", "SqTw"],
           ["SqTw", "MiSt", "1WW", "2WW", "SlLi"], ["CuLi", "1WW", "2WW", "SqTw", "MiSt"]],
    "FD": [["OFT", "DiSt", "DSp", "SyTw", "CuLi+RoLi", "ChSl", "ChSp"],
           ["SyTw", "RoLi", "OFT", "ChSt", "CuLi", "DiSt", "DSp", "ChLi"],
           ["OFT", "CuLi+RoLi", "DiSt", "ChSt", "SyTw", "DSp", "ChSl"]],
}

# ── small helpers ─────────────────────────────────────────────────────────────

D = Decimal
CENT = Decimal("0.01")


def r2(value) -> Decimal:
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def f2(value) -> str:
    return f"{r2(value):.2f}"


def trimmed_mean(values):
    """ISU trimmed mean: the highest and lowest value dropped."""
    vals = sorted(values)[1:-1]
    return sum(vals, D(0)) / len(vals)


def hms(seconds: int) -> str:
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def ms(seconds: int) -> str:
    return f"{seconds // 60}:{seconds % 60:02d}"


def stamp(dt: datetime) -> str:
    return dt.strftime("%d.%m.%Y %H:%M")


# ── people ────────────────────────────────────────────────────────────────────

@dataclass
class Person:
    given: str
    family: str
    gender: str          # F / M
    club: str = ""       # abbreviation (skaters)
    nation: str = ""
    code: str = ""       # ODF participant code

    @property
    def name(self) -> str:          # as FSM prints a skater: Given FAMILY
        return f"{self.given} {self.family.upper()}"

    @property
    def titled(self) -> str:        # as FSM prints an official: Ms. Given FAMILY
        return f"{'Ms.' if self.gender == 'F' else 'Mr.'} {self.name}"


class People:
    def __init__(self, rng: random.Random):
        self.rng = rng
        self.used = set()
        self.codes = set()

    def code(self, digits=8) -> str:
        while True:
            value = str(self.rng.randrange(10 ** (digits - 1), 10 ** digits))
            if value not in self.codes:
                self.codes.add(value)
                return value

    def new(self, gender: str, families_taken=None) -> Person:
        pool = FEMALE_GIVEN if gender == "F" else MALE_GIVEN
        for _ in range(10000):
            given, family = self.rng.choice(pool), self.rng.choice(SURNAMES)
            if (given, family) in self.used:
                continue
            if families_taken is not None and family in families_taken:
                continue
            self.used.add((given, family))
            if families_taken is not None:
                families_taken.add(family)
            return Person(given, family, gender, code=self.code())
        raise RuntimeError("name pool exhausted")


# ── scoring ───────────────────────────────────────────────────────────────────

@dataclass
class Element:
    planned: str
    code: str            # executed, as printed
    info: str            # Info column ("<", "q", "F", "<,F" ...)
    bv: Decimal          # printed base value (x included)
    x: bool
    grades: list         # nine judges
    goe: Decimal
    score: Decimal


@dataclass
class Performance:
    competitor: "Competitor"
    start_no: int
    elements: list
    components: list     # [(name, [nine marks], average)]
    factor: Decimal
    falls: int
    tes: Decimal = D(0)
    pcs: Decimal = D(0)
    deductions: Decimal = D(0)
    total: Decimal = D(0)
    rank: int = 0
    music: str = ""


@dataclass
class Competitor:
    name: str            # as printed
    club: str
    ability: float
    members: list = field(default_factory=list)   # Person (skater, couple, team incl. alternates)
    team_code: str = ""
    performances: dict = field(default_factory=dict)  # segment key -> Performance
    total: Decimal = D(0)
    rank: int = 0


def judge_grades(rng, quality, spread=0.8):
    grades = []
    for _ in range(9):
        g = int(round(quality + rng.gauss(0, spread)))
        grades.append(max(-5, min(5, g)))
    return grades


def goe_linear(grades, step):
    return r2(trimmed_mean([D(g) * step for g in grades]))


def jump_parts(spec: str):
    """'3S+2A+SEQ' -> (['3S', '2A'], ['SEQ'])"""
    jumps, extras = [], []
    for part in spec.split("+"):
        (jumps if part[:1].isdigit() else extras).append(part)
    return jumps, extras


def describe(planned: str) -> str:
    if planned in DESCRIPTIONS:
        return DESCRIPTIONS[planned]
    jumps, extras = jump_parts(planned)
    if jumps:
        words = [f"{ROTATIONS[j[0]]} {JUMP_NAMES[j[1:]]}" for j in jumps]
        text = "+".join(words)
        return text + (" Sequence" if "SEQ" in extras else "")
    return planned


def singles_element(rng, planned, ability, x, allow_error):
    """Executed code, info, base value and grades of one singles element."""
    quality = -0.8 + 3.0 * ability + rng.gauss(0, 0.5)
    jumps, extras = jump_parts(planned)
    if jumps:
        marks = [""] * len(jumps)
        bvs = [D(JUMP_BV[j]) for j in jumps]
        fall = False
        if allow_error:
            kind = rng.choice(["<", "q", "F"])
            target = max(range(len(jumps)), key=lambda i: bvs[i]) if kind != "<" else \
                rng.choice([i for i, j in enumerate(jumps) if j[0] in "23"] or [0])
            if kind == "<" and jumps[target][0] in "23":
                marks[target] = "<"
                bvs[target] = r2(bvs[target] * D("0.8"))
                quality -= 1.8
            elif kind == "q":
                marks[target] = "q"
                quality -= 1.2
            else:
                fall = True
        code = "+".join(j + m for j, m in zip(jumps, marks)) + "".join("+" + e for e in extras)
        info = ",".join(m for m in marks if m)
        if fall:
            info = (info + ",F") if info else "F"
        base = sum(bvs, D(0))
        ref = max(bvs)
        grades = [-5] * 9 if fall else judge_grades(rng, quality)
        goe = goe_linear(grades, ref / 10)
        printed = r2(base * D("1.1")) if x else base
        return Element(planned, code, info, printed, x, grades, goe, printed + goe), fall
    # spins, steps, choreographic elements
    if planned in ("ChSq", "ChSp"):
        code = planned + "1"
        bv = D(FIXED_BV[code])
        grades = judge_grades(rng, quality + 0.3)
        goe = goe_linear(grades, D("0.5"))
        return Element(planned, code, "", bv, False, grades, goe, bv + goe), False
    levels = LEVELLED_BV[planned]
    wanted = 1 + int(3.2 * ability + rng.random() * 1.6)
    level = min(levels, key=lambda lv: (abs(lv - wanted), -lv))
    code = f"{planned}{level}"
    bv = D(levels[level])
    grades = judge_grades(rng, quality)
    goe = goe_linear(grades, bv / 10)
    return Element(planned, code, "", bv, False, grades, goe, bv + goe), False


def synchro_element(rng, planned, ability):
    quality = -0.5 + 3.0 * ability + rng.gauss(0, 0.5)
    if planned == "I":
        options = ["I4+pi4", "I4+pi3", "I3+pi4", "I3+pi3", "I4+pi2", "I3+pi2", "I2+pi3"]
        code = options[max(0, min(len(options) - 1, int((1 - ability) * 6 + rng.random() * 2)))]
        bv = D(FIXED_BV[code])
    elif planned in ("CrL", "CrD"):
        code = planned + "1"
        bv = D(FIXED_BV[code])
    else:
        levels = LEVELLED_BV[planned]
        wanted = 2 + int(2.4 * ability + rng.random() * 1.4)
        level = min(levels, key=lambda lv: (abs(lv - wanted), -lv))
        code = f"{planned}{level}"
        bv = D(levels[level])
    grades = judge_grades(rng, quality)
    goe = goe_linear(grades, bv / 10)
    return Element(planned, code, "", bv, False, grades, goe, bv + goe)


def synchro_nhe(rng, segment_key, ability, novice):
    """The no-hold element differs per segment: '+sB' in the junior SP, 'B+s' in the FS."""
    quality = -0.5 + 3.0 * ability + rng.gauss(0, 0.5)
    if novice:
        options = ["NHE4+s3", "NHE4+s2", "NHE4+s1", "NHE3+s2", "NHE3+s1"]
    elif segment_key == "SP":
        options = ["NHE4+sB", "NHE4+sB", "NHE3+sB"]
    else:
        options = ["NHEB+s4", "NHEB+s3", "NHEB+s2", "NHEB+s1"]
    code = options[max(0, min(len(options) - 1, int((1 - ability) * (len(options) - 1) + rng.random())))]
    bv = D(FIXED_BV[code])
    grades = judge_grades(rng, quality)
    goe = goe_linear(grades, bv / 10)
    return Element("NHE", code, "", bv, False, grades, goe, bv + goe)


def dance_element(rng, planned, ability):
    quality = -0.8 + 3.0 * ability + rng.gauss(0, 0.5)
    good = rng.random() < 0.35 + 0.6 * ability
    choices = {
        "SqTw": ["SqTwW4+SqTwM4"],
        "1WW": ["1WW1+kpYNNN", "1WW1+kpNYNN"] if good else ["1WWB+kpNNNN"],
        "2WW": ["2WW1+kpNNYN", "2WW1+kpYNNN"] if good else ["2WWB+kpNNNN"],
        "MiSt": ["MiStW1+MiStM1"], "DiSt": ["DiStW1+DiStM1"],
        "RoLi": ["RoLi4"] if good else ["RoLi2"], "SlLi": ["SlLi3"], "CuLi": ["CuLi3"],
        "CuLi+RoLi": ["CuLi4+RoLi3"],
        "OFT": ["OFTW2+OFTM1", "OFTW1+OFTM2"] if good else ["OFTW1+OFTM1"],
        "SyTw": ["SyTwW1+SyTwM2", "SyTwW2+SyTwM1"],
        "DSp": ["DSp2"] if good else ["DSp1"],
        "ChSl": ["ChSl1"], "ChSt": ["ChSt1"], "ChLi": ["ChLi1"], "ChSp": ["ChSp1"],
    }[planned]
    code = rng.choice(choices)
    bv, pos, neg = (D(v) for v in DANCE_SOV[code])
    grades = judge_grades(rng, quality, 0.7)
    goe = r2(trimmed_mean([D(g) * (pos if g > 0 else neg) for g in grades]))
    return Element(planned, code, "", bv, False, grades, goe, bv + goe)


def pcs_marks(rng, ability, lo, hi):
    base = lo + (hi - lo) * ability
    comps = []
    for name in ("Composition", "Presentation", "Skating Skills"):
        centre = base + rng.gauss(0, 0.2)
        marks = []
        for _ in range(9):
            m = round((centre + rng.gauss(0, 0.35)) * 4) / 4
            marks.append(D(str(max(0.25, min(10.0, m)))).quantize(CENT))
        comps.append((name, marks, r2(trimmed_mean(marks))))
    return comps


def perform(rng, cat_code, cat, rule, competitor, start_no, layout):
    discipline = cat["discipline"]
    elements, falls = [], 0
    if discipline == "singles":
        jump_positions = [i for i, p in enumerate(layout) if jump_parts(p)[0]]
        window = jump_positions[-1:] if rule.key == "SP" else jump_positions[-3:]
        error_budget = 1 if rng.random() < 0.55 - 0.4 * competitor.ability else 0
        error_at = rng.choice(jump_positions) if error_budget else None
        for i, planned in enumerate(layout):
            el, fell = singles_element(rng, planned, competitor.ability, i in window, i == error_at)
            falls += fell
            elements.append(el)
    elif discipline == "synchro":
        novice = cat_code.endswith("ADVNOV")
        for planned in layout:
            if planned == "NHE":
                elements.append(synchro_nhe(rng, rule.key, competitor.ability, novice))
            else:
                elements.append(synchro_element(rng, planned, competitor.ability))
    else:
        for planned in layout:
            elements.append(dance_element(rng, planned, competitor.ability))
    lo, hi = PCS_RANGE_NOVICE if cat_code.endswith("ADVNOV") else PCS_RANGE[discipline]
    comps = pcs_marks(rng, competitor.ability, lo, hi)
    perf = Performance(competitor, start_no, elements, comps, rule.factor, falls,
                       music=rng.choice(MUSIC))
    perf.tes = sum((e.score for e in elements), D(0))
    perf.pcs = sum((r2(avg * rule.factor) for _n, _m, avg in comps), D(0))
    perf.deductions = D(-falls)
    perf.total = perf.tes + perf.pcs + perf.deductions
    return perf


# ── the competition model ─────────────────────────────────────────────────────

@dataclass
class Segment:
    cat_code: str
    rule: SegmentRule
    day: date
    panel: dict = field(default_factory=dict)        # role label -> Person
    performances: list = field(default_factory=list)  # in start order
    rows: list = field(default_factory=list)          # start-list rows
    start: int = 0                                     # seconds from midnight
    end: int = 0

    @property
    def prefix(self) -> str:
        return f"{self.cat_code:-<22}{self.rule.phase}--"

    @property
    def title(self) -> str:  # line 2 of the sheets
        return f"{CATEGORIES[self.cat_code]['name']} {self.rule.name}".upper()

    @property
    def printed_results(self) -> datetime:
        return datetime.combine(self.day, datetime.min.time()) + timedelta(seconds=self.end + 600)


@dataclass
class Category:
    code: str
    info: dict
    competitors: list
    segments: list

    @property
    def prefix(self) -> str:
        return f"{self.code:-<34}"

    @property
    def name(self) -> str:
        return self.info["name"]


PANEL_ROLES = (["Referee"] + [f"Judge No. {i}" for i in range(1, 10)]
               + ["Technical Controller", "Technical Specialist 1", "Technical Specialist 2",
                  "Data Operator", "Replay Operator"])


def build_competition():
    rng = random.Random(SEED)
    people = People(rng)
    clubs = {abbr: (name, nation) for abbr, name, nation in CLUBS}

    official_families = set()
    officials = []
    for i in range(30):
        p = people.new("F" if i % 3 else "M", official_families)
        p.nation = OFFICIAL_NATIONS[i % len(OFFICIAL_NATIONS)]
        officials.append(p)

    categories = {}
    for code, info in CATEGORIES.items():
        competitors = []
        abilities = sorted((rng.random() for _ in range(info["entries"])), reverse=True)
        if info["discipline"] == "synchro":
            for (club, team), ability in zip(SYNCHRO_TEAMS[code], abilities):
                members = []
                for _ in range(20):  # 16 on the ice + 4 alternates
                    m = people.new("F" if rng.random() < 0.94 else "M")
                    m.club, m.nation = club, clubs[club][1]
                    members.append(m)
                competitors.append(Competitor(team, club, ability, members, team_code=people.code(4)))
        elif info["discipline"] == "dance":
            for ability in abilities:
                club = rng.choice(CLUBS)[0]
                woman, man = people.new("F"), people.new("M")
                for m in (woman, man):
                    m.club, m.nation = club, clubs[club][1]
                competitors.append(Competitor(f"{woman.name} / {man.name}", club, ability, [woman, man]))
        else:
            for ability in abilities:
                club = rng.choice(CLUBS)[0]
                p = people.new(info["gender"])
                p.club, p.nation = club, clubs[club][1]
                competitors.append(Competitor(p.name, club, ability, [p]))
        rng.shuffle(competitors)
        segments = []
        for rule in info["segments"]:
            day = next(d for d, order in RUNNING_ORDER.items() if (code, rule.key) in order)
            segments.append(Segment(code, rule, day))
        categories[code] = Category(code, info, competitors, segments)

    # Panels: one referee and technical controller per category, the rest drawn
    # per segment from the officials' pool (people judge several segments a day).
    for cat in categories.values():
        referee, controller = rng.sample(officials, 2)
        for seg in cat.segments:
            others = rng.sample([o for o in officials if o not in (referee, controller)], 13)
            panel = [referee] + others[:9] + [controller] + others[9:]
            seg.panel = dict(zip(PANEL_ROLES, panel))

    # Start orders, performances, ranks
    for cat in categories.values():
        info = cat.info
        layouts = {}
        for seg in cat.segments:
            rule = seg.rule
            if seg is cat.segments[0]:
                order = list(cat.competitors)
                rng.shuffle(order)
            else:
                prev = cat.segments[0].rule.key
                order = sorted(cat.competitors, key=lambda c: c.performances[prev].rank, reverse=True)
            for no, comp in enumerate(order, 1):
                if info["discipline"] == "singles":
                    pool = (SINGLES_SP if rule.key == "SP" else SINGLES_FS)[info["gender"]]
                    key = (comp.name, rule.key)
                    layouts[key] = pool[rng.randrange(len(pool))]
                    layout = layouts[key]
                elif info["discipline"] == "synchro":
                    layout = list(SYNCHRO_LAYOUTS[(cat.code, rule.key)])
                    rng.shuffle(layout)
                else:
                    pool = DANCE_LAYOUTS[rule.key]
                    layout = pool[rng.randrange(len(pool))]
                perf = perform(rng, cat.code, info, rule, comp, no, layout)
                comp.performances[rule.key] = perf
                seg.performances.append(perf)
            ranked = sorted(seg.performances, key=lambda p: (-p.total, -p.tes))
            for place, perf in enumerate(ranked, 1):
                perf.rank = place
        for comp in cat.competitors:
            comp.total = sum((p.total for p in comp.performances.values()), D(0))
        last = cat.segments[-1].rule.key
        for place, comp in enumerate(sorted(cat.competitors,
                                            key=lambda c: (-c.total, -c.performances[last].total)), 1):
            comp.rank = place

    schedule(categories)
    return categories, officials


def schedule(categories):
    """Start times: warm-up groups, skating slots, resurfacing, one segment after another."""
    by_key = {(c.code, s.rule.key): s for c in categories.values() for s in c.segments}
    for day, order in RUNNING_ORDER.items():
        clock = DAY_START[day][0] * 3600 + DAY_START[day][1] * 60
        for key in order:
            seg = by_key[key]
            cat = categories[seg.cat_code]
            rule = seg.rule
            groups = cat.info["groups"]
            seg.start = clock
            seg.rows = []
            perfs = list(seg.performances)
            slot = rule.perf + rule.intro + rule.judging
            for g, size in enumerate(groups):
                if g:
                    seg.rows.append(("resurfacing", clock, clock + rule.resurfacing, None))
                    clock += rule.resurfacing
                if rule.warmup:
                    seg.rows.append(("warmup", clock, clock + rule.warmup, g + 1))
                    clock += rule.warmup + 30
                for perf in perfs[:size]:
                    seg.rows.append(("skater", clock, clock + slot, perf))
                    clock += slot
                perfs = perfs[size:]
            seg.end = clock
            clock += 900
            clock = -(-clock // 300) * 300  # next five minutes


def segment_order(categories, datasets):
    """Segments of the selected datasets in running order, with their day."""
    by_key = {(c.code, s.rule.key): s for c in categories.values() for s in c.segments}
    out = []
    for day, order in RUNNING_ORDER.items():
        for key in order:
            seg = by_key[key]
            if CATEGORIES[seg.cat_code]["dataset"] in datasets:
                out.append(seg)
    return out


# ── PDF drawing ───────────────────────────────────────────────────────────────

ASCENT = 0.905  # Arial/Helvetica ascender: y below is the top of the glyph box


class Pdf:
    def __init__(self):
        self.buf = io.BytesIO()
        self.c = canvas.Canvas(self.buf, pagesize=(PAGE_W, PAGE_H), invariant=1, pageCompression=1)
        self.c.setCreator("figureskatingtools.com sample data (FS Manager layout)")
        self.c.setAuthor("")
        self.c.setLineWidth(0.57)

    def text(self, x, y, s, size=8.7, bold=False, align="l"):
        if s is None or s == "":
            return
        self.c.setFont("Helvetica-Bold" if bold else "Helvetica", size)
        base = PAGE_H - y - size * ASCENT
        if align == "r":
            self.c.drawRightString(x, base, s)
        elif align == "c":
            self.c.drawCentredString(x, base, s)
        else:
            self.c.drawString(x, base, s)

    def hline(self, x0, x1, y, w=0.57):
        self.c.setLineWidth(w)
        self.c.line(x0, PAGE_H - y, x1, PAGE_H - y)

    def vline(self, x, y0, y1, w=0.57):
        self.c.setLineWidth(w)
        self.c.line(x, PAGE_H - y0, x, PAGE_H - y1)

    def rect(self, x0, y0, x1, y1, w=0.57, grey=None):
        self.c.setLineWidth(w)
        if grey is not None:
            self.c.setFillGray(grey)
        self.c.rect(x0, PAGE_H - y1, x1 - x0, y1 - y0, stroke=1, fill=1 if grey is not None else 0)
        self.c.setFillGray(0)

    def width(self, s, size, bold=False):
        return stringWidth(s, "Helvetica-Bold" if bold else "Helvetica", size)

    def page(self):
        self.c.showPage()

    def bytes(self) -> bytes:
        self.c.save()
        return self.buf.getvalue()


def header(pdf, title, subtitle, printed):
    """The standard FSM report header: title, segment line, then the printed stamp."""
    pdf.text(23.0, 70.9, title, 11.8, True)
    pdf.text(23.0, 88.7, subtitle, 11.8, True)
    pdf.text(22.7, 739.6, f"printed:   {stamp(printed)}", 7.7)


def page_no(pdf, n, total, y=740.6):
    pdf.text(572.6, y, f"Page {n} / {total}", 5.7, align="r")


def official_line(person):
    return f"{person.titled}, {person.nation}"


# ── per-segment documents ─────────────────────────────────────────────────────

CRITERIA = {
    "Composition": ["Multidimensional movements|/ use of space", "Connections between the|elements",
                    "Choreography reflecting|musical phrase and form", "Pattern / ice coverage", "Unity"],
    "Presentation": ["Expressiveness & projection", "Variety and contrast of|energy / of movements",
                     "Musical sensitivity and|timing", "Oneness and spatial|awareness"],
    "Skating skills": ["Variety of edges, steps,|turns, movements, directions",
                       "Clarity of edges, steps, turns,|movements and body control",
                       "Balance and glide", "Flow", "Power of speed", "Unison"],
}


def pcs_block(pdf, top, name, criteria):
    height = 25.5 + 19.0 * len(criteria)
    pdf.rect(22.7, top, 572.6, top + height, 1.13)
    pdf.rect(473.4, top, 572.6, top + 25.5, grey=0.863)
    pdf.hline(22.7, 572.6, top + 25.5)
    for i in range(1, len(criteria)):
        pdf.hline(22.7, 374.5, top + 25.5 + 19.0 * i)
    for x in (113.4, 165.5, 217.7, 269.9, 322.0, 374.5):
        pdf.vline(x, top, top + height)
    pdf.text(42.8, top + 7.85, name, 8.7, True)
    for x, y, s in ((119.7, 5.15, "V poor - Poor"), (124.6, 17.75, "0,25 - 2,75"),
                    (171.5, 1.75, "Weak - Below"), (179.3, 8.55, "Average"), (181.0, 17.75, "3 - 4,75"),
                    (224.5, 1.75, "Average - Ab"), (239.8, 8.55, "Av"), (233.2, 17.75, "5 - 6,75"),
                    (274.5, 5.15, "Good - V good"), (285.4, 17.75, "7 - 8,75"),
                    (332.6, 1.75, "Excellent -"), (329.9, 8.55, "Outstanding"), (340.3, 17.75, "9 - 10")):
        pdf.text(x, top + y, s, 6.2, True)
    pdf.text(377.3, top + 3.55, "Notes", 8.7, True)
    pdf.text(476.2, top + 3.55, "Score", 8.7, True)
    for i, crit in enumerate(criteria):
        lines = crit.split("|")
        y = top + 25.5 + 19.0 * i + (2.5 if len(lines) == 2 else 6.0)
        for j, line in enumerate(lines):
            pdf.text(25.5, y + 6.8 * j, line, 6.2, True)
    return top + height


def judges_sheet_all(seg, cat):
    pdf = Pdf()
    roles = ["Referee"] + [f"Judge No. {i}" for i in range(1, 10)]
    for role in roles:
        official = seg.panel[role]
        for perf in seg.performances:
            comp = perf.competitor
            pdf.text(25.5, 14.7, COMPETITION_NAME, 11.8, True)
            pdf.text(25.5, 29.2, seg.title, 11.8, True)
            pdf.text(25.5, 45.4, role, 8.7, True)
            pdf.text(168.4, 45.4, official.titled, 8.7, True)
            pdf.hline(165.5, 572.6, 54.7)
            pdf.hline(22.7, 572.6, 57.5)
            pdf.text(48.2, 58.1, str(perf.start_no), 11.8, True, "r")
            pdf.text(113.4, 58.1, comp.name, 11.8, True)
            pdf.text(536.6, 58.1, comp.club, 11.8, True)
            pdf.hline(22.7, 572.6, 72.0)
            pdf.text(25.5, 72.7, "Music:", 11.8, True)
            pdf.text(113.4, 72.7, perf.music, 11.8, True)
            pdf.rect(22.7, 89.6, 572.6, 389.5)
            for x in (125.0, 153.1, 278.1, 343.3):
                pdf.vline(x, 89.6, 389.5)
            for i in range(13):
                pdf.hline(22.7, 572.6, 113.95 + 22.96 * i)
            pdf.text(37.1, 96.9, "Notes/Transitions", 8.7, True)
            pdf.text(136.6, 96.9, "#", 8.7, True)
            pdf.text(159.9, 96.9, "Planned/Executed Element", 8.7, True)
            pdf.text(301.0, 96.9, "GOE", 8.7, True)
            pdf.text(421.1, 96.9, "Notes/Transitions", 8.7, True)
            for i in range(12):
                y = 120.5 + 22.96 * i
                pdf.text(141.5 if i < 9 else 143.9, y, str(i + 1), 8.7, True, "r")
                if i < len(perf.elements):
                    pdf.text(155.9, y, perf.elements[i].planned, 8.7)
            top = 398.55
            for name, crits in CRITERIA.items():
                top = pcs_block(pdf, top, name, crits)
            pdf.text(25.5, 763.1, "Deductions by", 8.7, True)
            pdf.text(25.5, 772.7, "majority", 8.7, True)
            pdf.text(116.2, 769.2, "[]", 6.2, True)
            pdf.text(127.3, 767.8, "Costume/Prop violation", 8.7, True)
            pdf.text(25.5, 793.3, "PC restrictions", 8.7, True)
            pdf.text(116.2, 786.9, "1 serious error: maximum score 9.50", 8.7, True)
            pdf.text(116.2, 799.7, "2 or more serious errors: maximum score 8.75", 8.7, True)
            pdf.rect(22.7, 760.0, 572.6, 784.0)
            pdf.rect(22.7, 784.0, 572.6, 812.0)
            pdf.vline(113.4, 760.0, 812.0)
            pdf.text(243.8, 818.4, "Signature:", 10.8)
            pdf.hline(297.0, 380.0, 829.0)
            pdf.text(25.5, 821.5, f"printed at {stamp(PAPERS_PRINTED)}", 6.7)
            pdf.page()
    return pdf.bytes()


def start_list(seg, cat, first_segment):
    pdf = Pdf()
    header(pdf, "TIME SCHEDULE", seg.title, PAPERS_PRINTED)
    pdf.text(26.1, 115.2, seg.day.strftime("%A, %d %B %Y").upper(), 11.8, True)
    ranked = not first_segment
    if ranked:
        nation_x, num_r, name_x = 434.8, 139.7, 157.9
        pdf.text(nation_x, 116.5, "Nation", 9.8, True)
        pdf.text(511.4, 110.3, "Current", 9.8, True)
        pdf.text(493.9, 122.5, "Rank", 9.8, True)
        pdf.text(539.2, 122.5, "Points", 9.8, True)
    else:
        nation_x, num_r, name_x = 526.7, 149.1, 167.2
        pdf.text(nation_x, 116.5, "Nation", 9.8, True)
    y = 138.3
    prev_key = cat.segments[0].rule.key
    for kind, t0, t1, item in seg.rows:
        pdf.text(25.9, y, f"{hms(t0)} - {hms(t1)}", 9.8)
        if kind == "skater":
            perf = item
            pdf.text(num_r, y, str(perf.start_no), 9.8, align="r")
            if ranked:
                before = perf.competitor.performances[prev_key]
                pdf.text(517.9, y, str(before.rank), 9.8, align="r")
                pdf.text(569.2, y, f2(before.total), 9.8, align="r")
            pdf.text(name_x, y, perf.competitor.name, 9.8)
            pdf.text(nation_x, y, perf.competitor.club, 9.8)
        elif kind == "warmup":
            pdf.text(name_x, y, f"Warm-Up Group {item}", 9.8, True)
        else:
            pdf.text(name_x, y, "Ice Resurfacing", 9.8, True)
        y += 13.9
    rule = seg.rule
    params = [f"Resurfacing: {ms(rule.resurfacing)}", f"Warm-Up: {ms(rule.warmup)}",
              f"Duration of Skating: {ms(rule.perf)} +/-10 seconds", f"Introduction: {ms(rule.intro)}",
              f"Judging First: {ms(rule.judging)}", f"Judging Last: {ms(rule.judging)}"]
    pdf.text(25.9, y, "    ".join(params), 7.7)
    page_no(pdf, 1, 1)
    return pdf.bytes()


def panel_pdf(seg):
    pdf = Pdf()
    header(pdf, "PANEL OF JUDGES", seg.title, PAPERS_PRINTED)
    p = seg.panel

    def row(y, label, person, bold_label=False):
        pdf.text(26.1, y, label, 9.8, bold_label)
        pdf.text(184.0, y, person.titled, 9.8)
        pdf.text(481.9, y, person.nation, 9.8)

    pdf.text(26.1, 110.3, "Officials", 11.8, True)
    row(132.7, "Technical Controller", p["Technical Controller"])
    row(155.1, "Technical Specialist", p["Technical Specialist 1"])
    row(177.7, "Technical Specialist", p["Technical Specialist 2"])
    pdf.text(26.1, 217.4, "Judges", 11.8, True)
    row(239.8, "Referee", p["Referee"], True)
    y = 284.7
    for i in range(1, 10):
        row(y, f"Judge No. {i}", p[f"Judge No. {i}"], True)
        y += 22.45
    y += 17.8
    pdf.text(26.1, y, "Data/Replay Operator", 11.8, True)
    row(y + 22.4, "Data Operator", p["Data Operator"], True)
    row(y + 44.9, "Replay Operator", p["Replay Operator"], True)
    page_no(pdf, 1, 1)
    return pdf.bytes()


def referee_sheet(seg):
    pdf = Pdf()
    ref = seg.panel["Referee"]
    pdf.text(26.1, 14.7, COMPETITION_NAME, 10.8, True)
    pdf.text(26.1, 28.1, f"{seg.title} - REFEREE SHEET", 10.8, True)
    pdf.text(26.1, 54.8, "Referee", 10.8, True)
    pdf.text(361.5, 41.4, "Deductions", 10.8, True)
    pdf.text(26.1, 81.6, f"{ref.titled}  {ref.nation}", 10.8, True)
    columns = [(232.3, ["Time", "violation"], ["0 -1 -2 -3 -4", "-5 -6"]),
               (279.3, ["Interruption", "in excess"], ["0 -1 -2 -3 -4", "-5 -6"]),
               (326.8, ["Interruption", "with", "allowance"], ["0 -5"]),
               (373.9, ["Costume", "failure"], ["0 -1"]),
               (421.0, ["Late start"], ["0 -1"])]
    for cx, labels, values in columns:
        for i, s in enumerate(labels):
            pdf.text(cx, 54.1 + 8.5 * i, s, 7.7, True, "c")
        for i, s in enumerate(values):
            pdf.text(cx, (99.2 if len(values) == 2 else 103.5) + 8.5 * i, s, 7.7, True, "c")
    pdf.text(569.2, 81.6, "Total", 10.8, True, "r")
    pdf.text(30.6, 121.9, "#  Name", 10.8, True)
    pdf.text(173.5, 121.9, "Nation", 10.8, True)
    for i in range(7):
        pdf.text(211.2 + 47.1 * i, 123.6, "Remarks", 7.7)
        pdf.text(248.9 + 47.1 * i, 123.6, "-", 7.7)
    for x in (208.8, 255.9, 302.9, 350.0, 397.1, 444.2, 491.3, 538.4):
        pdf.vline(x, 50.0, 137.0 + 26.65 * len(seg.performances))
    y = 144.7
    pdf.hline(26.1, 572.6, 137.0)
    for perf in seg.performances:
        pdf.text(30.6, y, f"{perf.start_no}  {perf.competitor.name}", 10.8)
        pdf.text(173.5, y, perf.competitor.club, 9.0)
        pdf.hline(26.1, 572.6, y + 19.6)
        y += 26.65
    pdf.text(569.2, y, "printed at", 6.7, align="r")
    pdf.text(569.2, y + 7.4, stamp(PAPERS_PRINTED), 6.7, align="r")
    return pdf.bytes()


def planned_program_content(seg, cat, first_segment):
    """Blocks of planned elements, several competitors per page."""
    blocks = []
    for perf in seg.performances:
        rows = (len(perf.elements) + 1) // 2
        blocks.append((perf, 55.8 + 11.1 * rows + 14.0))
    pages, current, y = [], [], 110.3
    for perf, height in blocks:
        if y + height > 725 and current:
            pages.append(current)
            current, y = [], 110.3
        current.append((perf, y))
        y += height
    pages.append(current)
    pdf = Pdf()
    prev_key = cat.segments[0].rule.key
    for n, page in enumerate(pages, 1):
        header(pdf, "PLANNED PROGRAM CONTENT", seg.title, PAPERS_PRINTED)
        for perf, y in page:
            comp = perf.competitor
            pdf.text(40.3, y, str(perf.start_no), 8.7, True, "r")
            pdf.text(47.1, y, comp.name, 8.7, True)
            pdf.text(347.0, y, comp.club, 8.7, True)
            if not first_segment:
                pdf.text(430.0, y, "Rank after " + cat.segments[0].rule.key, 8.7, True)
                pdf.text(569.2, y, str(comp.performances[prev_key].rank), 8.7, True, "r")
            pdf.text(47.1, y + 11.1, "Coach:", 8.7)
            pdf.text(47.1, y + 22.3, "Music:", 8.7)
            pdf.text(124.7, y + 22.3, perf.music, 8.7)
            for x in (35.4, 311.5):
                pdf.text(x, y + 39.1, "#  Name", 8.7, True)
            pdf.text(124.7, y + 39.1, "Description", 8.7, True)
            pdf.text(399.1, y + 39.1, "Description", 8.7, True)
            rows = (len(perf.elements) + 1) // 2
            for i, el in enumerate(perf.elements):
                col, r = divmod(i, rows)
                xn, xc, xd = (40.3, 47.1, 124.7) if col == 0 else (316.3, 323.1, 399.1)
                yy = y + 55.8 + 11.1 * r
                pdf.text(xn, yy, str(i + 1), 8.7, align="r")
                pdf.text(xc, yy, el.planned, 8.7)
                pdf.text(xd, yy, describe(el.planned), 8.7)
        page_no(pdf, n, len(pages))
        pdf.page()
    return pdf.bytes()


def technical_sheet(seg, role, title):
    pdf = Pdf()
    person = seg.panel[role]
    label = "Technical Controller:" if role == "Technical Controller" else "Technical Specialist:"
    total = len(seg.performances)
    for n, perf in enumerate(seg.performances, 1):
        comp = perf.competitor
        pdf.text(26.1, 14.7, COMPETITION_NAME, 11.8, True)
        pdf.text(26.1, 29.2, f"{title} - {seg.title}", 11.8, True)
        pdf.text(26.1, 58.1, f"{label}   {person.titled}", 11.8, True)
        pdf.text(519.0, 58.1, person.nation, 11.8, True)
        pdf.text(26.1, 76.4, str(perf.start_no), 11.8, True)
        pdf.text(54.1, 76.4, comp.name, 11.8, True)
        pdf.text(519.0, 76.4, comp.club, 11.8, True)
        pdf.text(35.7, 101.7, "No  Planned Element", 8.7, True)
        pdf.text(185.7, 96.9, "Executed Element", 8.7, True)
        pdf.text(185.7, 106.6, "Level", 8.7, True)
        pdf.text(281.5, 101.7, "Comments", 8.7, True)
        pdf.text(451.0, 101.8, "Falls", 8.7, True)
        pdf.text(481.2, 101.8, "Review", 8.7, True)
        pdf.text(521.8, 101.8, "Bonus, etc", 8.7, True)
        pdf.rect(26.1, 92.0, 572.6, 597.0)
        for x in (52.0, 181.0, 277.0, 446.0, 477.0, 517.0):
            pdf.vline(x, 92.0, 597.0)
        for i in range(14):
            y = 137.3 + 34.0 * i
            pdf.hline(26.1, 572.6, y - 15.0)
            pdf.text(47.3, y, f"{i + 1}.", 10.8, align="r")
            if i < len(perf.elements):
                pdf.text(54.1, y, perf.elements[i].planned, 10.8)
        pdf.text(26.1, 602.6, "Illegal elements", 8.7, True)
        pdf.text(185.7, 602.6, "Total Bonus points", 8.7, True)
        pdf.text(281.5, 602.6, "Falls IN", 8.7, True)
        pdf.text(370.5, 602.6, "Falls OUT", 8.7, True)
        pdf.text(480.2, 602.6, "Other Deductions", 8.7, True)
        pdf.rect(26.1, 598.0, 572.6, 650.0)
        pdf.text(26.1, 659.3, "Comments", 10.8, True)
        pdf.text(427.5, 710.4, "Signature", 10.8)
        pdf.hline(380.0, 572.6, 708.0)
        pdf.text(26.1, 797.3, f"printed:   {stamp(PAPERS_PRINTED)}", 8.7)
        page_no(pdf, n, total, 814.3)
        pdf.page()
    return pdf.bytes()


def signatures(pdf, y, seg):
    pdf.text(45.9, y, official_line(seg.panel["Referee"]), 10.8, True)
    pdf.text(317.5, y, official_line(seg.panel["Technical Controller"]), 10.8, True)
    pdf.text(45.9, y + 11.0, "Referee", 10.8)
    pdf.text(317.5, y + 11.0, "Technical Controller", 10.8)


def segment_results(seg):
    pdf = Pdf()
    header(pdf, "RESULTS", seg.title, seg.printed_results)
    pdf.text(56.0, 116.9, "Pl.  Name", 10.8, True)
    pdf.text(370.2, 117.1, "Nation", 10.8, True)
    pdf.text(511.9, 111.1, "Total Segment", 10.8, True, "r")
    pdf.text(511.9, 123.0, "Score", 10.8, True, "r")
    y = 139.8
    for perf in sorted(seg.performances, key=lambda p: p.rank):
        pdf.text(69.2, y, str(perf.rank), 8.7, align="r")
        pdf.text(76.0, y, perf.competitor.name, 8.7)
        pdf.text(370.2, y, perf.competitor.club, 8.7)
        pdf.text(511.9, y, f2(perf.total), 8.7, align="r")
        y += 11.05
    signatures(pdf, y + 50.0, seg)
    page_no(pdf, 1, 1)
    return pdf.bytes()


def judges_details(seg):
    """JUDGES DETAILS PER SKATER: one block per competitor in rank order."""
    perfs = sorted(seg.performances, key=lambda p: p.rank)
    discipline = CATEGORIES[seg.cat_code]["discipline"]
    legend = ["#  Sequence number      GOE  Grade of Execution      Jx  Judges (x=1-9)      Ref.  Referee"]
    if discipline == "singles":
        legend += ["*  Invalid element      <  Under-rotated jump      <<  Downgraded jump",
                   "x  Credit for highlight distribution, base value multiplied by 1.1      F  Fall",
                   "q  Jump landed on the quarter"]
    else:
        legend += ["F  Fall      D  Deduction applied"]
    legend_h = 12.0 + 9.0 * len(legend)

    def block_height(perf):
        return 60.0 + 8.22 * (len(perf.elements) + 1) + 17.5 + 8.2 * 4 + 12.0 + 18.0

    pages, current, y = [], [], 112.0
    for i, perf in enumerate(perfs):
        h = block_height(perf)
        limit = 735.0 - (legend_h if i == len(perfs) - 1 else 0)
        if y + h > limit and current:
            pages.append(current)
            current, y = [], 112.0
        current.append((perf, y))
        y += h
    pages.append(current)

    jx = [274.7 + 25.7 * k for k in range(9)]
    pdf = Pdf()
    for n, page in enumerate(pages, 1):
        header(pdf, "JUDGES DETAILS PER SKATER", seg.title, seg.printed_results)
        for perf, top in page:
            comp = perf.competitor
            b = 6.7
            pdf.text(39.1, top + 7.3, "Rank", b, True)
            pdf.text(62.4, top + 7.3, "Name", b, True)
            pdf.text(266.7, top + 7.3, "Nation", b, True)
            pdf.text(325.5, top + 3.7, "Starting", b, True)
            pdf.text(325.5, top + 11.0, "Number", b, True)
            for right, lines in ((400.5, ["Total", "Segment", "Score"]),
                                 (450.1, ["Total", "Element", "Score"]),
                                 (512.8, ["Total Program", "Component", "Score (factored)"])):
                for k, s in enumerate(lines):
                    pdf.text(right, top + 7.3 * k, s, b, True, "r")
            pdf.text(569.2, top + 3.7, "Total", b, True, "r")
            pdf.text(569.2, top + 11.0, "Deductions", b, True, "r")
            y = top + 27.8
            pdf.text(55.6, y, str(perf.rank), b, True, "r")
            pdf.text(62.4, y, comp.name, b, True)
            pdf.text(266.7, y, comp.club, b, True)
            pdf.text(350.9, y, str(perf.start_no), b, True, "r")
            pdf.text(400.5, y, f2(perf.total), b, True, "r")
            pdf.text(450.1, y, f2(perf.tes), b, True, "r")
            pdf.text(512.8, y, f2(perf.pcs), b, True, "r")
            pdf.text(569.2, y, f2(perf.deductions), b, True, "r")
            y = top + 43.9
            pdf.text(35.1, y, "#", b, True)
            pdf.text(45.1, y, "Executed Elements", b, True)
            pdf.text(127.1, y - 1.8, "Info", b, True)
            pdf.text(201.3, y - 3.7, "Base", b, True)
            pdf.text(201.3, y + 3.7, "Value", b, True)
            pdf.text(233.9, y, "GOE", b, True)
            for k, x in enumerate(jx):
                pdf.text(x, y, f"J{k + 1}", b, True, "r")
            pdf.text(519.3, y, "Ref.", b, True)
            pdf.text(569.5, y - 3.7, "Scores of", b, True, "r")
            pdf.text(569.5, y + 3.7, "Panel", b, True, "r")
            y = top + 59.8
            for i, el in enumerate(perf.elements, 1):
                pdf.text(38.8, y, str(i), b, align="r")
                pdf.text(45.1, y, el.code, b)
                pdf.text(140.9, y, el.info, b)
                pdf.text(219.1, y, f2(el.bv), b, align="r")
                if el.x:
                    pdf.text(225.4, y, "x", b)
                pdf.text(248.9, y, f2(el.goe), b, align="r")
                for g, x in zip(el.grades, jx):
                    pdf.text(x, y, str(g), b, align="r")
                pdf.text(569.5, y, f2(el.score), b, align="r")
                y += 8.22
            pdf.text(219.1, y, f2(sum((e.bv for e in perf.elements), D(0))), b, True, "r")
            pdf.text(569.5, y, f2(perf.tes), b, True, "r")
            y += 17.5
            pdf.text(45.1, y, "Program Components", b, True)
            pdf.text(248.9, y, "Factor", b, True, "r")
            y += 11.5
            for name, marks, avg in perf.components:
                pdf.text(45.1, y, name, b)
                pdf.text(248.9, y, f2(perf.factor), b, align="r")
                for m, x in zip(marks, jx):
                    pdf.text(x, y, f2(m), b, align="r")
                pdf.text(569.5, y, f2(avg), b, align="r")
                y += 8.2
            pdf.text(45.1, y, "Judges Total Program Component Score (factored)", b, True)
            pdf.text(569.5, y, f2(perf.pcs), b, True, "r")
            y += 11.1
            pdf.text(48.2, y, "Deductions:", b, True)
            if perf.falls:
                pdf.text(103.0, y, "Falls", b, True)
                pdf.text(250.0, y, f"{f2(-perf.falls)}   ({perf.falls})", b, True, "r")
            pdf.text(569.8, y, f2(perf.deductions), b, True, "r")
            pdf.rect(22.7, top - 4.0, 572.6, top + 37.5)
            pdf.hline(22.7, 572.6, top + 26.0, 0.3)
            pdf.rect(22.7, top + 37.5, 572.6, y - 2.0)
            pdf.rect(22.7, y - 2.0, 572.6, y + 8.5)
        if n == len(pages):
            ly = 735.0 - legend_h
            pdf.text(26.1, ly, "Legend:", 7.7, True)
            for k, line in enumerate(legend):
                pdf.text(26.1, ly + 11.0 + 9.0 * k, line, 6.7)
        page_no(pdf, n, len(pages))
        pdf.page()
    return pdf.bytes()


# ── per-category documents ────────────────────────────────────────────────────

def results(cat):
    last = cat.segments[-1]
    pdf = Pdf()
    header(pdf, "RESULTS", cat.name.upper(), last.printed_results + timedelta(minutes=5))
    pdf.text(55.1, 116.9, "Pl.  Name", 10.8, True)
    pdf.text(435.4, 117.1, "Nation", 10.8, True)
    pdf.text(506.0, 111.1, "Total", 10.8, True, "r")
    pdf.text(506.0, 123.0, "Score", 10.8, True, "r")
    keys = [s.rule.key for s in cat.segments]
    rights = [537.4, 569.2][-len(keys):]
    for key, right in zip(keys, rights):
        pdf.text(right, 117.1, key, 10.8, True, "r")
    y = 139.8
    for comp in sorted(cat.competitors, key=lambda c: c.rank):
        pdf.text(68.3, y, str(comp.rank), 8.7, align="r")
        pdf.text(75.1, y, comp.name, 8.7)
        pdf.text(435.4, y, comp.club, 8.7)
        pdf.text(506.0, y, f2(comp.total), 8.7, align="r")
        for key, right in zip(keys, rights):
            pdf.text(right, y, str(comp.performances[key].rank), 8.7, align="r")
        y += 11.05
    signatures(pdf, y + 50.0, last)
    y += 95.0
    pdf.text(26.1, y, "Legend:", 8.7, True)
    legend = [(k, s.rule.name) for k, s in zip(keys, cat.segments)] + [("Pl.", "Place")]
    for i, (k, s) in enumerate(legend):
        pdf.text(26.1 + 175.0 * i, y + 11.0, k, 8.7)
        pdf.text(60.0 + 175.0 * i, y + 11.0, s, 8.7)
    page_no(pdf, 1, 1)
    return pdf.bytes()


def protocol_head_page(cat):
    last = cat.segments[-1]
    pdf = Pdf()
    pdf.text(23.0, 88.7, cat.name.upper(), 11.8, True)
    pdf.text(22.7, 739.6, f"printed:   {stamp(last.printed_results + timedelta(minutes=5))}", 7.7)
    pdf.text(26.1, 110.3, VENUE, 10.8, True)
    y = 110.3
    for seg in cat.segments:
        pdf.text(188.5, y, seg.day.strftime("%d %b %Y").upper(), 10.8)
        pdf.text(307.5, y, hms(seg.start)[:5], 10.8)
        pdf.text(396.9, y, seg.rule.name, 10.8)
        y += 13.3
    y = 150.2
    n = str(len(cat.competitors))
    for label, value in (("Size of Skating Arena:", "30m*60m"), ("Ice Conditions:", "very good"),
                         ("Number of Entries:", n), ("Number of Participants:", n)):
        pdf.text(26.1, y, label, 10.8)
        pdf.text(188.5, y, value, 10.8)
        y += 13.4
    pdf.text(26.1, y + 13.3, "Entry Withdrawn:", 10.8)
    y += 39.4
    for seg in cat.segments:
        rule = seg.rule
        pdf.text(26.1, y, rule.name, 11.8, True)
        pdf.text(26.1, y + 13.9, "Duration:", 10.8)
        pdf.text(188.5, y + 13.9, f"{ms(rule.perf)}  +/- 10 seconds", 10.8)
        pdf.text(26.1, y + 27.2, "Segment Factor:", 10.8)
        pdf.text(188.5, y + 27.2, "1.00", 10.8)
        pdf.text(26.1, y + 54.1, "Program Component Factors:", 10.8, True)
        for k, comp in enumerate(("Composition", "Presentation", "Skating Skills")):
            pdf.text(188.5, y + 54.1 + 13.4 * k, comp, 10.8)
            pdf.text(396.9, y + 54.1 + 13.4 * k, f2(rule.factor), 10.8)
        y += 107.2
    page_no(pdf, 1, 1)
    return pdf.bytes()


def calculation_setup(cat):
    info = cat.info
    pdf = Pdf()
    pdf.text(26.1, 14.2, "CALCULATION SETUP VERIFICATION FOR REFEREE", 12.6, True)
    pdf.text(26.1, 47.0, f"Category {info['name']}", 10.8, True)
    pdf.text(26.1, 64.4, "Event parameter", 8.7, True)
    left = [("Software Version", "2.0.6"), ("Elm Xml Version", "2627.2"), ("Sys Elm Xml Version", "2627.0")]
    right = [("Competition Type", "International Competition"), ("Calculation", "ISU Judging System"),
             ("Trimmed Mean", "Starts With 5 Judges"), ("Verification Rules Season", "2026-2027")]
    for i, (k, v) in enumerate(left):
        pdf.text(26.1, 78.3 + 13.45 * i, k, 7.7)
        pdf.text(193.6, 78.3 + 13.45 * i, v, 7.7, align="r")
    for i, (k, v) in enumerate(right):
        pdf.text(263.1, 78.3 + 13.45 * i, k, 7.7)
        pdf.text(390.3, 78.3 + 13.45 * i, v, 7.7)
    pdf.text(26.1, 131.6, "Category parameter", 8.7, True)
    ctype = {"singles": "Singles", "dance": "Ice Dance", "synchro": "Synchronized Skating"}[info["discipline"]]
    gender = {"F": "Woman", "M": "Man", "X": "Mixed"}[info["gender"]]
    level = "Advanced Novice" if cat.code.endswith("ADVNOV") else "Junior"
    pdf.text(26.1, 145.6, "Category type", 7.7)
    pdf.text(193.6, 145.6, ctype, 7.7, align="r")
    pdf.text(26.1, 159.1, "Gender", 7.7)
    pdf.text(193.6, 159.1, gender, 7.7, align="r")
    pdf.text(263.1, 145.6, "Level", 7.7)
    pdf.text(390.3, 145.6, level, 7.7)
    if info["discipline"] == "synchro":
        deductions = [("1:", "Costume/Prop violation", "Majority", "0 -1"),
                      ("2:", "Program time violation", "Referee", "0 -1 -2 -3 -4 -5 -6"),
                      ("4:", "Illegal element", "Technical Panel", "0 -2 -4 -6"),
                      ("5:", "Interruption in excess", "Referee", "0 -1 -2 -3 -4 -5 -6"),
                      ("7:", "Costume failure", "Referee", "0 -1"),
                      ("8:", "Falls", "Technical Panel", "-1 per Fall"),
                      ("17:", "Late start", "Referee", "0 -1")]
    else:
        deductions = [("1:", "Costume/Prop violation", "Majority", "0 -1"),
                      ("2:", "Time violation", "Referee", "0 -1 -2 -3 -4 -5 -6"),
                      ("4:", "Illegal element/movement", "Technical Panel", "0 -2 -4 -6"),
                      ("5:", "Falls", "Technical Panel", "-1 per Fall"),
                      ("6:", "Interruption in excess", "Referee", "0 -1 -2 -3 -4 -5 -6"),
                      ("7:", "Interruption with allowance", "Referee", "0 -5"),
                      ("10:", "Costume failure", "Referee", "0 -1"),
                      ("11:", "Late start", "Referee", "0 -1")]
    y = 170.6
    for seg in cat.segments:
        rule = seg.rule
        pdf.text(26.1, y, f"Segment {rule.name}", 10.8, True)
        pdf.text(263.1, y + 15.1, "checksum element table:", 7.7)
        pdf.text(390.3, y + 15.1, "sample-data-not-a-checksum", 7.7, True)
        credit = "1.10" if info["discipline"] == "singles" else "1.00"
        half = ms(rule.perf // 2) if info["discipline"] == "singles" else "0:00"
        rows = [("General segment factor", "1.00", "Program time", f"{ms(rule.perf)}    +/- 10 sec."),
                ("Credit for highlight distribution", credit, "Start time 2nd half of program", half),
                ("", "", "Verification Rules", "ISU Rules")]
        for i, (k1, v1, k2, v2) in enumerate(rows):
            pdf.text(26.1, y + 31.3 + 13.4 * i, k1, 7.7)
            pdf.text(193.6, y + 31.3 + 13.4 * i, v1, 7.7, align="r")
            pdf.text(263.1, y + 31.3 + 13.4 * i, k2, 7.7)
            pdf.text(390.3, y + 31.3 + 13.4 * i, v2, 7.7)
        yy = y + 71.5
        pdf.text(26.1, yy, "Program components:", 7.7, True)
        pdf.text(193.6, yy, "Factor", 7.7, align="r")
        pdf.text(263.1, yy, "Deductions:", 7.7, True)
        pdf.text(390.3, yy, "Entered By", 7.7)
        pdf.text(569.2, yy, "Values", 7.7, align="r")
        pdf.text(26.1, yy + 13.5, "General component factor", 7.7)
        pdf.text(193.6, yy + 13.5, "1.00", 7.7, align="r")
        for k, comp in enumerate(("Composition", "Presentation", "Skating Skills")):
            pdf.text(26.1, yy + 26.9 + 13.45 * k, f"{k + 1}:", 7.7)
            pdf.text(40.0, yy + 26.9 + 13.45 * k, comp, 7.7)
            pdf.text(193.6, yy + 26.9 + 13.45 * k, f2(rule.factor), 7.7, align="r")
        for k, (no, label, by, values) in enumerate(deductions):
            pdf.text(263.1, yy + 26.9 + 13.45 * k, no, 7.7)
            pdf.text(277.2, yy + 26.9 + 13.45 * k, label, 7.7)
            pdf.text(390.3, yy + 26.9 + 13.45 * k, by, 7.7)
            pdf.text(569.2, yy + 26.9 + 13.45 * k, values, 7.7, align="r")
        y = yy + 26.9 + 13.45 * len(deductions) + 14.0
    referee = cat.segments[0].panel["Referee"]
    pdf.text(26.1, 770.0, referee.titled, 8.7)
    pdf.text(26.1, 797.3, f"printed: {stamp(PAPERS_PRINTED)}", 7.7)
    pdf.text(200.0, 797.3, "Parameter available at: www.isuresults.com/setupverification.pdf", 7.7)
    page_no(pdf, 1, 1, 814.3)
    return pdf.bytes()


# ── per-competition documents ─────────────────────────────────────────────────

def competition_schedule(segments):
    pdf = Pdf()
    pdf.text(23.0, 70.9, "COMPETITION SCHEDULE", 11.8, True)
    pdf.text(22.7, 739.6, f"printed:   {stamp(PAPERS_PRINTED)}", 7.7)
    s = 7.7
    pdf.text(26.9, 118.2, "Date", s)
    pdf.text(72.3, 114.0, "Start", s)
    pdf.text(72.3, 122.5, "Time", s)
    pdf.text(107.1, 114.0, "Finish", s)
    pdf.text(107.1, 122.5, "Time", s)
    pdf.text(166.9, 114.0, "No. of", s, align="r")
    pdf.text(166.9, 122.5, "Entries", s, align="r")
    pdf.text(175.5, 118.2, "Category", s)
    pdf.text(330.0, 118.2, "Segment", s)
    pdf.text(423.8, 118.8, "Resurfacing", 6.7)
    pdf.text(465.2, 115.1, "Perfor-", 6.7)
    pdf.text(465.2, 122.5, "mance", 6.7)
    for x in (502.3, 539.4):
        pdf.text(x, 115.1, "Judging", 6.7)
    pdf.text(502.3, 122.5, "First", 6.7)
    pdf.text(539.4, 122.5, "Last", 6.7)
    pdf.hline(22.7, 572.6, 134.0)
    y = 144.4
    day = None
    for seg in segments:
        if seg.day != day:
            if day is not None:
                y += 11.0
            day = seg.day
            pdf.text(25.1, y, day.strftime("%d.%m.%Y"), s, True)
            y += 10.1
        rule = seg.rule
        pdf.text(68.6, y, hms(seg.start), s)
        pdf.text(103.7, y, hms(seg.end), s)
        pdf.text(167.0, y, str(len(seg.performances)), s, align="r")
        pdf.text(175.5, y, CATEGORIES[seg.cat_code]["name"], s, True)
        pdf.text(330.0, y, rule.name, s)
        for x, v in ((423.8, rule.resurfacing), (465.2, rule.perf), (502.3, rule.judging),
                     (539.4, rule.judging)):
            pdf.text(x, y + 0.6, hms(v), 6.7)
        y += 11.6
    page_no(pdf, 1, 1)
    return pdf.bytes()


# ── XML ───────────────────────────────────────────────────────────────────────

def odf_root(document_type, version, logical):
    created = PAPERS_PRINTED
    return (f'<OdfBody CompetitionCode={quoteattr(COMPETITION_CODE)} DocumentCode="{COMPETITION_PREFIX}" '
            f'DocumentType="{document_type}" Version="{version}" FeedFlag="P" '
            f'Date="{created:%Y-%m-%d}" Time="{created:%H%M%S}000" LogicalDate="{logical:%Y-%m-%d}" '
            f'Source="FSKFSK1">')


def iso(day, seconds):
    return f"{day:%Y-%m-%d}T{hms(seconds)}{UTC_OFFSET}"


def dt_schedule(segments):
    lines = ['<?xml version="1.0" encoding="utf-8"?>', odf_root("DT_SCHEDULE", 1, DAY1), "  <Competition>"]
    first, last = segments[0], segments[-1]
    names = " / ".join(f"{CATEGORIES[s.cat_code]['name']} {s.rule.name}" for s in segments)
    lines.append(f'    <Session SessionCode="FSK01" StartDate="{iso(first.day, first.start)}" '
                 f'EndDate="{iso(last.day, last.end)}" Venue="FSK" VenueName={quoteattr(VENUE)} Medal="3">')
    lines.append(f'      <SessionName Language="ENG" Value={quoteattr(names)} />')
    lines.append("    </Session>")
    for seg in segments:
        medal = ' Medal="1"' if seg is CATEGORY_LAST[seg.cat_code] else ""
        item = f"{CATEGORIES[seg.cat_code]['name']} {seg.rule.name}"
        lines.append(f'    <Unit Code="{seg.prefix}" PhaseType="3" ScheduleStatus="SCHEDULED" '
                     f'StartDate="{iso(seg.day, seg.start)}" EndDate="{iso(seg.day, seg.end)}"{medal} '
                     f'Venue="FSK" Location="FSR" SessionCode="FSK01">')
        lines.append(f'      <ItemName Language="ENG" Value={quoteattr(item)} />')
        lines.append(f'      <VenueDescription VenueName={quoteattr(VENUE)} LocationName={quoteattr(VENUE)} />')
        lines.append("    </Unit>")
    lines += ["  </Competition>", "</OdfBody>", ""]
    return "\n".join(lines).encode("utf-8")


def participant(p, function):
    family_upper = p.family.upper()
    initial = f"{p.given[0]}. {family_upper}"
    attrs = [("Code", p.code), ("Parent", p.code), ("Status", "ACTIVE"), ("GivenName", p.given),
             ("FamilyName", p.family), ("PrintName", p.name), ("PrintInitialName", initial),
             ("TVName", p.name), ("TVInitialName", initial), ("TVFamilyName", family_upper),
             ("PSCBLongName", p.name), ("PSCBName", initial), ("PSCBShortName", initial),
             ("Gender", p.gender), ("Organisation", p.club or p.nation), ("Nationality", p.nation),
             ("MainFunctionId", function)]
    head = " ".join(f"{k}={quoteattr(v)}" for k, v in attrs)
    return [f"    <Participant {head}>",
            f'      <Discipline Code="{COMPETITION_PREFIX}" IFId="{p.code}" />',
            "    </Participant>"]


def dt_partic(categories, officials, datasets):
    lines = ['<?xml version="1.0" encoding="utf-8"?>', odf_root("DT_PARTIC", 3, DAY1), "  <Competition>"]
    for cat in categories:
        for comp in cat.competitors:
            for m in comp.members:
                lines += participant(m, "AA01")
    used = []
    for cat in categories:
        for seg in cat.segments:
            for person in seg.panel.values():
                if person not in used:
                    used.append(person)
    for person in sorted(used, key=lambda o: o.code):
        lines += participant(person, "JU")
    lines += ["  </Competition>", "</OdfBody>", ""]
    return "\n".join(lines).encode("utf-8")


def dt_partic_teams(categories):
    lines = ['<?xml version="1.0" encoding="utf-8"?>', odf_root("DT_PARTIC_TEAMS", 1, DAY1), "  <Competition>"]
    for cat in categories:
        for order, comp in enumerate(cat.competitors, 1):
            name = quoteattr(comp.name)
            lines.append(f'    <Team Code="{comp.team_code}" Organisation="{comp.club}" Name={name} '
                         f'ShortName={name} TeamType="CUSTOM" TVTeamName={name} Gender="X" Status="ACTIVE">')
            lines.append("      <Composition>")
            for k, m in enumerate(comp.members, 1):
                lines.append(f'        <Athlete Code="{m.code}" Order="{k}" />')
            lines.append("      </Composition>")
            lines.append(f'      <Discipline Code="{COMPETITION_PREFIX}" IFId="{comp.team_code}">')
            lines.append(f'        <RegisteredEvent Event="{cat.prefix}" Class="ODF_EXTENDED">')
            lines.append(f'          <EventEntry Type="ER_EXTENDED" Code="ENTRY_ORDER" Pos="0" Value="{order}" />')
            lines.append("        </RegisteredEvent>")
            lines.append("      </Discipline>")
            lines.append("    </Team>")
    lines += ["  </Competition>", "</OdfBody>", ""]
    return "\n".join(lines).encode("utf-8")


# ── output ────────────────────────────────────────────────────────────────────

CATEGORY_LAST = {}

DESCRIPTIONS_TEXT = {
    "synchro": ("Junior synchronized skating (6 teams, short program and free skating) and "
                "Advanced Novice synchronized skating (5 teams, free skating): judges' sheets, "
                "panels, start lists, technical and referee sheets, results and judges' details, "
                "plus team rosters (DT_PARTIC, DT_PARTIC_TEAMS)."),
    "singles": ("Junior Women (8 skaters) and Junior Men (5 skaters), short program and free "
                "skating: judges' sheets, panels, start lists, technical and referee sheets, "
                "results and judges' details."),
    "icedance": ("Junior Ice Dance (5 couples), rhythm dance and free dance: judges' sheets, "
                 "panels, start lists, technical and referee sheets, results and judges' details."),
}


def dataset_files(categories, officials):
    """{dataset id: {file name: bytes}} for the per-segment and per-category files."""
    out = {d: {} for d in DATASET_IDS}
    for cat in categories.values():
        files = out[cat.info["dataset"]]
        for i, seg in enumerate(cat.segments):
            first = i == 0
            p = seg.prefix
            files[f"{p}_StartListwithTimes.pdf"] = start_list(seg, cat, first)
            files[f"{p}_ISUPanelofJudgesandTechnicalPanel.pdf"] = panel_pdf(seg)
            files[f"{p}_JudgesSheetAll.pdf"] = judges_sheet_all(seg, cat)
            files[f"{p}_RefereeSheet.pdf"] = referee_sheet(seg)
            files[f"{p}_PlannedProgramContent.pdf"] = planned_program_content(seg, cat, first)
            files[f"{p}_TechnicalControllerSheet.pdf"] = technical_sheet(
                seg, "Technical Controller", "TECHNICAL CONTROLLER SHEET")
            files[f"{p}_TechnicalSpecialistSheet1.pdf"] = technical_sheet(
                seg, "Technical Specialist 1", "TECHNICAL SPECIALIST SHEET")
            files[f"{p}_TechnicalSpecialistSheet2.pdf"] = technical_sheet(
                seg, "Technical Specialist 2", "TECHNICAL SPECIALIST SHEET")
            files[f"{p}_SegmentResults.pdf"] = segment_results(seg)
            files[f"{p}_JudgesDetailsperSkater.pdf"] = judges_details(seg)
        files[f"{cat.prefix}_CalculationSetupVerificationforReferee.pdf"] = calculation_setup(cat)
        files[f"{cat.prefix}_Results.pdf"] = results(cat)
        files[f"{cat.prefix}_ProtocolHeadPage.pdf"] = protocol_head_page(cat)
    return out


def combination_files(categories, officials, datasets):
    cats = [c for c in categories.values() if c.info["dataset"] in datasets]
    segments = segment_order(categories, datasets)
    files = {
        f"{COMPETITION_PREFIX}_CompetitionSchedule.pdf": competition_schedule(segments),
        f"DT_SCHEDULE_{COMPETITION_PREFIX}.xml": dt_schedule(segments),
        f"DT_PARTIC_{COMPETITION_PREFIX}.xml": dt_partic(cats, officials, datasets),
    }
    if "synchro" in datasets:
        files[f"DT_PARTIC_TEAMS_{COMPETITION_PREFIX}.xml"] = dt_partic_teams(
            [c for c in cats if c.info["discipline"] == "synchro"])
    return files


def combination_keys():
    keys = []
    for n in range(1, len(DATASET_IDS) + 1):
        for combo in combinations(DATASET_IDS, n):
            keys.append("-".join(sorted(combo)))
    return keys


def check_names(categories, officials):
    """Guards the parsers rely on, so a pool change can't silently break them."""
    names = [o.name for o in officials]
    for cat in categories.values():
        for comp in cat.competitors:
            names.append(comp.name)
            names += [m.name for m in comp.members]
    for name in names:
        low = name.lower()
        bad = [s for s in FORBIDDEN_SUBSTRINGS if s in low]
        if bad:
            raise SystemExit(f"a generated name contains a parser anchor ({bad[0]!r})")
        name.encode("cp1252")  # the standard PDF fonts are WinAnsi
    clubs_json = HERE.parents[2] / "site" / "public" / "tools" / "banner" / "logos" / "clubs.json"
    if clubs_json.exists():
        real = {str(c.get("abbreviation", "")).casefold() for c in json.loads(clubs_json.read_text("utf-8"))}
        clash = [abbr for abbr, _n, _c in CLUBS if abbr.casefold() in real]
        if clash:
            raise SystemExit("a sample club abbreviation is a real club's (clubs.json)")


def generate(out_dir: Path) -> dict:
    categories, officials = build_competition()
    for cat in categories.values():
        CATEGORY_LAST[cat.code] = cat.segments[-1]
    check_names(categories, officials)

    manifest_path = HERE / "manifest.json"
    old = json.loads(manifest_path.read_text("utf-8")) if manifest_path.exists() else {}
    labels = {d["id"]: d for d in old.get("datasets", [])}

    for sub in ("datasets", "combined"):
        shutil.rmtree(out_dir / sub, ignore_errors=True)
    per_dataset = dataset_files(categories, officials)
    listing = {}
    for dataset_id, files in per_dataset.items():
        folder = out_dir / "datasets" / dataset_id
        folder.mkdir(parents=True, exist_ok=True)
        for name in sorted(files):
            (folder / name).write_bytes(files[name])
        listing[dataset_id] = [f"datasets/{dataset_id}/{name}" for name in sorted(files)]

    combos = {}
    for key in combination_keys():
        datasets = key.split("-")
        folder = out_dir / "combined" / key
        folder.mkdir(parents=True, exist_ok=True)
        files = combination_files(categories, officials, datasets)
        paths = []
        for d in DATASET_IDS:
            if d in datasets:
                paths += listing[d]
        for name in sorted(files):
            (folder / name).write_bytes(files[name])
            paths.append(f"combined/{key}/{name}")
        combos[key] = paths

    manifest = {
        "version": old.get("version", 1),
        "datasets": [
            {"id": d, "label": labels.get(d, {}).get("label", d.title()),
             "description": DESCRIPTIONS_TEXT[d]}
            for d in DATASET_IDS
        ],
        "combinations": combos,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", "utf-8")
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out", type=Path, default=HERE,
                        help="where to write datasets/, combined/ and manifest.json (default: here)")
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    manifest = generate(args.out)
    count = len({p for paths in manifest["combinations"].values() for p in paths})
    size = sum((args.out / p).stat().st_size for p in
               {p for paths in manifest["combinations"].values() for p in paths})
    print(f"wrote {count} files, {size / 1024 / 1024:.2f} MiB, into {args.out}")


if __name__ == "__main__":
    sys.exit(main())
