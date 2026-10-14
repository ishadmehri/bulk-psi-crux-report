@echo off
rem Double-click launcher. Starts the local server and opens the UI in the
rem default browser; closing this window quits the app.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed, or not on PATH.
  echo Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "node_modules\exceljs" (
  echo First run - installing dependencies, this takes a minute...
  call npm install --omit=dev
  if errorlevel 1 ( pause & exit /b 1 )
)

node gui\server.js
pause
