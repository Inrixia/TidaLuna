use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;

fn main() {
    // --- SECCIÓN FRONTEND (BUN) ---
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

    // --- SECCIÓN WINDOWS ARM64 (MPV) ---
    #[cfg(target_os = "windows")]
    {
        let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();
        let libs_dir = Path::new(&manifest_dir).join("libs");
        
        // 1. Verificación de archivos necesarios para el enlazado
        if !libs_dir.join("libmpv.dll.a").exists() {
            panic!("Error: 'libs/libmpv.dll.a' is missing.");
        }

        // 2. Configurar el enlazador
        println!("cargo:rustc-link-search=native={}", libs_dir.display());
        println!("cargo:rustc-link-lib=mpv");

        // 3. COPIA AUTOMÁTICA DE LA DLL AL DIRECTORIO DE SALIDA
        // Buscamos la carpeta target/debug o target/release
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
            println!("cargo:warning=⚠️ Warning: libmpv-2.dll not found in /libs. Execution might fail.");
        }
    }
}