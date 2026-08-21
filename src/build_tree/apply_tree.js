/**
 * Reads Topic/Standard/Weightage/Assessment rows from a tree xlsx (parsed
 * by parse_tree_xlsx.py) and diffs them against the live reportbee tree for
 * a Grade+Section+Subject, applying every update/rename/reweight,
 * deletion, and creation it finds automatically (no per-change
 * confirmation — reviewing every diff by hand across whole subjects isn't
 * practical). Prints the full plan either way so what happened is visible
 * after the fact.
 *
 * Creation uses the clone-template strategy validated on Module
 * (Seasons/Metals and Non-metals, see create_node_test.js /
 * create_metals.js): clone an existing sibling node's full field set
 * (course_id, plan_id, grade_template_id, etc. are then guaranteed valid)
 * and override only name/parent_uuid/order/weight/mode. A missing Topic
 * cascades into creating its Standards and their Assessments too, in one
 * batch. If a subject has no existing node at all to clone from at some
 * level, that item is skipped and reported rather than guessed at.
 *
 * Usage: node src/build_tree/apply_tree.js
 * Prompts for: Grade & Section (e.g. "VII A"), tree xlsx path, Term (e.g.
 * "Term 1", guessed from the xlsx filename), Subject (blank = all subjects
 * in that xlsx).
 *
 * Only needs an authenticated reportbee session — navigateToSubject()
 * automates the Year(already-active) -> Term -> Assessment -> Subject
 * expansion itself (reusing extractSection()'s proven find/expand
 * sequence), so nothing needs to be manually clicked open in the browser
 * first. Subjects sitting directly under the Term (Socio-Emotional
 * Learning) and ones nested under an Assessment-level grouping (English,
 * Hindi, Math, Module, ...) are both handled.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { PYTHON_CMD } = require('../pythonCmd');
const {
  connectToReportbeeTab, getPageContext, getCsrfToken, sampleAuthParams,
  switchGradeSection, switchYear, fetchNodeMarks, findFullLabel,
  isExpandable, expandNode, getChildrenFromData, delay, subjectMatches, SUBJECT_ALIASES,
} = require('../extract/extract');

const ROOT = path.join(__dirname, '..', '..');

function createPrompter(rl) {
  const isTTY = !!process.stdin.isTTY;
  let queue = null;
  let queueReady = null;
  if (!isTTY) {
    queue = [];
    queueReady = new Promise((resolve) => {
      rl.on('line', (line) => queue.push(line.trim()));
      rl.on('close', () => resolve());
    });
  }
  return async function ask(question, defaultValue) {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    if (isTTY) {
      return new Promise((resolve) => {
        rl.question(`${question}${suffix}: `, (answer) => resolve(answer.trim() || defaultValue || ''));
      });
    }
    await queueReady;
    const line = queue.shift();
    const value = line || defaultValue || '';
    console.log(`${question}${suffix}: ${value}`);
    return value;
  };
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, '');
}

// Cheap, reliable "what grade/section is this tab actually on right now"
// check -- the same signal switchGradeSection's own "already there"
// shortcut uses. reportbee's tab is a real, interactive browser window
// (not a sandboxed automation-only session), so a stray click -- ours or
// a person's -- can navigate it to a different section mid-run with
// nothing in between throwing an exception; the wipe-and-rebuild write
// that follows would then silently target the wrong section's tree.
// CONFIRMED live, 2026-08-21 (Grade VI, reproducible): this happened for
// real partway through a run, consistently right around a subject
// (Hindi) that needs the deeper "check inside each Assessment-level
// grouping" search in navigateToSubject below.
async function currentGradeSectionLabel(page) {
  return page.evaluate(() => document.querySelector('a.all-standards-link')?.textContent.trim() || null);
}

async function assertOnGradeSection(page, expectedLabel, context) {
  const actual = await currentGradeSectionLabel(page);
  if (actual !== expectedLabel) {
    throw new Error(
      `Section drift detected${context ? ` (${context})` : ''}: expected to still be on "${expectedLabel}" `
      + `but the page is now on "${actual}". Aborting rather than risk writing to the wrong section.`
    );
  }
}

// Alias-aware subject-name comparison (xlsx header vs. reportbee's live
// tree label -- e.g. "SEL" vs. "Social Emotional Learning") lives in
// extract.js as subjectMatches, imported above -- extract.js's own
// patchSubjects filter needs the exact same aliasing, so it's the shared
// source of truth rather than a copy kept here too.

// Labels long enough to wrap onto two lines in the tree's SVG boxes
// (confirmed: "Socio-Emotional Learning") split across multiple <tspan>
// children of one text.node-name element — no single leaf DOM element
// ever contains the full string, so a naive "leaf element, exact text"
// search can't find them. text.node-name's OWN textContent (all its tspan
// children concatenated) is the reliable thing to match against, same
// pattern already proven in extract.js's findFullLabel().
async function findNodeNameElement(page, targetText) {
  return page.evaluateHandle((targetText) => {
    function norm(s) { return (s || '').replace(/\s+/g, '').toLowerCase(); }
    const nt = norm(targetText);
    for (const el of document.querySelectorAll('text.node-name')) {
      if (norm(el.textContent) === nt) return el;
    }
    return null;
  }, targetText);
}

async function ensureExpanded(page, domLabel) {
  if (await isExpandable(page, domLabel)) {
    await expandNode(page, domLabel);
    await delay(500);
  }
}

// Label-text lookups (findFullLabel/isExpandable/expandNode/
// getChildrenFromData, all from extract.js) fail silently for long topic
// names -- confirmed live: this tree's SVG clips/wraps very long labels in
// the DOM, so a full name like "Aravalli Hills: The Stone and Stream of
// Gurugram" never actually appears verbatim in any node's textContent
// (truncated to "...Stream of", missing "Gurugram" entirely). Once we
// already have a node's own uuid (from its parent's D3 children data),
// matching g.node.__data__.uuid directly sidesteps the truncation problem
// altogether -- exact and never ambiguous, unlike text matching.
async function isExpandableByUuid(page, uuid) {
  return page.evaluate((uuid) => {
    for (const g of document.querySelectorAll('g.node')) {
      const d = g.__data__;
      if (!d || d.uuid !== uuid) continue;
      const btn = g.querySelector('g.svg-btn.open-close-btn');
      if (!btn) return false;
      const pts = btn.querySelector('polygon')?.getAttribute('points') || '';
      return pts !== '12.487,7 3.513,7 3.513,9 12.487,9';
    }
    return false;
  }, uuid);
}

async function expandNodeByUuid(page, uuid) {
  const handle = await page.evaluateHandle((uuid) => {
    for (const g of document.querySelectorAll('g.node')) {
      if (g.__data__ && g.__data__.uuid === uuid) return g;
    }
    return null;
  }, uuid);
  if (await handle.evaluate(el => el === null)) return false;
  await handle.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
  await delay(200);
  const btn = await handle.evaluateHandle(el => el.querySelector('g.svg-btn.open-close-btn'));
  const box = await btn.boundingBox();
  if (!box) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await delay(1000);
  return true;
}

async function childrenByUuid(page, uuid) {
  return page.evaluate((uuid) => {
    for (const g of document.querySelectorAll('g.node')) {
      const d = g.__data__;
      if (!d || d.uuid !== uuid) continue;
      const kids = d.children || d._children || [];
      return kids
        .map(c => ({
          name: c.name || '', uuid: c.uuid || '', type: c.type || '',
          shortName: c.short_name || '', planId: c.plan_id || '',
          hasChildren: !!(c.children_uuids && c.children_uuids.length > 0),
        }))
        .filter(c => c.uuid);
    }
    return [];
  }, uuid);
}

async function domChildrenOfUuid(page, uuid) {
  if (await isExpandableByUuid(page, uuid)) {
    await expandNodeByUuid(page, uuid);
    await delay(500);
  }
  return childrenByUuid(page, uuid);
}

// Automates Term -> Assessment -> Subject navigation (same sequence
// extractSection() already uses and has proven reliable) so nothing needs
// to be manually pre-expanded in the browser first — only an
// authenticated reportbee session is required. Subjects sit either
// directly under the Term (confirmed: Socio-Emotional Learning) or nested
// one level deeper under an Assessment-level grouping (English, Hindi,
// Math, Module, ...), so both are checked. Assumes the correct academic
// year is already active (via the header dropdown) — this doesn't call
// switchYear.
async function navigateToSubject(page, termLabel, subjectName) {
  const DBG = !!process.env.DEBUG_TREE;
  const candidates = [subjectName, ...(SUBJECT_ALIASES[subjectName.toLowerCase()] || [])];

  // Fast path: already expanded/visible from earlier in this session.
  for (const name of candidates) {
    const handle = await findNodeNameElement(page, name);
    if (await handle.evaluate(el => !!el)) return name;
  }

  // The tree may not have finished rendering yet right after
  // switchGradeSection -- extractSection() hits this same race and waits
  // for the Term label to actually appear before searching for it, rather
  // than a single immediate attempt (confirmed live: a bare one-shot
  // findFullLabel here failed for every single subject on a fresh grade
  // switch, purely from running before the DOM caught up).
  await page.waitForFunction(
    (tl) => Array.from(document.querySelectorAll('text.node-name'))
      .some(n => n.textContent.trim().replace(/\s+/g, '').toLowerCase()
        .startsWith(tl.replace(/\s+/g, '').toLowerCase())),
    { timeout: 10000 },
    termLabel
  ).catch(() => {});
  await delay(500);

  let termDomLabel = await findFullLabel(page, termLabel);
  if (!termDomLabel) {
    await delay(2000);
    termDomLabel = await findFullLabel(page, termLabel);
  }
  if (!termDomLabel) return null;
  await ensureExpanded(page, termDomLabel);

  const termChildren = await getChildrenFromData(page, termDomLabel);
  for (const child of termChildren) {
    if (candidates.some(name => subjectMatches(child.name, name))) return child.name;
  }

  // Not directly under Term -- check inside each Assessment-level grouping.
  for (const assessmentChild of termChildren) {
    if (!assessmentChild.hasChildren) continue;
    const assessmentDomLabel = await findFullLabel(page, assessmentChild.name);
    if (!assessmentDomLabel) continue;
    if (DBG) {
      const before = await currentGradeSectionLabel(page);
      console.log(`  [dbg] expanding "${assessmentDomLabel}" while searching for "${subjectName}" (on "${before}")`);
    }
    await ensureExpanded(page, assessmentDomLabel);
    if (DBG) {
      const after = await currentGradeSectionLabel(page);
      console.log(`  [dbg] after expanding "${assessmentDomLabel}", now on "${after}"`);
    }
    const subChildren = await getChildrenFromData(page, assessmentDomLabel);
    for (const child of subChildren) {
      if (candidates.some(name => subjectMatches(child.name, name))) return child.name;
    }
  }

  return null;
}

async function readLiveSubject(page, subjectName) {
  const handle = await findNodeNameElement(page, subjectName);
  return handle.evaluate((el) => {
    if (!el) return null;
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      if (node.__data__) {
        const d = node.__data__;
        return { uuid: d.uuid, plan_id: d.plan_id, name: d.name };
      }
      node = node.parentElement;
    }
    return null;
  });
}

// exam_plan_node_marks/fetch's all_nodes ONLY ever contains the exact node
// queried, never its children -- confirmed live on a freshly-built term
// (every node here still has mark_entry_status "not_started"): querying a
// Subject, a Topic, and a Standard all came back with all_nodes.length===1
// (just self), even though children_uuids correctly listed real children.
// The extract.js doc comment promising "queried node PLUS its direct
// children" was validated on already-marked terms, not this one -- so it
// can't be trusted here for discovering children, only for pulling one
// specific node's own full ~40-field record (which it does return
// correctly every time, self is never truncated).
async function fetchFullNode(page, ctx, nodeUuid) {
  const json = await fetchNodeMarks(page, { ...ctx, nodeUuid });
  if (!json || !json.status) return null;
  const allNodes = json.data.all_nodes || [];
  return allNodes.find(n => n.uuid === nodeUuid) || null;
}

async function readLiveTree(page, ctx, subjectUuid) {
  const DBG = !!process.env.DEBUG_TREE;
  let topicRefs = await domChildrenOfUuid(page, subjectUuid);

  // Some subjects nest their real topics one level deeper, behind a single
  // extra course_paper-typed pass-through node, instead of listing them
  // directly under the subject like every other subject does -- a genuine
  // Topic elsewhere is always type:"regular_paper" (course_paper is
  // otherwise reserved for the Subject level itself), so this unwraps any
  // such wrapper by descending into it and treating ITS children as the
  // real topics.
  //
  // CONFIRMED live, 2026-08-20 (Grade VII-B): a course_paper wrapper is NOT
  // always a throwaway artifact -- SEL's own wrapper ("Social Emotional
  // Learning" under "Socio-Emotional Learning") carries a non-empty
  // `linked_nodes` field (`[{plan_id, node_uuid, plan_type: "ReportPlan"}]`)
  // pointing at a separate, per-section ReportPlan record this script has
  // no way to create or repair. The original version of this function
  // queued every course_paper wrapper for deletion unconditionally,
  // assuming it was redundant -- for SEL that deleted the one node holding
  // that link, collapsing a whole tree level. `linked_nodes` is the actual,
  // reliable signal (type alone isn't -- a wrapper can be legitimately
  // redundant OR a protected link, and only this field tells them apart):
  // a linked wrapper is now NEVER queued for deletion and is treated as
  // permanently off-limits -- still unwrapped for reading (its children are
  // real topics), but new topics get created as ITS children (via
  // protectedParentUuid, below), not the subject's, and the wrapper node
  // itself is never touched by anything downstream.
  // CONFIRMED live, 2026-08-21 (Grade VI-A): the linked_nodes check above
  // only ever ran when `ref.hasChildren` was already true, so a wrapper
  // that legitimately exists but hasn't had its topics (re)created yet
  // (e.g. right after a manual partial rebuild in reportbee's own UI) fell
  // through to the plain `else` branch below -- treated as an ordinary,
  // unmatched topic, queued for deletion, with new topics created directly
  // under the subject instead of under it. Checking type alone (not type
  // + hasChildren) closes that gap: an empty wrapper still gets its
  // linked_nodes checked and protected, it just has nothing to unwrap yet.
  const wrapperUuidsToDelete = [];
  let protectedParentUuid = null;
  const unwrapped = [];
  for (const ref of topicRefs) {
    if (ref.type === 'course_paper') {
      const wrapperFull = await fetchFullNode(page, ctx, ref.uuid);
      const isLinked = !!(wrapperFull && Array.isArray(wrapperFull.linked_nodes) && wrapperFull.linked_nodes.length > 0);
      if (isLinked) {
        if (DBG) console.log(`  [dbg] wrapper "${ref.name}" (${ref.uuid}) has linked_nodes -- protected, not queued for deletion`);
        protectedParentUuid = ref.uuid;
      } else {
        wrapperUuidsToDelete.push(ref.uuid);
      }
      if (ref.hasChildren) {
        unwrapped.push(...await domChildrenOfUuid(page, ref.uuid));
      }
    } else {
      unwrapped.push(ref);
    }
  }
  topicRefs = unwrapped;

  if (DBG) console.log(`  [dbg] subject topicRefs: ${topicRefs.map(t => `${t.name}(hasChildren=${t.hasChildren})`).join(', ')}`);
  const tree = [];
  for (const topicRef of topicRefs) {
    const topicFull = await fetchFullNode(page, ctx, topicRef.uuid);
    if (!topicFull) { if (DBG) console.log(`  [dbg] topic "${topicRef.name}" fetchFullNode FAILED`); continue; }
    const topicEntry = { ...topicFull, standards: [] };
    const stdRefs = topicRef.hasChildren ? await domChildrenOfUuid(page, topicRef.uuid) : [];
    if (DBG) console.log(`  [dbg] topic "${topicRef.name}" stdRefs: ${stdRefs.map(s => `${s.name}(hasChildren=${s.hasChildren})`).join(', ') || '(none)'}`);
    // Assessment-level (leaf FA/SA) children are NOT read here -- confirmed
    // live that neither the marks-fetch API nor DOM expansion can reliably
    // discover them (the tree UI apparently never renders a Standard as its
    // own independently-expandable node past this depth). This is fine
    // under the wipe-and-rebuild strategy: we never try to match/preserve
    // individual assessments, only delete the whole topic (server-side
    // cascade handles descendants) and recreate fresh from the xlsx.
    for (const stdRef of stdRefs) {
      const stdFull = await fetchFullNode(page, ctx, stdRef.uuid);
      if (!stdFull) { if (DBG) console.log(`  [dbg] standard "${stdRef.name}" fetchFullNode FAILED`); continue; }
      topicEntry.standards.push({ ...stdFull, assessments: [] });
    }
    tree.push(topicEntry);
  }
  return { topics: tree, wrapperUuidsToDelete, protectedParentUuid };
}

// Creation strategy validated on Module (Seasons/Metals and Non-metals):
// clone an existing sibling's full field set (course_id, plan_id,
// grade_template_id, rounding rules, etc. are all real/valid that way)
// and override only the handful of fields that describe this specific
// node's own identity/position. Never hand-build the ~40-field payload
// from scratch.
function cloneAsNew(template, overrides) {
  const clone = { ...template };
  clone.created_at = '';
  clone.updated_at = '';
  clone.aggregation_property_updated_at = null;
  clone.structure_under_me_updated_at = null;
  clone.aggregation_property_under_me_updated_at = null;
  clone.mark_entry_under_me_at = null;
  clone.mark_entry_at = null;
  clone.mark_entry_status = 'not_started';
  Object.assign(clone, overrides);
  return clone;
}

// Template preference: a sibling in the exact same place in the tree first
// (so course_id/grade_template_id context matches as closely as possible),
// falling back to any node of that level anywhere in the subject.
// CONFIRMED live, 2026-08-21 (Grade VI, Mathematics): this used to return
// liveTopics[0] unconditionally -- whatever the tree happened to list
// first, with no check that it wasn't Work Ethics itself. Work Ethics'
// use_for_aggregation: false / use_for_total: false (the very fields that
// mark it as a standing, non-curricular category -- see isStandingCategory)
// got cloned onto every newly created topic that picked it as a template,
// silently excluding them from the subject's own total. Real, curricular
// topics created this way stopped counting toward students' grades with
// no error anywhere. Filtering standing categories out here is the actual
// fix; isStandingCategory is the same signal buildPlan already uses to
// decide what NOT to delete, reused here to decide what's safe to clone.
function findTopicTemplate(liveTopics) {
  return liveTopics.find(t => !isStandingCategory(t)) || null;
}
function findStandardTemplate(liveTopics, preferTopicUuid) {
  if (preferTopicUuid) {
    const t = liveTopics.find(t => t.uuid === preferTopicUuid);
    if (t && !isStandingCategory(t) && t.standards.length > 0) return t.standards[0];
  }
  for (const t of liveTopics) if (!isStandingCategory(t) && t.standards.length > 0) return t.standards[0];
  // Some subjects' existing "topics" are themselves flat, type:"assessment"
  // nodes directly under the subject rather than type:"regular_paper"
  // wrappers around real standards -- confirmed live in Module/Mathematics/
  // Digital Literacy ("Number System", "Geometry", "Creative Coding_Scratch"
  // etc. are all type:"assessment" with real children of their own we just
  // can't read, per readLiveTree's own known blind spot). Structurally
  // identical field-shape to a genuine Standard regardless of which level
  // of this subject's tree it's sitting at, so usable as a template here
  // too rather than reporting no template at all.
  if (preferTopicUuid) {
    const t = liveTopics.find(t => t.uuid === preferTopicUuid);
    if (t && !isStandingCategory(t) && t.type === 'assessment') return t;
  }
  for (const t of liveTopics) if (!isStandingCategory(t) && t.type === 'assessment') return t;
  return null;
}
function findNearbyAssessmentTemplate(liveTopics, preferStandardUuid) {
  if (!preferStandardUuid) return null;
  for (const t of liveTopics) {
    const s = t.standards.find(s => s.uuid === preferStandardUuid);
    if (s && s.assessments.length > 0) return s.assessments[0];
  }
  return null;
}
function findAnyAssessmentOrStandardTemplate(liveTopics, preferStandardUuid) {
  for (const t of liveTopics) for (const s of t.standards) if (s.assessments.length > 0) return s.assessments[0];
  // Some subjects (confirmed in Hindi) have zero existing leaf-level
  // assessment nodes anywhere -- every standard currently has no children
  // at all. Standards and leaf assessments are structurally identical in
  // reportbee (both type: "assessment", same field shape), so fall back to
  // an existing standard as the template rather than borrowing
  // cross-subject and risking a mismatched course_id/grade_template_id.
  return findStandardTemplate(liveTopics, preferStandardUuid);
}

// Builds one new assessment leaf node (no children of its own).
// fallbackTemplate (when given) is the standard this leaf's own parent was
// just cloned from -- preferred over a subject-wide search, since it's
// guaranteed to carry the correct course_id/grade_template_id for exactly
// this lineage (confirmed live in SEL: a subject-wide fallback picked an
// unrelated leftover standard's leaf, inheriting its wrong grade scale).
function createAssessment(liveTopics, targetAsm, parentUuid, order, mode, fallbackTemplate) {
  const template = findNearbyAssessmentTemplate(liveTopics, parentUuid)
    || fallbackTemplate
    || findAnyAssessmentOrStandardTemplate(liveTopics, parentUuid);
  if (!template) return { node: null, label: `[assessment, NO TEMPLATE AVAILABLE] "${targetAsm.name}" — skipped, nothing in this subject to clone from` };
  const uuid = crypto.randomUUID();
  const node = cloneAsNew(template, {
    uuid, name: targetAsm.name, short_name: targetAsm.name.slice(0, 10),
    parent_uuid: parentUuid, children_uuids: [], order,
    conversion_score: targetAsm.weightage != null ? targetAsm.weightage : template.conversion_score,
    should_convert: true,
    mark_entry_mode: mode || template.mark_entry_mode,
    max_score: targetAsm.max_score != null ? targetAsm.max_score : template.max_score,
  });
  return { node, label: `[assessment, created] "${targetAsm.name}" (weight ${targetAsm.weightage}, out of ${node.max_score})` };
}

// Builds one new standard node plus its assessment children.
function createStandard(liveTopics, targetStd, parentUuid, order, creates, labels) {
  const template = findStandardTemplate(liveTopics, parentUuid);
  if (!template) { labels.push(`[standard, NO TEMPLATE AVAILABLE] "${targetStd.name}" — skipped, nothing in this subject to clone from`); return null; }
  const uuid = crypto.randomUUID();
  const asmOrder = { n: 0 };
  const childUuids = [];
  for (const targetAsm of targetStd.assessments) {
    asmOrder.n += 10;
    const { node, label } = createAssessment(liveTopics, targetAsm, uuid, asmOrder.n, targetAsm.mark_entry_mode, template);
    labels.push(label);
    if (node) { creates[node.uuid] = node; childUuids.push(node.uuid); }
  }
  const node = cloneAsNew(template, {
    uuid, name: targetStd.name, short_name: targetStd.name.slice(0, 10),
    parent_uuid: parentUuid, children_uuids: childUuids, order,
    conversion_score: targetStd.weightage != null ? targetStd.weightage : template.conversion_score,
    should_convert: true,
    mark_entry_mode: targetStd.mark_entry_mode || template.mark_entry_mode,
  });
  creates[uuid] = node;
  labels.push(`[standard, created] "${targetStd.name}" (weight ${targetStd.weightage}) with ${childUuids.length} assessment(s)`);
  return node;
}

// Builds one new topic node plus its standards (and their assessments).
function createTopic(liveTopics, targetTopic, topicName, parentUuid, order, creates, labels) {
  const template = findTopicTemplate(liveTopics);
  if (!template) { labels.push(`[topic, NO TEMPLATE AVAILABLE] "${topicName}" — skipped, subject has no existing topic to clone from`); return null; }
  const uuid = crypto.randomUUID();
  const stdOrder = { n: 0 };
  const childUuids = [];
  for (const targetStd of targetTopic.standards) {
    stdOrder.n += 10;
    const node = createStandard(liveTopics, targetStd, uuid, stdOrder.n, creates, labels);
    if (node) childUuids.push(node.uuid);
  }
  const node = cloneAsNew(template, {
    uuid, name: topicName, short_name: topicName.slice(0, 10),
    parent_uuid: parentUuid, children_uuids: childUuids, order,
    conversion_score: targetTopic.weightage != null ? targetTopic.weightage : template.conversion_score,
    should_convert: true,
    mark_entry_mode: targetTopic.mark_entry_mode || template.mark_entry_mode,
  });
  creates[uuid] = node;
  labels.push(`[topic, created] "${topicName}" (weight ${targetTopic.weightage}) with ${childUuids.length} standard(s)`);
  return node;
}

// Wipe-and-rebuild strategy: reading the live tree down to individual
// FA/SA assessment nodes has proven unreliable (see readLiveTree's own
// comment), and a fresh term's structure is being authored from the xlsx
// from scratch anyway -- so rather than trying to diff/match/preserve
// existing topics, standards, and assessments piece by piece, delete every
// existing topic under the subject (server-side cascade handles their
// standards/assessments) and recreate the whole thing fresh from the xlsx.
// Work Ethics is the one exception: a standing grading category that never
// appears in any term's topic xlsx, so it's preserved untouched rather
// than deleted, and just re-sorted to sort last among the new topics.
//
// Detecting it by English name string was wrong -- confirmed live: Hindi's
// own localized equivalent ("कार्य आचरण") doesn't contain "workethics" in
// any normalized form, so that check silently let it through the wipe and
// it got permanently deleted. use_for_aggregation is the real,
// language-agnostic signal (confirmed: Expedition's real "Work Ethics" node
// has use_for_aggregation: false, while an ordinary graded topic like
// "Aravalli Hills" has it true) -- this field means "does this node's score
// count toward the subject's overall total", which is exactly what
// distinguishes a standing/non-curricular category from real content
// regardless of what it's named or which language it's in. Kept the name
// check too (OR, not replacing) since erring toward NOT deleting something
// is the safe direction if the two signals ever disagree.
function isStandingCategory(topic) {
  return topic.use_for_aggregation === false || normalize(topic.name).includes('workethics');
}

// Wipe-and-rebuild used to delete+recreate every non-standing topic
// unconditionally, even ones that were already byte-for-byte identical to
// the xlsx -- pure churn, and not even harmless churn: it's what triggered
// the same-name delete+create validation failure (see saveStructureTwoPhase's
// comment) on a topic that hadn't actually changed at all. These compare a
// live topic against its xlsx target and leave it completely untouched
// (neither deleted nor recreated) when everything the xlsx actually
// specifies already matches -- name (the lookup key itself), weight, mode,
// and every standard/assessment beneath it. Anything else -- a new topic, a
// renamed/reweighted one, or one whose standards changed -- still goes
// through the normal delete+recreate path; this only removes the case
// where there was never anything to do. Order isn't compared (a
// topics-only-reordered, otherwise-identical xlsx would go undetected) --
// deliberately out of scope: order is cosmetic sort position, not a
// grading-affecting field, so leaving it stale on a rare reorder is a
// reasonable trade against reintroducing the churn this exists to avoid.
const WEIGHT_EPSILON = 0.05;

function numsClose(a, b) {
  if (a == null || b == null) return true; // no opinion when either side doesn't specify a value
  return Math.abs(a - b) < WEIGHT_EPSILON;
}

function assessmentsMatch(liveAssessments, targetAssessments) {
  if (liveAssessments.length !== targetAssessments.length) return false;
  const liveByName = new Map(liveAssessments.map(a => [a.name, a]));
  for (const targetAsm of targetAssessments) {
    const liveAsm = liveByName.get(targetAsm.name);
    if (!liveAsm) return false;
    if (!numsClose(liveAsm.conversion_score, targetAsm.weightage)) return false;
    if (!numsClose(liveAsm.max_score, targetAsm.max_score)) return false;
    if (targetAsm.mark_entry_mode && liveAsm.mark_entry_mode !== targetAsm.mark_entry_mode) return false;
  }
  return true;
}

function standardsMatch(liveStandards, targetStandards) {
  if (liveStandards.length !== targetStandards.length) return false;
  const liveByName = new Map(liveStandards.map(s => [s.name, s]));
  for (const targetStd of targetStandards) {
    const liveStd = liveByName.get(targetStd.name);
    if (!liveStd) return false;
    if (!numsClose(liveStd.conversion_score, targetStd.weightage)) return false;
    if (targetStd.mark_entry_mode && liveStd.mark_entry_mode !== targetStd.mark_entry_mode) return false;
    if (!assessmentsMatch(liveStd.assessments, targetStd.assessments)) return false;
  }
  return true;
}

function topicUnchanged(liveTopic, targetTopic) {
  if (!numsClose(liveTopic.conversion_score, targetTopic.weightage)) return false;
  if (targetTopic.mark_entry_mode && liveTopic.mark_entry_mode !== targetTopic.mark_entry_mode) return false;
  return standardsMatch(liveTopic.standards, targetTopic.standards);
}

function buildPlan(liveTopics, targetTopics, subjectUuid) {
  const plan = { deletes: [], needsCreation: [], creates: {}, unchanged: [] };
  const liveByName = new Map(liveTopics.filter(t => !isStandingCategory(t)).map(t => [t.name, t]));

  for (const topic of liveTopics) {
    if (isStandingCategory(topic)) continue;
    const targetTopic = targetTopics[topic.name];
    if (targetTopic && topicUnchanged(topic, targetTopic)) {
      plan.unchanged.push(topic.name);
      continue;
    }
    const childUuids = topic.standards.flatMap(s => [s.uuid, ...s.assessments.map(a => a.uuid)]);
    plan.deletes.push({ uuid: topic.uuid, label: `[topic, deleted] "${topic.name.slice(0, 60)}"`, children: childUuids });
  }

  let order = 10;
  for (const [topicName, targetTopic] of Object.entries(targetTopics)) {
    const liveTopic = liveByName.get(topicName);
    if (liveTopic && topicUnchanged(liveTopic, targetTopic)) {
      order += 10;
      continue;
    }
    const labels = [];
    createTopic(liveTopics, targetTopic, topicName, subjectUuid, order, plan.creates, labels);
    for (const l of labels) plan.needsCreation.push({ label: l });
    order += 10;
  }

  const lastUsedOrder = order - 10;
  const workEthics = liveTopics.find(isStandingCategory);
  if (workEthics && (workEthics.order || 0) <= lastUsedOrder) {
    const newOrder = order;
    plan.updates = { [workEthics.uuid]: {
      uuid: workEthics.uuid, order: newOrder,
      _label: `[topic] "${workEthics.name}" order ${workEthics.order} -> ${newOrder} (Work Ethics must sort last)`,
    } };
  } else {
    plan.updates = {};
  }

  return plan;
}

async function saveStructure(page, ctx, changes) {
  return page.evaluate(async (args) => {
    const { baseUrl, planId, csrfToken, accessToken, profileId, changes } = args;
    const body = new URLSearchParams();
    body.set('cp_structure_changes', JSON.stringify(changes));
    body.set('authenticity_token', csrfToken);
    body.set('access_token', accessToken);
    body.set('current_user_profile_id', profileId);
    const res = await fetch(`${baseUrl}/rb_records/exam_plans/${planId}/save_structure_v2`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, json, rawText: json ? null : text.slice(0, 1000) };
  }, { baseUrl: ctx.baseUrl, planId: ctx.planId, csrfToken: ctx.csrfToken, accessToken: ctx.accessToken, profileId: ctx.profileId, changes });
}

// reportbee validates "no duplicate name at this level" against a single
// request's combined effect, not sequentially -- deleting an old node and
// creating a new one with the same name in the SAME request gets rejected
// even though the create was only ever meant to replace the delete, not
// coexist with it. CONFIRMED live, 2026-08-21 (Grade VI, Math): a combined
// request failed with "Nodes in the same level shouldn't contain the same
// name in section 'VI A' ... Mathematics->Number System" purely from
// wipe-and-rebuild's normal delete-old-recreate-fresh behavior hitting a
// topic whose name happened to be unchanged. Splitting into two round
// trips -- every delete first, then every update/create -- sidesteps this:
// the name is genuinely free server-side before the create fires,
// regardless of how reportbee's own validation is implemented.
async function saveStructureTwoPhase(page, ctx, { update, deleteUuids }) {
  if (deleteUuids.length > 0) {
    const deleteResult = await saveStructure(page, ctx, { update: {}, delete: deleteUuids, copy_marks: [] });
    if (!(deleteResult.json && deleteResult.json.status)) {
      return deleteResult;
    }
  }
  return saveStructure(page, ctx, { update, delete: [], copy_marks: [] });
}

// The tree's own top-level "Year" node (Term 1/Term 2's shared parent) has
// a plain `name` field that's just whatever it was set to when the exam
// plan was first created for that year (often cloned from last year's) --
// confirmed live: VI A's root still said "2025 - 26" while every subject
// beneath it was correctly being built for 2026-27, and nothing else in
// this script ever surfaces or fixes it, so it silently stays stale
// release after release unless checked explicitly here.
function formatYearRootLabel(yearLabel) {
  const m = yearLabel.match(/^(\d{4})-(\d{2,4})$/);
  if (!m) return yearLabel;
  const [, startYear, endPart] = m;
  const shortEnd = endPart.length === 4 ? endPart.slice(2) : endPart;
  return `${startYear} - ${shortEnd}`;
}

// Walking up from Term's own __data__.parent_uuid to find the root proved
// unreliable (confirmed live: right after a fresh page reload it can
// report a stale grandparent uuid instead of the true immediate parent --
// a settling delay didn't fix it, so that field just isn't trustworthy
// here). Finding the root node directly by its own distinctive "YYYY - YY"
// name pattern sidesteps the whole parent-chain question, and a plain
// {uuid, name} update (no full-record clone needed -- confirmed elsewhere
// this session that partial updates work fine for existing nodes) is all a
// rename needs.
async function ensureYearRootLabel(page, ctx, yearLabel) {
  const match = await page.evaluate(() => {
    for (const g of document.querySelectorAll('g.node')) {
      const nameEl = g.querySelector('text.node-name');
      const text = nameEl && nameEl.textContent.trim();
      if (text && /^\d{4}\s*-\s*\d{2,4}$/.test(text)) {
        return { uuid: g.__data__.uuid, name: text };
      }
    }
    return null;
  });
  if (!match) {
    console.warn('⚠️  Could not find a year-labeled root node to check -- skipping.');
    return;
  }

  // A genuinely fresh plan (confirmed live: a SEN plan never opened before
  // this session) lands with its root collapsed and nothing beneath it
  // rendered at all, unlike an Academic plan that's typically already been
  // expanded from earlier interactions -- expand it here so Term 1/2
  // actually exist in the DOM for the caller's subsequent findFullLabel
  // calls, rather than relying on incidental prior expansion.
  if (await isExpandable(page, match.name)) {
    await expandNode(page, match.name);
    await delay(500);
  }

  const expectedLabel = formatYearRootLabel(yearLabel);
  if (match.name === expectedLabel) {
    console.log(`✅ Year root already labeled "${expectedLabel}"`);
    return;
  }

  console.log(`🔧 Year root says "${match.name}", renaming to "${expectedLabel}"`);
  if (process.env.DRY_RUN) {
    console.log('🧪 DRY_RUN set — not saving the year root rename.');
    return;
  }
  const changes = { update: { [match.uuid]: { uuid: match.uuid, name: expectedLabel } }, delete: [], copy_marks: [] };
  const result = await saveStructure(page, ctx, changes);
  if (result.json && result.json.status) {
    console.log(`✅ Year root renamed to "${expectedLabel}"`);
  } else {
    console.warn('⚠️  Failed to rename year root:', result.json || result.rawText);
  }
}

function parseTreeXlsx(xlsxPath, grade, subject) {
  const args = [path.join(__dirname, 'parse_tree_xlsx.py'), xlsxPath, grade];
  if (subject) args.push(subject);
  const out = execFileSync(PYTHON_CMD, args, { cwd: ROOT });
  return JSON.parse(out.toString());
}

function findDefaultTreeFile() {
  const inputDir = path.join(ROOT, 'input');
  if (!fs.existsSync(inputDir)) return '';
  const files = fs.readdirSync(inputDir).filter(f => f.toLowerCase().endsWith('.xlsx'));
  if (files.length === 0) return '';
  files.sort((a, b) => fs.statSync(path.join(inputDir, b)).mtimeMs - fs.statSync(path.join(inputDir, a)).mtimeMs);
  return path.join('input', files[0]);
}

function guessTermLabel(xlsxPath) {
  const m = path.basename(xlsxPath).match(/term[_ ]?(\d+)/i);
  return m ? `Term ${m[1]}` : 'Term 1';
}

function guessYearLabel(xlsxPath) {
  const m = path.basename(xlsxPath).match(/(\d{4})[-_](\d{2,4})/);
  return m ? `${m[1]}-${m[2]}` : '';
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = createPrompter(rl);

  const gradeSection = await prompt('📥 Grade & Section (e.g. VII A)', '');
  const treePath = await prompt('📥 Tree xlsx path', findDefaultTreeFile());
  const subjectFilter = await prompt('📥 Subject (blank = all)', '');

  const [grade, ...sectionParts] = gradeSection.trim().split(/\s+/);
  const section = sectionParts.join(' ');
  if (!grade || !section) throw new Error('Grade & Section required, e.g. "VII A"');
  const VALID_GRADES = ['IV', 'V', 'VI', 'VII'];
  if (!VALID_GRADES.includes(grade.toUpperCase())) {
    throw new Error(`"${grade}" isn't a recognized grade (expected one of ${VALID_GRADES.join(', ')}) — check you answered the "Grade & Section" prompt and not a later one.`);
  }
  const gradeSectionLabel = `${grade} ${section}`;

  // Paths pasted from a shell (e.g. tab-completed, with spaces backslash-escaped
  // or the whole thing quoted) are common here since this isn't itself a shell
  // argument — this prompt takes the line literally, so unescape/unquote first.
  const cleanedTreePath = treePath.trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\(.)/g, '$1');
  const absTreePath = path.isAbsolute(cleanedTreePath) ? cleanedTreePath : path.join(ROOT, cleanedTreePath);
  if (!fs.existsSync(absTreePath)) throw new Error(`Tree file not found: ${absTreePath}`);

  const termLabel = await prompt('📥 Term (e.g. Term 1)', guessTermLabel(absTreePath));
  const yearLabel = await prompt('📥 Academic Year (e.g. 2026-27)', guessYearLabel(absTreePath));
  if (!yearLabel) throw new Error('Academic Year required, e.g. "2026-27" -- could not guess one from the xlsx filename.');
  // A grade/section can have separate Academic / Non-Academic / SEN exam
  // plans (confirmed live) -- the rest of the pipeline (xlsx parsing, tree
  // wipe-and-rebuild, everything) is identical either way, only which
  // plan card gets opened differs.
  const planType = await prompt('📥 Plan type (Academic/SEN)', 'Academic');

  const page = await connectToReportbeeTab();
  // The live tree's D3 client-side state (which nodes' children are
  // actually populated vs. stale/empty) accumulates across whatever manual
  // clicking has happened in this tab -- confirmed live: after enough
  // manual expand/rename/collapse interaction, some already-expanded topics
  // silently read back zero children even though the server has real ones,
  // which would have caused both a missed deletion and a duplicate
  // creation for standards that already existed. A hard reload guarantees
  // a clean slate before any reading starts.
  await page.reload({ waitUntil: 'networkidle2' });
  await delay(2000);
  await switchYear(page, yearLabel);
  await switchGradeSection(page, grade, section, planType);

  const { baseUrl, planId } = getPageContext(page);
  const csrfToken = await getCsrfToken(page);

  // One-time check, before touching any subject: the tree's own top-level
  // Year node commonly carries a stale name from whenever this year's plan
  // was created (see ensureYearRootLabel's own comment) -- fix that first,
  // sampling auth params off the Term node itself since it's guaranteed
  // visible right after switchGradeSection and nothing subject-specific is
  // needed yet.
  let termDomLabel = await findFullLabel(page, termLabel);
  if (!termDomLabel) { await delay(2000); termDomLabel = await findFullLabel(page, termLabel); }
  // Cached and reused for every subject below instead of re-sampling per
  // subject -- see the loop's own comment for why (SEL's subject-level
  // node has no "Enter / View Marks" option of its own).
  let cachedAccessToken = null, cachedProfileId = null;
  if (termDomLabel) {
    const { accessToken, profileId } = await sampleAuthParams(page, termDomLabel);
    cachedAccessToken = accessToken;
    cachedProfileId = profileId;
    await ensureYearRootLabel(page, { baseUrl, planId, csrfToken, accessToken, profileId }, yearLabel);
  } else {
    console.warn(`⚠️  Could not find Term "${termLabel}" to check the year root label -- skipping that check.`);
  }

  const target = parseTreeXlsx(absTreePath, grade, subjectFilter || undefined);
  // SEL used to be hardcoded here -- its real topic/standard content lives
  // in a linked ReportPlan, and applying its plan once (Grade VII-B,
  // 2026-08-20) deleted that link's wrapper node and replaced its real
  // leaf standards with shallower shells, since readLiveTree assumed any
  // course_paper wrapper was a redundant pass-through. Fixed by detecting
  // the wrapper via its `linked_nodes` field instead of guessing from node
  // type alone (see readLiveTree's own comment), and by never letting a
  // standing category (Work Ethics-like nodes) get used as a clone
  // template (see findTopicTemplate). Verified against VII-C end to end
  // afterward -- SEL runs through the normal path now like every other
  // subject, no special-casing left here. A section with no intact SEL
  // structure to clone from yet (no existing standard anywhere under it)
  // still can't originate one from nothing -- that's a data problem for
  // that section, not something this list should paper over again.
  const SKIP_SUBJECTS = [];
  const subjects = Object.keys(target).filter(name => {
    if (SKIP_SUBJECTS.includes(name.toLowerCase())) {
      console.log(`\n=== ${name} ===\n⏭️  Skipped (known limitation -- see SKIP_SUBJECTS comment above).`);
      return false;
    }
    return true;
  });
  if (subjects.length === 0) {
    console.log('No matching subject(s) found in the tree xlsx for this grade.');
    return;
  }

  for (const subjectName of subjects) {
    console.log(`\n=== ${subjectName} ===`);
    await assertOnGradeSection(page, gradeSectionLabel, `before processing "${subjectName}"`);
    const liveName = await navigateToSubject(page, termLabel, subjectName);
    if (!liveName) {
      console.warn(`⚠️  Could not find "${subjectName}" under Term "${termLabel}" (checked directly under the Term and inside each Assessment-level grouping).`);
      continue;
    }
    if (liveName !== subjectName) console.log(`   (matched to live subject "${liveName}")`);
    const liveSubject = await readLiveSubject(page, liveName);
    if (!liveSubject) {
      console.warn(`⚠️  Found "${liveName}" in the tree but couldn't read its data — try again.`);
      continue;
    }

    // access_token/profile_id are session-level, not node-specific (see
    // sampleAuthParams's own comment) -- reuse the Term-level sample above
    // rather than re-sampling from this subject's own node, which fails
    // for SEL: its subject-level node ("Socio-Emotional Learning") has no
    // "Enter / View Marks" option at all (confirmed live, 2026-08-21).
    let accessToken = cachedAccessToken, profileId = cachedProfileId;
    if (!accessToken || !profileId) {
      const domLabel = await findFullLabel(page, liveName) || liveName;
      ({ accessToken, profileId } = await sampleAuthParams(page, domLabel));
      cachedAccessToken = accessToken;
      cachedProfileId = profileId;
    }
    const ctx = { baseUrl, planId: liveSubject.plan_id, csrfToken, accessToken, profileId };

    const { topics: liveTopics, wrapperUuidsToDelete, protectedParentUuid } = await readLiveTree(page, ctx, liveSubject.uuid);
    if (process.env.DEBUG_TREE) {
      console.log('\n🔎 Live tree read:');
      if (protectedParentUuid) console.log(`  (new topics will be created under protected wrapper ${protectedParentUuid}, not the subject itself)`);
      for (const t of liveTopics) {
        console.log(`  Topic "${t.name}" (${t.uuid}) conversion_score=${t.conversion_score}`);
        for (const s of t.standards) {
          console.log(`    Standard "${s.name}" (${s.uuid}) conversion_score=${s.conversion_score}`);
          for (const a of s.assessments) {
            console.log(`      Assessment "${a.name}" (${a.uuid}) conversion_score=${a.conversion_score}`);
          }
        }
      }
    }
    const plan = buildPlan(liveTopics, target[subjectName], protectedParentUuid || liveSubject.uuid);
    for (const uuid of wrapperUuidsToDelete) {
      plan.deletes.push({ uuid, label: '[wrapper, deleted] redundant course_paper pass-through node' });
    }

    const updateList = Object.values(plan.updates);
    const createList = Object.values(plan.creates);
    if (plan.unchanged.length) {
      console.log(`\n${plan.unchanged.length} topic(s) already match the xlsx, left untouched: ${plan.unchanged.join(', ')}`);
    }
    console.log(`\n${updateList.length} update(s):`);
    for (const u of updateList) console.log(`  ${u._label}`);
    console.log(`\n${plan.deletes.length} deletion(s):`);
    for (const d of plan.deletes) console.log(`  ${d.label}`);
    console.log(`\n${plan.needsCreation.length} creation(s):`);
    for (const c of plan.needsCreation) console.log(`  ${c.label}`);

    if (updateList.length === 0 && plan.deletes.length === 0 && createList.length === 0) {
      console.log('\nNothing to apply for this subject.');
      continue;
    }

    if (process.env.DRY_RUN) {
      console.log('\n🧪 DRY_RUN set — not saving.');
      continue;
    }

    const updates = {};
    for (const u of updateList) {
      const { _label, ...clean } = u;
      updates[u.uuid] = clean;
    }
    for (const node of createList) {
      updates[node.uuid] = node;
    }
    const deleteUuids = plan.deletes.flatMap(d => [d.uuid, ...(d.children || [])]);

    await assertOnGradeSection(page, gradeSectionLabel, `immediately before saving "${subjectName}"`);
    const result = await saveStructureTwoPhase(page, ctx, { update: updates, deleteUuids });
    console.log('Response status:', result.status);
    if (result.json) {
      console.log(result.json.status ? '✅ ' + result.json.message : '❌ ' + JSON.stringify(result.json));
    } else {
      console.log('❌ Non-JSON response:', result.rawText);
    }
  }
  rl.close();
  // puppeteer.connect() keeps the process alive on an open CDP connection
  // even after there's nothing left to do — disconnect() detaches without
  // closing the user's actual browser tab, then exit explicitly.
  await page.browser().disconnect();
  process.exit(0);
}

module.exports = {
  ensureYearRootLabel, parseTreeXlsx, navigateToSubject, readLiveSubject,
  readLiveTree, buildPlan, saveStructure, saveStructureTwoPhase, guessTermLabel, guessYearLabel,
  findDefaultTreeFile, currentGradeSectionLabel, assertOnGradeSection,
  SKIP_SUBJECTS: [],
};

if (require.main === module) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
