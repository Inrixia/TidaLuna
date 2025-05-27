{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    systems.url = "github:nix-systems/default";
  };

  outputs = inputs@{ self, systems, flake-parts, nixpkgs, ... }: flake-parts.lib.mkFlake { inherit inputs; } {
    systems = import systems;

    imports = [
      ./nix
    ];

    perSystem = { config, pkgs, system, ... }: {
      _module.args.pkgs = import inputs.nixpkgs {
        inherit system;
        overlays = [ self.overlays.default ];
      };

      packages.injection =
       pkgs.callPackage ./nix/package.nix { inherit (pkgs) nodejs fetchFromGitHub; pnpm = pkgs.pnpm_9; };

      packages.default = pkgs.tidaLuna;
    };
  };
}