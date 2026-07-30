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

async function main() {
  const grade = process.argv[2];
  if (!grade) {
    console.error('usage: node src/batch.js <Grade Roman, e.g. VII> [--skip-deck]');
    process.exit(1);
  }
  const skipDeck = process.argv.includes('--skip-deck');

  const config = loadConfig();
  if (!config.grades.includes(grade)) {
    console.error(`❌ Grade "${grade}" is not listed in config/batch.json`);
    process.exit(1);
  }

  const page = await connectToReportbeeTab();

  console.log(`🔎 Discovering sections for Grade ${grade}, Year ${config.year}...`);
  const sections = await discoverSections(page, config.year, grade);
  if (sections.length === 0) {
    console.error(`❌ No sections found for Grade ${grade} in Year ${config.year} — check the grade exists for that year`);
    process.exit(1);
  }

  console.log(`▶️  Batch: Grade ${grade}  |  Year: ${config.year}  |  Terms: ${config.terms.join(', ')}`);
  console.log(`   Sections found: ${sections.join(', ')}\n`);

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
          patchSubjects: [],
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
