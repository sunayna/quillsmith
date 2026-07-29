"""
Builds a Data Analysis deck from a folder of per-section CSVs:
one file per class section (VII_A.csv, VII_B.csv, ...), each a "long"
table with one row per (Year, Class, Subject, Standard, S, P, M, E) —
exactly what src/extract/extract.js writes into data/<year>/.

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
from deck_lib import DECK_TEMPLATE, make_chart, assemble

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
            blocks.append({"subject": subject, "title": canon, "classes": merged[canon]})

        we_key = (subject, "__WORK_ETHICS__")
        if we_key in per_row_data:
            we_label = subject_work_ethics_label.get(subject, "Work Ethics")
            blocks.append(
                {"subject": subject, "title": we_label, "classes": per_row_data[we_key]}
            )

    return subject_order, blocks


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

    session_m = re.search(r"(\d{4})[_-](\d{2,4})", os.path.basename(folder.rstrip("/")))
    session_label = f"{session_m.group(1)}-{session_m.group(2)}" if session_m else "Unknown"

    tag = f"G{grade_num}_{session_label.replace('-', '_')}"

    if len(sys.argv) >= 4:
        out_path = sys.argv[3]
        out_path = out_path if os.path.isabs(out_path) else os.path.join(ROOT, out_path)
    else:
        out_path = os.path.join(
            ROOT, "output", session_label.replace("-", "_"),
            f"Grade_{grade_num}_Data_Analysis.pptx",
        )

    print(f"=== reading section CSVs from {folder} (prefix {filename_prefix!r}) ===")
    subject_order, blocks = build_blocks(folder, filename_prefix)
    print("subjects:", subject_order)
    print("total blocks:", len(blocks))

    print("=== rendering charts ===")
    work_dir = os.path.join(ROOT, ".build", tag)
    chart_dir = os.path.join(work_dir, "charts")
    os.makedirs(chart_dir, exist_ok=True)
    for i, b in enumerate(blocks):
        out_chart = os.path.join(chart_dir, f"chart_{i:03d}.png")
        make_chart(b["classes"], out_chart)
        b["chart_path"] = out_chart

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
        session_label=session_label, subtitle_label="",
    )

    print("=== zipping into .pptx ===")
    zip_pptx(unpacked, out_path)

    print("done. deck at:", out_path)


if __name__ == "__main__":
    main()
