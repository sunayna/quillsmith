"""
Parses a "... ASSESSMENT TREES.xlsx" workbook (the source document teachers
fill in with Topic/Standard/Weightage/Assessment/Score-Grade info) into a
structured {subject: {topic_name: {...}}} shape, for driving updates to
reportbee's live Build Structure tree.

This workbook is NOT as clean as reference/standards_*.json's source —
confirmed live, different subjects in the SAME sheet use different label
conventions ("Skill/Topic" vs "Skill Name" vs "Skill" vs "TOPIC N:"),
different "Standard N" vs "Standard N:" punctuation, and put the weightage
value in column C for some subjects but column D for others. There's no
single fixed column layout to trust — this parser reads whichever of
column C/D actually holds a number for a given row, rather than assuming
a fixed position.

Also: different subjects express weightage on different scales — some as
whole percentages (summing to ~100 across siblings), others as fractions
(summing to ~1). Normalized here to whole percentages, per subject, by
checking which scale that subject's own topic weightages sum closest to.

Usage:
  python3 parse_tree_xlsx.py <xlsx_path> <Grade e.g. VII> [Subject]
Prints JSON: {subject: {topic_name: {weightage, standards: [...]}}}
"""
import json
import re
import sys

import openpyxl

GRADE_TO_SHEET = {"IV": "G4", "V": "G5", "VI": "G6", "VII": "G7"}

TOPIC_LABEL_RE = re.compile(r'^(skill(\s*/\s*topic|\s*name)?|topic\s*\d+:?|topic\s*name|project\s*\d+:?)$', re.I)
STANDARD_LABEL_RE = re.compile(r'^standard\s*\d+:?$', re.I)
ASSESSMENTS_LABEL_RE = re.compile(r'^assessments?$', re.I)
MARKS_LABEL_RE = re.compile(r'^marks$', re.I)
WEIGHTAGE_STD_LABEL_RE = re.compile(r'^weightage\s*standard$', re.I)
LT_LABEL_RE = re.compile(r'^lt\s*\d+$', re.I)

# Column headers for a Topic/Standard's own weight -- NOT the same text as
# WEIGHTAGE_STD_LABEL_RE above (that's a row label, "Weightage Standard",
# for an FA/SA split; these are column headers, "Standard Weightage" /
# "Topic Weightage", opposite word order, sitting once per subject in that
# subject's own header row).
HEADER_STD_WEIGHT_RE = re.compile(r'^standard\s*weightage$', re.I)
HEADER_TOPIC_WEIGHT_RE = re.compile(r'^topic\s*weightage$', re.I)

# Any row whose column A matches one of these is a structural row, never a
# subject header -- even when column B happens to be empty on that row
# (e.g. an "Assessments" row with only an "SA" label in column C and
# nothing in B, which otherwise looks exactly like a subject-header row:
# text in A, empty B).
STRUCTURAL_ROW_RE = re.compile(
    r'^(skill(\s*/\s*topic|\s*name)?|topic\s*\d+:?|topic\s*name|project\s*\d+:?|standard\s*\d+:?|'
    r'assessments?|marks|weightage\s*standard|link\s*to\s*report\s*bee|lt\s*\d+)$',
    re.I,
)

# Some subjects (confirmed in Module) write the FA/SA split as one
# descriptive string in a single cell -- "FA=20% , SA=80%" -- rather than
# clean numeric values in separate columns. Extracts (label, percent) pairs.
TEXT_WEIGHT_PAIR_RE = re.compile(r'([A-Za-z]+)\s*=\s*(\d+(?:\.\d+)?)\s*%')

# SEL grades every standard directly on a Rarely/Occasionally/Consistently
# scale (README point 8 under "How it works") -- confirmed there's no
# FA/SA assessment split beneath any of its standards, unlike every other
# subject. row_mark_entry_mode() only ever reads a "grade" signal off an
# assessment's own Marks cell, so with no assessment row to carry that
# signal, SEL's standards would otherwise default to "score" (numeric)
# like everything else. Matched by subject name instead of asking the
# sheet to carry a fake assessment row just to trigger the normal keyword
# check -- deliberately not literal subject_name == "SEL" since the live
# tree/report card refers to it as "Social(/Socio)-Emotional Learning" in
# other contexts (see the reportbee tree screenshot).
SEL_SUBJECT_RE = re.compile(r'\bsel\b|social\s*[-\s]*emotional\s*learning', re.I)


def first_number(*vals):
    for v in vals:
        if isinstance(v, (int, float)):
            return float(v)
    return None


def find_weight_columns(rows):
    """Scans one subject's rows for its own header row (e.g. "Standard |
    ... | Standard Weightage | Topic Weightage") to find which columns
    those two labels actually sit in for THIS subject.

    CONFIRMED live, 2026-08-21 (Grade VII Expedition): these are NOT
    reliably at columns C/D -- a subject with more assessment columns
    (Expedition's SA1-SA4, 4 wide) pushes them further right (Standard
    Weightage at F, Topic Weightage at G in that sheet). Reading fixed
    columns C/D meant both were invisible entirely: Topic Weightage
    (0.7/0.3, explicitly given) was never seen, and the topic-weight-
    derivation fallback (see its own comment) had no standard-level
    weight to derive from either (Standard 1's own weight is ALSO only
    implicit, as the sum of its 4 assessments) -- both projects silently
    fell back to an arbitrary clone template's weight instead, landing on
    the same wrong value for both (reading as "100% each" instead of the
    real 70/30 split).

    Returns (std_col, topic_col), either of which may be None if that
    label wasn't found in the header row at all (some subjects, e.g. an
    older Module sheet, never give Topic Weightage explicitly and rely
    entirely on derivation -- a missing column here must stay a genuine
    "nothing to read", not silently default to a column that isn't
    actually this label). Falls back to the historical (2, 3) only when no
    header row with either label is found anywhere in the block, matching
    every subject shape confirmed before this fix existed.
    """
    for row in rows:
        std_col = None
        topic_col = None
        for idx, cell in enumerate(row):
            if not isinstance(cell, str):
                continue
            text = cell.strip()
            if HEADER_STD_WEIGHT_RE.match(text):
                std_col = idx
            elif HEADER_TOPIC_WEIGHT_RE.match(text):
                topic_col = idx
        if std_col is not None or topic_col is not None:
            # CONFIRMED live, 2026-08-21 (Grade VI Math): the two headers
            # sit in adjacent columns in every confirmed sheet shape
            # (Standard Weightage immediately followed by Topic Weightage),
            # but some subjects' header row only actually labels ONE of
            # them even though a real value sits right next to it (Math:
            # "Standard Weightage" labeled at column C, but D -- which
            # holds the real 0.75/0.25 topic weights -- has no header text
            # at all). Inferring the missing one from that adjacency
            # rather than treating it as "no column at all" is what makes
            # those still-real values readable.
            if std_col is not None and topic_col is None:
                topic_col = std_col + 1
            elif topic_col is not None and std_col is None:
                std_col = topic_col - 1
            return std_col, topic_col
    return 2, 3


def row_mark_entry_mode(cell):
    """Decides ONE assessment's mode from ITS OWN Marks-row cell only --
    "grade"/"rubric"/"EMPS" mentioned there means grade mode; anything else
    (a real number, or nothing at all) means score mode. This is a per-cell
    decision, not a per-standard one -- confirmed live: FA and SA under the
    same standard can genuinely differ (one numeric, one EMPS), so the
    caller must not average this into a single mode for the whole standard
    the way it used to."""
    if isinstance(cell, str) and any(kw in cell.lower() for kw in ('grade', 'rubric', 'emps')):
        return 'grade'
    return 'score'


def parse_subject_block(rows):
    """rows: list of row-tuples (col A..D values) for one subject's block,
    starting at the subject name row. Returns {topic_name: {weightage, standards: [...]}}."""
    topics = {}
    current_topic = None
    current_standard = None
    current_standard_row_index = None
    current_lt_row_index = None
    current_lt_entry = None
    lt_run_length = 0
    raw_topic_weightages = []  # for scale detection
    raw_standard_weightages = []
    std_weight_col, topic_weight_col = find_weight_columns(rows)

    i = 1  # skip the subject-name row itself
    while i < len(rows):
        row = rows[i]
        a = (str(row[0]).strip() if row[0] is not None else "")
        b = row[1] if len(row) > 1 else None
        c = row[2] if len(row) > 2 else None
        d = row[3] if len(row) > 3 else None
        std_weight_val = row[std_weight_col] if std_weight_col is not None and std_weight_col < len(row) else None
        topic_weight_val = row[topic_weight_col] if topic_weight_col is not None and topic_weight_col < len(row) else None

        if a == "" and b is None:
            i += 1
            continue

        if TOPIC_LABEL_RE.match(a) and isinstance(b, str) and b.strip():
            # Topic rows never carry a real mode signal of their own -- per
            # the actual rule, only a leaf FA/SA's own Marks cell can ever
            # indicate "grade"; every other level defaults to "score".
            topic_name = b.strip()
            weight = first_number(topic_weight_val, std_weight_val)
            current_topic = {"name": topic_name, "weightage": weight, "mark_entry_mode": "score", "standards": []}
            topics[topic_name] = current_topic
            current_standard = None
            if weight is not None:
                raw_topic_weightages.append(weight)

        elif STANDARD_LABEL_RE.match(a) and isinstance(b, str) and b.strip() and current_topic is not None:
            # Standards default to "score" too -- the grade/rubric/EMPS
            # signal only ever applies to an individual leaf FA/SA, not the
            # standard as a whole (a standard can have one numeric and one
            # EMPS assessment beneath it at the same time).
            weight = first_number(std_weight_val, topic_weight_val)
            current_standard = {"name": b.strip(), "weightage": weight, "mark_entry_mode": "score", "assessments": []}
            current_standard_row_index = i
            current_lt_row_index = None
            current_lt_entry = None
            lt_run_length = 0
            current_topic["standards"].append(current_standard)
            if weight is not None:
                raw_standard_weightages.append(weight)

        elif LT_LABEL_RE.match(a) and isinstance(b, str) and b.strip() and current_standard is not None:
            # Learning-target sub-item: some subjects (confirmed in Hindi)
            # never give the Standard row itself a weight -- only these LT
            # rows carry weight, and they act as that standard's actual
            # assessment leaves (matching how the live tree names leaf
            # nodes "LT1"/"LT2" directly under a Standard with no separate
            # named "Assessments" row at all). Tracked here (row index +
            # the entry itself) so an Assessments block immediately
            # following THIS row can be recognized as this LT's own FA/SA
            # breakdown below, rather than silently dropped. lt_run_length
            # counts consecutive LT rows since the last Standard row or
            # processed Assessments block -- confirmed live, both real
            # shapes exist: most LTs get their own immediately-following
            # Assessments block (lt_run_length stays 1 at that point), but
            # occasionally two LTs share one trailing block with nothing in
            # between (confirmed: G7's Standard 7, LT1+LT2 then one shared
            # FA/SA) -- genuinely ambiguous which LT it belongs to, so that
            # case is deliberately left alone rather than guessed at (see
            # the Assessments branch below).
            weight = first_number(c, d)
            current_lt_entry = {
                "name": b.strip(),
                "weightage": weight,
                "max_score": None,
                "mark_entry_mode": "score",
                # FA/SA (when a following Assessments block belongs to
                # THIS LT -- see the branch below) nest here as this LT's
                # own children, not flattened into the standard's list.
                # Confirmed live: reportbee's real tree already has this
                # exact depth (Topic -> Standard -> LT -> Assessment), so
                # the LT is a real node to keep, not a placeholder to
                # discard once its composition is known.
                "assessments": [],
            }
            current_standard["assessments"].append(current_lt_entry)
            current_lt_row_index = i
            lt_run_length += 1

        elif (ASSESSMENTS_LABEL_RE.match(a) and current_standard is not None
                and (i == current_standard_row_index + 1
                     or (current_lt_row_index is not None and i == current_lt_row_index + 1 and lt_run_length == 1))):
            # Two positions recognized as belonging to something specific,
            # not a topic-wide trailer to leave alone: immediately after
            # the Standard row (English/Math's convention -- these become
            # the STANDARD's own direct assessments), or immediately after
            # an LT row (Hindi's convention -- these become THAT LT's own
            # nested assessments instead, one level deeper) -- confirmed
            # live in the 2026-27 Hindi sheet, once per standard/LT (not
            # once per topic the way an older Hindi workbook did it --
            # that "topic trailer" shape, if it still exists elsewhere, is
            # still correctly left alone since it won't be adjacent to
            # either row here).
            if current_lt_row_index is not None and i == current_lt_row_index + 1 and lt_run_length == 1:
                target_list = current_lt_entry["assessments"]
            else:
                target_list = current_standard["assessments"]
            lt_run_length = 0
            marks_row = rows[i + 1] if i + 1 < len(rows) else None

            # Assessment names, their "Marks" (out-of score), and their
            # "Weightage Standard" all live in parallel columns starting at
            # B, one column per assessment -- 2 columns (FA/SA) for
            # English/Math, but confirmed up to 4 (SA1-SA4) in Expedition, so
            # this walks however many columns are actually populated rather
            # than assuming a fixed count.
            weight_row = rows[i + 2] if i + 2 < len(rows) else None
            weight_row_b = weight_row[1] if weight_row and len(weight_row) > 1 else None

            # The Marks row (one below Assessments, e.g. "Marks", 15, 15) is
            # the actual out-of score for each assessment -- same column
            # alignment as the assessment names themselves. Read here so it
            # can be carried through as each assessment's max_score;
            # non-numeric placeholders (e.g. "EMPS") are left as None rather
            # than guessed at.
            marks = []
            if marks_row and MARKS_LABEL_RE.match(str(marks_row[0]).strip() if marks_row[0] is not None else ""):
                marks = list(marks_row[1:])

            text_pairs = TEXT_WEIGHT_PAIR_RE.findall(weight_row_b) if isinstance(weight_row_b, str) else []
            if text_pairs:
                # e.g. "FA=20% , SA=80%" in one cell -- overrides whatever
                # was in the Assessments row's own columns (often just a
                # compound label like "FA+SA", not real per-column names).
                # No reliable column alignment to the Marks row in this
                # compact-text convention, so max_score is left unset here.
                for name, pct in text_pairs:
                    # No reliable column alignment to the Marks row in this
                    # compact-text convention, so mode defaults to "score"
                    # (the deterministic default per the actual rule) rather
                    # than guessing.
                    target_list.append({"name": name, "weightage": float(pct), "max_score": None, "mark_entry_mode": "score"})
            else:
                weights = []
                if weight_row:
                    wa = (str(weight_row[0]).strip() if weight_row[0] is not None else "")
                    if WEIGHTAGE_STD_LABEL_RE.match(wa):
                        weights = list(weight_row[1:])
                # Column position (not post-filter index) keeps name/weight/
                # mark aligned even if an earlier column is blank while a
                # later one has a real assessment.
                for col_idx in range(1, len(row)):
                    name = row[col_idx]
                    if not (isinstance(name, str) and name.strip()):
                        continue
                    name = name.strip()
                    w = weights[col_idx - 1] if col_idx - 1 < len(weights) else None
                    m = marks[col_idx - 1] if col_idx - 1 < len(marks) else None
                    target_list.append({
                        "name": name,
                        "weightage": float(w) if isinstance(w, (int, float)) else None,
                        "max_score": float(m) if isinstance(m, (int, float)) else None,
                        # Decided per-assessment from THIS assessment's own
                        # Marks cell only -- "grade"/"rubric"/"EMPS" mentioned
                        # there means grade mode, everything else (a real
                        # number, or nothing) means score.
                        "mark_entry_mode": row_mark_entry_mode(m),
                    })

        elif ASSESSMENTS_LABEL_RE.match(a):
            # An Assessments row that matched neither recognized position
            # above (e.g. two-or-more LTs sharing one trailing block, with
            # nothing resetting the run in between) -- deliberately left
            # unattached to anything (see the branch above), but still
            # resets the LT run count so it doesn't keep accumulating into
            # a later, genuinely single LT within the same standard.
            lt_run_length = 0

        i += 1

    # When a Standard's own row carries no weight at all (confirmed in
    # Hindi -- every "Standard N" row there has None in both weight
    # columns), derive it as the sum of its own LT/assessment children's
    # weights instead. Verified against all three Hindi topics: these sums
    # land exactly on 1.0 across a topic's standards, confirming this is
    # the real intended weighting, not missing data.
    for topic in topics.values():
        for std in topic["standards"]:
            if std["weightage"] is None and std["assessments"]:
                child_weights = [a["weightage"] for a in std["assessments"] if a["weightage"] is not None]
                if child_weights:
                    std["weightage"] = round(sum(child_weights), 6)

    # English/Math's "Assessments" convention: FA/SA sitting directly under
    # a Standard are shares of THAT standard specifically, and should sum
    # to 100 within it. Renormalizing by ratio handles the case where they
    # were entered as fractions (0.2/0.8) rather than already-scaled
    # percentages, as a no-op when they're already percentages (50/50 stays
    # 50/50).
    #
    # CONFIRMED live, 2026-08-21 (Grade VI-A Hindi): this must NOT touch
    # Hindi's LT entries, even though they sit in this same std["assessments"]
    # list -- an LT's own weight is meant to be its raw xlsx value (20, 20,
    # 15) relative to the whole STANDARD (which itself derives as their sum,
    # e.g. 55 -- see the derivation below), not renormalized to sum to 100
    # the way flat English/Math leaves are. Applying this to LTs inflated a
    # 15%-weighted LT to read 27.27%, contradicting the sheet directly.
    # Detected by whether an entry carries its own nested "assessments" --
    # only true leaves (no nested list) ever get renormalized here; an
    # entry with real nested children is an LT, left exactly as parsed.
    for topic in topics.values():
        for std in topic["standards"]:
            if any(a.get("assessments") for a in std["assessments"]):
                continue
            weighted = [a for a in std["assessments"] if a["weightage"] is not None]
            total = sum(a["weightage"] for a in weighted)
            if total > 0:
                for a in weighted:
                    a["weightage"] = round((a["weightage"] / total) * 100, 4)

    # Same rule one level deeper, for an LT's own nested FA/SA (Hindi's
    # convention -- see the LT branch above): those weights are shares of
    # their own LT (e.g. FA=0.2, SA=0.8 of THAT LT), never touched by the
    # standard-level pass above since it only looks at std["assessments"]
    # directly, not into each entry's own nested list.
    for topic in topics.values():
        for std in topic["standards"]:
            for entry in std["assessments"]:
                nested = entry.get("assessments") or []
                weighted = [a for a in nested if a["weightage"] is not None]
                total = sum(a["weightage"] for a in weighted)
                if total > 0:
                    for a in weighted:
                        a["weightage"] = round((a["weightage"] / total) * 100, 4)

    # Scale normalization: if this subject's topic weightages sum close to 1
    # rather than 100, they're fractions -- convert topic/standard weights
    # (not assessments, already normalized to 0-100 above) to whole-percentage.
    topic_sum = sum(raw_topic_weightages) if raw_topic_weightages else 0
    is_fraction_scale = 0 < topic_sum <= 1.5  # sums to ~1, not ~100

    if is_fraction_scale:
        for topic in topics.values():
            if topic["weightage"] is not None:
                topic["weightage"] = round(topic["weightage"] * 100, 4)
            for std in topic["standards"]:
                if std["weightage"] is not None:
                    std["weightage"] = round(std["weightage"] * 100, 4)
    else:
        # Standard-level weightages might still be fractions even when
        # topic-level is already a percentage (seen in Digital Literacy:
        # topic=70 but no per-standard fractions to worry about there).
        # Detect per-scope: if a standard's own weightage is <=1.5 while
        # its topic's is >1.5, scale that one up.
        for topic in topics.values():
            for std in topic["standards"]:
                if std["weightage"] is not None and std["weightage"] <= 1.5:
                    std["weightage"] = round(std["weightage"] * 100, 4)

    # An LT's own weight is deliberately NOT renormalized to sum-to-100
    # above (see that block's own comment) -- it still needs the same
    # fraction -> whole-percentage scaling every other level gets, just
    # applied directly rather than via renormalization, since Hindi's real
    # sheet stores it as a percentage-formatted cell (0.2 for "20%", not
    # 20 -- confirmed live, 2026-08-21). Scoped to entries that carry their
    # own nested assessments (LTs specifically) so a true leaf's already-
    # renormalized 0-100 value is never touched twice.
    for topic in topics.values():
        for std in topic["standards"]:
            for a in std["assessments"]:
                if a.get("assessments") and a["weightage"] is not None and a["weightage"] <= 1.5:
                    a["weightage"] = round(a["weightage"] * 100, 4)

    # A Topic ("PROJECT N:" in Module's own convention) with no Topic
    # Weightage of its own -- confirmed live, 2026-08-21 -- has no signal
    # in apply_tree.js for its intended weight either, so it silently fell
    # back to an arbitrary clone template's weight instead (every topic
    # created in one run clones from the same template, so they all landed
    # on that one value, reading as "split equally" even though nothing
    # was actually computed that way). Derived here as the sum of its own
    # standards' weights instead, the same rule already used above for a
    # standard with no weight of its own -- a Module topic missing its own
    # weightage but with fully-weighted standards beneath it (confirmed:
    # Aravalli Hills 20+25, Crisis to Care 25+10, Crisis Beneath the
    # Concrete 20) is exactly that case. Deliberately last, after both
    # scale-normalization branches above: this sums each standard's
    # *final* percentage-scale weight, not its possibly-still-fractional
    # raw one, so the derived topic weight never needs scaling of its own.
    for topic in topics.values():
        if topic["weightage"] is None and topic["standards"]:
            child_weights = [s["weightage"] for s in topic["standards"] if s["weightage"] is not None]
            if child_weights:
                topic["weightage"] = round(sum(child_weights), 6)

    return topics


def parse_workbook(xlsx_path, grade, subject_filter=None):
    sheet_name = GRADE_TO_SHEET.get(grade)
    if not sheet_name:
        raise SystemExit(f"Unknown grade {grade!r} -- expected one of {list(GRADE_TO_SHEET)}")

    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    if sheet_name not in wb.sheetnames:
        raise SystemExit(f"Sheet {sheet_name!r} not found in {xlsx_path}")
    ws = wb[sheet_name]

    # Column count varies by subject/sheet -- confirmed up to 26 columns in
    # G7 (Expedition puts 4 parallel assessments in B-E alone). A fixed cap
    # of 4 columns silently dropped anything past column D (e.g. Expedition's
    # SA3/SA4), so read every column the sheet actually has.
    all_rows = [
        tuple(ws.cell(row=r, column=c).value for c in range(1, ws.max_column + 1))
        for r in range(1, ws.max_row + 1)
    ]

    # Subject blocks start at a row where column A has text, column B is
    # empty, and the row isn't itself one of the structural rows (topic,
    # standard, assessments, marks, weightage, link) that can *also* have
    # an empty column B (e.g. an "Assessments" row with no FA, only an
    # "SA" label sitting in column C).
    subject_starts = []
    for idx, row in enumerate(all_rows):
        a = row[0]
        b = row[1]
        a_text = a.strip() if isinstance(a, str) else ""
        if (a_text and (b is None or (isinstance(b, str) and not b.strip()))
                and not STRUCTURAL_ROW_RE.match(a_text)):
            subject_starts.append((idx, a_text))

    result = {}
    for i, (start_idx, subject_name) in enumerate(subject_starts):
        # Lenient match: the CLI's subject name doesn't always match the
        # xlsx's own header exactly (confirmed live: "Math" typed by a user
        # vs the xlsx's actual "Mathematics" -- a strict equality check
        # silently matched nothing and produced an empty plan with no
        # error). Substring containment either direction covers this.
        if subject_filter:
            sf, sn = subject_filter.lower().strip(), subject_name.lower().strip()
            if sf not in sn and sn not in sf:
                continue
        end_idx = subject_starts[i + 1][0] if i + 1 < len(subject_starts) else len(all_rows)
        block = all_rows[start_idx:end_idx]
        topics = parse_subject_block(block)
        if SEL_SUBJECT_RE.search(subject_name):
            for topic in topics.values():
                topic["mark_entry_mode"] = "grade"
                for std in topic["standards"]:
                    std["mark_entry_mode"] = "grade"
        result[subject_name] = topics

    return result


def main():
    if len(sys.argv) < 3:
        print("usage: python3 parse_tree_xlsx.py <xlsx_path> <Grade e.g. VII> [Subject]")
        sys.exit(1)
    xlsx_path = sys.argv[1]
    grade = sys.argv[2]
    subject_filter = sys.argv[3] if len(sys.argv) > 3 else None

    result = parse_workbook(xlsx_path, grade, subject_filter)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
