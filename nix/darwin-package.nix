{
  callPackage,
  tidal ? null,
}: let
  injection = callPackage ./injection-darwin.nix {};
in
  if tidal == null then
    throw "The 'tidal' package is required for 'darwin-package.nix'. Please provide it via an overlay or by passing it as an argument. Note that the official TIDAL app is not in nixpkgs by default."
  else
    tidal.overrideAttrs (oldAttrs: {
      postInstall =
        (oldAttrs.postInstall or "")
        + ''
          if [ -f "$out/Applications/TIDAL.app/Contents/Resources/app.asar" ]; then
            mv "$out/Applications/TIDAL.app/Contents/Resources/app.asar" \
               "$out/Applications/TIDAL.app/Contents/Resources/original.asar"
          fi

          mkdir -p "$out/Applications/TIDAL.app/Contents/Resources/app/"
          cp -R ${injection}/* "$out/Applications/TIDAL.app/Contents/Resources/app/"
        '';
    })
