{
  lib,
  stdenv,
  callPackage,
  fetchurl,
}: let
  injection = callPackage ./injection-darwin.nix {};
in
  stdenv.mkDerivation {
    pname = "tidaLuna-darwin";
    version = "1";

    src = fetchurl {
      url = "https://download.tidal.com/desktop/TIDAL.arm64.dmg";
      sha256 = "sha256-77Z5i4m2nQtfw7CAZqWNybYzpUZG+mEqltlK/llKQJ0=";
    };

    dontUnpack = true;

    allowedPlatforms = lib.platforms.darwin;

    installPhase = ''
      # Ensure the macOS tool hdiutil exists.
      if [ ! -x /usr/bin/hdiutil ]; then
        echo "/usr/bin/hdiutil not found or not executable; build this on macOS host."
        exit 1
      fi

      mkdir -p "$out/Applications"

      MOUNT_POINT=$(mktemp -d)
      /usr/bin/hdiutil attach "$src" -nobrowse -mountpoint "$MOUNT_POINT"

      if [ -d "$MOUNT_POINT/TIDAL.app" ]; then
        cp -R "$MOUNT_POINT/TIDAL.app" "$out/Applications/TIDAL.app"
      else
        APP_PATH=$(find "$MOUNT_POINT" -name "TIDAL.app" -maxdepth 2 -print -quit)
        if [ -n "$APP_PATH" ]; then
          cp -R "$APP_PATH" "$out/Applications/TIDAL.app"
        else
          echo "TIDAL.app not found in DMG"
        fi
      fi

      /usr/bin/hdiutil detach "$MOUNT_POINT"

      if [ -f "$out/Applications/TIDAL.app/Contents/Resources/app.asar" ]; then
        mv "$out/Applications/TIDAL.app/Contents/Resources/app.asar" \
           "$out/Applications/TIDAL.app/Contents/Resources/original.asar" || true
      fi

      mkdir -p "$out/Applications/TIDAL.app/Contents/Resources/app/"
      cp -R ${injection}/* "$out/Applications/TIDAL.app/Contents/Resources/app/"
    '';

    meta = with lib; {
      description = "TidaLuna macOS TIDAL DMG wrapper";
      platforms = [
        "x86_64-darwin"
        "aarch64-darwin"
      ];
    };
  }
