# nook's runtime: the web app (planner/serve.py) and nook-scan (trainer + jobs server), stdlib Python plus numpy,
# pillow and jsonschema. Keeps the repo layout under share/nook so the code finds contract/ the way it does in git.
{
  lib,
  stdenvNoCC,
  python3,
  makeWrapper,
  nook-gsplat,
}:
let
  py = python3.withPackages (ps: [
    ps.numpy
    ps.pillow
    ps.jsonschema
  ]);
in
stdenvNoCC.mkDerivation {
  pname = "nook";
  version = "0.2.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../planner
      ../scan/src
      ../contract
    ];
  };

  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/nook $out/bin
    cp -r planner scan contract $out/share/nook/
    makeWrapper ${py}/bin/python3 $out/bin/nook-scan \
      --add-flags "-c 'from nook_scan.cli import main; main()'" \
      --set PYTHONPATH $out/share/nook/scan/src \
      --set NOOK_VERSION 0.2.0 \
      --set-default NOOK_GSPLAT_BIN ${lib.getExe nook-gsplat}
    makeWrapper ${py}/bin/python3 $out/bin/nook-web \
      --add-flags "$out/share/nook/planner/serve.py"
    runHook postInstall
  '';

  meta = {
    description = "Reading-room planner, iPhone scan trainer and jobs server";
    mainProgram = "nook-scan";
    platforms = lib.platforms.linux;
  };
}
