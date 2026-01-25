{
  mkShell,
  callPackage,
  rustPlatform,

  # extra tooling
  clippy,
  rustfmt,
  rust-analyzer,

  bun,
  mpv, # TODO? : just need library, load all?

  pkgconf,
  pkg-config,
}:
let
  defaultPackage = callPackage ./default.nix { };
in
mkShell {
  inputsFrom = [ defaultPackage ];

  env = {
    RUST_SRC_PATH = rustPlatform.rustLibSrc;
  };

  packages = [
    clippy
    rustfmt
    rust-analyzer

    mpv
    bun
    pkgconf
    pkg-config
  ];
}
