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

async function getNodeUuid(page, domLabel) {
  return page.evaluate((lbl) => {
    for (const g of document.querySelectorAll('g.node')) {
      const nameEl = g.querySelector('text.node-name');
      if (nameEl && nameEl.textContent.trim() === lbl) {
        return g.__data__?.uuid || null;
      }
    }
    return null;
  }, domLabel);
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

async function zoomOut(page, times = 5) {
  for (let i = 0; i < times; i++) {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      const zoomOut = btns.find(b =>
        b.querySelector('span.icon-minus') && !b.closest('g')
      );
      zoomOut?.click();
    });
    await delay(150);
  }
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
  const btn   = await group.evaluateHandle(el => el.querySelector('g.svg-btn.open-close-btn'));
  const box   = await btn.boundingBox();
  if (!box) return false;

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await delay(1500);
  await zoomOut(page, 5);
  return true;
}

async function getChildrenFromData(page, domLabel) {
  return page.evaluate((lbl) => {
    for (const g of document.querySelectorAll('g.node')) {
      const nameEl = g.querySelector('text.node-name');
      if (!nameEl || nameEl.textContent.trim() !== lbl) continue;
      const d = g.__data__;
      if (!d) return [];
      const kids = d.children || d._children || [];
      return kids.map(c => ({ name: c.name || '', uuid: c.uuid || '' })).filter(c => c.uuid);
    }
    return [];
  }, domLabel);
}

async function findDomLabelByUuid(page, uuid) {
  return page.evaluate((uid) => {
    for (const g of document.querySelectorAll('g.node')) {
      if (g.__data__?.uuid === uid) {
        return g.querySelector('text.node-name')?.textContent.trim() || null;
      }
    }
    return null;
  }, uuid);
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
 * Open a node's 3-dot menu just long enough to read the href of its
 * "Enter / View Marks" link — that href already carries access_token and
 * current_user_profile_id, so we don't need to open the actual marks popup.
 * access_token/current_user_profile_id are session-level, not node-specific,
 * so it doesn't matter which node we sample this from.
 */
async function sampleAuthParams(page, domLabel) {
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

  const groupBox = await group.boundingBox();
  if (groupBox) {
    await page.mouse.move(groupBox.x + groupBox.width / 2, groupBox.y + groupBox.height / 2);
    await delay(300);
  }

  const optionBtn = await group.evaluateHandle(el => el.querySelector('g.svg-btn.option-btn'));
  const btnBox = await optionBtn.boundingBox();
  if (!btnBox) throw new Error(`Options button not found for sampling on: ${domLabel}`);

  await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
  await delay(800);

  const href = await page.evaluate(() => {
    const link = Array.from(document.querySelectorAll('#node-options-popbox a.hook'))
      .find(a => a.textContent.includes('Enter / View Marks'));
    return link ? link.getAttribute('href') : null;
  });

  await page.evaluate(() => {
    if (typeof closeAllPopbox === 'function') closeAllPopbox();
  });
  await page.keyboard.press('Escape').catch(() => {});
  await delay(300);

  if (!href) throw new Error(`Could not find "Enter / View Marks" link on: ${domLabel} to sample auth params`);
  const url = new URL(href, page.url());
  return {
    accessToken: url.searchParams.get('access_token'),
    profileId: url.searchParams.get('current_user_profile_id')
  };
}

/**
 * Fetch marks for a single node + its direct children, using the browser's
 * own authenticated fetch (so cookies/session are reused automatically).
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

function writeLeafRow(ctx, subject, nodeInfo, marksForNode) {
  const counts = { S: 0, P: 0, M: 0, E: 0 };
  for (const studentId of Object.keys(marksForNode)) {
    const grade = marksForNode[studentId].grade;
    if (Object.prototype.hasOwnProperty.call(counts, grade)) counts[grade]++;
  }

  const standardName = (nodeInfo.name || '').trim();
  console.log(`🎯 ${standardName} → S=${counts.S}, P=${counts.P}, M=${counts.M}, E=${counts.E}`);

  const row = `${ctx.academicYear},${ctx.classAndSection},${subject || 'Unknown'},${standardName},${counts.S},${counts.P},${counts.M},${counts.E}\n`;
  const isNewFile = !fs.existsSync(ctx.csvFilePath);
  fs.appendFileSync(ctx.csvFilePath, isNewFile ? 'Year,Class,Subject,Standard,S,P,M,E\n' + row : row, 'utf8');
}

/**
 * Recursively walk the tree via the API alone (no DOM interaction), writing
 * a CSV row for every true leaf (children_uuids null/empty).
 */
async function collectLeaves(page, authCtx, nodeUuid, ctx) {
  let json;
  try {
    json = await fetchNodeMarks(page, { ...authCtx, nodeUuid });
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
        const match = ctx.patchSubjects.some(s => normalize(subject).includes(normalize(s)));
        if (!match) {
          console.log(`⏭️  Skipping subject: ${subject}`);
          continue;
        }
        console.log(`✅ Patch match: ${subject}`);
      }
    }

    const isLeaf = !childInfo.children_uuids || childInfo.children_uuids.length === 0;
    if (isLeaf) {
      const leafMarks = marks[childUuid];
      if (!leafMarks) {
        console.warn(`⚠️  No marks found for leaf: ${childInfo.name}`);
        continue;
      }
      writeLeafRow(ctx, subject, childInfo, leafMarks);
    } else {
      await collectLeaves(page, authCtx, childUuid, { ...ctx, subject });
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

async function switchGradeSection(page, grade, section) {
  const currentClass = await page.evaluate(() =>
    document.querySelector('a.all-standards-link')?.textContent.trim() || ''
  );
  const expectedClass = `${grade} ${section}`;

  if (currentClass === expectedClass) {
    console.log(`✅ Already on ${expectedClass}`);
    return expectedClass;
  }

  await page.evaluate(() => document.querySelector('a.all-standards-link')?.click());
  await page.waitForSelector('#all-standards-list', { visible: true });
  await delay(500);

  await page.evaluate((g) => {
    Array.from(document.querySelectorAll('a.standard-js'))
      .find(a => a.dataset.standardname.trim() === g)?.click();
  }, grade);
  await delay(500);

  await page.evaluate(({ section, grade }) => {
    Array.from(document.querySelectorAll('a.section-js'))
      .find(a => a.dataset.sectionname.trim() === section && a.dataset.standardname.trim() === grade)?.click();
  }, { section, grade });

  console.log(`✅ Selected ${expectedClass}`);

  try {
    await page.waitForSelector('.card-footer a.btn.gamma-btn', { visible: true, timeout: 8000 });
    await page.evaluate(() => document.querySelector('.card-footer a.btn.gamma-btn')?.click());
  } catch (e) {
    console.warn('⚠️  View button not found, checking if already on exam plan...');
  }

  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {}),
    page.waitForSelector('text.node-name', { visible: true, timeout: 10000 }).catch(() => {})
  ]);
  await delay(1000);

  console.log(`✅ Loaded exam plan for ${expectedClass}`);
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

  const classAndSection = await switchGradeSection(page, grade, section);
  const academicYear = yearLabel;

  const yearFolder = yearLabel.replace(/-/g, '_');
  const dataDir = path.join(__dirname, '..', '..', 'data', yearFolder);
  fs.mkdirSync(dataDir, { recursive: true });
  const csvFilePath = path.join(dataDir, `${classAndSection.replace(/\s+/g, '_')}.csv`);

  if (patchSubjects.length === 0 && fs.existsSync(csvFilePath)) {
    fs.unlinkSync(csvFilePath);
    console.log(`🗑️  Cleared ${path.basename(csvFilePath)}`);
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

  const termUuid = await getNodeUuid(page, termDomLabel);
  if (!termUuid) {
    throw new Error(`Could not resolve uuid for Term node "${termLabel}"`);
  }

  const termChildren = await getChildrenFromData(page, termDomLabel);
  if (termChildren.length === 0) {
    throw new Error(`Term node "${termLabel}" has no children — nothing to extract`);
  }

  const firstChildDomLabel = await findDomLabelByUuid(page, termChildren[0].uuid) || termChildren[0].name;
  console.log(`🔑 Sampling auth params from: ${termChildren[0].name}`);

  const { accessToken, profileId } = await sampleAuthParams(page, firstChildDomLabel);
  const csrfToken = await getCsrfToken(page);
  const { baseUrl, planId } = getPageContext(page);

  if (!accessToken || !profileId || !csrfToken || !baseUrl || !planId) {
    throw new Error(
      `Missing auth/context values — ` +
      `accessToken=${!!accessToken} profileId=${!!profileId} csrfToken=${!!csrfToken} ` +
      `baseUrl=${!!baseUrl} planId=${!!planId}`
    );
  }
  console.log(`✅ Got auth context (plan_id=${planId})`);

  if (patchSubjects.length > 0) {
    console.log(`🔧 Patch mode — only extracting: ${patchSubjects.join(', ')}\n`);
  } else {
    console.log(`🚀 Full run mode\n`);
  }

  console.log(`🚀 Starting API-based extraction from Term: "${termLabel}"\n`);
  await collectLeaves(
    page,
    { baseUrl, planId, csrfToken, accessToken, profileId },
    termUuid,
    { classAndSection, academicYear, subject: '', patchSubjects, csvFilePath }
  );

  console.log(`\n✅ Done. Wrote ${csvFilePath}`);
  return csvFilePath;
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

module.exports = { extractSection, connectToReportbeeTab };

if (require.main === module) {
  runCli().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
