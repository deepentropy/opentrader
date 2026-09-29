fn main() {
    #[allow(unused_mut)]
    let mut attributes = tauri_build::Attributes::new();

    // Windows: embed app.manifest into EVERY target via the linker, and turn off
    // tauri-build's own manifest so there is exactly one source (two would fail
    // the link with CVT1100 "duplicate resource: MANIFEST, name 1").
    //
    // Why this matters beyond the app binary: the tauri dependency tree
    // statically imports comctl32!TaskDialogIndirect, which only ComCtl32 v6
    // exports, and the manifest's Common-Controls v6 dependency is what binds
    // v6. tauri-build embeds its manifest into bin targets only, so test
    // binaries got no resource section at all, loaded comctl32 5.82 from
    // System32, and died at load with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)
    // before main. That made `cargo test` impossible on Windows — including the
    // `export_bindings` test CI depends on. Cargo has no link-arg scope covering
    // a lib's unit tests (`-tests` is for tests/ targets only), hence the
    // unscoped flag plus disabling tauri's copy.
    //
    // new_without_app_manifest() drops ONLY the manifest; the window icon
    // default is retained.
    #[cfg(windows)]
    {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("app.manifest");
        println!("cargo::rerun-if-changed=app.manifest");
        println!("cargo::rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo::rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }

    gateway_token();

    tauri_build::try_build(attributes).expect("failed to run tauri build script");
}

/// The gateway app token (`data::gateway::token`) is compiled in and never
/// committed. Official builds set `OPENTRADER_GATEWAY_TOKEN` in the build
/// environment; a dev build without it takes the value from the repo-root
/// `.env` (gitignored).
fn gateway_token() {
    const VAR: &str = "OPENTRADER_GATEWAY_TOKEN";
    println!("cargo::rerun-if-env-changed={VAR}");
    if std::env::var_os(VAR).is_some() {
        return;
    }
    let env_file = std::path::Path::new("../.env");
    if !env_file.exists() {
        return;
    }
    println!("cargo::rerun-if-changed=../.env");
    let Ok(text) = std::fs::read_to_string(env_file) else { return };
    let value = text.lines().find_map(|l| l.trim().strip_prefix(VAR)?.trim_start().strip_prefix('='));
    if let Some(v) = value {
        let v = v.trim().trim_matches('"').trim_matches('\'');
        if !v.is_empty() {
            println!("cargo::rustc-env={VAR}={v}");
        }
    }
}
