"""
Selects which rows in a raw extraction dump are real Standards.

extract.js deliberately no longer makes this decision live against
reportbee's tree — different years have different, sometimes unpredictable
tree shapes, so there's no fully reliable structural signal ("this is the
Standard" vs "this is a Topic heading, an FA/SA instance, or a rubric
criterion beneath the real standard") to use while extracting. Working
against the finished CSV instead means iterating on the matching logic
never requires reportbee or a browser at all.

Two strategies, picked per subject:
1. If a reference workbook exists for the year (reference/standards_*.json,
   built by build_reference.py / build_reference_2023_24.py), a row is a
   Standard if its NodeName matches one of that grade+subject's known
   standard texts — exact match first, then fuzzy (the xlsx and the live
   tree occasionally have small genuine text drift between them, e.g.
   "घटनाक्रम" vs "घटना-क्रम", not just whitespace/formatting differences).
2. If a subject has no reference coverage at all (e.g. Socio-Emotional
   Learning in the 2023-24 workbook, which has no SEL sheet), fall back to
   picking true leaves — rows with no deeper row beneath them in the same
   file. This is the same shape the old short_name heuristic was
   approximating, just derived structurally instead of guessed from naming
   conventions.

Usage: python3 filter_standards.py <raw-csv-dir> <year-label> [out-dir]
Writes one CSV per input file into <out-dir> (default: <raw-csv-dir>/filtered),
in the Year,Class,Subject,Standard,S,P,M,E format build_deck.py expects.
"""
import csv
import difflib
import json
import os
import re
import sys

REFERENCE_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "reference"))

# Exact overrides for years with their own dedicated reference file.
REFERENCE_FILES = {
    "2023-24": "standards_2023_24.json",
    "2025-26": "standards_2025_26.json",
}

# 2023-24 and earlier had no standardized way to list Standards across
# grades (see build_reference_2023_24.py's docstring for that workbook's
# "old format" layout). From 2024-25 onward the school switched to the
# per-grade "ASSESSMENT TREES" workbook shape ("new format"), first
# captured for 2025-26 — no separate workbook has been produced for
# 2024-25/2026-27/etc, but the standards themselves haven't changed since,
# only the year label, so those years reuse the 2025-26 reference until a
# year-specific one exists.
OLD_FORMAT_CUTOFF_YEAR = 2024
OLD_FORMAT_REFERENCE = "standards_2023_24.json"
NEW_FORMAT_REFERENCE = "standards_2025_26.json"

FUZZY_THRESHOLD = 0.85

# Subject names don't always match between a reference workbook and the
# live tree (हिंदी vs Hindi, Math vs Mathematics, inconsistent SEL naming).
# Substring containment (checked in subjects_match) covers most cases on
# its own; these are the ones that need an explicit equivalence because
# neither name is a substring of the other.
ALIAS_GROUPS = [
    {"sel", "socioemotionallearning", "socialemotionallearning"},
    {"hindi", "हिंदी"},
]


def normalize_key(s):
    s = s.lower()
    return re.sub(r"[^a-z0-9ऀ-ॿ]+", "", s)


def normalize_text(s):
    return re.sub(r"\s+", " ", s.strip().lower())


def subjects_match(live_norm, ref_norm):
    if live_norm == ref_norm:
        return True
    if live_norm in ref_norm or ref_norm in live_norm:
        return True
    for group in ALIAS_GROUPS:
        if live_norm in group and ref_norm in group:
            return True
    return False


def resolve_reference_filename(year_label):
    if year_label in REFERENCE_FILES:
        return REFERENCE_FILES[year_label]
    m = re.match(r"(\d{4})", year_label)
    if not m:
        return None
    start_year = int(m.group(1))
    return OLD_FORMAT_REFERENCE if start_year < OLD_FORMAT_CUTOFF_YEAR else NEW_FORMAT_REFERENCE


def resolve_subject(reference_for_grade, live_subject):
    live_norm = normalize_key(live_subject)
    for ref_subject in reference_for_grade:
        if subjects_match(live_norm, normalize_key(ref_subject)):
            return ref_subject
    return None


def matches_standard(node_name, candidates):
    nn = normalize_text(node_name)
    best_score = 0.0
    for cand in candidates:
        cn = normalize_text(cand)
        if nn == cn:
            return True
        best_score = max(best_score, difflib.SequenceMatcher(None, nn, cn).ratio())
    return best_score >= FUZZY_THRESHOLD


def full_path_of(r):
    return f"{r['Path']} > {r['NodeName']}" if r["Path"] else r["NodeName"]


def dedupe_ancestor_matches(matched_rows):
    """A Standard's own "I can ..." student-facing restatements are close
    paraphrases of their parent by design (shared vocabulary, same meaning),
    so they can cross the fuzzy threshold and match the same reference text
    as their parent. When that happens the parent (shallower node) is the
    real Standard and the child is scored to be dropped — confirmed the
    child is always the deeper node in these cases, never the reverse."""
    full_paths = {full_path_of(r) for r in matched_rows}
    return [
        r for r in matched_rows
        if not any(full_path_of(r) != other and full_path_of(r).startswith(other + " > ") for other in full_paths)
    ]


def process_file(in_path, reference, out_path):
    rows = list(csv.DictReader(open(in_path, encoding="utf-8")))
    if not rows:
        return 0

    grade = rows[0]["Class"].split()[0]
    ref_for_grade = reference.get(grade, {})

    # A row is a leaf if no other row's own ancestry path is exactly this
    # row's path-plus-itself — i.e. nothing deeper was recorded beneath it.
    full_paths_present = {r["Path"] for r in rows if r["Path"]}

    def is_leaf(r):
        return full_path_of(r) not in full_paths_present

    subject_cache = {}
    reference_matches = []
    out_rows = []
    for r in rows:
        subject = r["Subject"]
        if subject not in subject_cache:
            subject_cache[subject] = resolve_subject(ref_for_grade, subject)
        ref_key = subject_cache[subject]
        candidates = ref_for_grade.get(ref_key, []) if ref_key else []

        if candidates:
            if matches_standard(r["NodeName"], candidates):
                reference_matches.append(r)
        elif is_leaf(r):
            out_rows.append(r)

    out_rows.extend(dedupe_ancestor_matches(reference_matches))

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Year", "Class", "Subject", "Standard", "S", "P", "M", "E"])
        for r in out_rows:
            w.writerow([r["Year"], r["Class"], r["Subject"], r["NodeName"], r["S"], r["P"], r["M"], r["E"]])
    return len(out_rows)


def main():
    if len(sys.argv) < 3:
        print("usage: python3 filter_standards.py <raw-csv-dir> <year-label> [out-dir]")
        sys.exit(1)

    raw_dir = sys.argv[1]
    year_label = sys.argv[2]
    out_dir = sys.argv[3] if len(sys.argv) > 3 else os.path.join(raw_dir, "filtered")

    ref_filename = resolve_reference_filename(year_label)
    if ref_filename:
        reference = json.load(open(os.path.join(REFERENCE_DIR, ref_filename), encoding="utf-8"))
        print(f"using reference {ref_filename}")
    else:
        reference = {}
        print(f"⚠️  no reference workbook for year {year_label!r} — every subject falls back to leaf-detection")

    # *_ROC.csv (Socio-Emotional Learning's R/O/C-graded rows, written by
    # extract.js alongside the normal per-section file) uses a completely
    # different column schema -- R/O/C instead of S/P/M/E. process_file()
    # below reads r["S"] unconditionally, so a ROC file would crash with a
    # KeyError rather than silently misbehave; exclude it here instead.
    files = sorted(
        f for f in os.listdir(raw_dir)
        if f.lower().endswith(".csv") and not f.endswith("_ROC.csv")
    )
    if not files:
        raise SystemExit(f"no CSV files found in {raw_dir}")

    for fname in files:
        in_path = os.path.join(raw_dir, fname)
        out_path = os.path.join(out_dir, fname)
        n = process_file(in_path, reference, out_path)
        print(f"  {fname}: {n} standard rows")

    print(f"✅ Filtered CSVs written to {out_dir}")


if __name__ == "__main__":
    main()
