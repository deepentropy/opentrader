/*
 * A data plugin's instrument values (#383, `fields` in plugins/PROTOCOL.md): what its source tells of a symbol beyond
 * prices, such as the circuit limits and price bands of Indian exchanges. They come with the symbol's info
 * (`data.symbolInfo`) and change with its quotes (`data.quote`); Symbol info and the Details panel show them under
 * the plugin's name. Scripts read a value's history as an extra series of the symbol (`series`), not from here.
 */
use super::data::{self, Route};
use super::Plugins;
use opentrader_core::sync::LockExt;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

/// Fields of one symbol at most, and the longest name and text value.
const MAX_FIELDS: usize = 50;
const MAX_NAME: usize = 64;
const MAX_TEXT: usize = 200;

#[derive(Default)]
pub struct PluginFields {
    /// Symbol → the values its quotes changed (None: removed), by name.
    live: Mutex<HashMap<String, Vec<(String, Option<FieldValue>)>>>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, specta::Type)]
#[serde(untagged)]
pub enum FieldValue {
    Number(f64),
    Text(String),
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, specta::Type)]
pub struct PluginField {
    pub name: String,
    pub value: FieldValue,
}

/// A plugin symbol's fields, and the name of the plugin they come from.
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginSymbolFields {
    pub plugin_name: String,
    pub fields: Vec<PluginField>,
}

/// A plugin symbol's fields changed (a quote brought new values): read `plugin_symbol_fields` again.
#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct PluginFieldsChanged {
    pub symbol: String,
}

fn state(app: &AppHandle) -> &PluginFields {
    &app.state::<Plugins>().inner().fields
}

/// `{"name":…, "value":…}` as kept: a name, and a finite number or a text (null: none).
fn parse(v: &Value) -> Option<(String, Option<FieldValue>)> {
    let name: String = v.get("name")?.as_str()?.trim().chars().take(MAX_NAME).collect();
    if name.is_empty() {
        return None;
    }
    let value = match v.get("value") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => Some(FieldValue::Number(n.as_f64().filter(|x| x.is_finite())?)),
        Some(Value::String(s)) if !s.trim().is_empty() => Some(FieldValue::Text(s.trim().chars().take(MAX_TEXT).collect())),
        Some(Value::Bool(b)) => Some(FieldValue::Text(if *b { "Yes" } else { "No" }.into())),
        _ => None,
    };
    Some((name, value))
}

/// The fields of the info, with the values the quotes changed since: a name given again replaces its value in place,
/// a new one comes last, a null removes it.
fn merged(info: &[Value], live: &[(String, Option<FieldValue>)]) -> Vec<PluginField> {
    let mut out: Vec<(String, Option<FieldValue>)> = Vec::new();
    for (name, value) in info.iter().filter_map(parse).chain(live.iter().cloned()) {
        match out.iter_mut().find(|(n, _)| *n == name) {
            Some(slot) => slot.1 = value,
            None => out.push((name, value)),
        }
    }
    out.into_iter().filter_map(|(name, value)| Some(PluginField { name, value: value? })).take(MAX_FIELDS).collect()
}

/// A quote's `fields`: kept over the info's, and the windows told when they changed.
pub fn on_quote(app: &AppHandle, symbol: &str, fields: &[Value]) {
    let sent: Vec<(String, Option<FieldValue>)> = fields.iter().filter_map(parse).take(MAX_FIELDS).collect();
    if sent.is_empty() {
        return;
    }
    let changed = {
        let mut live = state(app).live.locked();
        let kept = live.entry(symbol.to_string()).or_default();
        let mut changed = false;
        for (name, value) in sent {
            match kept.iter().position(|(n, _)| *n == name) {
                Some(i) if kept[i].1 == value => {}
                Some(i) => {
                    kept[i].1 = value;
                    changed = true;
                }
                None if kept.len() < MAX_FIELDS => {
                    kept.push((name, value));
                    changed = true;
                }
                None => {}
            }
        }
        changed
    };
    if changed {
        let _ = PluginFieldsChanged { symbol: symbol.to_string() }.emit(app);
    }
}

/// The values the quotes of a plugin's exchanges (`prefixes`, "NSE:") brought: gone when it connects again.
pub fn forget(app: &AppHandle, prefixes: &[String]) {
    state(app).live.locked().retain(|sym, _| !prefixes.iter().any(|p| sym.starts_with(p)));
}

/// The fields of a plugin symbol; None for a symbol no plugin serves, or one with none.
#[tauri::command]
#[specta::specta]
pub async fn plugin_symbol_fields(app: AppHandle, symbol: String) -> Result<Option<PluginSymbolFields>, String> {
    let Some(r): Option<Route> = data::route(&app, &symbol) else { return Ok(None) };
    let info = data::info(&app, &r).await?;
    let live = state(&app).live.locked().get(&r.symbol).cloned().unwrap_or_default();
    let fields = merged(&info.fields, &live);
    if fields.is_empty() {
        return Ok(None);
    }
    let plugin_name = super::installed_manifest(&app, &r.plugin).map(|m| m.name).unwrap_or_else(|| r.plugin.clone());
    Ok(Some(PluginSymbolFields { plugin_name, fields }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_named_numbers_and_texts() {
        assert_eq!(parse(&json!({"name":" Upper circuit ","value":2950.5})), Some(("Upper circuit".into(), Some(FieldValue::Number(2950.5)))));
        assert_eq!(parse(&json!({"name":"Band","value":"20%"})), Some(("Band".into(), Some(FieldValue::Text("20%".into())))));
        assert_eq!(parse(&json!({"name":"Gone","value":null})), Some(("Gone".into(), None)));
        assert_eq!(parse(&json!({"name":"","value":1})), None);
        assert_eq!(parse(&json!({"value":1})), None);
    }

    #[test]
    fn quotes_change_the_info_values_in_place() {
        let info = vec![json!({"name":"Upper circuit","value":100}), json!({"name":"Lower circuit","value":80}), json!({"name":"Band","value":"10%"})];
        let live = vec![("Upper circuit".to_string(), Some(FieldValue::Number(110.0))), ("Band".to_string(), None), ("OI".to_string(), Some(FieldValue::Number(5.0)))];
        let out = merged(&info, &live);
        let names: Vec<(&str, &FieldValue)> = out.iter().map(|f| (f.name.as_str(), &f.value)).collect();
        assert_eq!(names, vec![("Upper circuit", &FieldValue::Number(110.0)), ("Lower circuit", &FieldValue::Number(80.0)), ("OI", &FieldValue::Number(5.0))]);
    }
}
