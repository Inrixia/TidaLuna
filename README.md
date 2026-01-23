# TidaLuna

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