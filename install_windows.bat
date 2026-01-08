@echo off
REM TidaLuna Windows Installer
REM This script installs TidaLuna into the TIDAL Windows application

echo ==========================================
echo       TidaLuna Windows Installer
echo ==========================================

REM Detect TIDAL installation path
set "TIDAL_PATH=%LOCALAPPDATA%\TIDAL"
if not exist "%TIDAL_PATH%" (
    set "TIDAL_PATH=%PROGRAMFILES%\TIDAL"
)
if not exist "%TIDAL_PATH%" (
    echo Error: Could not find TIDAL installation.
    echo Please install TIDAL from the Microsoft Store or tidal.com
    pause
    exit /b 1
)

echo [+] Found TIDAL at: %TIDAL_PATH%

REM Find app.asar
set "ASAR_PATH=%TIDAL_PATH%\resources\app.asar"
if not exist "%ASAR_PATH%" (
    echo Error: app.asar not found at %ASAR_PATH%
    pause
    exit /b 1
)

echo [+] Step 1: Backing up original.asar...
set "BACKUP_PATH=%TIDAL_PATH%\resources\original.asar"
if not exist "%BACKUP_PATH%" (
    echo     Creating backup...
    copy "%ASAR_PATH%" "%BACKUP_PATH%"
) else (
    echo     Backup already exists.
)

echo [+] Step 2: Installing Luna...
if not exist "dist" (
    echo ERROR: 'dist' folder not found. Run 'npm run build' first.
    exit /b 1
)
echo     Removing old installation...
if exist "%TIDAL_PATH%\resources\app.asar.unpacked" (
    rmdir /s /q "%TIDAL_PATH%\resources\app.asar.unpacked"
)
if exist "%ASAR_PATH%" (
    del /f "%ASAR_PATH%"
)

echo     Creating app directory...
mkdir "%TIDAL_PATH%\resources\app"

echo     Copying build files...
xcopy /s /e /y dist\* "%TIDAL_PATH%\resources\app\"

echo     Creating package.json...
(
echo {
echo   "name": "tidal",
echo   "main": "injector.mjs",
echo   "type": "module"
echo }
) > "%TIDAL_PATH%\resources\app\package.json"

echo     Renaming to app.asar...
move "%TIDAL_PATH%\resources\app" "%TIDAL_PATH%\resources\app.asar"

echo ==========================================
echo       Installation Complete!
echo ==========================================
echo You can now open TIDAL.
echo.
echo To uninstall, run:
echo   del /f "%TIDAL_PATH%\resources\app.asar"
echo   move "%BACKUP_PATH%" "%ASAR_PATH%"
pause
