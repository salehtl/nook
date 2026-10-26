# nook-poses: learned camera-pose refinement for nook captures (poses/nook_poses.py, contract §4.11) as one
# executable. VGGT-1B (github.com/facebookresearch/vggt) on CUDA; x86_64-linux + NVIDIA only, libcuda from the host
# driver (/run/opengl-driver/lib on NixOS).
# Same nixpkgs instance as nix/nook-gsplat.nix (allowUnfree, cudaCapabilities, the NVSHMEM override), so torch-bin is
# the very same store path the trainer already uses: nothing CUDA gets built twice.
# Only the VGGT source is packaged (aggregator and camera head need just torch); the 5 GB weights are downloaded on
# first run into NOOK_POSES_CACHE (default ~/.cache/nook-poses; the service sets /var/lib/nook/cache).
{
  nixpkgs,
  system,
  cudaCapabilities ? [ "7.5" ],
}:
let
  pkgs = import nixpkgs {
    inherit system;
    config = {
      allowUnfree = true;
      inherit cudaCapabilities;
    };
    overlays = [
      (final: prev: {
        # Keep in step with nix/nook-gsplat.nix: torch-bin links NVSHMEM, built from source without its tests here.
        cudaPackages = prev.cudaPackages.overrideScope (
          cfinal: cprev: {
            libnvshmem = cprev.libnvshmem.overrideAttrs (old: {
              cmakeFlags = map (
                builtins.replaceStrings
                  [ "NVSHMEM_BUILD_TESTS:BOOL=TRUE" "NVSHMEM_BUILD_EXAMPLES:BOOL=TRUE" ]
                  [ "NVSHMEM_BUILD_TESTS:BOOL=FALSE" "NVSHMEM_BUILD_EXAMPLES:BOOL=FALSE" ]
              ) old.cmakeFlags;
            });
          }
        );
      })
    ];
  };
  inherit (pkgs) lib;
  vggt = pkgs.fetchFromGitHub {
    owner = "facebookresearch";
    repo = "vggt";
    rev = "a288dd0f14786c93483e45524328726ab7b1b4ce";
    hash = "sha256-BXiPhNyhFpKZBogWrh+/uK+wTRSqCnCD2kHyIJAWlFE=";
  };
  py = pkgs.python3.withPackages (ps: [
    ps.torch-bin
    ps.numpy
    ps.pillow
  ]);
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "nook-poses";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../poses;
    fileset = ../poses/nook_poses.py;
  };

  nativeBuildInputs = [ pkgs.makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    install -Dm644 nook_poses.py $out/share/nook-poses/nook_poses.py
    makeWrapper ${py}/bin/python3 $out/bin/nook-poses \
      --add-flags "-I $out/share/nook-poses/nook_poses.py" \
      --set NOOK_POSES_VGGT ${vggt} \
      --set-default PYTORCH_CUDA_ALLOC_CONF expandable_segments:True \
      --prefix LD_LIBRARY_PATH : ${pkgs.addDriverRunpath.driverLink}/lib
    runHook postInstall
  '';

  passthru = { inherit vggt; };

  meta = {
    description = "Camera-pose refinement for nook captures with VGGT, anchored to ARKit";
    mainProgram = "nook-poses";
    platforms = [ "x86_64-linux" ];
  };
}
