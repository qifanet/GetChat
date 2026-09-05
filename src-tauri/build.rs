fn main() {
    tauri_build::build();
    link_test_manifest_for_gnu();
}

/**
 * Embed a Common-Controls v6 manifest into TEST binaries on windows-gnu.
 *
 * wry imports `TaskDialogIndirect`, which exists only in comctl32 v6. The
 * MSVC toolchain embeds a default manifest (with the Common-Controls
 * dependency) into every linked binary, so `cargo test` works on Windows
 * CI. The GNU toolchain does not, so without this resource the test
 * executable binds comctl32 v5 and dies at load time with
 * STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139).
 *
 * windres must be on PATH (MinGW binutils). Non-GNU targets are unaffected.
 */
fn link_test_manifest_for_gnu() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.ends_with("windows-gnu") {
        return;
    }

    let rc = std::path::Path::new("windows/test-manifest.rc");
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR not set");
    let obj = std::path::Path::new(&out_dir).join("test_manifest.o");

    let status = std::process::Command::new("windres")
        .args(["-F", "pe-x86-64", "-i"])
        .arg(rc)
        .args(["-O", "coff", "-o"])
        .arg(&obj)
        .status();

    match status {
        Ok(status) if status.success() => {
            // Package as a .a archive exactly like tauri-build does for its
            // own resource object — ld's PE resource merge reliably picks up
            // archive members, while a bare object with a duplicate resource
            // id can be dropped in favour of rustc's default manifest.
            let archive = std::path::Path::new(&out_dir).join("libtest_manifest.a");
            let _ = std::fs::remove_file(&archive);
            let ar = std::process::Command::new("ar")
                .args(["crs"])
                .arg(&archive)
                .arg(&obj)
                .status();
            match ar {
                Ok(ar_status) if ar_status.success() => {
                    println!("cargo::rustc-link-arg-tests={}", archive.display());
                    println!("cargo::rerun-if-changed=windows/test-manifest.rc");
                    println!("cargo::rerun-if-changed=windows/test-manifest.xml");
                }
                Ok(ar_status) => panic!("ar failed ({ar_status}) for the test manifest"),
                Err(err) => panic!("ar not found ({err}); MinGW binutils are required to run tests on windows-gnu"),
            }
        }
        Ok(status) => panic!(
            "windres failed ({status}) while building the test manifest; \
             ensure MinGW binutils are on PATH"
        ),
        Err(err) => panic!(
            "windres not found ({err}); MinGW binutils are required to run \
             tests on windows-gnu"
        ),
    }
}
