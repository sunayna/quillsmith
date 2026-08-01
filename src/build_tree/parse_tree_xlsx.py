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


def first_number(*vals):
    for v in vals:
        if isinstance(v, (int, float)):
            return float(v)
    return None


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
    raw_topic_weightages = []  # for scale detection
    raw_standard_weightages = []

    i = 1  # skip the subject-name row itself
    while i < len(rows):
        row = rows[i]
        a = (str(row[0]).strip() if row[0] is not None else "")
        b = row[1] if len(row) > 1 else None
        c = row[2] if len(row) > 2 else None
        d = row[3] if len(row) > 3 else None

        if a == "" and b is None:
            i += 1
            continue

        if TOPIC_LABEL_RE.match(a) and isinstance(b, str) and b.strip():
            # Topic rows never carry a real mode signal of their own -- per
            # the actual rule, only a leaf FA/SA's own Marks cell can ever
            # indicate "grade"; every other level defaults to "score".
            topic_name = b.strip()
            weight = first_number(d, c)
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
            weight = first_number(c, d)
            current_standard = {"name": b.strip(), "weightage": weight, "mark_entry_mode": "score", "assessments": []}
            current_standard_row_index = i
            current_topic["standards"].append(current_standard)
            if weight is not None:
                raw_standard_weightages.append(weight)

        elif LT_LABEL_RE.match(a) and isinstance(b, str) and b.strip() and current_standard is not None:
            # Learning-target sub-item: some subjects (confirmed in Hindi)
            # never give the Standard row itself a weight -- only these LT
            # rows carry weight, and they act as that standard's actual
            # assessment leaves (matching how the live tree names leaf
            # nodes "LT1"/"LT2" directly under a Standard with no separate
            # named "Assessments" row at all).
            weight = first_number(c, d)
            current_standard["assessments"].append({
                "name": b.strip(),
                "weightage": weight,
                "max_score": None,
                "mark_entry_mode": "score",
            })

        elif (ASSESSMENTS_LABEL_RE.match(a) and current_standard is not None
                and i == current_standard_row_index + 1):
            # Only treat this as THIS standard's own assessment split when it
            # immediately follows the Standard row (English/Math's
            # convention). Hindi instead puts LT rows in between and this
            # trailer only once per whole TOPIC at the end -- that's a
            # topic-level FA/SA split, not this standard's, so it's
            # deliberately not attached to anything here when it isn't
            # adjacent (confirmed live: attaching it to whatever standard
            # happened to be "current" inflated that standard's weight
            # past 100%).
            marks_row = rows[i + 1] if i + 1 < len(rows) else None

            # Assessment names live in columns B, C (up to 2 parallel assessments
            # observed) on this row; their weightages come 2 rows down on the
            # "Weightage Standard" row, same column positions.
            weight_row = rows[i + 2] if i + 2 < len(rows) else None
            weight_row_b = weight_row[1] if weight_row and len(weight_row) > 1 else None

            # The Marks row (one below Assessments, e.g. "Marks", 15, 15) is
            # the actual out-of score for each assessment -- same column
            # alignment as the assessment names themselves (B/C). Read here
            # so it can be carried through as each assessment's max_score;
            # non-numeric placeholders (e.g. "EMPS") are left as None rather
            # than guessed at.
            marks = []
            if marks_row and MARKS_LABEL_RE.match(str(marks_row[0]).strip() if marks_row[0] is not None else ""):
                marks = [marks_row[1] if len(marks_row) > 1 else None,
                         marks_row[2] if len(marks_row) > 2 else None]

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
                    current_standard["assessments"].append({"name": name, "weightage": float(pct), "max_score": None, "mark_entry_mode": "score"})
            else:
                names = [v.strip() for v in (b, c) if isinstance(v, str) and v.strip()]
                weights = []
                if weight_row:
                    wa = (str(weight_row[0]).strip() if weight_row[0] is not None else "")
                    if WEIGHTAGE_STD_LABEL_RE.match(wa):
                        weights = [weight_row[1] if len(weight_row) > 1 else None,
                                   weight_row[2] if len(weight_row) > 2 else None]
                for idx, name in enumerate(names):
                    w = weights[idx] if idx < len(weights) else None
                    m = marks[idx] if idx < len(marks) else None
                    current_standard["assessments"].append({
                        "name": name,
                        "weightage": float(w) if isinstance(w, (int, float)) else None,
                        "max_score": float(m) if isinstance(m, (int, float)) else None,
                        # Decided per-assessment from THIS assessment's own
                        # Marks cell only -- "grade"/"rubric"/"EMPS" mentioned
                        # there means grade mode, everything else (a real
                        # number, or nothing) means score.
                        "mark_entry_mode": row_mark_entry_mode(m),
                    })

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

    # Assessment/LT weights aren't always expressed relative to their own
    # standard -- Hindi's LT weights are shares of the whole TOPIC (they
    # only sum to 1.0 across all of a topic's standards combined, not
    # per-standard), whereas English's "Assessments" weights already sum to
    # 1.0 within each standard on their own. Renormalizing every standard's
    # assessments to sum to 100 by ratio handles both conventions
    # correctly with the same rule, since English's case is already a no-op
    # under this (0.5/1.0*100 = 50, same as before).
    for topic in topics.values():
        for std in topic["standards"]:
            weighted = [a for a in std["assessments"] if a["weightage"] is not None]
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

    return topics


def parse_workbook(xlsx_path, grade, subject_filter=None):
    sheet_name = GRADE_TO_SHEET.get(grade)
    if not sheet_name:
        raise SystemExit(f"Unknown grade {grade!r} -- expected one of {list(GRADE_TO_SHEET)}")

    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    if sheet_name not in wb.sheetnames:
        raise SystemExit(f"Sheet {sheet_name!r} not found in {xlsx_path}")
    ws = wb[sheet_name]

    all_rows = [
        tuple(ws.cell(row=r, column=c).value for c in range(1, 5))
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
        result[subject_name] = parse_subject_block(block)

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
