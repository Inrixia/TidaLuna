#!/bin/bash
set -e

TIDAL_APP="/Applications/TIDAL.app"
RESOURCES="$TIDAL_APP/Contents/Resources"
DIST_DIR="./dist"

echo "=========================================="
echo "      TidaLuna MacOS Installer"
echo "=========================================="

if [ ! -d "$DIST_DIR" ]; then
    echo "ERROR: 'dist' directory not found. Please run './verify_fix.sh' or 'npm run build' first."
    exit 1
fi

if [ ! -d "$RESOURCES" ]; then
    echo "ERROR: TIDAL.app resources not found at $RESOURCES"
    exit 1
fi

if [ "$EUID" -ne 0 ]; then
    echo "ERROR: This script must be run as root to modify the Tidal application."
    echo "Please run with sudo:"
    echo "  sudo $0"
    exit 1
fi

echo "[+] Step 1: Handling original.asar..."
if [ ! -f "$RESOURCES/original.asar" ]; then
    if [ -f "$RESOURCES/app.asar" ]; then
        echo "    Backing up app.asar to original.asar..."
        mv "$RESOURCES/app.asar" "$RESOURCES/original.asar"
    else
        echo "ERROR: Neither app.asar nor original.asar found. Is Tidal installed correctly?"
        exit 1
    fi
else
    echo "    original.asar already exists."
fi

echo "[+] Step 2: Installing Luna..."
# Remove existing app folder if it exists
if [ -d "$RESOURCES/app" ]; then
    echo "    Removing old installation..."
    rm -rf "$RESOURCES/app"
fi

echo "    Creating app directory..."
mkdir -p "$RESOURCES/app"

echo "    Copying build files..."
cp -r "$DIST_DIR"/* "$RESOURCES/app/"

echo "    Creating package.json..."
echo '{ "name": "tidal", "main": "injector.mjs", "type": "module" }' > "$RESOURCES/app/package.json"

echo "[+] Step 3: Signing Application..."
codesign --force --deep --sign - "$TIDAL_APP"

echo "=========================================="
echo "      Installation Complete!"
echo "=========================================="
echo "You can now open TIDAL."
