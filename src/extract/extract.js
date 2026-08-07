const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ─── Helpers ────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function normalize(text) {
  return text.replace(/\s+/g, '').toLowerCase();
}

// A subject filter (typed by hand, or an xlsx's own header) doesn't always
// share any substring with what reportbee's live tree actually calls that
// subject -- confirmed live: "SEL" (how anyone would naturally type it, and
// literally the xlsx's own header) shares zero characters in sequence with
// "Social Emotional Learning"/"Socio-Emotional Learning" (the live tree's
// name, which has varied by year), so plain substring matching silently
// finds nothing. The single source of truth for this table -- apply_tree.js
// imports subjectMatches from here rather than keeping its own copy, so an
// alias only ever needs adding in one place.
const SUBJECT_ALIASES = {
  'sel': ['Socio-Emotional Learning', 'Social Emotional Learning', 'Social-Emotional Learning'],
};

function normalizeSubjectName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, '');
}

function subjectMatches(liveName, filterText) {
  const nLive = normalizeSubjectName(liveName);
  const nFilter = normalizeSubjectName(filterText);
  if (!nLive || !nFilter) return false;
  if (nLive === nFilter || nLive.includes(nFilter) || nFilter.includes(nLive)) return true;
  return (SUBJECT_ALIASES[nFilter] || []).some((alias) => {
    const nAlias = normalizeSubjectName(alias);
    return nLive === nAlias || nLive.includes(nAlias) || nAlias.includes(nLive);
  });
}

async function readInputs() {
  const inputs = [];
  const rl = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY
  });

  const parseSubjects = (line) =>
    line ? line.split(',').map(s => s.trim()).filter(Boolean) : [];

  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      rl.question('📥 Grade and Section (e.g. VII A): ', (gs) => {
        rl.question('📥 Year (e.g. 2025-26): ', (year) => {
          rl.question('📥 Term (e.g. Term 1): ', (term) => {
            rl.question('📥 Patch subjects (blank = full run): ', (subjects) => {
              rl.close();
              resolve({
                gradeSection: gs.trim(),
                yearLabel: year.trim(),
                termLabel: term.trim(),
                patchSubjects: parseSubjects(subjects)
              });
            });
          });
        });
      });
    } else {
      rl.on('line', (line) => { inputs.push(line.trim()); });
      rl.on('close', () => {
        resolve({
          gradeSection: inputs[0] || '',
          yearLabel:    inputs[1] || '',
          termLabel:    inputs[2] || '',
          patchSubjects: parseSubjects(inputs[3] || '')
        });
      });
    }
  });
}

// ─── DOM helpers (only used for the one-time navigation/sampling below) ──────

async function findFullLabel(page, label) {
  const handles = await page.$$('text.node-name');
  for (const el of handles) {
    const text = await el.evaluate(e => e.textContent.trim());
    if (normalize(text).startsWith(normalize(label))) return text;
  }
  return null;
}

async function isExpandable(page, domLabel) {
  return page.evaluate((lbl) => {
    for (const g of document.querySelectorAll('g.node')) {
      const nameEl = g.querySelector('text.node-name');
      if (!nameEl || nameEl.textContent.trim() !== lbl) continue;
      const btn = g.querySelector('g.svg-btn.open-close-btn');
      if (!btn) return false;
      const pts = btn.querySelector('polygon')?.getAttribute('points') || '';
      return pts !== '12.487,7 3.513,7 3.513,9 12.487,9';
    }
    return false;
  }, domLabel);
}

async function expandNode(page, domLabel) {
  const handles = await page.$$('text.node-name');
  let target = null;
  for (const el of handles) {
    const text = await el.evaluate(e => e.textContent.trim());
    if (text === domLabel) { target = el; break; }
  }
  if (!target) return false;

  const group = await target.evaluateHandle(el => el.closest('g.node'));
  // Scroll into view before clicking — with many sequential expansions
  // across a whole grade/section walk, newly revealed nodes can render
  // outside the current viewport, and clicking blind coordinates there
  // silently misses. (This function intentionally does NOT zoom out after
  // expanding, unlike earlier versions of this script — repeated zoom-out
  // clicks compound across every expansion in a long-lived browser session
  // and can shrink the tree to an unusably tiny, unclickable scale.)
  await group.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
  await delay(200);
  const btn = await group.evaluateHandle(el => el.querySelector('g.svg-btn.open-close-btn'));
  const box = await btn.boundingBox();
  if (!box) return false;

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await delay(1000);
  return true;
}

/**
 * Children of a node from D3 __data__ — reading this does NOT require the
 * child to have been expanded itself, only the parent. Each child carries
 * its own plan_id and children_uuids fields already, straight off the
 * parent's data — confirmed live: a Subject (course_paper) node can belong
 * to a different underlying plan than its container (Assessment/Term), but
 * that correct plan_id is sitting right here for free, no separate lookup
 * or expand click needed. children_uuids reliably tells us whether a child
 * is a true leaf even before it's ever been expanded itself.
 */
async function getChildrenFromData(page, domLabel) {
  return page.evaluate((lbl) => {
    for (const g of document.querySelectorAll('g.node')) {
      const nameEl = g.querySelector('text.node-name');
      if (!nameEl || nameEl.textContent.trim() !== lbl) continue;
      const d = g.__data__;
      if (!d) return [];
      const kids = d.children || d._children || [];
      return kids
        .map(c => ({
          name: c.name || '',
          uuid: c.uuid || '',
          type: c.type || '',
          shortName: c.short_name || '',
          planId: c.plan_id || '',
          hasChildren: !!(c.children_uuids && c.children_uuids.length > 0),
        }))
        .filter(c => c.uuid);
    }
    return [];
  }, domLabel);
}

// ─── Direct API extraction ─────────────────────────────────────────────────
//
// The "Enter / View Marks" → "View Analysis" flow hits:
//   GET {baseUrl}/rb_records/exam_plan_node_marks/fetch
//     ?plan_id=...&selected_node_uuid=...&authenticity_token=...
//     &access_token=...&current_user_profile_id=...
//
// This always returns { data: { marks, all_nodes } } for exactly the queried
// node PLUS its direct children — never deeper. So instead of clicking
// through every leaf in the UI, we call this endpoint once per non-leaf node
// and recurse using children_uuids from the response itself. A node's type
// is "course_paper" exactly at the Subject level, which is how we track the
// Subject column without relying on fixed tree depth.

function getPageContext(page) {
  const url = page.url();
  const baseMatch = url.match(/^(https?:\/\/[^/]+\/[^/]+)/);
  const planMatch = url.match(/exam_plans\/([^/]+)\//);
  return {
    baseUrl: baseMatch ? baseMatch[1] : null,
    planId: planMatch ? planMatch[1] : null
  };
}

async function getCsrfToken(page) {
  return page.evaluate(() => document.querySelector('meta[name="csrf-token"]')?.content || null);
}

/**
 * Open a node's 3-dot menu and click "Enter / View Marks" — that click
 * (handled entirely in JS, not a plain href) fires the same
 * exam_plan_node_marks/fetch request we call directly later, so we
 * intercept that one response to read off access_token and
 * current_user_profile_id. Both are session-level, not node-specific, so
 * it doesn't matter which node we sample this from.
 */
async function sampleAuthParams(page, domLabel) {
  // Force a fresh response (not a cached 304 with an empty body) so the
  // response listener below reliably gets the full JSON.
  await page.setCacheEnabled(false);

  const handles = await page.$$('text.node-name');
  let target = null;
  for (const el of handles) {
    const text = await el.evaluate(e => e.textContent.trim());
    if (text === domLabel) { target = el; break; }
  }
  if (!target) throw new Error(`Could not find node to sample auth params: ${domLabel}`);

  const group = await target.evaluateHandle(el => el.closest('g.node'));
  await group.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
  await delay(300);

  // The option button is revealed by CSS (`.node:hover .option-btn` or
  // `.node.selected .option-btn { display: block }`) — confirmed live that
  // simulating real hover via mouse.move is unreliable (works sometimes,
  // silently leaves the button at display:none other times, e.g. on a
  // freshly-loaded 2025-26 exam plan). Adding the `selected` class directly
  // is deterministic since it's an explicit CSS alternative to hover, not a
  // workaround relying on synthetic events triggering real hover state.
  await group.evaluate(el => el.classList.add('selected'));
  await delay(200);

  const optionBtn = await group.evaluateHandle(el => el.querySelector('g.svg-btn.option-btn'));
  const btnBox = await optionBtn.boundingBox();
  if (!btnBox) {
    await group.evaluate(el => el.classList.remove('selected'));
    throw new Error(`Options button not found for sampling on: ${domLabel}`);
  }

  // A coordinate-based page.mouse.click() here reliably opened an EMPTY
  // options popup (no menu items) — the site's handler apparently needs the
  // mouseover/mousedown/mouseup/click sequence to fire in order to actually
  // populate the popup content, not just register a bare click at the right
  // pixel. Dispatching the events directly on the element sidesteps whatever
  // coordinate/hit-testing mismatch caused that.
  await optionBtn.evaluate(el => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await delay(800);

  let captured = null;
  const onResponse = async (res) => {
    if (captured) return;
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;
    try {
      const json = await res.json();
      if (json && json.access_token && json.current_user_profile_id) {
        captured = json;
      }
    } catch (e) { /* not JSON, or body already consumed — ignore */ }
  };
  page.on('response', onResponse);

  const clicked = await page.evaluate(() => {
    const link = Array.from(document.querySelectorAll('#node-options-popbox a.hook'))
      .find(a => a.textContent.includes('Enter / View Marks'));
    if (link) { link.click(); return true; }
    return false;
  });

  if (!clicked) {
    page.off('response', onResponse);
    throw new Error(`Could not find "Enter / View Marks" link on: ${domLabel} to sample auth params`);
  }

  // wait for the response to land, polling briefly rather than one fixed sleep
  for (let i = 0; i < 20 && !captured; i++) await delay(200);
  page.off('response', onResponse);

  // close whatever popup/modal opened as a side effect of the click
  await page.evaluate(() => document.querySelector('#cboxClose')?.click());
  await page.evaluate(() => { if (typeof closeAllPopbox === 'function') closeAllPopbox(); });
  await page.keyboard.press('Escape').catch(() => {});
  await group.evaluate(el => el.classList.remove('selected'));
  await delay(300);

  if (!captured) throw new Error(`Timed out waiting for auth params after clicking "Enter / View Marks" on: ${domLabel}`);
  return {
    accessToken: captured.access_token,
    profileId: captured.current_user_profile_id
  };
}

/**
 * Fetch marks for a single node + its direct children, using the browser's
 * own authenticated fetch (so cookies/session are reused automatically).
 * planId is passed per-call rather than fixed globally — see getFullTree's
 * doc comment for why that matters.
 */
async function fetchNodeMarks(page, { baseUrl, planId, nodeUuid, csrfToken, accessToken, profileId }) {
  return page.evaluate(async (args) => {
    const { baseUrl, planId, nodeUuid, csrfToken, accessToken, profileId } = args;
    const url = `${baseUrl}/rb_records/exam_plan_node_marks/fetch`
      + `?plan_id=${encodeURIComponent(planId)}`
      + `&selected_node_uuid=${encodeURIComponent(nodeUuid)}`
      + `&authenticity_token=${encodeURIComponent(csrfToken)}`
      + `&access_token=${encodeURIComponent(accessToken)}`
      + `&current_user_profile_id=${encodeURIComponent(profileId)}`;
    const res = await fetch(url, { credentials: 'include' });
    return res.json();
  }, { baseUrl, planId, nodeUuid, csrfToken, accessToken, profileId });
}

/**
 * RFC4180 field escaping. Standard names come straight from the API's raw
 * JSON (not truncated/sanitized DOM text like the old scraper saw), and
 * some genuinely contain embedded commas or literal newlines from
 * multi-line text entry upstream — writing those with naive string
 * interpolation splits a single logical row across two physical CSV lines,
 * silently corrupting every row after it.
 */
function csvField(value) {
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Writes one row per node — every node, not just ones guessed to be "the
 * Standard". Deciding which rows are real Standards is deliberately NOT
 * this script's job: reportbee's tree has no fully reliable structural
 * signal for that (short_name "S<n>" looked like one but wasn't — a topic
 * heading and the real standard beneath it can both match it), and years
 * without a ground-truth workbook have no standardized tree shape at all
 * to reason about live. Dumping everything (with each node's own rolled-up
 * marks and its ancestry path) turns "which row is the standard" into an
 * offline row-selection problem on a CSV instead — fast to iterate on, and
 * it doesn't need reportbee or a browser at all.
 */
// reportbee isn't on one universal grading scale -- confirmed live that
// Socio-Emotional Learning's marks come back with grade:"R"/"O"/"C"
// ("Rarely"/"Occasionally"/"Consistently"), not the S/P/M/E codes every
// other subject uses. Those don't overlap, so a node's own grade values
// identify which scale it's on. Getting this wrong used to be silent: the
// old fixed S/P/M/E counter never recognized R/O/C, so every SEL row wrote
// S=0,P=0,M=0,E=0 regardless of the real marks -- not "no data", just
// dropped data that looked exactly like no data.
const GRADE_SCALES = {
  SPME: { codes: ['S', 'P', 'M', 'E'], suffix: '' },
  ROC: { codes: ['R', 'O', 'C'], suffix: '_ROC' },
};

function detectScale(grades) {
  for (const scale of Object.values(GRADE_SCALES)) {
    if (grades.some((g) => scale.codes.includes(g))) return scale;
  }
  return GRADE_SCALES.SPME; // no marks entered yet, or an unrecognized code -- same as before
}

function writeRawRow(ctx, subject, ancestryPath, nodeInfo, marksForNode) {
  const grades = Object.keys(marksForNode).map((id) => marksForNode[id].grade);
  const scale = detectScale(grades);
  const counts = {};
  for (const code of scale.codes) counts[code] = 0;
  for (const g of grades) if (Object.prototype.hasOwnProperty.call(counts, g)) counts[g]++;

  const nodeName = (nodeInfo.name || '').trim();
  const pathStr = ancestryPath.join(' > ');
  const summary = scale.codes.map((c) => `${c}=${counts[c]}`).join(', ');
  console.log(`🎯 [${pathStr}] ${nodeName} → ${summary}`);

  // A node with no course_paper ancestor (e.g. Socio-Emotional Learning,
  // which sits directly under the Term/Assessment grouping) has no real
  // "subject" of its own — match the original convention of using the
  // node's own name as the Subject too in that case.
  const fields = [
    ctx.academicYear, ctx.classAndSection, subject || nodeName, pathStr, nodeName,
    nodeInfo.type || '', nodeInfo.short_name || nodeInfo.shortName || '',
    ...scale.codes.map((c) => counts[c]),
  ].map(csvField);
  const row = fields.join(',') + '\n';
  // A non-default scale (currently just ROC) writes to its own file
  // alongside the main one instead of forcing every subject onto the same
  // fixed S/P/M/E columns -- filter_standards.py/build_deck.py keep reading
  // the main file exactly as before, untouched by scales they don't handle.
  const filePath = scale.suffix ? ctx.csvFilePath.replace(/\.csv$/, `${scale.suffix}.csv`) : ctx.csvFilePath;
  const isNewFile = !fs.existsSync(filePath);
  fs.appendFileSync(
    filePath,
    isNewFile ? `Year,Class,Subject,Path,NodeName,Type,ShortName,${scale.codes.join(',')}\n${row}` : row,
    'utf8'
  );
}

/**
 * Recurses purely via the marks API — no DOM interaction at all. Confirmed
 * live: a Subject's own plan_id (obtained once, for free, from its parent's
 * D3 children data) stays correct for every descendant all the way down to
 * true leaves; there's no further plan boundary crossing below Subject
 * level. This is what makes it safe to never touch the DOM again once
 * we're inside a subject's subtree — no more clicking, no accordion-style
 * sibling collapse to worry about, since we simply never look at the tree
 * view again for this branch.
 *
 * Writes a row for every child (leaf or not) and recurses into any child
 * that structurally has further children — always to true leaves, with no
 * "is this the Standard" decision made here at all (see writeRawRow).
 */
async function collectAllNodes(page, authCtx, planId, nodeUuid, ancestryPath, ctx) {
  let json;
  try {
    json = await fetchNodeMarks(page, { ...authCtx, planId, nodeUuid });
  } catch (e) {
    console.warn(`⚠️  Fetch failed for node ${nodeUuid}: ${e.message}`);
    return;
  }
  if (!json || !json.status) {
    console.warn(`⚠️  API returned failure for node ${nodeUuid}: ${json && json.message}`);
    return;
  }

  const allNodes = json.data.all_nodes || [];
  const marks = json.data.marks || {};
  const nodeInfo = allNodes.find(n => n.uuid === nodeUuid);
  if (!nodeInfo) {
    console.warn(`⚠️  Node ${nodeUuid} missing from all_nodes in response — skipping`);
    return;
  }

  const childUuids = nodeInfo.children_uuids || [];
  for (const childUuid of childUuids) {
    const childInfo = allNodes.find(n => n.uuid === childUuid);
    if (!childInfo) {
      console.warn(`⚠️  Child ${childUuid} missing from all_nodes — skipping`);
      continue;
    }

    let subject = ctx.subject;
    if (childInfo.type === 'course_paper') {
      subject = childInfo.name;
      if (ctx.patchSubjects && ctx.patchSubjects.length > 0) {
        const match = ctx.patchSubjects.some(s => subjectMatches(subject, s));
        if (!match) {
          console.log(`⏭️  Skipping subject: ${subject}`);
          continue;
        }
        console.log(`✅ Patch match: ${subject}`);
      }
    }

    const childMarks = marks[childUuid];
    if (childMarks) {
      writeRawRow(ctx, subject, ancestryPath, childInfo, childMarks);
    } else {
      console.warn(`⚠️  No marks found for: ${childInfo.name}`);
    }

    const hasChildren = childInfo.children_uuids && childInfo.children_uuids.length > 0;
    if (hasChildren) {
      // Same plan_id all the way down — confirmed live two levels below a
      // Subject, so we keep reusing it rather than re-deriving anything.
      await collectAllNodes(page, authCtx, planId, childUuid, [...ancestryPath, childInfo.name], { ...ctx, subject });
    }
  }
}

/**
 * The only two levels that genuinely need real DOM expand-clicks: Term's
 * own children (Assessment-level groupings) and each Assessment-level
 * node's own children (Subjects, and any direct non-Subject leaves like
 * Socio-Emotional Learning). Both are read via D3 right after their parent
 * is expanded — no per-child DOM lookups. Once we have a child's own
 * uuid+plan_id from that read, everything below it is pure API recursion.
 */
async function expandAssessmentNode(page, authCtx, assessmentNode, ancestryPath, ctx) {
  const domLabel = await findFullLabel(page, assessmentNode.name);
  if (!domLabel) {
    console.warn(`⚠️  Could not find Assessment-level node in DOM: ${assessmentNode.name} — skipping`);
    return;
  }
  if (await isExpandable(page, domLabel)) {
    await expandNode(page, domLabel);
    await delay(500);
  }

  // One fetch at the Assessment level itself — covers any child that's a
  // direct leaf (no Subject wrapper), which the D3 read below can identify
  // but can't fetch marks for on its own since it uses the Assessment's own
  // plan_id, not the (different) one Subjects use.
  let json;
  try {
    json = await fetchNodeMarks(page, { ...authCtx, planId: assessmentNode.planId, nodeUuid: assessmentNode.uuid });
  } catch (e) {
    console.warn(`⚠️  Fetch failed for node ${assessmentNode.name}: ${e.message}`);
    return;
  }
  if (!json || !json.status) {
    console.warn(`⚠️  API returned failure for node ${assessmentNode.name}: ${json && json.message}`);
    return;
  }
  const marks = json.data.marks || {};

  const children = await getChildrenFromData(page, domLabel);
  for (const child of children) {
    // collectAllNodes only detects "this is a Subject" by seeing a
    // course_paper-typed *child* inside a parent's response — starting
    // the recursion directly at the Subject's own uuid skips that one
    // moment, so the Subject label has to be set here instead, before
    // handing off.
    let subject = ctx.subject;
    if (child.type === 'course_paper') {
      if (ctx.patchSubjects && ctx.patchSubjects.length > 0) {
        const match = ctx.patchSubjects.some(s => subjectMatches(child.name, s));
        if (!match) {
          console.log(`⏭️  Skipping subject: ${child.name}`);
          continue;
        }
        console.log(`✅ Patch match: ${child.name}`);
      }
      subject = child.name;
    }

    const childMarks = marks[child.uuid];
    if (childMarks) {
      writeRawRow(ctx, subject, ancestryPath, child, childMarks);
    } else {
      console.warn(`⚠️  No marks found for: ${child.name}`);
    }

    if (child.hasChildren) {
      await collectAllNodes(page, authCtx, child.planId, child.uuid, [...ancestryPath, child.name], { ...ctx, subject });
    }
  }
}

// ─── Grade / Section switcher ─────────────────────────────────────────────────

async function clickFirstAvailableNode(page) {
  const nodes = await page.$$('text.node-name');
  if (!nodes.length) return false;
  const box = await nodes[0].boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await delay(1000);
    return true;
  }
  return false;
}

/**
 * The academic year is a page-level / global-header setting (a "Year
 * Change" popup off #year-link), NOT a node inside the exam-plan tree —
 * confirmed live after shipping data under the wrong year: the tree's own
 * root node just happens to display whatever year is currently selected
 * globally, so searching the tree for a year label only ever finds
 * whichever year was already active, never actually switches it. The popup
 * lists years in full "2025-2026" form, not the "2025-26" short form used
 * elsewhere, so this converts before matching.
 */
function toFullYearFormat(yearLabel) {
  const m = yearLabel.match(/^(\d{4})-(\d{2,4})$/);
  if (!m) return yearLabel;
  const [, startYear, endPart] = m;
  if (endPart.length === 4) return yearLabel;
  return `${startYear}-${startYear.slice(0, 2)}${endPart}`;
}

async function switchYear(page, yearLabel) {
  const fullYear = toFullYearFormat(yearLabel);
  const current = await page.evaluate(() => document.querySelector('.year-name')?.textContent.trim() || null);
  if (current === fullYear) {
    console.log(`✅ Already on year ${fullYear}`);
    return;
  }

  console.log(`🔄 Switching year: ${current} → ${fullYear}`);
  const hasYearLink = await page.evaluate(() => !!document.querySelector('#year-link'));
  if (!hasYearLink) {
    throw new Error(`Could not find year switcher (#year-link) on the current page`);
  }

  await page.evaluate(() => document.querySelector('#year-link')?.click());
  await delay(800);

  const clicked = await page.evaluate((fy) => {
    const popup = document.querySelector('#year-popup');
    if (!popup) return false;
    const link = Array.from(popup.querySelectorAll('a')).find(a => a.textContent.trim() === fy);
    if (link) { link.click(); return true; }
    return false;
  }, fullYear);

  if (!clicked) {
    throw new Error(`Could not find year option "${fullYear}" in the year-change popup`);
  }

  // Changing year navigates to a fresh select_class page (grade/section
  // picker), not back to wherever we were.
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {}),
    delay(3000),
  ]);
  await delay(1000);
}

/**
 * Confirmed live (2026-08) that clicking through the grade -> section
 * picker no longer works: a.section-js links are href="#" with an
 * accordion-style reveal that only responds to a genuinely trusted click —
 * a script-dispatched click on the (possibly still-collapsed) anchor has
 * no effect at all, so the automated grade/section clicks silently never
 * navigated anywhere, and every run stalled on the picker page until the
 * plan-card wait below timed out.
 *
 * Every a.section-js element carries the section's real data-sectionid in
 * its dataset regardless of whether it's currently visible/expanded — this
 * exists identically whether the picker is open or the sidebar is just
 * sitting collapsed on an already-loaded exam plan page, since it's a
 * persistent, always-in-DOM sidebar rather than something rendered fresh
 * per page. Reading that id and navigating straight to
 * /rb_records/exams?section_id=<id> reproduces exactly what a real
 * section-letter click does (confirmed against a live network capture of
 * a manual click), without depending on any click actually registering.
 *
 * planType selects which of the grade/section's exam-plan-type cards to
 * open (confirmed live: a single grade/section can have separate Academic /
 * Non-Academic / SEN plans, each with its own distinct plan_id) --
 * defaults to 'Academic'. Each card's real plan_id is embedded directly in
 * its own View link's href, so this navigates straight there via
 * page.goto() once the matching card is found, rather than clicking
 * through it -- confirmed this part of the flow still works exactly as
 * written, once the picker is actually reached.
 *
 * NOTE: a tree-root-based year check was tried and removed here -- the
 * root node's own label (e.g. "2025 - 26") turned out to be a static field
 * from whenever that exam plan record was originally created, not a live
 * reflection of the active year context (confirmed: a known-good, already
 * -verified-correct VI A/2026-27 plan shows this exact same "2025 - 26"
 * label). switchYear()'s own header-based check is the only confirmed
 * reliable year signal; nothing here re-verifies it.
 */
async function switchGradeSection(page, grade, section, planType = 'Academic') {
  const currentClass = await page.evaluate(() =>
    document.querySelector('a.all-standards-link')?.textContent.trim() || ''
  );
  const expectedClass = `${grade} ${section}`;

  // The "already there" shortcut has no way to tell WHICH plan type the
  // currently-loaded page is on (only the grade/section label is checked),
  // so it's only trusted for the default Academic case -- anything else
  // always re-navigates through the card picker to guarantee correctness.
  if (currentClass === expectedClass && planType === 'Academic') {
    console.log(`✅ Already on ${expectedClass}`);
    return expectedClass;
  }

  // The section-js list can still be mid-render right after switchYear's
  // navigation (confirmed live: the exact same grade/section is present a
  // few seconds later with no other change) -- poll for it instead of
  // trusting a single immediate query, the same render-race pattern seen
  // elsewhere on this picker after a fresh navigation.
  const findSectionId = (grade, section) => {
    const el = Array.from(document.querySelectorAll('a.section-js'))
      .find((e) => (e.dataset.standardname || '').trim() === grade && (e.dataset.sectionname || '').trim() === section);
    return el ? el.dataset.sectionid : null;
  };
  let sectionId = await page.evaluate(findSectionId, grade, section);
  if (!sectionId) {
    try {
      await page.waitForFunction(findSectionId, { timeout: 8000 }, grade, section);
      sectionId = await page.evaluate(findSectionId, grade, section);
    } catch (e) { /* fall through to the error below */ }
  }
  if (!sectionId) {
    throw new Error(`Could not find a section_id for ${expectedClass} in the standards picker`);
  }

  // /rb_records/exams lives on the school's own portal subdomain, not on
  // daffodils.reportbee.com (the shared records-app host the page may
  // already be on from a prior section's extraction, where the school name
  // is a path segment instead of the subdomain).
  const currentUrl = new URL(page.url());
  const schoolOrigin = currentUrl.hostname === 'daffodils.reportbee.com'
    ? `https://${currentUrl.pathname.split('/').filter(Boolean)[0]}.reportbee.com`
    : currentUrl.origin;

  await page.goto(`${schoolOrigin}/rb_records/exams?section_id=${sectionId}`, { waitUntil: 'networkidle2', timeout: 20000 });
  console.log(`✅ Selected ${expectedClass}`);

  try {
    await page.waitForSelector('.card-footer a.btn.gamma-btn', { visible: true, timeout: 8000 });
    const planUrl = await page.evaluate((planType) => {
      for (const btn of document.querySelectorAll('.card-footer a.btn.gamma-btn')) {
        const card = btn.closest('.card');
        const heading = card && card.querySelector('h2, h3, h4, .title, [class*="title"], [class*="name"]');
        if (heading && heading.textContent.trim() === planType && /\/exam_plans\/[^/]+\/build_structure/.test(btn.href)) {
          return btn.href;
        }
      }
      return null;
    }, planType);
    if (!planUrl) throw new Error(`No "${planType}" plan card found for ${expectedClass}`);
    await page.goto(planUrl, { waitUntil: 'networkidle2', timeout: 15000 });
  } catch (e) {
    console.warn(`⚠️  Could not select "${planType}" plan card (${e.message}) -- checking if already on exam plan...`);
  }

  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {}),
    page.waitForSelector('text.node-name', { visible: true, timeout: 10000 }).catch(() => {})
  ]);
  await delay(1000);

  console.log(`✅ Loaded ${planType} exam plan for ${expectedClass}`);
  await clickFirstAvailableNode(page);
  return expectedClass;
}

// ─── Core extraction (reusable across a whole batch of sections) ───────────

/**
 * Extracts one grade/section/term onto disk as a CSV. `page` must already
 * be an authenticated reportbee.com tab. Callers running a batch across
 * many sections should open the browser/page once and call this repeatedly
 * — no need to reconnect puppeteer per section.
 */
async function extractSection(page, { gradeSection, yearLabel, termLabel, patchSubjects }) {
  const [grade, ...sectionParts] = gradeSection.split(/\s+/);
  const section = sectionParts.join(' ');

  await switchYear(page, yearLabel);
  const classAndSection = await switchGradeSection(page, grade, section);
  const academicYear = yearLabel;

  const yearFolder = yearLabel.replace(/-/g, '_');
  const termFolder = termLabel.replace(/\s+/g, '_');
  const dataDir = path.join(__dirname, '..', '..', 'data', yearFolder, termFolder);
  fs.mkdirSync(dataDir, { recursive: true });
  const csvFilePath = path.join(dataDir, `${classAndSection.replace(/\s+/g, '_')}.csv`);

  if (patchSubjects.length === 0) {
    // Clear the main file plus every per-scale companion (e.g. _ROC.csv) --
    // otherwise a full re-run just appends duplicate rows onto whatever a
    // previous run already wrote there.
    const scaleFiles = [csvFilePath, ...Object.values(GRADE_SCALES)
      .filter((s) => s.suffix)
      .map((s) => csvFilePath.replace(/\.csv$/, `${s.suffix}.csv`))];
    for (const f of scaleFiles) {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        console.log(`🗑️  Cleared ${path.basename(f)}`);
      }
    }
  }

  console.log(`📅 Academic Year: ${academicYear}`);

  console.log(`🔓 Expanding year node: "${yearLabel}"`);
  let yearDomLabel = await findFullLabel(page, yearLabel);
  if (!yearDomLabel) {
    console.warn(`⚠️  Year node not found — retrying in 3s...`);
    await delay(3000);
    yearDomLabel = await findFullLabel(page, yearLabel);
  }
  if (yearDomLabel) {
    if (await isExpandable(page, yearDomLabel)) {
      await expandNode(page, yearDomLabel);
      await delay(1000);
    }
  } else {
    console.warn(`⚠️  Could not find year node "${yearLabel}" — proceeding anyway`);
  }

  await page.waitForFunction(
    (tl) => Array.from(document.querySelectorAll('text.node-name'))
      .some(n => n.textContent.trim().replace(/\s+/g, '').toLowerCase()
        .startsWith(tl.replace(/\s+/g, '').toLowerCase())),
    { timeout: 10000 },
    termLabel
  ).catch(() => console.warn(`⚠️  Term node "${termLabel}" did not appear`));
  await delay(500);

  const termDomLabel = await findFullLabel(page, termLabel);
  if (!termDomLabel) {
    throw new Error(`Could not locate Term node "${termLabel}" in DOM`);
  }

  if (await isExpandable(page, termDomLabel)) {
    await expandNode(page, termDomLabel);
    await delay(500);
  }

  const termChildren = await getChildrenFromData(page, termDomLabel);
  if (termChildren.length === 0) {
    throw new Error(`Term node "${termLabel}" has no children — nothing to extract`);
  }

  const firstChildDomLabel = await findFullLabel(page, termChildren[0].name) || termChildren[0].name;
  console.log(`🔑 Sampling auth params from: ${termChildren[0].name}`);

  const { accessToken, profileId } = await sampleAuthParams(page, firstChildDomLabel);
  const csrfToken = await getCsrfToken(page);
  const { baseUrl } = getPageContext(page);

  if (!accessToken || !profileId || !csrfToken || !baseUrl) {
    throw new Error(
      `Missing auth/context values — ` +
      `accessToken=${!!accessToken} profileId=${!!profileId} csrfToken=${!!csrfToken} baseUrl=${!!baseUrl}`
    );
  }
  console.log(`✅ Got auth context`);

  if (patchSubjects.length > 0) {
    console.log(`🔧 Patch mode — only extracting: ${patchSubjects.join(', ')}\n`);
  } else {
    console.log(`🚀 Full run mode\n`);
  }

  console.log(`🚀 Starting extraction from Term: "${termLabel}"\n`);
  const authCtx = { baseUrl, csrfToken, accessToken, profileId };
  for (const assessmentNode of termChildren) {
    await expandAssessmentNode(
      page,
      authCtx,
      assessmentNode,
      [assessmentNode.name],
      { classAndSection, academicYear, grade, subject: '', patchSubjects, csvFilePath }
    );
  }

  console.log(`\n✅ Done. Wrote ${csvFilePath}`);
  return csvFilePath;
}

/**
 * Reads the real, current list of sections for a grade straight from
 * reportbee's own grade/section picker — the same a.section-js elements
 * switchGradeSection clicks — instead of relying on a hand-maintained list
 * that can silently drift out of sync (confirmed live: Grade VII gained a
 * section "I" this year that a static config list missed entirely, and
 * different grades don't all have the same sections to begin with).
 */
async function discoverSections(page, yearLabel, grade) {
  await switchYear(page, yearLabel);

  const hasAllStandardsLink = await page.evaluate(() => !!document.querySelector('a.all-standards-link'));
  if (hasAllStandardsLink) {
    await page.evaluate(() => document.querySelector('a.all-standards-link')?.click());
    await page.waitForSelector('#all-standards-list', { visible: true });
    await delay(500);
  }

  const sections = await page.evaluate((g) => {
    return Array.from(document.querySelectorAll('a.section-js'))
      .filter(a => a.dataset.standardname.trim() === g)
      .map(a => a.dataset.sectionname.trim());
  }, grade);

  return sections;
}

// ─── CLI entrypoint (manual single-section runs / debugging) ───────────────

async function connectToReportbeeTab() {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
  const pages   = await browser.pages();
  const page    = pages.find(p => p.url().includes('reportbee.com'));
  if (!page) throw new Error('No open tab with reportbee.com — open one and log in first');
  return page;
}

async function runCli() {
  const page = await connectToReportbeeTab();
  const { gradeSection, yearLabel, termLabel, patchSubjects } = await readInputs();
  await extractSection(page, { gradeSection, yearLabel, termLabel, patchSubjects });
  process.exit(0);
}

module.exports = {
  extractSection, connectToReportbeeTab, discoverSections,
  getPageContext, getCsrfToken, sampleAuthParams, findFullLabel,
  switchGradeSection, switchYear, isExpandable, expandNode, fetchNodeMarks,
  getChildrenFromData, delay, detectScale, GRADE_SCALES,
  subjectMatches, SUBJECT_ALIASES,
};

if (require.main === module) {
  runCli().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
