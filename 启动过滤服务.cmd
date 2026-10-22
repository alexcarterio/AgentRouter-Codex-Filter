@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or later is required. Install it and add node to PATH, then reopen this window.
  pause
  exit /b 1
)
chcp 65001 >nul
title Codex Filter - Start
node -e "console.log('\u542f\u52a8\u8fc7\u6ee4\u670d\u52a1\uff1b\u5982\u679c\u5df2\u8fd0\u884c\uff0c\u5c06\u8fd4\u56de\u73b0\u6709\u72b6\u6001\u3002')"
node "%~dp0ccswitch-codex-filter\filter.cjs" start %*
set "filterExit=%errorlevel%"
echo.
node -e "console.log('running=true \u4ec5\u8868\u793a\u540e\u53f0\u8fd0\u884c\uff1bstate=filtering \u4e14 ccSwitchReachable=true \u624d\u8868\u793a\u914d\u7f6e\u5df2\u63a5\u5165\u5e76\u53ef\u8fde\u63a5 CC Switch\u3002\nwaiting-for-supported-provider \u6216 waiting-for-ccswitch \u8868\u793a\u5f85\u547d\uff1b\u8bf7\u5728 CC Switch \u6253\u5f00\u672c\u5730\u4ee3\u7406\u548c Codex \u63a5\u7ba1\u3002\n\u63a5\u5165\u540e\u91cd\u5f00 Codex\uff1b\u5173\u95ed\u672c\u7a97\u53e3\u4e0d\u4f1a\u505c\u6b62\u8fc7\u6ee4\u670d\u52a1\u3002\u5b9e\u65f6\u65e5\u5fd7\u8bf7\u6253\u5f00\u540c\u76ee\u5f55\u7684\u67e5\u770b\u5165\u53e3\u3002')"
pause
exit /b %filterExit%
