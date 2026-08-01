/**
 * One-off investigation tool: connects to the already-open, already-logged-in
 * reportbee tab (same CDP connection extract.js uses) and logs every
 * XHR/fetch request reportbee's own JS makes, so we can watch what happens
 * when a human manually adds/edits a node on the "Build Structure" tree page.
 *
 * We've only ever reverse-engineered the READ side (exam_plan_node_marks/fetch,
 * discovered the same way — watch Network while doing the action manually,
 * then read off the request shape). This does the same thing for the WRITE
 * side (creating Topics/Standards with weightage + grading), which we've
 * never investigated.
 *
 * Usage:
 *   node src/build_tree/sniff.js
 * Then, in the actual Chrome window: navigate to the Grade 7 / 2026-27 /
 * Expedition exam plan's Build Structure page, and manually add one Topic
 * and one Standard (with weightage + score/grade) through the UI. Every
 * matching request gets printed here AND appended to sniff_log.json.
 *
 * Filters out obvious noise (images, css, fonts, analytics) — keeps anything
 * that looks like a reportbee API call (XHR/fetch, JSON-ish, same-origin).
 */
const fs = require('fs');
const path = require('path');
const { connectToReportbeeTab } = require('../extract/extract');

const LOG_PATH = path.join(__dirname, 'sniff_log.json');

const NOISE_EXT = /\.(png|jpg|jpeg|gif|svg|woff2?|ttf|css|ico)(\?|$)/i;
const NOISE_HOST = /google-analytics|googletagmanager|doubleclick|sentry|hotjar|intercom/i;

function shouldLog(url, resourceType) {
  if (NOISE_HOST.test(url)) return false;
  if (NOISE_EXT.test(url)) return false;
  if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) return false;
  return true;
}

async function main() {
  const page = await connectToReportbeeTab();
  console.log(`✅ Attached to reportbee tab: ${page.url()}`);
  console.log(`📝 Logging to: ${LOG_PATH}`);
  console.log(`\n👉 Now go create/edit a node in the Build Structure UI — every relevant request will print below.\n`);

  const entries = [];
  const pending = new Map(); // requestId-ish key -> request info

  page.on('request', (req) => {
    const url = req.url();
    if (!shouldLog(url, req.resourceType())) return;
    if (!['xhr', 'fetch', 'document'].includes(req.resourceType())) return;

    const info = {
      time: new Date().toISOString(),
      method: req.method(),
      url,
      resourceType: req.resourceType(),
      postData: req.postData() || null,
    };
    pending.set(req, info);
  });

  page.on('requestfinished', async (req) => {
    const info = pending.get(req);
    if (!info) return;
    pending.delete(req);

    try {
      const res = req.response();
      const ct = res.headers()['content-type'] || '';
      let body = null;
      if (ct.includes('application/json') || ct.includes('text/')) {
        try { body = await res.text(); } catch (e) { body = `<unreadable: ${e.message}>`; }
      } else {
        body = `<binary, content-type: ${ct}>`;
      }
      info.status = res.status();
      info.responseBody = body && body.length > 4000 ? body.slice(0, 4000) + '...<truncated>' : body;
    } catch (e) {
      info.status = null;
      info.responseBody = `<error reading response: ${e.message}>`;
    }

    entries.push(info);
    fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2), 'utf8');

    console.log(`\n─────────────────────────────────────────`);
    console.log(`${info.method} ${info.url}`);
    if (info.postData) console.log(`  body: ${info.postData}`);
    console.log(`  -> ${info.status}`);
    if (info.responseBody) console.log(`  response: ${info.responseBody.slice(0, 500)}`);
  });

  console.log('Press Ctrl+C here when done capturing.');
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
