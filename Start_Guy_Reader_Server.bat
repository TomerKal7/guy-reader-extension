@echo off
cd /d "%~dp0"
set "DISABLE_ROBOSHAUL=1"
if exist "%~dp0.venv\Scripts\pythonw.exe" (
    start "" "%~dp0.venv\Scripts\pythonw.exe" "%~dp0speech_engine.py"
) else (
    start "" pythonw "%~dp0speech_engine.py"
)
echo [OK] Guy Reader background server started on port 5050.
