# Sample datasets (test environment only)

Synthetic FS Manager-style competition files that the create-competition
dialog offers in the **test** environment (`SAMPLE_DATA_ENABLED`; prod
hard-codes it off). Every name, club, nation and score here is invented.

The platform API (`function_app.py`) serves them:

- `GET /api/sample-datasets` lists `datasets` from `manifest.json`.
- `POST /api/competitions/{id}/sample-data` with `{"datasets": [...]}` writes
  every file of the selected combination into the competition's `uploads/`
  (`sourceTool` `sample`, overwriting same-named files). No birth-date
  stripping runs on them: they are trusted static assets.

## `manifest.json` contract

```json
{
  "version": 1,
  "datasets": [
    {"id": "synchro",  "label": "Synchronized skating", "description": "…"},
    {"id": "singles",  "label": "Singles",              "description": "…"},
    {"id": "icedance", "label": "Ice dance",            "description": "…"}
  ],
  "combinations": {
    "synchro": ["datasets/synchro/<file>", "combined/synchro/<file>"],
    "icedance-singles": ["…"],
    "icedance-singles-synchro": ["…"]
  }
}
```

- Dataset ids are `[a-z0-9]{1,32}` (no `-`, it joins them).
- A combination key is the selected ids, **sorted**, joined by `-`. Every
  non-empty selection must have its key (3 datasets → 7 keys), no more.
- Each value is a non-empty list of paths relative to this directory. A file
  lands in the pool under its **basename**, so basenames are unique within a
  combination (case-insensitively).
- The loader (`load_sample_manifest`) refuses the whole manifest when a path
  escapes this directory (absolute, `..`, `\`, or a symlink pointing outside),
  a file is missing, a basename would not pass `sanitize_pool_filename`
  unchanged, its extension is not in `POOL_CONTENT_TYPES`, or a file exceeds
  `POOL_MAX_FILE_SIZE`.
- Participant XML carries no `BirthDate` and no DTD:
  `tests/test_sample_data.py` checks that every listed file would pass the
  upload's `_strip_upload_birth_dates` byte for byte.

## Layout

- `datasets/<id>/` — the files of one dataset (per-segment and per-category
  PDFs).
- `combined/<combination key>/` — the files that exist once per competition
  (schedule, participant lists), prebuilt for each combination.

Only `manifest.json`, `datasets/` and `combined/` ship in the platform zip;
the scripts, this README and `requirements-sampledata.txt` are left out
(`.funcignore` and the "Build backend package" step of `deploy-site.yml`).

## What the datasets hold

One fictional competition, "Sample Autumn Trophy 2026" at "Sampleton Ice
Arena", Saturday 17 and Sunday 18 October 2026, English FSM locale (colon
times, `printed: dd.mm.yyyy hh:mm`). Invented clubs (single-token
abbreviations, none a real club's in `clubs.json`), skaters, synchro teams and
officials (ISU nation codes); every segment has a 15-person panel (Referee,
Judge No. 1–9, Technical Controller, two Technical Specialists, Data and
Replay Operator), drawn once and printed identically in every file.

| Dataset | Category (code) | Segments | Entries |
|---|---|---|---|
| `synchro` | Junior Synchronized Skating (`FSKXSYNCHRONJUNIOR`) | Short Program, Free Skating | 6 teams |
| | Advanced Novice Synchronized Skating (`FSKXSYNCHRONADVNOV`) | Free Skating | 5 teams |
| `singles` | Junior Women (`FSKWSINGLES-JUNIOR`) | Short Program, Free Skating | 8 |
| | Junior Men (`FSKMSINGLES-JUNIOR`) | Short Program, Free Skating | 5 |
| `icedance` | Junior Ice Dance (`FSKXICEDANCEJUNIOR`) | Rhythm Dance, Free Dance | 5 couples |

Per segment: `StartListwithTimes`, `ISUPanelofJudgesandTechnicalPanel`,
`JudgesSheetAll`, `RefereeSheet`, `PlannedProgramContent`,
`TechnicalControllerSheet`, `TechnicalSpecialistSheet1/2`, `SegmentResults`,
`JudgesDetailsperSkater`. Per category: `CalculationSetupVerificationforReferee`,
`Results`, `ProtocolHeadPage`. Per combination (`combined/<key>/`):
`CompetitionSchedule.pdf`, `DT_SCHEDULE`, `DT_PARTIC` (skaters, synchro
alternates and officials) and, with synchro, `DT_PARTIC_TEAMS` (16 + 4 per
team, linked by `<Composition><Athlete Code>`). File names follow FSM:
`<category padded to 22 with '-'><QUAL000100|FNL-000100>--_<Suffix>.pdf`, the
competition level `FSK` + 31 dashes.

Scores are generated, not copied: element lists follow the 2026-27 rules
(the ice dance pattern dance as FSM printed it in 2025-26), base values come
from the small SOV table in `generate.py`, nine judges' GOE and component marks
are random around each competitor's level, and every panel value, TES, PCS,
deduction, segment score, total and rank is computed from them (see the
docstring of `generate.py` for the rules).

## Regenerate, verify, leak-check

```bash
cd infra/functions/sample_data
python3 -m venv .venv && .venv/bin/pip install -r requirements-sampledata.txt
.venv/bin/python generate.py         # rewrites datasets/, combined/, manifest.json
.venv/bin/python verify_parsers.py   # the tools' parsers on every file (~2 min)
.venv/bin/python check_leaks.py      # no reference name in any file
```

- `generate.py` is deterministic (fixed seed, reportlab `invariant=1`, fixed
  "printed" stamps); with the pinned reportlab it writes the committed bytes
  again (`tests/test_sample_data.py` checks that when reportlab is installed;
  CI skips it). It keeps the manifest's `version` and dataset labels.
- `verify_parsers.py` (local only) imports the parsers from sibling checkouts
  (`~/git/fs-judgepapers`, `fs-protocolgenerator`, `fs-scoremodifier`;
  `--repos` to move them; Azure SDK imports are stubbed) and runs the site's
  TypeScript (`summarizeScheduleXml`, the Protocol Generator slot planner)
  with node 24. Every expectation comes from the generator's own model; it
  ends with a pass/fail count per tool and exits non-zero on any failure.
- `check_leaks.py` (local only) reads the real FSM exports the layouts were
  learned from (`~/fs-samples/refs`, never committed), collects every person,
  club and team name, competition name and venue in them at runtime, and fails
  when any appears in a generated file. It prints counts only (`--show` prints
  the names, for local debugging; never paste them anywhere).
