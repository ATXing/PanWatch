@echo off
REM PanWatch background launcher (autostart) - keep ASCII only
cd /d "%~dp0"
set http_proxy=
set https_proxy=
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set all_proxy=
set NO_PROXY=localhost,127.0.0.1
REM GTK3 runtime for WeasyPrint PDF export (pango/cairo/gobject DLLs)
set "PATH=%~dp0.gtk3\bin;%PATH%"

if not exist "%~dp0logs" mkdir "%~dp0logs"
REM --- skip if already listening on 8123 ---
netstat -ano | findstr ":8123" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [%date% %time%] PanWatch already running on 8123, skip.>> "%~dp0logs\autostart.log"
    exit /b 0
)
echo. >> "%~dp0logs\autostart.log"
echo [%date% %time%] PanWatch boot start>> "%~dp0logs\autostart.log"
".venv\Scripts\python.exe" -m uvicorn server:app --host 127.0.0.1 --port 8123 >> "%~dp0logs\autostart.log" 2>&1
echo [%date% %time%] PanWatch exited with code %errorlevel%>> "%~dp0logs\autostart.log"
