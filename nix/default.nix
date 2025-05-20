{ withSystem, ... }: {
  flake.overlays.default = final: prev:
    withSystem prev.stdenv.hostPlatform.system (
      { config, ... }:
      let
        injection = prev.callPackage ./package.nix { nodejs = prev.nodejs; pnpm = prev.pnpm_9; };
      in
      {
        tidaLuna =  prev.tidal-hifi.overrideAttrs (old: {
          installPhase = ''
            runHook preInstall

            # Default installation from tidal-hifi
            mkdir -p "$out/bin"
            cp -R "opt" "$out"
            cp -R "usr/share" "$out/share"

            # Rename app.asar to original.asar
            mv $out/opt/tidal-hifi/resources/app.asar $out/opt/tidal-hifi/resources/original.asar

            # Move injection into app folder
            mkdir -p "$out/opt/tidal-hifi/resources/app/"
            cp -R ${injection}/* $out/opt/tidal-hifi/resources/app/


            runHook postInstall
          '';

          tidaLuna = final.tidal-hifi;
      });
    }
  );
}

