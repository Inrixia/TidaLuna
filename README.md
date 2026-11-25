# Tidal Luna

[![Build & Release](https://github.com/Inrixia/TidaLuna/actions/workflows/build.yml/badge.svg)](https://github.com/Inrixia/TidaLuna/actions/workflows/build.yml)
[![coverage](https://img.shields.io/endpoint?url=https://cdn.jsdelivr.net/gh/Inrixia/TidaLuna@master/.github/badges/coverage.json)](docs/testing.md)
[![branch coverage](https://img.shields.io/endpoint?url=https://cdn.jsdelivr.net/gh/Inrixia/TidaLuna@master/.github/badges/coverage-branches.json)](docs/testing.md)
[![tests](https://img.shields.io/endpoint?url=https://cdn.jsdelivr.net/gh/Inrixia/TidaLuna@master/.github/badges/tests.json)](docs/testing.md)

Luna is a client mod for the [TIDAL Client](https://tidal.com/) & successor to [Neptune](https://github.com/uwu/neptune).  
Luna lets developers create and users run plugins to modify and enhance the Tidal Client.

If you want to chat with users and plugin creators, head over to our discord! **[discord.gg/jK3uHrJGx4](https://discord.gg/jK3uHrJGx4)**

The client is currently in **BETA**.

## Installing

To install Luna

1. Install [**Tidal**](https://offer.tidal.com/download)
2. Download and run the [**Luna Installer**](https://github.com/jxnxsdev/TidaLuna-Installer/releases/latest)

### FAQ

- Luna does not support the Windows Store version of Tidal.  
  Please install the desktop version if you have the Store version.
- Ensure that Tidal is closed when installing or installation may fail.
- You shouldnt need to run as Admin for installing.

### Manual Install

Only needed if for some reason the [**Luna Installer**](https://github.com/jxnxsdev/TidaLuna-Installer/releases/latest) is not working for you!

1. Download the **luna.zip** release you want to install from https://github.com/Inrixia/TidaLuna/releases
2. Go to your Tidal install resources folder, typically found in:

- Windows: `%localappdata%\TIDAL\app-x.xx.x\resources`
- MacOS: `/Applications/TIDAL.app/Contents/Resources`
- Linux: `/opt/tidal-hifi/resources`

3. Rename `app.asar` to `original.asar`
4. Unzip **luna.zip** into a folder named `app` in the `resources` directory alongside `original.asar`
5. You should now have a folder `TIDAL\...\resources\app` next to `original.asar` with all the files from **luna.zip**

#### MacOS CodeSign

On MacOS you need to sign the new install so that it isnt reverted, you can do this by running this command

```sh
codesign --force --deep --sign - /Applications/TIDAL.app
```

Done! Start Tidal and you should see the Luna splashscreen.

### Nix install
TidaLuna is managed through flakes, so the first thing you have to do is add TidaLuna in your inputs
```nix
inputs.tidaLuna = {
  url = "github:Inrixia/TidaLuna";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

There are three ways to install the injected tidal-hifi client

#### Overlay
Add TidaLuna into your overlay list
```nix
nixpkgs.overlay = [
  inputs.tidaLuna.overlays.default
];
```

after that install the tidal-hifi package as you used to

#### Package
Replace your current `tidal-hifi` package with the new input

```diff
environment.systemPackages = with pkgs; [
-  tidal-hifi
+  inputs.tidaLuna.packages.${stdenv.hostPlatform.system}.default
];
```

#### Home Manager

The Home Manager module installs the injected client itself (no need for the overlay or package above) and can declare stores, plugins and plugin settings.
Add the module to `sharedModules` (or to `imports` in a standalone Home Manager config):

```nix
home-manager.sharedModules = [
  inputs.tidaLuna.homeManagerModules.default
];
```

Then enable TidaLuna:

```nix
programs.tidaluna = {
  enable = true;
};
```

> [!WARNING]
> Your config is the source of truth: once you set `stores`, `plugins` or `storage`, TidaLuna applies them on **every** startup.
> Stores and plugins you add or remove in the UI are reverted on the next start, and declared `storage` values overwrite the values changed in the UI.
> Options you leave unset (the default) are not touched.

##### Stores

`stores` replaces the store list, including the stores that come with TidaLuna (listed in `plugins/ui/src/SettingsPage/PluginStoreTab/index.tsx`).
Plugins declared in `plugins` are looked up in these stores, so include the stores they come from:

```nix
programs.tidaluna = {
  enable = true;
  stores = [
    "https://github.com/Inrixia/luna-plugins/releases/download/dev/store.json"
  ];
};
```

##### Plugins

When `plugins` is set, every plugin not in the list is uninstalled on startup and missing ones are installed from the stores.
Use the plugin's name as listed in the Plugin Store (e.g. `DiscordRPC`, `Song Downloader`, `meowarex.radiant-lyrics`) or its package name, case is ignored.
If a plugin is not found in any store, TidaLuna shows an error on startup.
Settings of plugins you uninstall are kept. Enabling or disabling an installed plugin is still up to you in the UI.

```nix
programs.tidaluna = {
  enable = true;
  stores = [
    "https://github.com/Inrixia/luna-plugins/releases/download/dev/store.json"
  ];
  plugins = [ "Shazam" "DiscordRPC" ];
};
```

##### Storage (plugin settings and anything else)

`storage` writes values into TidaLuna's stores, laid out as devtools shows them: store name, then key, then value.
Plugin settings live in the `@luna/pluginStorage` store under the plugin's name, but `storage` can override anything a plugin stores.
An attrset value is merged over the stored one, so only the keys you declare are overwritten. Any other value (a list, a string...) replaces the stored value.

```nix
programs.tidaluna.storage = {
  "@luna/pluginStorage".DiscordRPC = {
    displayOnPause = false;
    displayArtistIcon = true;
    customStatusText = "{track} by {artist}";
  };
};
```

To see what is stored, open TIDAL's devtools: Application, IndexedDB, then a store (e.g. `@luna/pluginStorage`) and its `_` object store.
Or dump a store in the console: `console.log(JSON.stringify(await luna.core.ReactiveStore.getStore("@luna/pluginStorage").dump(), null, 2));`

`stores` is a shorthand for `storage."@luna/pluginStores".storeUrls`, set only one of them.

The module writes these options to `luna-settings.json` next to TidaLuna's files (`resources/app`). Without Nix you can write that file by hand:

```json
{
  "plugins": ["Shazam", "DiscordRPC"],
  "storage": {
    "@luna/pluginStores": { "storeUrls": ["https://github.com/Inrixia/luna-plugins/releases/download/dev"] },
    "@luna/pluginStorage": { "DiscordRPC": { "displayOnPause": false } }
  }
}
```

## Developers

Proper developer documentation etc is planned after the inital beta release of Luna.  
If you are a developer or want to try making your own plugin, please hop in discord and ask we are more than happy to assist with getting started.

### Client Dev

To develop for the luna client follow these steps:

1. Fork this repo and clone it locally
2. Install packages `pnpm i`
3. Run the watch command to build `pnpm run watch`
4. Symlink your `dist` folder to your Tidal `app` folder mentioned in the _Manual Install_ section above.
   ```sh
   mklink /D "%LOCALAPPDATA%\TIDAL\app-x.xx.x\resources\app" "./dist"
   ```
   or if you dont care about live reloading of `/native/injector.ts` set the `TIDALUNA_DIST_PATH` env variable to your `dist` folder path.
5. Launch Luna

Core plugins under `/plugins` can be reloaded via Luna Settings.  
Changes to `/render` or `/native` code require a client restart.

### Test instances

To test dev builds or plugins without touching your daily client, you can run separate TIDAL instances side by side,
each with its own profile, Luna build and DevTools port. See [docs/test-instances.md](docs/test-instances.md).
