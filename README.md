# Tidal Luna

Luna is a client mod for the [TIDAL Client](https://tidal.com/) & successor to [Neptune](https://github.com/uwu/neptune).  
Luna lets developers create and users run plugins to modify and enhance the Tidal Client.

If you want to chat with users and plugin creators, head over to our discord! **[discord.gg/jK3uHrJGx4](https://discord.gg/jK3uHrJGx4)**

The client is currently in **ALPHA** and active development.

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
1. Add this flake in your inputs: inputs.tidaLuna.url = github:Inrixia/TidaLuna
2. then install the package from the input: inputs'.tidaLuna.packages.default (with flake-parts)


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
