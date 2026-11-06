#!/usr/bin/env python3
"""Run the tools' real parsers on the generated sample data. Local only, not CI.

Needs sibling checkouts of the tool repos (default ~/git, override with
--repos) and the packages of requirements-sampledata.txt; node (24+, runs the
site's TypeScript directly) for the banner and slot-planning checks.

    .venv/bin/python verify_parsers.py            # checks this directory's files
    .venv/bin/python verify_parsers.py --dir OUT  # checks a generate.py --out tree

Every expectation comes from the generator's own model (generate.py rebuilds it
deterministically), so a file that parses into anything else fails loudly:

- Judge Paper Creator: file names, panels, the role and competitor line of every
  judges'-sheet page, start lists (pypdf and pdfminer readers), the competition
  schedule, and a full `process_judging_papers` run per dataset combination
  (packets per official and day, page counts, no warnings);
- Protocol Generator: schedule PDF, total and segment results, DT_PARTIC /
  DT_PARTIC_TEAMS rosters and their placement into categories, empty-page
  detection, the PDF sanitizer; and the site's slot planner;
- Score Modifier: block detection, every summary row, the split, the page-0
  name;
- banner: `summarizeScheduleXml` of every DT_SCHEDULE;
- the numbers themselves: every element, component and total recomputed.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib.abc
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tempfile
import types
import warnings
import zipfile
from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from unittest import mock

warnings.filterwarnings("ignore")
HERE = Path(__file__).resolve().parent
SITE = HERE.parents[2]


# ── azure stubs (the tools' function_app modules import the Azure SDKs) ───────

class _StubModule(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        value = mock.MagicMock(name=f"{self.__name__}.{name}")
        setattr(self, name, value)
        return value


class _AzureStubFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path, target=None):
        if fullname == "azure" or fullname.startswith("azure."):
            return importlib.util.spec_from_loader(fullname, self, is_package=True)
        return None

    def create_module(self, spec):
        return _StubModule(spec.name)

    def exec_module(self, module):
        module.__path__ = []


# ── bookkeeping ───────────────────────────────────────────────────────────────

class Report:
    def __init__(self):
        self.passed = defaultdict(int)
        self.failed = defaultdict(list)
        self.notes = set()

    def eq(self, tool, what, got, want):
        if got == want:
            self.passed[tool] += 1
        else:
            self.failed[tool].append(f"{what}:\n      got  {got!r}\n      want {want!r}")

    def ok(self, tool, what, condition, detail=""):
        if condition:
            self.passed[tool] += 1
        else:
            self.failed[tool].append(f"{what}: {detail}" if detail else what)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def quiet(fn, *args, **kwargs):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        result = fn(*args, **kwargs)
    return result, out.getvalue()


# ── the expected model ────────────────────────────────────────────────────────

def load_model():
    gen = load_module("sample_generate", HERE / "generate.py")
    categories, officials = gen.build_competition()
    for cat in categories.values():
        gen.CATEGORY_LAST[cat.code] = cat.segments[-1]
    return gen, categories, officials


def category_table(gen):
    kinds = {"singles": "Figure skating", "dance": "Ice dance", "synchro": "Synchronized skating"}
    rows = [{"abbreviation": code, "displayName": info["name"], "displayNameFi": info["name"],
             "judgingMethod": "ISU", "competitionType": kinds[info["discipline"]]}
            for code, info in gen.CATEGORIES.items()]
    rows.sort(key=lambda r: len(r["abbreviation"]), reverse=True)
    return rows


def check_numbers(rep, gen, categories):
    """Recompute every score of the model from its raw marks."""
    D = Decimal
    for cat in categories.values():
        for seg in cat.segments:
            for perf in seg.performances:
                for el in perf.elements:
                    rep.eq("numbers", f"{seg.prefix} {el.code} score", el.score, el.bv + el.goe)
                    rep.ok("numbers", f"{seg.prefix} {el.code} grades", len(el.grades) == 9
                           and all(-5 <= g <= 5 for g in el.grades))
                for name, marks, avg in perf.components:
                    rep.eq("numbers", f"{seg.prefix} {name} average", avg, gen.r2(gen.trimmed_mean(marks)))
                    rep.ok("numbers", f"{seg.prefix} {name} quarter marks",
                           all((m * 4) % 1 == 0 for m in marks))
                pcs = sum((gen.r2(avg * perf.factor) for _n, _m, avg in perf.components), D(0))
                rep.eq("numbers", f"{seg.prefix} pcs", perf.pcs, pcs)
                rep.eq("numbers", f"{seg.prefix} tes", perf.tes, sum((e.score for e in perf.elements), D(0)))
                rep.eq("numbers", f"{seg.prefix} total", perf.total, perf.tes + perf.pcs + perf.deductions)
                rep.eq("numbers", f"{seg.prefix} deductions", perf.deductions, D(-perf.falls))
                falls = sum(1 for e in perf.elements if "F" in e.info.split(","))
                rep.eq("numbers", f"{seg.prefix} falls marked", falls, perf.falls)
            order = sorted(seg.performances, key=lambda p: p.rank)
            rep.ok("numbers", f"{seg.prefix} ranks", all(a.total >= b.total for a, b in zip(order, order[1:])))
        for comp in cat.competitors:
            rep.eq("numbers", f"{cat.code} total", comp.total,
                   sum((p.total for p in comp.performances.values()), D(0)))
        order = sorted(cat.competitors, key=lambda c: c.rank)
        rep.ok("numbers", f"{cat.code} final ranks", all(a.total >= b.total for a, b in zip(order, order[1:])))


# ── Judge Paper Creator ───────────────────────────────────────────────────────

ROLE_KEYS = {
    "Referee": "referee", "Technical Controller": "technical_controller",
    "Technical Specialist 1": "technical_specialist_1", "Technical Specialist 2": "technical_specialist_2",
    "Data Operator": "data_operator", "Replay Operator": "replay_operator",
}


def check_jpc(rep, gen, categories, root, jpc_dir):
    sys.path.insert(0, str(jpc_dir))
    try:
        import categories as jcat
        import combine_judging_papers as cjp
        import combined_schedule as csched
        import competition_schedule as comp_sched
        import create_cover_pages as ccp
        import processor
        import split_judges_sheets as sjs
        from pypdf import PdfReader
    finally:
        sys.path.remove(str(jpc_dir))
    T = "judgepapers"
    table = category_table(gen)
    other_language = [dict(r, displayName="Kategoria", displayNameFi="Kategoria") for r in table]

    for cat in categories.values():
        folder = root / "datasets" / cat.info["dataset"]
        for name in (f"{cat.prefix}_CalculationSetupVerificationforReferee.pdf", f"{cat.prefix}_Results.pdf"):
            parsed = jcat.parse_filename_generic(name, table)
            rep.eq(T, f"{name} category", parsed and parsed["categoryCode"], cat.code)
        for seg in cat.segments:
            p = seg.prefix
            for suffix in ("StartListwithTimes", "JudgesSheetAll", "ISUPanelofJudgesandTechnicalPanel",
                           "SegmentResults", "JudgesDetailsperSkater"):
                parsed = jcat.parse_filename_generic(f"{p}_{suffix}.pdf", table)
                rep.eq(T, f"{p} {suffix} parsed", parsed and (parsed["categoryCode"], parsed["segment"]),
                       (cat.code, seg.rule.phase))
            # panel
            panel = cjp.get_panel_info(str(folder / f"{p}_ISUPanelofJudgesandTechnicalPanel.pdf"))
            want = []
            for role in ("Technical Controller", "Technical Specialist 1", "Technical Specialist 2", "Referee"):
                want.append((ROLE_KEYS[role], seg.panel[role].name,
                             "Technical Specialist" if role.startswith("Technical Specialist") else role))
            want += [("judge", seg.panel[f"Judge No. {i}"].name, f"Judge {i}") for i in range(1, 10)]
            want += [(ROLE_KEYS[r], seg.panel[r].name, r) for r in ("Data Operator", "Replay Operator")]
            rep.eq(T, f"{p} panel", panel, want)
            # judges' sheets: every page
            js = folder / f"{p}_JudgesSheetAll.pdf"
            reader = PdfReader(str(js))
            pages = [pg.extract_text(extraction_mode="layout") for pg in reader.pages]
            expected_pages = []
            for role in ["Referee"] + [f"Judge No. {i}" for i in range(1, 10)]:
                for perf in seg.performances:
                    expected_pages.append(("referee" if role == "Referee" else "judge",
                                           sjs.slugify(seg.panel[role].name),
                                           str(perf.start_no), perf.competitor.name))
            got_pages = []
            for text in pages:
                found = next(((r, n) for r, n in map(sjs.parse_judge_line, text.split("\n")) if r), (None, None))
                got_pages.append(found + sjs.extract_starting_number(text))
            rep.eq(T, f"{p} judges' sheet pages", got_pages, expected_pages)
            rep.ok(T, f"{p} no withdrawn pages", not any(sjs.is_withdrawn_page(t) for t in pages))
            rep.eq(T, f"{p} title line", ccp.extract_title_from_pdf(str(js)), gen.COMPETITION_NAME)
            line2 = ccp.extract_segment_name_from_pdf(str(js))
            rep.eq(T, f"{p} line 2", line2, seg.title)
            want_names = (cat.name.upper(), seg.rule.name.upper())
            rep.eq(T, f"{p} names from line 2", jcat.names_from_sheet_line(
                line2, jcat.match_category(p, table)), want_names)
            rep.eq(T, f"{p} names from line 2 (other-language table)", jcat.names_from_sheet_line(
                line2, jcat.match_category(p, other_language)), want_names)
            # start list
            sl = folder / f"{p}_StartListwithTimes.pdf"
            rep.eq(T, f"{p} start list date", cjp.get_date_from_start_list(str(sl)), seg.day.strftime("%Y%m%d"))
            rep.eq(T, f"{p} first start", cjp.get_first_start_time_from_start_list(str(sl)), gen.hms(seg.start)[:5])
            rep.eq(T, f"{p} last end", cjp.get_last_end_time_from_start_list(str(sl)), gen.hms(seg.end)[:5])
            parsed, _ = quiet(csched.parse_start_list, str(sl))
            rep.ok(T, f"{p} start list parses (pdfminer)", parsed is not None)
            if parsed:
                rep.eq(T, f"{p} start list title", csched.split_title(parsed["title_line"]), want_names)
                rep.eq(T, f"{p} start list date (pdfminer)", parsed["date"],
                       datetime(seg.day.year, seg.day.month, seg.day.day))
                rows = [(r["kind"], r["time"], r["number"], r["name"], r["club"]) for r in parsed["rows"]]
                want_rows = []
                for kind, t0, t1, item in seg.rows:
                    time = f"{gen.hms(t0)} - {gen.hms(t1)}"
                    if kind == "skater":
                        want_rows.append(("skater", time, str(item.start_no), item.competitor.name, item.competitor.club))
                    elif kind == "warmup":
                        want_rows.append(("warmup", time, "", f"Warm-Up Group {item}", ""))
                    else:
                        want_rows.append(("resurfacing", time, "", "Ice Resurfacing", ""))
                rep.eq(T, f"{p} start list rows", rows, want_rows)
                rep.eq(T, f"{p} start list params", sorted(parsed["params"]), sorted(csched.PARAM_KEYS))
                rep.eq(T, f"{p} start list printed", parsed["printed"], gen.PAPERS_PRINTED)

    # competition schedule of every combination
    for key in gen.combination_keys():
        segments = gen.segment_order(categories, key.split("-"))
        path = root / "combined" / key / f"{gen.COMPETITION_PREFIX}_CompetitionSchedule.pdf"
        entries = comp_sched.parse_competition_schedule(str(path), table)
        got = [(e["date"], e["start_time"], e["end_time"], e["entries"], e["category_name"],
                e["segment_name"].split("  ")[0]) for e in entries]
        want = [(s.day.strftime("%Y%m%d"), gen.hms(s.start)[:5], gen.hms(s.end)[:5], len(s.performances),
                 gen.CATEGORIES[s.cat_code]["name"], s.rule.name) for s in segments]
        rep.eq(T, f"{key} competition schedule", got, want)
        if any(e["segment_name"] != e["segment_name"].split("  ")[0] for e in entries):
            rep.notes.add("judgepapers: competition_schedule's two-column pattern keeps the trailing "
                          "resurfacing/performance times in segment_name (compared without them here)")
        # get_schedule_start_time matches the segment name alone first, so every
        # segment of one name gets the day's first start. The processor overrides
        # it with the start list's own first time, so this is only reported.
        for s in segments:
            found = comp_sched.get_schedule_start_time(
                entries, gen.CATEGORIES[s.cat_code]["name"].upper(), s.rule.name.upper())
            if found != gen.hms(s.start)[:5]:
                rep.notes.add("judgepapers: competition_schedule.get_schedule_start_time ignores the category "
                              "when another category has the same segment name (the start list wins)")

    # the whole pipeline, per combination
    for key in gen.combination_keys():
        datasets = key.split("-")
        manifest = json.loads((root / "manifest.json").read_text("utf-8"))
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / "src", Path(tmp) / "out"
            src.mkdir()
            for rel in manifest["combinations"][key]:
                shutil.copy(root / rel, src / Path(rel).name)
            with mock.patch.object(processor, "_get_categories_for_processor", return_value=table):
                stats, log = quiet(processor.process_judging_papers, str(src), str(out),
                                   {"globalCombinedSchedule": True})
            bad = [ln for ln in log.splitlines() if any(w in ln for w in ("Warning", "Skipping", "Error"))]
            rep.eq(T, f"{key} pipeline warnings", bad, [])
            segments = gen.segment_order(categories, datasets)
            for day in sorted({s.day for s in segments}):
                ds = day.strftime("%Y%m%d")
                expected = expected_packets(gen, categories, segments, day, src, sjs.slugify, PdfReader)
                zpath = out / f"judgingPapers_{ds}.zip"
                rep.ok(T, f"{key} {ds} zip", zpath.exists())
                if not zpath.exists():
                    continue
                with zipfile.ZipFile(zpath) as z:
                    got = {}
                    for info in z.infolist():
                        slug = info.filename[len(f"judgingpapers_{ds}_"):-4]
                        got[slug] = len(PdfReader(io.BytesIO(z.read(info))).pages)
                rep.eq(T, f"{key} {ds} packets and page counts", got, expected)
                daily = out / f"judgingpapers_{ds}.pdf"
                rep.ok(T, f"{key} {ds} day document", daily.exists())
            rep.ok(T, f"{key} statistics", isinstance(stats, dict) and stats)


def expected_packets(gen, categories, segments, day, src, slugify, PdfReader):
    """{official slug: page count} of one day's personal packets, from the PDFs' own page counts."""
    pages = lambda name: len(PdfReader(str(src / name)).pages)  # noqa: E731
    setup_given = set()
    packets = {}
    for seg in sorted(segments, key=lambda s: (s.day, s.start)):
        cat = categories[seg.cat_code]
        for role, person in seg.panel.items():
            slug = slugify(person.name)
            if seg.day != day:
                if role == "Referee" and seg.day < day:
                    setup_given.add((cat.code, slug))
                continue
            n = packets.setdefault(slug, 1)  # the cover
            n += pages(f"{seg.prefix}_StartListwithTimes.pdf")
            per = len(seg.performances)
            if role == "Referee":
                if (cat.code, slug) not in setup_given:
                    setup_given.add((cat.code, slug))
                    n += pages(f"{cat.prefix}_CalculationSetupVerificationforReferee.pdf")
                n += pages(f"{seg.prefix}_RefereeSheet.pdf") + per
            elif role.startswith("Judge"):
                n += per
            elif role == "Technical Controller":
                n += pages(f"{seg.prefix}_TechnicalControllerSheet.pdf")
            elif role.startswith("Technical Specialist"):
                n += pages(f"{seg.prefix}_TechnicalSpecialistSheet{role[-1]}.pdf")
            else:
                n += pages(f"{seg.prefix}_PlannedProgramContent.pdf")
            packets[slug] = n
    return packets


# ── Protocol Generator ────────────────────────────────────────────────────────

def check_pg(rep, gen, categories, root, pg_dir):
    sys.path.insert(0, str(pg_dir))
    try:
        import assemble
        import dt_partic
        import pdf_sanitize
        import results_parser
        import roster_matching
        import schedule_parser
        from pypdf import PdfReader, PdfWriter
    finally:
        sys.path.remove(str(pg_dir))
    T = "protocolgenerator"
    disciplines = {"singles": "single", "dance": "dance", "synchro": "synchro"}
    structures = {}
    for key in gen.combination_keys():
        datasets = key.split("-")
        segments = gen.segment_order(categories, datasets)
        data = (root / "combined" / key / f"{gen.COMPETITION_PREFIX}_CompetitionSchedule.pdf").read_bytes()
        rows, cats, meta = schedule_parser.parse_schedule_data(data)
        got = [(r["date"], r["date_display"], r["start_time"], r["end_time"], r["entries"],
                r["category_name"], r["segment_name"]) for r in rows]
        want = [(s.day.strftime("%Y%m%d"), s.day.strftime("%d.%m.%Y"), gen.hms(s.start)[:5], gen.hms(s.end)[:5],
                 len(s.performances), gen.CATEGORIES[s.cat_code]["name"], s.rule.name) for s in segments]
        rep.eq(T, f"{key} schedule rows", got, want)
        want_cats = []
        for code in dict.fromkeys(s.cat_code for s in segments):
            info = gen.CATEGORIES[code]
            want_cats.append((info["name"], disciplines[info["discipline"]], [r.name for r in info["segments"]]))
        rep.eq(T, f"{key} schedule categories",
               [(c["name"], c["discipline"], [s["name"] for s in c["segments"]]) for c in cats], want_cats)
        rep.eq(T, f"{key} schedule dates", meta.get("dates"),
               " – ".join(dict.fromkeys(s.day.strftime("%d.%m.%Y") for s in (segments[0], segments[-1]))))
        structures[key] = {"categories": cats}

        cat_ids = {c["name"]: c["id"] for c in cats}
        rows_by_cat = {}
        for cat in categories.values():
            if cat.info["dataset"] not in datasets:
                continue
            res = (root / "datasets" / cat.info["dataset"] / f"{cat.prefix}_Results.pdf").read_bytes()
            rows_by_cat[cat_ids[cat.name]] = results_parser.parse_result_rows(res)
        if "synchro" in datasets:
            teams_xml = (root / "combined" / key / f"DT_PARTIC_TEAMS_{gen.COMPETITION_PREFIX}.xml").read_bytes()
            partic_xml = (root / "combined" / key / f"DT_PARTIC_{gen.COMPETITION_PREFIX}.xml").read_bytes()
            rep.eq(T, f"{key} TEAMS document type", dt_partic.document_type(teams_xml), dt_partic.TEAMS)
            rep.eq(T, f"{key} PARTIC document type", dt_partic.document_type(partic_xml), dt_partic.PARTIC)
            teams = dt_partic.parse_team_rosters(teams_xml, dt_partic.parse_participants(partic_xml))
            want_teams = []
            for cat in categories.values():
                if cat.info["discipline"] != "synchro":
                    continue
                for comp in cat.competitors:
                    members = sorted(f"{m.family.upper()} {m.given}" for m in comp.members)
                    want_teams.append((comp.name, comp.club, cat.prefix, members))
            rep.eq(T, f"{key} rosters", [(t["name"], t["org"], t["event"], t["members"]) for t in teams], want_teams)
            report = roster_matching.match_teams(structures[key], teams, rows_by_cat)
            names = {c["id"]: c["name"] for c in cats}
            got = sorted((a["team"]["name"], names[a["categoryId"]], a["method"]) for a in report["assignments"])
            want = sorted((comp.name, cat.name, "results") for cat in categories.values()
                          if cat.info["discipline"] == "synchro" for comp in cat.competitors)
            rep.eq(T, f"{key} roster placement", (got, report["unmatched"], report["withdrawn"]), (want, [], []))
        else:
            partic_xml = (root / "combined" / key / f"DT_PARTIC_{gen.COMPETITION_PREFIX}.xml").read_bytes()
            rep.eq(T, f"{key} PARTIC document type", dt_partic.document_type(partic_xml), dt_partic.PARTIC)

    slot_pdfs = []
    for cat in categories.values():
        folder = root / "datasets" / cat.info["dataset"]
        res = (folder / f"{cat.prefix}_Results.pdf").read_bytes()
        want = [(c.rank, c.name, c.club) for c in sorted(cat.competitors, key=lambda c: c.rank)]
        rep.eq(T, f"{cat.code} total results", [(r["rank"], r["name"], r["club"])
                                                for r in results_parser.parse_result_rows(res)], want)
        rep.eq(T, f"{cat.code} top three", results_parser.parse_top_three(res),
               [f"{c} - {n}" for _r, n, c in want[:3]])
        slot_pdfs += [folder / f"{cat.prefix}_Results.pdf", folder / f"{cat.prefix}_ProtocolHeadPage.pdf"]
        for seg in cat.segments:
            sr = (folder / f"{seg.prefix}_SegmentResults.pdf").read_bytes()
            want = [(p.rank, p.competitor.name, p.competitor.club) for p in sorted(seg.performances, key=lambda p: p.rank)]
            rep.eq(T, f"{seg.prefix} segment results", [(r["rank"], r["name"], r["club"])
                                                       for r in results_parser.parse_result_rows(sr)], want)
            rep.eq(T, f"{seg.prefix} unit count", results_parser.count_result_rows(sr), len(seg.performances))
            slot_pdfs += [folder / f"{seg.prefix}_{s}.pdf" for s in
                          ("SegmentResults", "ISUPanelofJudgesandTechnicalPanel", "JudgesDetailsperSkater")]
    writer = PdfWriter()
    for path in slot_pdfs:
        reader = PdfReader(str(path))
        rep.eq(T, f"{path.name} empty pages", assemble._skippable_page_indices(reader), set())
        for page in reader.pages:
            writer.add_page(page)
    try:
        pdf_sanitize.sanitize(writer, title="Sample", author="Sample")
        writer.write(io.BytesIO())
        rep.ok(T, "sanitizer accepts every slot PDF", True)
    except Exception as e:  # noqa: BLE001
        rep.ok(T, "sanitizer accepts every slot PDF", False, repr(e))
    return structures


# ── node: banner summary + slot planner (the site's TypeScript) ──────────────

NODE_SCRIPT = r"""
import { readFileSync } from 'node:fs';
import { summarizeScheduleXml, isScheduleXmlName } from './schedule-xml.ts';
import { planAutoAssignment, applyOutcomeLocally } from './protocol-auto-assign.ts';
const input = JSON.parse(readFileSync(0, 'utf8'));
const out = { summaries: {}, names: {}, plans: {} };
for (const [key, xml] of Object.entries(input.schedules)) out.summaries[key] = summarizeScheduleXml(xml);
for (const name of input.names) out.names[name] = isScheduleXmlName(name);
for (const [key, job] of Object.entries(input.plans)) {
  const structure = structuredClone(job.structure);
  structure.files = {};
  out.plans[key] = {};
  for (const file of job.files) {
    const outcome = planAutoAssignment(file, input.table, structure);
    applyOutcomeLocally(structure, outcome, file);
    out.plans[key][file] = outcome;
  }
}
process.stdout.write(JSON.stringify(out));
"""


def check_node(rep, gen, categories, root, structures):
    node = shutil.which("node")
    if not node:
        rep.failed["banner"].append("node is not installed: the TypeScript checks did not run")
        return
    src = SITE / "packages" / "shared-ui" / "src"
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "package.json").write_text('{"type": "module"}')
        for name in ("schedule-xml.ts", "category-recognition.ts", "protocol-auto-assign.ts"):
            text = (src / name).read_text("utf-8").replace("./category-recognition.js", "./category-recognition.ts")
            (tmp / name).write_text(text, "utf-8")
        (tmp / "run.mjs").write_text(NODE_SCRIPT, "utf-8")
        payload = {"schedules": {}, "names": [], "plans": {}, "table": category_table(gen)}
        for key in gen.combination_keys():
            payload["schedules"][key] = (root / "combined" / key /
                                         f"DT_SCHEDULE_{gen.COMPETITION_PREFIX}.xml").read_text("utf-8")
            files = [Path(p).name for p in manifest["combinations"][key]]
            payload["names"] += files
            payload["plans"][key] = {"structure": structures[key], "files": [f for f in files if f.endswith(".pdf")]}
        proc = subprocess.run([node, "--no-warnings", str(tmp / "run.mjs")], input=json.dumps(payload),
                              capture_output=True, text=True, cwd=tmp)
    if proc.returncode:
        rep.failed["banner"].append(f"node failed: {proc.stderr.strip()[:500]}")
        return
    out = json.loads(proc.stdout)
    for key in gen.combination_keys():
        segments = gen.segment_order(categories, key.split("-"))
        want = {"categories": list(dict.fromkeys(gen.CATEGORIES[s.cat_code]["name"] for s in segments)),
                "firstDate": segments[0].day.isoformat(), "lastDate": segments[-1].day.isoformat(),
                "venue": gen.VENUE}
        rep.eq("banner", f"{key} summarizeScheduleXml", out["summaries"][key], want)
    for name, is_schedule in out["names"].items():
        rep.eq("banner", f"isScheduleXmlName({name})", is_schedule, name.startswith("DT_SCHEDULE_"))

    T = "protocolgenerator"
    for key, plan in out["plans"].items():
        cats = {c["id"]: c for c in structures[key]["categories"]}
        for file, outcome in plan.items():
            suffix = file.rsplit("_", 1)[1][:-4]
            if suffix in ("SegmentResults", "ISUPanelofJudgesandTechnicalPanel", "JudgesDetailsperSkater",
                          "Results", "ProtocolHeadPage"):
                ok = outcome.get("action") == "assign"
                target = outcome.get("target", {})
                cat = cats.get(target.get("categoryId"), {})
                info = next((v for k, v in sorted(gen.CATEGORIES.items(), key=lambda kv: -len(kv[0]))
                             if file.startswith(k)), None)
                detail = json.dumps(outcome)
                rep.ok(T, f"{key} slot plan {file}", ok and info and cat.get("name") == info["name"], detail)
                if ok and target.get("kind") == "segment":
                    seg = next(s for s in cat["segments"] if s["id"] == target["segmentId"])
                    phase = file[22:26]
                    want = [r.name for r in info["segments"] if r.phase.startswith(phase)]
                    rep.ok(T, f"{key} slot segment {file}", seg["name"] in want, f"{seg['name']} vs {want}")
            else:
                rep.eq(T, f"{key} slot plan {file}", outcome, {"action": "tray", "reason": "not-for-protocol"})


# ── Score Modifier ────────────────────────────────────────────────────────────

def check_sm(rep, gen, categories, root, sm_dir):
    sys.path.insert(0, str(sm_dir))
    sys.path.insert(0, str(sm_dir / "infra" / "functions"))
    try:
        import pymupdf as fitz
        from scoremodifier import per_skater, extract, results as sm_results
        from scoremodifier.model import ResultsMeta
        sm_app = load_module("sm_function_app", sm_dir / "infra" / "functions" / "function_app.py")
    finally:
        sys.path.remove(str(sm_dir))
        sys.path.remove(str(sm_dir / "infra" / "functions"))
    T = "scoremodifier"
    for cat in categories.values():
        for seg in cat.segments:
            path = root / "datasets" / cat.info["dataset"] / f"{seg.prefix}_JudgesDetailsperSkater.pdf"
            data = path.read_bytes()
            doc = fitz.open(stream=data, filetype="pdf")
            title, bands, legend = per_skater._collect(doc)
            rep.eq(T, f"{seg.prefix} blocks", len(bands), len(seg.performances))
            rep.ok(T, f"{seg.prefix} rank digits", all(b["rank_bbox"] is not None for b in bands))
            rep.ok(T, f"{seg.prefix} legend", legend is not None)
            doc.close()
            teams, segment_line = extract.extract_results(data)
            got = [(t.rank, t.name, t.club, t.starting_number, t.segment_score, t.element_score,
                    t.component_score, t.deductions) for t in teams]
            want = [(p.rank, p.competitor.name, p.competitor.club, p.start_no, float(p.total), float(p.tes),
                     float(p.pcs), float(p.deductions)) for p in sorted(seg.performances, key=lambda p: p.rank)]
            rep.eq(T, f"{seg.prefix} summary rows", got, want)
            rep.eq(T, f"{seg.prefix} segment line", segment_line, seg.title)
            split = per_skater.split_per_skater(data)
            rep.eq(T, f"{seg.prefix} split pages", fitz.open(stream=split, filetype="pdf").page_count,
                   len(seg.performances))
            name, segment, printed = sm_app.derive_name_and_meta(data)
            rep.eq(T, f"{seg.prefix} page-0 name", (segment, printed),
                   (seg.title, gen.stamp(seg.printed_results)))
            meta = ResultsMeta(competition=gen.COMPETITION_NAME, date="17.-18.10.2026", venue=gen.VENUE,
                               category=cat.name.upper(), supertitle=seg.rule.name.upper(),
                               team_count=len(teams))
            rendered = sm_results.render_results_pdf(meta, teams)
            rep.ok(T, f"{seg.prefix} results page renders", rendered[:5] == b"%PDF-")


# ── names agree across files ──────────────────────────────────────────────────

def check_officials(rep, gen, categories, root):
    from pypdf import PdfReader
    T = "officials"
    for cat in categories.values():
        folder = root / "datasets" / cat.info["dataset"]
        for seg in cat.segments:
            p = seg.prefix
            for suffix, role, label in (("TechnicalControllerSheet", "Technical Controller", "Technical Controller:"),
                                        ("TechnicalSpecialistSheet1", "Technical Specialist 1", "Technical Specialist:"),
                                        ("TechnicalSpecialistSheet2", "Technical Specialist 2", "Technical Specialist:")):
                reader = PdfReader(str(folder / f"{p}_{suffix}.pdf"))
                rep.eq(T, f"{p} {suffix} pages", len(reader.pages), len(seg.performances))
                for page in reader.pages:
                    rep.ok(T, f"{p} {suffix} official", f"{label}   {seg.panel[role].titled}" in page.extract_text())
            text = PdfReader(str(folder / f"{p}_RefereeSheet.pdf")).pages[0].extract_text()
            rep.ok(T, f"{p} referee sheet", seg.panel["Referee"].titled in text)
            text = PdfReader(str(folder / f"{p}_SegmentResults.pdf")).pages[0].extract_text()
            for role in ("Referee", "Technical Controller"):
                rep.ok(T, f"{p} results signature {role}", gen.official_line(seg.panel[role]) in text)
            text = PdfReader(str(folder / f"{p}_PlannedProgramContent.pdf")).pages[0].extract_text()
            rep.ok(T, f"{p} planned content", seg.performances[0].competitor.name in text)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run the tools' parsers on the sample data.")
    parser.add_argument("--dir", type=Path, default=HERE, help="sample_data tree to check (default: here)")
    parser.add_argument("--repos", type=Path, default=Path.home() / "git",
                        help="directory holding the fs-judgepapers, fs-protocolgenerator, fs-scoremodifier checkouts")
    args = parser.parse_args(argv)
    sys.meta_path.insert(0, _AzureStubFinder())
    root = args.dir.resolve()
    rep = Report()
    gen, categories, officials = load_model()

    check_numbers(rep, gen, categories)
    check_officials(rep, gen, categories, root)
    check_jpc(rep, gen, categories, root, args.repos / "fs-judgepapers" / "infra" / "functions")
    structures = check_pg(rep, gen, categories, root, args.repos / "fs-protocolgenerator" / "infra" / "functions")
    check_node(rep, gen, categories, root, structures)
    check_sm(rep, gen, categories, root, args.repos / "fs-scoremodifier")

    failed = 0
    for tool in sorted(set(rep.passed) | set(rep.failed)):
        problems = rep.failed.get(tool, [])
        failed += len(problems)
        print(f"{tool:18s} {rep.passed.get(tool, 0):5d} passed  {len(problems):3d} failed")
        for problem in problems[:15]:
            print("    FAIL", problem)
        if len(problems) > 15:
            print(f"    ... and {len(problems) - 15} more")
    for note in sorted(rep.notes):
        print("note:", note)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
