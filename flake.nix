{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    systems.url = "github:nix-systems/default";
    devenv.url = "github:cachix/devenv";
  };

  outputs = inputs@{ self, systems, flake-parts, nixpkgs, ... }: flake-parts.lib.mkFlake { inherit inputs; } {
    systems = import systems;

    imports = [
      ./nix
      inputs.devenv.flakeModule
    ];

    perSystem = { config, pkgs, system, ... }: {
      _module.args.pkgs = import inputs.nixpkgs {
        inherit system;
        config.allowUnfree = true;
        overlays = [ self.overlays.default ];
      };

      packages.injection =
       pkgs.callPackage ./nix/package.nix { inherit (pkgs) nodejs fetchFromGitHub; pnpm = pkgs.pnpm_9; };

      packages.default = pkgs.tidaLuna;
    };
  };
}