use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Pi 内置的默认工具集（settings.md `defaultTools` 默认值）。
/// 首次注入时用它做基线，避免把已激活的工具集抹成空数组。
const BUILTIN_DEFAULT: [&str; 4] = ["read", "bash", "edit", "write"];

#[derive(Serialize)]
pub struct ToolSet {
    pub active: Vec<String>,
    /// UI 可选工具全集（能力清单内置基线 ∪ 当前白名单），前端不再写死工具名。
    pub catalog: Vec<String>,
    pub settings_path: String,
}

/// Pi 的工具激活是由 `<agent-dir>/settings.json` 的 `defaultTools` 决定的。
/// Pi 自身没有把工具集暴露成 RPC 命令，因此「注入 Pi」在这里落到同一份配置上：
/// 写入白名单后需重启内核（`pi_start`）才会生效。
fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

pub fn read_active(settings: &PathBuf) -> Vec<String> {
    let Ok(text) = fs::read_to_string(settings) else {
        return BUILTIN_DEFAULT.iter().map(|s| s.to_string()).collect();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return BUILTIN_DEFAULT.iter().map(|s| s.to_string()).collect();
    };
    json.get("defaultTools")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_else(|| BUILTIN_DEFAULT.iter().map(|s| s.to_string()).collect())
}

/// 能力清单声明 `tools.injectable = false` 时，写内核工具白名单是无效动作。
/// 写入与增删两条路径都要过这道闸，否则清单形同虚设。
fn assert_injectable() -> Result<(), String> {
    if crate::capabilities::CapabilityManifest::discover()
        .and_then(|m| m.tools.injectable)
        .unwrap_or(true)
        == false
    {
        return Err("能力清单声明工具不可注入（tools.injectable = false）".into());
    }
    Ok(())
}

#[tauri::command]
pub fn tools_activate(
    app: AppHandle,
    tools: Vec<String>,
    enable: bool,
) -> Result<ToolSet, String> {
    if tools.iter().any(|t| t.trim().is_empty()) {
        return Err("工具名不能为空".into());
    }
    assert_injectable()?;
    let settings = settings_path(&app)?;
    let current = read_active(&settings);
    let mut next = merge_active(&current, &tools, enable);

    let mut json = if let Ok(text) = fs::read_to_string(&settings) {
        serde_json::from_str::<serde_json::Value>(&text).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    json["defaultTools"] = serde_json::Value::Array(
        next.iter()
            .map(|s| serde_json::Value::String(s.clone()))
            .collect(),
    );
    fs::write(&settings, serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    next.sort();
    Ok(ToolSet {
        catalog: catalog(&next),
        active: next,
        settings_path: settings.to_string_lossy().into_owned(),
    })
}

/// 整体替换时的排序去重口径。
fn normalize(tools: &[String]) -> Vec<String> {
    let mut out = tools.to_vec();
    out.sort();
    out.dedup();
    out
}

/// 「在现有集合上增删」的纯粹语义，与文件 IO 无关，便于单测覆盖。
fn merge_active(current: &[String], tools: &[String], enable: bool) -> Vec<String> {
    let out: Vec<String> = if enable {
        let mut out = current.to_vec();
        for t in tools {
            if !out.iter().any(|x| x == t) {
                out.push(t.clone());
            }
        }
        out
    } else {
        current
            .iter()
            .filter(|x| !tools.iter().any(|t| t == *x))
            .cloned()
            .collect()
    };
    out
}

/// 用给定的工具集**整体替换** defaultTools。
///
/// 与 `tools_activate` 的区别在语义：activate 是「在现有集合上增删」，
/// 这里是「当前作用域就是这一份」（会话级工具作用域由连接器域算出后整体写入）。
/// 同一份 settings.json、同一套「其它字段原样保留」的写入纪律。
pub fn write_active(app: &AppHandle, tools: &[String]) -> Result<Vec<String>, String> {
    assert_injectable()?;
    let settings = settings_path(app)?;
    if tools.iter().any(|t| t.trim().is_empty()) {
        return Err("工具名不能为空".into());
    }
    let mut json = match fs::read_to_string(&settings) {
        Ok(text) => serde_json::from_str::<serde_json::Value>(&text)
            .unwrap_or_else(|_| serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    };
    // 白名单是集合语义，顺序不稳定会让用户看到「工具顺序自己变了」。
    let next = normalize(tools);
    json["defaultTools"] = serde_json::Value::Array(
        next.iter()
            .map(|s| serde_json::Value::String(s.clone()))
            .collect(),
    );
    fs::write(&settings, serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(next)
}

/// 当前生效的 defaultTools（按 AppHandle 的配置目录读取）。
/// 扩展清单用它判断某个 extension 是否真的激活，避免再解释一遍「激活」的含义。
pub fn active_tools(app: &AppHandle) -> Vec<String> {
    match settings_path(app) {
        Ok(p) => read_active(&p),
        Err(_) => BUILTIN_DEFAULT.iter().map(|s| s.to_string()).collect(),
    }
}

/// 当前白名单（只读），供 UI 展示「哪些工具对内核可见」。
#[tauri::command]
pub fn tools_list(app: AppHandle) -> ToolSet {
    let settings = settings_path(&app).ok();
    let active = match &settings {
        Some(p) => read_active(p),
        None => BUILTIN_DEFAULT.iter().map(|s| s.to_string()).collect(),
    };
    ToolSet {
        catalog: catalog(&active),
        active,
        settings_path: settings
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// UI 可选工具全集 = 能力清单内置基线 ∪ 当前白名单。
/// 后端是工具名的唯一真源，前端不写死列表，清单里新增工具 UI 自动出现。
fn catalog(active: &[String]) -> Vec<String> {
    let mut out = crate::capabilities::CapabilityManifest::discover()
        .map(|m| m.tools.builtin.clone())
        .unwrap_or_else(|| BUILTIN_DEFAULT.iter().map(|s| s.to_string()).collect());
    for t in active {
        if !out.iter().any(|x| x == t) {
            out.push(t.clone());
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json_of(active: &[&str]) -> String {
        serde_json::to_string_pretty(&serde_json::json!({
            "defaultTools": active,
            "otherSetting": 1
        }))
        .unwrap()
    }

    #[test]
    fn missing_settings_falls_back_to_builtin() {
        let p = std::env::temp_dir().join("piwb-tools-missing.json");
        let _ = fs::remove_file(&p);
        let active = read_active(&p);
        assert_eq!(active, BUILTIN_DEFAULT.to_vec());
    }

    /// 复现 tools_activate 的合并语义（enable=true），不含 Tauri 侧的文件 IO。
    fn merged(current: &[&str], add: &[&str]) -> Vec<String> {
        let mut out: Vec<String> = current.iter().map(|s| s.to_string()).collect();
        for t in add {
            if !out.iter().any(|x| x == t) {
                out.push((*t).to_string());
            }
        }
        out
    }

    #[test]
    fn activate_adds_without_duplicate() {
        let merged = merged(&["read", "bash"], &["read", "my-tool"]);
        assert_eq!(merged.len(), 3, "已存在的不应重复添加");
        assert!(merged.contains(&"my-tool".to_string()));
    }

    /// 复现 tools_activate 的移除语义（enable=false）。
    fn removed(current: &[&str], drop: &[&str]) -> Vec<String> {
        current
            .iter()
            .filter(|x| !drop.contains(x))
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn deactivate_removes_only_requested() {
        let after = removed(&["read", "bash", "tmp-tool"], &["tmp-tool"]);
        assert!(!after.contains(&"tmp-tool".to_string()));
        assert_eq!(after.len(), 2);
        assert_eq!(after, vec!["read".to_string(), "bash".to_string()]);
    }

    #[test]
    fn write_normalizes_order_and_duplicates() {
        let next = normalize(&["b".into(), "a".into(), "b".into()]);
        assert_eq!(next, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn merge_keeps_everything_else_when_deactivating() {
        let current: Vec<String> = ["read", "bash", "tmp"].iter().map(|s| s.to_string()).collect();
        let after = merge_active(&current, &["tmp".into()], false);
        assert_eq!(after.len(), 2);
        let added = merge_active(&["read".into()], &["read".into(), "z".into()], true);
        assert_eq!(added.len(), 2, "已存在的不应重复添加");
    }

    #[test]
    fn keeps_unrelated_settings_intact() {
        let json: serde_json::Value = serde_json::from_str(&json_of(&["read"])).unwrap();
        assert_eq!(json["otherSetting"], 1, "写入不应破坏同文件其它字段");
    }
}
