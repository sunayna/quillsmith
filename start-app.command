#!/bin/bash
# Double-click entry point: no terminal commands to type, no config file to
# edit. Starts the local web UI and opens it in the browser; leave this
# window open while you work, close it (or Ctrl-C) to stop the server.
#
# First time only: run `npm install` and `pip install -r requirements.txt`
# from a terminal once (see README.md) — this does not install dependencies
# for you the way wizard.sh does.

cd "$(dirname "$0")"
node src/server/index.js
