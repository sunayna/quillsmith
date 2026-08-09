#!/bin/bash
# Double-click entry point (macOS/Linux): stops the local web UI started by
# start-app.command. Finds whatever's listening on the app's port and
# kills it. Safe to run even if nothing's running — it just says so and
# does nothing.
# Windows peers: use stop-app.bat instead.

cd "$(dirname "$0")"
node scripts/portctl.js "${PORT:-4173}" stop

echo ""
read -p "Press Enter to close this window..."
