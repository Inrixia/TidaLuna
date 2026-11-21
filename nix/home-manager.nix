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
  isDarwin = pkgs.stdenv.hostPlatform.isDarwin;

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

  # Build the seed settings JSON, a key is only written when its option is set
  pluginSettings =
    if cfg.plugins == null then
      { }
    else
      builtins.listToAttrs (
        map (p: {
          name = if p.settingsName != null then p.settingsName else p.name;
          value = p.settings;
        }) (lib.filter (p: p.settings != { }) cfg.plugins)
      );

  seedSettings =
    lib.optionalAttrs (cfg.stores != null) {
      stores = map normalizeStoreUrl cfg.stores;
    }
    // lib.optionalAttrs (cfg.plugins != null) {
      plugins = map (p: p.name) cfg.plugins;
    }
    // lib.optionalAttrs (pluginSettings != { }) {
      inherit pluginSettings;
    };

  seedSettingsFile = pkgs.writeText "luna-settings.json" (builtins.toJSON seedSettings);

  hasSeedSettings = seedSettings != { };

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
        # The bin wrappers exec the original package, point them at this copy so luna-settings.json is used
        for f in $out/bin/*; do
          if [ -f "$f" ] && grep -qF ${cfg.package} "$f"; then
            substituteInPlace "$f" --replace-fail ${cfg.package} $out
          fi
        done
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
      type = lib.types.nullOr (lib.types.listOf lib.types.str);
      default = null;
      example = lib.literalExpression ''
        [
          "https://github.com/Inrixia/luna-plugins/releases/download/dev/store.json"
          "https://release.radiant-lyrics.org/store.json"
        ]
      '';
      description = ''
        Plugin store URLs. When set, this list replaces the store list (including the default stores) on every startup.
        `null` leaves the stores as they are. Declared `plugins` are looked up in these stores.
      '';
    };

    plugins = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.listOf (
          lib.types.submodule {
            options = {
              name = lib.mkOption {
                type = lib.types.str;
                description = ''
                  Plugin to install: its name as listed in the Plugin Store (e.g. `DiscordRPC`, `meowarex.radiant-lyrics`)
                  or its package name. Matching ignores case. A plugin that is not found in any store shows an error in TIDAL.
                '';
                example = "DiscordRPC";
              };

              settingsName = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Key the plugin stores its settings under. Only needed when it differs from `name` and `settings` is set.";
                example = "RadiantLyrics";
              };

              settings = lib.mkOption {
                type = lib.types.attrsOf lib.types.anything;
                default = { };
                description = "Plugin settings. Declared keys overwrite the stored values on every startup, other keys are kept.";
              };
            };
          }
        )
      );
      default = null;
      description = ''
        Plugins to keep installed. When set, every plugin not in this list is removed on startup and missing ones are installed.
        `null` leaves the installed plugins as they are.
      '';
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
