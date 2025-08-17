# Tidal Luna

Luna is a client mod for the [TIDAL Client](https://tidal.com/) & successor to [Neptune](https://github.com/uwu/neptune).  
Luna lets developers create and users run plugins to modify and enhance the Tidal Client.

If you want to chat with users and plugin creators, head over to our discord! **[discord.gg/jK3uHrJGx4](https://discord.gg/jK3uHrJGx4)**

The client is currently in **BETA**.

## Installation
Use one of the following projects:  
- https://github.com/jxnxsdev/TidaLuna-Installer
- https://github.com/espeon/lunactl

### FAQ
- Luna does not support the Windows Store version of Tidal.  
  Please install the desktop version if you have the Store version.
- Ensure that Tidal is closed when installing or installation may fail.
- You shouldnt need to run as Admin for installing.

### Nix install
1. Add the flake in your inputs:
```nix
inputs.tidaLuna.url = "github:Inrixia/TidaLuna"
```
2. Then install the package from the input:
```diff
environment.systemPackages = with pkgs; [
-  tidal-hifi
+  inputs.tidaLuna.packages.${system}.default
];
```

### Manual Install
1. Download the **luna.zip** release you want to install from https://github.com/Inrixia/TidaLuna/releases
2. Go to your Tidal install resources folder, typically found in:
- Windows: `%localappdata%\TIDAL\app-x.xx.x\resources`
- MacOS: `/Applications/TIDAL.app/Contents/Resources`
- Linux: `/opt/tidal-hifi/resources`
3. Rename `app.asar` to `original.asar`
4. Unzip **luna.zip** into a folder named `app` in the `resources` directory alongside `original.asar`
5. You should now have a folder `TIDAL\...\resources\app` next to `original.asar` with all the files from **luna.zip**

Done! Start Tidal and you should see the Luna spashscreen.

## Developers
Proper developer documentation etc is planned after the inital beta release of Luna.  
If you are a developer or want to try making your own plugin, please hop in discord and ask we are more than happy to assist with getting started.

### Client Dev
To develop for the luna client follow these steps:
1. Fork this repo and clone it locally
2. Install packages `pnpm i`
3. Run the watch command to build `pnpm run watch`
4. Symlink your `dist` folder to your Tidal `app` folder mentioned in the *Manual Install* section above.  
   Or if you dont care about live reloading of `/native/injector.ts` set the `TIDALUNA_DIST_PATH` env variable to your `dist` folder path.
5. Launch Luna

Core plugins under `/plugins` can be reloaded via Luna Settings.  
Changes to `/render` or `/native` code require a client restart.
