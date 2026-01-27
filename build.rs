use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;

fn main() {
    // --- FRONTEND BUILD (BUN) ---
    // Only rebuild if frontend source or deps actually change
    println!("cargo:rerun-if-changed=frontend/src");
    println!("cargo:rerun-if-changed=frontend/package.json");

    let out_dir = env::var("OUT_DIR").unwrap();
    let dest_path = Path::new(&out_dir).join("bundle.js");
    let frontend_dir = Path::new("frontend");

    // Make sure we have the node_modules ready
    let status = Command::new("bun")
        .args(&["install"])
        .current_dir(frontend_dir)
        .status()
        .expect("Failed to run bun install");

    if !status.success() {
        panic!("bun install failed");
    }

    // Run the build script defined in package.json
    let status = Command::new("bun")
        .args(&["run", "build"])
        .current_dir(frontend_dir)
        .status()
        .expect("Failed to run bun build");

    if !status.success() {
        panic!("bun build failed");
    }

    // Move the final bundle to where Rust can find it
    let bundle_path = frontend_dir.join("dist").join("bundle.js");
    std::fs::copy(&bundle_path, &dest_path).expect("Failed to copy bundle.js to OUT_DIR");

    // --- WINDOWS ARM64 SETUP (MPV) ---
    #[cfg(target_os = "windows")]
    {
        let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();
        let libs_dir = Path::new(&manifest_dir).join("libs");
        
        // Quick check for the linker lib, otherwise it'll fail later anyway
        if !libs_dir.join("libmpv.dll.a").exists() {
            panic!("Error: 'libs/libmpv.dll.a' is missing. Linker will complain.");
        }

        // Tell cargo where to look for mpv and link it
        println!("cargo:rustc-link-search=native={}", libs_dir.display());
        println!("cargo:rustc-link-lib=mpv");

        // AUTO-COPY DLL TO TARGET DIR
        // We need the DLL right next to the .exe to actually run the thing
        let target_dir = Path::new(&out_dir)
            .join("..")
            .join("..")
            .join("..");

        let dll_source = libs_dir.join("libmpv-2.dll");
        let dll_dest = target_dir.join("libmpv-2.dll");

        if dll_source.exists() {
            fs::copy(&dll_source, &dll_dest).expect("Failed to copy libmpv-2.dll to target directory");
            println!("cargo:warning=✅ MPV DLL copied to: {:?}", dll_dest);
        } else {
            // Not a hard fail, but the app probably won't start
            println!("cargo:warning=⚠️ Heads up: libmpv-2.dll not found in /libs. Runtime might crash.");
        }
    }
}