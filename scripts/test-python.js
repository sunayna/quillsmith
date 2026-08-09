#!/usr/bin/env node
// Thin cross-platform wrapper so `npm run test:python` doesn't have to
// hardcode a Python executable name that only exists on some platforms.
const { spawnSync } = require('child_process');
const { PYTHON_CMD } = require('../src/pythonCmd');

const result = spawnSync(PYTHON_CMD, ['-m', 'pytest'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
