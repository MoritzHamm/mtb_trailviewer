@echo off
cd /d "%~dp0"

if exist env.bat call env.bat

where python >nul 2>nul
if %errorlevel%==0 (
    python serve.py 8080
) else (
    py serve.py 8080
)

pause
