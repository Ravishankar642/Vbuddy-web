@echo off
setlocal
title VBuddy bridge
cd /d "%~dp0"
echo Starting VBuddy. Leave this window open while you fly.
echo.
"%~dp0node\node.exe" "%~dp0app\vbuddy-bridge.mjs" --web "%~dp0web" %*
echo.
echo VBuddy has stopped. If this was not on purpose, the lines above say why.
pause
