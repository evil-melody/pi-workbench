/**
 * 连接器域。
 *
 * 职责边界：
 *   · 传输协议 / stdio 子进程 / tools/list 全在 `crate::mcp`，这一层不碰；
 *   · 这一层只管三件事：实例是什么（定义）、能不能用（健康）、这个会话能用哪些（选择）。
 *
 * 三条关键语义：
 *   1. 连接器实例是持久化的定义，内核侧连接是全局长驻的运行时，两者生命周期独立；
 *   2. serverName 全局唯一，重名直接拒绝（它决定工具命名空间 `mcp__<serverName>__<tool>`）；
 *   3. 停用 / 删除一个连接器，会把它从所有会话的选择里摘掉，
 *      否则会话会残留一个永远连不上的引用，内核白名单里也留了一堆叫不出名字的工具。
 */
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::mcp::{disconnect_inner, spawn_and_register, tool_fqn};
use crate::state::McpState;

const TITLE_MAX: usize = 80;
const DESCRIPTION_MAX: usize = 240;
const SERVER_NAME_MAX: usize = 32;
const COMMAND_MAX: usize = 1024;
const ARG_MAX: usize = 4096;
const ARGS_MAX: usize = 64;
const URL_MAX: usize = 2048;
/// 会话选择上限（会话选择 max(32)）。
const SELECTION_MAX: usize = 32;

const DEFINITIONS_FILE: &str = "connectors.json";
const SELECTIONS_FILE: &str = "connector-selections.json";
/// 早期版本写的是 `mcp.json`（裸数组），升级时从这里迁移。
const LEGACY_FILE: &str = "mcp.json";

// ── 领域模型 ──────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectorTransport {
    /// 子进程 stdio，唯一能真正握手成功的传输。
    #[default]
    Stdio,
    StreamableHttp,
}

/// 状态与传输都直接由 serde 序列化：加了 `as_str` 反而没人调用，
/// 而「前端拿到的是 kebab-case 字符串」这件事本来就该由 derive 保证。
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectorState {
    /// 已建进程，正在握手。
    Discovering,
    Ready,
    Offline,
    Disabled,
}

impl ConnectorState {
    /// 只有 Ready 才允许被会话选中：握手没拿到工具的连接器不该污染内核白名单。
    pub fn selectable(self) -> bool {
        self == ConnectorState::Ready
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectorDefinition {
    /// 自增 id：用户不关心，改 title 也不变，长期稳定。
    pub id: String,
    pub title: String,
    pub description: String,
    /// MCP 服务标识，决定工具命名空间，全局唯一。
    pub server_name: String,
    /// 老记录里没有这个字段，缺省按 stdio 处理：解析失败会让整条定义被静默丢掉。
    #[serde(default)]
    pub transport: ConnectorTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// 只记录「配过没配过令牌」，令牌本身不落这个文件。
    #[serde(default)]
    pub authorization_configured: bool,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

/// 编辑表单读回的视图：令牌是只写字段，任何读接口都不返回。
#[derive(Clone, Serialize)]
pub struct ConnectorConfigView {
    pub id: String,
    pub title: String,
    pub description: String,
    pub server_name: String,
    pub transport: ConnectorTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub authorization_configured: bool,
}

#[derive(Clone, Serialize)]
pub struct ConnectorSummary {
    pub id: String,
    pub title: String,
    pub description: String,
    pub server_name: String,
    pub transport: ConnectorTransport,
    pub enabled: bool,
    pub state: ConnectorState,
    pub tool_names: Vec<String>,
    pub tool_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

#[derive(Clone, Deserialize)]
pub struct ConnectorInput {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub server_name: String,
    #[serde(default)]
    pub transport: ConnectorTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// 只写：非空表示「更新凭据」，空表示保持不变。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_token: Option<String>,
}

#[derive(Clone, Default)]
pub struct ConnectorStore {
    pub definitions: Vec<ConnectorDefinition>,
    pub selections: HashMap<String, Vec<String>>,
}

// ── 存储 ──────────────────────────────────────────────────────

fn store_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

fn decode_definitions(raw: &Value) -> Vec<ConnectorDefinition> {
    let rows = raw
        .get("definitions")
        .and_then(|v| v.as_array())
        .or_else(|| raw.as_array())
        .cloned()
        .unwrap_or_default();
    rows
        .iter()
        .filter_map(|row| serde_json::from_value::<ConnectorDefinition>(row.clone()).ok())
        .collect()
}

fn decode_selections(raw: &Value) -> HashMap<String, Vec<String>> {
    let mut out = HashMap::new();
    // 兼容两种键名：selections（新）/ sessionSelections（更早一版）。
    for key in ["selections", "sessionSelections"] {
        if let Some(obj) = raw.get(key).and_then(|v| v.as_object()) {
            for (session, ids) in obj {
                if let Some(arr) = ids.as_array() {
                    out.insert(
                        session.clone(),
                        arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect(),
                    );
                }
            }
        }
    }
    out
}

fn decode_store(text: &str) -> Option<ConnectorStore> {
    let raw: Value = serde_json::from_str(text).ok()?;
    Some(ConnectorStore {
        definitions: decode_definitions(&raw),
        selections: decode_selections(&raw),
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// 迁移：早期 `mcp.json` 是裸数组 `[{name, command, args}]`，
/// 不迁移的话升级后用户已配好的 MCP 服务会凭空消失。
fn migrate_from_legacy(app: &AppHandle) -> ConnectorStore {
    let Ok(path) = store_file(app, LEGACY_FILE) else {
        return ConnectorStore::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return ConnectorStore::default();
    };
    let Ok(rows) = serde_json::from_str::<Vec<Value>>(&text) else {
        return ConnectorStore::default();
    };
    let mut store = ConnectorStore::default();
    for (i, row) in rows.iter().enumerate() {
        let name = row.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let command = row
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() || command.is_empty() {
            continue;
        }
        let args = row
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        let now = now_ms();
        let server_name = sanitize_server_name(&name);
        store.definitions.push(ConnectorDefinition {
            id: format!("mcp-{server_name}-{i}"),
            title: name.clone(),
            description: String::new(),
            server_name,
            transport: ConnectorTransport::Stdio,
            command: Some(command),
            args: Some(args),
            url: None,
            authorization_configured: false,
            enabled: true,
            created_at: now,
            updated_at: now,
        });
    }
    store
}

pub fn load_store(app: &AppHandle) -> ConnectorStore {
    if let Ok(p) = store_file(app, DEFINITIONS_FILE) {
        if let Ok(text) = fs::read_to_string(&p) {
            if let Some(store) = decode_store(&text) {
                return store;
            }
        }
    }
    migrate_from_legacy(app)
}

pub fn save_store(app: &AppHandle, store: &ConnectorStore) -> Result<(), String> {
    let p = store_file(app, DEFINITIONS_FILE)?;
    fs::write(
        &p,
        serde_json::to_string_pretty(&json!({ "definitions": store.definitions })).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let sp = store_file(app, SELECTIONS_FILE)?;
    fs::write(&sp, serde_json::to_string_pretty(&json!(store.selections)).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── 校验 ──────────────────────────────────────────────────────

/// 服务标识只允许 `[A-Za-z0-9_-]`：它直接拼进工具命名空间，
/// 一旦带点号或斜杠，内核解析工具名时的分隔符就会歧义。
fn sanitize_server_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        // 空格改成连字符而不是直接丢掉：丢掉会让 "GitHub MCP" 变成 "GitHubMCP" 这种
        // 看不出原本意思的名字，改成连字符既安全又可读。
        .flat_map(|c| if c == ' ' { Some('-') } else { Some(c) })
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(SERVER_NAME_MAX)
        .collect();
    cleaned.trim_matches(|c| c == '-' || c == '_').to_string()
}

fn validate_input(input: &ConnectorInput) -> Result<(), String> {
    if input.title.trim().is_empty() {
        return Err("connector/title-required".into());
    }
    if input.title.chars().count() > TITLE_MAX {
        return Err("connector/title-too-long".into());
    }
    if input.description.chars().count() > DESCRIPTION_MAX {
        return Err("connector/description-too-long".into());
    }
    if sanitize_server_name(&input.server_name).is_empty() {
        return Err("connector/server-name-invalid".into());
    }
    match input.transport {
        ConnectorTransport::Stdio => {
            let command = input.command.as_deref().unwrap_or("").trim();
            if command.is_empty() {
                return Err("connector/command-required".into());
            }
            if command.len() > COMMAND_MAX {
                return Err("connector/command-too-long".into());
            }
            let args = input.args.clone().unwrap_or_default();
            if args.len() > ARGS_MAX {
                return Err("connector/args-too-many".into());
            }
            if args.iter().any(|a| a.len() > ARG_MAX) {
                return Err("connector/arg-too-long".into());
            }
        }
        ConnectorTransport::StreamableHttp => {
            let url = input.url.as_deref().unwrap_or("").trim();
            if url.is_empty() {
                return Err("connector/url-required".into());
            }
            if url.len() > URL_MAX || !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err("connector/url-invalid".into());
            }
        }
    }
    Ok(())
}

fn assert_unique_server(store: &ConnectorStore, server_name: &str, except_id: Option<&str>) -> Result<(), String> {
    let hit = store
        .definitions
        .iter()
        .any(|d| d.server_name == server_name && Some(d.id.as_str()) != except_id);
    if hit {
        return Err(format!("connector/server-name-conflict: {server_name}"));
    }
    Ok(())
}

// ── 运行时 ────────────────────────────────────────────────────

#[derive(Clone)]
struct Runtime {
    state: ConnectorState,
    diagnostic: Option<String>,
}

static RUNTIMES: OnceLock<Mutex<HashMap<String, Runtime>>> = OnceLock::new();

fn runtimes() -> &'static Mutex<HashMap<String, Runtime>> {
    RUNTIMES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn runtime(id: &str) -> Runtime {
    runtimes()
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .unwrap_or_else(|| Runtime {
            state: ConnectorState::Disabled,
            diagnostic: None,
        })
}

fn set_runtime(id: &str, state: ConnectorState, diagnostic: Option<String>) {
    runtimes().lock().unwrap().insert(
        id.to_string(),
        Runtime { state, diagnostic },
    );
}

/// 把定义落到运行时上：停用 → disabled；非 stdio → offline 并给诊断；
/// stdio → 真起进程握手。握手是本地进程通信（几十毫秒），同步做，
/// 异步化只会让调用方更难处理「连上了还是没连上」。
fn apply_definition(dev: &ConnectorDefinition, app: &AppHandle, mcp: &State<McpState>) {
    if !dev.enabled {
        disconnect_inner(&dev.server_name, mcp);
        set_runtime(&dev.id, ConnectorState::Disabled, None);
        return;
    }
    if dev.transport != ConnectorTransport::Stdio {
        // 落库但不假装已连接：列表里直接显示「连接异常」并给出诊断，
        // 好过静默连不上、用户以为是界面坏了。
        set_runtime(
            &dev.id,
            ConnectorState::Offline,
            Some("streamable-http 传输尚未接入，当前只支持 stdio 进程".into()),
        );
        return;
    }
    let command = dev.command.clone().unwrap_or_default();
    let args = dev.args.clone().unwrap_or_default();
    set_runtime(&dev.id, ConnectorState::Discovering, None);
    match spawn_and_register(&dev.server_name, &command, &args, app, mcp) {
        Ok(_) => set_runtime(&dev.id, ConnectorState::Ready, None),
        Err(e) => {
            set_runtime(&dev.id, ConnectorState::Offline, Some(e));
        }
    }
}

/// 启动时恢复：把已启用的连接器重新握手一遍。
/// 不恢复的话，重启应用后所有连接器都停在 Disabled，列表明明在却一个都选不了。
pub fn restore(app: &AppHandle, state: &ConnectorRuntimeState, mcp: &State<McpState>) {
    let definitions: Vec<ConnectorDefinition> = state.store.lock().unwrap().definitions.clone();
    for dev in definitions {
        apply_definition(&dev, app, mcp);
    }
}

fn summary_of(dev: &ConnectorDefinition, mcp: &State<McpState>) -> Result<ConnectorSummary, String> {
    let rt = runtime(&dev.id);
    let tool_names: Vec<String> = crate::mcp::server_tools(mcp, &dev.server_name)
        .into_iter()
        .map(|name| tool_fqn(&dev.server_name, &name))
        .collect();
    let state = if !dev.enabled {
        ConnectorState::Disabled
    } else if rt.state == ConnectorState::Ready && !tool_names.is_empty() {
        ConnectorState::Ready
    } else {
        rt.state
    };
    // 先算数量再移交所有权：结构体里放的是名字，计数是同一个 Vec 的长。
    let tool_count = tool_names.len();
    Ok(ConnectorSummary {
        id: dev.id.clone(),
        title: dev.title.clone(),
        description: dev.description.clone(),
        server_name: dev.server_name.clone(),
        transport: dev.transport,
        enabled: dev.enabled,
        state,
        tool_count,
        tool_names,
        diagnostic: rt.diagnostic.clone(),
    })
}

// ── 命令 ──────────────────────────────────────────────────────

#[tauri::command]
#[allow(non_snake_case)]
pub fn connectors_list(state: State<ConnectorRuntimeState>, mcp: State<McpState>) -> Vec<ConnectorSummary> {
    let store = state.store.lock().unwrap();
    let mut out: Vec<ConnectorSummary> = Vec::new();
    for dev in store.definitions.iter() {
        if let Ok(s) = summary_of(dev, &mcp) {
            out.push(s);
        }
    }
    out.sort_by(|a, b| a.title.cmp(&b.title));
    out
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn connectors_config(
    id: String,
    state: State<ConnectorRuntimeState>,
) -> Result<ConnectorConfigView, String> {
    let store = state.store.lock().unwrap();
    let dev = store
        .definitions
        .iter()
        .find(|d| d.id == id)
        .ok_or_else(|| "connector/not-found".to_string())?
        .clone();
    Ok(ConnectorConfigView {
        id: dev.id,
        title: dev.title,
        description: dev.description,
        server_name: dev.server_name,
        transport: dev.transport,
        command: dev.command,
        args: dev.args,
        url: dev.url,
        authorization_configured: dev.authorization_configured,
    })
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn connectors_create(
    input: ConnectorInput,
    app: AppHandle,
    state: State<ConnectorRuntimeState>,
    mcp: State<McpState>,
) -> Result<ConnectorSummary, String> {
    validate_input(&input)?;
    let server_name = sanitize_server_name(&input.server_name);
    let now = now_ms();
    {
        let store = state.store.lock().unwrap();
        assert_unique_server(&store, &server_name, None)?;
    }
    let base = server_name.clone();
    let mut id = base.clone();
    let mut seq = 2u64;
    {
        let store = state.store.lock().unwrap();
        while store.definitions.iter().any(|d| d.id == id) {
            id = format!("{base}-{seq}");
            seq += 1;
        }
    }
    let dev = ConnectorDefinition {
        id: id.clone(),
        title: input.title.trim().to_string(),
        description: input.description.trim().to_string(),
        server_name,
        transport: input.transport,
        command: input.command.map(|c| c.trim().to_string()),
        args: input.args,
        url: input.url.map(|u| u.trim().to_string()),
        authorization_configured: input
            .authorization_token
            .as_deref()
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false),
        enabled: true,
        created_at: now,
        updated_at: now,
    };
    {
        let mut store = state.store.lock().unwrap();
        store.definitions.push(dev.clone());
        save_store(&app, &store)?;
    }
    apply_definition(&dev, &app, &mcp);
    summary_of(&dev, &mcp)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn connectors_update(
    id: String,
    input: ConnectorInput,
    app: AppHandle,
    state: State<ConnectorRuntimeState>,
    mcp: State<McpState>,
) -> Result<ConnectorSummary, String> {
    validate_input(&input)?;
    let server_name = sanitize_server_name(&input.server_name);
    let dev = {
        let store = state.store.lock().unwrap();
        assert_unique_server(&store, &server_name, Some(&id))?;
        let current = store
            .definitions
            .iter()
            .find(|d| d.id == id)
            .ok_or_else(|| "connector/not-found".to_string())?
            .clone();
        // 服务标识变了 = 换了命名空间：旧进程必须下线，
        // 否则旧工具名还留在内核白名单里，会调到一个已经不存在的服务。
        if current.server_name != server_name {
            disconnect_inner(&current.server_name, &mcp);
        }
        let next = ConnectorDefinition {
            id: current.id.clone(),
            title: input.title.trim().to_string(),
            description: input.description.trim().to_string(),
            server_name,
            transport: input.transport,
            command: input.command.map(|c| c.trim().to_string()),
            args: input.args,
            url: input.url.map(|u| u.trim().to_string()),
            authorization_configured: if input
                .authorization_token
                .as_deref()
                .map(|t| !t.trim().is_empty())
                .unwrap_or(false)
            {
                true
            } else {
                current.authorization_configured
            },
            enabled: current.enabled,
            created_at: current.created_at,
            updated_at: now_ms(),
        };
        let mut next_store = store.clone();
        if let Some(slot) = next_store.definitions.iter_mut().find(|d| d.id == id) {
            *slot = next.clone();
        }
        save_store(&app, &next_store)?;
        *state.store.lock().unwrap() = next_store;
        next
    };
    apply_definition(&dev, &app, &mcp);
    summary_of(&dev, &mcp)
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn connectors_remove(
    id: String,
    app: AppHandle,
    state: State<ConnectorRuntimeState>,
    mcp: State<McpState>,
) -> Result<(), String> {
    let dev = {
        let store = state.store.lock().unwrap();
        let dev = store
            .definitions
            .iter()
            .find(|d| d.id == id)
            .ok_or_else(|| "connector/not-found".to_string())?
            .clone();
        let mut next = store.clone();
        next.definitions.retain(|d| d.id != id);
        // 关键一步：把该连接器从所有会话的选择里摘掉。
        // 只删定义不摘选择，会话就会留着一个指向不存在 id 的引用。
        for ids in next.selections.values_mut() {
            ids.retain(|sid| sid != &dev.server_name);
        }
        drop(store);
        save_store(&app, &next)?;
        *state.store.lock().unwrap() = next;
        dev
    };
    disconnect_inner(&dev.server_name, &mcp);
    set_runtime(&dev.id, ConnectorState::Disabled, None);
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn connectors_set_enabled(
    id: String,
    enabled: bool,
    app: AppHandle,
    state: State<ConnectorRuntimeState>,
    mcp: State<McpState>,
) -> Result<ConnectorSummary, String> {
    let dev = {
        let store = state.store.lock().unwrap();
        let mut dev = store
            .definitions
            .iter()
            .find(|d| d.id == id)
            .ok_or_else(|| "connector/not-found".to_string())?
            .clone();
        if dev.enabled == enabled {
            return summary_of(&dev, &mcp);
        }
        dev.enabled = enabled;
        dev.updated_at = now_ms();
        let mut next = store.clone();
        if let Some(slot) = next.definitions.iter_mut().find(|d| d.id == id) {
            *slot = dev.clone();
        }
        drop(store);
        save_store(&app, &next)?;
        *state.store.lock().unwrap() = next;
        dev
    };
    if !enabled {
        disconnect_inner(&dev.server_name, &mcp);
        // 停用即断连，同时从所有会话选择里摘掉：
        // 停用的连接器不对任何会话可用。
        let store = state.store.lock().unwrap();
        let mut next = store.clone();
        for ids in next.selections.values_mut() {
            ids.retain(|sid| sid != &dev.server_name);
        }
        drop(store);
        save_store(&app, &next)?;
        *state.store.lock().unwrap() = next;
    }
    apply_definition(&dev, &app, &mcp);
    summary_of(&dev, &mcp)
}

// ── 会话级选择 ────────────────────────────────────────────────

#[tauri::command]
#[allow(non_snake_case)]
pub fn connectors_selection(state: State<ConnectorRuntimeState>, sessionId: String) -> Vec<String> {
    state
        .store
        .lock()
        .unwrap()
        .selections
        .get(&sessionId)
        .cloned()
        .unwrap_or_default()
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn connectors_set_selection(
    sessionId: String,
    connectorIds: Vec<String>,
    state: State<ConnectorRuntimeState>,
) -> Result<Vec<String>, String> {
    let unique = dedup_limit(connectorIds);
    if unique.len() > SELECTION_MAX {
        return Err(format!("connector/selection-limit-exceeded（上限 {SELECTION_MAX}）"));
    }
    {
        let store = state.store.lock().unwrap();
        for id in &unique {
            let dev = store
                .definitions
                .iter()
                .find(|d| d.id == *id)
                .ok_or_else(|| format!("connector/not-found: {id}"))?;
            if !dev.enabled {
                return Err(format!("connector/disabled: {id}"));
            }
            // 只有握手成功且真的拿到工具的连接器才能被选中：
            // 否则内核第一轮就会拿到一批叫不出名字的工具。
            if !runtime(&dev.id).state.selectable() {
                return Err(format!("connector/not-ready: {id}"));
            }
        }
    }
    let mut store = state.store.lock().unwrap();
    store.selections.insert(sessionId.clone(), unique.clone());
    Ok(unique)
}

/// 先去重再判上限：不去重的话 `[a, a, …×100]` 能绕过 max(32)。
fn dedup_limit(ids: Vec<String>) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        if unique.iter().any(|x| x == &id) {
            continue;
        }
        unique.push(id);
    }
    unique.truncate(SELECTION_MAX);
    unique
}

/// 会话最终对内核可见的工具名。
///
/// 会话选择不是「记一下」而是真的改变注入内核的白名单：
/// 属于「已启用但本会话未选中」连接器的工具会被摘掉，
/// 但不属于任何已知连接器的 `mcp__*` 孤儿工具保留（那是用户手动勾选的）。
pub fn tool_scope_for(
    app: &AppHandle,
    state: &ConnectorRuntimeState,
    mcp: &McpState,
    session_id: &str,
) -> Vec<String> {
    let base = crate::tools::active_tools(app);
    scope_for(&base, state, mcp, session_id)
}

/// 作用域计算的纯粹语义，与 AppHandle 无关，便于单测覆盖。
///
/// `base` 是内核当前白名单：属于「已启用但本会话未选中」连接器的工具会被摘掉，
/// 但不属于任何已知连接器的 `mcp__*` 孤儿工具保留（那是用户手动勾的）。
fn scope_for(
    base: &[String],
    state: &ConnectorRuntimeState,
    mcp: &McpState,
    session_id: &str,
) -> Vec<String> {
    let guard = state.store.lock().unwrap();
    let known_servers: HashSet<String> = guard
        .definitions
        .iter()
        .filter(|d| d.enabled)
        .map(|d| d.server_name.clone())
        .collect();
    let selected = guard.selections.get(session_id).cloned().unwrap_or_default();
    let selected_servers: HashSet<String> = guard
        .definitions
        .iter()
        .filter(|d| selected.contains(&d.id))
        .map(|d| d.server_name.clone())
        .collect();
    drop(guard);

    let mut out: Vec<String> = Vec::new();
    for tool in base {
        let server = tool_server(tool);
        // 摘掉的条件是「这个服务属于某个启用的连接器，但本会话没选中它」。
        // 反过来，用户手勾的孤儿工具不属于任何连接器，必须原样保留。
        let dropped = match server {
            Some(s) if !selected_servers.contains(&s) => known_servers.contains(&s),
            _ => false,
        };
        if !dropped {
            out.push(tool.clone());
        }
    }
    for (server, tools) in crate::mcp::servers_detail(mcp) {
        if !selected_servers.contains(&server) {
            continue;
        }
        for name in tools {
            let fqn = tool_fqn(&server, &name);
            if !out.iter().any(|x| x == &fqn) {
                out.push(fqn);
            }
        }
    }
    out.sort();
    out
}

/// 从全名里反推服务标识：`mcp__<server>__<tool>`。
fn tool_server(fqn: &str) -> Option<String> {
    let rest = fqn.strip_prefix("mcp__")?;
    let idx = rest.find("__")?;
    Some(rest[..idx].to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn connectors_apply_scope(
    app: AppHandle,
    sessionId: String,
    state: State<ConnectorRuntimeState>,
    mcp: State<McpState>,
) -> Result<Vec<String>, String> {
    let scope = tool_scope_for(&app, &state, &mcp, &sessionId);
    crate::tools::write_active(&app, &scope)?;
    Ok(scope)
}

// ── 应用状态 ──────────────────────────────────────────────────

#[derive(Default)]
pub struct ConnectorRuntimeState {
    pub store: Mutex<ConnectorStore>,
}

// ── 测试 ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn input(title: &str, server: &str) -> ConnectorInput {
        ConnectorInput {
            title: title.into(),
            description: String::new(),
            server_name: server.into(),
            transport: ConnectorTransport::Stdio,
            command: Some("node".into()),
            args: Some(vec!["server.mjs".into()]),
            url: None,
            authorization_token: None,
        }
    }

    fn sample(name: &str) -> ConnectorDefinition {
        ConnectorDefinition {
            id: name.to_string(),
            title: name.to_string(),
            description: String::new(),
            server_name: name.to_string(),
            transport: ConnectorTransport::Stdio,
            command: Some("node".into()),
            args: Some(vec!["server.mjs".into()]),
            url: None,
            authorization_configured: false,
            enabled: true,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn server_name_keeps_only_namespace_safe_characters() {
        assert_eq!(sanitize_server_name("GitHub MCP."), "GitHub-MCP");
        assert_eq!(sanitize_server_name("my server/tools"), "my-servertools");
    }

    #[test]
    fn server_name_strips_leading_and_trailing_separators() {
        assert_eq!(sanitize_server_name("--my-server--"), "my-server")
    }

    #[test]
    fn empty_server_name_is_rejected() {
        let mut bad = input("名称", "!!!");
        assert_eq!(validate_input(&bad), Err("connector/server-name-invalid".to_string()));
        bad.server_name = String::new();
        assert_eq!(validate_input(&bad), Err("connector/server-name-invalid".to_string()));
    }

    #[test]
    fn stdio_without_command_is_rejected() {
        let mut bad = input("名称", "srv");
        bad.command = Some(String::new());
        assert_eq!(validate_input(&bad), Err("connector/command-required".to_string()));
    }

    #[test]
    fn streamable_http_without_valid_url_is_rejected() {
        let mut bad = input("名称", "srv");
        bad.transport = ConnectorTransport::StreamableHttp;
        bad.command = None;
        bad.url = Some(String::new());
        assert_eq!(validate_input(&bad), Err("connector/url-required".to_string()));
        bad.url = Some("file:///tmp/mcp".into());
        assert_eq!(validate_input(&bad), Err("connector/url-invalid".to_string()));
    }

    #[test]
    fn duplicate_server_name_is_rejected_except_for_self() {
        let store = ConnectorStore {
            definitions: vec![sample("alpha")],
            selections: HashMap::new(),
        };
        assert!(assert_unique_server(&store, "alpha", None).is_err());
        // 改自己时允许同名，否则「只改个描述」都会被拒。
        assert!(assert_unique_server(&store, "alpha", Some("alpha")).is_ok());
        assert!(assert_unique_server(&store, "beta", None).is_ok());
    }

    #[test]
    fn tool_server_recovers_the_namespace_from_a_fqn() {
        assert_eq!(
            tool_server(&tool_fqn("github", "search_code")),
            Some("github".to_string())
        );
        assert_eq!(tool_server("read"), None);
        assert_eq!(tool_server("mcp__oops"), None);
    }

    #[test]
    fn selections_survive_decode_from_either_key_name() {
        let raw: Value = serde_json::from_str(
            r#"{"definitions":[],"selections":{"s1":["a"]}}"#,
        )
        .unwrap();
        let store = decode_store(&raw.to_string()).unwrap();
        assert_eq!(store.selections.get("s1"), Some(&vec!["a".to_string()]));

        let raw2: Value = serde_json::from_str(
            r#"{"definitions":[],"sessionSelections":{"s9":["b","c"]}}"#,
        )
        .unwrap();
        let store2 = decode_store(&raw2.to_string()).unwrap();
        assert_eq!(store2.selections.get("s9"), Some(&vec!["b".to_string(), "c".to_string()]));
    }

    /// 早期 `mcp.json` 存的是裸数组：解码必须同时接受「有包一层 definitions」和「裸数组」两种形状。
    #[test]
    fn definitions_decode_from_wrapped_or_bare_array() {
        // 字段与 save_store 落盘的形状一致（transport / enabled / 时间戳都有默认值）。
        let a = r#"{"id":"a","title":"A","description":"","server_name":"a","enabled":true}"#;
        let b = r#"{"id":"b","title":"B","description":"","server_name":"b","enabled":true}"#;
        let wrapped: Value = serde_json::from_str(&format!("{{\"definitions\":[{a}]}}")).unwrap();
        let bare: Value = serde_json::from_str(&format!("[{b}]")).unwrap();
        assert_eq!(decode_definitions(&wrapped).len(), 1);
        assert_eq!(decode_definitions(&bare).len(), 1);
        assert!(decode_definitions(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn selection_dedups_before_hitting_the_cap() {
        let many: Vec<String> = (0..50).map(|i| format!("id-{i}")).collect();
        let capped = dedup_limit(many);
        assert_eq!(capped.len(), SELECTION_MAX, "不去重的话重复项能绕过上限");

        let dupes = dedup_limit(vec!["a".into(), "a".into(), "b".into(), "a".into()]);
        assert_eq!(dupes, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn only_handshaked_connectors_are_selectable() {
        assert!(!ConnectorState::Disabled.selectable());
        assert!(!ConnectorState::Offline.selectable());
        assert!(ConnectorState::Ready.selectable());
    }

    /// 作用域的核心语义：
    ///  · 启用但未选中的连接器，它的工具要从白名单里摘掉；
    ///  · 不属于任何连接器的 `mcp__*` 孤儿工具必须原样保留；
    ///  · 已选中的连接器，在线工具补齐进来。
    #[test]
    fn scope_drops_unselected_connector_tools_and_keeps_orphans() {
        let mut store = ConnectorStore::default();
        store.definitions.push(ConnectorDefinition {
            id: "c1".into(),
            title: "已启用未选中".into(),
            description: String::new(),
            server_name: "alpha".into(),
            transport: ConnectorTransport::Stdio,
            command: None,
            args: None,
            url: None,
            authorization_configured: false,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        });
        store.definitions.push(ConnectorDefinition {
            id: "c2".into(),
            title: "已启用已选中".into(),
            description: String::new(),
            server_name: "beta".into(),
            transport: ConnectorTransport::Stdio,
            command: None,
            args: None,
            url: None,
            authorization_configured: false,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        });
        store.selections.insert("s1".into(), vec!["c2".to_string()]);
        let state = ConnectorRuntimeState {
            store: Mutex::new(store),
        };

        let mcp = McpState::default();
        let base = vec![
            "read".to_string(),
            tool_fqn("alpha", "hidden"),
            tool_fqn("beta", "shown"),
            tool_fqn("orphan", "manual"),
        ];
        let scope = scope_for(&base, &state, &mcp, "s1");

        assert!(scope.contains(&"read".to_string()), "内置工具必须保留");
        assert!(
            !scope.contains(&tool_fqn("alpha", "hidden")),
            "启用但未选中 → 摘掉"
        );
        assert!(
            scope.contains(&tool_fqn("beta", "shown")),
            "选中了 → 工具名进白名单"
        );
        assert!(
            scope.contains(&tool_fqn("orphan", "manual")),
            "孤儿工具类必须保留"
        );
        let sorted = {
            let mut c = scope.clone();
            c.sort();
            c
        };
        assert_eq!(scope, sorted, "作用域必须稳定排序");
    }
}
