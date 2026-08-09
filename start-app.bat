@echo off
REM Double-click entry point (Windows): no terminal commands to type, no
REM config file to edit. Starts the local web UI and opens it in the
REM browser; leave this window open while you work, close it (or Ctrl-C)
REM to stop the server -- or double-click stop-app.bat from anywhere.
REM macOS/Linux peers: use start-app.command instead.
REM
REM First time only: run "npm install" and "pip install -r requirements.txt"
REM from a terminal once (see README.md) -- this does not install
REM dependencies for you the way wizard.js does.

cd /d "%~dp0"

REM An earlier run that was closed without stopping the server leaves the
REM old process holding the port -- the next launch would otherwise crash
REM immediately with EADDRINUSE.
if "%PORT%"=="" (set PORT=4173)
node scripts\portctl.js %PORT% clear

node src\server\index.js
