# nook-gsplat: the gsplat trainer for nook captures (gsplat/nook_gsplat.py) as one executable. CUDA only
# (x86_64-linux + NVIDIA); libcuda comes from the host driver, /run/opengl-driver/lib on NixOS.
# torch-bin and the CUDA libraries are unfree, so this imports its own nixpkgs instance that allows them: the flake's
# other packages and the host's nixpkgs config are unchanged. Passthru `.gsplat` and `.fused-ssim` are its CUDA
# Python packages.
# cudaCapabilities limits every CUDA build in that instance (gsplat, and torch-bin's source-built NCCL and NVSHMEM,
# which are not in the binary cache since they are unfree) to the target GPU: 7.5 is kakapo's RTX 2060.
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
        # torch-bin links NVSHMEM, which nixpkgs builds from source along with ~600 test and example programs that
        # take hours of ptxas; only the library is needed.
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
  gsplat = pkgs.python3Packages.callPackage ./gsplat.nix {
    cudaArchList = lib.concatStringsSep ";" cudaCapabilities;
  };
  # fused-ssim (github.com/rahul-goel/fused-ssim, no releases): the CUDA SSIM loss gsplat's simple_trainer uses.
  # A plain PyTorch SSIM costs 33 ms per 1920x1440 step on the RTX 2060, three times gsplat's rasterizer at 300k splats.
  fused-ssim = gsplat.overridePythonAttrs (old: {
    pname = "fused-ssim";
    version = "0-unstable-2026-02-02";
    src = pkgs.fetchFromGitHub {
      owner = "rahul-goel";
      repo = "fused-ssim";
      rev = "a7c48d6dd7ac6dc39a7958c7c4452e0b10418f38";
      hash = "sha256-CcuC7Mud1S3x7Oh7n99DY7atdHekzQRe5uDLstAJZIQ=";
    };
    build-system = old.build-system ++ [ pkgs.python3Packages.wheel ];
    dependencies = [ pkgs.python3Packages.torch-bin ];
    pythonRemoveDeps = [ ];
    env = old.env // {
      CUDA_ARCHITECTURES = lib.concatStringsSep ";" (map (lib.replaceStrings [ "." ] [ "" ]) cudaCapabilities);
    };
    pythonImportsCheck = [ "fused_ssim_cuda" ];
    meta = old.meta // {
      description = "Fully fused differentiable SSIM (CUDA)";
      homepage = "https://github.com/rahul-goel/fused-ssim";
      license = lib.licenses.mit;
    };
  });
  py = pkgs.python3.withPackages (ps: [
    gsplat
    fused-ssim
    ps.numpy
    ps.pillow
    ps.scipy
  ]);
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "nook-gsplat";
  version = "0.2.0"; # 0.2.0: --stills-max-size (contract §4.9.1)

  src = lib.fileset.toSource {
    root = ../gsplat;
    fileset = ../gsplat/nook_gsplat.py;
  };

  nativeBuildInputs = [ pkgs.makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    install -Dm644 nook_gsplat.py $out/share/nook-gsplat/nook_gsplat.py
    makeWrapper ${py}/bin/python3 $out/bin/nook-gsplat \
      --add-flags "-I $out/share/nook-gsplat/nook_gsplat.py" \
      --prefix LD_LIBRARY_PATH : ${pkgs.addDriverRunpath.driverLink}/lib
    runHook postInstall
  '';

  passthru = { inherit gsplat fused-ssim; };

  meta = {
    description = "Gaussian-splat trainer for nook captures (gsplat, MCMC densification)";
    mainProgram = "nook-gsplat";
    platforms = [ "x86_64-linux" ];
  };
}
