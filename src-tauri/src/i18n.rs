//! 后端文案最小目录（托盘 / 通知）。
//!
//! 只覆盖后端自己拼装、前端拿不到的字符串；界面文案一律由前端 vue-i18n 负责。
//! 语言以 `settings.json` 的 `language` 为权威，`system` 时按 `LANG` 粗判中英。

use tauri::AppHandle;

pub fn is_en(lang: &str) -> bool {
    lang == "en"
}

pub fn current(app: &AppHandle) -> &'static str {
    let language = crate::models::settings_load(app.clone()).language;
    match language.as_deref() {
        Some("en-US") => "en",
        Some("zh-CN") => "zh",
        _ => system_lang(),
    }
}

fn system_lang() -> &'static str {
    let raw = std::env::var("LC_ALL")
        .ok()
        .or_else(|| std::env::var("LANG").ok())
        .unwrap_or_default()
        .to_lowercase();
    if raw.starts_with("en") {
        "en"
    } else {
        "zh"
    }
}

/// 取一条静态目录文案；没有英文时回退中文原文。
pub fn tr(lang: &str, zh: &str, en: &str) -> String {
    if is_en(lang) {
        en.to_string()
    } else {
        zh.to_string()
    }
}
