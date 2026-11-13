@echo off
rem ============================================================
rem  Restore container types (double-click to run)
rem  Actual logic + all Chinese prompts live in restore_container_types.js
rem  chcp 65001 so Node UTF-8 output shows correctly in the console
rem ============================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE="
where node >nul 2>nul && set "NODE=node"

if not defined NODE (
  if exist "%~dp0out\stage\runtime\node.exe" set "NODE=%~dp0out\stage\runtime\node.exe"
)
if not defined NODE (
  if exist "D:\work_app\scan_station\deploy\out\stage\runtime\node.exe" set "NODE=D:\work_app\scan_station\deploy\out\stage\runtime\node.exe"
)

if not defined NODE (
  echo [ERROR] node.exe not found in PATH, and no bundled runtime was found.
  echo         Ask the developer to run: node restore_container_types.js
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0restore_container_types.js" (
  echo [ERROR] restore_container_types.js is missing next to this .cmd
  echo.
  pause
  exit /b 1
)

echo.
echo ================================================================
echo   Container types restore tool  -  v173
echo   Adds back the 9 types lost on 2026-11-12 14:49.
echo   It only ADDS entries, never deletes. Nothing is sent anywhere
echo   except your own warehouse server.
echo ================================================================
echo.

"%NODE%" "%~dp0restore_container_types.js"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo [DONE] Finished successfully. You can close this window.
) else (
  if "%RC%"=="2" (
    echo [CHECK] Written, but read-back verification did not fully pass. Please review the list above.
  ) else (
    echo [STOPPED] Exit code %RC%. Nothing was written to the server, or it stopped before writing.
  )
)
echo.
pause
endlocal
exit /b %RC%
