@echo off
setlocal EnableExtensions DisableDelayedExpansion
title 3iLens launcher
rem ===========================================================================
rem  3iLens Academic Intelligence - one-click launcher for Windows 10/11 (64-bit)
rem
rem  Double-click this file. No admin rights are needed. It will:
rem    1. make sure Python 3.11+ is installed - if not, install Python 3.13 for
rem       the current user (winget, else the official python.org installer)
rem    2. create backend\.venv (recreate it if broken) and install the Python
rem       packages when they are missing, incomplete or at a wrong version, or
rem       when backend\requirements.txt changed
rem    3. make sure Node.js 20.9+ with npm is available - if not, download a
rem       portable Node.js 24 LTS into .tools\node (SHA-256 verified)
rem    4. install the frontend packages (npm ci / npm install) when
rem       node_modules is missing or package.json / package-lock.json changed
rem    5. create .env from .env.example if it is missing
rem    6. seed the database (institution, batch, Genetics rubric)
rem    7. start the FastAPI backend   in a window titled "3iLens API :<port>"
rem    8. start the Next.js frontend  in a window titled "3iLens Web :<port>"
rem    9. wait for the app to respond and open it in your browser
rem  Steps 1-4 run in scripts\ensure-deps.ps1 and take only a few seconds when
rem  everything is already in place. The first run needs internet access.
rem  Only one start.bat runs per folder at a time (.start.lock); a second one
rem  started meanwhile says so and stops.
rem
rem  Stop everything: close the two server windows, or run stop.bat.
rem
rem  Automation switches (environment variables, set before running):
rem    THREEILENS_NO_BROWSER=1   do not open the browser
rem    THREEILENS_NO_PAUSE=1     never wait for a key press, also not on errors
rem
rem  Test switches - exercise the install paths without changing this PC:
rem    THREEILENS_FORCE_NODE_INSTALL=1
rem        Ignore the system Node.js and use the portable copy in .tools\node,
rem        downloading and verifying it first if it is not there yet. Only
rem        this folder is changed. Delete .tools\node to test the download again.
rem    THREEILENS_FORCE_PYTHON_MISSING=1 together with
rem    THREEILENS_DRY_RUN_PYTHON_INSTALL=1
rem        Act as if no Python were installed and print exactly what the Python
rem        install would run (winget command, download URL, SHA-256, installer
rem        command line), then stop: nothing is installed or started.
rem        Careful: THREEILENS_FORCE_PYTHON_MISSING=1 on its own really installs
rem        Python 3.13 for the current user.
rem  Example, in a cmd window opened in this folder:
rem    set "THREEILENS_FORCE_PYTHON_MISSING=1"
rem    set "THREEILENS_DRY_RUN_PYTHON_INSTALL=1"
rem    start.bat
rem ===========================================================================

cd /d "%~dp0"
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "BACKEND=%ROOT%\backend"
set "VENV_PY=%BACKEND%\.venv\Scripts\python.exe"
set "DEPS_PS1=%ROOT%\scripts\ensure-deps.ps1"
set "PROC_PS1=%ROOT%\scripts\server-processes.ps1"
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" set "PS_EXE=powershell.exe"

echo.
echo  =============================================================
echo    3iLens Academic Intelligence - starting the local demo
echo  =============================================================
echo.

rem npm's own command shims (node_modules\.bin\*.cmd) break on & and ^ in the
rem folder path, so refuse such a folder up front instead of failing later.
set "ROOT_CHECK=%ROOT:&=%"
set "ROOT_CHECK=%ROOT_CHECK:^=%"
if not "%ROOT_CHECK%"=="%ROOT%" goto :bad_path

rem ---------------------------------------------------------------------------
rem  Everything up to "servers are up" runs in :main while this window holds
rem  .start.lock open for writing. A second start.bat for this folder cannot
rem  open it, so it stops instead of racing this one (two npm installs in one
rem  folder, two backends on one port). The lock is released when :main
rem  returns, before the final pause. The server windows are opened through
rem  the Windows shell, so they do not inherit (and keep) the lock.
rem ---------------------------------------------------------------------------
set "MAIN_RAN="
set "RESULT=fail"
set "SERVERS_STARTED="
9>"%ROOT%\.start.lock" (call :main)
if not defined MAIN_RAN goto :already_running
if "%RESULT%"=="dryrun" goto :dry_run_end
if not "%RESULT%"=="ok" goto :fail_end

if not "%THREEILENS_NO_BROWSER%"=="1" start "" "http://localhost:%WEB_PORT%/"
echo.
echo  -------------------------------------------------------------
echo    3iLens is running
echo      App        http://localhost:%WEB_PORT%
echo      API        http://127.0.0.1:%API_PORT%   (docs: /docs)
echo.
echo    To stop: close the "3iLens API" and "3iLens Web" windows,
echo             or double-click stop.bat.
echo    You can close this launcher window now.
echo  -------------------------------------------------------------
echo.
if not "%THREEILENS_NO_PAUSE%"=="1" pause
exit /b 0

:fail_end
echo.
echo  -------------------------------------------------------------
echo    3iLens did NOT start completely.
echo    Fix the problem shown by the [error] / [warn] lines above and
echo    run start.bat again.
if defined SERVERS_STARTED echo    Server windows that did open: check them for error messages,
if defined SERVERS_STARTED echo    then close them or run stop.bat.
echo  -------------------------------------------------------------
echo.
if not "%THREEILENS_NO_PAUSE%"=="1" pause
exit /b 1

:dry_run_end
echo.
if not "%THREEILENS_NO_PAUSE%"=="1" pause
exit /b 3

:already_running
echo.
echo  [error] start.bat is already running for this folder in another window
echo          (or this folder is not writable, so .start.lock cannot be created).
echo          Wait for the other launcher window to finish - it opens the app
echo          when it is ready - or close it and run start.bat again.
echo.
if not "%THREEILENS_NO_PAUSE%"=="1" pause
exit /b 1

:bad_path
echo  [error] The folder path contains ^& or ^^, which npm and Node.js cannot handle:
echo          "%ROOT%"
echo          Move or rename the 3iLens folder to a path without ^& and ^^,
echo          for example C:\3ilens, and run start.bat there.
echo.
if not "%THREEILENS_NO_PAUSE%"=="1" pause
exit /b 1


rem ===========================================================================
rem  :main - runs while .start.lock is held. Sets RESULT=ok / fail / dryrun
rem  and returns; the final messages and the pause are above.
rem ===========================================================================
:main
set "MAIN_RAN=1"
set "RESULT=fail"
set "FAILED="
set "HAVE_CURL="
where curl.exe >nul 2>&1 && set "HAVE_CURL=1"
if not exist "%DEPS_PS1%" goto :no_helper

rem ---------------------------------------------------------------------------
rem  1. Python 3.11+, backend\.venv and the backend packages
rem     (exit code 3 = dry run of the Python install finished)
rem ---------------------------------------------------------------------------
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%DEPS_PS1%" -Action Backend
set "RC=%errorlevel%"
if "%RC%"=="3" goto :dry_run_done
if not "%RC%"=="0" goto :backend_failed
if not exist "%VENV_PY%" goto :backend_failed

rem ---------------------------------------------------------------------------
rem  2. Node.js 20.9+ with npm, and the frontend packages
rem     (exit code 0 = ready with the node/npm that come first on PATH,
rem      exit code 2 = ready, using the portable Node.js in .tools\node)
rem ---------------------------------------------------------------------------
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%DEPS_PS1%" -Action Frontend
set "RC=%errorlevel%"
if "%RC%"=="2" goto :use_portable_node
if not "%RC%"=="0" goto :frontend_failed
goto :deps_ready

:use_portable_node
rem The frontend window started below inherits this PATH.
set "PATH=%ROOT%\.tools\node;%PATH%"
:deps_ready

rem ---------------------------------------------------------------------------
rem  3. .env and API keys (values are never printed)
rem ---------------------------------------------------------------------------
if exist "%ROOT%\.env" goto :env_ready
if not exist "%ROOT%\.env.example" goto :no_env_example
copy /y "%ROOT%\.env.example" "%ROOT%\.env" >nul
echo  [warn]  .env was missing, so it was created from .env.example.
echo          Open .env and add your ANTHROPIC_API_KEY to enable live AI grading.

:env_ready
set "AKEY="
for /f "usebackq tokens=1,* delims==" %%A in (`findstr /B /C:"ANTHROPIC_API_KEY=" "%ROOT%\.env"`) do set "AKEY=%%B"
if defined AKEY set "AKEY=%AKEY:"=%"
if defined AKEY set "AKEY=%AKEY: =%"
rem "ANTHROPIC_API_KEY=   # paste your key here" is an empty key with a comment.
if defined AKEY if "%AKEY:~0,1%"=="#" set "AKEY="
if defined AKEY goto :key_ok
echo  [warn]  ANTHROPIC_API_KEY is empty in .env - live AI grading of uploaded sheets
echo          will be marked FAILED with a clear message until you add the key.
echo          Works without a key: the "blurry" human-review demo and "Load demo cohort".
goto :key_done
:key_ok
echo  [ok]    ANTHROPIC_API_KEY is set in .env.
:key_done
set "AKEY="

rem ---------------------------------------------------------------------------
rem  4. Database seed (idempotent: institution, batch, Biology - Genetics rubric)
rem ---------------------------------------------------------------------------
echo  [....]  Seeding the database...
"%VENV_PY%" "%BACKEND%\seed.py"
if errorlevel 1 echo  [warn]  Seeding failed - the backend retries it on startup. See the messages above.

rem ---------------------------------------------------------------------------
rem  5. Pick ports. A 3iLens server from this folder that is already running is
rem     reused; otherwise the first free port is taken. A port held by another
rem     program is skipped.
rem ---------------------------------------------------------------------------
call :pick_port backend 8000 8009
if defined PICK_ERROR goto :pick_failed
if not defined PICKED goto :no_api_port
set "API_PORT=%PICKED%"
set "START_API=%PICK_START%"

call :pick_port frontend 3000 3009
if defined PICK_ERROR goto :pick_failed
if not defined PICKED goto :no_web_port
set "WEB_PORT=%PICKED%"
set "START_WEB=%PICK_START%"

rem The browser calls the API directly; tell the frontend where it is.
set "NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:%API_PORT%"

rem ---------------------------------------------------------------------------
rem  6. Start both servers in their own windows
rem ---------------------------------------------------------------------------
if not defined START_API goto :api_started
echo  [....]  Starting the backend  (FastAPI)  on http://127.0.0.1:%API_PORT% ...
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PROC_PS1%" -Root "%ROOT%" -Action Start -Kind backend -Port %API_PORT%
if errorlevel 1 goto :start_failed
set "SERVERS_STARTED=1"
:api_started

if not defined START_WEB goto :web_started
echo  [....]  Starting the frontend (Next.js)  on http://localhost:%WEB_PORT% ...
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PROC_PS1%" -Root "%ROOT%" -Action Start -Kind frontend -Port %WEB_PORT%
if errorlevel 1 goto :start_failed
set "SERVERS_STARTED=1"
:web_started

rem ---------------------------------------------------------------------------
rem  7. Wait until both respond (the browser is opened after :main returns)
rem ---------------------------------------------------------------------------
echo  [....]  Waiting for the backend to answer...
set /a TRIES=0
:wait_api
call :http_ok "http://127.0.0.1:%API_PORT%/api/health"
if not errorlevel 1 goto :api_answers
set /a TRIES+=1
if %TRIES% geq 45 goto :api_timeout
call :sleep 2
goto :wait_api
:api_timeout
echo  [warn]  The backend did not answer within 90 seconds.
echo          Check the "3iLens API :%API_PORT%" window for errors.
set "FAILED=1"
goto :wait_web_start
:api_answers
rem Something answers - make sure it is the server we just started and not
rem another program that took the port meanwhile.
if not defined START_API goto :api_up
call :is_ours %API_PORT%
if not errorlevel 1 goto :api_up
echo  [warn]  Port %API_PORT% answers, but not from this 3iLens backend - another
echo          program took the port. Check the "3iLens API :%API_PORT%" window.
set "FAILED=1"
goto :wait_web_start
:api_up
echo  [ok]    Backend is up:  http://127.0.0.1:%API_PORT%/docs

:wait_web_start
echo  [....]  Waiting for the frontend - the first start compiles the app, about 10-60 s...
set /a TRIES=0
:wait_web
call :http_ok "http://localhost:%WEB_PORT%/"
if not errorlevel 1 goto :web_answers
set /a TRIES+=1
if %TRIES% geq 45 goto :web_timeout
call :sleep 2
goto :wait_web
:web_timeout
echo  [warn]  The frontend did not answer within 90 seconds.
echo          Check the "3iLens Web :%WEB_PORT%" window for errors.
set "FAILED=1"
goto :main_done
:web_answers
if not defined START_WEB goto :web_up
call :is_ours %WEB_PORT%
if not errorlevel 1 goto :web_up
echo  [warn]  Port %WEB_PORT% answers, but not from this 3iLens frontend - another
echo          program took the port. Check the "3iLens Web :%WEB_PORT%" window.
set "FAILED=1"
goto :main_done
:web_up
echo  [ok]    Frontend is up: http://localhost:%WEB_PORT%

:main_done
if not defined FAILED set "RESULT=ok"
exit /b 0


rem ---------------------------------------------------------------------------
rem  Errors inside :main (scripts\ensure-deps.ps1 prints the details and the
rem  manual steps). Each one returns from :main with RESULT=fail.
rem ---------------------------------------------------------------------------
:no_helper
echo.
echo  [error] scripts\ensure-deps.ps1 is missing.
echo          Copy the whole 3iLens folder, not only start.bat, and run it again.
exit /b 1

:backend_failed
echo.
echo  [error] The Python setup did not finish - see the messages above.
echo          No messages? Then Windows PowerShell could not run scripts\ensure-deps.ps1.
exit /b 1

:frontend_failed
echo.
echo  [error] The Node.js setup did not finish - see the messages above.
echo          No messages? Then Windows PowerShell could not run scripts\ensure-deps.ps1.
exit /b 1

:dry_run_done
echo.
echo  [stop]  Dry run finished: nothing was installed and no servers were started.
echo          Clear THREEILENS_DRY_RUN_PYTHON_INSTALL and THREEILENS_FORCE_PYTHON_MISSING
echo          to start normally.
set "RESULT=dryrun"
exit /b 3

:no_env_example
echo.
echo  [error] Neither .env nor .env.example exists in the 3iLens folder.
exit /b 1

:pick_failed
echo.
echo  [error] Could not check which ports are free (scripts\server-processes.ps1 failed).
exit /b 1

:no_api_port
echo.
echo  [error] Ports 8000-8009 are all in use. Free one of them and run start.bat again.
exit /b 1

:no_web_port
echo.
echo  [error] Ports 3000-3009 are all in use. Free one of them and run start.bat again.
exit /b 1

:start_failed
echo.
echo  [error] Could not open the server window - see the message above.
exit /b 1


rem ===========================================================================
rem  Subroutines
rem ===========================================================================
:pick_port
rem %1 = backend or frontend, %2-%3 = port range.
rem Sets PICKED (the port; empty = all busy), PICK_START (1 = start a new
rem server, empty = reuse the running one) and PICK_ERROR (the check failed).
rem server-processes.ps1 -Action Pick prints the [info] lines and exits with
rem the port, the port + 10000 to reuse it, or 0 when every port is busy.
set "PICKED="
set "PICK_START="
set "PICK_ERROR="
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PROC_PS1%" -Root "%ROOT%" -Action Pick -Kind %1 -From %2 -To %3
set "PICK_RC=%errorlevel%"
if "%PICK_RC%"=="0" goto :eof
if %PICK_RC% LSS %2 goto :pick_port_error
if %PICK_RC% GTR 10000 goto :pick_port_reuse
if %PICK_RC% GTR %3 goto :pick_port_error
set "PICKED=%PICK_RC%"
set "PICK_START=1"
goto :eof
:pick_port_reuse
set /a PICKED=PICK_RC-10000
goto :eof
:pick_port_error
set "PICK_ERROR=1"
goto :eof

:is_ours
rem errorlevel 0 = every program listening on port %1 is a 3iLens server from this folder.
rem Decided from the listening process, not from what the port answers: another app on
rem the port may proxy its requests to a 3iLens server.
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PROC_PS1%" -Root "%ROOT%" -Action IsOurs -Port %1 >nul 2>&1
goto :eof

:http_ok
rem errorlevel 0 = URL %1 answers with an HTTP status below 400
if not defined HAVE_CURL goto :http_ok_ps
curl.exe -s -f -o nul -m 30 %1 >nul 2>&1
goto :eof
:http_ok_ps
"%PS_EXE%" -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 '%~1' | Out-Null; exit 0 } catch { exit 1 }"
goto :eof

:sleep
rem works even when the console has no keyboard input (unlike timeout /t)
set /a SLEEP_N=%1+1
ping -n %SLEEP_N% 127.0.0.1 >nul
goto :eof
