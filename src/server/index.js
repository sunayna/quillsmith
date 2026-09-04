/**
 * Local web UI for the extract -> filter -> deck pipeline — replaces
 * wizard.js's terminal prompts with a form + live progress in the browser,
 * for someone running this who doesn't want to touch a terminal.
 *
 * Usage: node src/server/index.js  (or `npm run app`)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const express = require('express');
const multer = require('multer');
const {
  extractSection, connectToReportbeeTab, discoverSections,
  switchYear, switchGradeSection, getPageContext, getCsrfToken, sampleAuthParams,
  findFullLabel, delay,
} = require('../extract/extract');
const treeLib = require('../build_tree/apply_tree');
const { PYTHON_CMD } = require('../pythonCmd');

const ROOT = path.join(__dirname, '..', '..');
const PORT = process.env.PORT || 4173;
const UPLOAD_DIR = path.join(ROOT, '.uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// multer's default `dest:` storage names files with no extension (a bare
// hash), which openpyxl then refuses to open ("does not support file
// format") even though the content is a perfectly valid .xlsx — preserve
// the original extension so downstream parsers can tell what they're
// reading.
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname)}`),
  }),
});
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function romanToArabic(roman) {
  const ROMAN = {
    I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7,
    VIII: 8, IX: 9, X: 10, XI: 11, XII: 12,
  };
  return ROMAN[roman] || roman;
}

// Data folders are named after whatever Year string a run was actually
// started with -- "2025-26" -> "2025_26". Every other Year input in this
// app (the "Start a run" dropdown, config.json) already uses that short
// form consistently, but a free-typed "2025-2026" is just as natural to
// type and would otherwise silently point at a folder that was never
// created, with an error that reads like the data itself is missing.
function normalizeYearLabel(year) {
  const m = (year || '').trim().match(/^(\d{4})-(\d{2,4})$/);
  if (!m) return year;
  const [, start, end] = m;
  return `${start}-${end.length === 4 ? end.slice(2) : end}`;
}

function listCsvFiles(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((f) => f.toLowerCase().endsWith('.csv')).sort();
}

// ─── Job orchestration ──────────────────────────────────────────────────────
//
// Only one job runs at a time: extractSection() drives a single shared
// Puppeteer page/browser tab through year/grade/section switches, so two
// jobs running concurrently would fight over that same tab's state.

const jobs = new Map();
let activeJob = null;

function createJob() {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'running',
    data: {},
    history: [],
    subscribers: new Set(),
  };
  job.emit = (evt) => {
    job.history.push(evt);
    for (const res of job.subscribers) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
  job.log = (line) => job.emit({ type: 'log', line: String(line) });
  job.setStatus = (status, data = {}) => {
    job.status = status;
    job.data = { ...job.data, ...data };
    job.emit({ type: 'status', status, data: job.data });
    if (status === 'done' || status === 'error' || status === 'stopped') activeJob = null;
  };
  // Stopping mid-extraction can't just set a flag and wait — a single
  // extractSection() call can sit inside a long await (a page.evaluate,
  // a wait for a selector) with no cancellation hook of its own. Killing
  // the active child process handles the filter/deck stages; disconnecting
  // the shared Puppeteer browser handles extraction — every in-flight
  // protocol call rejects immediately, which the per-section try/catch in
  // runExtractionPipeline already treats as a (now expected) failure.
  job.cancel = () => {
    job.cancelled = true;
    if (job.activeChild) {
      try { job.activeChild.kill('SIGTERM'); } catch (e) { /* already exited */ }
    }
    if (job.browser) {
      try { job.browser.disconnect(); } catch (e) { /* already disconnected */ }
    }
  };
  jobs.set(id, job);
  return job;
}

function reportFailure(job, e) {
  if (job.cancelled) {
    job.log('Stopped.');
    job.setStatus('stopped', {});
  } else {
    job.log(`Error: ${e.message}`);
    job.setStatus('error', { message: e.message });
  }
}

/**
 * extractSection/discoverSections log their progress via plain console.log
 * calls (used by the CLI wizard too), not a passed-in logger — capturing
 * console output for the duration of a job is simpler than threading a
 * logger through extract.js's whole call graph. Safe only because at most
 * one job ever runs at a time (enforced in the /api/run handler).
 */
async function withCapturedConsole(job, fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => job.log(args.map(String).join(' '));
  console.log = (...args) => { orig.log(...args); capture(...args); };
  console.warn = (...args) => { orig.warn(...args); capture(...args); };
  console.error = (...args) => { orig.error(...args); capture(...args); };
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
}

function spawnStreaming(job, cmd, args) {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error('Cancelled'));
    const child = spawn(cmd, args, { cwd: ROOT });
    job.activeChild = child;
    const onData = (buf) => {
      buf.toString('utf8').split(/\r?\n/).filter(Boolean).forEach((line) => job.log(line));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { job.activeChild = null; reject(e); });
    child.on('close', (code) => {
      job.activeChild = null;
      if (job.cancelled) return reject(new Error('Cancelled'));
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function runExtractionPipeline(job) {
  try {
    await withCapturedConsole(job, async () => {
      job.log('Connecting to reportbee...');
      const page = await connectToReportbeeTab();
      job.browser = page.browser();

      job.log(`Discovering sections for Grade ${job.grade}, Year ${job.year}...`);
      let sections = await discoverSections(page, job.year, job.grade);
      if (sections.length === 0) {
        throw new Error(`No sections found for Grade ${job.grade} in Year ${job.year}`);
      }
      job.log(`Sections found: ${sections.join(', ')}`);

      if (job.sectionFilter && job.sectionFilter.length > 0) {
        const wanted = new Set(job.sectionFilter.map((s) => s.toUpperCase()));
        const missing = [...wanted].filter((s) => !sections.some((sec) => sec.toUpperCase() === s));
        if (missing.length > 0) {
          throw new Error(`Section(s) not found for Grade ${job.grade}: ${missing.join(', ')} — available: ${sections.join(', ')}`);
        }
        sections = sections.filter((sec) => wanted.has(sec.toUpperCase()));
        job.log(`Sections filtered to: ${sections.join(', ')}`);
      }
      if (job.subjectFilter && job.subjectFilter.length > 0) {
        job.log(`Subjects filtered to: ${job.subjectFilter.join(', ')}`);
      }

      const yearFolder = job.year.replace(/-/g, '_');
      const termFolder = job.term.replace(/\s+/g, '_');
      job.gradeLabel = `Grade ${romanToArabic(job.grade)}`;
      job.dataFolder = path.join('data', yearFolder, termFolder);
      job.filteredFolder = path.join(job.dataFolder, 'filtered');
      job.failures = [];

      for (const section of sections) {
        if (job.cancelled) break;
        const gradeSection = `${job.grade} ${section}`;
        job.log(`── ${gradeSection}  |  ${job.year}  |  ${job.term} ──`);
        try {
          await extractSection(page, { gradeSection, yearLabel: job.year, termLabel: job.term, patchSubjects: job.subjectFilter || [] });
        } catch (e) {
          job.log(`Failed: ${gradeSection} — ${e.message}`);
          job.failures.push({ gradeSection, error: e.message });
        }
      }

      if (job.cancelled) throw new Error('Cancelled');

      job.log(`Data analysis done. ${sections.length - job.failures.length}/${sections.length} sections succeeded.`);
      job.data.rawFolder = job.dataFolder;
      job.data.rawFiles = listCsvFiles(job.dataFolder);
      job.log(`Raw CSVs: ${job.data.rawFiles.join(', ') || '(none)'}`);
    });

    const yearFolder = job.year.replace(/-/g, '_');
    const refPath = path.join(ROOT, 'reference', `standards_${yearFolder}.json`);
    if (fs.existsSync(refPath)) {
      job.log(`Using existing reference: reference/standards_${yearFolder}.json`);
      await runFilterStage(job);
    } else {
      job.log(`No dedicated reference workbook found for ${job.year} — without one, filtering falls back to the closest existing year (less precise, but not broken).`);
      job.setStatus('awaiting-reference', { yearLabel: job.year });
    }
  } catch (e) {
    reportFailure(job, e);
  }
}

async function resolveReferenceForJob(job, action, file) {
  const yearFolder = job.year.replace(/-/g, '_');
  const refPath = path.join(ROOT, 'reference', `standards_${yearFolder}.json`);

  if (action === 'template') {
    job.log(`Generating a blank reference template for ${job.year}...`);
    await spawnStreaming(job, PYTHON_CMD, [path.join(ROOT, 'reference', 'make_blank_template.py'), job.year]);
    job.log('Template generated — fill it in with the school\'s real standards, then upload it here on a future run. Continuing this run with the fallback reference.');
  } else if (action === 'upload') {
    if (!file) throw new Error('No file was uploaded');
    job.log(`Building reference/standards_${yearFolder}.json from ${file.originalname}...`);
    await spawnStreaming(job, PYTHON_CMD, [path.join(ROOT, 'reference', 'build_reference.py'), file.path, refPath]);
    job.log(`Built reference/standards_${yearFolder}.json`);
    fs.unlink(file.path, () => {});
  } else {
    job.log('Continuing with the fallback reference.');
  }

  await runFilterStage(job);
}

async function runFilterStage(job) {
  try {
    if (job.cancelled) throw new Error('Cancelled');
    job.log('Filtering standards...');
    await spawnStreaming(job, PYTHON_CMD, [path.join(ROOT, 'src', 'filter', 'filter_standards.py'), job.dataFolder, job.year]);
    job.log(`Filtered Standard CSVs written to ${job.filteredFolder}`);
    // Fetching data only ever fetches data -- there's no separate "build the
    // deck now?" decision step anymore, so this goes straight to 'done'.
    // Merging (and building a deck, via the standalone "Merge existing
    // data" panel) stays available afterward using this same job's folders.
    job.setStatus('done', {
      dataFolder: job.dataFolder,
      filteredFolder: job.filteredFolder,
      filteredFiles: listCsvFiles(job.filteredFolder),
      failures: job.failures,
    });
  } catch (e) {
    reportFailure(job, e);
  }
}

// ─── Tree apply (parse xlsx + write to the live reportbee tree) ────────────
//
// Unlike extraction, this deletes and recreates live grading structure —
// each subject's plan is computed and held for an explicit apply/skip
// decision (job.pendingSubject) rather than applied automatically the way
// the CLI (apply_tree.js) does, since silently rewriting a shared tree with
// no per-change review is a much bigger blast radius than writing a CSV.

const VALID_TREE_GRADES = ['IV', 'V', 'VI', 'VII'];

// job.gradeSectionInput is comma/newline separated -- "VII A", "VII A, VII
// B", "VII A, VII B, VII C" all parse the same way, one Grade+Section token
// at a time, so mixing grades in one run (e.g. "VII A, VI B") works too:
// each entry carries its own grade, which is all the per-grade xlsx parsing
// below needs to know.
function parseGradeSectionList(input) {
  const entries = (input || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((raw) => {
    const [grade, ...sectionParts] = raw.split(/\s+/);
    const section = sectionParts.join(' ');
    if (!grade || !section || !VALID_TREE_GRADES.includes(grade.toUpperCase())) {
      throw new Error(`"${raw}" isn't a valid Grade & Section — expected e.g. "VII A" with grade one of ${VALID_TREE_GRADES.join(', ')}`);
    }
    return { grade, section, gradeSectionLabel: `${grade} ${section}` };
  });
  if (entries.length === 0) {
    throw new Error('At least one Grade & Section is required (e.g. "VII A", or "VII A, VII B" for more than one).');
  }
  return entries;
}

async function runTreePipeline(job) {
  try {
    const entries = parseGradeSectionList(job.gradeSectionInput);

    await withCapturedConsole(job, async () => {
      if (job.forceRebuild) {
        job.log('Force apply is ON: every topic will be deleted and recreated from the xlsx, even ones that already look unchanged.');
      }
      if (entries.length > 1) {
        job.log(`Queued ${entries.length} sections: ${entries.map((e) => e.gradeSectionLabel).join(', ')}`);
      }
      job.log('Connecting to reportbee...');
      const page = await connectToReportbeeTab();
      job.browser = page.browser();
      job.page = page;

      job.log('Reloading tab for a clean tree read...');
      await page.reload({ waitUntil: 'networkidle2' });
      await delay(2000);
      await switchYear(page, job.year);

      // Parse the xlsx once per distinct Grade in the queue, up front --
      // multiple sections of the same grade (e.g. "VII A, VII B") share one
      // parse instead of re-reading the workbook per section, and the
      // upload gets deleted right after this, so every grade the run will
      // ever touch has to be read here rather than lazily per-section.
      job.targetByGrade = {};
      for (const grade of [...new Set(entries.map((e) => e.grade))]) {
        job.log(`Parsing tree workbook for Grade ${grade}...`);
        const target = treeLib.parseTreeXlsx(job.treeXlsxPath, grade, job.subjectFilter || undefined);
        const subjects = Object.keys(target).filter((name) => {
          if (treeLib.SKIP_SUBJECTS.includes(name.toLowerCase())) {
            job.log(`=== ${name} (Grade ${grade}) === Skipped (known limitation — see SKIP_SUBJECTS in apply_tree.js).`);
            return false;
          }
          return true;
        });
        if (subjects.length === 0) {
          throw new Error(`No matching subject(s) found in the tree xlsx for Grade ${grade}.`);
        }
        job.targetByGrade[grade] = { target, subjects };
      }
      if (job.applyWorkEthicsWeight) {
        job.targetWorkEthicsWeight = treeLib.readWorkEthicsWeight(job.treeXlsxPath);
        if (job.targetWorkEthicsWeight != null) {
          job.log(`Work Ethics weight from Scoring Guide sheet: ${job.targetWorkEthicsWeight} (will be applied to every subject where it differs)`);
        } else {
          job.log('Apply Work Ethics weight was checked, but no "Work Ethics" value was found in the Scoring Guide sheet — skipping.');
        }
      }
      fs.unlink(job.treeXlsxPath, () => {});

      job.sectionQueue = entries;
      job.sectionResults = [];
    });

    await advanceToNextSection(job);
  } catch (e) {
    reportFailure(job, e);
  }
}

// Pops the next queued Grade & Section, switches the live tab to it, and
// kicks off that section's own subject loop (advanceToNextSubject) -- once
// that loop empties this section's subjectQueue, it comes back here for the
// next one. Finishes the whole job once the section queue itself is empty.
async function advanceToNextSection(job) {
  await withCapturedConsole(job, async () => {
    if (job.sectionQueue.length === 0) {
      job.log('All sections processed.');
      // saveStructureTwoPhase saves via raw fetch() calls inside the page,
      // not real UI navigation -- the API call succeeds but the tree UI
      // itself never re-renders, so the tab keeps showing pre-run state
      // until reloaded. Reloaded once here, at the very end of the whole
      // run across every queued section (not per-section/per-subject --
      // confirmed preference, since a reload per subject means
      // re-navigating afterward too, adding real time for a payoff only
      // useful at the very end anyway). Best-effort: a reload failure
      // (e.g. the tab got closed) shouldn't stop the run from being
      // correctly reported as done -- the changes are already saved
      // regardless of whether this tab refresh succeeds.
      try {
        await job.page.reload({ waitUntil: 'networkidle2', timeout: 15000 });
        job.log('Reloaded the reportbee tab so the tree reflects the changes just applied.');
      } catch (e) {
        job.log(`Could not reload the reportbee tab automatically (${e.message}) -- refresh it manually to see the changes.`);
      }
      job.setStatus('done', { sectionResults: job.sectionResults });
      return;
    }

    if (job.cancelled) throw new Error('Cancelled');
    const { grade, section, gradeSectionLabel } = job.sectionQueue.shift();
    job.grade = grade;
    job.gradeSectionLabel = gradeSectionLabel;
    job.log(`── ${gradeSectionLabel} ──`);

    const page = job.page;
    await switchGradeSection(page, grade, section, job.planType);

    const { baseUrl, planId } = getPageContext(page);
    job.baseUrl = baseUrl;
    job.planId = planId;
    job.csrfToken = await getCsrfToken(page);

    // Term-level access token: re-sampled for every section switched to
    // (switchGradeSection navigates the page, which invalidates whatever
    // was sampled for the PREVIOUS section) -- still cached and reused
    // across every subject WITHIN this one section, same as before.
    job.accessToken = null;
    job.profileId = null;
    let termDomLabel = await findFullLabel(page, job.term);
    if (!termDomLabel) { await delay(2000); termDomLabel = await findFullLabel(page, job.term); }
    if (termDomLabel) {
      const { accessToken, profileId } = await sampleAuthParams(page, termDomLabel);
      // access_token/profile_id are session-level, not node-specific (see
      // sampleAuthParams's own comment) -- cached here so every subject
      // below reuses this instead of re-sampling from ITS OWN node. That
      // per-subject re-sampling used to be the only source, which broke
      // for SEL: its subject-level node ("Socio-Emotional Learning") is a
      // plain organizational node with no "Enter / View Marks" option at
      // all (only the linked-ReportPlan wrapper beneath it has that) --
      // confirmed live, 2026-08-21. The Term node always has it, so
      // sampling here once per section and reusing sidesteps that
      // per-subject gap entirely rather than special-casing SEL's node
      // again.
      job.accessToken = accessToken;
      job.profileId = profileId;
      await treeLib.ensureYearRootLabel(page, { baseUrl, planId, csrfToken: job.csrfToken, accessToken, profileId }, job.year);
    } else {
      job.log(`Could not find Term "${job.term}" to check the year root label — skipping that check.`);
    }

    const { target, subjects } = job.targetByGrade[grade];
    job.target = target;
    job.subjectQueue = [...subjects];
    job.subjectResults = [];
  });

  await advanceToNextSubject(job);
}

async function advanceToNextSubject(job) {
  await withCapturedConsole(job, async () => {
    while (job.subjectQueue.length > 0) {
      if (job.cancelled) throw new Error('Cancelled');
      const subjectName = job.subjectQueue.shift();
      const page = job.page;
      job.log(`=== ${subjectName} ===`);

      await treeLib.assertOnGradeSection(page, job.gradeSectionLabel, `before processing "${subjectName}"`);
      const liveName = await treeLib.navigateToSubject(page, job.term, subjectName);
      if (!liveName) {
        job.log(`Could not find "${subjectName}" under Term "${job.term}".`);
        job.subjectResults.push({ subject: subjectName, outcome: 'not-found' });
        continue;
      }
      if (liveName !== subjectName) job.log(`(matched to live subject "${liveName}")`);

      const liveSubject = await treeLib.readLiveSubject(page, liveName);
      if (!liveSubject) {
        job.log(`Found "${liveName}" but couldn't read its data.`);
        job.subjectResults.push({ subject: subjectName, outcome: 'read-failed' });
        continue;
      }

      // Reuse the Term-level token cached in runTreePipeline when
      // available (see its own comment) instead of re-sampling from this
      // subject's own node -- falls back to per-subject sampling only if
      // that initial cache attempt didn't happen (e.g. the Term node
      // itself couldn't be found).
      let accessToken = job.accessToken, profileId = job.profileId;
      if (!accessToken || !profileId) {
        const domLabel = await findFullLabel(page, liveName) || liveName;
        ({ accessToken, profileId } = await sampleAuthParams(page, domLabel));
        job.accessToken = accessToken;
        job.profileId = profileId;
      }
      const ctx = { baseUrl: job.baseUrl, planId: liveSubject.plan_id, csrfToken: job.csrfToken, accessToken, profileId };

      const { topics: liveTopics, wrapperUuidsToDelete, protectedParentUuid, protectedParentNode, subjectNode, subjectGradeTemplateId } = await treeLib.readLiveTree(page, ctx, liveSubject.uuid);
      // protectedParentNode (a real linked wrapper, e.g. SEL) wins when both
      // exist -- subjectNode (the subject's own record) is only a LAST
      // resort, for a subject with no sibling topic AND no wrapper at all
      // (a bare SEN subject). Mirrors the same fallback in apply_tree.js's
      // own main() (see readLiveTree's comment there) -- this web-server
      // path had fallen out of sync with the CLI and was still passing
      // protectedParentNode alone, so a bare subject applied through the
      // web UI still failed with NO TEMPLATE AVAILABLE even after the CLI
      // fix (0e8f59f) landed.
      const fallbackTemplate = protectedParentNode || subjectNode;
      const plan = treeLib.buildPlan(liveTopics, job.target[subjectName], protectedParentUuid || liveSubject.uuid, fallbackTemplate, job.forceRebuild, subjectGradeTemplateId, job.targetWorkEthicsWeight);
      for (const uuid of wrapperUuidsToDelete) {
        plan.deletes.push({ uuid, label: '[wrapper, deleted] redundant course_paper pass-through node' });
      }

      const updateList = Object.values(plan.updates);
      const createList = Object.values(plan.creates);
      if (plan.unchanged.length) {
        job.log(`${plan.unchanged.length} topic(s) already match the xlsx, left untouched: ${plan.unchanged.join(', ')}`);
      }

      if (updateList.length === 0 && plan.deletes.length === 0 && createList.length === 0) {
        // See apply_tree.js's own comment on this same split (CONFIRMED
        // live, 2026-08-21, Grade V-A SEL) -- the web UI previously didn't
        // even log plan.needsCreation's labels here at all, so a subject
        // where every topic failed with NO TEMPLATE AVAILABLE (nothing
        // anywhere to clone from -- usually never built at all) was
        // completely silent about it, reading identically to "already
        // correct".
        const failed = plan.needsCreation.filter((c) => c.label.includes('NO TEMPLATE AVAILABLE'));
        if (failed.length > 0) {
          job.log(`⚠️ Nothing was actually created — ${failed.length} creation(s) failed (NO TEMPLATE AVAILABLE):`);
          for (const f of failed) job.log(`  ${f.label}`);
          job.log('This subject likely has no existing structure anywhere to clone from yet.');
          job.subjectResults.push({ subject: subjectName, outcome: 'creation-failed' });
        } else {
          job.log('Nothing to apply for this subject.');
          job.subjectResults.push({ subject: subjectName, outcome: 'no-changes' });
        }
        continue;
      }

      // Normally pauses here for an explicit per-subject Apply/Skip (see the
      // block comment above runTreePipeline on why review is the default).
      // With job.autoApply set (the "Apply all subjects automatically"
      // checkbox), skip straight to saving this plan and move on to the
      // next subject in the same loop iteration -- no dialog, no pause.
      if (job.autoApply) {
        await applyPlan(job, subjectName, ctx, plan);
        continue;
      }

      job.pendingSubject = { subjectName, ctx, plan };
      job.setStatus('awaiting-subject-decision', {
        subjectName,
        gradeSectionLabel: job.gradeSectionLabel,
        remaining: job.subjectQueue.length,
        sectionsRemaining: job.sectionQueue.length,
        unchanged: plan.unchanged,
        updates: updateList.map((u) => u._label),
        deletes: plan.deletes.map((d) => d.label),
        creates: plan.needsCreation.map((c) => c.label),
      });
      return;
    }

    job.log(`All subjects processed for ${job.gradeSectionLabel}.`);
    job.sectionResults.push({ gradeSectionLabel: job.gradeSectionLabel, results: job.subjectResults });
  });

  await advanceToNextSection(job);
}

// Shared by the manual Apply button (applySubjectDecision, below) and the
// "Apply all subjects automatically" auto-apply path in
// advanceToNextSubject -- both just need to turn a computed plan into a
// saved one and record the outcome; the only difference between them is
// what happens before this runs (a dialog wait vs. nothing).
async function applyPlan(job, subjectName, ctx, plan) {
  const updateList = Object.values(plan.updates);
  const createList = Object.values(plan.creates);
  const updates = {};
  for (const u of updateList) {
    const { _label, ...clean } = u;
    updates[u.uuid] = clean;
  }
  for (const node of createList) updates[node.uuid] = node;
  const deleteUuids = plan.deletes.flatMap((d) => [d.uuid, ...(d.children || [])]);

  // The plan was computed earlier (possibly while the reviewer sat on
  // the awaiting-subject-decision dialog for a while) -- re-verify the
  // page hasn't drifted to a different section in the meantime before
  // actually saving. See assertOnGradeSection's own comment for why
  // this matters: this tab is a real, interactive browser window.
  await treeLib.assertOnGradeSection(job.page, job.gradeSectionLabel, `immediately before saving "${subjectName}"`);
  const result = await treeLib.saveStructureTwoPhase(job.page, ctx, { update: updates, deleteUuids });
  if (result.json && result.json.status) {
    job.log(`✅ ${subjectName}: ${result.json.message || 'applied'}`);
    job.subjectResults.push({ subject: subjectName, outcome: 'applied' });
  } else {
    job.log(`❌ ${subjectName}: ${JSON.stringify(result.json || result.rawText)}`);
    job.subjectResults.push({ subject: subjectName, outcome: 'apply-failed' });
  }
}

async function applySubjectDecision(job, action) {
  const { subjectName, ctx, plan } = job.pendingSubject;
  job.pendingSubject = null;

  if (action === 'apply') {
    await withCapturedConsole(job, () => applyPlan(job, subjectName, ctx, plan));
  } else {
    job.log(`Skipped ${subjectName} (not applied).`);
    job.subjectResults.push({ subject: subjectName, outcome: 'skipped' });
  }

  await advanceToNextSubject(job);
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * Years come from whatever reference workbooks or past data folders already
 * exist — not a hardcoded list, since a new academic year (with neither
 * yet) is exactly the case the "Other…" fallback in the UI covers.
 */
function listYearOptions() {
  const years = new Set();
  const refDir = path.join(ROOT, 'reference');
  if (fs.existsSync(refDir)) {
    for (const f of fs.readdirSync(refDir)) {
      const m = f.match(/^standards_(\d{4})_(\d{2,4})\.json$/);
      if (m) years.add(`${m[1]}-${m[2]}`);
    }
  }
  const dataDir = path.join(ROOT, 'data');
  if (fs.existsSync(dataDir)) {
    for (const f of fs.readdirSync(dataDir)) {
      const m = f.match(/^(\d{4})_(\d{2,4})$/);
      if (m) years.add(`${m[1]}-${m[2]}`);
    }
  }
  return Array.from(years).sort().reverse();
}

function listTermOptions() {
  const terms = new Set(['Term 1', 'Term 2', 'Term 3']);
  const dataDir = path.join(ROOT, 'data');
  if (fs.existsSync(dataDir)) {
    for (const yearDir of fs.readdirSync(dataDir)) {
      const yearPath = path.join(dataDir, yearDir);
      if (!fs.statSync(yearPath).isDirectory()) continue;
      for (const termDir of fs.readdirSync(yearPath)) {
        if (fs.statSync(path.join(yearPath, termDir)).isDirectory()) {
          terms.add(termDir.replace(/_/g, ' '));
        }
      }
    }
  }
  return Array.from(terms).sort();
}

app.get('/api/config', (req, res) => {
  let config = { year: '', terms: [], grades: [] };
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'config', 'batch.json'))];
    config = require(path.join(ROOT, 'config', 'batch.json'));
  } catch (e) { /* no config yet — fall back to blank defaults */ }
  res.json({ ...config, yearOptions: listYearOptions(), termOptions: listTermOptions() });
});

app.get('/api/status', async (req, res) => {
  try {
    const versionRes = await fetch('http://localhost:9222/json/version');
    if (!versionRes.ok) throw new Error('debug port not responding');
    const targets = await (await fetch('http://localhost:9222/json/list')).json();
    const reportbeeTabOpen = targets.some((t) => (t.url || '').includes('reportbee.com'));
    res.json({ chromeDebugReady: true, reportbeeTabOpen });
  } catch (e) {
    res.json({ chromeDebugReady: false, reportbeeTabOpen: false });
  }
});

// Launching the actual Chrome binary directly (rather than `open -a Google
// Chrome --args ...`) starts a genuinely separate process with its own
// --user-data-dir, alongside any Chrome the user already has open — macOS's
// `open -a` instead just re-focuses an already-running bundle without
// applying new --args, and quitting the existing Chrome first (an earlier
// version of this route did that) is both destructive to the user's other
// tabs and racy, since the quit is async and the relaunch could fire before
// it finishes. No need to touch the user's existing Chrome at all.
//
// Paths are OS-specific and, on Windows, also vary by install type (a
// per-machine install lands under Program Files, a per-user install --
// common when the installing account isn't an admin -- lands under
// %LOCALAPPDATA% instead), so several candidates are checked per platform.
const CHROME_BINARY_PATHS = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  win32: [
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/google-chrome'],
}[process.platform] || [];

app.post('/api/open-chrome', async (req, res) => {
  // Launching the binary again while a debug-profile Chrome is already up
  // points a second process at the same --user-data-dir, which Chrome
  // treats as a profile-lock conflict — it shows its own "already running"
  // prompt instead of just handing focus to the existing window, which is
  // what looked like being asked to log in again. If the debug port is
  // already answering, there's nothing to launch — just report success.
  try {
    const versionRes = await fetch('http://localhost:9222/json/version');
    if (versionRes.ok) {
      return res.json({ ok: true, alreadyRunning: true });
    }
  } catch (e) { /* debug port not up yet — fall through to launch it */ }

  const chromePath = CHROME_BINARY_PATHS.find((p) => fs.existsSync(p));
  if (!chromePath) {
    return res.status(500).json({ error: 'Could not find a Google Chrome install in any of the usual places for this OS' });
  }
  try {
    const profileDir = path.join(os.homedir(), 'chrome-debug-profile');
    spawn(chromePath, [`--remote-debugging-port=9222`, `--user-data-dir=${profileDir}`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    res.json({ ok: true, alreadyRunning: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/jobs/current', (req, res) => {
  if (!activeJob) return res.json({ jobId: null });
  res.json({ jobId: activeJob.id, kind: activeJob.kind || 'extract', status: activeJob.status, data: activeJob.data });
});

app.post('/api/run', (req, res) => {
  if (activeJob) {
    return res.status(409).json({ error: 'A run is already in progress', jobId: activeJob.id });
  }
  const { grade, year, term, section, subject } = req.body || {};
  if (!grade || !year || !term) {
    return res.status(400).json({ error: 'Grade, Year, and Term are all required' });
  }
  const job = createJob();
  job.kind = 'extract';
  job.grade = grade;
  job.year = normalizeYearLabel(year);
  job.term = term;
  // Both optional, comma-separated -- blank means every section / every
  // subject, same as before these existed. Subject reuses extractSection's
  // own patchSubjects filter (substring match against each subject's live
  // name).
  job.sectionFilter = (section || '').split(',').map((s) => s.trim()).filter(Boolean);
  job.subjectFilter = (subject || '').split(',').map((s) => s.trim()).filter(Boolean);
  activeJob = job;
  res.json({ jobId: job.id });
  runExtractionPipeline(job);
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  for (const evt of job.history) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  job.subscribers.add(res);
  req.on('close', () => job.subscribers.delete(res));
});

app.post('/api/jobs/:id/reference', upload.single('xlsxFile'), (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'awaiting-reference') {
    return res.status(409).json({ error: 'Job is not awaiting a reference decision' });
  }
  res.json({ ok: true });
  resolveReferenceForJob(job, req.body.action, req.file).catch((e) => reportFailure(job, e));
});

const MERGE_KINDS = ['raw', 'filtered', 'sel'];

// Shared by the job-based merge (available on the Done screen right after a
// fresh run) and the standalone one (merging data that already existed from an
// earlier session, with no active job at all) -- both just need to know
// which Grade/Year/Term/folder-kind to point merge_csv.py at. "sel" reads
// from the same raw folder as "raw" (SEL/ROC data is never filtered --
// filter_standards.py doesn't process it at all) but selects only the
// *_ROC.csv companions via scaleSuffix, instead of excluding them.
function mergePaths(grade, year, term, which) {
  const yearFolder = normalizeYearLabel(year).replace(/-/g, '_');
  const termFolder = term.replace(/\s+/g, '_');
  const dataFolder = path.join('data', yearFolder, termFolder);
  const folder = which === 'filtered' ? path.join(dataFolder, 'filtered') : dataFolder;
  const scaleSuffix = which === 'sel' ? '_ROC' : '';
  const outPath = path.join(ROOT, 'output', yearFolder, termFolder, `Grade_${romanToArabic(grade)}_${termFolder}_merged_${which}.xlsx`);
  return { folder, outPath, scaleSuffix };
}

async function mergeCsvForJob(job, which) {
  const { folder, outPath, scaleSuffix } = mergePaths(job.grade, job.year, job.term, which);
  job.log(`Merging ${which} CSVs from ${folder} (Grade ${job.grade})...`);
  await spawnStreaming(job, PYTHON_CMD, [path.join(ROOT, 'src', 'merge_csv.py'), folder, outPath, job.grade, scaleSuffix]);
  const relOut = path.relative(ROOT, outPath);
  job.data.mergedFiles = { ...(job.data.mergedFiles || {}), [which]: relOut };
  job.emit({ type: 'merge-done', which, path: relOut });
}

// A side action available on the Done screen right after a fresh
// extraction -- doesn't touch job.status, so it can run any number of times,
// independently of the other merge kinds.
app.post('/api/jobs/:id/merge', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done' || !job.filteredFolder) {
    return res.status(409).json({ error: 'Job has not finished fetching data yet' });
  }
  const { which } = req.body || {};
  if (!MERGE_KINDS.includes(which)) {
    return res.status(400).json({ error: `which must be one of ${MERGE_KINDS.join(', ')}` });
  }
  res.json({ ok: true });
  mergeCsvForJob(job, which).catch((e) => job.log(`Merge failed: ${e.message}`));
});

// Standalone: merges CSVs already sitting on disk from an earlier run, with
// no active job needed at all -- this is a pure local file operation, no
// reportbee session required.
app.post('/api/merge', async (req, res) => {
  const { grade, year, term, which } = req.body || {};
  if (!grade || !year || !term) {
    return res.status(400).json({ error: 'Grade, Year, and Term are all required' });
  }
  if (!MERGE_KINDS.includes(which)) {
    return res.status(400).json({ error: `which must be one of ${MERGE_KINDS.join(', ')}` });
  }
  const { folder, outPath, scaleSuffix } = mergePaths(grade, year, term, which);
  if (!fs.existsSync(path.join(ROOT, folder))) {
    return res.status(404).json({ error: `No ${which} data found at ${folder} -- run extraction for this Grade/Year/Term first` });
  }
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(PYTHON_CMD, [path.join(ROOT, 'src', 'merge_csv.py'), folder, outPath, grade, scaleSuffix], { cwd: ROOT });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `exited with code ${code}`))));
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true, path: path.relative(ROOT, outPath) });
});

// Standalone: builds a deck from filtered CSVs that already exist on disk,
// same as the "Merge existing data" section -- no active job, no fresh
// extraction, just Grade/Year/Term pointing at data from an earlier run.
app.post('/api/deck', async (req, res) => {
  const { grade, year, term } = req.body || {};
  if (!grade || !year || !term) {
    return res.status(400).json({ error: 'Grade, Year, and Term are all required' });
  }
  const yearFolder = normalizeYearLabel(year).replace(/-/g, '_');
  const termFolder = term.replace(/\s+/g, '_');
  const filteredFolder = path.join('data', yearFolder, termFolder, 'filtered');
  if (!fs.existsSync(path.join(ROOT, filteredFolder))) {
    return res.status(404).json({ error: `No filtered data found at ${filteredFolder} -- run extraction (and filtering) for this Grade/Year/Term first` });
  }
  const gradeLabel = `Grade ${romanToArabic(grade)}`;
  const outPath = path.join(ROOT, 'output', yearFolder, termFolder, `Grade_${romanToArabic(grade)}_${termFolder}_Data_Analysis.pptx`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(PYTHON_CMD, [path.join(ROOT, 'src', 'deck', 'build_deck.py'), filteredFolder, gradeLabel, outPath], { cwd: ROOT });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `exited with code ${code}`))));
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true, path: path.relative(ROOT, outPath) });
});

// Populates the Build Tree form's Subject dropdown -- subjects live in the
// uploaded xlsx itself (parse_tree_xlsx.py already reads them per Grade),
// so this uploads its own throwaway copy just to list them and deletes it
// right after; the real "Start tree apply" submission uploads the file
// again independently, unchanged from before this existed.
app.post('/api/tree/subjects', upload.single('treeFile'), (req, res) => {
  const { grade } = req.body || {};
  if (!grade) return res.status(400).json({ error: 'Grade is required' });
  if (!req.file) return res.status(400).json({ error: 'A tree .xlsx file is required' });
  try {
    const parsed = treeLib.parseTreeXlsx(req.file.path, grade);
    res.json({ ok: true, subjects: Object.keys(parsed) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

app.post('/api/tree/run', upload.single('treeFile'), (req, res) => {
  if (activeJob) {
    return res.status(409).json({ error: 'A run is already in progress', jobId: activeJob.id });
  }
  const { gradeSection, term, year, planType, subjectFilter, forceApply, applyWorkEthicsWeight, autoApply } = req.body || {};
  if (!gradeSection || !term || !year) {
    return res.status(400).json({ error: 'Grade & Section, Term, and Year are all required' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'A tree .xlsx file is required' });
  }
  const job = createJob();
  job.kind = 'tree';
  job.gradeSectionInput = gradeSection;
  job.term = term;
  job.year = year;
  job.planType = planType || 'Academic';
  job.subjectFilter = subjectFilter || '';
  job.forceRebuild = forceApply === 'true' || forceApply === true;
  job.applyWorkEthicsWeight = applyWorkEthicsWeight === 'true' || applyWorkEthicsWeight === true;
  job.autoApply = autoApply === 'true' || autoApply === true;
  job.treeXlsxPath = req.file.path;
  activeJob = job;
  res.json({ jobId: job.id });
  runTreePipeline(job);
});

app.post('/api/jobs/:id/subject-decision', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'awaiting-subject-decision') {
    return res.status(409).json({ error: 'Job is not awaiting a subject decision' });
  }
  res.json({ ok: true });
  applySubjectDecision(job, req.body.action).catch((e) => reportFailure(job, e));
});

app.post('/api/jobs/:id/stop', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (['done', 'error', 'stopped'].includes(job.status)) {
    return res.status(409).json({ error: 'Job has already finished' });
  }
  job.log('Stop requested — cancelling as soon as possible...');
  const isPaused = ['awaiting-reference', 'awaiting-subject-decision'].includes(job.status);
  job.cancel();
  if (isPaused) job.setStatus('stopped', {});
  res.json({ ok: true });
});

function resolveWithinRoot(target) {
  if (!target) return null;
  const resolved = path.resolve(ROOT, target);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) return null;
  return resolved;
}

// Opens a file/URL with whatever the OS's default handler is -- macOS's
// `open`, Windows' `start` (a cmd.exe builtin, not its own executable,
// hence running it through cmd /c; the empty "" first argument is `start`'s
// window-title slot, required whenever the target itself might contain
// spaces or it gets misread as the title instead), Linux's `xdg-open`.
function openWithDefaultApp(target) {
  if (process.platform === 'darwin') execFileSync('open', [target]);
  else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '""', target]);
  else execFileSync('xdg-open', [target]);
}

app.post('/api/reveal', (req, res) => {
  const resolved = resolveWithinRoot(req.body && req.body.path);
  if (!resolved) return res.status(400).json({ error: 'invalid path' });
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'not found' });
  try {
    openWithDefaultApp(resolved);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/download', (req, res) => {
  const resolved = resolveWithinRoot(req.query.path);
  if (!resolved) return res.status(400).json({ error: 'invalid path' });
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return res.status(404).json({ error: 'not found' });
  }
  res.download(resolved);
});

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Quillsmith is running at ${url}`);
  try {
    openWithDefaultApp(url);
  } catch (e) { /* not fatal — user can open the URL manually */ }
});
