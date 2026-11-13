/*
 * The manifest a plugin package carries (`opentrader-plugin.json` at the root of its zip): who it is, what it provides,
 * how it runs, what its installation copies outside the app and the settings the user fills in. Everything a plugin
 * needs on this computer is described here, so the app keeps no code of its own for any one plugin.
 */
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

pub const FILE: &str = "opentrader-plugin.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    /// Symbols, bars and live ticks (`data.*`).
    Datafeed,
    /// An account: positions, orders, executions and order commands (`broker.*`).
    Broker,
}

impl Capability {
    /// The capability a method namespace needs (`data.bars` → datafeed); none for `plugin.*`, `hello`, `ping`, `log`.
    pub fn of_method(method: &str) -> Option<Capability> {
        match method.split_once('.').map(|(ns, _)| ns) {
            Some("data") => Some(Capability::Datafeed),
            Some("broker") => Some(Capability::Broker),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Runtime {
    /// A program in the package the app starts and stops (`entry`, relative to the package folder). It finds the API
    /// in its environment: `OPENTRADER_PLUGIN_ADDR`, `OPENTRADER_PLUGIN_ID`, `OPENTRADER_PLUGIN_TOKEN`.
    Process {
        entry: String,
        #[serde(default)]
        args: Vec<String>,
    },
    /// Runs inside another application and connects by itself. The app writes the address and token to
    /// `connection_file` (a path template, see `expand`) while the plugin is enabled.
    External { connection_file: Option<String> },
}

/// A folder the user picks at installation (a file of the package is copied there).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderTarget {
    /// What to pick, shown to the user.
    pub title: String,
    /// A path template whose `*` segments match any folder: the folders offered.
    #[serde(default)]
    pub suggest: Option<String>,
    /// The end the picked folder must have (`MQL5/Experts`), checked case-insensitively.
    #[serde(default)]
    pub expect: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallStep {
    /// A file of the package (relative path).
    pub copy: String,
    pub to: FolderTarget,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum SettingKind {
    Text,
    Number,
    Bool,
    Select,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct SettingOption {
    pub value: String,
    pub label: String,
}

/// One field of the plugin's settings form. Values travel as text (`plugin.configure`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingField {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: SettingKind,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub options: Vec<SettingOption>,
    #[serde(default)]
    pub help: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Lowercase letters, digits and dashes.
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub description: String,
    /// The Plugin API version it speaks (`API_VERSION`).
    pub api: u32,
    pub provides: Vec<Capability>,
    /// A data plugin's symbols are `<exchange>:<ticker>`: uppercase letters, digits and `_`.
    #[serde(default)]
    pub exchange: Option<String>,
    /// A data plugin serving several exchanges (one account's market segments), in place of `exchange`. The app then
    /// speaks to it with whole symbols (`NSE:RELIANCE`), since a ticker may trade on several of them.
    #[serde(default)]
    pub exchanges: Vec<String>,
    pub runtime: Runtime,
    #[serde(default)]
    pub install: Vec<InstallStep>,
    #[serde(default)]
    pub settings: Vec<SettingField>,
    /// What the user does in the other application, shown after installation.
    #[serde(default)]
    pub setup: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    /// `windows`, `macos`, `linux`; empty: all.
    #[serde(default)]
    pub platforms: Vec<String>,
}

/// The exchanges the app's own data uses: a plugin cannot take them.
const RESERVED_EXCHANGES: &[&str] = &["LOCAL", "ECONOMICS"];

impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Manifest, String> {
        let m: Manifest = serde_json::from_slice(bytes).map_err(|e| format!("{FILE}: {e}"))?;
        m.validate()?;
        Ok(m)
    }

    pub fn provides(&self, c: Capability) -> bool {
        self.provides.contains(&c)
    }

    /// The exchanges whose symbols the plugin serves: `exchanges`, else `exchange`.
    pub fn data_exchanges(&self) -> Vec<String> {
        if self.exchanges.is_empty() { self.exchange.iter().cloned().collect() } else { self.exchanges.clone() }
    }

    /// The app names the plugin's symbols whole (`NSE:RELIANCE`), not by their bare ticker: it serves `exchanges`.
    pub fn whole_symbols(&self) -> bool {
        !self.exchanges.is_empty()
    }

    pub fn validate(&self) -> Result<(), String> {
        let id_ok = (2..=40).contains(&self.id.len())
            && self.id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !self.id.starts_with('-');
        if !id_ok {
            return Err(format!("Plugin id {:?}: use 2 to 40 lowercase letters, digits and dashes", self.id));
        }
        if self.name.trim().is_empty() || self.version.trim().is_empty() {
            return Err("The plugin has no name or version".into());
        }
        if self.api == 0 {
            return Err("The plugin gives no API version".into());
        }
        if self.api > super::API_VERSION {
            return Err(format!("The plugin needs a newer OpenTrader (Plugin API {})", self.api));
        }
        if self.provides.is_empty() {
            return Err("The plugin provides neither data nor a broker".into());
        }
        if self.provides(Capability::Datafeed) && self.exchange.is_none() && self.exchanges.is_empty() {
            return Err("A data plugin names its exchange (the prefix of its symbols)".into());
        }
        for ex in self.exchange.iter().chain(&self.exchanges) {
            let ok = (2..=16).contains(&ex.len()) && ex.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
            if !ok || RESERVED_EXCHANGES.contains(&ex.as_str()) {
                return Err(format!("Exchange {ex:?}: use 2 to 16 uppercase letters, digits and _ (not LOCAL or ECONOMICS)"));
            }
        }
        // `exchange` may also be in `exchanges` (a manifest for both API versions); `exchanges` itself has no repeat.
        if let Some(ex) = self.exchanges.iter().enumerate().find_map(|(i, e)| self.exchanges[..i].contains(e).then_some(e)) {
            return Err(format!("Exchange {ex:?} is listed twice"));
        }
        match &self.runtime {
            Runtime::Process { entry, .. } => relative(entry)?,
            Runtime::External { connection_file: Some(t) } => {
                expand(t).ok_or_else(|| format!("Connection file {t:?}: not a path the app may write"))?;
                if !t.to_ascii_lowercase().ends_with(".json") {
                    return Err(format!("Connection file {t:?}: a .json file"));
                }
            }
            Runtime::External { connection_file: None } => {}
        }
        for step in &self.install {
            relative(&step.copy)?;
            if let Some(s) = &step.to.suggest {
                if !template_ok(s) {
                    return Err(format!("Install folder {s:?}: not a path template"));
                }
            }
        }
        let mut keys = std::collections::HashSet::new();
        for f in &self.settings {
            if f.key.is_empty() || !keys.insert(&f.key) {
                return Err(format!("Setting {:?}: empty or repeated key", f.key));
            }
            if f.kind == SettingKind::Select && f.options.is_empty() {
                return Err(format!("Setting {:?}: a choice without options", f.key));
            }
        }
        Ok(())
    }

    /// Runs on this computer (`platforms` empty or naming it).
    pub fn supported_here(&self) -> bool {
        let here = if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        };
        self.platforms.is_empty() || self.platforms.iter().any(|p| p == here)
    }
}

/// A path inside the package: relative, without `..`.
fn relative(p: &str) -> Result<(), String> {
    let path = Path::new(p);
    let ok = !p.is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)));
    if ok {
        Ok(())
    } else {
        Err(format!("{p:?}: a path inside the package"))
    }
}

/// The folders a template may start from.
fn base(var: &str) -> Option<PathBuf> {
    match var {
        // Roaming application data on Windows (`%APPDATA%`).
        "{appData}" => dirs::config_dir(),
        "{localAppData}" => dirs::data_local_dir(),
        "{documents}" => dirs::document_dir(),
        "{home}" => dirs::home_dir(),
        _ => None,
    }
}

/// `{appData}/A/*/B`: one of the known starts, then plain segments (`*` allowed when `glob`), no `..`.
fn split_template(t: &str) -> Option<(&str, Vec<&str>)> {
    let t = t.trim();
    let (var, rest) = match t.find('}') {
        Some(i) if t.starts_with('{') => (&t[..=i], &t[i + 1..]),
        _ => return None,
    };
    let segments: Vec<&str> = rest.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    let ok = segments.iter().all(|s| *s != ".." && *s != "." && !s.contains(':'));
    ok.then_some((var, segments))
}

fn template_ok(t: &str) -> bool {
    split_template(t).is_some_and(|(var, _)| matches!(var, "{appData}" | "{localAppData}" | "{documents}" | "{home}"))
}

/// The path of a template without `*` (a connection file), or None when it is not one.
pub fn expand(t: &str) -> Option<PathBuf> {
    let (var, segments) = split_template(t)?;
    if segments.is_empty() || segments.iter().any(|s| s.contains('*')) {
        return None;
    }
    let mut p = base(var)?;
    p.extend(segments);
    Some(p)
}

/// The existing folders a template with `*` segments matches (an installation's suggested folders).
pub fn candidates(t: &str) -> Vec<PathBuf> {
    let Some((var, segments)) = split_template(t) else { return Vec::new() };
    let Some(root) = base(var) else { return Vec::new() };
    let mut found = vec![root];
    for seg in segments {
        let mut next = Vec::new();
        for dir in &found {
            if seg == "*" {
                if let Ok(entries) = std::fs::read_dir(dir) {
                    next.extend(entries.flatten().filter(|e| e.path().is_dir()).map(|e| e.path()));
                }
            } else {
                let p = dir.join(seg);
                if p.is_dir() {
                    next.push(p);
                }
            }
        }
        found = next;
    }
    found.sort();
    found
}

/// The picked folder ends with `expect` (`MQL5/Experts`), case-insensitively.
pub fn folder_matches(folder: &Path, expect: &str) -> bool {
    let want: Vec<String> = expect.split(['/', '\\']).filter(|s| !s.is_empty()).map(str::to_lowercase).collect();
    let have: Vec<String> =
        folder.components().filter_map(|c| c.as_os_str().to_str()).map(str::to_lowercase).collect();
    have.len() >= want.len() && have[have.len() - want.len()..] == want[..]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> serde_json::Value {
        serde_json::json!({
            "id": "mt5", "name": "MetaTrader 5", "version": "0.1.0", "api": 1,
            "provides": ["datafeed", "broker"], "exchange": "MT5",
            "runtime": { "type": "external", "connectionFile": "{appData}/X/Common/Files/OpenTrader/mt5.json" },
            "install": [{ "copy": "Bridge.ex5", "to": { "title": "Experts folder", "suggest": "{appData}/X/*/MQL5/Experts", "expect": "MQL5/Experts" } }],
            "settings": [{ "key": "port", "label": "Port", "type": "number", "default": "4002" }]
        })
    }

    fn parse(v: serde_json::Value) -> Result<Manifest, String> {
        Manifest::parse(v.to_string().as_bytes())
    }

    #[test]
    fn parses_a_valid_manifest() {
        let m = parse(sample()).unwrap();
        assert!(m.provides(Capability::Broker));
        assert_eq!(m.exchange.as_deref(), Some("MT5"));
        assert!(matches!(m.runtime, Runtime::External { connection_file: Some(_) }));
        assert_eq!(m.settings[0].kind, SettingKind::Number);
    }

    #[test]
    fn refuses_bad_fields() {
        let with = |k: &str, v: serde_json::Value| {
            let mut s = sample();
            s[k] = v;
            parse(s)
        };
        assert!(with("id", "MT5".into()).is_err());
        assert!(with("api", 99.into()).unwrap_err().contains("newer"));
        assert!(with("exchange", "LOCAL".into()).is_err());
        assert!(with("exchange", serde_json::Value::Null).is_err());
        assert!(with("provides", serde_json::json!([])).is_err());
        assert!(with("runtime", serde_json::json!({ "type": "process", "entry": "../x.exe" })).is_err());
        assert!(with("runtime", serde_json::json!({ "type": "external", "connectionFile": "C:/Windows/x.json" })).is_err());
        assert!(with("runtime", serde_json::json!({ "type": "external", "connectionFile": "{appData}/../x.json" })).is_err());
        assert!(with("runtime", serde_json::json!({ "type": "process", "entry": "bin/ibkr.exe" })).is_ok());
    }

    #[test]
    fn several_exchanges() {
        let mut s = sample();
        s["exchanges"] = serde_json::json!(["NSE", "BSE", "NFO"]);
        let m = parse(s.clone()).unwrap();
        assert_eq!(m.data_exchanges(), vec!["NSE", "BSE", "NFO"]);
        assert!(m.whole_symbols());
        // `exchanges` alone is enough; `exchange` alone keeps bare tickers.
        s.as_object_mut().unwrap().remove("exchange");
        assert!(parse(s.clone()).is_ok());
        assert!(!parse(sample()).unwrap().whole_symbols());
        assert_eq!(parse(sample()).unwrap().data_exchanges(), vec!["MT5"]);
        s["exchanges"] = serde_json::json!(["NSE", "nse"]);
        assert!(parse(s.clone()).is_err());
        s["exchanges"] = serde_json::json!(["NSE", "LOCAL"]);
        assert!(parse(s.clone()).is_err());
        s["exchanges"] = serde_json::json!(["NSE", "NSE"]);
        assert!(parse(s).unwrap_err().contains("twice"));
    }

    #[test]
    fn method_namespaces() {
        assert_eq!(Capability::of_method("data.bars"), Some(Capability::Datafeed));
        assert_eq!(Capability::of_method("broker.place"), Some(Capability::Broker));
        assert_eq!(Capability::of_method("plugin.configure"), None);
        assert_eq!(Capability::of_method("log"), None);
    }

    #[test]
    fn templates() {
        assert!(expand("{appData}/A/b.json").is_some());
        assert!(expand("{appData}/A/*/b.json").is_none());
        assert!(expand("{nope}/b.json").is_none());
        assert!(expand("{appData}").is_none());
        assert!(folder_matches(Path::new("C:/T/ABC/MQL5/Experts"), "mql5/experts"));
        assert!(!folder_matches(Path::new("C:/T/ABC/MQL5"), "MQL5/Experts"));
    }
}
