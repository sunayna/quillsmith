/**
 * One-off: applies a partial update to existing nodes via reportbee's
 * save_structure_v2 endpoint (reverse-engineered by watching Network while
 * manually editing the Build Structure tree — see src/build_tree/sniff.js
 * and sniff_log.json). Only touches nodes that already exist (a subset of
 * their own fields), which is a much smaller, better-understood payload
 * shape than full node creation (~40 interdependent fields) — safer for a
 * first real write.
 *
 * This is intentionally a one-off script, not a generic library yet: the
 * uuid/field values below are specific to the Grade 7 2026-27 English
 * "Interpretation of Spoken Texts" standard update.
 */
const {
  connectToReportbeeTab, getPageContext, getCsrfToken, sampleAuthParams, findFullLabel,
} = require('../extract/extract');

// Batch 3: Reading — collapsing 7 carried-over standards down to the 3 the
// 2026-27 xlsx actually specifies. Reuses the closest thematic match for
// each (rename + reweight, matching the pattern proven in batches 1-2),
// and deletes the 4 standards with no match left in the new xlsx (plus
// their single assessment child each, so nothing gets orphaned). Plan
// confirmed with the user before running, including which nodes to keep
// vs delete.
const UPDATES = {
  // Standard 1 "Thinking Within the Text": reuse S1, reweight 20 -> 30
  '9db0a142-dd70-4ef4-9409-280f1690f0cf': {
    uuid: '9db0a142-dd70-4ef4-9409-280f1690f0cf',
    name: 'Thinking Within the Text: Processes a text to derive its literal meaning by solving unfamiliar words, monitoring and self-correcting reading, using contextual clues to determine word meanings, and summarising key ideas to demonstrate overall comprehension',
    conversion_score: 30,
    should_convert: true,
  },
  'c2f20997-d8d9-4ce6-9d95-6832b26cf8ce': {
    uuid: 'c2f20997-d8d9-4ce6-9d95-6832b26cf8ce',
    name: 'Summary of Non-Fictional Text',
    conversion_score: 100,
    should_convert: true,
  },
  // Standard 2 "Thinking Beyond the Text": reuse S3 (social issue), reweight 15 -> 40
  'c1d3fdb6-08e5-42b8-9695-005da6810366': {
    uuid: 'c1d3fdb6-08e5-42b8-9695-005da6810366',
    name: 'Thinking Beyond the Text: Interprets a text by making predictions and connections to previous knowledge, personal experiences, and other texts, synthesising new information by incorporating it into existing understanding, and inferring meanings that the author has implied but not explicitly stated',
    conversion_score: 40,
    should_convert: true,
  },
  '9d5887dc-0723-4e96-a2b3-2cb9d985986e': {
    uuid: '9d5887dc-0723-4e96-a2b3-2cb9d985986e',
    name: 'Character Analysis',
    conversion_score: 100,
    should_convert: true,
  },
  // Standard 3 "Thinking About the Text": reuse S4 (writer's craft), reweight 20 -> 30;
  // keeps its existing 3 LT children untouched per the confirmed plan.
  '89d12e33-a177-4810-9059-10998f421288': {
    uuid: '89d12e33-a177-4810-9059-10998f421288',
    name: "Thinking About the Text: Analyzes the text by examining and evaluating the author's craft, including the use of language, characterisation, organisation, and structure, to understand how these elements shape meaning and communicate the author's purpose",
    conversion_score: 30,
    should_convert: true,
  },
};

// S2 (universal lesson/theme), S5 (genre/sub-genre), S6 (reads grade level
// texts), S7 (reading life) have no match in the 2026-27 xlsx at all —
// delete each along with its single assessment child.
const DELETES = [
  'f3b4333a-60c4-4c94-a878-b00568245d12', '1fff768d-e434-46dc-888b-94fb19639fa9', // S2 + child
  'f69ab2da-09e0-4b22-86fb-eee43d7b893f', '71c43c79-6d8a-419f-bd09-b54fea80ef35', // S5 + child
  '3b628e00-eea6-462f-8aa9-c0474575f7f0', 'da4bd91a-4505-4a89-8606-5bcabd35cb64', // S6 + child
  '51fefc16-6f17-4904-9911-2c3c742372ee', 'ff9ad1e7-5fdb-4f72-bcef-1f0f4f31d3dc', // S7 + child
];

async function saveStructure(page, { baseUrl, planId, csrfToken, accessToken, profileId }, changes) {
  return page.evaluate(async (args) => {
    const { baseUrl, planId, csrfToken, accessToken, profileId, changes } = args;
    const body = new URLSearchParams();
    body.set('cp_structure_changes', JSON.stringify(changes));
    body.set('authenticity_token', csrfToken);
    body.set('access_token', accessToken);
    body.set('current_user_profile_id', profileId);

    const res = await fetch(`${baseUrl}/rb_records/exam_plans/${planId}/save_structure_v2`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* leave null, return raw text below */ }
    return { status: res.status, json, rawText: json ? null : text.slice(0, 2000) };
  }, { baseUrl, planId, csrfToken, accessToken, profileId, changes });
}

async function main() {
  const page = await connectToReportbeeTab();
  console.log('Attached:', page.url());

  const { baseUrl, planId } = getPageContext(page);
  const csrfToken = await getCsrfToken(page);

  const domLabel = await findFullLabel(page, 'English');
  if (!domLabel) throw new Error('Could not find "English" node in DOM to sample auth params');
  const { accessToken, profileId } = await sampleAuthParams(page, domLabel);
  console.log('Sampled auth OK');

  const changes = { update: UPDATES, delete: DELETES, copy_marks: [] };
  console.log('Sending update:', JSON.stringify(changes, null, 2));

  const result = await saveStructure(page, { baseUrl, planId, csrfToken, accessToken, profileId }, changes);
  console.log('Response status:', result.status);
  if (result.json) {
    console.log('Response body:', JSON.stringify(result.json, null, 2));
  } else {
    console.log('Response was not JSON. Raw text (first 2000 chars):');
    console.log(result.rawText);
  }

  // puppeteer.connect() keeps the process alive on an open CDP connection
  // even after there's nothing left to do — disconnect() detaches without
  // closing the user's actual browser tab, then exit explicitly.
  await page.browser().disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
