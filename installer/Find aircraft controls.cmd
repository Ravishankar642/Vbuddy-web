@echo off
setlocal
title VBuddy: find aircraft controls
cd /d "%~dp0"
echo Load the aircraft in MSFS first (sitting in the cockpit, sim not paused).
echo This watches the aircraft's controls while you operate them and saves a report file you can send for support.
echo.
set /p LABEL=Name for the report (for example ifly737max): 
"%~dp0node\node.exe" "%~dp0app\tools\aircraft-discover.mjs" --label "%LABEL%"
echo.
pause
