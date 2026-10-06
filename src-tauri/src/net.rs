//! 出网的最小公共件：地址校验 + 文本下载。
//!
//! 三处需要「把用户给的字符串变成可信 URL」：浏览器「前往」、技能远端安装、扩展远端安装。
//! 与其各写一份（下一处就会漏掉 CRLF 这类注入面），统一收在这里。
//!
//! 安全边界：只放行 http/https；地址里出现控制字符或空白一律拒绝——
//! CRLF 会把请求行拆成两行，进而伪造请求头。

use std::time::Duration;

/// 下载上限：1 MiB。超过即拒，避免一个巨大的响应把内存吃干。
pub const FETCH_LIMIT: usize = 1 << 20;

/// 浏览器语义：无 scheme 时补 `https://`，有 scheme 时只放行 http/https。
/// 面板上的地址框允许用户输入 `example.com`，因此保留「补协议」这一步。
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("地址为空".to_string());
    }
    // 先判 scheme 再补 "://"：否则 "javascript:x" 会被补成 "https://javascript:x" 绕过校验。
    if has_forbidden_char(trimmed) {
        return Err("地址含非法字符（控制字符或空白）".to_string());
    }
    if let Some((scheme, rest)) = trimmed.split_once(':') {
        let lower = scheme.to_ascii_lowercase();
        if lower == "http" || lower == "https" {
            if rest.starts_with("//") && !rest.trim_start_matches('/').is_empty() {
                return Ok(trimmed.to_string());
            }
        }
        return Err(format!("只支持 http/https 地址，收到：{trimmed}"));
    }
    Ok(format!("https://{trimmed}"))
}

/// 安装语义：必须显式带 http/https，不补协议。
/// 下载 SKILL.md / 扩展源码时「补一个协议」只会让误填的地址变成合法的攻击面。
pub fn require_http_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return Err("地址需以 http:// 或 https:// 开头".to_string());
    };
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(format!("只支持 http/https 地址，收到：{scheme}://"));
    }
    if rest.is_empty() {
        return Err("地址为空".to_string());
    }
    if has_forbidden_char(rest) {
        return Err("地址含非法字符（控制字符或空白）".to_string());
    }
    Ok(trimmed.to_string())
}

/// 控制字符与空白：CR/LF 会伪造请求头，其余空白会让解析口径随服务端漂移。
fn has_forbidden_char(text: &str) -> bool {
    text.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// 下载 URL 并转文本。只负责「取回 + 限额」，内容合法性由调用方各自校验。
pub async fn fetch_text(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("pi-workbench/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("下载失败：服务端返回 HTTP {status}"));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    if bytes.len() > FETCH_LIMIT {
        return Err(format!(
            "内容过大：{} 字节，超过上限 {} 字节",
            bytes.len(),
            FETCH_LIMIT
        ));
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "下载的不是 UTF-8 文本".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_fills_missing_scheme_with_https() {
        assert_eq!(normalize_url("example.com").unwrap(), "https://example.com");
        assert_eq!(normalize_url("  example.com ").unwrap(), "https://example.com");
    }

    #[test]
    fn normalize_keeps_explicit_scheme() {
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
    fn normalize_rejects_non_http_schemes_and_empty() {
        assert!(normalize_url("javascript:alert(1)").is_err());
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert!(normalize_url("   ").is_err());
    }

    #[test]
    fn require_http_url_accepts_only_explicit_http_schemes() {
        assert_eq!(
            require_http_url("  https://example.com/s.md  ").unwrap(),
            "https://example.com/s.md"
        );
        assert_eq!(
            require_http_url("HTTPS://example.com/s.md").unwrap(),
            "HTTPS://example.com/s.md"
        );
        assert!(require_http_url("example.com/s.md").is_err(), "无 scheme 必须被拒");
        assert!(require_http_url("javascript:alert(1)").is_err());
        assert!(require_http_url("file:///etc/passwd").is_err());
        assert!(require_http_url("ftp://example.com/a").is_err());
        assert!(require_http_url("http://").is_err(), "scheme 后为空必须被拒");
    }

    #[test]
    fn both_reject_crlf_and_whitespace_injection() {
        for bad in [
            "https://example.com/a\nX-Evil: 1",
            "https://example.com/a\r\nX: y",
            "https://exa mple.com/a.md",
        ] {
            assert!(require_http_url(bad).is_err(), "安装侧必须拒：{bad}");
            assert!(normalize_url(bad).is_err(), "浏览器侧必须拒：{bad}");
        }
    }
}
