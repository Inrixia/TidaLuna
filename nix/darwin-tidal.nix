{
  prev ? { },
  injection,
  tidalDmg,
}:
let
  inherit (prev) lib stdenv;
in
stdenv.mkDerivation {
  pname = "tidaLuna-darwin";
  version = "1";

  buildPhase = ''
    true
  '';

  # Use a no-op unpackPhase so the build doesn't try to unpack anything.
  unpackPhase = ": ";

  allowedPlatforms = lib.platforms.darwin;

  installPhase = ''
    # Ensure the macOS tool `hdiutil` exists at `/usr/bin/hdiutil`. Nix builder
    # environments can have a restricted PATH, so check the absolute path and
    # fail with a clear message if it's not available.
    if [ ! -x /usr/bin/hdiutil ]; then
      echo "/usr/bin/hdiutil not found or not executable; build this on macOS host."
      exit 1
    fi

    mkdir -p "$out/Applications"

    MOUNT_POINT=$(mktemp -d)
    /usr/bin/hdiutil attach '${tidalDmg}' -nobrowse -mountpoint "$MOUNT_POINT"

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
      mv "$out/Applications/TIDAL.app/Contents/Resources/app.asar" "$out/Applications/TIDAL.app/Contents/Resources/original.asar" || true
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
