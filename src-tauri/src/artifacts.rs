//! 成果（Artifact）解析：从会话文本里找出被引用的文件，交给前端渲染成卡片。
//!
//! 设计约束：
//!   1. 路径安全一律复用 [`crate::fs::resolve`]，不另起一套边界判断——
//!      两套判定迟早会有一套漏，而漏的那套就是路径穿越。
//!   2. 「像不像一个成果」由结构化规则决定（是否存在、能否预览），
//!      不做任何关键词/意图判断。产物格式（html/md/json/svg/图片）按扩展名判定。
//!   3. 体积与类型都要设闸：二进制与超大文件直接拒，避免预览区卡死。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::fs::resolve;

/// 文本类预览的读取上限，超出部分截断并置 `truncated`。
const TEXT_LIMIT: u64 = 512 * 1024;
/// 图片转 base64 的上限，再大只给元信息不给内容。
const IMAGE_LIMIT: u64 = 4 * 1024 * 1024;
/// Office/PDF 是压缩包，无法按文本读；整体转 base64 交给前端解析器，
/// 上限单独设——10MB 级的 docx 在预览窗口里是常态。
const OFFICE_LIMIT: u64 = 12 * 1024 * 1024;

/// 判定为「未知二进制」的最大嗅探长度：这一段里出现 NUL 即判为二进制。
const NUL_SNIFF: usize = 2048;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub kind: &'static str,
    pub bytes: u64,
    pub lines: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactContent {
    pub path: String,
    pub kind: &'static str,
    /// 图片为 data URL，其余为文本。
    pub content: String,
    pub truncated: bool,
    pub total_bytes: u64,
}

/// `artifacts_scan` 的输入：一条会话文本及其归属 id。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSource {
    pub id: String,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub message_id: String,
    pub artifacts: Vec<Artifact>,
}

fn kind_of(ext: &str) -> &'static str {
    match ext {
        "html" | "htm" => "html",
        "md" | "markdown" => "markdown",
        "json" => "json",
        "svg" => "svg",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif" => "image",
        // Office 与 PDF 走字节流：前端解析器（docx-preview / SheetJS）需要原始 zip/pdf 字节。
        "docx" => "docx",
        "xlsx" => "xlsx",
        "pptx" => "pptx",
        "pdf" => "pdf",
        _ => "text",
    }
}

/// Office/PDF 需要整份字节，不适用文本截断。
fn is_stream_kind(kind: &str) -> bool {
    matches!(kind, "docx" | "xlsx" | "pptx" | "pdf")
}

/// 扩展名判定放在最后一个路径分隔符之后，避免 `a.b/c` 被误当成 `.c`。
fn split_ext(file_name: &str) -> (&str, &str) {
    let base = file_name.rsplit('/').next().unwrap_or(file_name);
    match base.rfind('.') {
        Some(0) | None => (base, ""),
        Some(i) => {
            let ext = &base[i + 1..];
            let is_ascii_ext = !ext.is_empty()
                && ext.len() <= 8
                && ext.chars().all(|c| c.is_ascii_alphanumeric());
            if is_ascii_ext {
                (&base[..i], ext)
            } else {
                (base, "")
            }
        }
    }
}

/// 把扫描出来的字符片段规整成候选路径。
///
/// .This 这类「以点开头的隐含文件」按扩展名规则处理；`~/` 展开到 home，
/// 因为用户描述里写 `~/Downloads/x.md` 是常态。
fn normalize_candidate(raw: &str) -> Option<String> {
    let s = raw.trim_matches(|c: char| {
        c.is_whitespace()
            || matches!(
                c,
                ',' | ';' | '"' | '\'' | '`' | '。' | '，' | '、' | '；' | '：' | '！' | '？' | '）' | '】' | '》'
            )
    });
    if s.is_empty() {
        return None;
    }
    // URL 与 scheme 一律跳过，否则 https://example.com/a.md 会被当成路径。
    if s.contains("://") {
        return None;
    }
    let s = s.trim_end_matches(|c: char| {
        matches!(
            c,
            '.' | ')' | ']' | '>' | ':' | '。' | '，' | '、' | '；' | '：' | '！' | '？' | '）' | '】' | '》'
        )
    });

    let expanded = match s.strip_prefix('~') {
        Some(rest) => {
            if rest.is_empty() || rest.starts_with('/') {
                let home = std::env::var("HOME").unwrap_or_default();
                if home.is_empty() {
                    return None;
                }
                format!("{home}{rest}")
            } else {
                return None;
            }
        }
        None => s.to_string(),
    };

    let (_, ext) = split_ext(&expanded);
    if ext.is_empty() {
        return None; // 目录或普通词，不是可预览成果
    }

    let is_drive = expanded
        .split_once(':')
        .is_some_and(|(a, _)| a.len() == 1 && a.chars().all(|c| c.is_ascii_alphabetic()));

    // 含斜杠即视为路径形态：内核输出里 `docs/report.md` 这类相对路径比重写绝对路径更常见，
    // 若只认 `/` 或 `./` 开头，这些成果会整片丢失。扩展名已在上一步验过，可据此区分普通词。
    let looks_like_path = expanded.starts_with('/')
        || expanded.starts_with("./")
        || expanded.starts_with("../")
        || expanded.starts_with(".\\")
        || expanded.contains('/')
        || is_drive;

    if !looks_like_path {
        return None;
    }
    Some(expanded)
}

/// 按空白与常见标点切出候选片段。
fn scan_candidates(text: &str) -> Vec<String> {
    // 中文标点必须进分隔符集合：内核输出多为“已完成 xxx.md 与 yyy.md 的迁移。”
    // 这样的中文句子，标点缺失会让整句粘连成一个 token，扩展名判定随之失效。
    const TERMINATORS: &[char] = &[
        ' ', '\t', '\n', '\r', '(', ')', '[', ']', '{', '}', '<', '>', '|', '\\',
        '。', '，', '、', '；', '：', '！', '？', '（', '）', '《', '》', '【', '】',
    ];
    let mut out: Vec<String> = Vec::new();
    let mut start: Option<usize> = None;

    for (i, ch) in text.char_indices() {
        if TERMINATORS.contains(&ch) {
            if let Some(s) = start.take() {
                if let Some(p) = normalize_candidate(&text[s..i]) {
                    out.push(p)
                }
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        if let Some(p) = normalize_candidate(&text[s..]) {
            out.push(p)
        }
    }
    out
}

/// 走 resolve 校验 + 元信息。同一文件被多种写法命中时由调用方按规范路径去重。
fn describe(root: &str, candidate: &str) -> Option<Artifact> {
    let abs: PathBuf = resolve(root, candidate).ok()?;
    let meta = fs::metadata(&abs).ok()?;
    if !meta.is_file() {
        return None;
    }
    let name = abs.file_name()?.to_string_lossy().into_owned();
    let ext = split_ext(&name).1.to_string();
    let kind = kind_of(&ext);
    let bytes = meta.len();
    let lines = count_lines(&abs).unwrap_or(0);
    Some(Artifact {
        path: abs.to_string_lossy().into_owned(),
        name,
        ext,
        kind,
        bytes,
        lines,
    })
}

fn count_lines(p: &std::path::Path) -> Option<u64> {
    let f = fs::File::open(p).ok()?;
    let r = std::io::BufReader::new(f);
    let mut n = 0u64;
    for l in std::io::BufRead::lines(r) {
        if l.is_err() {
            break;
        }
        n += 1;
    }
    Some(n)
}

/// 二进制兜底检查：读取片段里出现 NUL 即判为非文本。同时返回 base64。
fn encode_image(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > IMAGE_LIMIT as usize {
        return Err("图片过大（超过 4MB），不加载预览".into());
    }
    if bytes[..bytes.len().min(NUL_SNIFF)].contains(&0) {
        return Err("不支持预览二进制文件".into());
    }
    Ok(format!("data:image/png;base64,{}", base64_of(bytes)))
}

fn base64_of(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        let offs = [n >> 18, (n >> 12) & 63, (n >> 6) & 63, n & 63];
        for k in 0..4 {
            if k <= chunk.len() {
                out.push(T[offs[k] as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// 从多条会话文本里解析出成果。已存在的按规范路径去重，项目外的路径直接丢弃。
#[tauri::command]
pub fn artifacts_scan(
    root: String,
    sources: Vec<ScanSource>,
) -> Result<Vec<ScanResult>, String> {
    let mut results = Vec::new();
    for s in sources {
        let mut seen: Vec<String> = Vec::new();
        let mut artifacts: Vec<Artifact> = Vec::new();
        for cand in scan_candidates(&s.text) {
            let Some(a) = describe(&root, &cand) else {
                continue;
            };
            if seen.contains(&a.path) {
                continue;
            }
            seen.push(a.path.clone());
            artifacts.push(a);
        }
        if !artifacts.is_empty() {
            results.push(ScanResult {
                message_id: s.id,
                artifacts,
            });
        }
    }
    Ok(results)
}

/// 读取单个成果内容供预览。
#[tauri::command]
pub fn artifacts_read(
    root: String,
    path: String,
    max_bytes: Option<u64>,
) -> Result<ArtifactContent, String> {
    let abs = resolve(&root, &path)?;
    let meta = fs::metadata(&abs).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("不是文件".into());
    }
    let full = abs.to_string_lossy().into_owned();
    let (_, ext) = split_ext(&full);
    let kind = kind_of(ext);
    let bytes = fs::read(&abs).map_err(|e| e.to_string())?;

    if kind == "image" && meta.len() > IMAGE_LIMIT {
        return Err("图片过大（超过 4MB），不加载预览".into());
    }

    // Office/PDF：整份字节交给前端解析器。放在二进制嗅探之前，否则 zip 里的 NUL 会先把它拒掉。
    if is_stream_kind(kind) {
        if meta.len() > OFFICE_LIMIT {
            return Err(format!(
                "{ext} 文件过大（超过 {}MB），只提供「用外部应用打开」",
                OFFICE_LIMIT / 1024 / 1024
            ));
        }
        return Ok(ArtifactContent {
            path: full,
            kind,
            content: format!("data:application/octet-stream;base64,{}", base64_of(&bytes)),
            truncated: false,
            total_bytes: meta.len(),
        });
    }

    // 未知扩展名（.bin / .dat 等）在 kind 上落回 text，但内容必须嗅探过 NUL 才能当文本读；
    // 否则一个伪装成 .html 的二进制会直接冲进预览区。
    if kind != "image" && bytes[..bytes.len().min(NUL_SNIFF)].contains(&0) {
        return Err("不支持预览二进制文件".into());
    }

    let limit = max_bytes.unwrap_or(TEXT_LIMIT).min(TEXT_LIMIT);
    // 先按 limit 截断再处理，避免把超长文件整体读进内存。
    let (content, truncated) = if kind == "image" {
        (encode_image(&bytes)?, false)
    } else {
        let take = (limit as usize).min(bytes.len());
        let s = String::from_utf8_lossy(&bytes[..take]).into_owned();
        (s, bytes.len() > take)
    };

    Ok(ArtifactContent {
        path: abs.to_string_lossy().into_owned(),
        kind,
        content,
        truncated,
        total_bytes: meta.len(),
    })
}

/// 用系统默认应用打开成果。
///
/// 这里只校验文件存在，**不套项目内边界**：用户是主动点「用外部应用打开」的，
/// 再限制目标反而妨碍使用；自动抽取才需要 `resolve` 把关（见 artifacts_scan）。
#[tauri::command]
pub fn artifacts_open(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("文件不存在：{path}"));
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(&path, None::<String>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例独立目录：cargo test 默认并发跑，共用目录会互相删除产物。
    fn tmpproj(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("piwb-artifacts-{tag}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("docs")).unwrap();
        fs::write(d.join("report.html"), "<h1>hi</h1>").unwrap();
        fs::write(d.join("README.md"), "line1\nline2\nline3\n").unwrap();
        fs::write(d.join("data.json"), "{\"a\":1}").unwrap();
        fs::write(d.join("docs").join("nested.txt"), "x".repeat(3000)).unwrap();
        let bytes = [0u8; 16];
        fs::write(d.join("blob.bin"), bytes).unwrap();
        d
    }

    #[test]
    fn extracts_absolute_and_relative_paths() {
        let d = tmpproj("absrel");
        let root = d.to_string_lossy().to_string();
        let text = format!(
            "已完成 {}/README.md 与 docs/nested.txt 的迁移。",
            root
        );
        let got = scan_candidates(&text)
            .iter()
            .filter_map(|c| describe(&root, c))
            .collect::<Vec<_>>();
        let names: Vec<&str> = got.iter().map(|a| a.name.as_str()).collect();
        assert!(names.contains(&"README.md"), "绝对路径应命中：{names:?}");
        assert!(names.contains(&"nested.txt"), "相对路径应命中：{names:?}");
    }

    #[test]
    fn skips_urls_and_bare_words() {
        let d = tmpproj("url");
        let root = d.to_string_lossy().to_string();
        let text = "参考 https://example.com/a.md 以及 read、bash 这两个工具";
        let got = scan_candidates(text)
            .into_iter()
            .filter_map(|c| describe(&root, &c))
            .collect::<Vec<_>>();
        assert!(got.is_empty(), "不应命中 URL 或普通词：{got:?}");
    }

    #[test]
    fn drops_paths_outside_project() {
        let d = tmpproj("outside");
        let root = d.to_string_lossy().to_string();
        let text = "/etc/hosts /tmp/should-be-dropped.md";
        let got = scan_candidates(text)
            .into_iter()
            .filter_map(|c| describe(&root, &c))
            .collect::<Vec<_>>();
        assert!(got.is_empty(), "项目外路径必须被拦下：{got:?}");
    }

    #[test]
    fn dedups_same_file_different_spellings() {
        let d = tmpproj("dedup");
        let root = d.to_string_lossy().to_string();
        let text = format!("写好了 {}/README.md，顺手改了 README.md", root);
        let res = artifacts_scan(root, vec![ScanSource { id: "m1".into(), text }]).unwrap();
        let artifacts = &res[0].artifacts;
        assert_eq!(artifacts.len(), 1, "同一文件的两种写法应去重");
        assert_eq!(artifacts[0].name, "README.md");
    }

    #[test]
    fn classifies_kind_by_extension() {
        assert_eq!(kind_of("html"), "html");
        assert_eq!(kind_of("md"), "markdown");
        assert_eq!(kind_of("json"), "json");
        assert_eq!(kind_of("svg"), "svg");
        assert_eq!(kind_of("png"), "image");
        assert_eq!(kind_of("rs"), "text");
    }

    #[test]
    fn classifies_office_kinds_by_extension() {
        assert_eq!(kind_of("docx"), "docx");
        assert_eq!(kind_of("xlsx"), "xlsx");
        assert_eq!(kind_of("pptx"), "pptx");
        assert_eq!(kind_of("pdf"), "pdf");
    }

    /// Office 是 zip，内含 NUL；若先做二进制嗅探就会被整类拒掉。
    #[test]
    fn office_files_stream_as_base64_instead_of_binary_rejection() {
        let d = tmpproj("office");
        let root = d.to_string_lossy().to_string();
        // 一个含 NUL 字节的「伪 docx」，用来验证流分支先于二进制拒绝生效。
        fs::write(d.join("report.docx"), [0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]).unwrap();
        let c = artifacts_read(root.clone(), format!("{}/report.docx", root), None).unwrap();
        assert_eq!(c.kind, "docx");
        assert!(
            c.content.starts_with("data:application/octet-stream;base64,"),
            "Office 应走字节流：{}",
            &c.content[..40]
        );
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn truncates_large_text_and_flags_it() {
        let d = tmpproj("trunc");
        fs::write(d.join("huge.txt"), "y".repeat(600 * 1024)).unwrap();
        let root = d.to_string_lossy().to_string();
        let c = artifacts_read(root.clone(), format!("{}/huge.txt", root), None).unwrap();
        assert!(c.truncated, "超过 512KB 必须标记截断");
        assert!(c.total_bytes > 512 * 1024, "原文件大小应如实上报");
        assert!(c.content.len() <= 512 * 1024, "内容不应超过上限");
    }

    #[test]
    fn rejects_binary_preview() {
        let d = tmpproj("bin");
        let root = d.to_string_lossy().to_string();
        let err = artifacts_read(root.clone(), format!("{}/blob.bin", root), None);
        assert!(err.is_err(), "二进制应拒绝预览");
    }

    #[test]
    fn images_render_as_data_url() {
        let d = tmpproj("img");
        fs::write(d.join("shot.png"), vec![137u8, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]).unwrap();
        let root = d.to_string_lossy().to_string();
        let c = artifacts_read(root.clone(), format!("{}/shot.png", root), None).unwrap();
        assert_eq!(c.kind, "image");
        assert!(c.content.starts_with("data:image/png;base64,"), "图片应为 data URL");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn blocks_path_traversal() {
        let d = tmpproj("traversal");
        let root = d.to_string_lossy().to_string();
        let res = artifacts_scan(
            root,
            vec![ScanSource {
                id: "m1".into(),
                text: "../../../../etc/passwd".into(),
            }],
        )
        .unwrap();
        assert!(res.is_empty(), "越界路径不得产出成果");
        let _ = fs::remove_dir_all(&d);
    }
}
