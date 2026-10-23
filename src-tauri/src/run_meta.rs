//! 运行记录元数据 sidecar：置顶 / 重命名 / 归档 / 删除 + 独立回放窗口。
//!
//! 背景：侧栏「工作区 → 项目 → 运行记录」来自 journal 的 `session_open`
//! 分段（只读、append-only 的审计流）。WorkBuddy 同款记录菜单要改这些段的
//! 展示状态，但**不能写回 journal**——那会污染审计语义、也会让重放拿到
//! 被改过的历史。所以可变状态以 sidecar 文件
//! `<app_config_dir>/run_meta.json` 单独承载，按 `(cwd, index)` 与 journal
//! 段关联：`index` 即 `session_open` 的全局段号，前端回放仍按段号取数，
//! 软删除只隐藏段、绝不让 journal 缺号错位。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

/// 自定义标题上限：与 projects 的 `TITLE_MAX` 对齐。
/// 超长标题会把侧栏运行记录列的布局顶崩。
const TITLE_MAX: usize = 500;

/// 独立回放窗口的默认尺寸（对齐 WorkBuddy 回放窗）。
const REPLAY_WINDOW_WIDTH: f64 = 1100.0;
const REPLAY_WINDOW_HEIGHT: f64 = 760.0;

// ── 领域模型 ──────────────────────────────────────────────────

/// 一条运行记录的元数据。`(cwd, index)` 唯一对应 journal 的一个
/// `session_open` 段；缺省语义全 false / 无标题（未碰过的段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMetaEntry {
    /// 该段所属的工作目录（与 session_open 的 cwd 逐字节一致）。
    pub cwd: String,
    /// journal 全局段号（0 起，按时间顺序）。回放按它取段。
    pub index: u32,
    /// 置顶：列表排到最前（pinned 组内仍保持时间倒序）。
    #[serde(default)]
    pub pinned: bool,
    /// 重命名后的标题；`None` = 用段内第一条用户消息（journal 原语义）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// 归档：默认列表隐藏，`include_archived` 时随全量返回。
    #[serde(default)]
    pub archived: bool,
    /// 软删除：永久过滤（journal 原文不动，段号不错位）。
    #[serde(default)]
    pub deleted: bool,
}

/// 局部更新补丁：只改 `Some` 的字段，`None` 保持原值。
/// 前端传 camelCase（本结构字段名单词化，与 snake_case 同形，
/// 仍显式声明 rename 以防未来加多词字段时静默错位）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMetaPatch {
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub archived: Option<bool>,
    #[serde(default)]
    pub deleted: Option<bool>,
}

/// sidecar 存储：全部条目平铺。
///
/// 条目量级 = 用户历史会话数（百级），线性查找足够；换来的好处是
/// 序列化格式简单、可读、坏了能手改——与 projects.json 的 store 同思路。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RunMetaStore {
    #[serde(default)]
    pub entries: Vec<RunMetaEntry>,
}

/// Tauri 托管状态：store 常驻内存（启动时从盘加载），
/// 命令只做「改内存 → 落盘」。
#[derive(Default)]
pub struct RunMetaState {
    pub store: Mutex<RunMetaStore>,
}

// ── 纯函数（便于单测；命令层只负责取状态与落盘） ──────────────

/// 把补丁应用到条目：只动 `Some` 字段。
///
/// 标题做 trim；**空标题等价于清除重命名**（`title = None`），
/// 这样前端「恢复默认标题」传空串即可，不需要额外约定。
fn apply_patch(entry: &mut RunMetaEntry, patch: &RunMetaPatch) {
    if let Some(pinned) = patch.pinned {
        entry.pinned = pinned;
    }
    if let Some(title) = patch.title.as_deref() {
        let trimmed = title.trim();
        entry.title = if trimmed.is_empty() {
            None
        } else {
            // 按字符截断而非字节：中文标题 500 字符远小于 500 字节的
            // 直观预期，且不会把 UTF-8 序列切出乱码。
            Some(trimmed.chars().take(TITLE_MAX).collect())
        };
    }
    if let Some(archived) = patch.archived {
        entry.archived = archived;
    }
    if let Some(deleted) = patch.deleted {
        entry.deleted = deleted;
    }
}

/// upsert：无则新建条目（默认全 false / 无标题），有则只改 patch 里
/// `Some` 的字段。返回应用补丁后的条目快照。
pub fn upsert(store: &mut RunMetaStore, cwd: &str, index: u32, patch: &RunMetaPatch) -> RunMetaEntry {
    if let Some(existing) = store
        .entries
        .iter_mut()
        .find(|e| e.cwd == cwd && e.index == index)
    {
        apply_patch(existing, patch);
        return existing.clone();
    }
    let mut entry = RunMetaEntry {
        cwd: cwd.to_string(),
        index,
        pinned: false,
        title: None,
        archived: false,
        deleted: false,
    };
    apply_patch(&mut entry, patch);
    store.entries.push(entry.clone());
    entry
}

/// 确定性排序：`(cwd, index)` 字典序。
/// 前端按 cwd 过滤后与 journal 段号对齐，输出稳定也便于测试断言。
pub fn sorted_entries(store: &RunMetaStore) -> Vec<RunMetaEntry> {
    let mut rows = store.entries.clone();
    rows.sort_by(|a, b| (&a.cwd, a.index).cmp(&(&b.cwd, b.index)));
    rows
}

// ── 状态读写 ──────────────────────────────────────────────────

/// sidecar 路径：`<app_config_dir>/run_meta.json`。
///
/// 与 journal 路径同一套**确定性解析**（只问 app_config_dir，不依赖任何
/// 可变 state 字段）：App 刚启动、`pi_journal_sessions` 还没被调用过时，
/// 路径也必须可算——否则启动加载无从下手。
fn run_meta_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("run_meta.json"))
}

/// 启动时加载。文件缺失/损坏都不阻断启动：退化为空 sidecar，
/// 表现为「没有置顶/重命名」，而不是整个 App 起不来。
pub fn load(app: &AppHandle, state: &State<RunMetaState>) {
    let Ok(path) = run_meta_file(app) else {
        return;
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return;
    };
    if let Ok(store) = serde_json::from_str::<RunMetaStore>(&text) {
        *state.store.lock().unwrap() = store;
    }
}

/// 落盘。先 clone 快照再写：锁只在 clone 期间持有，
/// 磁盘慢不阻塞其它命令读 store。
fn persist(app: &AppHandle, state: &State<RunMetaState>) -> Result<(), String> {
    let path = run_meta_file(app)?;
    let snapshot = state.store.lock().unwrap().clone();
    let json = serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

// ── 命令层 ────────────────────────────────────────────────────

/// 全量元数据（前端按 cwd 过滤；量级百级，全量比按 cwd 拆命令更省事）。
/// **必须 async**：与 `run_meta_update` 同属运行记录 IO 面，
/// 一并收编进 `pi_bridge` 的 IO_WATCHED 名单。
#[tauri::command(async)]
pub fn run_meta_list(state: State<'_, RunMetaState>) -> Vec<RunMetaEntry> {
    sorted_entries(&state.store.lock().unwrap())
}

/// upsert 一条运行记录元数据（置顶/重命名/归档/删除都走这里）。
/// 写盘持久化后返回全量列表（与 `run_meta_list` 同序），前端省一次往返。
#[tauri::command(async)]
#[allow(non_snake_case)]
pub fn run_meta_update(
    app: AppHandle,
    cwd: String,
    index: u32,
    patch: RunMetaPatch,
    state: State<'_, RunMetaState>,
) -> Result<Vec<RunMetaEntry>, String> {
    {
        let mut store = state.store.lock().unwrap();
        upsert(&mut store, &cwd, index, &patch);
    }
    persist(&app, &state)?;
    Ok(sorted_entries(&state.store.lock().unwrap()))
}

/// 独立回放窗口（WorkBuddy「独立窗口」对位）：同一份前端、hash 路由落到
/// `#/chat?replay=<index>&cwd=<encodeURIComponent(cwd)>`，对话页据此
/// 只读重建该段会话——不新拉内核、不改 journal。
///
/// label 带时间戳保证唯一：同一段反复点「独立窗口」应各开一窗，而不是复用。
/// **必须 async**：Windows 上在同步命令里创建 Webview2 窗口会死锁
/// （tauri 官方 Known issues，见 `WebviewWindowBuilder::new` 文档），
/// 且建窗涉及 webview 进程创建，不能落主线程。
#[tauri::command(async)]
pub fn open_replay_window(app: AppHandle, cwd: String, index: u32) -> Result<(), String> {
    let label = format!("replay-{index}-{}", now_ms());
    let url = format!(
        "index.html#/chat?replay={index}&cwd={}",
        encode_uri_component(&cwd)
    );
    let window = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
        .title("Pi Workbench · 回放")
        .inner_size(REPLAY_WINDOW_WIDTH, REPLAY_WINDOW_HEIGHT)
        .build()
        .map_err(|e| e.to_string())?;
    // 建窗即聚焦：用户刚点的菜单，窗口不该缩在后台。
    // 聚焦失败（个别平台/窗口管理器）只是体验问题，窗口已建成，不报错。
    let _ = window.set_focus();
    Ok(())
}

// ── 工具函数 ──────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `encodeURIComponent` 对位：除未保留字符
/// （`A-Z a-z 0-9 - _ . ! ~ * ' ( )`）外按 UTF-8 字节 percent-encode。
///
/// 路径里最常见的 `/`、空格、中文、`#`、`&`、`?` 都会被编码，
/// 前端 `decodeURIComponent` / `URLSearchParams` 取回原值。
/// 不引 `percent-encoding` crate：只需要一个函数，为它加一条直接依赖
/// 不划算（它已作为 url/reqwest 的传递依赖在 lock 里，但直接用传递依赖
/// 会在升级时静默断供）。
fn encode_uri_component(raw: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        let unreserved = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if unreserved {
            // 未保留字符全是 ASCII，`as char` 不会造出多字节字符。
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_store() -> RunMetaStore {
        RunMetaStore::default()
    }

    fn patch_all(
        pinned: Option<bool>,
        title: Option<&str>,
        archived: Option<bool>,
        deleted: Option<bool>,
    ) -> RunMetaPatch {
        RunMetaPatch {
            pinned,
            title: title.map(|t| t.to_string()),
            archived,
            deleted,
        }
    }

    #[test]
    fn upsert_creates_entry_when_missing() {
        let mut store = empty_store();
        let entry = upsert(
            &mut store,
            "/repo/a",
            3,
            &patch_all(Some(true), Some("  新标题  "), Some(true), None),
        );

        assert_eq!(store.entries.len(), 1, "缺条目应新建");
        assert_eq!(entry.cwd, "/repo/a");
        assert_eq!(entry.index, 3);
        assert!(entry.pinned);
        assert_eq!(entry.title.as_deref(), Some("新标题"), "标题应 trim");
        assert!(entry.archived);
        assert!(!entry.deleted, "未传的字段保持默认 false");
    }

    #[test]
    fn upsert_patches_only_some_fields() {
        let mut store = empty_store();
        upsert(&mut store, "/repo/a", 0, &patch_all(Some(true), Some("甲"), None, None));

        // 第二次只改 archived：pinned/title 必须原样保留。
        let entry = upsert(&mut store, "/repo/a", 0, &patch_all(None, None, Some(true), None));

        assert_eq!(store.entries.len(), 1, "同 (cwd, index) 应命中既有条目");
        assert!(entry.pinned, "未传的 pinned 保持原值");
        assert_eq!(entry.title.as_deref(), Some("甲"), "未传的 title 保持原值");
        assert!(entry.archived);
    }

    #[test]
    fn empty_title_clears_rename() {
        let mut store = empty_store();
        upsert(&mut store, "/repo/a", 0, &patch_all(None, Some("旧标题"), None, None));

        let cleared = upsert(&mut store, "/repo/a", 0, &patch_all(None, Some("  "), None, None));
        assert_eq!(cleared.title, None, "空标题等价于恢复默认（清除重命名）");

        let nulled = upsert(&mut store, "/repo/a", 0, &patch_all(None, Some("又改名"), None, None));
        assert_eq!(nulled.title.as_deref(), Some("又改名"));
        // title 字段缺失（None）同样不动原值。
        let kept = upsert(&mut store, "/repo/a", 0, &patch_all(None, None, None, None));
        assert_eq!(kept.title.as_deref(), Some("又改名"), "patch 缺 title 不应清掉旧值");
    }

    #[test]
    fn same_index_different_cwd_are_distinct_entries() {
        let mut store = empty_store();
        upsert(&mut store, "/repo/a", 0, &patch_all(Some(true), None, None, None));
        upsert(&mut store, "/repo/b", 0, &patch_all(None, None, Some(true), None));

        assert_eq!(store.entries.len(), 2, "(cwd, index) 才唯一，index 单独不唯一");
        assert!(store.entries[0].pinned);
        assert!(!store.entries[0].archived);
        assert!(store.entries[1].archived);
    }

    #[test]
    fn sorted_entries_is_deterministic() {
        let mut store = empty_store();
        upsert(&mut store, "/repo/b", 2, &patch_all(None, None, None, None));
        upsert(&mut store, "/repo/a", 7, &patch_all(None, None, None, None));
        upsert(&mut store, "/repo/a", 1, &patch_all(None, None, None, None));

        let rows = sorted_entries(&store);
        let keys: Vec<(&str, u32)> = rows.iter().map(|e| (e.cwd.as_str(), e.index)).collect();
        assert_eq!(keys, vec![("/repo/a", 1), ("/repo/a", 7), ("/repo/b", 2)]);
    }

    #[test]
    fn encode_uri_component_matches_browser_semantics() {
        // 未保留字符原样。
        assert_eq!(encode_uri_component("AZaz09-_.!~*'()"), "AZaz09-_.!~*'()");
        // 路径分隔符、查询残留字符、空格必须编码。
        assert_eq!(encode_uri_component("/a b&c#d?e"), "%2Fa%20b%26c%23d%3Fe");
        // 中文按 UTF-8 字节编码（与 encodeURIComponent 一致）。
        assert_eq!(encode_uri_component("项目"), "%E9%A1%B9%E7%9B%AE");
    }

    #[test]
    fn long_title_is_truncated_by_chars_not_bytes() {
        let mut store = empty_store();
        let long = "中".repeat(TITLE_MAX + 10);
        let entry = upsert(&mut store, "/repo/a", 0, &patch_all(None, Some(&long), None, None));

        assert_eq!(
            entry.title.as_deref().map(|t| t.chars().count()),
            Some(TITLE_MAX)
        );
    }
}
