/**
 * Guided, step-by-step alternative to `batch.js` — for someone running this
 * on their own machine who doesn't want to hand-edit config/batch.json or
 * remember the extract -> filter -> deck command sequence. Installs missing
 * dependencies itself, then walks through each step, printing exactly where
 * every output file lands (raw CSVs, filtered CSVs, the finished deck) since
 * that's the thing that isn't obvious from the scripted flow.
 *
 * Usage: node src/wizard.js
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { extractSection, connectToReportbeeTab, discoverSections } = require('./extract/extract');

const ROOT = path.join(__dirname, '..');

function romanToArabic(roman) {
  const ROMAN = {
    I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7,
    VIII: 8, IX: 9, X: 10, XI: 11, XII: 12,
  };
  return ROMAN[roman] || roman;
}

/**
 * Chained rl.question() calls silently drop buffered lines when stdin is
 * piped rather than a real TTY — all lines arrive and get "line" events
 * emitted before the next question() has attached its one-time listener,
 * so anything not consumed by the first question is lost (confirmed via a
 * minimal repro). extract.js's readInputs() sidesteps this by collecting
 * every line up front over a persistent 'line' listener when non-TTY,
 * instead of asking one at a time — same fix here, just generalized to an
 * unknown number of prompts instead of a fixed 4.
 */
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
        rl.question(`${question}${suffix}: `, (answer) => {
          resolve(answer.trim() || defaultValue || '');
        });
      });
    }
    await queueReady;
    const line = queue.shift();
    const value = line || defaultValue || '';
    console.log(`${question}${suffix}: ${value}`);
    return value;
  };
}

function ensureDependencies() {
  const nodeModulesOk = fs.existsSync(path.join(ROOT, 'node_modules', 'puppeteer'));
  if (!nodeModulesOk) {
    console.log('📦 Node dependencies missing — running npm install...');
    execFileSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit' });
  }

  let pythonOk = true;
  try {
    execFileSync('python3', ['-c', 'import matplotlib, openpyxl'], { cwd: ROOT, stdio: 'ignore' });
  } catch (e) {
    pythonOk = false;
  }
  if (!pythonOk) {
    console.log('📦 Python dependencies missing — running pip install...');
    execFileSync('python3', ['-m', 'pip', 'install', '-r', 'requirements.txt'], { cwd: ROOT, stdio: 'inherit' });
  }
}

function listCsvFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv')).sort();
}

function printFileList(label, dir) {
  const files = listCsvFiles(dir);
  console.log(`\n📂 ${label}: ${path.resolve(dir)}`);
  if (files.length === 0) {
    console.log('   (no CSV files found)');
  } else {
    for (const f of files) console.log(`   - ${f}`);
  }
  return files;
}

async function resolveReference(prompt, yearLabel) {
  const yearFolder = yearLabel.replace(/-/g, '_');
  const refFilename = `standards_${yearFolder}.json`;
  const refPath = path.join(ROOT, 'reference', refFilename);

  if (fs.existsSync(refPath)) {
    console.log(`📘 Using existing reference: reference/${refFilename}`);
    return;
  }

  console.log(`\n⚠️  No dedicated reference workbook found for ${yearLabel} (reference/${refFilename} doesn't exist).`);
  console.log('   Without one, filtering falls back to the closest existing year\'s reference —');
  console.log('   less precise, but not broken.');
  const choice = await prompt(
    '   Provide a path to a filled-in xlsx workbook now, type "template" for a blank one to fill in later, or press enter to continue with the fallback',
    ''
  );

  if (!choice) return;

  if (choice.toLowerCase() === 'template') {
    execFileSync('python3', [path.join(ROOT, 'reference', 'make_blank_template.py'), yearLabel], { cwd: ROOT, stdio: 'inherit' });
    console.log(`   Fill that in with the school's real standards, then rerun the wizard and provide its path when asked.`);
    console.log(`   Continuing this run with the fallback reference.`);
    return;
  }

  const xlsxPath = path.isAbsolute(choice) ? choice : path.join(ROOT, choice);
  if (!fs.existsSync(xlsxPath)) {
    console.warn(`   ⚠️  "${xlsxPath}" not found — continuing with the fallback reference instead.`);
    return;
  }

  execFileSync('python3', [path.join(ROOT, 'reference', 'build_reference.py'), xlsxPath, refPath], { cwd: ROOT, stdio: 'inherit' });
  console.log(`   ✅ Built reference/${refFilename} from ${xlsxPath}`);
}

async function main() {
  ensureDependencies();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = createPrompter(rl);

  let config = {};
  try {
    config = require(path.join(ROOT, 'config', 'batch.json'));
  } catch (e) { /* no config yet — fall back to blank defaults */ }

  const grade = (await prompt('📥 Grade (e.g. VII)', (config.grades || [])[0] || '')).trim();
  const yearLabel = (await prompt('📥 Year (e.g. 2025-26)', config.year || '')).trim();
  const termLabel = (await prompt('📥 Term (e.g. Term 1)', (config.terms || [])[0] || '')).trim();

  if (!grade || !yearLabel || !termLabel) {
    console.error('❌ Grade, Year, and Term are all required.');
    rl.close();
    process.exit(1);
  }

  const page = await connectToReportbeeTab();

  console.log(`\n🔎 Discovering sections for Grade ${grade}, Year ${yearLabel}...`);
  const sections = await discoverSections(page, yearLabel, grade);
  if (sections.length === 0) {
    console.error(`❌ No sections found for Grade ${grade} in Year ${yearLabel}`);
    rl.close();
    process.exit(1);
  }
  console.log(`   Sections found: ${sections.join(', ')}`);

  const yearFolder = yearLabel.replace(/-/g, '_');
  const termFolder = termLabel.replace(/\s+/g, '_');
  const gradeLabel = `Grade ${romanToArabic(grade)}`;
  const dataFolder = path.join('data', yearFolder, termFolder);
  const filteredFolder = path.join(dataFolder, 'filtered');

  const failures = [];
  for (const section of sections) {
    const gradeSection = `${grade} ${section}`;
    console.log(`\n─────────────────────────────────────────────────────────────────`);
    console.log(`▶️  ${gradeSection}  |  ${yearLabel}  |  ${termLabel}`);
    console.log(`─────────────────────────────────────────────────────────────────`);
    try {
      await extractSection(page, { gradeSection, yearLabel, termLabel, patchSubjects: [] });
    } catch (e) {
      console.error(`❌ Failed: ${gradeSection} — ${e.message}`);
      failures.push({ gradeSection, error: e.message });
    }
  }

  console.log(`\n🎉 Extraction done. ${sections.length - failures.length}/${sections.length} sections succeeded.`);
  if (failures.length > 0) {
    console.log('⚠️  Failures:');
    for (const f of failures) console.log(`   - ${f.gradeSection}: ${f.error}`);
  }

  printFileList('Raw CSVs written to', dataFolder);

  await resolveReference(prompt, yearLabel);

  console.log(`\n▶️  Filtering standards...`);
  execFileSync('python3', [path.join(ROOT, 'src', 'filter', 'filter_standards.py'), dataFolder, yearLabel], { cwd: ROOT, stdio: 'inherit' });
  printFileList('Filtered Standard CSVs written to', filteredFolder);

  const buildDeck = (await prompt('\n📥 Build the PPT deck now? (Y/n)', 'Y')).trim().toLowerCase();
  rl.close();

  if (buildDeck.startsWith('n')) {
    console.log(`\nSkipping deck build. Run this later when you're ready:`);
    console.log(`   python3 src/deck/build_deck.py ${filteredFolder} "${gradeLabel}"`);
    process.exit(failures.length > 0 ? 1 : 0);
  }

  const outPath = path.join(ROOT, 'output', yearFolder, termFolder, `Grade_${romanToArabic(grade)}_${termFolder}_Data_Analysis.pptx`);
  console.log(`\n▶️  Building deck: ${gradeLabel}, ${termLabel}`);
  execFileSync('python3', [path.join(ROOT, 'src', 'deck', 'build_deck.py'), filteredFolder, gradeLabel, outPath], { cwd: ROOT, stdio: 'inherit' });
  console.log(`\n🎉 Deck built: ${outPath}`);

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
