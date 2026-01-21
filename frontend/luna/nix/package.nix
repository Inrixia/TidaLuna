{ stdenv, nodejs, pnpm, ... }:
stdenv.mkDerivation (finalAttrs: rec {
  name = "TidaLuna";
  pname = "${name}";
  version = "1.8.4-beta";
  src = ./..;

  nativeBuildInputs = [
    nodejs
    pnpm.configHook
  ];

  pnpmDeps = pnpm.fetchDeps {
    inherit (finalAttrs) pname src version;
    fetcherVersion = 1;
    hash = "sha256-4/00Vf+ZrmzJtXpoMlUuKMFTe8K0RACMcqyDLRp4zKs=";
  };

  buildPhase = ''
    runHook preBuild

    pnpm install
    pnpm run build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    cp -R "dist" "$out"

    runHook postInstall
  '';

})
