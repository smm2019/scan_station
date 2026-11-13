@echo off
rem ============================================================
rem  Preview only: shows what would be restored, writes NOTHING
rem  (same as: node restore_container_types.js --check)
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
  echo [ERROR] node.exe not found in PATH, and no bundled runtime was found.
  echo         Ask the developer to run: node restore_container_types.js --check
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
echo   PREVIEW MODE - nothing will be written to the server.
echo.

"%NODE%" "%~dp0restore_container_types.js" --check
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo [DONE] Preview finished. Nothing was changed.
) else (
  echo [STOPPED] Exit code %RC%. Nothing was written.
)
echo.
pause
endlocal
exit /b %RC%
