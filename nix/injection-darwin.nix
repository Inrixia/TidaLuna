{
  stdenv,
  nodejs,
  pnpmConfigHook,
  fetchPnpmDeps,
  pnpm,
}: let
  package = builtins.fromJSON (builtins.readFile ../package.json);
in
  stdenv.mkDerivation rec {
    pname = "TidaLuna";
    version = package.version;
    src = ./..;

    nativeBuildInputs = [
      nodejs
      pnpm
      pnpmConfigHook
    ];

    pnpmDeps = fetchPnpmDeps {
      inherit pname src version;
      fetcherVersion = 4;
      hash = "sha256-1YmocNoJsxrSO4Z+lRaSwiPfseJt3sp9QxTjQQPZP+Y=";
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
