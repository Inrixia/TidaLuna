use std::env;
use std::path::Path;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=frontend/src");
    println!("cargo:rerun-if-changed=frontend/package.json");

    let out_dir = env::var("OUT_DIR").unwrap();
    let dest_path = Path::new(&out_dir).join("bundle.js");
    let frontend_dir = Path::new("frontend");

    let status = Command::new("bun")
        .args(&["install"])
        .current_dir(frontend_dir)
        .status()
        .expect("Failed to run bun install");

    if !status.success() {
        panic!("bun install failed");
    }

    let status = Command::new("bun")
        .args(&["run", "build"])
        .current_dir(frontend_dir)
        .status()
        .expect("Failed to run bun build");

    if !status.success() {
        panic!("bun build failed");
    }

    let bundle_path = frontend_dir.join("dist").join("bundle.js");
    std::fs::copy(&bundle_path, &dest_path).expect("Failed to copy bundle.js to OUT_DIR");

    #[cfg(target_os = "windows")]
    {
        // Get the project root directory
        let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();

        // Point to the 'libs' folder we just created
        let libs_dir = Path::new(&manifest_dir).join("libs");

        // Verify the file exists so you get a clear error if it's missing
        if !libs_dir.join("libmpv.dll.a").exists() {
            panic!(
                "Error: 'libs/libmpv.dll.a' is missing. Please download 'libmpv.dll.a' and place it in a 'libs' folder."
            );
        }

        println!("cargo:rustc-link-search=native={}", libs_dir.display());
        println!("cargo:rustc-link-lib=mpv");
    }
}
