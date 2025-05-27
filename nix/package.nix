{ stdenv, nodejs, pnpm, fetchFromGitHub, ... }:
stdenv.mkDerivation rec {
  pname = "TidaLuna";
  version = "1.3.0-alpha";
  src = fetchFromGitHub {
    owner = "Inrixia";
    repo = "TidaLuna";
    rev = "${version}";
    hash = "sha256-niuAY7Hm4DZyHOD+pcAaIYqQZ2gzVbCWbcD2sc1ASVs=";
  };

  nativeBuildInputs = [
    nodejs
    pnpm.configHook
  ];

  pnpmDeps = pnpm.fetchDeps {
    inherit pname src version;
    hash = "sha256-2Nf7kzmiJT7P9jNCPI16VHTPREjKR1l2yoxdtNReCx0=";
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

}
