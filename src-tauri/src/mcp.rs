use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, to_string_pretty, Value};
use tauri::{AppHandle, Manager, State};

use crate::state::{McpServer, McpState};

/// 工具名在内核白名单里的命名空间前缀：`<服务标识>__<工具名>`。
/// 同名工具来自不同 MCP server 时会撞名，命名空间是唯一能区分的手段。
pub const TOOL_PREFIX: &str = "mcp__";

/// 内核可见的工具全名。前端与连接器选择都用它，避免两处各拼一次前缀。
pub fn tool_fqn(server_name: &str, tool_name: &str) -> String {
    format!("{TOOL_PREFIX}{server_name}__{tool_name}")
}

fn rpc_call(
    tx: &mpsc::Sender<String>,
    state: &McpState,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    // id 取自全局单调源，跨 server 唯一，避免 pending 表错配响应。
    let id = state.next_id();
    let (resp_tx, resp_rx) = mpsc::channel();
    state.pending.lock().unwrap().insert(id, resp_tx);
    let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let body = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    tx.send(body).map_err(|e| e.to_string())?;
    let resp = resp_rx
        .recv_timeout(Duration::from_secs(20))
        .map_err(|e| format!("MCP 调用超时 {method}: {e}"))?;
    if let Some(err) = resp.get("error") {
        return Err(format!("MCP 错误 {method}: {err}"));
    }
    Ok(resp)
}

fn mcp_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("mcp.json"))
}

fn save(app: &AppHandle, state: &State<McpState>) -> Result<(), String> {
    let f = mcp_file(app)?;
    let guard = state.servers.lock().unwrap();
    let arr: Vec<Value> = guard
        .iter()
        .map(|(name, s)| json!({ "name": name, "command": s.command, "args": s.args }))
        .collect();
    fs::write(&f, to_string_pretty(&arr).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

pub fn load(app: &AppHandle, state: &State<McpState>) {
    if let Ok(f) = mcp_file(app) {
        if let Ok(s) = fs::read_to_string(&f) {
            if let Ok(v) = serde_json::from_str::<Vec<Value>>(&s) {
                for srv in v {
                    let name = srv.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let command = srv
                        .get("command")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let args = srv
                        .get("args")
                        .and_then(|x| x.as_array())
                        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                        .unwrap_or_default();
                    if !name.is_empty() && !command.is_empty() {
                        let _ = mcp_connect(name, command, args, app.clone(), state.clone());
                    }
                }
            }
        }
    }
}

/// 断开并移除进程。保留 `remains_enabled` 语义由调用方决定：
/// 重新连接时希望进程先死干净，停用/删除时希望状态落到 offline/disabled。
pub fn disconnect_inner(name: &str, state: &McpState) {
    if let Some(mut s) = state.servers.lock().unwrap().remove(name) {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}

/// 起一个 stdio 子进程、完成 initialize、取回 tools/list。
/// 传输层不做任何业务判断（title / serverName / 是否重名都由连接器域负责），
/// 这样 `connectors.rs` 的 CRUD 可以直接复用同一条握手路径。
pub fn spawn_and_handshake(
    name: &str,
    command: &str,
    args: &[String],
    state: &State<McpState>,
) -> Result<(Child, mpsc::Sender<String>, Vec<Value>), String> {
    // 先卸掉同名旧进程：重连时希望进程先死干净，避免两个进程抢同一个 server 名。
    disconnect_inner(name, state);

    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("启动 MCP server 失败: {e}"))?;
    let mut stdin = child.stdin.take().ok_or_else(|| "MCP 无 stdin".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "MCP 无 stdout".to_string())?;

    let (tx, rx) = mpsc::channel::<String>();
    let pending = state.pending.clone();

    std::thread::spawn(move || {
        for msg in rx {
            if stdin
                .write_all(msg.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
                .is_err()
            {
                break;
            }
        }
    });

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if let Some(id) = v.get("id").and_then(|x| x.as_u64()) {
                    if let Some(s) = pending.lock().unwrap().remove(&id) {
                        let _ = s.send(v);
                    }
                }
            }
        }
    });

    let proto = json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": { "name": "pi-workbench", "version": "0.1.0" }
    });
    let _init = rpc_call(&tx, &state, "initialize", proto)?;
    let tools_resp = rpc_call(&tx, &state, "tools/list", json!({}))?;
    let tools = tools_resp
        .get("result")
        .and_then(|r| r.get("tools"))
        .cloned()
        .unwrap_or(Value::Array(vec![]));
    let tools_vec: Vec<Value> = tools.as_array().cloned().unwrap_or_default();
    Ok((child, tx, tools_vec))
}

/// 注册到全局表并落盘。握手成功但注册表写入失败的 server 必须回滚，
/// 否则内存里没有、下次 list 也看不到，用户只会看到「连上了但工具没了」。
pub fn register(
    name: &str,
    child: Child,
    tx: mpsc::Sender<String>,
    tools: Vec<Value>,
    command: String,
    args: Vec<String>,
    app: &AppHandle,
    state: &State<McpState>,
) -> Result<(), String> {
    let server = McpServer::new(child, tx, tools, command, args);
    state.servers.lock().unwrap().insert(name.to_string(), server);
    save(app, state)
}

pub fn spawn_and_register(
    name: &str,
    command: &str,
    args: &[String],
    app: &AppHandle,
    state: &State<McpState>,
) -> Result<Vec<Value>, String> {
    let (child, tx, tools) = spawn_and_handshake(name, command, args, state)?;
    register(name, child, tx, tools.clone(), command.to_string(), args.to_vec(), app, state)?;
    Ok(tools)
}

#[tauri::command]
pub fn mcp_connect(
    name: String,
    command: String,
    args: Vec<String>,
    app: AppHandle,
    state: State<McpState>,
) -> Result<Value, String> {
    let tools = spawn_and_register(&name, &command, &args, &app, &state)?;
    Ok(json!({ "name": name, "tool_count": tools.len(), "tools": tools }))
}

/// 某个 server 当前被发现的原始工具名（不带 `mcp__` 前缀）。
pub fn server_tools(state: &McpState, server_name: &str) -> Vec<String> {
    let guard = state.servers.lock().unwrap();
    guard
        .get(server_name)
        .map(|s| {
            s.tools
                .iter()
                .filter_map(|t| {
                    t.get("name")
                        .or_else(|| t.get("function").and_then(|f| f.get("name")))
                        .and_then(|v| v.as_str())
                        .map(|n| n.to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 全部在线 server：服务标识 → 该服务的原始工具名列表。
pub fn servers_detail(state: &McpState) -> Vec<(String, Vec<String>)> {
    let guard = state.servers.lock().unwrap();
    guard
        .iter()
        .map(|(name, s)| {
            let tools = s
                .tools
                .iter()
                .filter_map(|t| {
                    t.get("name")
                        .or_else(|| t.get("function").and_then(|f| f.get("name")))
                        .and_then(|v| v.as_str())
                        .map(|n| n.to_string())
                })
                .collect();
            (name.clone(), tools)
        })
        .collect()
}

pub fn list_values(state: &McpState) -> Vec<Value> {
    let guard = state.servers.lock().unwrap();
    guard
        .iter()
        .map(|(name, s)| json!({ "name": name, "tool_count": s.tools.len(), "tools": s.tools }))
        .collect()
}

#[tauri::command]
pub fn mcp_list(state: State<McpState>) -> Vec<Value> {
    list_values(&state)
}

/// 调用一次 MCP 工具。
///
/// **必须 `async`**：`rpc_call` 会阻塞等待子进程响应（上限 20s），而非 async 的
/// Tauri 命令跑在主线程上——点一次工具就会把整个窗口冻住直到超时。
#[tauri::command(async)]
pub fn mcp_call(
    server: String,
    tool: String,
    arguments: String,
    state: State<McpState>,
) -> Result<Value, String> {
    let tx = {
        let guard = state.servers.lock().unwrap();
        guard.get(&server).map(|s| s.stdin_tx.clone())
    }
    .ok_or_else(|| "MCP server 未连接".to_string())?;
    let args_val: Value = serde_json::from_str(&arguments).unwrap_or(Value::Object(Default::default()));
    let resp = rpc_call(&tx, &state, "tools/call", json!({ "name": tool, "arguments": args_val }))?;
    Ok(resp.get("result").cloned().unwrap_or(resp))
}

#[tauri::command]
pub fn mcp_disconnect(name: String, app: AppHandle, state: State<McpState>) -> Result<(), String> {
    disconnect_inner(&name, &state);
    save(&app, &state)?;
    Ok(())
}

