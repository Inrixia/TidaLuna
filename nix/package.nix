{ stdenv, nodejs, pnpm, fetchFromGitHub, ... }:
stdenv.mkDerivation (finalAttrs: rec {
  name = "TidaLuna";
  pname = "${name}";
  version = "1.1.0-alpha";
  src = fetchFromGitHub {
    owner = "Inrixia";
    repo = "${name}";
    rev = "${version}";
    hash = "sha256-T6J6mI3oxQ7tD8b76M15ajka1S8G9QW8Am3rqj0MaTo=";
  };

  nativeBuildInputs = [
    nodejs
    pnpm.configHook
  ];

  pnpmDeps = pnpm.fetchDeps {
    inherit (finalAttrs) pname src version;
    hash = "sha256-pnuDLjUAOxQUFlf+2FXeX2mpZcahzzVPMRpWZpbyDE4=";
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
