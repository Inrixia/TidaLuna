{
  stdenv,
  nodejs,

  pnpmConfigHook,
  fetchPnpmDeps,
  pnpm,
}:
let
  package = builtins.fromJSON (builtins.readFile ../package.json);
in
stdenv.mkDerivation (rec {
  name = "TidaLuna";
  pname = "${name}";

  version = package.version;
  src = ./..;

  nativeBuildInputs = [
    nodejs

    pnpm
    pnpmConfigHook
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit pname src version;
    fetcherVersion = 1;
    hash = "sha256-pHIY4Ie66ZVwEne/4RmY2QvsRWcnfsl2kv3CDXcqVrg=";
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
