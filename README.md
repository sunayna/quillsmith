# Quillsmith

Extracts marks/grade data straight from reportbee's own API and builds a
Data Analysis slide deck from it — one command per grade, from raw data to
finished `.pptx`.

**Requires a reportbee login for this school.** This isn't a general-purpose
tool — it's built against The Heritage School Gurgaon's own
`theheritageschoolggn.reportbee.com` tenant (URLs, DOM structure, and the
exam-plan tree layout are all specific to it). Without login access to that
account, none of this runs; you can still read the code, but there's nothing
to point it at.

## Run this

Works the same on macOS, Windows, and Linux — every script below has both a
`.command`/`.sh` (macOS/Linux) and a `.bat` (Windows) version. The only
per-OS prerequisite is that "Python" means `python3` on macOS/Linux and
`python` on Windows (the official Windows installer doesn't provide a
`python3` alias); every script in this repo already accounts for that
(`src/pythonCmd.js`) — it only matters if you're typing a `python...`
command yourself, e.g. from "Filter and build a deck" below.

**No terminal, no typing commands?** After a one-time `npm install` and
`pip install -r requirements.txt` (Windows: `pip install -r requirements.txt`
still works — `pip` itself isn't renamed), double-click `start-app.command`
(macOS/Linux) or `start-app.bat` (Windows). It starts a local web UI at
`http://localhost:4173` and opens it in your browser automatically. Leave
the terminal window it opens running in the background while you use it;
double-click `stop-app.command`/`stop-app.bat` (or close the window /
Ctrl-C) to stop it — starting also self-heals if a previous run was left
running: it detects the stale process on the port and kills it before
starting a fresh one, instead of crashing with `EADDRINUSE`. See
`src/server/index.js` for what it wraps, and `scripts/portctl.js` for the
cross-platform stale-port cleanup both the start and stop scripts share.

The UI has two tabs:
- **Data Analysis** — a form for Grade/Year/Term (plus optional Section and
  Subject filters, e.g. only Section A or only Math+Hindi), a button to open
  Chrome for reportbee login, and live progress. "Fetch data" only runs
  extraction — it does **not** build a deck; once it finishes you land on a
  Done screen with "Merge raw/filtered/SEL data" buttons. A separate
  **Merge existing data** panel further down lets you point at any
  Grade/Year/Term that's already been extracted (no new fetch, no active
  job needed) and either merge its CSVs into one xlsx or build the deck from
  its filtered CSVs — this is the only place a deck actually gets built from
  the UI. See "Merging extracted data into one file" below for what the
  merge itself does.
- **Build Tree** — the xlsx-driven exam-plan tree writer (see "Building or
  updating the exam-plan tree" below), with a per-subject review-before-apply
  step in the browser instead of the terminal.

**Step 1 — Open reportbee in a debuggable Chrome.** reportbee's site
silently ignores `--remote-debugging-port` on your normal default profile
(a Chrome 136+ security change), so it needs its own profile directory.

macOS:
```bash
osascript -e 'quit app "Google Chrome"'   # only if Chrome is already open
open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/chrome-debug-profile"
```
Windows (Command Prompt):
```bat
taskkill /IM chrome.exe /F
start chrome --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\chrome-debug-profile"
```
(the `taskkill` line is only needed if Chrome is already open — same as the
`osascript` line above)

Log into reportbee.com in that window and leave the tab open. Verify the
debug port is live:
```bash
curl -s http://localhost:9222/json/version
```
(Windows without `curl` on PATH: open `http://localhost:9222/json/version`
in any browser instead — it's a plain HTTP GET.)

**Step 2 — Run the wizard:**
```bash
./wizard.sh        # macOS/Linux
wizard.bat          # Windows
```
It installs any missing `npm`/`pip` dependencies itself, then prompts for
Grade / Year / Term, extracts every section reportbee has for that grade,
and prints exactly where the raw CSVs land. It then checks whether a
reference workbook exists for that year (offering to build one from a file
you point it at, or generate a blank fillable template, if not), filters
down to the real Standard rows and prints where those land, then asks
whether to build the PPT deck before doing it.

That's the whole flow — nothing else to install or configure first.

### Repeat/batch runs without the prompts

If you already know the year/terms/grades and want to run several grades
without answering prompts each time, edit `config/batch.json`:
```json
{
  "year": "2025-26",
  "terms": ["Term 2"],
  "grades": ["VII", "VI", "V", "IV"]
}
```
then:
```bash
./run.sh VII        # macOS/Linux
run.bat VII          # Windows
```
This discovers Grade VII's actual sections live, extracts every one, writes
their CSVs to `data/2025_26/Term_2/`, and builds
`output/2025_26/Term_2/Grade_7_Term_2_Data_Analysis.pptx`. (`run.sh`/`run.bat`
don't install dependencies for you — run `npm install` and
`pip install -r requirements.txt` once first.)

Pass `--skip-deck` to only run extraction (e.g. while iterating on the
extractor itself), and/or `--section=`/`--subject=` (both comma-separated)
to narrow a run to specific sections or subjects instead of every one
reportbee has for that grade:
```bash
./run.sh VII --skip-deck
./run.sh VII --section=A,B --subject=Math,Hindi
```
(same flags on Windows: `run.bat VII --skip-deck`)

To extract a single section manually (useful for debugging):
```bash
node src/extract/extract.js
# then answer the prompts: Grade and Section, Year, Term, Patch subjects
```

To filter and build a deck from raw CSVs that already exist in `data/`:
```bash
python3 src/filter/filter_standards.py data/2023_24/Term_1 2023-24
python3 src/deck/build_deck.py data/2023_24/Term_1/filtered "Grade 7"
```

### Merging extracted data into one file

Independent of building a deck, any folder of per-section CSVs (raw or
filtered) can be combined into a single `.xlsx` — useful for handing off one
file instead of one-per-section, or for opening the data directly:
```bash
python3 src/merge_csv.py data/2023_24/Term_1 out.xlsx VII
python3 src/merge_csv.py data/2023_24/Term_1/filtered out.xlsx VII
```
The optional third argument (`VII` above) restricts the merge to that
grade's files when a data folder holds more than one grade. Pass `_ROC` as a
fourth argument to merge only the Socio-Emotional Learning companion files
(`*_ROC.csv`, R/O/C scale) instead of the main S/P/M/E ones — see point 8
under "How it works" below for why SEL is split out. The web UI's "Merge
raw/filtered/SEL data" buttons (both right after a fresh extraction and in
the standalone "Merge existing data" panel) call this same logic.

## Building or updating the exam-plan tree

Quillsmith can also go the other direction: read the school's "ASSESSMENT
TREES" xlsx workbook and use it to (re)build reportbee's live exam-plan tree
— topics, standards, weightages, assessment splits, grading mode — via its
write API. This exists because reportbee's own tree has no reliable way to
identify "the Standard", and different years/subjects don't share a
consistent structure, so there's no generic way to read the school's
intended structure back out of reportbee itself; the xlsx is the actual
source of truth.

```bash
node src/build_tree/apply_tree.js
```
Prompts for Grade & Section, the tree xlsx path (defaults to the newest
file in `input/`), Subject (blank = every subject in that xlsx), Term,
Academic Year, and Plan type (Academic/SEN). Only needs an authenticated
reportbee session — it drives the Year → Term → Assessment → Subject
navigation itself, so nothing needs pre-expanding in the browser first.

**What it actually does, per subject, is wipe and rebuild — not a
field-by-field diff:**
1. `parse_tree_xlsx.py` parses the workbook into
   `{topic_name: {weightage, mark_entry_mode, standards: [{name, weightage,
   mark_entry_mode, assessments: [{name, weightage}]}]}}` for that
   Grade+Subject (see below for the parsing rules).
2. `apply_tree.js` reads the live tree down to each Topic and Standard node
   (name, uuid, weight) via reportbee's read-only marks API — but **not**
   down to individual FA/SA assessment nodes, since reading those has
   proven unreliable (neither the API nor DOM expansion can discover them
   past a Standard reliably; see the comment above `readLiveTree`).
3. Every live Topic is queued for **deletion** — server-side cascade takes
   the Standards and Assessments under it with it — except one standing,
   non-curricular category (e.g. "Work Ethics"), detected via
   `use_for_aggregation === false` rather than by name (its localized name
   varies by language), which is preserved and just re-sorted to the end.
4. Every Topic/Standard/Assessment in the parsed xlsx is then **created
   fresh**, regardless of whether a live node of that name already existed
   — there's no rename/reweight-in-place for existing nodes. New nodes are
   built by cloning an existing sibling's full ~40-field record (so
   `course_id`, `plan_id`, `grade_template_id`, and rounding rules are
   guaranteed valid) and overriding only name/parent/order/weight/mode.
5. The resulting delete+create batch is POSTed in one call to reportbee's
   `save_structure_v2` endpoint. The full plan is printed either way — there
   is no per-change confirmation prompt, since this is designed to run
   against a whole subject unattended, not to be reviewed line by line.

**This means every run destroys and recreates the whole subject's topic
structure from the xlsx, with no check for whether a topic already has real
marks entered against it** (see "Known constraints" below) — treat it as
"make the tree match this xlsx from scratch", not as a safe incremental
sync, and don't run it against a term where teachers have already started
entering grades without checking first.

```bash
python3 src/build_tree/parse_tree_xlsx.py <xlsx_path> <Grade> [Subject]
```
runs just the parsing step on its own (prints the parsed JSON) — useful for
checking what the workbook will actually produce before running it against
the live tree. Its pytest suite (`npm run test:python`) covers the
per-subject row-convention quirks and mode-inference rules this parser
depends on.

## Project layout

```
wizard.sh, wizard.bat   — guided entry point: installs deps, prompts for
                           Grade/Year/Term, runs extract -> filter -> deck
                           (.sh for macOS/Linux, .bat for Windows)
run.sh, run.bat         — scripted entry point: node src/batch.js <Grade>
src/pythonCmd.js        — the one place that picks "python3" vs "python"
                           (macOS/Linux vs Windows) for every script below
                           that shells out to a .py file
scripts/portctl.js      — cross-platform "find/kill whatever's on this
                           port", shared by start-app/stop-app on every OS
config/batch.json       — grade/section/year/term list for a batch run
assets/deck_template/   — blank deck skeleton (unpacked .pptx), permanent asset
reference/build_reference.py          — parses the 2025-26 "ASSESSMENT TREES"
                                         xlsx into a ground-truth standards list
reference/build_reference_2023_24.py  — same idea, for the differently-shaped
                                         2023-24 "Learning Standards" workbook
reference/make_blank_template.py — generates a blank xlsx in the 2025-26
                                    shape, for a year with no reference yet
reference/standards_*.json — grade -> subject -> [standard text], one per year
src/extract/extract.js  — API-based extractor; writes one row per node (with
                           its ancestry path) — exports extractSection() + a CLI
src/filter/filter_standards.py — selects which rows are real Standards from a
                                  raw dump, using reference/ + a leaf-detection
                                  fallback for subjects with no reference coverage
src/batch.js            — loops extractSection() over a grade's sections, then
                           filter_standards.py, then build_deck.py
src/wizard.js           — interactive version of the above; installs deps,
                           prompts instead of reading config/batch.json, and
                           asks before building the deck
src/deck/deck_lib.py    — chart rendering + slide XML assembly
src/deck/build_deck.py  — reads data/<year>/<term>/filtered/*.csv, builds the .pptx
src/merge_csv.py        — combines a folder of per-section CSVs (raw or
                           filtered, main or SEL/ROC) into one .xlsx
src/build_tree/parse_tree_xlsx.py — parses the source "ASSESSMENT TREES" xlsx
                                     into {subject: {topic_name: {...}}}
src/build_tree/apply_tree.js    — wipes and rebuilds reportbee's live
                                   exam-plan tree from the parsed xlsx via
                                   its write API (see "Building or updating
                                   the exam-plan tree" above)
src/build_tree/tests/           — pytest suite for parse_tree_xlsx.py
src/server/index.js     — Express server behind start-app.command: wraps
                           extract/filter/deck/merge/tree-apply as HTTP
                           endpoints + SSE job progress for the web UI
src/server/public/      — the web UI itself (plain HTML/CSS/JS, no build step)
start-app.command, start-app.bat — double-click entry point for the web UI
stop-app.command, stop-app.bat   — double-click to stop whatever's running
                                    on its port
input/                          — source ASSESSMENT TREES xlsx workbooks
                                   (git-ignored — proprietary school data)
data/<year>/<term>/            — raw extraction output (git-ignored)
data/<year>/<term>/filtered/   — filtered Standard rows (git-ignored)
output/<year>/<term>/          — finished decks (git-ignored)
```

## How it works

Read this if you're modifying the code — skip it if you just want to run
the pipeline (see "Run this" above).

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
   recursion (`collectAllNodes`) — no more clicking, ever. The key fact that
   makes this safe: a Subject's own `plan_id` (read for free from its
   parent's D3 data) stays correct for every descendant all the way to true
   leaves — confirmed by testing multiple levels deep. This also sidesteps
   an accordion-style UI quirk: the tree view only keeps one branch's
   descendants rendered at a time, so drilling into one subject via real
   clicks was silently dropping sibling subjects' data before this fix.
5. Recursion goes all the way to true leaves **unconditionally** — every
   node gets its own row, with its own rolled-up marks and its full
   ancestry path (`Path` column). Extraction deliberately does *not* try to
   decide which node is "the Standard": there's no fully reliable
   structural signal in reportbee's own tree for that (a short_name
   convention like `"S1"`, `"S2"` looked like one at first but wasn't — a
   Topic heading and the real standard beneath it can both match it), and
   years without a ground-truth workbook have no standardized tree shape at
   all to reason about live. Deciding which rows are real Standards is a
   separate, offline step (see below) — working against a finished CSV
   means iterating on that logic never needs reportbee or a browser.
6. Node names come straight from the API's raw JSON, which can contain
   literal commas or embedded newlines (unlike the old scraper's truncated
   DOM text) — CSV fields are written with proper RFC4180 quoting to avoid
   silently corrupting rows.
7. Writes one raw CSV per section to `data/<year>/<term>/<Grade>_<Section>.csv`,
   format `Year,Class,Subject,Path,NodeName,Type,ShortName,S,P,M,E`.
8. Not every subject actually grades on that S/P/M/E scale — confirmed live
   that Socio-Emotional Learning's marks come back as `grade:"R"/"O"/"C"`
   ("Rarely"/"Occasionally"/"Consistently") instead, which don't overlap with
   S/P/M/E at all. A node's own grade values identify which scale it's on
   (`detectScale` in extract.js); anything on a non-default scale (currently
   just ROC) writes to its own companion file instead, e.g.
   `VII_A_ROC.csv` with format `Year,Class,Subject,Path,NodeName,Type,
   ShortName,R,O,C` — so its marks are captured correctly rather than
   silently written as `S=0,P=0,M=0,E=0` (which is what happened before this
   was recognized: not "no data", just S/P/M/E counting for grade codes it
   never had). `filter_standards.py`/`build_deck.py` don't read the ROC file
   at all — deck-building only covers the default S/P/M/E scale for now.
   `merge_csv.py` can still merge the ROC files on their own into an xlsx
   (see "Merging extracted data into one file" above) even though they never
   feed the deck.

Each grade's actual section list (A–H, sometimes more) is **discovered live**
from reportbee's own grade/section picker (`discoverSections`) rather than
hand-maintained in config — different grades don't all have the same
sections, and the school can add one (e.g. a grade gaining a section "I")
without the config silently going stale.

Then `filter_standards.py` (`src/filter/`) selects which rows are real
Standards, writing `data/<year>/<term>/filtered/<Grade>_<Section>.csv` in the
old `Year,Class,Subject,Standard,S,P,M,E` format:

1. Resolves which reference JSON applies via `resolve_reference_filename()`:
   an exact override if one exists (`reference/standards_2023_24.json` /
   `standards_2025_26.json`), else a cutoff rule — years before 2024 use the
   2023-24 ("old format") reference, 2024 onward reuse the 2025-26 ("new
   format") one, since the school hasn't produced a fresh workbook every
   year but the standards/format itself hasn't changed since 2025-26.
2. A row is a Standard if its `NodeName` matches one of that grade+subject's
   known standard texts — exact match first, then fuzzy (Levenshtein-style
   ratio via `difflib`), since the source workbook and the live tree
   occasionally have small genuine text drift (e.g. "घटनाक्रम" vs
   "घटना-क्रम"), not just whitespace differences. Subject names also don't
   always match between the two sources (`हिंदी` vs `Hindi`, `Math` vs
   `Mathematics`, inconsistent SEL naming) — `resolve_subject()` bridges
   these via substring containment plus a small alias table.
3. A Standard's own "I can ..." student-facing restatements are close
   paraphrases of their parent by design, so they can also cross the fuzzy
   threshold and match the same reference text as their parent. Since the
   raw dump preserves ancestry, `dedupe_ancestor_matches()` keeps only the
   shallowest matching node per lineage — confirmed the deeper "I can ..."
   node is always the false positive, never the reverse.
4. If a subject has no reference coverage at all for its resolved year (e.g.
   Socio-Emotional Learning in the 2023-24 workbook, which has no SEL
   sheet), falls back to picking true leaves — rows with no deeper row
   beneath them in the same file.

Then `build_deck.py`:

1. Reads every section CSV for a grade, clusters near-duplicate standard
   titles (a safety net — matters less now that titles come from clean API
   JSON instead of truncated DOM text, but harmless to keep).
2. Aggregates grade-wide and per-subject stats (student counts, standard
   counts, M+E% mastery rate, S/P/M/E distribution) straight from the
   filtered CSVs — nothing here is hand-entered.
3. Renders the charts (`deck_lib.py`, matplotlib): a stacked S/P/M/E bar per
   standard and per section (as before), plus a grade-wide mastery-rate
   horizontal bar and a per-subject S/P/M/E donut.
4. Assembles a `.pptx` by copying the blank deck template
   (`assets/deck_template/`) and injecting, in order:
   - a static "How to use this deck" slide explaining the S/P/M/E bands
   - a grade-wide Dashboard (stat cards + the two grade-wide charts)
   - a grade-wide "Key Takeaways" placeholder (bracketed prompts, e.g.
     `[Point 1]` — meant to be filled in by hand, not auto-generated)
   - then, per subject: a title/stats slide, a grade-wide S/P/M/E donut
     ("Grade-wide Snapshot"), "Performance by Section" and "Performance by
     Standard" bar charts, one detail chart per standard, a per-subject
     "Key Takeaways" placeholder, and an "Instructional Implications"
     placeholder (fixed content, copied from the reference template)
   before zipping the result into a real `.pptx`. All of this is built from
   hand-rolled OOXML/DrawingML XML (see the `esc`/`run_xml`/`shape_xml`/
   `pic_xml`/`slide_doc` helpers near the top of `deck_lib.py`) rather than
   a Python pptx library, since the fixed template's placeholder slides
   couldn't accommodate data-driven layouts like the stat-card dashboard or
   the donut+callout snapshot slide.

This project supersedes two older, separate, manual pipelines: **netbot**
(scraped reportbee by clicking through every standard in the UI, ~7 seconds
each) and **Term Data** (a second, manual deck-building step from netbot's
CSVs). Quillsmith does both in one pipeline via direct API calls.

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
- Only tested so far against Grades IV, V, VI, VII for the 2023-24 and
  2025-26 academic years; the full raw-dump + filter pipeline has been
  verified end-to-end (all sections, extract + filter + deck) for Grades
  IV, V, VI, VII, 2023-24, Term 1.
- Each `reference/standards_*.json` is a **snapshot of one specific
  workbook**. Years before 2024 use the 2023-24 ("old format") reference by
  default; 2024 onward reuse the 2025-26 ("new format") one — see
  `resolve_reference_filename()` in `filter_standards.py`. If a year's real
  standards actually diverge from what's already captured, a fresh xlsx (or
  `reference/make_blank_template.py`'s blank template, filled in) plus a
  `build_reference*.py` re-run is needed. Filtering still works without any
  of this — a year label that doesn't parse at all falls back to
  leaf-detection for every subject — so this degrades gracefully rather
  than failing outright.
- **The tree writer (`apply_tree.js`) is newer and less hardened** than the
  extraction pipeline. Notably: every run unconditionally deletes and
  recreates every non-standing topic in the subject (see "Building or
  updating the exam-plan tree" above) with **no check for whether marks have
  already been entered** against it — running this against a term that's
  already in progress can destroy real grades. Also,
  `switchGradeSection`'s plan-type-card matching can silently report success
  even when navigation didn't actually happen. Always re-verify a run's
  result against the live tree (e.g. re-fetch via `fetchNodeMarks`) rather
  than trusting the printed plan alone.
- `SKIP_SUBJECTS` in `apply_tree.js` currently hardcodes `sel` — its real
  topic/standard content lives in a linked ReportPlan this script can't read
  or write, so it's skipped entirely rather than silently wiping it.
- **2022-23 and earlier** had yet another, unexamined workbook layout
  (separate per-grade files, e.g. `22_23_Grade 4.xlsx`) — the year-number
  cutoff rule above would incorrectly route those years to the 2023-24
  reference. Don't trust filtering results for 2022-23 or earlier without
  first checking that workbook's actual shape and writing a dedicated
  `build_reference_2022_23.py` if it differs.
