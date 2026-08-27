@echo off
rem Double-click this file to play Blade & Sigil on Windows.
rem Needs Python 3 (free from https://python.org - during install,
rem check the box that says "Add Python to PATH").
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 tools\serve.py
  goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
  python tools\serve.py
  goto :eof
)
echo.
echo Python 3 is needed to run the game and was not found.
echo Install it free from https://python.org - and during install,
echo CHECK THE BOX that says "Add Python to PATH". Then double-click me again.
echo.
pause
