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

The files committed now are placeholders; `generate.py` will regenerate the
real dataset.
