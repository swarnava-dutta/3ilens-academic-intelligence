@echo off
setlocal EnableExtensions
title 3iLens - stop servers
rem ===========================================================================
rem  Stops the 3iLens backend (port 8000+) and frontend (port 3000+) that were
rem  started by start.bat or by hand from this folder, including their windows.
rem  Only processes that belong to this project folder are stopped: another
rem  program that happens to use port 8000 or 3000 is reported and left alone.
rem ===========================================================================
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

echo.
echo  Stopping 3iLens servers...
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\server-processes.ps1" -Root "%ROOT%" -Action Stop
set "RC=%errorlevel%"
echo.
if "%RC%"=="0" (echo  Done.) else (echo  Some processes could not be stopped - close their windows manually.)
echo.
if not "%THREEILENS_NO_PAUSE%"=="1" pause
exit /b %RC%
