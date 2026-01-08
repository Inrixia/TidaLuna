#!/bin/bash

# TidaLuna Linux Installer
# This script installs TidaLuna into the TIDAL Linux application

set -e

echo "=========================================="
echo "      TidaLuna Linux Installer"
echo "=========================================="

# Detect TIDAL installation path
TIDAL_PATH=""
if [ -d "/opt/tidal-hifi" ]; then
    TIDAL_PATH="/opt/tidal-hifi"
elif [ -d "$HOME/.local/share/tidal-hifi" ]; then
    TIDAL_PATH="$HOME/.local/share/tidal-hifi"
elif [ -d "/usr/share/tidal-hifi" ]; then
    TIDAL_PATH="/usr/share/tidal-hifi"
else
    echo "Error: Could not find TIDAL installation."
    echo "Please specify the path manually:"
    read -p "TIDAL installation path: " TIDAL_PATH
    if [ ! -d "$TIDAL_PATH" ]; then
        echo "Error: Directory does not exist."
        exit 1
    fi
fi

echo "[+] Found TIDAL at: $TIDAL_PATH"

# Find app.asar
ASAR_PATH="$TIDAL_PATH/resources/app.asar"
if [ ! -f "$ASAR_PATH" ]; then
    echo "Error: app.asar not found at $ASAR_PATH"
    exit 1
fi

echo "[+] Step 1: Backing up original.asar..."
BACKUP_PATH="$TIDAL_PATH/resources/original.asar"
if [ ! -f "$BACKUP_PATH" ]; then
    echo "    Creating backup..."
    sudo cp "$ASAR_PATH" "$BACKUP_PATH"
else
    echo "    Backup already exists."
fi

echo "[+] Step 2: Installing Luna..."
echo "    Removing old installation..."
sudo rm -rf "$TIDAL_PATH/resources/app.asar.unpacked"
sudo rm -f "$ASAR_PATH"

echo "    Creating app directory..."
sudo mkdir -p "$TIDAL_PATH/resources/app"

echo "    Copying build files..."
sudo cp -r dist/* "$TIDAL_PATH/resources/app/"

echo "    Creating package.json..."
sudo tee "$TIDAL_PATH/resources/app/package.json" > /dev/null <<EOF
{
  "name": "tidal",
  "main": "injector.mjs",
  "type": "module"
}
EOF

echo "    Renaming to app.asar..."
sudo mv "$TIDAL_PATH/resources/app" "$TIDAL_PATH/resources/app.asar"

echo "=========================================="
echo "      Installation Complete!"
echo "=========================================="
echo "You can now open TIDAL."
echo ""
echo "To uninstall, run:"
echo "  sudo rm -rf $TIDAL_PATH/resources/app.asar"
echo "  sudo mv $BACKUP_PATH $ASAR_PATH"
