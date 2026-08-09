@echo off
REM Guided, interactive alternative to run.bat (Windows) -- installs missing
REM Node/Python dependencies itself, then prompts for Grade/Year/Term,
REM extracts, filters, and (optionally) builds the deck, printing exactly
REM where each output file lands along the way. Use this if you don't want
REM to hand-edit config\batch.json or remember the extract -> filter -> deck
REM sequence. macOS/Linux peers: use ./wizard.sh instead.
REM
REM Usage: wizard.bat
REM
REM Before running: Chrome must be open with --remote-debugging-port=9222 on
REM a separate profile (see README.md), with a reportbee.com tab open and
REM logged in.

cd /d "%~dp0"
node src\wizard.js
pause
