# nook-add: the furniture pipeline (pipeline/, contract §3) as one executable, on nixpkgs' python3 (3.13; the
# pipeline allows >=3.12,<3.14). planner/serve.py runs it for library jobs (§2.8) with --library <library-dir>.
# Keeps pipeline/pyproject.toml next to the source, so nook-add finds its root the way it does in git; it never
# writes there (the server always passes --library), and FAL_KEY comes from the environment (services.nook.falKeyFile).
{
  lib,
  stdenvNoCC,
  python3,
  makeWrapper,
}:
let
  fal-client = python3.pkgs.callPackage ./fal-client.nix { };
  py = python3.withPackages (ps: [
    ps.numpy
    ps.pillow
    ps.pillow-heif
    ps.trimesh
    fal-client
  ]);
in
stdenvNoCC.mkDerivation {
  pname = "nook-add";
  version = "0.2.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../pipeline/src
      ../pipeline/pyproject.toml
    ];
  };

  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/nook $out/bin
    cp -r pipeline $out/share/nook/
    makeWrapper ${py}/bin/python3 $out/bin/nook-add \
      --add-flags "-c 'from nook_pipeline.cli import main; main()'" \
      --set PYTHONPATH $out/share/nook/pipeline/src
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    $out/bin/nook-add --help >/dev/null
  '';

  passthru = { inherit fal-client; };

  meta = {
    description = "nook-add: a furniture photo or model to a normalized nook library item";
    mainProgram = "nook-add";
    platforms = lib.platforms.linux;
  };
}
