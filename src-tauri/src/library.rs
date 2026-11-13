//! 资料库域。
//!
//! 这一层只回答三件事：**这条资料是什么**（类型 / 目录 / 修订）、
//! **现在能不能读**（启用与否）、**能不能被搜到**（转换出的检索文本）。
//! 正文就放在资料库目录里，不另开存储，避免「库里记的」和「磁盘上的」两套事实。
//!
//! 五条不能打折扣的语义：
//!   1. **原件永远保留**：转换失败只标记为「不可搜索 + 转换失败」，不删不改原件；
//!   2. **停用立即生效**：停用的资产任何正文读取都被拒，历史任务引用也一样拒；
//!   3. **修订是资产的一部分**：每次写入留快照，可列出、可回滚；
//!   4. **检索文本是产物不是源**：删资产时一起删，重建时按原件重新转换；
//!   5. **新建即草稿**：草稿不进检索，必须先显式发布。
//!
//! 路径安全的口径与 `crate::fs` 一致：**路径一律由后端拼**，
//! 前端只能给「相对目录」这种已净化的形状，不接受绝对路径。
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

const STORE_FILE: &str = "library.json";
/// 单文件上限（单文件 50 MiB）。
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// 资料库合计上限（合计 5 GiB）。
const MAX_TOTAL_BYTES: u64 = 5 * 1024 * 1024 * 1024;
/// 每个资产保留的修订快照数，超出丢最旧。
const MAX_REVISIONS: usize = 20;
const NAME_MAX: usize = 120;
const PATH_MAX: usize = 512;
const HIT_LIMIT: usize = 100;
/// 检索文本的单资产上限，避免一份巨型 PDF 拖垮搜索。
const SEARCH_TEXT_LIMIT: usize = 512 * 1024;
/// 正文读取上限：超出的给截断标记，而不是把几十 MiB 塞进前端。
const BODY_LIMIT: u64 = 512 * 1024;
/// 这两个目录是产物（检索文本 / 修订快照），不能出现在目录树里。
const INDEX_DIR: &str = ".index";
const REVISION_DIR: &str = ".revisions";

// ── 领域模型 ──────────────────────────────────────────────────

/// 资产类型由扩展名推断，决定走哪条转换通道。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssetKind {
    /// Markdown：草稿发布的主通道，正文即检索文本。
    #[default]
    Markdown,
    /// 纯文本。
    Text,
    /// HTML：去标签后检索，原件仍按 HTML 存。
    Html,
    /// PDF：正文多在压缩流里，只有未压缩的那部分能提出来。
    Pdf,
    /// Word：zip 容器，本构建不含解码器 → 不可搜索。
    Docx,
    /// 幻灯片：同上。
    Pptx,
    /// 其它：一律不注册转换器。
    Other,
}

impl AssetKind {
    pub fn of_name(name: &str) -> Self {
        let dot = name.rfind('.').unwrap_or(0);
        let ext = name[dot.min(name.len())..].to_ascii_lowercase();
        match ext.as_str() {
            ".md" | ".markdown" | ".mdx" => AssetKind::Markdown,
            ".txt" | ".log" | ".ini" | ".json" | ".csv" => AssetKind::Text,
            ".html" | ".htm" | ".svg" => AssetKind::Html,
            ".pdf" => AssetKind::Pdf,
            ".docx" | ".doc" => AssetKind::Docx,
            ".pptx" | ".ppt" => AssetKind::Pptx,
            _ => AssetKind::Other,
        }
    }

    /// 是否按文本读写。二进制类型不进正文通道，走「系统应用打开」。
    pub fn is_textual(self) -> bool {
        matches!(
            self,
            AssetKind::Markdown | AssetKind::Text | AssetKind::Html
        )
    }

    /// 界面上的类型文案，同时用于「这个格式不能按文本读」的错误提示。
    pub fn label(self) -> &'static str {
        match self {
            AssetKind::Markdown => "markdown",
            AssetKind::Text => "text",
            AssetKind::Html => "html",
            AssetKind::Pdf => "pdf",
            AssetKind::Docx => "docx",
            AssetKind::Pptx => "pptx",
            AssetKind::Other => "other",
        }
    }
}

/// 资料从哪来：界面上直接显示这一条，比让用户猜「这文件哪来的」有用。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AssetOrigin {
    /// created / imported / written / draft-published / rollback
    pub kind: String,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAsset {
    pub id: String,
    pub name: String,
    /// 相对资料库根目录的路径，如 `docs/report.md`；根级就是文件名。
    pub rel_path: String,
    pub kind: AssetKind,
    pub size: u64,
    /// 停用即封锁正文：这是「停用」唯一的实际效果，也是它存在的理由。
    pub enabled: bool,
    /// 转换是否成功。false 时 `convert_error` 一定非空，原件仍完好。
    pub searchable: bool,
    pub convert_error: Option<String>,
    pub revision: u64,
    /// 草稿未发布：不进检索、不可被任务引用，必须先 publish。
    pub draft: bool,
    pub origin: AssetOrigin,
    /// 正文 sha256：自动归档按内容去重，路径改名不算新内容。
    /// 旧数据可能为空，`load_store` 会按原件补齐。
    #[serde(default)]
    pub content_hash: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LibraryRevision {
    /// 归属资产：修订表是全局的，不带这个字段就没法知道哪条属于谁。
    /// 旧版本按 camelCase 写盘，`alias` 保证老 library.json 还能读。
    #[serde(alias = "assetId")]
    pub asset_id: String,
    pub rev: u64,
    pub at: u64,
    pub size: u64,
}

#[derive(Clone, Serialize)]
pub struct LibraryAssetView {
    pub id: String,
    pub name: String,
    pub rel_path: String,
    /// 所在目录，根级为 `/`。
    pub dir: String,
    pub kind: AssetKind,
    pub size: u64,
    pub enabled: bool,
    pub searchable: bool,
    pub convert_error: Option<String>,
    pub revision: u64,
    pub draft: bool,
    pub origin: AssetOrigin,
    pub updated_at: u64,
}

impl LibraryAssetView {
    pub fn of(asset: &LibraryAsset) -> Self {
        LibraryAssetView {
            id: asset.id.clone(),
            name: asset.name.clone(),
            rel_path: asset.rel_path.clone(),
            dir: dir_of(&asset.rel_path),
            kind: asset.kind,
            size: asset.size,
            enabled: asset.enabled,
            searchable: asset.searchable,
            convert_error: asset.convert_error.clone(),
            revision: asset.revision,
            draft: asset.draft,
            origin: asset.origin.clone(),
            updated_at: asset.updated_at,
        }
    }
}

/// 目录树节点：磁盘上的目录 + 已登记为资产的文件。
#[derive(Clone, Serialize)]
pub struct LibraryNode {
    pub name: String,
    /// 相对根的路径；根为 `/`。
    pub path: String,
    pub is_dir: bool,
    /// 该条目是否已在资产表里登记。
    pub asset_id: Option<String>,
    pub size: u64,
    pub children: Vec<LibraryNode>,
}

/// 命中结果。四项元信息（目录 / 类型 / 来源 / 修订）与位置一起给出来，
/// 否则用户看到一条命中却不知道该去哪找。
#[derive(Clone, Serialize)]
pub struct LibraryHit {
    pub asset_id: String,
    pub name: String,
    pub dir: String,
    pub kind: AssetKind,
    pub origin: AssetOrigin,
    pub revision: u64,
    pub size: u64,
    /// ready=可检索，failed=转换失败（原件保留），skipped=未转换。
    pub convert_status: &'static str,
    /// 「第 3 段」这类位置，随资产类型而定。
    pub location: Option<String>,
    pub snippet: String,
    pub score: usize,
}

#[derive(Clone, Serialize)]
pub struct LibraryContent {
    pub content: String,
    pub truncated: bool,
    pub total_bytes: u64,
}

#[derive(Clone, Serialize)]
pub struct LibraryStats {
    pub asset_count: usize,
    pub used_bytes: u64,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStore {
    #[serde(default)]
    pub assets: Vec<LibraryAsset>,
    #[serde(default)]
    pub revisions: Vec<LibraryRevision>,
    /// 最近打开 / 最近写入记的是资产 id 而不是路径：
    /// 路径会随移动和改名失效，id 不会。
    #[serde(default)]
    pub recent: Vec<String>,
    #[serde(default)]
    pub written: Vec<String>,
    /// 自动归档失败的批次：保留待归档的源路径，用户可在界面重试。
    #[serde(default)]
    pub archive_failures: Vec<ArchiveFailure>,
}

/// 一批归档失败的原因。只记源路径，不复制原件：
/// 源文件被删掉后重试会继续失败，这正是界面要显示的事实。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ArchiveFailure {
    pub id: String,
    #[serde(alias = "sessionId")]
    pub session_id: String,
    #[serde(alias = "sessionTitle")]
    pub session_title: String,
    /// 归档目录的日期段，重试时沿用原批次，不再按重试当天分目录。
    pub date: String,
    pub paths: Vec<String>,
    pub error: String,
    pub at: u64,
}

// ── 存储 ──────────────────────────────────────────────────────

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let file = dir.join(STORE_FILE);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(file)
}

pub fn load_store(app: &AppHandle) -> LibraryStore {
    let Ok(p) = store_path(app) else {
        return LibraryStore::default();
    };
    let Ok(text) = fs::read_to_string(&p) else {
        return LibraryStore::default();
    };
    let mut store = serde_json::from_str::<LibraryStore>(&text).unwrap_or_default();
    if let Ok(root) = library_root(app) {
        backfill_hashes(&root, &mut store);
    }
    store
}

/// 旧版本没有 content_hash：启动时按原件补一遍，去重才能覆盖历史资产。
/// 读不到原件的保持为空，下次归档时不会误判为「内容已存在」。
fn backfill_hashes(root: &Path, store: &mut LibraryStore) {
    for asset in store.assets.iter_mut().filter(|a| a.content_hash.is_empty()) {
        if let Ok(hash) = hash_file(&asset_path(root, &asset.rel_path)) {
            asset.content_hash = hash;
        }
    }
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// 按字节流式算 sha256：64 KiB 分块，50 MiB 的图片也不会整块进内存。
fn hash_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn save_store(app: &AppHandle, store: &LibraryStore) -> Result<(), String> {
    let p = store_path(app)?;
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    // 先写同目录临时文件再原子替换：直接覆盖时进程中断会留下半截 JSON，
    // load_store 只能回退空库，等于把整本资产表丢掉。
    let tmp = p.with_file_name(format!("{STORE_FILE}.tmp"));
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn total_bytes(assets: &[LibraryAsset]) -> u64 {
    assets.iter().map(|a| a.size).sum()
}

fn assert_quota(store: &LibraryStore, adding: u64) -> Result<(), String> {
    if adding > MAX_FILE_BYTES {
        return Err(format!(
            "library/file-too-large（单文件上限 {} MiB）",
            MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    if total_bytes(&store.assets) + adding > MAX_TOTAL_BYTES {
        return Err(format!(
            "library/quotas-exceeded（合计上限 {} GiB）",
            MAX_TOTAL_BYTES / 1024 / 1024 / 1024
        ));
    }
    Ok(())
}

/// 覆盖已有正文时的配额判定：旧大小要先从占用里扣掉，
/// 否则编辑已有文件会把同一份大小算两遍，接近上限时被误拒。
fn assert_replace_quota(store: &LibraryStore, old: u64, new: u64) -> Result<(), String> {
    if new > MAX_FILE_BYTES {
        return Err(format!(
            "library/file-too-large（单文件上限 {} MiB）",
            MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    let projected = total_bytes(&store.assets).saturating_sub(old) + new;
    if projected > MAX_TOTAL_BYTES {
        return Err(format!(
            "library/quotas-exceeded（合计上限 {} GiB）",
            MAX_TOTAL_BYTES / 1024 / 1024 / 1024
        ));
    }
    Ok(())
}

// ── 路径 ──────────────────────────────────────────────────────

/// 只放行「不会破坏路径结构」的字符：允许中文等 Unicode 文件名，但拒绝
/// 控制字符与反斜杠；空段、`.`、`..` 一律拦下。
///
/// 目录参数来自前端，这里是唯一边界：一旦放宽，
/// 前端给一个 `../../` 就能把资料库外的文件登记成资产。
fn validate_rel(rel: &str) -> Result<String, String> {
    if rel.len() > PATH_MAX {
        return Err("library/path-too-long".into());
    }
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err("library/path-invalid".into());
        }
        if !seg
            .chars()
            .all(|c| !c.is_control() && c != '/' && c != '\\')
        {
            return Err("library/path-invalid".into());
        }
    }
    Ok(rel.to_string())
}

/// 文件名与目录名共用：不允许路径分隔、不允许以点开头（隐藏文件不当资产）。
fn validate_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("library/name-required".into());
    }
    if name.len() > NAME_MAX {
        return Err("library/name-too-long".into());
    }
    if name.starts_with('.') || name.contains('/') || name.contains('\\') {
        return Err("library/name-invalid".into());
    }
    if name.chars().any(|c| c.is_control()) {
        return Err("library/name-invalid".into());
    }
    Ok(name.to_string())
}

fn join_rel(dir: &str, name: &str) -> Result<String, String> {
    let base = if dir.is_empty() || dir == "/" {
        String::new()
    } else {
        validate_rel(dir.trim_matches('/'))?
    };
    Ok(if base.is_empty() {
        name.to_string()
    } else {
        format!("{base}/{name}")
    })
}

/// 资产所在目录，根级为 `/`。
fn dir_of(rel_path: &str) -> String {
    match rel_path.rfind('/') {
        Some(i) => format!("/{}", &rel_path[..i]),
        None => "/".to_string(),
    }
}

fn library_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let root = dir.join("library");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    fs::create_dir_all(root.join(INDEX_DIR)).map_err(|e| e.to_string())?;
    fs::create_dir_all(root.join(REVISION_DIR)).map_err(|e| e.to_string())?;
    Ok(root)
}

fn asset_path(root: &Path, rel: &str) -> PathBuf {
    root.join(rel)
}

fn search_path(root: &Path, id: &str) -> PathBuf {
    root.join(INDEX_DIR).join(format!("{id}.txt"))
}

fn revision_dir(root: &Path, id: &str) -> PathBuf {
    root.join(REVISION_DIR).join(id)
}

fn revision_path(root: &Path, id: &str, rev: u64) -> PathBuf {
    revision_dir(root, id).join(format!("{rev}.txt"))
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

// ── 转换器 ────────────────────────────────────────────────────

/// 装进 zip 的格式没有解码器就是没有，编一个「部分支持」只会让原件更难找。
fn no_converter_error(kind: AssetKind) -> String {
    match kind {
        AssetKind::Docx | AssetKind::Pptx => "正文在 zip 容器内，本构建未编入 zip 解码器".into(),
        _ => "该类型未注册转换器".into(),
    }
}

/// 把原件确定性地转成「只含正文的检索文本」。
///
/// 失败就返回 `Err`：原件必须原样保留，调用方只据此标记「不可搜索」。
pub fn to_search_text(kind: AssetKind, raw: &[u8]) -> Result<String, String> {
    let text = match kind {
        AssetKind::Markdown | AssetKind::Text => {
            let s = String::from_utf8_lossy(raw).to_string();
            s.trim_start_matches('\u{feff}').to_string()
        }
        AssetKind::Html => html_to_text(&String::from_utf8_lossy(raw)),
        // PDF 正文几乎都在压缩流里；只能提未压缩的那部分，
        // 提不出来就老实说提不出来，不拿乱码充数。
        AssetKind::Pdf => pdf_to_text(raw)?,
        AssetKind::Docx | AssetKind::Pptx => {
            // 装进 zip 的格式没有解码器就是没有，编一个"部分支持"只会让原件更难找。
            return Err(no_converter_error(kind));
        }
        AssetKind::Other => return Err(no_converter_error(kind)),
    };
    let text = collapse(&text);
    if text.is_empty() {
        return Err("转换后没有可读正文".into());
    }
    Ok(text)
}

fn collapse(text: &str) -> String {
    // 保留空行：检索结果的「第 N 段」依赖空行分段，全部压掉会让所有文件都变成第 1 段。
    text.lines().map(|l| l.trim()).collect::<Vec<_>>().join("\n").trim().to_string()
}

/// 解析标签时的跳过状态：`<script>` / `<style>` 内部整段丢掉。
enum SkipState {
    None,
    Tag(String),
}

fn html_to_text(raw: &str) -> String {
    let mut out = String::new();
    let mut skip = SkipState::None;
    let mut i = 0usize;
    while i < raw.len() {
        // 按字符前进而不是按字节：一个汉字是 3 个字节，按字节推进会把它拆成三个乱码。
        let c = raw[i..].chars().next().unwrap_or('\u{fffd}');
        let step = c.len_utf8();
        if c != '<' {
            if matches!(skip, SkipState::None) {
                out.push(c);
            }
            i += step;
            continue;
        }
        // `find` 返回的是相对当前切片的下标，必须加回 i 才是原串里的绝对位置；
        // 直接拿相对下标去切片，轻则死循环，重则越界 panic。
        let close = match raw[i..].find('>') {
            Some(f) => i + f,
            None => raw.len(),
        };
        // 标签名要「不含 '>'」：把 '>' 也算进标签名，`<style>` 会被读成 `style>`，
        // 于是跳过状态永远设不上，样式内容就当正文留在了检索文本里。
        let end = (close + 1).min(raw.len());
        let raw_tag = raw.get(i + 1..close).unwrap_or("").to_ascii_lowercase();
        let is_close = raw_tag.starts_with('/');
        let name = raw_tag
            .trim_start_matches('/')
            .chars()
            .take(6)
            .collect::<String>();
        if is_close {
            if matches!(&skip, SkipState::Tag(t) if *t == name) {
                skip = SkipState::None;
            }
        } else {
            match name.as_str() {
                "script" | "style" => skip = SkipState::Tag(name.clone()),
                // 块级标签换成空行，和段落分段保持一致，避免所有命中都落在「第 1 段」。
                "p" | "div" | "br" | "h1" | "h2" | "h3" | "h4" | "li" | "tr" | "section" => {
                    if matches!(skip, SkipState::None) {
                        out.push_str("\n\n");
                    }
                }
                _ => {}
            }
        }
        i = end;
    }
    decode_entities(&out)
}

fn decode_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&ldquo;", "“")
        .replace("&rdquo;", "”")
}

/// PDF 文本提取：只做「未压缩内容流里的 `(...) Tj / TJ`」这一档。
///
/// 压缩流（FlateDecode）解不开是常态，这类 PDF 走「转换失败 → 保留原件」通道，
/// 不会为了「看起来能搜」把二进制当正文。
fn pdf_to_text(raw: &[u8]) -> Result<String, String> {
    let s = String::from_utf8_lossy(raw);
    let b = s.as_bytes();
    let mut out = String::new();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] != b'(' {
            i += 1;
            continue;
        }
        let start = i + 1;
        let mut j = start;
        while j < b.len() {
            match b[j] {
                b'\\' => j += 2,
                b')' => break,
                _ => j += 1,
            }
        }
        let mut k = j + 1;
        while k < b.len() && b[k].is_ascii_whitespace() {
            k += 1;
        }
        let op = s.get(k..k + 2).unwrap_or("");
        let is_op = op == "Tj" || op == "TJ" || op == "T*" || op == "'" || op == "\"";
        // 往回看一个非空白字节，判断这个字符串处在什么位置。
        let mut back = i;
        while back > 0 && b[back - 1].is_ascii_whitespace() {
            back -= 1;
        }
        // 数组里的字符串同样要当正文：TJ 的间距数字夹在中间，
        // 只认「后面紧跟操作符」会把数组里后面的正文整段丢掉。
        let in_array = match back.checked_sub(1).map(|x| b[x]) {
            // 数组已闭合，后面的字符串不再是正文。
            Some(b']') => false,
            Some(b'[') | Some(b'/') => true,
            Some(d) if d.is_ascii_digit() || d == b'.' || d == b'-' => true,
            _ => false,
        };
        if in_array || is_op {
            // 先把整段字符串按 UTF-8 解出来，再处理反斜杠转义：
            // 逐字节 `as char` 会把中文拆成三个控制字符，检索文本直接变乱码。
            let chunk = String::from_utf8_lossy(&b[start..j]).to_string();
            let cb = chunk.as_bytes();
            let mut buf = String::new();
            let mut t = 0usize;
            while t < cb.len() {
                if cb[t] == b'\\' && t + 1 < cb.len() {
                    let n = cb[t + 1];
                    buf.push(match n {
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        _ => n as char,
                    });
                    t += 2;
                    continue;
                }
                let c = chunk[t..].chars().next().unwrap_or('\u{fffd}');
                let len = c.len_utf8();
                if !c.is_control() {
                    buf.push(c);
                }
                t += len;
            }
            if !buf.trim().is_empty() {
                out.push_str(&buf);
                out.push('\n');
            }
            // 取到正文就跳过去：PDF 字符串不嵌套，后面不可能再有同级的文本串。
            i = j + 1;
        } else {
            // 没取到（例如数组已闭合之后的字符串）就退回字符串内部继续找，
            // 直接跳到 ')' 之后会把同一段里后面的正文整块漏掉。
            i = start;
        }
    }
    let text = out.trim().to_string();
    if text.is_empty() {
        return Err("PDF 正文在压缩流中，未压缩部分没有文本".into());
    }
    // 质量闸门：乱码一律不收，宁可标记为不可搜索。
    // 判据是「有没有可打印字符」而不是「是不是 ASCII」：
    // 中文正文在 PDF 里同样合法，按 ASCII 比例会把正常文档误判成乱码。
    let printable = text
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_ascii_graphic() || c.is_whitespace())
        .count();
    let ratio = printable as f64 / text.chars().count().max(1) as f64;
    if ratio < 0.85 {
        return Err("PDF 文本无法可靠提取（疑似编码流）".into());
    }
    Ok(text)
}

// ── 检索 ──────────────────────────────────────────────────────

/// 按空行切段。段号是给用户看的定位信息，比行号更能指向「第几段」。
fn iter_blocks(lines: &[&str]) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        if lines[i].trim().is_empty() {
            i += 1;
            continue;
        }
        let mut buf = String::new();
        while i < lines.len() && !lines[i].trim().is_empty() {
            if !buf.is_empty() {
                buf.push('\n');
            }
            buf.push_str(lines[i]);
            i += 1;
        }
        // 段号按「第几段」数，不是按行号：空行占了行号，用行号会得到第 3 段这种怪值。
        out.push((out.len() + 1, buf));
    }
    out
}

/// 命中片段：围绕第一个命中位置取一段，并给前端一个可高亮的中心词。
fn snippet_of(block: &str, needle: &str) -> (String, usize) {
    let flat: String = block.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = flat.to_lowercase();
    // lower 可能因大小写转换改变字节长度，at 只能当近似位置用；切片前必须回到 flat 的安全边界，
    // 否则多字节字符被切在中间会直接 panic。
    let at = lower.find(needle).unwrap_or(0).min(flat.len());
    let mut center = at.saturating_sub(30).min(flat.len());
    while center > 0 && !flat.is_char_boundary(center) {
        center -= 1;
    }
    let tail = flat[center..].chars().take(140).collect::<String>();
    let head = if center > 0 { "…" } else { "" };
    (format!("{head}{tail}"), at)
}

// ── 资产生命周期 ──────────────────────────────────────────────

/// 按原件重算检索文本与转换状态。
fn reindex(app: &AppHandle, asset: &mut LibraryAsset) {
    let Ok(root) = library_root(app) else {
        asset.searchable = false;
        asset.convert_error = Some("资料库根目录不可写".into());
        return;
    };
    reindex_at(&root, asset);
}

/// 二进制容器（docx/pptx/other）不做正文检索，只需指纹：
/// 整块读进内存既没用，还会让 50 MiB 的文件卡一下。
fn reindex_at(root: &Path, asset: &mut LibraryAsset) {
    let path = asset_path(root, &asset.rel_path);
    if matches!(
        asset.kind,
        AssetKind::Docx | AssetKind::Pptx | AssetKind::Other
    ) {
        match hash_file(&path) {
            Ok(hash) => {
                asset.content_hash = hash;
                asset.searchable = false;
                let _ = fs::remove_file(search_path(root, &asset.id));
            }
            Err(e) => {
                asset.searchable = false;
                asset.convert_error = Some(e.to_string());
                return;
            }
        }
        asset.convert_error = Some(no_converter_error(asset.kind));
        return;
    }
    match fs::read(&path) {
        Ok(bytes) => {
            // 每次重算索引顺手刷新内容指纹；导入/保存/发布/回滚都经过这里。
            asset.content_hash = hash_bytes(&bytes);
            match to_search_text(asset.kind, &bytes) {
                Ok(text) => {
                    let trimmed = text.chars().take(SEARCH_TEXT_LIMIT).collect::<String>();
                    match fs::write(search_path(root, &asset.id), trimmed) {
                        Ok(()) => {
                            asset.searchable = true;
                            asset.convert_error = None;
                        }
                        Err(e) => {
                            asset.searchable = false;
                            asset.convert_error = Some(e.to_string());
                        }
                    }
                }
                Err(e) => {
                    // 转换失败：原件不动，只记状态。
                    asset.searchable = false;
                    asset.convert_error = Some(e);
                    let _ = fs::remove_file(search_path(root, &asset.id));
                }
            }
        }
        Err(e) => {
            asset.searchable = false;
            asset.convert_error = Some(e.to_string());
        }
    }
}

fn find_mut<'a>(store: &'a mut LibraryStore, id: &str) -> Option<&'a mut LibraryAsset> {
    store.assets.iter_mut().find(|a| a.id == id)
}

fn find(store: &LibraryStore, id: &str) -> Option<LibraryAsset> {
    store.assets.iter().find(|a| a.id == id).cloned()
}

fn push_unique(list: &mut Vec<String>, id: &str) {
    list.retain(|x| x != id);
    list.insert(0, id.to_string());
    list.truncate(20);
}

/// 写入正文：留快照 → 覆盖 → 重算索引 → 记来源。
/// 只有确实变了才动这些，重复保存不该堆出一串一模一样的修订。
fn write_body(
    app: &AppHandle,
    store: &mut LibraryStore,
    id: &str,
    content: &str,
    origin_kind: &str,
    origin_detail: &str,
) -> Result<LibraryAsset, String> {
    let Some(current) = find(store, id) else {
        return Err("library/not-found".to_string());
    };
    if !current.enabled {
        return Err(format!("library/disabled: {}", current.name));
    }
    if !current.kind.is_textual() {
        return Err(format!(
            "library/binary-body: {} 不是文本资产，请用系统应用打开原件",
            current.kind.label()
        ));
    }
    let size = content.len() as u64;
    assert_replace_quota(store, current.size, size)?;

    // 后续全在副本上改，最后再一次性提交回表里：
    // 中间任何一步失败都不会留下「内存改了一半」的状态。
    let mut asset = current;
    let root = library_root(app)?;
    let path = asset_path(&root, &asset.rel_path);
    let before: Option<String> = if path.is_file() {
        fs::read_to_string(&path).ok()
    } else {
        None
    };
    let changed = before.as_deref() != Some(content);

    let new_rev = asset.revision + 1;
    if changed {
        // 覆盖前先给旧正文留快照：没有这一步，「修订」只是个假象。
        if let Some(old) = &before {
            fs::create_dir_all(revision_dir(&root, id)).map_err(|e| e.to_string())?;
            fs::write(revision_path(&root, id, new_rev), old).map_err(|e| e.to_string())?;
        }
        // 覆盖写必须走临时文件 + 原子替换：fs::write 先截断再写，磁盘满时会直接毁掉旧正文。
        let tmp = path.with_file_name(format!(".lib-{id}.tmp"));
        if let Err(e) = fs::write(&tmp, content) {
            let _ = fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        if let Err(e) = fs::rename(&tmp, &path) {
            let _ = fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        asset.size = size;
        asset.revision = new_rev;
        asset.origin = AssetOrigin {
            kind: origin_kind.to_string(),
            detail: origin_detail.to_string(),
        };
        // 只有真的写了快照才记修订：原件缺失时没有可回滚的内容，
        // 凭空记一条只会让「修订」列表出现点击必 revision-missing 的假版本。
        if let Some(old) = &before {
            store.revisions.push(LibraryRevision {
                asset_id: id.to_string(),
                rev: new_rev,
                at: now_ms(),
                // 快照里存的是旧正文，大小要记旧正文，不是刚写入的新正文。
                size: old.len() as u64,
            });
            trim_revisions(store, &root, id);
        }
    }
    asset.updated_at = now_ms();
    reindex(app, &mut asset);
    push_unique(&mut store.recent, id);
    if changed {
        push_unique(&mut store.written, id);
    }
    if let Some(slot) = find_mut(store, id) {
        *slot = asset.clone();
    }
    Ok(asset)
}

fn trim_revisions(store: &mut LibraryStore, root: &Path, id: &str) {
    let mut owned: Vec<LibraryRevision> = store
        .revisions
        .iter()
        .filter(|r| r.asset_id == id)
        .cloned()
        .collect();
    owned.sort_by_key(|r| r.rev);
    while owned.len() > MAX_REVISIONS {
        let dropped = owned.remove(0);
        let _ = fs::remove_file(revision_path(root, id, dropped.rev));
    }
    store.revisions.retain(|r| r.asset_id != id);
    store.revisions.extend(owned);
}

fn next_id(store: &LibraryStore) -> String {
    let now = now_ms();
    let mut id = format!("lib-{now:x}");
    let mut seq = 1u64;
    while store.assets.iter().any(|a| a.id == id) {
        id = format!("lib-{now:x}-{seq:x}");
        seq += 1;
    }
    id
}

// ── 命令 ──────────────────────────────────────────────────────

#[tauri::command]
pub fn library_list(state: State<LibraryState>) -> Vec<LibraryAssetView> {
    let store = state.store.lock().unwrap();
    let mut out: Vec<LibraryAssetView> = store.assets.iter().map(LibraryAssetView::of).collect();
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

/// 「最近打开 / 最近写入」按时间顺序返回资产；历史里已不存在的条目直接跳过，
/// 不返回空 ids，免得前端还要自己过滤一遍。
#[tauri::command]
pub fn library_marks(state: State<LibraryState>, kind: Option<String>) -> Vec<LibraryAssetView> {
    let store = state.store.lock().unwrap();
    let ids = match kind.as_deref().unwrap_or("recent") {
        "written" => &store.written,
        _ => &store.recent,
    };
    ids.iter()
        .filter_map(|id| {
            store
                .assets
                .iter()
                .find(|a| &a.id == id)
                .map(LibraryAssetView::of)
        })
        .collect()
}

#[tauri::command]
pub fn library_stats(state: State<LibraryState>) -> LibraryStats {
    let store = state.store.lock().unwrap();
    LibraryStats {
        asset_count: store.assets.len(),
        used_bytes: total_bytes(&store.assets),
        max_file_bytes: MAX_FILE_BYTES,
        max_total_bytes: MAX_TOTAL_BYTES,
    }
}

#[tauri::command(async)]
pub fn library_tree(
    app: AppHandle,
    state: State<LibraryState>,
    dir: Option<String>,
) -> Vec<LibraryNode> {
    let rel = match dir {
        Some(d) if !d.is_empty() && d != "/" => d.trim_matches('/').to_string(),
        _ => String::new(),
    };
    let root = match library_root(&app) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let abs = asset_path(&root, &rel);
    let entries = match fs::read_dir(&abs) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    let registered: Vec<(String, String)> = {
        let store = state.store.lock().unwrap();
        store
            .assets
            .iter()
            .map(|a| (a.rel_path.clone(), a.id.clone()))
            .collect()
    };
    let prefix = if rel.is_empty() {
        String::new()
    } else {
        format!("{rel}/")
    };
    let mut nodes: Vec<LibraryNode> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        let child_rel = format!("{prefix}{name}");
        let is_dir = entry.path().is_dir();
        let asset_id = registered
            .iter()
            .find(|(r, _)| *r == child_rel)
            .map(|(_, id)| id.clone());
        let size = if is_dir {
            0
        } else {
            entry.metadata().map(|m| m.len()).unwrap_or(0)
        };
        nodes.push(LibraryNode {
            name,
            path: child_rel,
            is_dir,
            asset_id,
            size,
            children: Vec::new(),
        });
    }
    nodes.sort_by(|a, b| (b.is_dir, a.name.to_lowercase()).cmp(&(a.is_dir, b.name.to_lowercase())));
    nodes
}

#[tauri::command(async)]
pub fn library_read(
    app: AppHandle,
    state: State<LibraryState>,
    id: String,
) -> Result<LibraryContent, String> {
    let mut store = state.store.lock().unwrap();
    let Some(asset) = find(&store, &id) else {
        return Err("library/not-found".to_string());
    };
    // 停用即封锁：历史任务引用也一样拒，不搞「当前会话里就放行」的特例。
    if !asset.enabled {
        return Err(format!("library/disabled: {}", asset.name));
    }
    if !asset.kind.is_textual() {
        return Err(format!(
            "library/binary-body: {} 不是文本资产，请用系统应用打开原件",
            asset.kind.label()
        ));
    }
    let root = library_root(&app)?;
    let path = asset_path(&root, &asset.rel_path);
    if !path.is_file() {
        return Err(format!("library/missing: {}", asset.rel_path));
    }
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw).to_string();
    let total = text.len() as u64;
    let truncated = total > BODY_LIMIT;
    // BODY_LIMIT 是字节数；按字符截会放大到 4 倍，且可能切在 UTF-8 中间。
    let content = if truncated {
        let mut end = BODY_LIMIT as usize;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        text[..end].to_string()
    } else {
        text
    };
    push_unique(&mut store.recent, &id);
    // 「最近打开」是界面承诺的后端持久化数据，内存改了必须落盘。
    let _ = save_store(&app, &store);
    Ok(LibraryContent {
        content,
        truncated,
        total_bytes: total,
    })
}

#[derive(Clone, Serialize)]
pub struct LibraryBytes {
    pub kind: String,
    pub content: String,
}

#[tauri::command(async)]
pub fn library_bytes(
    app: AppHandle,
    state: State<LibraryState>,
    id: String,
) -> Result<LibraryBytes, String> {
    let mut store = state.store.lock().unwrap();
    let Some(asset) = find(&store, &id) else {
        return Err("library/not-found".to_string());
    };
    if !asset.enabled {
        return Err(format!("library/disabled: {}", asset.name));
    }
    let rel_path = asset.rel_path.clone();
    let root = library_root(&app)?;
    let path = asset_path(&root, &rel_path);
    if !path.is_file() {
        return Err(format!("library/missing: {rel_path}"));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > crate::artifacts::OFFICE_LIMIT {
        return Err("library/too-large: 超过 12 MiB 预览上限，请用「原件」打开".to_string());
    }
    let dot = rel_path.rfind('.').unwrap_or(0);
    let kind = rel_path[dot..].trim_start_matches('.').to_ascii_lowercase();
    push_unique(&mut store.recent, &id);
    let _ = save_store(&app, &store);
    Ok(LibraryBytes {
        kind,
        content: format!(
            "data:application/octet-stream;base64,{}",
            crate::artifacts::base64_of(&bytes)
        ),
    })
}

#[tauri::command(async)]
pub fn library_write(
    app: AppHandle,
    state: State<LibraryState>,
    id: String,
    content: String,
) -> Result<LibraryAssetView, String> {
    let mut store = state.store.lock().unwrap();
    let next = write_body(&app, &mut store, &id, &content, "written", "")?;
    save_store(&app, &store)?;
    Ok(LibraryAssetView::of(&next))
}

#[tauri::command(async)]
pub fn library_create(
    app: AppHandle,
    state: State<LibraryState>,
    dir: Option<String>,
    name: String,
    content: Option<String>,
) -> Result<LibraryAssetView, String> {
    let name = validate_name(&name)?;
    let rel = join_rel(dir.as_deref().unwrap_or(""), &name)?;
    let mut store = state.store.lock().unwrap();
    if store.assets.iter().any(|a| a.rel_path == rel) {
        return Err(format!("library/already-registered: {rel}"));
    }
    let root = library_root(&app)?;
    let path = asset_path(&root, &rel);
    if path.exists() {
        return Err(format!("library/path-taken: {rel}"));
    }
    let body = content.unwrap_or_default();
    assert_quota(&store, body.len() as u64)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, &body).map_err(|e| e.to_string())?;
    let now = now_ms();
    let mut asset = LibraryAsset {
        id: next_id(&store),
        name: name.clone(),
        rel_path: rel.clone(),
        kind: AssetKind::of_name(&name),
        size: body.len() as u64,
        enabled: true,
        searchable: false,
        convert_error: None,
        revision: 1,
        // 新建即草稿：必须显式发布才进检索，这是草稿发布流程的起点。
        draft: true,
        origin: AssetOrigin {
            kind: "created".into(),
            detail: String::new(),
        },
        content_hash: String::new(),
        created_at: now,
        updated_at: now,
    };
    reindex(&app, &mut asset);
    push_unique(&mut store.recent, &asset.id);
    store.assets.push(asset.clone());
    save_store(&app, &store)?;
    Ok(LibraryAssetView::of(&asset))
}

#[tauri::command(async)]
pub fn library_import(
    app: AppHandle,
    state: State<LibraryState>,
    path: String,
    dir: Option<String>,
) -> Result<LibraryAssetView, String> {
    let root = library_root(&app)?;
    let mut store = state.store.lock().unwrap();
    let view = import_into(
        &root,
        &mut store,
        &PathBuf::from(&path),
        &path,
        dir.as_deref().unwrap_or(""),
    )?;
    save_store(&app, &store)?;
    Ok(view)
}

/// 手动导入一份原件。与自动归档共用同一套内容去重：
/// 同内容已登记就直接返回已有记录，不再落第二份（文件名、目录都可以不同）。
fn import_into(
    root: &Path,
    store: &mut LibraryStore,
    source: &Path,
    source_label: &str,
    dir: &str,
) -> Result<LibraryAssetView, String> {
    if !source.is_file() {
        return Err(format!("library/source-missing: {source_label}"));
    }
    let size = fs::metadata(source).map(|m| m.len()).unwrap_or(0);
    let hash = hash_file(source)?;
    if let Some(existing) = store
        .assets
        .iter()
        .find(|a| !a.content_hash.is_empty() && a.content_hash == hash)
    {
        return Ok(LibraryAssetView::of(existing));
    }
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = validate_name(&name)?;
    let rel = join_rel(dir, &name)?;
    if store.assets.iter().any(|a| a.rel_path == rel) {
        return Err(format!("library/already-registered: {rel}"));
    }
    assert_quota(store, size)?;
    let target = asset_path(root, &rel);
    if target.exists() {
        return Err(format!("library/path-taken: {rel}"));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let copied = match fs::copy(source, &target) {
        Ok(n) => n,
        Err(e) => {
            // 复制中途失败会留下半截目标文件，必须清掉，避免变成不可见的孤儿。
            let _ = fs::remove_file(&target);
            return Err(e.to_string());
        }
    };
    // 源文件可能在 metadata 与 copy 之间变化：配额和统计必须记实际复制字节数。
    if let Err(e) = assert_quota(store, copied) {
        let _ = fs::remove_file(&target);
        return Err(e);
    }
    let now = now_ms();
    let mut asset = LibraryAsset {
        id: next_id(store),
        name: name.clone(),
        rel_path: rel.clone(),
        kind: AssetKind::of_name(&name),
        size: copied,
        enabled: true,
        searchable: false,
        convert_error: None,
        revision: 1,
        draft: false,
        origin: AssetOrigin {
            kind: "imported".into(),
            detail: source_label.to_string(),
        },
        content_hash: String::new(),
        created_at: now,
        updated_at: now,
    };
    reindex_at(root, &mut asset);
    push_unique(&mut store.recent, &asset.id);
    store.assets.push(asset.clone());
    Ok(LibraryAssetView::of(&asset))
}

// ── 会话产物自动归档 ──────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct ArchiveReport {
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
}

struct ArchiveOutcome {
    imported: usize,
    skipped: usize,
    failed: Vec<(String, String)>,
}

/// 日期段由前端按本地时区给出（`2026-11-13`）：Rust 这里没有时区数据，
/// 按 UTC 算会在东八区凌晨把文件放进前一天。形状不对就退回 unknown-date，
/// 归档本身不能因为日期格式失败。
fn date_segment(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let shaped = bytes.len() == 10
        && bytes
            .iter()
            .enumerate()
            .all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    if shaped {
        raw.to_string()
    } else {
        "unknown-date".to_string()
    }
}

/// 会话标题进目录名前先净化：路径分隔符、控制字符与文件系统保留字符都换成 `-`。
/// 标题被清空时退回会话 id，保证目录一定存在。
fn session_segment(title: &str, session_id: &str) -> String {
    let base = if title.trim().is_empty() { session_id } else { title };
    let mut out = String::new();
    for c in base.chars() {
        if out.chars().count() >= 60 {
            break;
        }
        let bad = c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
        out.push(if bad { '-' } else { c });
    }
    let trimmed = out.trim().trim_start_matches('.').trim();
    if trimmed.is_empty() {
        let mut fallback: String = session_id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        if fallback.is_empty() {
            fallback = "session".to_string();
        }
        fallback
    } else {
        trimmed.to_string()
    }
}

/// 同目录下重名但内容不同的文件加序号，绝不覆盖已有原件。
fn unique_rel(root: &Path, dir: &str, name: &str, store: &LibraryStore) -> Result<String, String> {
    let taken = |rel: &str| {
        store.assets.iter().any(|a| a.rel_path == rel) || asset_path(root, rel).exists()
    };
    let first = join_rel(dir, name)?;
    if !taken(&first) {
        return Ok(first);
    }
    let dot = name.rfind('.').filter(|i| *i > 0).unwrap_or(name.len());
    let (stem, ext) = name.split_at(dot);
    for i in 2..1000 {
        let candidate = join_rel(dir, &format!("{stem}-{i}{ext}"))?;
        if !taken(&candidate) {
            return Ok(candidate);
        }
    }
    Err("library/path-taken".to_string())
}

/// 归档一批源文件。单个文件失败只记入 `failed`，不中断整批：
/// 会话可能产出很多文件，一个坏文件不该让其余文件全部丢失。
fn archive_into(
    app: &AppHandle,
    store: &mut LibraryStore,
    session_id: &str,
    session_title: &str,
    date: &str,
    paths: &[String],
) -> ArchiveOutcome {
    match library_root(app) {
        Ok(root) => archive_into_at(&root, store, session_id, session_title, date, paths),
        Err(e) => ArchiveOutcome {
            imported: 0,
            skipped: 0,
            failed: paths.iter().map(|p| (p.clone(), e.clone())).collect(),
        },
    }
}

fn archive_into_at(
    root: &Path,
    store: &mut LibraryStore,
    session_id: &str,
    session_title: &str,
    date: &str,
    paths: &[String],
) -> ArchiveOutcome {
    let mut outcome = ArchiveOutcome {
        imported: 0,
        skipped: 0,
        failed: Vec::new(),
    };
    let dir = format!("{}/{}", date_segment(date), session_segment(session_title, session_id));
    for path in paths {
        let source = PathBuf::from(path);
        if !source.is_file() {
            outcome.failed.push((path.clone(), "源文件不存在".to_string()));
            continue;
        }
        let size = match fs::metadata(&source) {
            Ok(m) => m.len(),
            Err(e) => {
                outcome.failed.push((path.clone(), e.to_string()));
                continue;
            }
        };
        // 先按 metadata 查配额，再流式算指纹：大文件不整块读进内存。
        if let Err(e) = assert_quota(store, size) {
            outcome.failed.push((path.clone(), e));
            continue;
        }
        let hash = match hash_file(&source) {
            Ok(hash) => hash,
            Err(e) => {
                outcome.failed.push((path.clone(), e));
                continue;
            }
        };
        // 去重按内容：同内容已登记就跳过，与文件叫什么都无关。
        if store
            .assets
            .iter()
            .any(|a| !a.content_hash.is_empty() && a.content_hash == hash)
        {
            outcome.skipped += 1;
            continue;
        }
        let raw_name = source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let name = match validate_name(&raw_name) {
            Ok(name) => name,
            Err(e) => {
                outcome.failed.push((path.clone(), e));
                continue;
            }
        };
        let rel = match unique_rel(root, &dir, &name, store) {
            Ok(rel) => rel,
            Err(e) => {
                outcome.failed.push((path.clone(), e));
                continue;
            }
        };
        let target = asset_path(root, &rel);
        if let Some(parent) = target.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                outcome.failed.push((path.clone(), e.to_string()));
                continue;
            }
        }
        // ponytail: 指纹取自复制前的源文件。源文件在 hash 与 copy 之间被改写的窗口极小，
        // 真撞上也只是指纹与字节不符；要严格的话在 copy 后按 target 重算一次。
        let copied = match fs::copy(&source, &target) {
            Ok(n) => n,
            Err(e) => {
                let _ = fs::remove_file(&target);
                outcome.failed.push((path.clone(), e.to_string()));
                continue;
            }
        };
        // 源文件可能在 metadata 与 copy 之间长大：按实际字节数再核一次配额。
        if let Err(e) = assert_quota(store, copied) {
            let _ = fs::remove_file(&target);
            outcome.failed.push((path.clone(), e));
            continue;
        }
        let now = now_ms();
        let mut asset = LibraryAsset {
            id: next_id(store),
            name: name.clone(),
            rel_path: rel,
            kind: AssetKind::of_name(&name),
            size: copied,
            enabled: true,
            searchable: false,
            convert_error: None,
            revision: 1,
            // 归档是「已经产出的成品」：直接可检索，不再走草稿发布。
            draft: false,
            origin: AssetOrigin {
                kind: "auto-archive".into(),
                detail: format!("会话：{}（{}）", session_title.trim(), session_id),
            },
            content_hash: hash,
            created_at: now,
            updated_at: now,
        };
        reindex_at(root, &mut asset);
        store.assets.push(asset);
        outcome.imported += 1;
    }
    outcome
}

fn failure_text(failed: &[(String, String)]) -> String {
    failed
        .iter()
        .map(|(path, error)| format!("{path}: {error}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[tauri::command(rename_all = "snake_case", async)]
pub fn library_archive_session(
    app: AppHandle,
    state: State<LibraryState>,
    session_id: String,
    session_title: String,
    date: String,
    paths: Vec<String>,
) -> Result<ArchiveReport, String> {
    // 开关关闭时静默跳过：归档是后台行为，不该让调用方看到错误。
    if !crate::models::settings_load(app.clone())
        .auto_archive_artifacts
        .unwrap_or(true)
    {
        return Ok(ArchiveReport {
            imported: 0,
            skipped: paths.len(),
            failed: 0,
        });
    }
    let mut store = state.store.lock().unwrap();
    let outcome = archive_into(&app, &mut store, &session_id, &session_title, &date, &paths);
    if !outcome.failed.is_empty() {
        store.archive_failures.push(ArchiveFailure {
            id: format!("arc-{}", now_ms()),
            session_id,
            session_title,
            date: date_segment(&date),
            paths: outcome.failed.iter().map(|(p, _)| p.clone()).collect(),
            error: failure_text(&outcome.failed),
            at: now_ms(),
        });
    }
    save_store(&app, &store)?;
    Ok(ArchiveReport {
        imported: outcome.imported,
        skipped: outcome.skipped,
        failed: outcome.failed.len(),
    })
}

#[tauri::command(async)]
pub fn library_archive_retry(
    app: AppHandle,
    state: State<LibraryState>,
    id: String,
) -> Result<ArchiveReport, String> {
    let mut store = state.store.lock().unwrap();
    let Some(job) = store.archive_failures.iter().find(|f| f.id == id).cloned() else {
        return Err("library/archive-job-missing".to_string());
    };
    // 重试不受开关影响：用户已经在界面上明确点了重试。
    let outcome = archive_into(
        &app,
        &mut store,
        &job.session_id,
        &job.session_title,
        &job.date,
        &job.paths,
    );
    if outcome.failed.is_empty() {
        store.archive_failures.retain(|f| f.id != id);
    } else if let Some(slot) = store.archive_failures.iter_mut().find(|f| f.id == id) {
        slot.paths = outcome.failed.iter().map(|(p, _)| p.clone()).collect();
        slot.error = failure_text(&outcome.failed);
        slot.at = now_ms();
    }
    save_store(&app, &store)?;
    Ok(ArchiveReport {
        imported: outcome.imported,
        skipped: outcome.skipped,
        failed: outcome.failed.len(),
    })
}

#[tauri::command]
pub fn library_archive_failures(state: State<LibraryState>) -> Vec<ArchiveFailure> {
    state.store.lock().unwrap().archive_failures.clone()
}

#[tauri::command(async)]
pub fn library_archive_dismiss(
    app: AppHandle,
    state: State<LibraryState>,
    id: String,
) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    store.archive_failures.retain(|f| f.id != id);
    save_store(&app, &store)
}

#[tauri::command(async)]
pub fn library_rename(
    app: AppHandle,
    state: State<LibraryState>,
    id: String,
    name: String,
) -> Result<LibraryAssetView, String> {
    let name = validate_name(&name)?;
    let mut store = state.store.lock().unwrap();
    let Some(asset) = find(&store, &id) else {
        return Err("library/not-found".to_string());
    };
    let rel = join_rel(&dir_of(&asset.rel_path), &name)?;
    if store.assets.iter().any(|a| a.id != id && a.rel_path == rel) {
        return Err(format!("library/already-registered: {rel}"));
    }
    let root = library_root(&app)?;
    let from = asset_path(&root, &asset.rel_path);
    let to = asset_path(&root, &rel);
    if to.exists() {
        return Err(format!("library/path-taken: {rel}"));
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())?;
    let mut next = asset;
    next.name = name;
    next.rel_path = rel;
    // 类型可能随改名变（a.md → a.txt），索引必须跟着重算；
    // 重算结果要先于写回 store 落到 next 上，否则 searchable/convert_error 会被旧值覆盖。
    next.kind = AssetKind::of_name(&next.name);
    next.updated_at = now_ms();
    reindex(&app, &mut next);
    if let Some(slot) = find_mut(&mut store, &id) {
        *slot = next.clone();
    }
    save_store(&app, &store)?;
    Ok(LibraryAssetView::of(&next))
}

#[tauri::command(rename_all = "snake_case", async)]
pub fn library_move(
    app: AppHandle,
    state: State<LibraryState>,
    id: String,
    target_dir: Option<String>,
) -> Result<LibraryAssetView, String> {
    let mut store = state.store.lock().unwrap();
    let Some(asset) = find(&store, &id) else {
        return Err("library/not-found".to_string());
    };
    let rel = join_rel(target_dir.as_deref().unwrap_or(""), &asset.name)?;
    if store.assets.iter().any(|a| a.id != id && a.rel_path == rel) {
        return Err(format!("library/already-registered: {rel}"));
    }
    let root = library_root(&app)?;
    let from = asset_path(&root, &asset.rel_path);
    let to = asset_path(&root, &rel);
    if to.exists() {
        return Err(format!("library/path-taken: {rel}"));
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())?;
    let mut next = asset;
    next.rel_path = rel;
    next.updated_at = now_ms();
    if let Some(slot) = find_mut(&mut store, &id) {
        *slot = next.clone();
    }
    save_store(&app, &store)?;
    Ok(LibraryAssetView::of(&next))
}

#[tauri::command(async)]
pub fn library_remove(
    app: AppHandle,
    state: State<LibraryState>,
    id: String,
) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    let Some(asset) = find(&store, &id) else {
        return Err("library/not-found".to_string());
    };
    // 先删原件再删索引：顺序反了，中途失败会留下指不到文件的孤儿索引。
    let root = library_root(&app)?;
    match fs::remove_file(asset_path(&root, &asset.rel_path)) {
        Ok(()) => {}
        // 原件已经不在了，删除记录仍然有效。
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        // 权限不足/只读磁盘：必须保留记录，否则文件变成界面不可见的孤儿。
        Err(e) => return Err(e.to_string()),
    }
    let _ = fs::remove_file(search_path(&root, &id));
    let _ = fs::remove_dir_all(revision_dir(&root, &id));
    store.revisions.retain(|r| r.asset_id != id);
    store.assets.retain(|a| a.id != id);
    store.recent.retain(|x| *x != id);
    store.written.retain(|x| *x != id);
    save_store(&app, &store)?;
    Ok(())
}

#[tauri::command(async)]
pub fn library_set_enabled(
    app: AppHandle,
    state: State<LibraryState>,
    id: String,
    enabled: bool,
) -> Result<LibraryAssetView, String> {
    let mut store = state.store.lock().unwrap();
    let Some(asset) = find(&store, &id) else {
        return Err("library/not-found".to_string());
    };
    if asset.enabled == enabled {
        return Ok(LibraryAssetView::of(&asset));
    }
    let mut next = asset;
    next.enabled = enabled;
    next.updated_at = now_ms();
    if let Some(slot) = find_mut(&mut store, &id) {
        *slot = next.clone();
    }
    save_store(&app, &store)?;
    Ok(LibraryAssetView::of(&next))
}

/// 草稿发布：草稿转正式，索引重算并进入检索。发布不改正文，因此不产生新修订号。
#[tauri::command(async)]
pub fn library_publish(
    app: AppHandle,
    state: State<LibraryState>,
    id: String,
) -> Result<LibraryAssetView, String> {
    let mut store = state.store.lock().unwrap();
    let Some(asset) = find(&store, &id) else {
        return Err("library/not-found".to_string());
    };
    if !asset.draft {
        return Ok(LibraryAssetView::of(&asset));
    }
    let mut next = asset;
    next.draft = false;
    next.origin = AssetOrigin {
        kind: "draft-published".into(),
        detail: String::new(),
    };
    next.updated_at = now_ms();
    // 发布只是可见性变更，不产生新正文：不再凭空加一个没有快照的修订号，
    // 否则「修订历史」里会出现点回滚必然 revision-missing 的假版本。
    reindex(&app, &mut next);
    if let Some(slot) = find_mut(&mut store, &id) {
        *slot = next.clone();
    }
    push_unique(&mut store.written, &id);
    save_store(&app, &store)?;
    Ok(LibraryAssetView::of(&next))
}

#[tauri::command]
pub fn library_revisions(state: State<LibraryState>, id: String) -> Vec<LibraryRevision> {
    let store = state.store.lock().unwrap();
    let mut out: Vec<LibraryRevision> = store
        .revisions
        .iter()
        .filter(|r| r.asset_id == id)
        .cloned()
        .collect();
    out.sort_by(|a, b| b.rev.cmp(&a.rev));
    out
}

/// 回滚：把某一版快照写回正文，并留下一条来源标记。
#[tauri::command(async)]
pub fn library_rollback(
    app: AppHandle,
    state: State<LibraryState>,
    id: String,
    rev: u64,
) -> Result<LibraryAssetView, String> {
    let root = library_root(&app)?;
    let snapshot = revision_path(&root, &id, rev);
    if !snapshot.is_file() {
        return Err(format!("library/revision-missing: #{rev}"));
    }
    let old = fs::read_to_string(&snapshot).map_err(|e| e.to_string())?;
    let mut store = state.store.lock().unwrap();
    write_body(&app, &mut store, &id, &old, "rollback", &format!("#{rev}"))?;
    let next = match find_mut(&mut store, &id) {
        Some(slot) => {
            slot.origin = AssetOrigin {
                kind: "rollback".into(),
                detail: format!("#{rev}"),
            };
            slot.updated_at = now_ms();
            slot.clone()
        }
        None => return Err("library/not-found".to_string()),
    };
    save_store(&app, &store)?;
    Ok(LibraryAssetView::of(&next))
}

#[tauri::command(async)]
pub fn library_search(
    app: AppHandle,
    state: State<LibraryState>,
    query: String,
) -> Vec<LibraryHit> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let root = match library_root(&app) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let store = state.store.lock().unwrap();
    let mut hits: Vec<LibraryHit> = Vec::new();
    for asset in store.assets.iter() {
        // 停用的与草稿不参与检索：能搜到却读不出来，比搜不到更糟。
        if !asset.enabled || asset.draft {
            continue;
        }
        // 原件被外部删除后索引可能还在；按索引返回命中，点开只会报缺失。
        if !asset_path(&root, &asset.rel_path).is_file() {
            continue;
        }
        let convert_status = if asset.searchable {
            "ready"
        } else if asset.convert_error.is_some() {
            "failed"
        } else {
            "skipped"
        };
        let mut best: Option<LibraryHit> = None;
        // 名字 / 目录命中：不要求索引存在，也把它排在最前。
        if asset.name.to_lowercase().contains(&needle)
            || asset.rel_path.to_lowercase().contains(&needle)
        {
            best = Some(LibraryHit {
                asset_id: asset.id.clone(),
                name: asset.name.clone(),
                dir: dir_of(&asset.rel_path),
                kind: asset.kind,
                origin: asset.origin.clone(),
                revision: asset.revision,
                size: asset.size,
                convert_status,
                location: None,
                snippet: format!("/{}", asset.rel_path),
                score: 10,
            });
        }
        if asset.searchable {
            let Ok(text) = fs::read_to_string(search_path(&root, &asset.id)) else {
                continue;
            };
            let lines: Vec<&str> = text.lines().collect();
            for (block_no, block) in iter_blocks(&lines) {
                let lower = block.to_lowercase();
                if !lower.contains(&needle) {
                    continue;
                }
                let (snippet, _) = snippet_of(&block, &needle);
                let candidate = LibraryHit {
                    asset_id: asset.id.clone(),
                    name: asset.name.clone(),
                    dir: dir_of(&asset.rel_path),
                    kind: asset.kind,
                    origin: asset.origin.clone(),
                    revision: asset.revision,
                    size: asset.size,
                    convert_status,
                    location: Some(format!("第 {block_no} 段")),
                    snippet,
                    score: lower.matches(&needle).count(),
                };
                let better = match &best {
                    Some(b) => {
                        candidate.score > b.score
                            || (candidate.score == b.score && b.location.is_none())
                    }
                    None => true,
                };
                if better {
                    best = Some(candidate);
                }
                break;
            }
        }
        if let Some(hit) = best {
            hits.push(hit);
        }
    }
    hits.sort_by(|a, b| b.score.cmp(&a.score).then(a.name.cmp(&b.name)));
    hits.truncate(HIT_LIMIT);
    hits
}

#[tauri::command(async)]
pub fn library_open(app: AppHandle, state: State<LibraryState>, id: String) -> Result<(), String> {
    let store = state.store.lock().unwrap();
    let Some(asset) = find(&store, &id) else {
        return Err("library/not-found".to_string());
    };
    if !asset.enabled {
        return Err(format!("library/disabled: {}", asset.name));
    }
    let root = library_root(&app)?;
    let path = asset_path(&root, &asset.rel_path);
    if !path.is_file() {
        return Err(format!("library/missing: {}", asset.rel_path));
    }
    drop(store);
    use tauri_plugin_opener::OpenerExt;
    // `open_path` 只要 `impl Into<String>`：传 &PathBuf 会被拒，先转成字符串。
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<String>)
        .map_err(|e| e.to_string())
}

// ── 应用状态 ──────────────────────────────────────────────────

#[derive(Default)]
pub struct LibraryState {
    pub store: Mutex<LibraryStore>,
}

// ── 测试 ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_paths_are_rejected() {
        for bad in ["../etc/passwd", "a/../../b", "", "a//b", "a\u{0}b"] {
            assert_eq!(
                validate_rel(bad),
                Err("library/path-invalid".to_string()),
                "坏路径没被拦下: {bad}"
            );
        }
        assert!(validate_rel("docs/报告.md").is_ok());
    }

    #[test]
    fn invalid_names_are_rejected() {
        // 空名字与纯空白是「没填」，与「填了不合法」是两种错误，不能混为一谈。
        for bad in ["", "  "] {
            assert_eq!(
                validate_name(bad),
                Err("library/name-required".to_string()),
                "空名字没被拦下: {bad}"
            );
        }
        // tab 属于控制字符：文件名里出现它，终端与日志都会看不出真实内容。
        for bad in [".hidden", "a/b.md", "a\\b.md", "名字\ta"] {
            assert_eq!(
                validate_name(bad),
                Err("library/name-invalid".to_string()),
                "坏名字没被拦下: {bad:?}"
            );
        }
        assert!(validate_name("报告 v2.md").is_ok(), "中文文件名必须放行");
    }

    #[test]
    fn kind_is_inferred_from_extension() {
        assert_eq!(AssetKind::of_name("a.md"), AssetKind::Markdown);
        assert_eq!(AssetKind::of_name("a.TXT"), AssetKind::Text);
        assert_eq!(AssetKind::of_name("a.html"), AssetKind::Html);
        assert_eq!(AssetKind::of_name("a.pdf"), AssetKind::Pdf);
        assert_eq!(AssetKind::of_name("a.docx"), AssetKind::Docx);
        assert_eq!(AssetKind::of_name("a.pptx"), AssetKind::Pptx);
        assert_eq!(AssetKind::of_name("a.bin"), AssetKind::Other);
        assert_eq!(AssetKind::Other.label(), "other");
        assert!(AssetKind::Markdown.is_textual());
        assert!(!AssetKind::Pdf.is_textual());
    }

    #[test]
    fn html_converter_drops_tags_scripts_and_styles() {
        let html = "<html><head><style>a{color:red}</style><script>var a=1;</script></head><body><p>第一段</p><p>第二段</p></body></html>";
        let text = to_search_text(AssetKind::Html, html.as_bytes()).unwrap();
        assert!(!text.contains("var"), "script 内容必须整段丢掉");
        assert!(!text.contains("color:red"), "style 内容必须整段丢掉");
        assert!(!text.contains("<p>"), "标签必须剥掉");
        assert!(text.contains("第一段") && text.contains("第二段"));
        // 块级标签必须留出空行，否则两段会被合并成「第 1 段」。
        assert_eq!(iter_blocks(&text.lines().collect::<Vec<_>>()).len(), 2);
    }

    #[test]
    fn collapse_keeps_paragraph_breaks() {
        let text = collapse(" 第一段 \n\n 第二段 \n");
        assert_eq!(text, "第一段\n\n第二段");
        assert_eq!(iter_blocks(&text.lines().collect::<Vec<_>>()).len(), 2);
    }

    #[test]
    fn markdown_converter_keeps_the_body() {
        let md = "\u{feff}# 标题\n\n正文一行\n";
        let text = to_search_text(AssetKind::Markdown, md.as_bytes()).unwrap();
        assert!(text.contains("标题") && text.contains("正文一行"));
        assert!(!text.starts_with('\u{feff}'), "BOM 必须去掉");
    }

    /// 装进 zip 的格式没有解码器时必须**明确失败**，
    /// 而不是返回一段垃圾当正文——那会让「转换失败」变成谎话。
    #[test]
    fn zip_backed_formats_fail_explicitly() {
        assert!(to_search_text(AssetKind::Docx, b"PK\x03\x04fake").is_err());
        assert!(to_search_text(AssetKind::Pptx, b"PK\x03\x04fake").is_err());
        assert!(to_search_text(AssetKind::Other, b"anything").is_err());
    }

    #[test]
    fn pdf_without_uncompressed_text_is_not_searchable() {
        let pdf = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF";
        assert!(to_search_text(AssetKind::Pdf, pdf).is_err());
    }

    #[test]
    fn pdf_uncompressed_strings_are_extracted() {
        let pdf = "%PDF-1.4\nBT (第一段) Tj ET\nBT [(第二段) -200 (第三段)] TJ ET";
        let text = to_search_text(AssetKind::Pdf, pdf.as_bytes()).unwrap();
        assert!(text.contains("第一段"), "未压缩的 Tj 字符串必须能提出来");
        // TJ 数组里被当间距处理的那一段同样要提出来，否则整份 PDF 会缺一大块正文。
        assert!(
            text.contains("第二段") && text.contains("第三段"),
            "整段丢掉会让正文缺一块：{text}"
        );
    }

    #[test]
    fn empty_conversion_is_reported_as_failure() {
        assert!(to_search_text(AssetKind::Text, b"   \n\n ").is_err());
    }

    #[test]
    fn dir_of_reads_the_parent_folder() {
        assert_eq!(dir_of("a/b.md"), "/a");
        assert_eq!(dir_of("b.md"), "/");
    }

    #[test]
    fn join_rel_normalizes_the_folder_argument() {
        assert_eq!(join_rel("/", "a.md").unwrap(), "a.md");
        assert_eq!(join_rel("", "a.md").unwrap(), "a.md");
        assert_eq!(join_rel("docs/", "a.md").unwrap(), "docs/a.md");
        assert_eq!(join_rel("/docs/sub", "a.md").unwrap(), "docs/sub/a.md");
    }

    /// 段号定位：命中要能说出「第几段」，否则用户还得自己翻。
    #[test]
    fn blocks_are_numbered_paragraphs() {
        let lines: Vec<&str> = "第一段\n\n第二段\n第三段".lines().collect();
        let blocks = iter_blocks(&lines);
        // 空行切段，连续两行算同一段。
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].0, 1);
        assert_eq!(blocks[0].1, "第一段");
        assert_eq!(blocks[1].0, 2);
        assert_eq!(blocks[1].1, "第二段\n第三段");
    }

    #[test]
    fn snippet_centers_on_the_hit() {
        let long = format!("前缀 {}\n", "填充".repeat(60));
        let (snippet, _) = snippet_of(&long, "填充");
        assert!(snippet.contains("填充"));
        assert!(snippet.chars().count() <= 150);
    }

    /// 多字节字符前 30 字节不一定落在字符边界上；旧实现直接按字节切片会 panic。
    #[test]
    fn snippet_slices_on_char_boundaries() {
        let block = format!("{}a{}", "😀".repeat(20), "😀".repeat(20));
        let (snippet, _) = snippet_of(&block, "a");
        assert!(snippet.contains('a'));
    }

    #[test]
    fn snippet_handles_punctuation_and_emoji() {
        let block = format!("{}！！！命中！！！{}", "😀".repeat(40), "😀".repeat(40));
        let (snippet, _) = snippet_of(&block, "命中");
        assert!(snippet.contains("命中"));
        assert!(snippet.starts_with('…'), "命中点前有内容时必须带截断标记");
    }

    /// 重启一致性依赖这份 JSON 完整往返；字段少一个就等于资产表丢信息。
    #[test]
    fn store_round_trips_for_restart() {
        let mut store = LibraryStore::default();
        store.assets.push(LibraryAsset {
            id: "a".into(),
            name: "a.md".into(),
            rel_path: "docs/a.md".into(),
            kind: AssetKind::Markdown,
            size: 42,
            enabled: false,
            searchable: true,
            convert_error: None,
            revision: 3,
            draft: false,
            origin: AssetOrigin {
                kind: "imported".into(),
                detail: "/tmp/a.md".into(),
            },
            content_hash: "abc".into(),
            created_at: 1,
            updated_at: 2,
        });
        store.revisions.push(LibraryRevision {
            asset_id: "a".into(),
            rev: 3,
            at: 2,
            size: 7,
        });
        store.recent.push("a".into());
        store.written.push("a".into());

        let text = serde_json::to_string(&store).unwrap();
        let back: LibraryStore = serde_json::from_str(&text).unwrap();
        assert_eq!(back.assets[0].rel_path, "docs/a.md");
        assert_eq!(back.assets[0].size, 42);
        assert!(!back.assets[0].enabled);
        assert_eq!(back.assets[0].origin.detail, "/tmp/a.md");
        assert_eq!(back.revisions[0].rev, 3);
        assert_eq!(back.recent, vec!["a".to_string()]);
        assert_eq!(back.written, vec!["a".to_string()]);
    }

    /// 日期段由前端按本地时区给；形状不对时不能让整批归档失败。
    #[test]
    fn date_segment_accepts_only_iso_shapes() {
        assert_eq!(date_segment("2026-11-13"), "2026-11-13");
        assert_eq!(date_segment("2026/11/13"), "unknown-date");
        assert_eq!(date_segment(""), "unknown-date");
    }

    /// 会话标题里的斜杠与保留字符必须换成 `-`，否则会写出日期目录之外。
    #[test]
    fn session_segment_strips_path_characters() {
        let seg = session_segment("重构/资料库：v2", "s-1");
        assert!(!seg.contains('/'));
        assert!(!seg.contains(':'));
        assert_eq!(session_segment("", "s-1"), "s-1");
        assert_eq!(session_segment("..", "s-1"), "s-1");
    }

    /// 去重看内容不看名字：同内容不同文件名得到同一指纹。
    #[test]
    fn content_hash_ignores_file_names() {
        let same_a = hash_bytes(b"hello");
        let same_b = hash_bytes(b"hello");
        let other = hash_bytes(b"hello!");
        assert_eq!(same_a, same_b);
        assert_ne!(same_a, other);
    }

    #[test]
    fn replace_quota_subtracts_the_old_size() {
        let asset = |id: usize| LibraryAsset {
            id: format!("a{id}"),
            name: "a.md".into(),
            rel_path: format!("a{id}.md"),
            kind: AssetKind::Markdown,
            size: MAX_FILE_BYTES,
            enabled: true,
            searchable: true,
            convert_error: None,
            revision: 1,
            draft: false,
            origin: AssetOrigin::default(),
            content_hash: String::new(),
            created_at: 0,
            updated_at: 0,
        };
        // 101 份 50 MiB + 目标一份 50 MiB = 5100 MiB，距 5120 MiB 上限只剩 20 MiB。
        // 旧实现把目标文件大小再加一遍，5100 + 50 > 5120，会误拒这次纯替换。
        let mut assets: Vec<LibraryAsset> = (0..101).map(asset).collect();
        assets.push(asset(101));
        let store = LibraryStore {
            assets,
            revisions: Vec::new(),
            recent: Vec::new(),
            written: Vec::new(),
            archive_failures: Vec::new(),
        };
        assert!(assert_replace_quota(&store, MAX_FILE_BYTES, MAX_FILE_BYTES).is_ok());
        // 单文件上限仍然独立生效。
        assert!(assert_replace_quota(&store, 0, MAX_FILE_BYTES + 1).is_err());
    }

    #[test]
    fn quota_is_enforced_against_the_total() {
        let store = LibraryStore {
            assets: vec![LibraryAsset {
                id: "a".into(),
                name: "a.md".into(),
                rel_path: "a.md".into(),
                kind: AssetKind::Markdown,
                size: MAX_TOTAL_BYTES - 1,
                enabled: true,
                searchable: true,
                convert_error: None,
                revision: 1,
                draft: false,
                origin: AssetOrigin::default(),
                content_hash: String::new(),
                created_at: 0,
                updated_at: 0,
            }],
            revisions: Vec::new(),
            recent: Vec::new(),
            written: Vec::new(),
            archive_failures: Vec::new(),
        };
        assert!(assert_quota(&store, 2).is_err(), "超合计上限必须被拒");
        assert!(assert_quota(&store, 1).is_ok(), "正好用满应当放行");
    }

    #[test]
    fn single_file_ceiling_is_50_mib() {
        let store = LibraryStore::default();
        assert!(assert_quota(&store, MAX_FILE_BYTES + 1).is_err());
        assert!(assert_quota(&store, MAX_FILE_BYTES).is_ok());
    }

    #[test]
    fn recent_and_written_lists_dedup_with_newest_first() {
        let mut list = Vec::new();
        push_unique(&mut list, "a");
        push_unique(&mut list, "b");
        push_unique(&mut list, "a");
        assert_eq!(list, vec!["a".to_string(), "b".to_string()]);
        assert!(list.len() <= 20);
    }

    #[test]
    fn revisions_are_scoped_to_their_asset() {
        let mut store = LibraryStore {
            assets: vec![LibraryAsset {
                id: "a".into(),
                name: "a.md".into(),
                rel_path: "a.md".into(),
                kind: AssetKind::Markdown,
                size: 1,
                enabled: true,
                searchable: true,
                convert_error: None,
                revision: 1,
                draft: false,
                origin: AssetOrigin::default(),
                content_hash: String::new(),
                created_at: 0,
                updated_at: 0,
            }],
            revisions: vec![
                LibraryRevision {
                    asset_id: "a".into(),
                    rev: 1,
                    at: 1,
                    size: 1,
                },
                LibraryRevision {
                    asset_id: "b".into(),
                    rev: 1,
                    at: 2,
                    size: 1,
                },
            ],
            recent: Vec::new(),
            written: Vec::new(),
            archive_failures: Vec::new(),
        };
        store.revisions.retain(|r| r.asset_id == "a");
        assert_eq!(store.revisions.len(), 1, "删 a 时不能顺手删掉 b 的修订");
    }

    /// IPC 契约：前端按 snake_case 读。字段一大写化，目录树与配额卡就静默变空。
    /// 这个测试是上面的替代品：不跑界面也能钉住字段名。
    #[test]
    fn ipc_views_serialize_snake_case() {
        let view = LibraryAssetView {
            id: "a-1".into(),
            name: "a.md".into(),
            rel_path: "docs/a.md".into(),
            dir: "docs".into(),
            kind: AssetKind::Markdown,
            size: 1,
            enabled: true,
            searchable: true,
            convert_error: None,
            revision: 1,
            draft: false,
            origin: AssetOrigin::default(),
            updated_at: 0,
        };
        let json = serde_json::to_value(&view).unwrap();
        assert!(json.get("rel_path").is_some(), "前端读 rel_path");
        assert!(json.get("relPath").is_none());
        assert!(json.get("convert_error").is_some());
        assert!(json.get("updated_at").is_some());

        let node = LibraryNode {
            name: "docs".into(),
            path: "/docs".into(),
            is_dir: true,
            asset_id: None,
            size: 0,
            children: Vec::new(),
        };
        let json = serde_json::to_value(&node).unwrap();
        assert!(json.get("is_dir").is_some(), "前端读 is_dir");
        assert!(json.get("assetId").is_none());

        let stats = LibraryStats {
            asset_count: 2,
            used_bytes: 6144,
            max_file_bytes: MAX_FILE_BYTES,
            max_total_bytes: MAX_TOTAL_BYTES,
        };
        let json = serde_json::to_value(&stats).unwrap();
        assert!(json.get("asset_count").is_some(), "前端读 asset_count");
        assert!(json.get("max_total_bytes").is_some());
        assert!(json.get("maxTotalBytes").is_none());

        let body = LibraryContent {
            content: "x".into(),
            truncated: false,
            total_bytes: 1,
        };
        let json = serde_json::to_value(&body).unwrap();
        assert!(json.get("total_bytes").is_some(), "前端读 total_bytes");
    }

    #[test]
    fn store_decodes_from_partial_json() {
        let store: LibraryStore = serde_json::from_str("{}").unwrap();
        assert!(store.assets.is_empty());
        assert!(store.revisions.is_empty());
        assert!(store.recent.is_empty() && store.written.is_empty());
    }

    // ── 真实文件去重验证 ────────────────────────────────────────
    // 下面这些测试全部落真实文件、真实 sha256，不 mock 存储层：
    // 只有真跑一遍，才能证明「同内容只留一份」「重名不覆盖」是磁盘上的事实。

    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 每个测试一个独立临时根目录，互不干扰。
    fn temp_root(tag: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("pi-lib-{}-{tag}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(INDEX_DIR)).unwrap();
        fs::create_dir_all(root.join(REVISION_DIR)).unwrap();
        root
    }

    /// 在临时根下写一份真实源文件，返回其绝对路径。
    fn source_file(root: &Path, rel: &str, bytes: &[u8]) -> String {
        let p = root.join("_src").join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, bytes).unwrap();
        p.to_string_lossy().into_owned()
    }

    fn archive_all(root: &Path, store: &mut LibraryStore, paths: &[String]) -> ArchiveOutcome {
        archive_into_at(root, store, "s-1", "会话一", "2026-11-13", paths)
    }

    /// 1. 同内容、不同文件名、不同目录：只保留一份。
    #[test]
    fn archive_keeps_one_copy_per_content() {
        let root = temp_root("same-content");
        let mut store = LibraryStore::default();
        let a = source_file(&root, "one/a.md", b"# same body\n");
        let b = source_file(&root, "two/b.md", b"# same body\n");
        let outcome = archive_all(&root, &mut store, &[a, b]);
        assert_eq!(outcome.imported, 1, "同内容只该入库一份");
        assert_eq!(outcome.skipped, 1, "第二份应被内容哈希挡下");
        assert_eq!(store.assets.len(), 1);
        assert_eq!(store.assets[0].rel_path, "2026-11-13/会话一/a.md");
        assert!(asset_path(&root, &store.assets[0].rel_path).is_file());
        println!(
            "[1 同内容异名] imported={} skipped={} assets={} path={}",
            outcome.imported,
            outcome.skipped,
            store.assets.len(),
            store.assets[0].rel_path
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// 2. 同名不同内容：各自保留，重名靠后缀区分，绝不覆盖。
    #[test]
    fn archive_suffixes_same_name_with_different_content() {
        let root = temp_root("same-name");
        let mut store = LibraryStore::default();
        let a = source_file(&root, "one/report.md", b"v1");
        let b = source_file(&root, "two/report.md", b"v2");
        let outcome = archive_all(&root, &mut store, &[a, b]);
        assert_eq!(outcome.imported, 2);
        assert_eq!(outcome.skipped, 0);
        let paths: Vec<String> = store.assets.iter().map(|a| a.rel_path.clone()).collect();
        assert_eq!(
            paths,
            vec![
                "2026-11-13/会话一/report.md".to_string(),
                "2026-11-13/会话一/report-2.md".to_string(),
            ]
        );
        // 关键：第一份内容没被第二份覆盖。
        assert_eq!(
            fs::read_to_string(asset_path(&root, &paths[0])).unwrap(),
            "v1"
        );
        assert_eq!(
            fs::read_to_string(asset_path(&root, &paths[1])).unwrap(),
            "v2"
        );
        println!(
            "[2 同名异内容] imported={} assets={} paths={:?}",
            outcome.imported,
            store.assets.len(),
            paths
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// 3. 归档后源文件被编辑：按当前实现进新条目（不是新修订），旧条目内容不变。
    #[test]
    fn editing_an_archived_source_creates_a_new_entry() {
        let root = temp_root("edited");
        let mut store = LibraryStore::default();
        let a = source_file(&root, "report.md", b"v1");
        archive_all(&root, &mut store, &[a.clone()]);
        assert_eq!(store.assets.len(), 1);

        fs::write(&a, b"v2").unwrap();
        let outcome = archive_all(&root, &mut store, &[a]);
        assert_eq!(outcome.imported, 1, "内容变了就该是新条目");
        assert_eq!(outcome.skipped, 0);
        assert_eq!(store.assets.len(), 2, "旧条目必须留着");

        let first = &store.assets[0];
        let second = &store.assets[1];
        assert_eq!(first.rel_path, "2026-11-13/会话一/report.md");
        assert_eq!(second.rel_path, "2026-11-13/会话一/report-2.md");
        // 旧条目仍指向旧内容，新内容只落在新条目上。
        assert_eq!(first.content_hash, hash_bytes(b"v1"));
        assert_eq!(second.content_hash, hash_bytes(b"v2"));
        assert_eq!(
            fs::read_to_string(asset_path(&root, &first.rel_path)).unwrap(),
            "v1",
            "旧条目不能指向新内容"
        );
        assert_eq!(first.revision, 1);
        assert_eq!(second.revision, 1);
        println!(
            "[3 归档后编辑] imported={} assets={} old={} new={}",
            outcome.imported,
            store.assets.len(),
            first.rel_path,
            second.rel_path
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// 4. 手动导入与已归档内容相同：命中已有记录，不产生第二份。
    #[test]
    fn manual_import_hits_existing_content() {
        let root = temp_root("import-dedupe");
        let mut store = LibraryStore::default();
        let a = source_file(&root, "a.md", b"# doc\n");
        archive_all(&root, &mut store, &[a]);
        assert_eq!(store.assets.len(), 1);

        let copy = source_file(&root, "copy.md", b"# doc\n");
        let view = import_into(&root, &mut store, Path::new(&copy), &copy, "").unwrap();
        assert_eq!(store.assets.len(), 1, "同内容手动导入不得再落一份");
        assert_eq!(view.rel_path, "2026-11-13/会话一/a.md");
        println!(
            "[4 手动导入同内容] assets={} hit={}",
            store.assets.len(),
            view.rel_path
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// 5. 旧资产没有指纹：补指纹后参与去重；已经重复的旧记录不自动合并。
    #[test]
    fn legacy_assets_join_dedupe_after_backfill() {
        let root = temp_root("legacy");
        let legacy = root.join("old/legacy.md");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, b"legacy body").unwrap();

        let mut store = LibraryStore::default();
        store.assets.push(LibraryAsset {
            id: "old-1".into(),
            name: "legacy.md".into(),
            rel_path: "old/legacy.md".into(),
            kind: AssetKind::Markdown,
            size: 11,
            enabled: true,
            searchable: true,
            convert_error: None,
            revision: 1,
            draft: false,
            origin: AssetOrigin::default(),
            content_hash: String::new(),
            created_at: 0,
            updated_at: 0,
        });
        backfill_hashes(&root, &mut store);
        assert_eq!(store.assets[0].content_hash, hash_bytes(b"legacy body"));

        let again = source_file(&root, "again.md", b"legacy body");
        let outcome = archive_all(&root, &mut store, &[again]);
        assert_eq!(outcome.imported, 0, "补齐指纹后旧资产必须参与去重");
        assert_eq!(outcome.skipped, 1);
        assert_eq!(store.assets.len(), 1);
        println!(
            "[5 旧资产补指纹] imported={} skipped={} assets={} hash={}…",
            outcome.imported,
            outcome.skipped,
            store.assets.len(),
            &store.assets[0].content_hash[..12]
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// 6. 大文件 / 二进制：按字节算指纹，且与整块哈希一致。
    #[test]
    fn large_binary_files_hash_by_bytes() {
        let root = temp_root("binary");
        let mut store = LibraryStore::default();
        let bytes: Vec<u8> = (0..12 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        let a = source_file(&root, "img/photo.png", &bytes);
        // 流式哈希必须与整块哈希一致：证明没有漏读尾块、没有按行/按文本处理。
        assert_eq!(hash_file(Path::new(&a)).unwrap(), hash_bytes(&bytes));

        let outcome = archive_all(&root, &mut store, &[a.clone()]);
        assert_eq!(outcome.imported, 1);
        let (first_size, first_path) = {
            let asset = &store.assets[0];
            assert_eq!(asset.kind, AssetKind::Other);
            assert_eq!(asset.size, bytes.len() as u64);
            assert_eq!(asset.content_hash, hash_bytes(&bytes));
            assert!(!asset.searchable, "二进制类型不该走正文检索");
            (asset.size, asset.rel_path.clone())
        };
        // 复制必须逐字节一致。
        assert_eq!(
            fs::read(asset_path(&root, &first_path)).unwrap().len(),
            bytes.len()
        );

        // 同内容的第二个二进制文件同样被挡下。
        let b = source_file(&root, "img/copy.png", &bytes);
        let second = archive_all(&root, &mut store, &[b]);
        assert_eq!(second.imported, 0);
        assert_eq!(second.skipped, 1);
        assert_eq!(store.assets.len(), 1);
        println!(
            "[6 12MiB 二进制] imported={} skipped={} assets={} size={} path={}",
            outcome.imported,
            second.skipped,
            store.assets.len(),
            first_size,
            first_path
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// docx 这类 zip 容器：不入正文索引，但指纹照算、照去重。
    #[test]
    fn docx_is_hashed_but_not_searchable() {
        let root = temp_root("docx");
        let mut store = LibraryStore::default();
        let bytes = b"PK\x03\x04fake docx bytes";
        let a = source_file(&root, "doc/合同.docx", bytes);
        let outcome = archive_all(&root, &mut store, &[a]);
        assert_eq!(outcome.imported, 1);
        let asset = &store.assets[0];
        assert_eq!(asset.kind, AssetKind::Docx);
        assert_eq!(asset.content_hash, hash_bytes(bytes));
        assert!(!asset.searchable);
        assert!(asset.convert_error.is_some());
        assert!(!search_path(&root, &asset.id).exists(), "不该留下空索引");
        let _ = fs::remove_dir_all(&root);
    }
}
