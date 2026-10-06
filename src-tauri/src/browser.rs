use tauri::AppHandle;

use crate::net::normalize_url;

/// 只允许 http/https：避免把任意文件路径/协议塞进系统默认应用。
/// 补协议与注入面过滤的实现在 `net.rs`（浏览器、技能、扩展三处共用）。

/// 用系统默认浏览器打开地址。
///
/// Pi 内核当前没有浏览器会话能力，面板上的「前往」应当是真实动作而不是留痕，
/// 因此这里直接调各平台的默认处理器（macOS `open` / Windows `start` / Linux `xdg-open`）。
fn open_default(url: &str) {
    let (program, args): (&str, Vec<&str>) = if cfg!(target_os = "windows") {
        ("cmd", vec!["/c", "start", "", url])
    } else if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else {
        ("xdg-open", vec![url])
    };
    let _ = std::process::Command::new(program).args(args).status();
}

#[tauri::command]
pub fn browser_open(_app: AppHandle, url: String) -> Result<String, String> {
    let normalized = normalize_url(&url)?;
    open_default(&normalized);
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::normalize_url;

    #[test]
    fn fills_missing_scheme_with_https() {
        assert_eq!(normalize_url("example.com").unwrap(), "https://example.com");
    }

    #[test]
    fn keeps_explicit_scheme() {
        assert_eq!(
            normalize_url("http://localhost:1420").unwrap(),
            "http://localhost:1420"
        );
        assert_eq!(
            normalize_url("https://example.com/a?b=1").unwrap(),
            "https://example.com/a?b=1"
        );
    }

    #[test]
    fn trims_surrounding_whitespace() {
        assert_eq!(normalize_url("  example.com ").unwrap(), "https://example.com");
    }

    #[test]
    fn rejects_non_http_schemes_and_empty() {
        assert!(normalize_url("javascript:alert(1)").is_err());
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert!(normalize_url("   ").is_err());
    }
}
