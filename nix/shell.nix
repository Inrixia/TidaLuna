{
  mkShellNoCC,
  callPackage,
  # packages
  nodejs,
  pnpm,
  prettierd,
  pkgs,
  ...
}: let
  injection =
    if pkgs.stdenv.isDarwin
    then callPackage ./injection-darwin.nix {}
    else callPackage ./injection-linux.nix {};

  defaultPackage =
    if pkgs.stdenv.isDarwin
    then null
    else callPackage ./linux-package.nix {};
in
  mkShellNoCC {
    # load the overlay of tidal-hifi & the stand-alone injection
    inputsFrom = [
      injection
    ] ++ pkgs.lib.optional (defaultPackage != null) defaultPackage;

    # Get all required packages for this project
    packages = [
      nodejs
      pnpm

      prettierd
    ];
  }
