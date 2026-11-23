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

  # `stores` is shorthand for storage."@luna/pluginStores".storeUrls
  storesKeySet = cfg.storage ? "@luna/pluginStores" && cfg.storage."@luna/pluginStores" ? storeUrls;
  storage =
    cfg.storage
    // lib.optionalAttrs (cfg.stores != null) {
      "@luna/pluginStores" = (cfg.storage."@luna/pluginStores" or { }) // {
        storeUrls = lib.unique (map normalizeStoreUrl cfg.stores);
      };
    };

  # Build the seed settings JSON, a key is only written when its option is set
  seedSettings =
    lib.optionalAttrs (cfg.plugins != null) {
      inherit (cfg) plugins;
    }
    // lib.optionalAttrs (storage != { }) {
      inherit storage;
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
          if [ -L "$f" ]; then
            target=$(readlink "$f")
            case "$target" in
              ${cfg.package}/*) ln -sfn "$out''${target#${cfg.package}}" "$f" ;;
            esac
          elif [ -f "$f" ] && grep -qF ${cfg.package} "$f"; then
            # Only scripts can be patched as text, a binary wrapper would break
            if [ "$(head -c 2 "$f")" != "#!" ]; then
              echo "tidaluna: can't point $f at the patched copy, it is not a script" >&2
              exit 1
            fi
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
      defaultText = lib.literalExpression "inputs.tidaLuna.packages.\${system}.default";
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
      type = lib.types.nullOr (lib.types.listOf lib.types.str);
      default = null;
      example = [
        "Shazam"
        "DiscordRPC"
      ];
      description = ''
        Plugins to keep installed: their names as listed in the Plugin Store (e.g. `DiscordRPC`, `meowarex.radiant-lyrics`)
        or their package names, case is ignored. When set, every plugin not in this list is removed on startup and missing ones
        are installed, a plugin that is not found in any store shows an error in TIDAL.
        Whether an installed plugin is enabled stays up to you in the UI. `null` leaves the installed plugins as they are.
      '';
    };

    storage = lib.mkOption {
      type = lib.types.attrsOf (lib.types.attrsOf lib.types.anything);
      default = { };
      example = lib.literalExpression ''
        {
          "@luna/pluginStorage".DiscordRPC = {
            displayOnPause = false;
            customStatusText = "{track} by {artist}";
          };
        }
      '';
      description = ''
        Values written into TidaLuna's stores on every startup, laid out as devtools shows them (IndexedDB): store name, key, value.
        An attrset value is merged over the stored one so undeclared keys are kept, any other value replaces it.
        Stores and keys you don't declare are not touched.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !(cfg.stores != null && storesKeySet);
        message = ''programs.tidaluna: set either `stores` or `storage."@luna/pluginStores".storeUrls`, not both.'';
      }
    ];

    # Provide the default package from the flake outputs.
    programs.tidaluna.package = lib.mkOptionDefault (
      self.packages.${pkgs.stdenv.hostPlatform.system}.default
    );

    # Add the patched package to home.packages on all platforms.
    home.packages = [ patchedPackage ];
  };
}
