{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/release-24.11";
    systems.url = "github:nix-systems/default";
  };

  outputs = inputs@{ self, systems, flake-parts, nixpkgs, ... }: flake-parts.lib.mkFlake { inherit inputs; } {
    systems = import systems;

    imports = [ ./package.nix ];

    perSystem = { config, pkgs, system, ... }: {
      _module.args.pkgs = import inputs.nixpkgs {
        inherit system;
        overlays = [ self.overlays.default ];
      };

      packages.default = pkgs.tidaLuna;
    };
  };
}