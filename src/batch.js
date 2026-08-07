const path = require('path');
const { execFileSync } = require('child_process');
const { extractSection, connectToReportbeeTab, discoverSections } = require('./extract/extract');

const ROOT = path.join(__dirname, '..');

function loadConfig() {
  return require(path.join(ROOT, 'config', 'batch.json'));
}

function romanToArabic(roman) {
  const ROMAN = {
    I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7,
    VIII: 8, IX: 9, X: 10, XI: 11, XII: 12,
  };
  return ROMAN[roman] || roman;
}

// --section=A,B and --subject=Math,Hindi are both optional, comma-separated,
// case-insensitive narrowing filters -- omit either to keep the previous
// "every section, every subject" behavior. --subject reuses extractSection's
// own patchSubjects (substring match against each subject's live name), the
// same filter already exposed on the single-section CLI but never wired up
// to the batch/all-sections path until now.
function parseListFlag(name) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return [];
  return arg.slice(name.length + 3).split(',').map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const grade = process.argv[2];
  if (!grade) {
    console.error('usage: node src/batch.js <Grade Roman, e.g. VII> [--skip-deck] [--section=A,B] [--subject=Math,Hindi]');
    process.exit(1);
  }
  const skipDeck = process.argv.includes('--skip-deck');
  const sectionFilter = parseListFlag('section');
  const subjectFilter = parseListFlag('subject');

  const config = loadConfig();
  if (!config.grades.includes(grade)) {
    console.error(`❌ Grade "${grade}" is not listed in config/batch.json`);
    process.exit(1);
  }

  const page = await connectToReportbeeTab();

  console.log(`🔎 Discovering sections for Grade ${grade}, Year ${config.year}...`);
  let sections = await discoverSections(page, config.year, grade);
  if (sections.length === 0) {
    console.error(`❌ No sections found for Grade ${grade} in Year ${config.year} — check the grade exists for that year`);
    process.exit(1);
  }

  if (sectionFilter.length > 0) {
    const wanted = new Set(sectionFilter.map((s) => s.toUpperCase()));
    const missing = [...wanted].filter((s) => !sections.some((sec) => sec.toUpperCase() === s));
    if (missing.length > 0) {
      console.error(`❌ Section(s) not found for Grade ${grade}: ${missing.join(', ')} — available: ${sections.join(', ')}`);
      process.exit(1);
    }
    sections = sections.filter((sec) => wanted.has(sec.toUpperCase()));
  }

  console.log(`▶️  Batch: Grade ${grade}  |  Year: ${config.year}  |  Terms: ${config.terms.join(', ')}`);
  console.log(`   Sections: ${sections.join(', ')}${sectionFilter.length ? ' (filtered)' : ''}`);
  if (subjectFilter.length > 0) console.log(`   Subjects: ${subjectFilter.join(', ')} (filtered)`);
  console.log('');

  const yearFolder = config.year.replace(/-/g, '_');
  const gradeLabel = `Grade ${romanToArabic(grade)}`;
  const failures = [];

  // A deck is built per term, not per grade — each term's report is a
  // separate document a school actually hands out, and CSVs live in
  // per-term folders (data/<year>/<term>/) so extracting Term 2 can never
  // silently overwrite Term 1's data the way a shared filename would.
  for (const term of config.terms) {
    for (const section of sections) {
      const gradeSection = `${grade} ${section}`;
      console.log(`\n─────────────────────────────────────────────────────────────────`);
      console.log(`▶️  ${gradeSection}  |  ${config.year}  |  ${term}`);
      console.log(`─────────────────────────────────────────────────────────────────`);
      try {
        await extractSection(page, {
          gradeSection,
          yearLabel: config.year,
          termLabel: term,
          patchSubjects: subjectFilter,
        });
      } catch (e) {
        console.error(`❌ Failed: ${gradeSection} | ${term} — ${e.message}`);
        failures.push({ gradeSection, term, error: e.message });
      }
    }

    if (skipDeck) continue;

    const termFolder = term.replace(/\s+/g, '_');
    const dataFolder = path.join('data', yearFolder, termFolder);
    const filteredFolder = path.join(dataFolder, 'filtered');
    const outPath = path.join(ROOT, 'output', yearFolder, termFolder, `Grade_${romanToArabic(grade)}_${termFolder}_Data_Analysis.pptx`);

    console.log(`\n▶️  Filtering standards: ${gradeLabel}, ${term}`);
    execFileSync(
      'python3',
      [path.join(ROOT, 'src', 'filter', 'filter_standards.py'), dataFolder, config.year],
      { cwd: ROOT, stdio: 'inherit' }
    );

    console.log(`\n▶️  Building deck: ${gradeLabel}, ${term}`);
    execFileSync(
      'python3',
      [path.join(ROOT, 'src', 'deck', 'build_deck.py'), filteredFolder, gradeLabel, outPath],
      { cwd: ROOT, stdio: 'inherit' }
    );
  }

  const totalRuns = sections.length * config.terms.length;
  console.log(`\n🎉 Extraction done. ${totalRuns - failures.length}/${totalRuns} sections succeeded.`);
  if (failures.length > 0) {
    console.log('⚠️  Failures:');
    for (const f of failures) console.log(`   - ${f.gradeSection} | ${f.term}: ${f.error}`);
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
