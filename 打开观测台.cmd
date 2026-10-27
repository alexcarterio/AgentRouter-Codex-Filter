@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or later is required. Install it and add node to PATH, then reopen this window.
  pause
  exit /b 1
)
chcp 65001 >nul
title Codex Filter - Dashboard
node -e "console.log('\u6253\u5f00\u7f51\u9875\u89c2\u6d4b\u53f0\uff1a\u5b9e\u65f6\u56fe\u8868\u3001\u9519\u8bef\u5206\u7c7b\u3001\u91cd\u8bd5\u6548\u679c\u4e0e\u6700\u8fd1\u8bf7\u6c42\u3002\u5730\u5740\u542b\u672c\u673a\u8bbf\u95ee\u4ee4\u724c\uff0c\u8bf7\u52ff\u5916\u4f20\u3002')"
node "%~dp0ccswitch-codex-filter\filter.cjs" ui %*
set "filterExit=%errorlevel%"
echo.
node -e "console.log('\u82e5\u6d4f\u89c8\u5668\u672a\u81ea\u52a8\u6253\u5f00\uff0c\u8bf7\u590d\u5236\u4e0a\u65b9\u5730\u5740\u624b\u52a8\u8bbf\u95ee\u3002\u5173\u95ed\u672c\u7a97\u53e3\u4e0d\u4f1a\u505c\u6b62\u8fc7\u6ee4\u670d\u52a1\u3002')"
pause
exit /b %filterExit%
