#!/usr/bin/env node
/**
 * Cross-platform "find whatever's listening on this port and kill it" --
 * the one thing start-app/stop-app need on every OS, kept in one place
 * instead of reimplementing lsof/netstat/taskkill parsing in bash and
 * batch separately.
 *
 * Usage: node scripts/portctl.js <port> [clear|stop]
 *   clear (default) -- silent unless something was actually found; used by
 *                       start-app to free a stale port before launching.
 *   stop            -- narrates each step; used by stop-app.
 */
const { execSync } = require('child_process');

const port = process.argv[2];
const mode = process.argv[3] || 'clear';
if (!port) {
  console.error('usage: node scripts/portctl.js <port> [clear|stop]');
  process.exit(1);
}
const verbose = mode === 'stop';

function findPids() {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split('\n')) {
        const m = line.trim().match(/LISTENING\s+(\d+)\s*$/);
        if (m) pids.add(m[1]);
      }
      return [...pids];
    }
    const out = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    return []; // lsof/findstr exit non-zero when nothing matches -- not an error here
  }
}

function killPid(pid, force) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${pid}${force ? ' /F' : ''}`);
    else execSync(`kill ${force ? '-9 ' : ''}${pid}`);
  } catch (e) { /* already gone -- fine */ }
}

// Synchronous delay with no external dependency and no OS-specific "sleep"
// command -- gives a killed process a moment to actually exit before the
// force-kill pass checks whether it's still holding the port.
function sleepSync(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

let pids = findPids();
if (pids.length === 0) {
  if (verbose) console.log(`Nothing is running on port ${port} — already stopped.`);
  process.exit(0);
}

if (verbose) console.log(`Stopping process(es) on port ${port}: ${pids.join(', ')}`);
else console.log(`Port ${port} is already in use (from an earlier run that wasn't stopped) — clearing it first...`);

for (const pid of pids) killPid(pid, false);
sleepSync(1000);

// Force-kill anything that ignored the polite signal.
for (const pid of findPids()) killPid(pid, true);

if (verbose) console.log('Stopped.');
