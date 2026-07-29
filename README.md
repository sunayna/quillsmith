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
plus its *direct* children — never deeper. So instead of clicking through
every node in the UI, `extract.js`:

1. Uses Puppeteer only for the parts that need a real browser: switching to
   the right grade/section, expanding the Year and Term nodes, and reading
   the full node tree straight out of D3's already-loaded `__data__` (no
   extra network calls needed for that — it's already sitting in the page).
2. Peeks at **one** node's "Enter / View Marks" link `href` to read off
   `access_token` and `current_user_profile_id` (session-level values, not
   tied to that specific node) and grabs `authenticity_token` from the
   page's `<meta name="csrf-token">` tag.
3. From there on, walks the entire tree by calling the API directly
   (`page.evaluate(() => fetch(...))`, reusing the browser's own session/
   cookies) — no more clicking, scrolling, or waiting on rendered popups.
   Recursion is driven by `children_uuids`/`type` in the API's own JSON
   response; a node's `type` is `"course_paper"` exactly at the Subject
   level, which is how the Subject column is tracked without assuming a
   fixed tree depth.
4. Writes one CSV per section to `data/<year>/<Grade>_<Section>.csv`, format
   `Year,Class,Subject,Standard,S,P,M,E`.

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

Edit `config/batch.json` for the year, terms, and grade/section list, then:

```bash
./run.sh VII
```

This extracts every section configured for Grade VII, writes their CSVs to
`data/2025_26/`, and builds `output/2025_26/Grade_7_Data_Analysis.pptx`.

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
  its direct children]` and that `type === "course_paper"` marks the
  Subject level — both confirmed against reportbee's actual responses, but
  if reportbee changes its API shape this will need revisiting.
