{
  callPackage,
  tidal-hifi ? null,
}: let
  injection = callPackage ./injection-linux.nix {};
in
  if tidal-hifi == null then
    throw "The 'tidal-hifi' package is required for 'linux-package.nix'. Please ensure it is available in nixpkgs or provide it via an overlay."
  else
    tidal-hifi.overrideAttrs {
      postInstall = ''
        mv $out/share/tidal-hifi/resources/app.asar $out/share/tidal-hifi/resources/original.asar

        mkdir -p "$out/share/tidal-hifi/resources/app/"
        cp -R ${injection}/* $out/share/tidal-hifi/resources/app/
      '';
    }
