# Quillsmith

Extracts marks/grade data straight from reportbee's own API (not by clicking
through the UI) and builds a Data Analysis slide deck from it — one command
per grade, from raw data to finished `.pptx`.

This replaces two older, separate, manual pipelines:
- **netbot** — scraped reportbee by clicking through every single standard in
  the UI (~7 seconds each, multiplied by every leaf in the tree).
- **Term Data** — took the CSVs netbot produced and built a deck from them as
  a second, manual step, using a chart/slide template that lived in a
  temporary Claude session scratchpad path (fragile — could vanish any time).

Quillsmith does both in one pipeline, extracts via direct API calls instead
of clicking, and keeps its own deck template as a permanent project asset.

## How it works

reportbee's "Enter / View Marks → View Analysis" flow calls one endpoint:

```
GET {baseUrl}/rb_records/exam_plan_node_marks/fetch
  ?plan_id=...&selected_node_uuid=...&authenticity_token=...
  &access_token=...&current_user_profile_id=...
```

This always returns marks + tree info for exactly the node you asked about
plus its *direct* children — never deeper, and only reliably for nodes it's
actually valid to query directly (see the plan_id note below). So `extract.js`
uses Puppeteer for real UI navigation only as far as it has to, then switches
to pure API calls:

1. **Year** is a global-header setting (a "Year Change" popup off
   `#year-link`), *not* a node inside the tree — the tree's own root node
   just happens to display whatever year is currently selected, which looks
   like a clickable year node but isn't one. `switchYear()` handles this
   properly: converts the short form (`2025-26`) to the full form reportbee's
   popup actually lists (`2025-2026`), and clicks the matching option if the
   page isn't already on it. Confirmed the hard way: treating the tree's
   year label as clickable silently extracted the wrong year's data while
   labeling the output with the year you'd asked for.
2. Real clicks are used for: switching grade/section, and expanding each
   Assessment-level node (e.g. "Assessment 2") — just enough to load its
   children (Subjects, and any direct non-Subject leaves) into D3's
   `__data__`, read for free with no further clicking.
3. **One click** on some node's "Enter / View Marks" link intercepts the
   resulting network response to read off `access_token` and
   `current_user_profile_id` (session-level values, not tied to that
   specific node); `authenticity_token` comes from the page's
   `<meta name="csrf-token">` tag.
4. From an Assessment-level node's children onward, everything is pure API
   recursion (`collectViaApi`) — no more clicking, ever. The key fact that
   makes this safe: a Subject's own `plan_id` (read for free from its
   parent's D3 data) stays correct for every descendant all the way to true
   leaves — confirmed by testing multiple levels deep. This also sidesteps
   an accordion-style UI quirk: the tree view only keeps one branch's
   descendants rendered at a time, so drilling into one subject via real
   clicks was silently dropping sibling subjects' data before this fix.
5. Recursion stops at the real **Standard** level using
   `reference/standards_2025_26.json` — a ground-truth list of actual
   standard text per grade/subject, built from the school's own "ASSESSMENT
   TREES" workbook (`reference/build_reference.py`). This exists because
   there's no fully reliable structural signal in reportbee's own tree for
   "this is the Standard" versus "this is a Topic heading, an assessment
   instance (FA/SA), or a rubric criterion beneath the real standard" — a
   short_name convention (`"S1"`, `"S2"`, ...) looked like that signal at
   first but wasn't: on one Expedition standard, a topic heading *and* the
   real standard beneath it both matched `S<n>`. Node names are matched
   against the reference with exact-then-fuzzy (Levenshtein similarity)
   comparison, since the xlsx and the live tree occasionally have small
   genuine text drift between them (not just whitespace/formatting).
   Subject names also don't always match between the two sources (`हिंदी`
   vs `Hindi`, `Math` vs `Mathematics`, inconsistent SEL naming) —
   `resolveSubjectKey()` bridges these. Falls back to the old short_name
   heuristic only when no reference data covers a subject.
6. Standard names come straight from the API's raw JSON, which can contain
   literal commas or embedded newlines (unlike the old scraper's truncated
   DOM text) — CSV fields are written with proper RFC4180 quoting to avoid
   silently corrupting rows.
7. Writes one CSV per section to `data/<year>/<Grade>_<Section>.csv`, format
   `Year,Class,Subject,Standard,S,P,M,E`.

Each grade's actual section list (A–H, sometimes more) is **discovered live**
from reportbee's own grade/section picker (`discoverSections`) rather than
hand-maintained in config — different grades don't all have the same
sections, and the school can add one (e.g. a grade gaining a section "I")
without the config silently going stale.

Then `build_deck.py`:

1. Reads every section CSV for a grade, clusters near-duplicate standard
   titles (a safety net — matters less now that titles come from clean API
   JSON instead of truncated DOM text, but harmless to keep).
2. Renders a stacked S/P/M/E bar chart per standard (`deck_lib.py`,
   matplotlib) across all sections.
3. Assembles a `.pptx` by copying the blank deck template
   (`assets/deck_template/`) and injecting one divider slide per subject
   plus one chart slide per standard, then zips it into a real `.pptx`.

## Setup

**Node side** (extraction):
```bash
npm install
```

**Python side** (deck building):
```bash
pip install -r requirements.txt
```

**Chrome**, with remote debugging on a *separate* profile — reportbee's site
silently ignores `--remote-debugging-port` on your normal default profile
(a Chrome 136+ security change), so it needs its own profile directory:
```bash
osascript -e 'quit app "Google Chrome"'   # only if Chrome is already open
open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/chrome-debug-profile"
```
Log into reportbee.com in that window and leave it open. Verify the debug
port is live:
```bash
curl -s http://localhost:9222/json/version
```

## Usage

Edit `config/batch.json` for the year, terms, and which grades to run — just
a list of grade names, no per-grade section list to maintain:

```json
{
  "year": "2025-26",
  "terms": ["Term 2"],
  "grades": ["VII", "VI", "V", "IV"]
}
```

Then:

```bash
./run.sh VII
```

This discovers Grade VII's actual sections live, extracts every one, writes
their CSVs to `data/2025_26/`, and builds
`output/2025_26/Grade_7_Data_Analysis.pptx`.

Pass `--skip-deck` to only run extraction (e.g. while iterating on the
extractor itself):
```bash
./run.sh VII --skip-deck
```

To extract a single section manually (useful for debugging):
```bash
node src/extract/extract.js
# then answer the prompts: Grade and Section, Year, Term, Patch subjects
```

To build a deck from CSVs that already exist in `data/`:
```bash
python3 src/deck/build_deck.py data/2025_26 "Grade 7"
```

## Project layout

```
config/batch.json       — grade/section/year/term list for a batch run
assets/deck_template/   — blank deck skeleton (unpacked .pptx), permanent asset
reference/build_reference.py     — parses the school's "ASSESSMENT TREES"
                                    xlsx into a ground-truth standards list
reference/standards_2025_26.json — that list; grade -> subject -> [standard text]
src/extract/extract.js  — API-based extractor; exports extractSection() + a CLI
src/batch.js            — loops extractSection() over a grade's sections, then
                           calls build_deck.py
src/deck/deck_lib.py    — chart rendering + slide XML assembly
src/deck/build_deck.py  — reads data/<year>/*.csv, builds the .pptx
data/<year>/            — extraction output (git-ignored)
output/<year>/          — finished decks (git-ignored)
```

## Known constraints

- `access_token`/`authenticity_token` are session-bound. If a batch run is
  long enough for the session to expire mid-run, later sections in that
  batch will fail with a clear auth error — rerun `./run.sh` to resample.
- The tree-walking recursion assumes the API always returns `[queried node,
  its direct children]`, that `type === "course_paper"` marks the Subject
  level, and that a Subject's `plan_id` is valid for every descendant below
  it — all confirmed against reportbee's actual responses, but if reportbee
  changes its API shape this will need revisiting.
- `switchYear`/`switchGradeSection` depend on specific reportbee UI markup
  (`#year-link`, `#year-popup`, `a.standard-js`, `a.section-js`, the
  `.card-footer a.btn.gamma-btn` "View" button). If reportbee redesigns
  these pages, navigation will need updating even though the underlying API
  extraction wouldn't.
- Only tested so far against Grades IV, V, VI, VII for the 2023-24 (verified
  correct data) and 2025-26 (year-switching verified, full batch pending
  re-verification after the year-switching fix) academic years.
- `reference/standards_2025_26.json` is a **snapshot for one specific term's
  workbook**. A new term/year needs a fresh xlsx from the school and a
  re-run of `build_reference.py` against it — extraction still works without
  it (falls back to the short_name heuristic, which is less reliable but not
  broken), so this degrades gracefully rather than failing outright.
