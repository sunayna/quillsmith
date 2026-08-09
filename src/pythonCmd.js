// The one place that decides which Python executable name to spawn.
// macOS/Linux installs reliably provide `python3` (bare `python` is often
// missing or points at a stale Python 2). Windows' official installer does
// the opposite -- it provides `python`, not `python3` -- so hardcoding
// either name breaks the other platform. Every spawn/execFileSync call that
// runs one of this project's .py scripts should use this instead of a
// literal string.
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

module.exports = { PYTHON_CMD };
