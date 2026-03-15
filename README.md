# Tidal Luna

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
inputs.tidaLuna.url = "github:Inrixia/TidaLuna"
```

There are now two ways to install the injected tidal-hifi client

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

Add the home manager module to `sharedModules`

```nix
home-manager.sharedModules = [
    inputs.tidaluna.homeManagerModules.default
]
```

Then Enable TidaLuna using 

```nix
programs.tidaluna = {
    enable = true;
};
```

##### Configuring Stores

In contrast to the other installation methods, the home manager module comes with no stores preconfigured. You must
include the stores for any plugins you declare in `plugins`. To define stores add them to the `stores` array:

```nix
programs.tidaluna = {
    enable = true;
    stores = [
        "https://github.com/Inrixia/luna-plugins/releases/download/dev/store.json"
    ];
};
```

The list of stores which come default with TidaLuna can be found in `plugins/ui/src/SettingsPage/PluginStoreTab/index.tsx`.

##### Installing and Configuring Plugins

After having added the stores needed plugins can be defined in the `plugins` array:
```nix
programs.tidaluna = {
    enable = true;
    stores = [
        "https://github.com/Inrixia/luna-plugins/releases/download/dev/store.json"
    ];
    plugins = [
        {
            shortURL = "DiscordRPC";
            settingsName = "DiscordRPC";
            settings = {
                "displayOnPause" = false;
                "displayArtistIcon" = true;
                "displayPlaylistButton" = true;
                "customStatusText" = "{track} by {artist}";
            };
        }
    ];
};
```

A plugin definition consists of the following three keys: 

- `shortURL`: The name as shown in the "Plugin Store" tab, used for installing the plugin.
- `settingsName`: The key the plugin uses for storing its settings. This may or may not **differ** from the `shortURL`.
- `settings`: Settings to be applied to the plugin.

To get the `settingsName` and `settings` of all installed plugins run the following command in the developer console
of Tidal: `const idb = await luna.core.ReactiveStore.getStore("@luna/pluginStorage").dump(); console.log(JSON.stringify(idb, null, 2));`

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
