#!/bin/bash
# Guided, interactive alternative to ./run.sh — installs missing Node/Python
# dependencies itself, then prompts for Grade/Year/Term, extracts, filters,
# and (optionally) builds the deck, printing exactly where each output file
# lands along the way. Use this if you don't want to hand-edit
# config/batch.json or remember the extract -> filter -> deck sequence.
#
# Usage: ./wizard.sh
#
# Before running: Chrome must be open with --remote-debugging-port=9222 on a
# separate profile (see README.md), with a reportbee.com tab open and logged in.

set -e
cd "$(dirname "$0")"
node src/wizard.js
