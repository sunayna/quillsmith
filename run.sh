#!/bin/bash
# One command: extract every configured section for a grade straight from
# reportbee via the API, then build that grade's Data Analysis deck.
#
# Usage: ./run.sh <Grade Roman, e.g. VII> [--skip-deck] [--section=A,B] [--subject=Math,Hindi]
# --section and --subject are optional, comma-separated filters -- omit
# either to run every section / every subject, same as before.
#
# Before running: Chrome must be open with --remote-debugging-port=9222 on a
# separate profile (see README.md), with a reportbee.com tab open and logged in.

set -e
cd "$(dirname "$0")"
node src/batch.js "$@"
