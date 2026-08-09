@echo off
REM Double-click entry point (Windows): stops the local web UI started by
REM start-app.bat. Finds whatever's listening on the app's port and kills
REM it. Safe to run even if nothing's running -- it just says so and does
REM nothing.
REM macOS/Linux peers: use stop-app.command instead.

cd /d "%~dp0"
if "%PORT%"=="" (set PORT=4173)
node scripts\portctl.js %PORT% stop

echo.
pause
