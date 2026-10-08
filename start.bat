@echo off
rem Serves the map on http://localhost:8765 so it can read the live Google Sheet.
rem (Opening index.html directly also works, but only shows the saved snapshot.)
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8765/
  python -m http.server 8765
) else (
  where npx >nul 2>nul || (echo Python or Node.js is required. & pause & exit /b 1)
  start "" http://localhost:8765/
  npx --yes http-server -p 8765 -c-1 .
)
