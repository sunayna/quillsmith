"""
Tests for parse_tree_xlsx.py's row-parsing logic, built directly from the
real per-subject conventions and bugs found live against the actual
"ASSESSMENT TREES" workbook this session (see module docstring in
parse_tree_xlsx.py for the full narrative behind each convention).

parse_subject_block tests construct row-tuples directly rather than real
xlsx files, since that's the actual unit of parsing logic and needs no I/O.
parse_workbook tests build a throwaway workbook via openpyxl to cover
subject-boundary detection and lenient subject-name matching.
"""
import pytest

from parse_tree_xlsx import (
    first_number,
    parse_subject_block,
    parse_workbook,
    row_mark_entry_mode,
)


# ---------------------------------------------------------------------------
# first_number
# ---------------------------------------------------------------------------

def test_first_number_prefers_first_numeric_arg():
    assert first_number(5, 3) == 5.0


def test_first_number_skips_none_to_find_numeric():
    assert first_number(None, 3) == 3.0


def test_first_number_skips_non_numeric_strings():
    assert first_number("text", None) is None


def test_first_number_all_missing_returns_none():
    assert first_number() is None
    assert first_number(None, None) is None


# ---------------------------------------------------------------------------
# row_mark_entry_mode
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("cell", ["Grade", "some rubric text", "EMPS", "emps"])
def test_row_mark_entry_mode_grade_keywords(cell):
    assert row_mark_entry_mode(cell) == "grade"


@pytest.mark.parametrize("cell", [15, None, "15", ""])
def test_row_mark_entry_mode_defaults_to_score(cell):
    assert row_mark_entry_mode(cell) == "score"


# ---------------------------------------------------------------------------
# parse_subject_block
# ---------------------------------------------------------------------------

def test_mode_is_read_per_assessment_not_per_subject():
    """Regression test for the live English bug: a Marks row with one grade
    leaf and one numeric leaf under the SAME standard must not collapse to a
    single mode for the whole topic/standard -- each assessment keeps its own
    mode, and the topic/standard themselves always stay 'score'."""
    rows = [
        ("English", None, None, None),
        ("Skill/Topic", "Listening and Speaking", 50, None),
        ("Standard 1", "Standard 1", 60, None),
        ("Assessments", "FA", "SA", None),
        ("Marks", "Grade", 15, None),
        ("Weightage Standard", 40, 60, None),
    ]
    result = parse_subject_block(rows)
    topic = result["Listening and Speaking"]
    assert topic["mark_entry_mode"] == "score"

    std = topic["standards"][0]
    assert std["name"] == "Standard 1"
    assert std["mark_entry_mode"] == "score"

    by_name = {a["name"]: a for a in std["assessments"]}
    assert by_name["FA"]["mark_entry_mode"] == "grade"
    assert by_name["SA"]["mark_entry_mode"] == "score"
    assert by_name["SA"]["max_score"] == 15.0
    assert by_name["FA"]["weightage"] == 40.0
    assert by_name["SA"]["weightage"] == 60.0


def test_lt_rows_derive_standard_weight_from_children():
    """Hindi convention: the Standard row itself carries no weight, only its
    LT children do; the standard's weight must be derived as their sum, then
    correctly scaled from fraction to whole-percentage. The Topic itself
    also carries no weight here -- with its one Standard fully accounting
    for the weight, the topic derives its own weight as that same sum too
    (see test_topic_weight_derives_from_standards for the more realistic
    multi-standard case this rule actually exists for)."""
    rows = [
        ("Hindi", None, None, None),
        ("Topic Name", "Vyakaran", None, None),
        ("Standard 1", "Reading", None, None),
        ("LT1", "Fluency", 0.3, None),
        ("LT2", "Comprehension", 0.7, None),
    ]
    result = parse_subject_block(rows)
    topic = result["Vyakaran"]
    assert topic["weightage"] == 100.0

    std = topic["standards"][0]
    assert std["weightage"] == 100.0

    by_name = {a["name"]: a for a in std["assessments"]}
    assert by_name["Fluency"]["weightage"] == 30.0
    assert by_name["Comprehension"]["weightage"] == 70.0
    assert by_name["Fluency"]["mark_entry_mode"] == "score"


def test_topic_weight_derives_from_standards():
    """Module convention: a "PROJECT N:" topic with no Topic Weightage of
    its own, but standards beneath it that do carry real weights (stored as
    fractions, the way a percentage-formatted xlsx cell actually holds
    them) -- confirmed live against a real workbook (Grade VI Expedition):
    the topic's weight must derive as the sum of its own standards',
    computed AFTER those standards are themselves scaled from fraction to
    whole-percentage, not before."""
    rows = [
        ("Module", None, None, None),
        ("PROJECT 1:", "Aravalli Hills", None, None),
        ("Standard 1:", "Water bodies", None, 0.2),
        ("Standard 2:", "Rock cycle", None, 0.25),
    ]
    result = parse_subject_block(rows)
    topic = result["Aravalli Hills"]
    assert topic["weightage"] == 45.0
    assert topic["standards"][0]["weightage"] == 20.0
    assert topic["standards"][1]["weightage"] == 25.0


def test_text_weight_pair_format():
    """Module convention: 'FA=20% , SA=80%' in a single cell instead of clean
    numeric columns."""
    rows = [
        ("Module", None, None, None),
        ("Skill", "Seasons", 100, None),
        ("Standard 1", "Weather patterns", 100, None),
        ("Assessments", "FA+SA", None, None),
        ("Marks", None, None, None),
        ("Weightage Standard", "FA=20% , SA=80%", None, None),
    ]
    result = parse_subject_block(rows)
    std = result["Seasons"]["standards"][0]
    by_name = {a["name"]: a for a in std["assessments"]}
    assert by_name["FA"]["weightage"] == 20.0
    assert by_name["SA"]["weightage"] == 80.0
    assert by_name["FA"]["mark_entry_mode"] == "score"
    assert by_name["FA"]["max_score"] is None


def test_assessment_weights_renormalize_to_100():
    """When per-assessment weights don't already sum to 100 (or 1), they must
    be renormalized by ratio rather than taken at face value."""
    rows = [
        ("SubjectX", None, None, None),
        ("Skill/Topic", "TopicA", 100, None),
        ("Standard 1", "StdA", 100, None),
        ("Assessments", "FA", "SA", None),
        ("Marks", 10, 20, None),
        ("Weightage Standard", 15, 35, None),
    ]
    result = parse_subject_block(rows)
    std = result["TopicA"]["standards"][0]
    by_name = {a["name"]: a for a in std["assessments"]}
    assert by_name["FA"]["weightage"] == 30.0
    assert by_name["SA"]["weightage"] == 70.0
    assert by_name["FA"]["max_score"] == 10.0
    assert by_name["SA"]["max_score"] == 20.0


def test_topic_level_fraction_scale_converts_to_percentage():
    rows = [
        ("Science", None, None, None),
        ("Skill/Topic", "Physics", 0.4, None),
        ("Skill/Topic", "Chemistry", 0.6, None),
    ]
    result = parse_subject_block(rows)
    assert result["Physics"]["weightage"] == 40.0
    assert result["Chemistry"]["weightage"] == 60.0


def test_standard_level_fraction_scale_when_topic_already_percentage():
    """Digital Literacy case: topic-level weights already sum to ~100, but a
    standard's own weight is still a bare fraction and must be scaled up
    independently of the topic-level scale decision."""
    rows = [
        ("Digital Literacy", None, None, None),
        ("Skill/Topic", "Coding", 70, None),
        ("Standard 1", "Basics", 0.5, None),
        ("Skill/Topic", "Internet Safety", 30, None),
    ]
    result = parse_subject_block(rows)
    assert result["Coding"]["weightage"] == 70.0
    std = result["Coding"]["standards"][0]
    assert std["weightage"] == 50.0


def test_topic_always_defaults_to_score_regardless_of_content():
    rows = [
        ("SubjectY", None, None, None),
        ("Skill/Topic", "SomeTopic", 100, None),
        ("Standard 1", "SomeStandard", 100, None),
        ("Assessments", "FA", None, None),
        ("Marks", "Grade", None, None),
        ("Weightage Standard", 100, None, None),
    ]
    result = parse_subject_block(rows)
    assert result["SomeTopic"]["mark_entry_mode"] == "score"
    assert result["SomeTopic"]["standards"][0]["mark_entry_mode"] == "score"


def test_trailing_assessments_row_not_adjacent_is_ignored():
    """Two LTs sharing one trailing FA/SA block with nothing resetting the
    run in between (confirmed live: G7 Hindi's Standard 7, LT1+LT2 then one
    shared block) is genuinely ambiguous which LT it belongs to -- must not
    be guessed at, which would inflate one LT's weight past its real share
    or silently drop the other."""
    rows = [
        ("Hindi", None, None, None),
        ("Topic Name", "Vyakaran", None, None),
        ("Standard 1", "Reading", None, None),
        ("LT1", "Fluency", 0.3, None),
        ("LT2", "Comprehension", 0.7, None),
        ("Assessments", "FA", "SA", None),  # shared trailer, ambiguous
        ("Marks", 20, 20, None),
        ("Weightage Standard", 40, 60, None),
    ]
    result = parse_subject_block(rows)
    std = result["Vyakaran"]["standards"][0]
    names = {a["name"] for a in std["assessments"]}
    assert names == {"Fluency", "Comprehension"}
    assert std["weightage"] == 100.0


def test_single_lt_assessments_nest_under_lt():
    """Confirmed live (G6 Hindi, Standard 1 and 2; and the real live tree,
    which already has this exact depth): when exactly one LT is immediately
    followed by its own Assessments block, that block becomes the LT's own
    NESTED assessments (FA/SA), one level deeper -- the LT itself stays as
    a real node (Topic -> Standard -> LT -> Assessment), not replaced or
    flattened away. A standard with several LTs still derives its own
    weight as their sum, and each LT's own FA/SA split is independent of
    its sibling LTs' weights (always its own 20/80, not scaled by anything
    else) since it's a self-contained nested list now.

    CONFIRMED live, 2026-08-21: an LT's own weight must stay its raw xlsx
    value (just scaled from fraction to percentage, e.g. 0.2 -> 20.0), NOT
    renormalized to sum to 100 within its standard the way flat English/
    Math leaves are -- that renormalization inflated a 15%-weighted LT to
    read 27.27%, contradicting the sheet directly."""
    rows = [
        ("Hindi", None, None, None),
        ("Topic Name", "Shravan", None, None),
        ("Standard 1", "Listening for facts", None, None),
        ("LT1", "Fact gathering", 0.2, None),
        ("Assessments", "FA", "SA", None),
        ("Marks", "Grade", "Grade", None),
        ("Weightage Standard", 0.2, 0.8, None),
        ("Standard 2", "Story elements", None, None),
        ("LT1", "Sequencing events", 0.2, None),
        ("Assessments", "FA", "SA", None),
        ("Marks", "Grade", "Grade", None),
        ("Weightage Standard", 0.2, 0.8, None),
        ("LT2", "Character traits", 0.2, None),
        ("Assessments", "FA", "SA", None),
        ("Marks", "Grade", "Grade", None),
        ("Weightage Standard", 0.2, 0.8, None),
        ("LT3", "Setting description", 0.15, None),
        ("Assessments", "FA", "SA", None),
        ("Marks", "Grade", "Grade", None),
        ("Weightage Standard", 0.2, 0.8, None),
    ]
    result = parse_subject_block(rows)
    topic = result["Shravan"]

    std1 = topic["standards"][0]
    assert std1["weightage"] == 20.0
    assert len(std1["assessments"]) == 1
    lt1 = std1["assessments"][0]
    assert lt1["name"] == "Fact gathering"
    assert lt1["weightage"] == 20.0  # raw xlsx value (0.2), scaled to whole-percent -- not renormalized
    nested1 = {a["name"]: a for a in lt1["assessments"]}
    assert nested1["FA"]["weightage"] == pytest.approx(20.0)
    assert nested1["SA"]["weightage"] == pytest.approx(80.0)
    assert nested1["FA"]["mark_entry_mode"] == "grade"

    std2 = topic["standards"][1]
    assert std2["weightage"] == pytest.approx(55.0)  # 0.2 + 0.2 + 0.15, scaled to whole percent
    assert len(std2["assessments"]) == 3  # LT1, LT2, LT3 stay as real nodes
    lt_names = {a["name"] for a in std2["assessments"]}
    assert lt_names == {"Sequencing events", "Character traits", "Setting description"}
    # Each LT keeps its own raw xlsx weight (scaled to whole-percent), not
    # renormalized to sum to 100 across its sibling LTs.
    by_name2 = {a["name"]: a for a in std2["assessments"]}
    assert by_name2["Sequencing events"]["weightage"] == 20.0
    assert by_name2["Character traits"]["weightage"] == 20.0
    assert by_name2["Setting description"]["weightage"] == 15.0
    # Every LT's own FA/SA split is independent of its weight -- always its
    # own 20/80, not scaled down for the smaller LT3.
    for lt in std2["assessments"]:
        nested = {a["name"]: a for a in lt["assessments"]}
        assert nested["FA"]["weightage"] == pytest.approx(20.0)
        assert nested["SA"]["weightage"] == pytest.approx(80.0)


# ---------------------------------------------------------------------------
# parse_workbook
# ---------------------------------------------------------------------------

def _make_workbook(tmp_path, sheet_name, rows):
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet_name
    for r, row in enumerate(rows, start=1):
        for c, value in enumerate(row, start=1):
            ws.cell(row=r, column=c, value=value)
    path = tmp_path / "tree.xlsx"
    wb.save(path)
    return path


def test_parse_workbook_splits_subjects_and_skips_structural_rows(tmp_path):
    rows = [
        ("English", None, None, None),
        ("Skill/Topic", "Reading", 100, None),
        ("Standard 1", "Std1", 100, None),
        ("Assessments", None, "SA", None),  # empty B, must not start new subject
        ("Weightage Standard", None, 100, None),
        ("Marks", None, 20, None),
        ("Mathematics", None, None, None),
        ("Skill/Topic", "Numbers", 100, None),
        ("PROJECT 1:", None, None, None),  # empty placeholder, must not start new subject
        ("Science", None, None, None),
        ("Skill/Topic", "Physics", 100, None),
    ]
    path = _make_workbook(tmp_path, "G7", rows)

    result = parse_workbook(str(path), "VII")
    assert set(result.keys()) == {"English", "Mathematics", "Science"}
    assert "Reading" in result["English"]
    assert "Numbers" in result["Mathematics"]
    assert "Physics" in result["Science"]


def test_parse_workbook_subject_filter_is_lenient_substring_match(tmp_path):
    rows = [
        ("English", None, None, None),
        ("Skill/Topic", "Reading", 100, None),
        ("Mathematics", None, None, None),
        ("Skill/Topic", "Numbers", 100, None),
    ]
    path = _make_workbook(tmp_path, "G7", rows)

    result = parse_workbook(str(path), "VII", subject_filter="Math")
    assert set(result.keys()) == {"Mathematics"}


def test_parse_workbook_unknown_grade_raises():
    with pytest.raises(SystemExit):
        parse_workbook("irrelevant.xlsx", "III")


def test_parse_workbook_missing_sheet_raises(tmp_path):
    path = _make_workbook(tmp_path, "G4", [("English", None, None, None)])
    with pytest.raises(SystemExit):
        parse_workbook(str(path), "VII")
