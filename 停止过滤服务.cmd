@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or later is required. Install it and add node to PATH, then reopen this window.
  pause
  exit /b 1
)
chcp 65001 >nul
title Codex Filter - Stop
node -e "console.log('\u505c\u6b62\u8fc7\u6ee4\u670d\u52a1\uff0c\u5e76\u6062\u590d\u672c\u5de5\u5177\u6539\u5199\u7684 CC Switch \u5730\u5740\u3002')"
node "%~dp0ccswitch-codex-filter\filter.cjs" stop %*
set "filterExit=%errorlevel%"
echo.
node -e "console.log('\u53ea\u6709\u8fd4\u56de running=false\u3001state=stopped \u624d\u8868\u793a\u5df2\u7ecf\u505c\u6b62\u3002\n\u505c\u6b62\u540e\u8bf7\u91cd\u5f00 Codex\uff1b\u6062\u590d\u8fdc\u7a0b\u76f4\u8fde\u8fd8\u9700\u5728 CC Switch \u5173\u95ed Codex \u63a5\u7ba1\u5e76\u6062\u590d\u539f\u914d\u7f6e\u3002')"
pause
exit /b %filterExit%
