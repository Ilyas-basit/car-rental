@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 (
  echo Python launcher not found. Install Python 3.10 or 3.11, then run this file again.
  pause
  exit /b 1
)

py -3.11 -m venv .venv 2>nul
if errorlevel 1 py -3.10 -m venv .venv
if errorlevel 1 (
  echo Python 3.10 or 3.11 is required for the OCR-rex dependencies.
  pause
  exit /b 1
)

call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo Installation failed. Review the messages above.
  pause
  exit /b 1
)

echo.
echo OCR-rex is installed. You can now run start.bat.
pause
