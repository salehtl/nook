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
          ]
          ++ lib.optionals (cfg.maxSplats != null) [
            "--max-splats"
            (toString cfg.maxSplats)
          ]
        );
        # Training runs as a child: stop it with the server.
        KillMode = "mixed";
        TimeoutStopSec = 30;
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
      serviceConfig = hardening // {
        ExecStart = lib.escapeShellArgs [
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
        ];
      };
    };
  };
}
