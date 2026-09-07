@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo OCR-rex is not installed yet. Run install.bat first.
  pause
  exit /b 1
)

echo OCR-rex service starting on http://127.0.0.1:5000
echo Keep this window open while using document scanning in the dashboard.
echo.
.venv\Scripts\python.exe server.py
pause
