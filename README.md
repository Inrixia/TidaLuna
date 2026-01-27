# TidaLuna

## Windows ARM64 Support
Client now runs **fully natively** on Windows ARM64 (Snapdragon X Elite/Plus). No emulation required.

### Build Automation & Libraries
To make things easier, I've included the necessary ARM64 binaries and automated the setup:
* **Included Libs**: The `/libs` folder already contains `libmpv-2.dll` and `libmpv.dll.a` for ARM64.
* **Auto-Copy**: The `build.rs` script automatically copies the DLL to your `target/debug` or `target/release` folder during compilation.
* **Frontend**: The build script also handles `bun install` and `bun run build` for the frontend automatically.

### Prerequisites
* **LLVM**: Required in your `PATH` for compilation.
* **MPV Binaries (ARM64)**: Download `libmpv-2.dll` and `libmpv.dll.a` from [zhongfly/mpv-winbuild](https://github.com/zhongfly/mpv-winbuild/releases) and place them in the `/libs` folder before building.

### Troubleshooting & Findings
* **The "Null" Init Error**: Fixed by adding a "Language Trick" in `player.rs`. It forces the 'C' locale to prevent MPV from crashing on non-English Windows systems (where commas are used as decimals).

## Linux Notes
Install `libmpv-git` from the **AUR**. Then do `Cargo Run` and ye should be good!

### MPV Locale Fix
The fix is already applied in `main.rs` (and handled specifically for Windows in `player.rs`):
```rust
unsafe {
    std::env::set_var("LC_NUMERIC", "C");
    libc::setlocale(libc::LC_ALL, c"".as_ptr());
}
PlayerCommand::Load Fix
## Linux Notes

Install `libmpv-git` from the **AUR**

Then do `Cargo Run` and ye should be good!

### MPV Locale Fix

MPV's library requires the `LC_NUMERIC` locale to be set to `"C"` for proper number parsing (timestamps, durations, etc). Different locales use different decimal separators (`.` vs `,`), and MPV expects the C-style dot format.

If you see this error:
```
Non-C locale detected. This is not supported.
Call 'setlocale(LC_NUMERIC, "C");' in your code.
```

The fix is already applied in `main.rs`:
```rust
unsafe {
    std::env::set_var("LC_NUMERIC", "C");
    libc::setlocale(libc::LC_ALL, c"".as_ptr());
}
```

This sets the numeric locale to C and tells the system to reload locale settings before MPV initializes otherwise it has a hemerage.

Requires `libc` as a dependency. (I added this already <3)

### PlayerCommand::Load Fix

If you see this error:
```
error[E0559]: variant `PlayerCommand::Load` has no field named `url`
```

This happens when struct syntax is used for tuple variant. The fix me made in `player.rs`:
```rust
// Wrong (struct syntax)
.send(PlayerCommand::Load { url: stream_url })

// Correct (tuple syntax)
.send(PlayerCommand::Load(stream_url))
```