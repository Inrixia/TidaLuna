{
  callPackage,
  tidal-hifi,
}: let
  injection = callPackage ./injection-linux.nix {};
in
  tidal-hifi.overrideAttrs {
    postInstall = ''
      mv $out/share/tidal-hifi/resources/app.asar $out/share/tidal-hifi/resources/original.asar

      mkdir -p "$out/share/tidal-hifi/resources/app/"
      cp -R ${injection}/* $out/share/tidal-hifi/resources/app/
    '';
  }
