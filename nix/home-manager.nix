# Called from flake.nix with { inherit self; }, returns a home-manager module.
{ self }:
{
  config,
  lib,
  ...
}:
let
  cfg = config.programs.tidaluna;
  pkgs = config._module.args.pkgs;
  isDarwin = pkgs.stdenv.isDarwin;

  # Normalize store URLs: strip trailing /store.json since TidaLuna adds it back
  normalizeStoreUrl =
    url:
    let
      suffix = "/store.json";
      len = builtins.stringLength url;
      suffixLen = builtins.stringLength suffix;
    in
    if suffixLen <= len && builtins.substring (len - suffixLen) suffixLen url == suffix then
      builtins.substring 0 (len - suffixLen) url
    else
      url;

  # Build the seed settings JSON
  pluginNames = if cfg.plugins == null then [ ] else map (p: p.shortURL) cfg.plugins;

  pluginSettings =
    if cfg.plugins == null then
      { }
    else
      builtins.listToAttrs (
        map (p: {
          name = p.settingsName;
          value = p.settings;
        }) (lib.filter (p: p.settings != { }) cfg.plugins)
      );

  seedSettings = {
    stores = map normalizeStoreUrl cfg.stores;
    pluginSettings = pluginSettings;
  }
  // lib.optionalAttrs (cfg.plugins != null) {
    plugins = pluginNames;
  };

  seedSettingsFile = pkgs.writeText "luna-settings.json" (builtins.toJSON seedSettings);

  hasSeedSettings = cfg.stores != [ ] || cfg.plugins != null || pluginSettings != { };

  # Patch the package to include luna-settings.json in the bundle directory
  patchedPackage =
    if !hasSeedSettings then
      cfg.package
    else if isDarwin then
      pkgs.runCommand "tidaluna-darwin-patched" { } ''
        cp -r ${cfg.package} $out
        chmod -R u+w $out
        cp ${seedSettingsFile} $out/Applications/TIDAL.app/Contents/Resources/app/luna-settings.json
      ''
    else
      pkgs.runCommand "tidaluna-linux-patched" { } ''
        cp -r ${cfg.package} $out
        chmod -R u+w $out
        cp ${seedSettingsFile} $out/share/tidal-hifi/resources/app/luna-settings.json
      '';
in
{
  options.programs.tidaluna = {
    enable = lib.mkEnableOption "TidaLuna, a client mod for the TIDAL music client";

    package = lib.mkOption {
      type = lib.types.package;
      defaultText = lib.literalExpression "inputs.tidaluna.packages.\${system}.default";
      description = "The TidaLuna package to install (before seed settings are patched in).";
    };

    stores = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = lib.literalExpression ''
        [
          "https://github.com/Inrixia/luna-plugins/releases/download/dev/store.json"
          "https://github.com/meowarex/TidalLuna-Plugins/releases/download/latest/store.json"
        ]
      '';
      description = ''
        Plugin store URLs to register in TidaLuna. This list fully replaces the persisted store list on every startup.
        You must include the stores for any plugins you declare in `plugins`.
      '';
    };

    plugins = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.listOf (
          lib.types.submodule {
            options = {
              shortURL = lib.mkOption {
                type = lib.types.str;
                description = "Plugin identifier used by the resolver (The name shown in the plugin store).";
                example = "meowarex/radiant-lyrics";
              };

              settingsName = lib.mkOption {
                type = lib.types.str;
                description = "Key used for plugin settings storage.";
                example = "RadiantLyrics";
              };

              settings = lib.mkOption {
                type = lib.types.attrsOf lib.types.anything;
                default = { };
                description = "Plugin settings.";
              };
            };
          }
        )
      );
      default = [ ];
    };
  };

  config = lib.mkIf cfg.enable {
    # Provide the default package from the flake outputs.
    programs.tidaluna.package = lib.mkOptionDefault (
      self.packages.${pkgs.stdenv.hostPlatform.system}.default
    );

    # Add the patched package to home.packages on all platforms.
    home.packages = [ patchedPackage ];
  };
}
