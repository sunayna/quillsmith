#!/bin/bash
# Double-click entry point: no terminal commands to type, no config file to
# edit. Starts the local web UI and opens it in the browser; leave this
# window open while you work, close it (or Ctrl-C) to stop the server —
# or double-click stop-app.command from anywhere.
#
# First time only: run `npm install` and `pip install -r requirements.txt`
# from a terminal once (see README.md) — this does not install dependencies
# for you the way wizard.sh does.

cd "$(dirname "$0")"

# An earlier run that was closed without stopping the server (window
# closed, terminal quit, etc.) leaves the old process holding the port —
# the next launch would otherwise crash immediately with EADDRINUSE.
PORT="${PORT:-4173}"
STALE=$(lsof -ti tcp:"$PORT")
if [ -n "$STALE" ]; then
  echo "Port $PORT is already in use (from an earlier run that wasn't stopped) — clearing it first..."
  kill $STALE
  sleep 1
fi

node src/server/index.js
