@echo off
REM PanWatch (PanWatch) local launcher - keep ASCII only
cd /d "%~dp0"

REM Clear sandbox proxy so outbound data feeds work
set http_proxy=
set https_proxy=
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set all_proxy=
set NO_PROXY=localhost,127.0.0.1

echo ================================================
echo  PanWatch starting on http://127.0.0.1:8123
echo  (port 8123 is used to avoid DSA on 8000)
echo  Press Ctrl+C to stop.
echo ================================================
echo.

start "" http://127.0.0.1:8123
.venv\Scripts\python.exe -m uvicorn server:app --host 0.0.0.0 --port 8123
pause
