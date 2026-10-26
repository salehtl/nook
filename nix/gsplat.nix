# gsplat (github.com/nerfstudio-project/gsplat), the CUDA Gaussian-splat rasterizer behind nook-gsplat. Built from
# source against torch-bin (PyTorch's CUDA 12.8 wheels) with nvcc from cudaPackages (12.9; a minor-version mismatch
# torch accepts). Only one GPU architecture is compiled (kakapo's RTX 2060 is sm_75), which keeps the build short.
{
  lib,
  buildPythonPackage,
  fetchFromGitHub,
  cudaPackages,
  autoAddDriverRunpath,
  which,
  setuptools,
  ninja,
  torch-bin,
  numpy,
  jaxtyping,
  rich,
  packaging,
  cudaArchList ? "7.5",
}:
buildPythonPackage.override { stdenv = cudaPackages.backendStdenv; } rec {
  pname = "gsplat";
  version = "1.5.3";
  pyproject = true;

  src = fetchFromGitHub {
    owner = "nerfstudio-project";
    repo = "gsplat";
    tag = "v${version}";
    fetchSubmodules = true; # glm, under gsplat/cuda/csrc/third_party
    hash = "sha256-kZjhrqEJvgMBulsaURnAcoTPnTCSic7poRLoAUJXccg=";
  };

  build-system = [
    setuptools
    ninja
    torch-bin
  ];

  nativeBuildInputs = [
    cudaPackages.cuda_nvcc
    autoAddDriverRunpath
    which
  ];

  # Headers torch's CUDA headers pull in (ATen/cuda/CUDAContext.h) plus cub/thrust.
  buildInputs = with cudaPackages; [
    cuda_cudart
    cuda_cccl
    libcublas
    libcusparse
    libcusolver
    libcurand
  ];

  dependencies = [
    torch-bin
    numpy
    jaxtyping
    rich
    packaging
  ];

  # ninja is only needed to compile the extension, which happens here, not at import time.
  pythonRemoveDeps = [ "ninja" ];

  preBuild = ''
    export MAX_JOBS=$NIX_BUILD_CORES
  '';

  env = {
    CUDA_HOME = "${cudaPackages.cuda_nvcc}";
    TORCH_CUDA_ARCH_LIST = cudaArchList;
    # torch's table wants g++ < 14 for CUDA 12.9, but nvcc 12.9 supports GCC 14, which is what nixpkgs' CUDA
    # backendStdenv provides (and what nvcc is pinned to anyway).
    TORCH_DONT_CHECK_COMPILER_ABI = "1";
  };

  # Importing gsplat loads the compiled extension (gsplat.csrc), which only needs the CUDA runtime, not a GPU.
  pythonImportsCheck = [
    "gsplat"
    "gsplat.csrc"
  ];
  doCheck = false; # the tests need a GPU

  meta = {
    description = "CUDA accelerated rasterization of Gaussian splatting";
    homepage = "https://github.com/nerfstudio-project/gsplat";
    license = lib.licenses.asl20;
    platforms = [ "x86_64-linux" ];
  };
}
