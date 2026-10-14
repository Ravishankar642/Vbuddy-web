@echo off
set "F=%APPDATA%\VBuddy\config.env"
if exist "%F%" (
  start "" notepad "%F%"
) else (
  echo The settings file is created the first time VBuddy starts.
  echo Start VBuddy once, close it, then run this again.
  pause
)
