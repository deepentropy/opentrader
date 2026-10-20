/// The gateway app token (`data::gateway::token`) is compiled in and never
/// committed. Official builds set `OPENTRADER_GATEWAY_TOKEN` in the build
/// environment; a dev build without it takes the value from the repo-root
/// `.env` (gitignored). A server reads the same variable at run time instead.
fn main() {
    const VAR: &str = "OPENTRADER_GATEWAY_TOKEN";
    println!("cargo::rerun-if-env-changed={VAR}");
    if std::env::var_os(VAR).is_some() {
        return;
    }
    let env_file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.env");
    if !env_file.exists() {
        return;
    }
    println!("cargo::rerun-if-changed={}", env_file.display());
    let Ok(text) = std::fs::read_to_string(&env_file) else { return };
    let value = text.lines().find_map(|l| l.trim().strip_prefix(VAR)?.trim_start().strip_prefix('='));
    if let Some(v) = value {
        let v = v.trim().trim_matches('"').trim_matches('\'');
        if !v.is_empty() {
            println!("cargo::rustc-env={VAR}={v}");
        }
    }
}
