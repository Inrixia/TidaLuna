{
  description = "Injection for TIDAL";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = {
    self,
    nixpkgs,
  }: let
    forAllSystems = function:
      nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed (
        # unfree packages needed for "castlabs-electron"
        system:
          function (
            import nixpkgs {
              inherit system;
              config.allowUnfree = true;
            }
          )
      );
  in {
    packages = forAllSystems (pkgs: {
      # TidaLuna injection stand-alone (platform-dispatched)
      injection =
        if pkgs.stdenv.isDarwin
        then pkgs.callPackage ./nix/injection-darwin.nix {}
        else pkgs.callPackage ./nix/injection-linux.nix {};

      # Explicit per-platform injection targets (for nix-update)
      injection-darwin = pkgs.callPackage ./nix/injection-darwin.nix {};
      injection-linux = pkgs.callPackage ./nix/injection-linux.nix {};

      # macOS TIDAL app with Luna injected (for nix-update of DMG hash)
      darwin-package = pkgs.callPackage ./nix/darwin-package.nix {};

      # TidaLuna injected into tidal-hifi / TIDAL.app
      default =
        if pkgs.stdenv.isDarwin
        then pkgs.callPackage ./nix/darwin-package.nix {}
        else pkgs.callPackage ./nix/linux-package.nix {};
    });

    # Dev environment
    devShells = forAllSystems (pkgs: {
      default = pkgs.callPackage ./nix/shell.nix {};
    });

    # Home Manager module
    homeManagerModules.default = import ./nix/home-manager.nix {inherit self;};

    # Overlay (if preferred)
    overlays.default = final: prev: {tidal-hifi = final.callPackage ./nix/linux-package.nix {tidal-hifi = prev.tidal-hifi;};};
  };
}
