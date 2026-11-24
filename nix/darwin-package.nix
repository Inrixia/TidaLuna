{
  callPackage,
  tidal ? null,
}: let
  injection = callPackage ./injection-darwin.nix {};
  signApp = import ./darwin-sign.nix;
  app = "$out/Applications/TIDAL.app";
in
  if tidal == null then
    throw "The 'tidal' package is required for 'darwin-package.nix'. Please provide it via an overlay or by passing it as an argument. Note that the official TIDAL app is not in nixpkgs by default."
  else
    tidal.overrideAttrs (oldAttrs: {
      postInstall =
        (oldAttrs.postInstall or "")
        + ''
          if [ -f "${app}/Contents/Resources/app.asar" ]; then
            mv "${app}/Contents/Resources/app.asar" \
               "${app}/Contents/Resources/original.asar"
          fi

          mkdir -p "${app}/Contents/Resources/app/"
          cp -R ${injection}/. "${app}/Contents/Resources/app/"
        '';

      # Sign in postFixup: fixupPhase strips binaries, which would break the signature again
      postFixup =
        (oldAttrs.postFixup or "")
        + signApp app;
    })
