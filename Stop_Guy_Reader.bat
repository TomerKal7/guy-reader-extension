@echo off
title Stop Guy Reader
echo Stopping Guy Reader background speech engine...
powershell -NoProfile -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:5050/shutdown' -Method POST -TimeoutSec 2 | Out-Null } catch {}"
echo Done! Guy Reader background service has been stopped.
ping 127.0.0.1 -n 2 >nul
exit /b 0
