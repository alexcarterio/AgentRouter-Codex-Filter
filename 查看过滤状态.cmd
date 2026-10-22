@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or later is required. Install it and add node to PATH, then reopen this window.
  pause
  exit /b 1
)
chcp 65001 >nul
title Codex Filter - Live Requests
node "%~dp0ccswitch-codex-filter\filter.cjs" logs %*
set "filterExit=%errorlevel%"
echo.
pause
exit /b %filterExit%
