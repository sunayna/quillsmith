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

const ROOT = path.join(__dirname, '..', '..');
const PORT = process.env.PORT || 4173;
const UPLOAD_DIR = path.join(ROOT, '.uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR });
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
      const sections = await discoverSections(page, job.year, job.grade);
      if (sections.length === 0) {
        throw new Error(`No sections found for Grade ${job.grade} in Year ${job.year}`);
      }
      job.log(`Sections found: ${sections.join(', ')}`);

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
          await extractSection(page, { gradeSection, yearLabel: job.year, termLabel: job.term, patchSubjects: [] });
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
    await spawnStreaming(job, 'python3', [path.join(ROOT, 'reference', 'make_blank_template.py'), job.year]);
    job.log('Template generated — fill it in with the school\'s real standards, then upload it here on a future run. Continuing this run with the fallback reference.');
  } else if (action === 'upload') {
    if (!file) throw new Error('No file was uploaded');
    job.log(`Building reference/standards_${yearFolder}.json from ${file.originalname}...`);
    await spawnStreaming(job, 'python3', [path.join(ROOT, 'reference', 'build_reference.py'), file.path, refPath]);
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
    await spawnStreaming(job, 'python3', [path.join(ROOT, 'src', 'filter', 'filter_standards.py'), job.dataFolder, job.year]);
    job.log(`Filtered Standard CSVs written to ${job.filteredFolder}`);
    job.setStatus('awaiting-deck-decision', {
      dataFolder: job.dataFolder,
      filteredFolder: job.filteredFolder,
      filteredFiles: listCsvFiles(job.filteredFolder),
      failures: job.failures,
    });
  } catch (e) {
    reportFailure(job, e);
  }
}

async function buildDeckForJob(job) {
  const yearFolder = job.year.replace(/-/g, '_');
  const termFolder = job.term.replace(/\s+/g, '_');
  const outPath = path.join(ROOT, 'output', yearFolder, termFolder, `Grade_${romanToArabic(job.grade)}_${termFolder}_Data_Analysis.pptx`);
  job.log(`Building deck: ${job.gradeLabel}, ${job.term}`);
  await spawnStreaming(job, 'python3', [path.join(ROOT, 'src', 'deck', 'build_deck.py'), job.filteredFolder, job.gradeLabel, outPath]);
  job.log(`Deck built: ${outPath}`);
  job.setStatus('done', { outPath, failures: job.failures });
}

// ─── Tree apply (parse xlsx + write to the live reportbee tree) ────────────
//
// Unlike extraction, this deletes and recreates live grading structure —
// each subject's plan is computed and held for an explicit apply/skip
// decision (job.pendingSubject) rather than applied automatically the way
// the CLI (apply_tree.js) does, since silently rewriting a shared tree with
// no per-change review is a much bigger blast radius than writing a CSV.

async function runTreePipeline(job) {
  try {
    const [grade, ...sectionParts] = job.gradeSection.trim().split(/\s+/);
    const section = sectionParts.join(' ');
    const VALID_GRADES = ['IV', 'V', 'VI', 'VII'];
    if (!grade || !section || !VALID_GRADES.includes(grade.toUpperCase())) {
      throw new Error(`"${job.gradeSection}" isn't a valid Grade & Section — expected e.g. "VII A" with grade one of ${VALID_GRADES.join(', ')}`);
    }
    job.grade = grade;

    await withCapturedConsole(job, async () => {
      job.log('Connecting to reportbee...');
      const page = await connectToReportbeeTab();
      job.browser = page.browser();
      job.page = page;

      job.log('Reloading tab for a clean tree read...');
      await page.reload({ waitUntil: 'networkidle2' });
      await delay(2000);
      await switchYear(page, job.year);
      await switchGradeSection(page, grade, section, job.planType);

      const { baseUrl, planId } = getPageContext(page);
      job.baseUrl = baseUrl;
      job.planId = planId;
      job.csrfToken = await getCsrfToken(page);

      let termDomLabel = await findFullLabel(page, job.term);
      if (!termDomLabel) { await delay(2000); termDomLabel = await findFullLabel(page, job.term); }
      if (termDomLabel) {
        const { accessToken, profileId } = await sampleAuthParams(page, termDomLabel);
        await treeLib.ensureYearRootLabel(page, { baseUrl, planId, csrfToken: job.csrfToken, accessToken, profileId }, job.year);
      } else {
        job.log(`Could not find Term "${job.term}" to check the year root label — skipping that check.`);
      }

      job.log('Parsing tree workbook...');
      const target = treeLib.parseTreeXlsx(job.treeXlsxPath, grade, job.subjectFilter || undefined);
      fs.unlink(job.treeXlsxPath, () => {});
      const subjects = Object.keys(target).filter((name) => {
        if (treeLib.SKIP_SUBJECTS.includes(name.toLowerCase())) {
          job.log(`=== ${name} === Skipped (known limitation — see SKIP_SUBJECTS in apply_tree.js).`);
          return false;
        }
        return true;
      });
      if (subjects.length === 0) {
        throw new Error('No matching subject(s) found in the tree xlsx for this grade.');
      }

      job.target = target;
      job.subjectQueue = subjects;
      job.subjectResults = [];
    });

    await advanceToNextSubject(job);
  } catch (e) {
    reportFailure(job, e);
  }
}

async function advanceToNextSubject(job) {
  await withCapturedConsole(job, async () => {
    while (job.subjectQueue.length > 0) {
      if (job.cancelled) throw new Error('Cancelled');
      const subjectName = job.subjectQueue.shift();
      const page = job.page;
      job.log(`=== ${subjectName} ===`);

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

      const domLabel = await findFullLabel(page, liveName) || liveName;
      const { accessToken, profileId } = await sampleAuthParams(page, domLabel);
      const ctx = { baseUrl: job.baseUrl, planId: liveSubject.plan_id, csrfToken: job.csrfToken, accessToken, profileId };

      const { topics: liveTopics, wrapperUuidsToDelete } = await treeLib.readLiveTree(page, ctx, liveSubject.uuid);
      const plan = treeLib.buildPlan(liveTopics, job.target[subjectName], liveSubject.uuid);
      for (const uuid of wrapperUuidsToDelete) {
        plan.deletes.push({ uuid, label: '[wrapper, deleted] redundant course_paper pass-through node' });
      }

      const updateList = Object.values(plan.updates);
      const createList = Object.values(plan.creates);

      if (updateList.length === 0 && plan.deletes.length === 0 && createList.length === 0) {
        job.log('Nothing to apply for this subject.');
        job.subjectResults.push({ subject: subjectName, outcome: 'no-changes' });
        continue;
      }

      job.pendingSubject = { subjectName, ctx, plan };
      job.setStatus('awaiting-subject-decision', {
        subjectName,
        remaining: job.subjectQueue.length,
        updates: updateList.map((u) => u._label),
        deletes: plan.deletes.map((d) => d.label),
        creates: plan.needsCreation.map((c) => c.label),
      });
      return;
    }

    job.log('All subjects processed.');
    job.setStatus('done', { results: job.subjectResults });
  });
}

async function applySubjectDecision(job, action) {
  const { subjectName, ctx, plan } = job.pendingSubject;
  job.pendingSubject = null;

  if (action === 'apply') {
    await withCapturedConsole(job, async () => {
      const updateList = Object.values(plan.updates);
      const createList = Object.values(plan.creates);
      const updates = {};
      for (const u of updateList) {
        const { _label, ...clean } = u;
        updates[u.uuid] = clean;
      }
      for (const node of createList) updates[node.uuid] = node;
      const deleteUuids = plan.deletes.flatMap((d) => [d.uuid, ...(d.children || [])]);
      const changes = { update: updates, delete: deleteUuids, copy_marks: [] };

      const result = await treeLib.saveStructure(job.page, ctx, changes);
      if (result.json && result.json.status) {
        job.log(`✅ ${subjectName}: ${result.json.message || 'applied'}`);
        job.subjectResults.push({ subject: subjectName, outcome: 'applied' });
      } else {
        job.log(`❌ ${subjectName}: ${JSON.stringify(result.json || result.rawText)}`);
        job.subjectResults.push({ subject: subjectName, outcome: 'apply-failed' });
      }
    });
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
const CHROME_BINARY_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

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
    return res.status(500).json({ error: 'Could not find Google Chrome in /Applications' });
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
  const { grade, year, term } = req.body || {};
  if (!grade || !year || !term) {
    return res.status(400).json({ error: 'Grade, Year, and Term are all required' });
  }
  const job = createJob();
  job.kind = 'extract';
  job.grade = grade;
  job.year = year;
  job.term = term;
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

app.post('/api/jobs/:id/deck', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'awaiting-deck-decision') {
    return res.status(409).json({ error: 'Job is not awaiting a deck decision' });
  }
  res.json({ ok: true });
  if (req.body.action === 'skip') {
    job.log('Skipping deck build. Run this later when ready:');
    job.log(`python3 src/deck/build_deck.py ${job.filteredFolder} "${job.gradeLabel}"`);
    job.setStatus('done', { failures: job.failures });
    return;
  }
  buildDeckForJob(job).catch((e) => reportFailure(job, e));
});

app.post('/api/tree/run', upload.single('treeFile'), (req, res) => {
  if (activeJob) {
    return res.status(409).json({ error: 'A run is already in progress', jobId: activeJob.id });
  }
  const { gradeSection, term, year, planType, subjectFilter } = req.body || {};
  if (!gradeSection || !term || !year) {
    return res.status(400).json({ error: 'Grade & Section, Term, and Year are all required' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'A tree .xlsx file is required' });
  }
  const job = createJob();
  job.kind = 'tree';
  job.gradeSection = gradeSection;
  job.term = term;
  job.year = year;
  job.planType = planType || 'Academic';
  job.subjectFilter = subjectFilter || '';
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
  const isPaused = ['awaiting-reference', 'awaiting-deck-decision', 'awaiting-subject-decision'].includes(job.status);
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

app.post('/api/reveal', (req, res) => {
  const resolved = resolveWithinRoot(req.body && req.body.path);
  if (!resolved) return res.status(400).json({ error: 'invalid path' });
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'not found' });
  try {
    execFileSync('open', [resolved]);
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
  if (process.platform === 'darwin') {
    try {
      execFileSync('open', [url]);
    } catch (e) { /* not fatal — user can open the URL manually */ }
  }
});
