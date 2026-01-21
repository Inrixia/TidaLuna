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
        let path = if let Ok(mpv_source) = std::env::var("MPV_SOURCE") {
            std::path::PathBuf::from(mpv_source)
        } else {
            let appdata_dir = std::env::var("APPDATA").unwrap();
            std::path::Path::new(&appdata_dir).join("mpv").join("lib")
        };

        println!("cargo:rustc-link-search=native={}", path.display());
        println!("cargo:rustc-link-lib=static=mpv");
    }
}
