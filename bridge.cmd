@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer, then reopen this window.
  pause
  exit /b 1
)
node "%~dp0scripts\bridge.mjs" %*
set "bridgeExitCode=%errorlevel%"
if "%~1"=="" pause
exit /b %bridgeExitCode%
