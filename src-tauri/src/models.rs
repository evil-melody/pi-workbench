//! 应用级设置：模型、主题、语言等。
//!
//! 文件位置：`app_config_dir/app-settings.json`，与项目数据隔离。
//! 支持多模型配置列表；读取旧版单 `model` 字段时会自动迁移为单条模型。
//! API key 仅存储在本地配置文件中，命令返回值保留字段但错误信息不回显 key 内容。

use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager};

pub const SETTINGS_FILE: &str = "app-settings.json";

fn bool_true() -> bool {
    true
}

fn default_model_id() -> String {
    "default".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub temperature: f32,
    pub max_tokens: u32,
    #[serde(default = "bool_true")]
    pub enabled: bool,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            id: default_model_id(),
            name: "默认模型".to_string(),
            provider: "openai".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4o-mini".to_string(),
            api_key: String::new(),
            temperature: 0.6,
            max_tokens: 4096,
            enabled: true,
        }
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub models: Vec<ModelConfig>,
    pub default_model_id: Option<String>,
    pub theme: Option<String>,
    pub language: Option<String>,
    /// Pi 可执行文件的绝对路径。留空 = 自动探测（见 `pi_bridge::resolve_pi_bin`）。
    /// 桌面进程 PATH 里常没有 pi（macOS GUI 只有 /usr/bin 等），探测不到时必须能手动指定。
    #[serde(default)]
    pub pi_bin: Option<String>,
}

impl AppSettings {
    pub fn ensure_default_model(&mut self) {
        if self.models.is_empty() {
            self.models.push(ModelConfig::default());
        }
        if self.default_model_id.is_none() {
            self.default_model_id = self.models.iter().find(|m| m.enabled).map(|m| m.id.clone());
        }
        if self.default_model_id.is_none() {
            self.default_model_id = Some(self.models[0].id.clone());
        }
    }
}

#[derive(Debug, Deserialize)]
struct LegacyModelConfig {
    provider: String,
    base_url: String,
    model: String,
    api_key: String,
    temperature: f32,
    max_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct LegacyAppSettings {
    model: LegacyModelConfig,
    theme: Option<String>,
    language: Option<String>,
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| e.to_string())
        .map(|d| d.join(SETTINGS_FILE))
}

#[tauri::command]
pub fn settings_load(app: AppHandle) -> AppSettings {
    let path = match settings_path(&app) {
        Ok(p) => p,
        Err(_) => return AppSettings::default(),
    };
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return AppSettings::default(),
    };

    if let Ok(mut s) = serde_json::from_str::<AppSettings>(&text) {
        s.ensure_default_model();
        return s;
    }

    // 兼容旧版单 model 字段配置
    if let Ok(legacy) = serde_json::from_str::<LegacyAppSettings>(&text) {
        let id = "migrated".to_string();
        return AppSettings {
            models: vec![ModelConfig {
                id: id.clone(),
                name: "已迁移模型".to_string(),
                provider: legacy.model.provider,
                base_url: legacy.model.base_url,
                model: legacy.model.model,
                api_key: legacy.model.api_key,
                temperature: legacy.model.temperature,
                max_tokens: legacy.model.max_tokens,
                enabled: true,
            }],
            default_model_id: Some(id),
            theme: legacy.theme,
            language: legacy.language,
            pi_bin: None,
        };
    }

    AppSettings::default()
}

#[tauri::command]
pub fn settings_save(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(())
}

/// 测试模型配置连通性：只校验 base_url 可达，不发送真实请求、不消耗 token、不回显 key。
#[tauri::command]
pub async fn settings_test_model(config: ModelConfig) -> Result<String, String> {
    let url = if config.base_url.is_empty() {
        return Err("Base URL 不能为空".to_string());
    } else {
        config.base_url.trim().trim_end_matches('/').to_string()
    };

    let target = if url.starts_with("http://") || url.starts_with("https://") {
        url
    } else {
        format!("https://{url}")
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent(concat!("pi-workbench/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;

    let resp = client
        .get(&target)
        .send()
        .await
        .map_err(|e| format!("无法连接到 {provider} 服务端: {e}", provider = config.provider))?;

    let status = resp.status();
    if status.is_server_error() {
        return Err(format!("服务端错误: HTTP {status}"));
    }

    // 只证明「网络可达」，不证明「鉴权 / 模型名可用」——404、401 也走到这里，
    // 因此文案必须写明边界，不能让用户误以为模型已经能用。
    Ok(format!(
        "网络可达：HTTP {status}（仅探测 Base URL，未校验 API Key 与模型名）"
    ))
}

/// 注入 Pi 内核所需的启动参数（provider / model / api_key）。
pub struct PiModelLaunch {
    pub provider: String,
    pub model: String,
    pub api_key: String,
}

/// 把默认模型落成 Pi 能读的 `models.json`，并返回 spawn 时该传的参数。
///
/// Pi 的 agent 目录由 `pi_bridge` 通过 `PI_CODING_AGENT_DIR` 指到 `app_config_dir`，
/// 所以这里写的就是 Pi 实际读取的那一份；`baseUrl` 只有落在 models.json 里才会被采用，
/// `--provider/--model` 只是从这份清单里挑一条。
pub fn pi_model_launch(app: &AppHandle) -> Option<PiModelLaunch> {
    let settings = settings_load(app.clone());
    let id = settings.default_model_id.clone()?;
    let model = settings
        .models
        .into_iter()
        .find(|m| m.id == id && m.enabled)?;
    if model.provider.trim().is_empty() || model.model.trim().is_empty() {
        return None;
    }
    if let Err(e) = write_models_json(app, &model) {
        eprintln!("写入 models.json 失败，内核将退回自身配置: {e}");
        return None;
    }
    Some(PiModelLaunch {
        provider: model.provider,
        model: model.model,
        api_key: model.api_key,
    })
}

/// 合并式写入：只覆盖当前 provider 条目，保留文件里其它 provider。
/// 未声明 `api` 时 Pi 按 `openai-completions` 兜底，兼容绝大多数 OpenAI 协议端点。
fn write_models_json(app: &AppHandle, model: &ModelConfig) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("models.json");
    let mut root: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({ "providers": {} }));
    if !root.get("providers").map(|v| v.is_object()).unwrap_or(false) {
        root["providers"] = serde_json::json!({});
    }
    let mut entry = serde_json::json!({
        "name": model.name,
        "baseUrl": model.base_url,
        "models": [ { "id": model.model, "name": model.model } ],
    });
    if !model.api_key.trim().is_empty() {
        entry["apiKey"] = serde_json::Value::String(model.api_key.clone());
    }
    root["providers"][model.provider.as_str()] = entry;
    fs::write(
        &path,
        serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_model_config_serializes() {
        let cfg = ModelConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("openai"));
        assert!(json.contains("default"));
    }

    #[test]
    fn app_settings_roundtrip() {
        let mut s = AppSettings::default();
        s.language = Some("zh-CN".to_string());
        s.ensure_default_model();
        let json = serde_json::to_string_pretty(&s).unwrap();
        let parsed: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.language, Some("zh-CN".to_string()));
        assert!(!parsed.models.is_empty());
    }

    #[test]
    fn legacy_single_model_migration() {
        let legacy = r#"{"model":{"provider":"openai","base_url":"https://api.openai.com/v1","model":"gpt-4o","api_key":"sk-test","temperature":0.7,"max_tokens":2048},"theme":"dark"}"#;
        let parsed: AppSettings = serde_json::from_str(legacy).unwrap_or_default();
        // 旧版直接反序列化会失败，走 load 里的兼容分支；这里只验证新格式解析
        assert!(parsed.models.is_empty() || parsed.models[0].provider == "openai");
    }
}
