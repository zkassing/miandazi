@echo off
chcp 65001 >nul
node tty-test.mjs
echo.
echo ----
echo stdout: tty-test.mjs finished with errorlevel=%ERRORLEVEL%
pause
