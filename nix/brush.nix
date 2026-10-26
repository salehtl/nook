# Brush (github.com/ArthurBrussee/brush), the Gaussian-splat trainer nook-scan drives. Same tag as scan/ uses on macOS.
# Headless use only: training talks to the GPU through wgpu -> Vulkan, so the wrapper puts the Vulkan loader on the
# library path; the NVIDIA driver itself (ICD) comes from the host (/run/opengl-driver).
{
  lib,
  rustPlatform,
  fetchFromGitHub,
  pkg-config,
  makeWrapper,
  vulkan-loader,
  wayland,
  libxkbcommon,
  libGL,
}:
rustPlatform.buildRustPackage rec {
  pname = "brush";
  version = "0.3.0";

  src = fetchFromGitHub {
    owner = "ArthurBrussee";
    repo = "brush";
    rev = "v${version}";
    hash = "sha256-xVYZrQUgHxaefAMmSXG/rrVlCr0H5lRmyyXtRmOtbTU=";
  };
  cargoHash = "sha256-KBgE0fiaUEsGuAYGhBjqMX7ftj5JnGggH86brxq6280=";

  cargoBuildFlags = [
    "-p"
    "brush-app"
    "--bin"
    "brush_app"
  ];
  doCheck = false;

  nativeBuildInputs = [
    pkg-config
    makeWrapper
  ];
  buildInputs = [
    wayland
    libxkbcommon
  ];

  postInstall = ''
    wrapProgram $out/bin/brush_app \
      --prefix LD_LIBRARY_PATH : ${
        lib.makeLibraryPath [
          vulkan-loader
          wayland
          libxkbcommon
          libGL
        ]
      }
  '';

  meta = {
    description = "3D Gaussian splat trainer (WebGPU/Vulkan)";
    homepage = "https://github.com/ArthurBrussee/brush";
    license = lib.licenses.asl20;
    mainProgram = "brush_app";
    platforms = [ "x86_64-linux" ];
  };
}
