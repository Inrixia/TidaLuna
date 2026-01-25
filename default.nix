{
  lib,
  rustPlatform,

  # build inputs needed for building this package
  pkg-config,

  glib,
  webkitgtk_4_1,
  gdk-pixbuf,
  gtk3
}:
let
  toml = (lib.importTOML ./Cargo.toml).package;
in
# TODO: there is *yet* no build process, so this will always fail
rustPlatform.buildRustPackage {
  pname = "tidal-rs";
  inherit (toml) version;

  nativeBuildInputs = [
    pkg-config
  ];

  buildInputs = [
    glib
    gtk3
    webkitgtk_4_1
    gdk-pixbuf
  ];

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.intersection (lib.fileset.fromSource (lib.sources.cleanSource ./.)) (
      lib.fileset.unions [
        ./Cargo.toml
        ./Cargo.lock
        ./src
      ]
    );
  };

  cargoLock.lockFile = ./Cargo.lock;
}
