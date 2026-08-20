"""
Builds a Data Analysis deck from a folder of per-section CSVs:
one file per class section (VII_A.csv, VII_B.csv, ...), each a "long"
table with one row per (Year, Class, Subject, Standard, S, P, M, E) —
what src/filter/filter_standards.py writes after selecting Standard rows
out of extract.js's raw per-node dump (data/<year>/<term>/filtered/).

Ported from the Term Data project's section_csv_deck.py. That version
left the assembled deck as an unpacked directory and relied on a manual
zip/soffice step afterward; this version zips it into a real .pptx
itself so the whole pipeline is one command end to end.

Usage: python3 build_deck.py <data-folder> "Grade 7" [output-path]
"""
import csv
import difflib
import json
import os
import re
import shutil
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from deck_lib import (
    DECK_TEMPLATE, make_chart, make_hbar_chart, make_donut_chart, assemble,
    ROC_STACK_ORDER, ROC_COLORS, ROC_LEGEND_ORDER,
)

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROMAN = {
    "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7,
    "VIII": 8, "IX": 9, "X": 10, "XI": 11, "XII": 12,
}


def norm(s):
    s = s.lower()
    s = re.sub(r"[^a-z0-9ऀ-ॿ]+", "", s)
    return s


def clean_title(text):
    text = str(text).replace("\n", " ").replace("\t", " ")
    text = text.lstrip("●").strip()
    text = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", text)  # camelCase wrap artifact
    text = re.sub(r"\s+", " ", text).strip()
    return text


def class_label_from_filename(fname):
    # "VII_A.csv" -> "7A"
    stem = os.path.splitext(os.path.basename(fname))[0]
    m = re.match(r"([IVXLC]+)_([A-Za-z]+)", stem)
    if m and m.group(1) in ROMAN:
        return f"{ROMAN[m.group(1)]}{m.group(2).upper()}"
    return stem


def parse_section_csv(path):
    """Returns [(subject, raw_title, is_work_ethics, S, P, M, E), ...].

    The Standard column can contain an unescaped comma (e.g. "Analyses
    the diverse types of sources, th..."), which shifts every column
    after it. Year/Class/Subject are always the first 3 fields and
    S/P/M/E are always the last 4, so anchor on those instead of fixed
    positions and let the title absorb whatever's left in between.
    """
    rows = list(csv.reader(open(path)))
    out = []
    for r in rows[1:]:
        if len(r) < 8:
            continue
        subject = r[2].strip()
        title = ",".join(r[3:-4]).strip()
        try:
            s, p, m, e = (int(round(float(x))) for x in r[-4:])
        except ValueError:
            continue
        is_we = title.lstrip().startswith("●")
        out.append((subject, title, is_we, s, p, m, e))
    return out


def parse_roc_csv(path):
    """Returns [(R, O, C), ...], one tuple per real standard row in a
    section's raw *_ROC.csv (Year,Class,Subject,Path,NodeName,Type,
    ShortName,R,O,C). Only Type == "regular_paper" rows are kept -- the
    file also carries a "course_paper" rollup row (same NodeName as the
    subject itself, one per exam) that would double-count marks against
    the standards beneath it. Unlike parse_section_csv, no comma-anchoring
    is needed here: these are raw extractor rows with proper RFC4180
    quoting (README point 6), not the filtered format's rewritten Standard
    column."""
    rows = list(csv.reader(open(path)))
    out = []
    for r in rows[1:]:
        if len(r) < 10 or r[5].strip() != "regular_paper":
            continue
        try:
            out.append(tuple(int(round(float(x))) for x in r[-3:]))
        except ValueError:
            continue
    return out


def build_sel_summary(raw_folder, filename_prefix):
    """Aggregates Social Emotional Learning's R/O/C marks across every
    section's raw *_ROC.csv for this grade -- SEL is on a different scale
    than S/P/M/E (README point 8) so it never enters build_blocks()/
    subject_order, and needs its own parallel aggregation here. students
    is the same per-section-max-then-sum headcount proxy
    subject_student_count uses for S/P/M/E subjects. Returns None if this
    grade/term has no ROC data at all (e.g. a folder with no SEL results
    yet, or an older term before SEL was graded on this scale)."""
    if not os.path.isdir(raw_folder):
        return None
    files = sorted(f for f in os.listdir(raw_folder) if f.lower().endswith("_roc.csv"))
    if filename_prefix is not None:
        files = [f for f in files if f.startswith(filename_prefix)]
    if not files:
        return None

    totals = {"R": 0, "O": 0, "C": 0}
    per_section_max = {}
    standard_count = 0
    for fname in files:
        cls = class_label_from_filename(fname)
        rows = parse_roc_csv(os.path.join(raw_folder, fname))
        standard_count = max(standard_count, len(rows))
        section_max = 0
        for r, o, c in rows:
            totals["R"] += r
            totals["O"] += o
            totals["C"] += c
            section_max = max(section_max, r + o + c)
        per_section_max[cls] = section_max

    if sum(totals.values()) == 0:
        return None
    return {
        "totals": totals,
        "students": sum(per_section_max.values()),
        "sections": len(files),
        "standards": standard_count,
    }


def cluster_titles(raw_titles, threshold=0.72):
    """Groups near-duplicate raw title strings (same standard, different
    per-section wording/casing) into clusters, keyed by first raw title
    seen. Returns {raw_title: canonical_cleaned_title}.

    With the API-based extractor this matters less than it used to (no
    more DOM-truncated titles), but harmless to keep as a safety net —
    section CSVs could still disagree slightly if a standard's wording
    was edited mid-term.
    """
    clusters = []  # [{"canonical_raw": str, "members": [str]}]
    for t in raw_titles:
        nt = norm(t)
        best, best_score = None, 0.0
        for cl in clusters:
            score = difflib.SequenceMatcher(None, nt, norm(cl["canonical_raw"])).ratio()
            if score > best_score:
                best_score, best = score, cl
        if best and best_score >= threshold:
            best["members"].append(t)
            if len(clean_title(t)) > len(clean_title(best["canonical_raw"])):
                best["canonical_raw"] = t
        else:
            clusters.append({"canonical_raw": t, "members": [t]})

    mapping = {}
    for cl in clusters:
        canonical = clean_title(cl["canonical_raw"])
        for member in cl["members"]:
            mapping[member] = canonical
    return mapping


def build_blocks(folder, filename_prefix=None):
    files = sorted(f for f in os.listdir(folder) if f.lower().endswith(".csv"))
    if filename_prefix is not None:
        # the folder may hold multiple grades' section CSVs side by side
        # (e.g. "VI_A.csv" and "VII_A.csv") — only take this grade's own
        files = [f for f in files if f.startswith(filename_prefix)]
    if not files:
        raise SystemExit(f"no CSV files found in {folder} matching prefix {filename_prefix!r}")

    subject_raw_titles = {}
    subject_work_ethics_label = {}
    per_row_data = {}
    subject_order = []

    for fname in files:
        cls = class_label_from_filename(fname)
        for subject, raw_title, is_we, s, p, m, e in parse_section_csv(
            os.path.join(folder, fname)
        ):
            if subject not in subject_order:
                subject_order.append(subject)
            if is_we:
                subject_work_ethics_label.setdefault(subject, clean_title(raw_title))
                key = (subject, "__WORK_ETHICS__")
            else:
                subject_raw_titles.setdefault(subject, [])
                if raw_title not in subject_raw_titles[subject]:
                    subject_raw_titles[subject].append(raw_title)
                key = (subject, raw_title)
            per_row_data.setdefault(key, {})[cls] = {"S": s, "P": p, "M": m, "E": e}

    blocks = []
    for subject in subject_order:
        raw_titles = subject_raw_titles.get(subject, [])
        title_map = cluster_titles(raw_titles)

        canonical_order = []
        merged = {}
        for raw in raw_titles:
            canon = title_map[raw]
            if canon not in merged:
                merged[canon] = {}
                canonical_order.append(canon)
            merged[canon].update(per_row_data[(subject, raw)])

        for canon in canonical_order:
            blocks.append({"subject": subject, "title": canon, "classes": merged[canon], "is_work_ethics": False})

        we_key = (subject, "__WORK_ETHICS__")
        if we_key in per_row_data:
            we_label = subject_work_ethics_label.get(subject, "Work Ethics")
            blocks.append(
                {"subject": subject, "title": we_label, "classes": per_row_data[we_key], "is_work_ethics": True}
            )

    return subject_order, blocks


def sum_spme(counts_list):
    total = {"S": 0, "P": 0, "M": 0, "E": 0}
    for c in counts_list:
        for k in total:
            total[k] += c.get(k, 0)
    return total


def build_subject_grade_summary(blocks):
    """{subject: {S,P,M,E}} -- every standard and every section summed, one
    bar per subject. The grade-wide "how's each subject doing" dashboard."""
    result = {}
    for b in blocks:
        result.setdefault(b["subject"], []).append(b["classes"].values())
    return {subj: sum_spme([c for classes in lists for c in classes]) for subj, lists in result.items()}


def build_subject_section_summary(blocks, subject):
    """{section: {S,P,M,E}} for one subject -- every standard summed,
    sections kept separate. Answers "which section is struggling" within
    a subject, the way the per-standard charts already do per-standard."""
    per_section = {}
    for b in blocks:
        if b["subject"] != subject:
            continue
        for section, counts in b["classes"].items():
            per_section.setdefault(section, []).append(counts)
    return {sec: sum_spme(counts) for sec, counts in per_section.items()}


def build_subject_standard_summary(blocks, subject):
    """({standard_title: {S,P,M,E}}, [title order]) for one subject -- every
    section summed per standard. A one-chart overview of every standard in
    a subject, before drilling into each standard's own per-section detail
    (the existing per-block charts)."""
    summary = {}
    order = []
    for b in blocks:
        if b["subject"] != subject:
            continue
        summary[b["title"]] = sum_spme(b["classes"].values())
        order.append(b["title"])
    return summary, order


def proficiency_pct(counts):
    total = sum(counts.values())
    return (counts["M"] + counts["E"]) / total * 100 if total else 0.0


def sort_by_proficiency_desc(summary):
    return sorted(summary.keys(), key=lambda k: -proficiency_pct(summary[k]))


def subject_student_count(blocks, subject):
    """Approximates a subject's student roster: for each section, take the
    max total (S+P+M+E) seen across that subject's standards (tolerating a
    few students missing marks on any single standard), then sum across
    sections -- there's no per-student ID in this data, only per-node
    counts, so this is the closest available proxy for a headcount."""
    per_section_max = {}
    for b in blocks:
        if b["subject"] != subject:
            continue
        for section, counts in b["classes"].items():
            total = sum(counts.values())
            per_section_max[section] = max(per_section_max.get(section, 0), total)
    return sum(per_section_max.values())


def grade_wide_stats(blocks, subject_order):
    """Grade-wide dashboard numbers: student roster, subject count, real
    (non-Work-Ethics) standard count, and the S/P/M/E percentage split
    across every mark in the grade. Roster size is the largest of any one
    subject's own count (approximates the full non-elective grade roster --
    confirmed against the reference template: its Grade-wide and
    core-subject student counts were identical)."""
    real_blocks = [b for b in blocks if not b.get("is_work_ethics")]
    students = max((subject_student_count(blocks, s) for s in subject_order), default=0)
    totals = sum_spme([c for b in blocks for c in b["classes"].values()])
    total_marks = sum(totals.values())
    pct = {k: (v / total_marks * 100 if total_marks else 0.0) for k, v in totals.items()}
    return {"students": students, "subjects": len(subject_order), "standards": len(real_blocks), "pct": pct}


def subject_stats(blocks, subject):
    """Per-subject stat-slide numbers: students assessed, section count, and
    real (non-Work-Ethics) standard count."""
    subject_blocks = [b for b in blocks if b["subject"] == subject]
    real_blocks = [b for b in subject_blocks if not b.get("is_work_ethics")]
    sections = {sec for b in subject_blocks for sec in b["classes"]}
    return {"students": subject_student_count(blocks, subject), "sections": len(sections), "standards": len(real_blocks)}


def subject_mastery_pct(blocks, subject_order):
    """{subject: M+E%}, for the "Average Mastery Rate by Subject" bar."""
    summary = build_subject_grade_summary(blocks)
    return {subj: proficiency_pct(summary[subj]) for subj in subject_order if subj in summary}


def zip_pptx(unpacked_dir, out_path):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    if os.path.exists(out_path):
        os.remove(out_path)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(unpacked_dir):
            for f in files:
                full = os.path.join(root, f)
                arcname = os.path.relpath(full, unpacked_dir)
                zf.write(full, arcname)


def main():
    if len(sys.argv) < 3:
        print('usage: python3 build_deck.py <data-folder> "Grade 7" [output-path]')
        sys.exit(1)

    folder_arg = sys.argv[1]
    folder = folder_arg if os.path.isabs(folder_arg) else os.path.join(ROOT, folder_arg)
    grade_label = sys.argv[2]
    grade_num_m = re.search(r"\d+", grade_label)
    grade_num = grade_num_m.group(0) if grade_num_m else grade_label
    roman = {v: k for k, v in ROMAN.items()}.get(int(grade_num)) if grade_num.isdigit() else None
    filename_prefix = f"{roman}_" if roman else None

    # data/<year>/<term>/ means neither the year nor the term pattern is
    # necessarily in the immediate folder name — walk every path component
    # looking for each independently (a folder called just "Term_1" won't
    # match the year pattern, and vice versa).
    session_label = "Unknown"
    term_num = None
    for part in os.path.normpath(folder).split(os.sep):
        if session_label == "Unknown":
            ym = re.search(r"(\d{4})[_-](\d{2,4})", part)
            if ym:
                session_label = f"{ym.group(1)}-{ym.group(2)}"
        if term_num is None:
            tm = re.search(r"term[_ ]?(\d+)", part, re.I)
            if tm:
                term_num = tm.group(1)
    subtitle_label = f"(TERM {term_num})" if term_num else ""
    term_folder = f"Term_{term_num}" if term_num else None

    tag = f"G{grade_num}_{session_label.replace('-', '_')}" + (f"_T{term_num}" if term_num else "")

    if len(sys.argv) >= 4:
        out_path = sys.argv[3]
        out_path = out_path if os.path.isabs(out_path) else os.path.join(ROOT, out_path)
    else:
        out_dir = [ROOT, "output", session_label.replace("-", "_")]
        if term_folder:
            out_dir.append(term_folder)
        name_suffix = f"_{term_folder}" if term_folder else ""
        out_path = os.path.join(*out_dir, f"Grade_{grade_num}{name_suffix}_Data_Analysis.pptx")

    print(f"=== reading section CSVs from {folder} (prefix {filename_prefix!r}) ===")
    subject_order, blocks = build_blocks(folder, filename_prefix)
    print("subjects:", subject_order)
    print("total blocks:", len(blocks))

    # SEL's raw *_ROC.csv companions live one level up from `folder` when
    # `folder` is the usual .../filtered dir (they're never filtered --
    # build_blocks()/filter_standards.py don't read them at all, see
    # README point 8) -- fall back to `folder` itself for a caller that
    # already points at the raw dir directly.
    raw_folder = folder
    if os.path.basename(os.path.normpath(folder)).lower() == "filtered":
        raw_folder = os.path.dirname(os.path.normpath(folder))
    sel_summary = build_sel_summary(raw_folder, filename_prefix)
    if sel_summary:
        print("SEL:", sel_summary["students"], "students,", sel_summary["standards"], "standards")

    print("=== rendering charts ===")
    work_dir = os.path.join(ROOT, ".build", tag)
    chart_dir = os.path.join(work_dir, "charts")
    os.makedirs(chart_dir, exist_ok=True)
    for i, b in enumerate(blocks):
        out_chart = os.path.join(chart_dir, f"chart_{i:03d}.png")
        make_chart(b["classes"], out_chart)
        b["chart_path"] = out_chart

    print("=== rendering summary charts ===")
    grade_summary = build_subject_grade_summary(blocks)
    grade_chart_path = None
    if grade_summary:
        grade_order = sort_by_proficiency_desc(grade_summary)
        grade_chart_path = os.path.join(chart_dir, "grade_summary.png")
        make_chart(grade_summary, grade_chart_path, label_order=grade_order,
                   xlabel="Subject", rotate_labels=20, label_maxlen=18, show_percent=True)

    mastery_chart_path = None
    if grade_summary:
        mastery = subject_mastery_pct(blocks, subject_order)
        mastery_chart_path = os.path.join(chart_dir, "mastery_by_subject.png")
        make_hbar_chart(mastery, mastery_chart_path, xlabel="Average Mastery Rate (%)", label_maxlen=20)

    grade_stats = grade_wide_stats(blocks, subject_order)
    subject_stats_map = {subject: subject_stats(blocks, subject) for subject in subject_order}
    period_label = f"Term {term_num} {session_label}".strip() if term_num else session_label

    subject_donut_chart = {}
    subject_section_chart = {}
    subject_standard_chart = {}
    for subject in subject_order:
        if subject in grade_summary:
            p = os.path.join(chart_dir, f"donut_{norm(subject)}.png")
            make_donut_chart(grade_summary[subject], p)
            subject_donut_chart[subject] = p

        section_summary = build_subject_section_summary(blocks, subject)
        if section_summary:
            p = os.path.join(chart_dir, f"section_summary_{norm(subject)}.png")
            make_chart(section_summary, p, xlabel="Class and Section", show_percent=True)
            subject_section_chart[subject] = p

        standard_summary, standard_order = build_subject_standard_summary(blocks, subject)
        if standard_summary:
            p = os.path.join(chart_dir, f"standard_summary_{norm(subject)}.png")
            make_chart(standard_summary, p, label_order=standard_order,
                       xlabel="Standard", rotate_labels=20, label_maxlen=22, show_percent=True)
            subject_standard_chart[subject] = p

    sel_donut_chart_path = None
    if sel_summary:
        sel_donut_chart_path = os.path.join(chart_dir, "donut_sel.png")
        make_donut_chart(sel_summary["totals"], sel_donut_chart_path,
                          stack_order=ROC_STACK_ORDER, colors=ROC_COLORS, legend_order=ROC_LEGEND_ORDER)

    json.dump(
        {"subject_order": subject_order, "blocks": blocks},
        open(os.path.join(work_dir, "data.json"), "w"),
        ensure_ascii=False, indent=2,
    )

    print("=== assembling deck ===")
    unpacked = os.path.join(work_dir, "unpacked")
    if os.path.exists(unpacked):
        shutil.rmtree(unpacked)
    shutil.copytree(DECK_TEMPLATE, unpacked)

    assemble(
        unpacked, subject_order, blocks, grade_num,
        session_label=session_label, subtitle_label=subtitle_label,
        grade_chart_path=grade_chart_path,
        subject_donut_chart=subject_donut_chart,
        grade_summary=grade_summary,
        subject_section_chart=subject_section_chart,
        subject_standard_chart=subject_standard_chart,
        mastery_chart_path=mastery_chart_path,
        grade_stats=grade_stats,
        subject_stats_map=subject_stats_map,
        period_label=period_label,
        sel_summary=sel_summary,
        sel_donut_chart_path=sel_donut_chart_path,
    )

    print("=== zipping into .pptx ===")
    zip_pptx(unpacked, out_path)

    print("done. deck at:", out_path)


if __name__ == "__main__":
    main()
