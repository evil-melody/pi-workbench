use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{MutexGuard, TryLockError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::pi_events;
use crate::state::PiState;

/// 单条 RPC 的默认等待上限。
///
/// 走 `pi_call` 的全是控制面命令（`get_tree` / `fork` / `set_thinking_level`），
/// 都是毫秒级；真正的 agent 轮次走 `pi_send` 的流式通道，不经过这里。
/// 原先按「agent 一轮可能数分钟」定成 120s，导致内核无响应时界面最长冻结两分钟。
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Unix 毫秒时间戳，供事件元信息打点。
fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 解析结果：可执行文件位置 + 探测轨迹（诊断/报错用）。
pub struct PiBin {
    pub path: PathBuf,
    /// 探测过的绝对路径清单，报错时回显给用户，避免「只说没找到」。
    pub probed: Vec<String>,
}

/// 常见安装目录：npm 全局 / Homebrew / 版本化 Node 管理器。
///
/// 桌面进程（macOS GUI）的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，
/// 而 `pi` 往往装在 `~/.workbuddy/binaries/node/versions/*/bin` 这类目录里
/// —— 外壳里 `which pi` 有结果，App 里 `Command::new("pi")` 却直接 spawn 失败，
/// 表现为「回车/点发送毫无反应」。所以必须按绝对路径探测，不能只依赖 PATH。
fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        // 版本化目录：一层通配展开，命中当前装着的每个 Node 版本。
        for rel in [
            ".workbuddy/binaries/node/versions",
            ".nvm/versions/node",
            ".local/share/fnm/node-versions",
            ".local/share/nvm/versions/node",
        ] {
            if let Ok(entries) = fs::read_dir(home.join(rel)) {
                for e in entries.flatten() {
                    dirs.push(e.path().join("bin"));
                }
            }
        }
        for rel in [
            ".npm-global/bin",
            ".local/bin",
            ".bun/bin",
            ".volta/bin",
            ".cargo/bin",
            ".yarn/bin",
            "Library/pnpm",
        ] {
            dirs.push(home.join(rel));
        }
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/opt/local/bin"));
    dirs
}

/// 路径是否是可执行文件：存在 + 是普通文件 +（符号链接 / 有可执行位）。
///
/// npm 装的 bin 几乎都是 symlink，链接目标的执行位未必齐全（靠 shebang 执行），
/// 所以 symlink 直接放行，只对普通文件校验可执行位。
fn is_executable(p: &Path) -> bool {
    let Ok(m) = fs::metadata(p) else {
        return false;
    };
    if !m.is_file() {
        return false;
    }
    if fs::symlink_metadata(p)
        .map(|sm| sm.file_type().is_symlink())
        .unwrap_or(false)
    {
        return true;
    }
    executable_bit(&m)
}

#[cfg(unix)]
fn executable_bit(m: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode() & 0o111 != 0
}

/// Windows 没有可执行位概念，扩展名决定可执行性，这里只要求它是文件。
#[cfg(not(unix))]
fn executable_bit(_m: &fs::Metadata) -> bool {
    true
}

/// 按顺序定位 pi：设置里的显式路径 → `PI_BIN` 环境变量 → 常见安装目录 → PATH。
pub fn resolve_pi_bin(app: &AppHandle) -> Result<PiBin, String> {
    let mut probed: Vec<String> = Vec::new();

    let configured = crate::models::settings_load(app.clone()).pi_bin;
    if let Some(raw) = configured.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(raw);
        probed.push(p.display().to_string());
        if is_executable(&p) {
            return Ok(PiBin { path: p, probed });
        }
        return Err(format!(
            "设置里指定的 Pi 路径不可执行：{}（请到「设置」重新选择 pi 可执行文件）",
            p.display()
        ));
    }

    if let Ok(raw) = std::env::var("PI_BIN") {
        let p = PathBuf::from(raw.trim());
        probed.push(p.display().to_string());
        if is_executable(&p) {
            return Ok(PiBin { path: p, probed });
        }
    }

    if let Some(p) = probe_pi() {
        probed.push(p.display().to_string());
        return Ok(PiBin { path: p, probed });
    }

    let shown: Vec<&String> = probed.iter().rev().take(6).collect();
    Err(format!(
        "未找到 pi 可执行文件（已探测 {} 处，例如 {}）。请到「设置 → Pi 可执行文件」指定绝对路径，或用 npm i -g @earendil-works/pi-coding-agent 安装。",
        probed.len(),
        shown.iter().rev().map(|s| s.as_str()).collect::<Vec<_>>().join("、")
    ))
}

/// 不依赖 AppHandle 的纯探测：常见安装目录 → PATH。抽出来是为了能单测。
fn probe_pi() -> Option<PathBuf> {
    for dir in candidate_dirs() {
        let p = dir.join("pi");
        if is_executable(&p) {
            return Some(p);
        }
    }
    if let Ok(paths) = std::env::var("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join("pi");
            if is_executable(&p) {
                return Some(p);
            }
        }
    }
    None
}

/// 子进程 PATH：pi 所在目录 + 常见 Node 目录 + 原 PATH。
///
/// pi 多数是 `#!/usr/bin/env node` 的 JS 包装，只把 pi 找到还不够——
/// shebang 里的 `env node` 用的是子进程的 PATH，桌面进程那份同样缺 Node 目录。
fn pi_path_env(bin_dir: &Path) -> String {
    let mut parts: Vec<String> = vec![bin_dir.display().to_string()];
    for d in candidate_dirs() {
        if d.is_dir() {
            parts.push(d.display().to_string());
        }
    }
    // 原 PATH 要拆成目录再合并：整串塞进来会让去重失效（整串 ≠ 单个目录）。
    if let Ok(p) = std::env::var("PATH") {
        for d in std::env::split_paths(&p) {
            parts.push(d.display().to_string());
        }
    }
    let mut seen = std::collections::HashSet::new();
    parts.retain(|p| seen.insert(p.clone()));
    parts.join(":")
}

/// 内核可用性自检：给 UI 与排障用，不启动子进程。
#[derive(Serialize)]
pub struct PiDoctor {
    pub found: bool,
    pub path: Option<String>,
    pub probed: usize,
    pub error: Option<String>,
}

/// **必须 async**：内部做多轮目录遍历与文件 stat，不占用主线程。
#[tauri::command(async)]
pub fn pi_doctor(app: AppHandle) -> PiDoctor {
    match resolve_pi_bin(&app) {
        Ok(bin) => PiDoctor {
            found: true,
            path: Some(bin.path.display().to_string()),
            probed: bin.probed.len(),
            error: None,
        },
        Err(e) => PiDoctor {
            found: false,
            path: None,
            probed: 0,
            error: Some(e),
        },
    }
}

/// 启动 Pi 子进程（RPC 模式），桥接 stdin/stdout 到前端事件 / 命令响应。
///
/// 常驻语义：启动签名（cwd + provider + model）不变时直接复用已在跑的子进程。
/// Pi 的 cwd 在进程启动时固定、协议里没有 set_cwd，所以同项目内反复调用是空操作，
/// 只有换项目 / 换模型才真正重启——既省掉重复拉起 Node 的开销，也不会丢掉会话。
///
/// **必须 async**：函数体里有 `spawn` / `stop_child`（kill + wait）这类进程操作，
/// 非 async 命令跑在主线程上，任何一步慢（Node 冷启动、子进程退出回收）都会
/// 冻住整个窗口——与 `pi_call` 同一教训。
#[tauri::command(async)]
pub fn pi_start(app: AppHandle, cwd: Option<String>, state: State<PiState>) -> Result<(), String> {
    let agent_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("取配置目录失败: {e}"))?;
    let launch = crate::models::pi_model_launch(&app);

    let sig = format!(
        "{}|{}|{}",
        cwd.as_deref().unwrap_or(""),
        launch.as_ref().map(|l| l.provider.as_str()).unwrap_or(""),
        launch.as_ref().map(|l| l.model.as_str()).unwrap_or(""),
    );
    if reuse_child(&state, &sig) {
        return Ok(());
    }
    stop_child(&state);

    let bin = resolve_pi_bin(&app)?;
    let mut cmd = Command::new(&bin.path);
    // 子进程 PATH 必须显式带上 pi 所在目录与常见 Node 目录：pi 是 `#!/usr/bin/env node`
    // 的 JS 包装，桌面进程那份 PATH 里既没有 pi 也没有 node，不注入就 spawn/启动即失败。
    let bin_dir = bin
        .path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("/usr/bin"));
    cmd.env("PATH", pi_path_env(&bin_dir));
    cmd.args(["--mode", "rpc", "--no-session"]);
    // 把 Pi 的 agent 目录指到本应用的配置目录：技能发现、defaultTools、models.json
    // 三处配置才会和外壳读写的是同一份。不设这个变量时 Pi 读 `~/.pi/agent`，
    // 外壳写的白名单/技能全部落空。
    cmd.env("PI_CODING_AGENT_DIR", &agent_dir);
    if let Some(l) = &launch {
        cmd.arg("--provider").arg(&l.provider);
        cmd.arg("--model").arg(&l.model);
        // 空 key 时不传：让 Pi 退回环境变量，避免用空串覆盖掉已配置的凭据。
        if !l.api_key.trim().is_empty() {
            cmd.arg("--api-key").arg(&l.api_key);
        }
    }
    if let Some(cwd) = &cwd {
        cmd.current_dir(cwd);
    }
    // 内置插件随 Pi 一起启动：沙箱接缝 + 角色注入。
    // app_config_dir 下不一定有插件（开发态在源码树里），故按候选路径逐个探测。
    for ext in find_extensions(&app) {
        cmd.arg("--extension").arg(&ext);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = cmd.spawn().map_err(|e| format!("启动 pi 失败: {e}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "pi 无 stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "pi 无 stdout".to_string())?;

    let (tx, rx) = mpsc::channel::<String>();
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

    let app2 = app.clone();
    std::thread::spawn(move || {
        // State 只能在 AppHandle 存活期间取；闭包持有 app2 故可安全构造。
        let state_ref = app2.state::<PiState>();
        let reader = BufReader::new(stdout);
        // 每条内核连接内单调：长跑会话里事件的到达顺序不可靠，前端排序需要稳定锚点。
        let mut seq: u64 = 0;
        let mut emit = |raw: Value| {
            seq += 1;
            let mut batch: Vec<Value> = Vec::with_capacity(2);
            pi_events::enrich(
                &raw,
                &pi_events::EventMeta {
                    seq,
                    ts_ms: unix_ms(),
                },
                &mut batch,
            );
            for ev in batch {
                let _ = app2.emit("pi://event", ev);
            }
        };

        for line in reader.lines().flatten() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(json) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if is_response(&json) {
                // 响应：按 id 交还给发起该命令的那个 pi_call，不进入前端事件流。
                let Some(id) = rpc_id(&json) else { continue };
                if let Some(tx) = take_pending(&state_ref, &id) {
                    let _ = tx.send(json);
                } else if json.get("success").and_then(|v| v.as_bool()) == Some(false) {
                    // 无主响应 = `pi_send` 下发的 prompt 的回执（fire-and-forget 没有接收方）。
                    // 不回推，内核报错（No API key / 模型不可用）前端就永远看不到：
                    // 消息停在「已发送」，既没有回复也没有错误 —— 正是「点了没反应」。
                    emit(json);
                }
                continue;
            }
            // 事件：流式推送（message_update / agent_settled / …），与命令响应交错到达。
            emit(json);
        }
        // 子进程退出：结构化后再推，消费端与其余事件同构。
        emit(Value::String("process_exit".into()));
    });

    *state.child.lock().unwrap() = Some(child);
    *state.stdin_tx.lock().unwrap() = Some(tx);
    *state.launch_sig.lock().unwrap() = Some(sig);
    // 记住 cwd：pi_restart 换模型 / 换工具白名单后要原地重建同一工作目录。
    *state.launch_cwd.lock().unwrap() = cwd;
    Ok(())
}

/// 原地重启内核：改模型 / 改工具白名单后，新配置只在**新进程**里生效。
/// 返回是否真的重启：内核没在跑时直接跳过，避免「设置页点一下就在默认目录凭空拉起内核」。
/// **必须 async**：函数体经 `stop_child` 做 kill + wait，阻塞调用不能落主线程。
#[tauri::command(async)]
pub fn pi_restart(app: AppHandle, state: State<PiState>) -> Result<bool, String> {
    if state.child.lock().unwrap().is_none() {
        return Ok(false);
    }
    let cwd = state.launch_cwd.lock().unwrap().clone();
    if let Ok(mut pending) = state.pending.lock() {
        pending.clear();
    }
    stop_child(&state);
    pi_start(app, cwd, state)?;
    Ok(true)
}

/// 已在跑的内核能否直接复用：签名一致且子进程仍存活。
/// `try_wait` 同时兼顾「内核自己崩了」——此时旧 child 已回收，必须重新拉起。
fn reuse_child(state: &PiState, sig: &str) -> bool {
    let same = state
        .launch_sig
        .lock()
        .map(|s| s.as_deref() == Some(sig))
        .unwrap_or(false);
    if !same {
        return false;
    }
    let mut guard = state.child.lock().unwrap();
    match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            _ => {
                *guard = None;
                false
            }
        },
        None => false,
    }
}

/// 全双工 RPC：下发一条命令，等待其专属响应。
///
/// 前端只与 `pi_call` 打交道——响应由内核按 id 路由回来，前端无需轮询或
/// 依赖「同一时刻只有一条命令」的假设。命令响应之外的流式事件仍走 `pi://event`。
///
/// **必须 `async`**：Tauri 的非 async 命令跑在**主线程**上，而这里会阻塞等待
/// 内核响应。曾经不写 `async`，内核一旦不回应就把整个窗口冻住（换目录、切模型后
/// 相继触发 `set_thinking_level`，界面「点不动」就是这么来的），直到超时才恢复。
#[tauri::command(async)]
pub fn pi_call(
    json: String,
    timeout_ms: Option<u64>,
    state: State<PiState>,
) -> Result<Value, String> {
    let mut command: Value =
        serde_json::from_str(&json).map_err(|e| format!("命令不是合法 JSON: {e}"))?;
    let (tx, rx) = mpsc::channel();
    let id = {
        let mut seq = lock_seq(&state);
        *seq += 1;
        format!("pi{seq}")
    };
    if let Some(obj) = command.as_object_mut() {
        obj.insert("id".into(), Value::String(id.clone()));
    }

    {
        let stdin_tx = lock_stdin(&state)?;
        let sender = stdin_tx.as_ref().ok_or_else(|| "pi 未启动".to_string())?;
        sender.send(command.to_string()).map_err(|e| e.to_string())?;
    }

    {
        let mut pending = lock_pending(&state);
        pending.insert(id.clone(), tx);
    }

    let timeout = timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_TIMEOUT);
    match rx.recv_timeout(timeout) {
        Ok(resp) => {
            let _ = take_pending(&state, &id);
            ok_data(&resp)
        }
        Err(_) => {
            let _ = take_pending(&state, &id);
            Err(format!(
                "pi 在 {:?} 内未响应（id={id}）；可用 timeout_ms 放宽",
                timeout
            ))
        }
    }
}

/// 向 Pi 下发一条命令后立刻返回（fire-and-forget），用于不需要结果的场景。
/// 注意：流式结果仍从 `pi://event` 事件流里取。
///
/// **必须 async**：虽然当前 `sender.send()`（无界 channel）不会阻塞，但它在
/// 发消息主链路上，与内核子进程共享一把 `stdin_tx` 锁；一旦锁被占用（如重启竞态），
/// 非 async 命令会把主线程按住。发消息是最高频操作，不允许任何冻结可能。
#[tauri::command(async)]
pub fn pi_send(json: String, state: State<PiState>) -> Result<(), String> {
    let mut command: Value =
        serde_json::from_str(&json).map_err(|e| format!("命令不是合法 JSON: {e}"))?;
    if !command.get("id").and_then(|v| v.as_str()).is_some() {
        let mut seq = lock_seq(&state);
        *seq += 1;
        let id = format!("pi{}", *seq);
        if let Some(obj) = command.as_object_mut() {
            obj.insert("id".into(), Value::String(id));
        }
    }
    let stdin_tx = lock_stdin(&state)?;
    let sender = stdin_tx.as_ref().ok_or_else(|| "pi 未启动".to_string())?;
    sender
        .send(command.to_string())
        .map_err(|e| format!("下发命令失败: {e}"))
}

/// 停止内核：kill + wait 回收子进程。wait 是阻塞调用，必须 async 防主线程冻结。
#[tauri::command(async)]
pub fn pi_stop(state: State<PiState>) -> Result<(), String> {
    if let Ok(mut pending) = state.pending.lock() {
        pending.clear();
    }
    stop_child(&state);
    Ok(())
}

/// 一条 stdout 记录是否为命令响应（而非流式事件）。
/// Pi 协议：`{"id","type":"response","command","success","data"}` 为响应，其余为事件。
pub fn is_response(record: &Value) -> bool {
    record
        .get("type")
        .and_then(|t| t.as_str())
        .map(|t| t == "response")
        .unwrap_or(false)
}

pub fn rpc_id(record: &Value) -> Option<String> {
    record
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// 取出并移除某个命令的响应通道。响应只能被消费一次，超时后残留条目也要清掉。
pub fn take_pending(state: &PiState, id: &str) -> Option<Sender<Value>> {
    lock_pending(state).remove(id)
}

/// 命令响应 → 调用方可见的数据；失败则带 Pi 给出的错误信息。
pub fn ok_data(resp: &Value) -> Result<Value, String> {
    let success = resp
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if success {
        Ok(resp.get("data").cloned().unwrap_or(Value::Null))
    } else {
        // String 变体必须取原始文本：`Value::to_string()` 输出的是 JSON 字面量，
        // 会把错误信息连引号一起包给前端（Toast 里显示成 "no such entry"）。
        let err = resp
            .get("error")
            .map(|e| match e {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| "未知错误（pi 未给出 error 字段）".to_string());
        Err(err)
    }
}

fn lock_pending(state: &PiState) -> MutexGuard<'_, HashMap<String, Sender<Value>>> {
    state
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn lock_stdin(state: &PiState) -> Result<MutexGuard<'_, Option<Sender<String>>>, String> {
    state.stdin_tx.lock().map_err(|e| e.to_string())
}

/// 取 seq 的自增锁。
///
/// 用 `try_lock` 而非 `lock`：std 的 Mutex **不检测同线程重入**，同一线程第二次
/// `lock()` 会永久阻塞（不是 poisoned），临界区又极短，卡死没有任何收益。
/// 只在加锁失败（占用/中毒）时降级取回内部 guard。
pub(crate) fn lock_seq(state: &PiState) -> MutexGuard<'_, u64> {
    match state.seq.try_lock() {
        Ok(g) => g,
        // 持有者 panic 过：seq 只是个自增序号，丢掉中毒状态继续计数即可。
        Err(TryLockError::Poisoned(e)) => e.into_inner(),
        // 被别的持有者占着：临界区极短，等它放锁；不会命中同线程重入。
        Err(TryLockError::WouldBlock) => state.seq.lock().unwrap_or_else(|e| e.into_inner()),
    }
}

/// 候选插件路径：资源目录 → 配置目录 → 相对源码树。返回所有命中者（缺失的插件不参与启动）。
fn find_extensions(app: &AppHandle) -> Vec<std::path::PathBuf> {
    // 单一真源：扩展清单以 capabilities.json#extensions 为准；缺失时退回硬编码默认。
    let names: Vec<String> = crate::capabilities::CapabilityManifest::discover()
        .map(|m| m.extensions.iter().cloned().collect())
        .unwrap_or_else(|| vec!["sandbox-env.ts".to_string(), "role-inject.ts".to_string()]);
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    for name in &names {
        if let Ok(d) = app.path().resource_dir() {
            candidates.push(d.join("extensions").join(name));
        }
        if let Ok(d) = app.path().app_config_dir() {
            candidates.push(d.join("extensions").join(name));
        }
        for base in [
            std::env::current_dir().ok(),
            app.path()
                .resource_dir()
                .ok()
                .and_then(|d| d.join("..").join("..").join("..").parent().map(|p| p.to_path_buf())),
        ]
        .into_iter()
        .flatten()
        {
            candidates.push(base.join("src-tauri").join("extensions").join(name));
            candidates.push(base.join("extensions").join(name));
        }
    }
    let mut found: Vec<std::path::PathBuf> = candidates.into_iter().filter(|p| p.exists()).collect();
    found.dedup();
    found
}

fn stop_child(state: &PiState) {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *state.stdin_tx.lock().unwrap() = None;
    // 清掉签名：下次 pi_start 必须重新拉起，不能复用已停的进程。
    *state.launch_sig.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resp(id: &str, success: bool, data: Option<Value>) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("id".into(), Value::String(id.into()));
        m.insert("type".into(), Value::String("response".into()));
        m.insert("command".into(), Value::String("get_tree".into()));
        m.insert("success".into(), Value::Bool(success));
        if let Some(d) = data {
            m.insert("data".into(), d);
        }
        Value::Object(m)
    }

    #[test]
    fn response_vs_event() {
        assert!(is_response(&resp("a", true, None)));
        // 流式事件没有 type:"response"，必须被判为事件
        assert!(!is_response(&serde_json::json!({"type": "agent_settled"})));
        assert!(!is_response(&serde_json::json!({})));
    }

    /// 源码级回归守卫：会**阻塞等待**的命令必须声明成 `#[tauri::command(async)]`。
    ///
    /// Tauri 的非 async 命令跑在主线程上，一旦在里面等子进程响应，整个窗口就会冻住
    /// （「换目录 / 切模型后点不动」的根因）。这里按名字逐条检查声明形式——
    /// 新增阻塞式命令时把它加进 `WATCHED` 即可。
    #[test]
    fn blocking_commands_must_be_declared_async() {
        const WATCHED: [&str; 9] = [
            "pi_call", "mcp_call", "skills_list",
            // 发消息主链路：用户报「输入完成后整窗卡死」后全部收编（见 2026-10-05 修复）。
            "pi_start", "pi_restart", "pi_send", "pi_stop",
            "project_task_context",
            // 目录遍历 + stat，同样不落主线程。
            "pi_doctor",
        ];
        let sources = [
            ("pi_bridge.rs", include_str!("pi_bridge.rs")),
            ("mcp.rs", include_str!("mcp.rs")),
            ("skills.rs", include_str!("skills.rs")),
            ("projects.rs", include_str!("projects.rs")),
        ];

        for (file, src) in sources {
            let lines: Vec<&str> = src.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                let Some(name) = WATCHED.iter().find(|n| line.contains(&format!("fn {n}("))) else {
                    continue;
                };
                let attr = lines[..i]
                    .iter()
                    .rev()
                    .find(|l| l.trim_start().starts_with("#[tauri::command"))
                    .unwrap_or_else(|| panic!("{file}: {name} 不是 tauri 命令"));
                assert!(
                    attr.contains("async"),
                    "{file}: {name} 会阻塞等待，必须写成 #[tauri::command(async)]，否则冻结主线程（当前：{attr}）",
                );
            }
        }
    }

    /// 子进程 PATH：pi 目录在最前（优先命中刚解析出的那个），且不丢系统路径。
    #[test]
    fn pi_path_env_puts_bin_dir_first_and_dedups() {
        let env = pi_path_env(std::path::Path::new("/custom/pi-bin"));
        assert_eq!(env.split(':').next().unwrap_or(""), "/custom/pi-bin");
        let mut seen = std::collections::HashSet::new();
        for p in env.split(':') {
            assert!(seen.insert(p), "PATH 里出现重复项: {p}");
        }
        if let Ok(cur) = std::env::var("PATH") {
            let merged: Vec<&str> = env.split(':').collect();
            for d in std::env::split_paths(&cur) {
                let s = d.display().to_string();
                assert!(merged.contains(&s.as_str()), "必须保留原 PATH 目录 {s}");
            }
        }
    }

    /// 本机 PATH 里能找到 pi 时，探测逻辑必须命中同一个文件 —— 否则桌面端
    /// 「点发送没反应」会原样复现（PATH 里有、App 里 spawn 不到）。
    /// 没装 pi 的机器（CI）自动跳过。
    #[test]
    fn probe_pi_finds_installed_binary() {
        let in_path = std::env::split_paths(&std::env::var("PATH").unwrap_or_default())
            .map(|d| d.join("pi"))
            .find(|p| is_executable(p));
        let Some(expected) = in_path else {
            return;
        };
        // 不要求与 PATH 里那个同路径：候选目录优先于 PATH 正是设计意图
        // （桌面进程没有用户 PATH）。只要求「确实探测到一个可执行的 pi」。
        let found = probe_pi()
            .unwrap_or_else(|| panic!("PATH 里有 pi，探测却没找到：{}", expected.display()));
        assert!(is_executable(&found), "探测结果不可执行：{}", found.display());
        assert_eq!(found.file_name().and_then(|n| n.to_str()), Some("pi"));
    }

    /// 探测判据：目录与不存在的路径都不能被当成 pi。
    #[test]
    fn is_executable_rejects_missing_and_dirs() {
        assert!(!is_executable(std::path::Path::new("/definitely/not/here/pi")));
        assert!(!is_executable(std::path::Path::new("/tmp")));
    }

    #[test]
    fn rpc_id_reads_string_id() {
        assert_eq!(rpc_id(&resp("abc", true, None)).as_deref(), Some("abc"));
        assert_eq!(rpc_id(&serde_json::json!({"type": "x"})), None);
    }

    #[test]
    fn ok_data_unwraps_payload() {
        assert_eq!(
            ok_data(&resp("a", true, Some(Value::String("hi".into())))).unwrap(),
            Value::String("hi".into())
        );
        // success 但无 data：契约允许，返回 Null 而非报错
        assert_eq!(ok_data(&resp("a", true, None)).unwrap(), Value::Null);
        // 失败：带出 Pi 的 error
        let err = resp("a", false, None);
        assert!(ok_data(&err).is_err());
        // 错误信息必须原样透出，不能带 JSON 引号。
        let mut quoted = resp("a", false, None);
        quoted["error"] = Value::String("no such entry".into());
        assert_eq!(ok_data(&quoted).unwrap_err(), "no such entry");
        // 非字符串的错误（对象/数字）退化成 JSON 文本，至少可读。
        let mut obj = resp("a", false, None);
        obj["error"] = serde_json::json!({ "code": 5 });
        assert_eq!(ok_data(&obj).unwrap_err(), r#"{"code":5}"#);
    }

    #[test]
    fn ok_data_propagates_error_text() {
        let mut bad = resp("a", false, None);
        bad["error"] = Value::String("no such entry".into());
        assert_eq!(ok_data(&bad).unwrap_err(), "no such entry");
    }

    #[test]
    fn pending_is_consumed_once() {
        let state = PiState::default();
        let (tx, _rx) = mpsc::channel();
        state
            .pending
            .lock()
            .unwrap()
            .insert("pi1".into(), tx.clone());
        assert!(take_pending(&state, "pi1").is_some());
        // 响应只能被消费一次，否则超时/迟到的响应会重复唤醒已放弃的调用
        assert!(take_pending(&state, "pi1").is_none());
        assert!(take_pending(&state, "pi2").is_none());
    }

    #[test]
    fn parallel_calls_do_not_cross_route() {
        let state = PiState::default();
        let (tx1, rx1) = mpsc::channel();
        let (tx2, rx2) = mpsc::channel();
        {
            let mut p = state.pending.lock().unwrap();
            p.insert("pi1".into(), tx1);
            p.insert("pi2".into(), tx2);
        }
        // 模拟读取线程：按 id 路由，pi2 的响应只唤醒 pi2 的调用方
        let for_pi2 = resp("pi2", true, Some(Value::Number(2.into())));
        let routed = take_pending(&state, rpc_id(&for_pi2).unwrap().as_str()).expect("pi2 可路由");
        routed.send(for_pi2).unwrap();
        assert_eq!(
            ok_data(&rx2.try_recv().unwrap()).unwrap(),
            Value::Number(2.into())
        );

        // pi1 的响应随后到达，不能串到 pi2 的调用方
        let for_pi1 = resp("pi1", true, Some(Value::Number(1.into())));
        let routed = take_pending(&state, rpc_id(&for_pi1).unwrap().as_str()).expect("pi1 可路由");
        routed.send(for_pi1).unwrap();
        assert_eq!(
            ok_data(&rx1.try_recv().unwrap()).unwrap(),
            Value::Number(1.into())
        );
        assert!(rx2.try_recv().is_err(), "pi2 不应收到 pi1 的响应");
        assert!(state.pending.lock().unwrap().is_empty());
    }

    /// seq 自增必须单调。
    ///
    /// 注意调用方必须让 guard 及时离开作用域：`std::sync::Mutex` 不检测同线程重入，
    /// 在同一作用域里连续 `lock_seq` 会永久阻塞（实现侧用 `try_lock` 降级，
    /// 兜底路径因此只处理「别的持有者」，而不是「自己」）。
    #[test]
    fn seq_is_monotonic() {
        let state = PiState::default();
        let first = { let mut a = lock_seq(&state); *a += 1; *a };
        let second = { let mut b = lock_seq(&state); *b += 1; *b };
        assert!(first < second);

        // 并发自增不丢步：两个线程各加 50 次，最终必须是 100。
        std::thread::scope(|s| {
            for _ in 0..2 {
                s.spawn(|| {
                    for _ in 0..50 {
                        let mut g = lock_seq(&state);
                        *g += 1;
                    }
                });
            }
        });
        assert_eq!(*lock_seq(&state), 102);
    }
}
