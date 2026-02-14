{
  lib,
  stdenv,
  callPackage,
  fetchurl,
  tidal-hifi ? null,
}: let
  injection = callPackage ./injection.nix {};

  # Only fetch the DMG for darwin builds
  tidalDmg =
    if stdenv.isDarwin
    then
      fetchurl {
        url = "https://download.tidal.com/desktop/TIDAL.arm64.dmg";
        sha256 = "sha256-w5tQscUkhxpWOToAP4oIJJstCNFIdosebTyDI1zFIAE=";
      }
    else null;
in
  if stdenv.isDarwin
  then
    import ./darwin-tidal.nix {
      prev = {inherit lib stdenv;};
      inherit injection tidalDmg;
    }
  else
    tidal-hifi.overrideAttrs rec {
      postInstall = ''
        mv $out/share/tidal-hifi/resources/app.asar $out/share/tidal-hifi/resources/original.asar

        mkdir -p "$out/share/tidal-hifi/resources/app/"
        cp -R ${injection}/* $out/share/tidal-hifi/resources/app/
      '';
    }
