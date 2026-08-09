@echo off
REM One command: extract every configured section for a grade straight from
REM reportbee via the API, then build that grade's Data Analysis deck.
REM macOS/Linux peers: use ./run.sh instead.
REM
REM Usage: run.bat <Grade Roman, e.g. VII> [--skip-deck] [--section=A,B] [--subject=Math,Hindi]
REM --section and --subject are optional, comma-separated filters -- omit
REM either to run every section / every subject, same as before.
REM
REM Before running: Chrome must be open with --remote-debugging-port=9222 on
REM a separate profile (see README.md), with a reportbee.com tab open and
REM logged in.

cd /d "%~dp0"
node src\batch.js %*
pause
