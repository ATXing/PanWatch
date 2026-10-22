@echo off
rem Sync holdings from Obsidian ledger into PanWatch.
rem Usage: drag args here or edit this file to add options.
rem   --dry-run  preview only
rem   --prune    also delete positions removed from the ledger

cd /d "%~dp0"
"C:\Users\CXH\.workbuddy\binaries\python\versions\3.13.12\python.exe" sync_holdings.py %*
echo.
if errorlevel 1 (
  echo [FAILED] see message above.
) else (
  echo [OK] done.
)
pause
