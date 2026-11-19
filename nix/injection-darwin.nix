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
      hash = "sha256-nsV0AbT3WWHFBs0bm45Esply5Pemxb71aP/LXnQDrmM=";
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
