/**
 * Creates the "Metals and Non-metals" topic under Module (Grade VII A,
 * 2026-27) — genuinely missing, no existing live topic resembles it at
 * all (unlike "Light and Shadows", which overlaps with an existing
 * "Light" topic and needs a human decision first). Same clone-template
 * approach validated on "Seasons".
 */
const crypto = require('crypto');
const {
  connectToReportbeeTab, getPageContext, getCsrfToken, sampleAuthParams, findFullLabel, fetchNodeMarks,
} = require('../extract/extract');

const MODULE_SUBJECT_UUID = '730f7963-4ae5-42b6-b063-8fa57b12616f';
const TEMPLATE_TOPIC_UUID = '0515875c-f836-4c39-8559-17ae5121454a'; // Temperature and Its Measurement
const TEMPLATE_STANDARD_UUID = '6e6ca212-8c05-46fd-ac1e-4c511b1fa8f3';
const TEMPLATE_SA_UUID = '4f2fa62b-0ddd-4f25-bd34-a25dfc73da10'; // only need SA this time -- xlsx has no FA here

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

async function main() {
  const page = await connectToReportbeeTab();
  const { baseUrl, planId } = getPageContext(page);
  const csrfToken = await getCsrfToken(page);
  const domLabel = await findFullLabel(page, 'Module');
  const { accessToken, profileId } = await sampleAuthParams(page, domLabel || 'Module');
  const ctx = { baseUrl, planId: '11F1317D-0273-CF6E-9CCF-35F9A0118B42', csrfToken, accessToken, profileId };

  const topicJson = await fetchNodeMarks(page, { ...ctx, nodeUuid: TEMPLATE_TOPIC_UUID });
  const templateTopic = (topicJson.data.all_nodes || []).find(n => n.uuid === TEMPLATE_TOPIC_UUID);

  const stdJson = await fetchNodeMarks(page, { ...ctx, nodeUuid: TEMPLATE_STANDARD_UUID });
  const stdNodes = stdJson.data.all_nodes || [];
  const templateStandard = stdNodes.find(n => n.uuid === TEMPLATE_STANDARD_UUID);
  const templateSA = stdNodes.find(n => n.uuid === TEMPLATE_SA_UUID);

  if (!templateTopic || !templateStandard || !templateSA) {
    throw new Error('Could not fetch one or more templates — aborting.');
  }

  const newTopicUuid = crypto.randomUUID();
  const newStdUuid = crypto.randomUUID();
  const newSaUuid = crypto.randomUUID();

  const newTopic = cloneAsNew(templateTopic, {
    uuid: newTopicUuid,
    name: 'Metals and Non-metals',
    short_name: 'SK4',
    parent_uuid: MODULE_SUBJECT_UUID,
    children_uuids: [newStdUuid],
    order: 45,
    conversion_score: 15,
    should_convert: true,
  });

  const newStandard = cloneAsNew(templateStandard, {
    uuid: newStdUuid,
    name: 'Analyses the physical and chemical properties of metals and non-metals to understand how those properties influence their classification, behavior, and uses',
    short_name: 'S1',
    parent_uuid: newTopicUuid,
    children_uuids: [newSaUuid],
    order: 10,
    conversion_score: 100,
    should_convert: templateStandard.should_convert,
  });

  const newSA = cloneAsNew(templateSA, {
    uuid: newSaUuid,
    name: 'SA',
    short_name: 'SA',
    parent_uuid: newStdUuid,
    children_uuids: [],
    order: 10,
    conversion_score: 100,
    should_convert: true,
  });

  const changes = {
    update: { [newTopicUuid]: newTopic, [newStdUuid]: newStandard, [newSaUuid]: newSA },
    delete: [],
    copy_marks: [],
  };

  console.log('New uuids:', { newTopicUuid, newStdUuid, newSaUuid });

  const result = await page.evaluate(async (args) => {
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
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, json, rawText: json ? null : text.slice(0, 1500) };
  }, { baseUrl, planId: ctx.planId, csrfToken, accessToken, profileId, changes });

  console.log('Response status:', result.status);
  if (result.json) {
    console.log(result.json.status ? '✅ ' + result.json.message : '❌ ' + JSON.stringify(result.json));
  } else {
    console.log('❌ Non-JSON response:', result.rawText);
  }

  await page.browser().disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
