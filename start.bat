@echo off
REM start.bat - Double-click launcher for AI Interviewer
REM Auto-cd to the script's own directory so cwd is correct when launched from Explorer.

chcp 65001 >nul
cd /d "%~dp0"

setlocal EnableDelayedExpansion

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Node.js is not installed. Please install Node.js 22+ from:
    echo         https://nodejs.org/
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node --version') do set NODE_VER=%%v
echo.
echo   AI Interviewer - Starting...  (Node !NODE_VER!)
echo   Project: %CD%
echo.

node scripts\launch.mjs %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo [launch] Exited with code %ERRORLEVEL%
    pause
)

endlocal
