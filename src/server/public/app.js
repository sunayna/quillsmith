const sections = {
  form: document.getElementById('form-section'),
  'tree-form': document.getElementById('tree-form-section'),
  'tree-subject': document.getElementById('tree-subject-section'),
  log: document.getElementById('log-section'),
  reference: document.getElementById('reference-section'),
  deck: document.getElementById('deck-section'),
  done: document.getElementById('done-section'),
  error: document.getElementById('error-section'),
};

function show(...names) {
  for (const [name, el] of Object.entries(sections)) {
    el.classList.toggle('hidden', !names.includes(name));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let currentJobKind = 'extract';

function setTab(tab) {
  document.getElementById('tab-analysis').classList.toggle('active', tab === 'analysis');
  document.getElementById('tab-tree').classList.toggle('active', tab === 'tree');
  show(tab === 'tree' ? 'tree-form' : 'form');
  // Not part of the show()-managed sections map -- it's a standalone
  // utility available any time on the Data Analysis tab, independent of
  // whatever state a run is in, not a step in either pipeline's flow.
  document.getElementById('merge-existing-section').classList.toggle('hidden', tab !== 'analysis');
}

document.getElementById('tab-analysis').onclick = () => { if (!currentJobId) setTab('analysis'); };
document.getElementById('tab-tree').onclick = () => { if (!currentJobId) setTab('tree'); };

const logEl = document.getElementById('log');
function appendLog(line) {
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

let currentJobId = null;
let eventSource = null;

function connectToJob(jobId) {
  currentJobId = jobId;
  logEl.textContent = '';
  document.getElementById('stop-btn').disabled = false;
  show('log');
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/jobs/${jobId}/events`);
  eventSource.onmessage = (e) => {
    const evt = JSON.parse(e.data);
    if (evt.type === 'log') {
      appendLog(evt.line);
    } else if (evt.type === 'status') {
      handleStatus(evt.status, evt.data);
    } else if (evt.type === 'merge-done') {
      renderMergedFile(evt.which, evt.path);
    }
  };
}

const MERGE_LABELS = { raw: 'Raw', filtered: 'Filtered', sel: 'SEL' };

function renderMergedFile(which, relPath) {
  const label = MERGE_LABELS[which] || which;
  const el = document.getElementById('merged-files');
  el.innerHTML += `<p>${label} merge: <a href="${downloadUrl(relPath)}">${relPath}</a></p>`;
}

function downloadUrl(relPath) {
  return `/api/download?path=${encodeURIComponent(relPath)}`;
}

function renderFileList(folder, files) {
  if (!files || !files.length) return '<p>(none)</p>';
  return `<ul class="file-list">${files.map((f) => {
    const full = `${folder}/${f}`;
    return `<li><a href="${downloadUrl(full)}">${f}</a></li>`;
  }).join('')}</ul>`;
}

function handleStatus(status, data) {
  if (status === 'running') {
    show('log');
  } else if (status === 'awaiting-reference') {
    show('log', 'reference');
  } else if (status === 'awaiting-deck-decision') {
    const filesEl = document.getElementById('filtered-files');
    if (data.filteredFiles && data.filteredFiles.length) {
      filesEl.innerHTML = `<p>Filtered CSVs written to <code>${data.filteredFolder}</code>:</p>
        ${renderFileList(data.filteredFolder, data.filteredFiles)}`;
    } else {
      filesEl.innerHTML = `<p>No filtered CSVs were produced — check the log above.</p>`;
    }
    document.getElementById('merged-files').innerHTML = '';
    // "Skip for now" already ends the run cleanly here, unlike
    // awaiting-reference/awaiting-subject-decision which have no equivalent
    // "end the whole run" option of their own -- Stop is redundant (and
    // reads as if something's still actively running) once we're just
    // waiting on this decision.
    document.getElementById('stop-btn').disabled = true;
    show('log', 'deck');
  } else if (status === 'awaiting-subject-decision') {
    document.getElementById('tree-subject-heading').textContent = `Review: ${data.subjectName}`;
    document.getElementById('tree-subject-meta').textContent =
      `${data.remaining} subject(s) remaining after this one.`;
    document.getElementById('tree-subject-plan').innerHTML = `
      <p>${data.updates.length} update(s):</p>${renderPlanList(data.updates)}
      <p>${data.deletes.length} deletion(s):</p>${renderPlanList(data.deletes)}
      <p>${data.creates.length} creation(s):</p>${renderPlanList(data.creates)}
    `;
    show('log', 'tree-subject');
  } else if (status === 'done') {
    document.getElementById('stop-btn').disabled = true;
    document.getElementById('done-heading').textContent = 'Done';
    if (currentJobKind === 'tree') {
      renderTreeDone(data);
    } else {
      renderDone(data);
    }
    show('log', 'done');
  } else if (status === 'stopped') {
    document.getElementById('stop-btn').disabled = true;
    document.getElementById('done-heading').textContent = 'Stopped';
    document.getElementById('done-failures').innerHTML = '<p>Run stopped before finishing.</p>';
    document.getElementById('done-outpath').innerHTML = '';
    show('log', 'done');
  } else if (status === 'error') {
    document.getElementById('stop-btn').disabled = true;
    document.getElementById('error-message').textContent = data.message || 'Unknown error';
    show('log', 'error');
  }
}

function renderDone(data) {
  const failuresEl = document.getElementById('done-failures');
  if (data.failures && data.failures.length) {
    failuresEl.innerHTML = `<p class="failure-list">${data.failures.length} section(s) failed:</p>
      <ul class="failure-list">${data.failures.map((f) => `<li>${f.gradeSection}: ${f.error}</li>`).join('')}</ul>`;
  } else {
    failuresEl.innerHTML = `<p>All sections analyzed successfully.</p>`;
  }

  const outEl = document.getElementById('done-outpath');
  let html = '';
  if (data.outPath) {
    html += `<p>Deck built: <code>${data.outPath}</code></p>
      <a class="btn-link" href="${downloadUrl(data.outPath)}">Download deck</a>
      <button id="open-deck-btn" class="secondary">Open deck</button>`;
  }
  if (data.filteredFiles && data.filteredFiles.length) {
    html += `<p>Filtered CSVs (<code>${data.filteredFolder}</code>):</p>${renderFileList(data.filteredFolder, data.filteredFiles)}`;
  }
  if (data.rawFiles && data.rawFiles.length) {
    html += `<p>Raw CSVs (<code>${data.rawFolder}</code>):</p>${renderFileList(data.rawFolder, data.rawFiles)}`;
  }
  outEl.innerHTML = html;
  if (data.outPath) {
    document.getElementById('open-deck-btn').onclick = () => reveal(data.outPath);
  }
}

function renderPlanList(labels) {
  if (!labels || !labels.length) return '<p>(none)</p>';
  return `<ul class="file-list">${labels.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`;
}

function renderTreeDone(data) {
  const failuresEl = document.getElementById('done-failures');
  const results = data.results || [];
  if (results.length) {
    failuresEl.innerHTML = `<ul class="file-list">${results.map((r) =>
      `<li>${escapeHtml(r.subject)}: ${escapeHtml(r.outcome)}</li>`).join('')}</ul>`;
  } else {
    failuresEl.innerHTML = '<p>No subjects were processed.</p>';
  }
  document.getElementById('done-outpath').innerHTML = '';
}

async function reveal(absPath) {
  await fetch('/api/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: absPath }),
  });
}

// ─── Chrome connection banner ───────────────────────────────────────────────

async function checkChromeStatus() {
  const dot = document.getElementById('chrome-dot');
  const text = document.getElementById('chrome-text');
  dot.className = 'dot';
  text.textContent = 'Checking Chrome connection…';
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.chromeDebugReady && data.reportbeeTabOpen) {
      dot.className = 'dot ok';
      text.textContent = 'Chrome is connected with reportbee open.';
    } else if (data.chromeDebugReady) {
      dot.className = 'dot bad';
      text.textContent = 'Chrome debug connection is up, but no reportbee.com tab is open — log in first.';
    } else {
      dot.className = 'dot bad';
      text.textContent = 'Chrome is not open in debug mode yet.';
    }
    document.getElementById('start-btn').disabled = !(data.chromeDebugReady && data.reportbeeTabOpen);
  } catch (e) {
    dot.className = 'dot bad';
    text.textContent = 'Could not check Chrome status.';
  }
}

document.getElementById('stop-btn').onclick = async () => {
  if (!currentJobId) return;
  document.getElementById('stop-btn').disabled = true;
  await fetch(`/api/jobs/${currentJobId}/stop`, { method: 'POST' });
};

document.getElementById('chrome-recheck').onclick = checkChromeStatus;

document.getElementById('chrome-open').onclick = async () => {
  const res = await fetch('/api/open-chrome', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) {
    appendLogHint(`Could not open Chrome: ${data.error}`);
    return;
  }
  if (data.alreadyRunning) {
    appendLogHint('The debug Chrome window is already open — switch to it and make sure you\'re logged into reportbee.com.');
  } else {
    appendLogHint('A separate Chrome window is opening — log into reportbee.com in it, then click "Check again". Your existing Chrome windows are untouched.');
  }
};

function appendLogHint(msg) {
  const text = document.getElementById('chrome-text');
  text.textContent = msg;
}

// ─── Form ───────────────────────────────────────────────────────────────────

function populateSelectWithOther(selectId, customId, options, selected) {
  const select = document.getElementById(selectId);
  const custom = document.getElementById(customId);
  select.innerHTML = options.map((o) => `<option value="${o}">${o}</option>`).join('')
    + '<option value="__other__">Other…</option>';
  if (selected && options.includes(selected)) {
    select.value = selected;
  } else if (selected) {
    select.value = '__other__';
    custom.value = selected;
    custom.classList.remove('hidden');
  }
  select.onchange = () => {
    custom.classList.toggle('hidden', select.value !== '__other__');
    if (select.value === '__other__') custom.focus();
  };
}

function selectedValue(selectId, customId) {
  const select = document.getElementById(selectId);
  if (select.value === '__other__') return document.getElementById(customId).value.trim();
  return select.value;
}

async function loadConfig() {
  const res = await fetch('/api/config');
  const config = await res.json();
  const gradeSelect = document.getElementById('grade');
  const grades = config.grades && config.grades.length ? config.grades : ['XII', 'XI', 'X', 'IX', 'VIII', 'VII', 'VI', 'V', 'IV'];
  gradeSelect.innerHTML = grades.map((g) => `<option value="${g}">${g}</option>`).join('');

  populateSelectWithOther('year', 'year-custom', config.yearOptions || [], config.year);
  populateSelectWithOther('term', 'term-custom', config.termOptions || [], (config.terms && config.terms[0]) || '');

  document.getElementById('tree-year').value = config.year || '';
  document.getElementById('tree-term').value = (config.terms && config.terms[0]) || '';

  document.getElementById('merge-grade').innerHTML = gradeSelect.innerHTML;
  document.getElementById('merge-year').value = config.year || '';
  document.getElementById('merge-term').value = (config.terms && config.terms[0]) || '';
}

// ─── Merge existing data (standalone, no active job needed) ────────────────

async function runStandaloneMerge(which) {
  const grade = document.getElementById('merge-grade').value;
  const year = document.getElementById('merge-year').value.trim();
  const term = document.getElementById('merge-term').value.trim();
  const errorEl = document.getElementById('merge-existing-error');
  errorEl.classList.add('hidden');

  if (!grade || !year || !term) {
    errorEl.textContent = 'Grade, Year, and Term are all required.';
    errorEl.classList.remove('hidden');
    return;
  }

  const res = await fetch('/api/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grade, year, term, which }),
  });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || 'Merge failed';
    errorEl.classList.remove('hidden');
    return;
  }
  const label = MERGE_LABELS[which] || which;
  document.getElementById('merge-existing-result').innerHTML += `<p>${label} merge: <a href="${downloadUrl(data.path)}">${data.path}</a></p>`;
}

document.getElementById('merge-existing-raw-btn').onclick = () => runStandaloneMerge('raw');
document.getElementById('merge-existing-filtered-btn').onclick = () => runStandaloneMerge('filtered');
document.getElementById('merge-existing-sel-btn').onclick = () => runStandaloneMerge('sel');

document.getElementById('build-existing-deck-btn').onclick = async () => {
  const grade = document.getElementById('merge-grade').value;
  const year = document.getElementById('merge-year').value.trim();
  const term = document.getElementById('merge-term').value.trim();
  const errorEl = document.getElementById('merge-existing-error');
  errorEl.classList.add('hidden');

  if (!grade || !year || !term) {
    errorEl.textContent = 'Grade, Year, and Term are all required.';
    errorEl.classList.remove('hidden');
    return;
  }

  const btn = document.getElementById('build-existing-deck-btn');
  btn.disabled = true;
  btn.textContent = 'Building deck…';
  try {
    const res = await fetch('/api/deck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grade, year, term }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Deck build failed';
      errorEl.classList.remove('hidden');
      return;
    }
    document.getElementById('merge-existing-result').innerHTML += `<p>Deck: <a href="${downloadUrl(data.path)}">${data.path}</a></p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Build deck';
  }
};

document.getElementById('start-btn').onclick = async () => {
  const grade = document.getElementById('grade').value;
  const year = selectedValue('year', 'year-custom');
  const term = selectedValue('term', 'term-custom');
  const section = document.getElementById('section-filter').value.trim();
  const subject = document.getElementById('subject-filter').value.trim();
  const errorEl = document.getElementById('form-error');
  errorEl.classList.add('hidden');

  if (!grade || !year || !term) {
    errorEl.textContent = 'Grade, Year, and Term are all required.';
    errorEl.classList.remove('hidden');
    return;
  }

  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grade, year, term, section, subject }),
  });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || 'Could not start run';
    errorEl.classList.remove('hidden');
    return;
  }
  currentJobKind = 'extract';
  connectToJob(data.jobId);
};

// ─── Build Tree ─────────────────────────────────────────────────────────────

document.getElementById('tree-start-btn').onclick = async () => {
  const gradeSection = document.getElementById('tree-gradesection').value.trim();
  const term = document.getElementById('tree-term').value.trim();
  const year = document.getElementById('tree-year').value.trim();
  const planType = document.getElementById('tree-plantype').value;
  const subjectFilter = document.getElementById('tree-subject-filter').value.trim();
  const fileInput = document.getElementById('tree-file');
  const errorEl = document.getElementById('tree-form-error');
  errorEl.classList.add('hidden');

  if (!gradeSection || !term || !year) {
    errorEl.textContent = 'Grade & Section, Term, and Year are all required.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (!fileInput.files.length) {
    errorEl.textContent = 'Choose a tree .xlsx file.';
    errorEl.classList.remove('hidden');
    return;
  }

  const formData = new FormData();
  formData.append('gradeSection', gradeSection);
  formData.append('term', term);
  formData.append('year', year);
  formData.append('planType', planType);
  formData.append('subjectFilter', subjectFilter);
  formData.append('treeFile', fileInput.files[0]);

  const res = await fetch('/api/tree/run', { method: 'POST', body: formData });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || 'Could not start tree apply';
    errorEl.classList.remove('hidden');
    return;
  }
  currentJobKind = 'tree';
  connectToJob(data.jobId);
};

document.getElementById('tree-apply-btn').onclick = async () => {
  show('log');
  await fetch(`/api/jobs/${currentJobId}/subject-decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'apply' }),
  });
};

document.getElementById('tree-skip-btn').onclick = async () => {
  show('log');
  await fetch(`/api/jobs/${currentJobId}/subject-decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'skip' }),
  });
};

// ─── Reference resolution ───────────────────────────────────────────────────

document.getElementById('ref-upload-btn').onclick = async () => {
  const fileInput = document.getElementById('ref-file');
  if (!fileInput.files.length) {
    alert('Choose an .xlsx file first.');
    return;
  }
  const formData = new FormData();
  formData.append('action', 'upload');
  formData.append('xlsxFile', fileInput.files[0]);
  show('log');
  await fetch(`/api/jobs/${currentJobId}/reference`, { method: 'POST', body: formData });
};

document.getElementById('ref-template-btn').onclick = async () => {
  show('log');
  await fetch(`/api/jobs/${currentJobId}/reference`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'template' }),
  });
};

document.getElementById('ref-skip-btn').onclick = async () => {
  show('log');
  await fetch(`/api/jobs/${currentJobId}/reference`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'skip' }),
  });
};

// ─── Deck decision ──────────────────────────────────────────────────────────

document.getElementById('deck-build-btn').onclick = async () => {
  show('log');
  await fetch(`/api/jobs/${currentJobId}/deck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'build' }),
  });
};

document.getElementById('deck-skip-btn').onclick = async () => {
  show('log');
  await fetch(`/api/jobs/${currentJobId}/deck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'skip' }),
  });
};

function runJobMerge(which) {
  return fetch(`/api/jobs/${currentJobId}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ which }),
  });
}
document.getElementById('merge-raw-btn').onclick = () => runJobMerge('raw');
document.getElementById('merge-filtered-btn').onclick = () => runJobMerge('filtered');
document.getElementById('merge-sel-btn').onclick = () => runJobMerge('sel');

document.getElementById('run-again-btn').onclick = () => {
  currentJobId = null;
  if (eventSource) eventSource.close();
  setTab(currentJobKind === 'tree' ? 'tree' : 'analysis');
};

document.getElementById('error-restart-btn').onclick = () => {
  currentJobId = null;
  if (eventSource) eventSource.close();
  setTab(currentJobKind === 'tree' ? 'tree' : 'analysis');
};

// ─── Init ───────────────────────────────────────────────────────────────────

(async function init() {
  await loadConfig();
  await checkChromeStatus();
  // Login happens in a separate Chrome window with no way for this page to
  // be notified when it's done — poll instead of requiring a manual
  // "Check again" click for the Start button to ever re-enable.
  setInterval(checkChromeStatus, 3000);

  const current = await (await fetch('/api/jobs/current')).json();
  if (current.jobId) {
    currentJobKind = current.kind || 'extract';
    setTab(currentJobKind === 'tree' ? 'tree' : 'analysis');
    connectToJob(current.jobId);
    handleStatus(current.status, current.data);
  } else {
    setTab('analysis');
  }
})();
