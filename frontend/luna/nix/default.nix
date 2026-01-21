{ withSystem, ... }: {
  flake.overlays.default = final: prev:
    withSystem prev.stdenv.hostPlatform.system (
      { config, ... }:
      let
        injection = prev.callPackage ./package.nix { nodejs = prev.nodejs; pnpm = prev.pnpm_9; };
      in
      {
        tidaLuna =  prev.tidal-hifi.overrideAttrs (old: {
          postInstall = ''
            # Rename app.asar to original.asar
            mv $out/share/tidal-hifi/resources/app.asar $out/share/tidal-hifi/resources/original.asar

            # Move injection into app folder
            mkdir -p "$out/share/tidal-hifi/resources/app/"
            cp -R ${injection}/* $out/share/tidal-hifi/resources/app/
          '';

          tidaLuna = final.tidal-hifi;
      });
    }
  );
}

