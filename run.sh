#!/bin/bash
# One command: extract every configured section for a grade straight from
# reportbee via the API, then build that grade's Data Analysis deck.
#
# Usage: ./run.sh <Grade Roman, e.g. VII> [--skip-deck]
#
# Before running: Chrome must be open with --remote-debugging-port=9222 on a
# separate profile (see README.md), with a reportbee.com tab open and logged in.

set -e
cd "$(dirname "$0")"
node src/batch.js "$@"
