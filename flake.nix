{
  # nook: the reading-room planner (web app), the iPhone-scan trainer and its jobs server.
  # kakapo runs it from nixosModules.default (docs/plans/nook-scan-v2.md); Linux x86_64 + NVIDIA (Vulkan) only.
  description = "nook: reading-room planner, iPhone scan trainer and jobs server";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      linux = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${linux};
      shell =
        p:
        p.mkShell {
          packages = [
            p.python312
            p.uv
            p.nodejs_22
            p.cargo
            p.rustc
            p.pkg-config
            p.git
          ];
        };
    in
    {
      packages.${linux} = rec {
        brush = pkgs.callPackage ./nix/brush.nix { };
        nook = pkgs.callPackage ./nix/nook.nix { inherit brush; };
        default = nook;
      };

      nixosModules.default = import ./nix/module.nix self;

      # kakapo's project rule: tools come from the project's devShell.
      devShells.${linux}.default = shell pkgs;
      devShells.aarch64-darwin.default = shell nixpkgs.legacyPackages.aarch64-darwin;
    };
}
