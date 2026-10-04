@echo off
setlocal
cd /d "%~dp0"

set "PY_CMD=py -3.13"
%PY_CMD% --version >nul 2>&1
if errorlevel 1 set "PY_CMD=python"

%PY_CMD% -c "import sys; sys.exit(0 if sys.version_info >= (3, 13) else 1)" >nul 2>&1
if errorlevel 1 (
  echo Python 3.13 or later is required.
  echo Install it from https://www.python.org/downloads/ and select "Add python.exe to PATH".
  echo Then run this file again.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating the app's private Python environment...
  %PY_CMD% -m venv .venv
  if errorlevel 1 goto failed
)

echo Installing Cosmo-Tracker dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto failed

echo.
echo Cosmo-Tracker is starting. Open http://127.0.0.1:8080 in your browser.
echo Keep this window open while you use the app.
".venv\Scripts\python.exe" -m uvicorn main:app --host 127.0.0.1 --port 8080
pause
exit /b 0

:failed
echo.
echo Setup did not finish. Check your internet connection and try again.
pause
exit /b 1