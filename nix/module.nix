# NixOS module for nook on a GPU host (kakapo): the nook-scan jobs server trains uploaded iPhone captures on the GPU
# and writes each finished room into the folder the web app serves, so a scan sent from the app shows up in the
# planner with no manual step. Both listen on 127.0.0.1 only; the host's proxy decides who can reach the web app,
# which forwards /api/scan/* to the jobs server (one origin for the app and the iPhone).
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.nook;
  pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.nook;
  dir = cfg.dataDir;
  hardening = {
    User = "nook";
    Group = "nook";
    WorkingDirectory = dir;
    NoNewPrivileges = true;
    PrivateTmp = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    ReadWritePaths = [ dir ];
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectControlGroups = true;
    RestrictSUIDSGID = true;
    LockPersonality = true;
    Restart = "on-failure";
    RestartSec = 5;
  };
in
{
  options.services.nook = {
    enable = lib.mkEnableOption "nook: reading-room planner and GPU trainer for iPhone room scans";
    webPort = lib.mkOption {
      type = lib.types.port;
      default = 8096;
      description = "Web app (planner) port on 127.0.0.1; it also proxies /api/scan/* to the jobs server.";
    };
    apiPort = lib.mkOption {
      type = lib.types.port;
      default = 8095;
      description = "nook-scan jobs server port on 127.0.0.1.";
    };
    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/nook";
      description = "Rooms, uploads, layouts, library and renders.";
    };
    quality = lib.mkOption {
      type = lib.types.enum [
        "draft"
        "high"
      ];
      default = "high";
    };
    maxSplats = lib.mkOption {
      type = lib.types.nullOr lib.types.ints.positive;
      default = null;
      description = "Cap on splats per room (VRAM); null keeps nook-scan's own default.";
    };
    falKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/nook-fal";
      description = ''
        An EnvironmentFile holding `FAL_KEY=...` for the web app's paid fal calls (library adds from photos and
        Render). A path string, so the secret never lands in the Nix store. Null: those calls answer "FAL_KEY not set".
      '';
    };
    dailySpendUsd = lib.mkOption {
      type = lib.types.numbers.nonnegative;
      default = 2;
      description = "Cap on paid fal calls per UTC day, in USD (`nook-web --daily-spend-usd`, contract §2.9).";
    };
    allowedHosts = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "nook.salehtl.com" ];
      description = ''
        Host names the web app answers besides loopback ones (`nook-web --allowed-host`, contract §2.9): the names
        the host's proxy serves it under. Any other Host gets a 403, against DNS rebinding. nook-scan only gets
        loopback traffic (from the web app's proxy), so it needs none.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.nook = {
      isSystemUser = true;
      group = "nook";
      extraGroups = [
        "video"
        "render"
      ];
      home = dir;
    };
    users.groups.nook = { };

    systemd.tmpfiles.settings."10-nook" = lib.genAttrs [
      dir
      "${dir}/room"
      "${dir}/jobs"
      "${dir}/tmp"
      "${dir}/library"
      "${dir}/layouts"
      "${dir}/renders"
    ] (_: { d = { user = "nook"; group = "nook"; mode = "0750"; }; });

    systemd.services.nook-scan = {
      description = "nook-scan jobs server (trains iPhone room scans on the GPU)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      environment = {
        HOME = dir;
        TMPDIR = "${dir}/tmp";
      };
      serviceConfig = hardening // {
        ExecStart = lib.escapeShellArgs (
          [
            "${pkg}/bin/nook-scan"
            "serve"
            "--host"
            "127.0.0.1"
            "--port"
            (toString cfg.apiPort)
            "--data-dir"
            "${dir}/jobs"
            "--room-dir"
            "${dir}/room"
            "--quality"
            cfg.quality
            # One GPU user at a time: evals/remote.sh takes the same lock (contract §5.1).
            "--gpu-lock"
            "/run/nook/gpu.lock"
          ]
          ++ lib.optionals (cfg.maxSplats != null) [
            "--max-splats"
            (toString cfg.maxSplats)
          ]
        );
        # Training runs as a child: stop it with the server.
        KillMode = "mixed";
        TimeoutStopSec = 30;
        # The house's services come first; training peaks near 12.3 GB (docs/plans/nook-v4.md).
        Nice = 10;
        CPUWeight = 50;
        MemoryMax = "16G";
        # /run/nook holds gpu.lock; group-writable so a user in the nook group (evals/remote.sh) can share it.
        RuntimeDirectory = "nook";
        RuntimeDirectoryMode = "0775";
      };
    };

    systemd.services.nook-web = {
      description = "nook web app (planner), serving the rooms nook-scan trains";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network.target"
        "nook-scan.service"
      ];
      environment.HOME = dir;
      serviceConfig = hardening // lib.optionalAttrs (cfg.falKeyFile != null) {
        EnvironmentFile = cfg.falKeyFile;
      } // {
        ExecStart = lib.escapeShellArgs (
          [
            "${pkg}/bin/nook-web"
            "--host"
            "127.0.0.1"
            "--port"
            (toString cfg.webPort)
            "--room-dir"
            "${dir}/room"
            "--library-dir"
            "${dir}/library"
            "--layouts-dir"
            "${dir}/layouts"
            "--renders-dir"
            "${dir}/renders"
            "--costs-file"
            "${dir}/library/costs.csv"
            "--scan-api"
            "http://127.0.0.1:${toString cfg.apiPort}"
            "--daily-spend-usd"
            (toString cfg.dailySpendUsd)
          ]
          ++ lib.concatMap (h: [
            "--allowed-host"
            h
          ]) cfg.allowedHosts
        );
      };
    };
  };
}
