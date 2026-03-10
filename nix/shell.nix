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
  defaultPackage =
    if pkgs.stdenv.isDarwin
    then callPackage ./darwin-package.nix {}
    else callPackage ./linux-package.nix {};

  injection =
    if pkgs.stdenv.isDarwin
    then callPackage ./injection-darwin.nix {}
    else callPackage ./injection-linux.nix {};
in
  mkShellNoCC {
    # load the overlay of tidal-hifi & the stand-alone injection
    inputsFrom = [
      defaultPackage
      injection
    ];

    # Get all required packages for this project
    packages = [
      nodejs
      pnpm

      prettierd
    ];
  }
