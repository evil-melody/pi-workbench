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
use crate::run_meta::{RunMetaEntry, RunMetaState};
use crate::state::PiState;

/// 单条 RPC 的默认等待上限。
///
/// 走 `pi_call` 的全是控制面命令（`get_tree` / `fork` / `set_thinking_level`），
/// 都是毫秒级；真正的 agent 轮次走 `pi_send` 的流式通道，不经过这里。
/// 原先按「agent 一轮可能数分钟」定成 120s，导致内核无响应时界面最长冻结两分钟。
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Unix 毫秒时间戳，供事件元信息打点。
pub(crate) fn unix_ms() -> u64 {
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
pub fn pi_start(
    app: AppHandle,
    cwd: Option<String>,
    state: State<PiState>,
    gov: State<'_, crate::governance::GovernanceState>,
) -> Result<(), String> {
    let agent_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("取配置目录失败: {e}"))?;
    let launch = crate::models::pi_model_launch(&app);

    // 准入闸门（access/model-policy）：显式选择的 provider/model 必须过
    // 治理配置（governance.json 的 model_policy），命中拒绝名单直接不启动。
    if let Some(l) = &launch {
        let policy = gov.config.lock().unwrap().model_policy.clone();
        crate::governance::enforce_model_policy(&policy, Some(&l.provider), Some(&l.model))?;
    }

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

    // 内核异常退出（如扩展冲突 abort）来不及释放 settings.json.lock（proper-lockfile
    // 式目录锁）；残留会让下次启动 settings 加载失败（EEXIST）→ 默认模型配置落空。
    // 此刻本 App 的内核尚未拉起、无并发持有者，清理残留是安全的；remove_dir 非递归，
    // 万一锁里真有内容会失败而不是误删。
    let settings_lock = agent_dir.join("settings.json.lock");
    if settings_lock.exists() {
        let removed = if settings_lock.is_dir() {
            std::fs::remove_dir(&settings_lock)
        } else {
            std::fs::remove_file(&settings_lock)
        };
        if let Err(e) = removed {
            eprintln!("[pi:stderr] 清理残留 settings 锁失败: {e}");
        }
    }

    // 事件 journal（B2）：每条 pi://event 追加写入 <config>/.pi/journal/events.jsonl，
    // 供审计与回放；内核重启时文件不重建，事件按时间顺序累积。
    let journal_dir = agent_dir.join(".pi").join("journal");
    let _ = std::fs::create_dir_all(&journal_dir);
    let journal_path = journal_dir.join("events.jsonl");
    *state.journal_path.lock().unwrap() = Some(journal_path.clone());
    // G4：会话打开标记（cwd 入 journal），回放据此只重建当前项目的会话。
    if let Some(cwd) = &cwd {
        append_session_open(&journal_path, cwd);
    }

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
    // G3：checkpoint 备份目录。扩展（agent-tool-gate）在 edit/write 放行前把目标
    // 文件复制进 `<这里>/turn-<seq>/<镜像路径>`，rewind 时原样还原。
    cmd.env("PI_CHECKPOINT_DIR", checkpoint_base(&app));
    if let Some(l) = &launch {
      cmd.arg("--provider").arg(&l.provider);
      cmd.arg("--model").arg(&l.model);
      // 透传给团队子进程（agent-teams 的 runMember 读 PI_LAUNCH_* 复用同一模型，
      // 避免成员以默认模型在错误目录跑——见 WORKDSH-ALIGN-26 的 A3）。
      cmd.env("PI_LAUNCH_PROVIDER", &l.provider);
      cmd.env("PI_LAUNCH_MODEL", &l.model);
      // 空 key 时不传 arg / 不传 env：让 Pi 退回环境变量，避免用空串覆盖已配置凭据。
      if !l.api_key.trim().is_empty() {
        cmd.arg("--api-key").arg(&l.api_key);
        cmd.env("PI_LAUNCH_API_KEY", &l.api_key);
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
        // stderr 必须接管：之前是 null，内核启动即崩的死因（模型配置错、扩展抛错）
        // 被直接丢弃，排障只能靠猜。这里转发到终端，一行不少。
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("启动 pi 失败: {e}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "pi 无 stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "pi 无 stdout".to_string())?;
    let stderr = child.stderr.take();

    // 内核 stderr → 终端：内核崩溃/配置错误的第一现场，绝不能再吞。
    if let Some(err) = stderr {
        std::thread::spawn(move || {
            let reader = BufReader::new(err);
            for line in reader.lines().flatten() {
                eprintln!("[pi:stderr] {line}");
            }
        });
    }

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
        // 事件 journal 文件句柄：每条事件追加写入，供审计/回放（B2）。
        let journal_path = state_ref.journal_path.lock().unwrap().clone();
        let mut journal = journal_path.and_then(|p| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&p)
                .ok()
        });
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
                let _ = app2.emit("pi://event", ev.clone());
                if let Some(f) = journal.as_mut() {
                    let _ = writeln!(f, "{}", serde_json::to_string(&ev).unwrap_or_default());
                }
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
        // 自灭（非 stop_child 主动停）时必须同时清 stdin_tx：不清的话 sender 仍是
        // Some，pi_send 往死管道写「成功」返回，前端拿到 dispatch:sent 却永远等不到
        // 回复——正是「消息发出去了，然后什么都没有」的静默黑洞。
        *state_ref.stdin_tx.lock().unwrap() = None;
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
pub fn pi_restart(
    app: AppHandle,
    state: State<PiState>,
    gov: State<'_, crate::governance::GovernanceState>,
) -> Result<bool, String> {
    if state.child.lock().unwrap().is_none() {
        return Ok(false);
    }
    let cwd = state.launch_cwd.lock().unwrap().clone();
    // A5：不再静默丢弃 in-flight 请求。逐个以「内核重启」失败响应唤醒等待方，
    // 前端 pi_call 因此拿到清晰错误而非永久卡在 streaming；并广播重启事件。
    drain_pending_on_restart(&state);
    let _ = app.emit(
        "pi://event",
        serde_json::json!({ "type": "kernel_restarted", "at": unix_ms() }),
    );
    stop_child(&state);
    pi_start(app, cwd, state, gov)?;
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

/// G4 会话打开标记（journal 分段用）。
///
/// 内核 `agent_start` 事件不带 cwd，回放时无法区分消息属于哪个项目；
/// 桥在每次 pi_start 补一条 `session_open`，cwd 即当时的工作目录。
/// 追加写与 reader 线程的 journal 句柄并发，行级写入足够安全（单行 < PIPE_BUF）。
pub(crate) fn append_session_open(journal_path: &Path, cwd: &str) {
    use std::io::Write;
    let line = serde_json::json!({
        "type": "session_open",
        "cwd": cwd,
        "pi_ts": unix_ms(),
    });
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(journal_path)
    {
        let _ = writeln!(f, "{}", line);
    }
}

/// 全双工 RPC 内核态实现：下发一条命令，等待其专属响应。
/// `pi_call`（对外）与 Rust 内部调用（checkpoint 的 get_tree/fork）共用。
pub(crate) fn rpc_roundtrip(
    state: &PiState,
    command: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel();
    let id = {
        let mut seq = lock_seq(state);
        *seq += 1;
        format!("pi{seq}")
    };
    let mut command = command;
    if let Some(obj) = command.as_object_mut() {
        obj.insert("id".into(), Value::String(id.clone()));
    }

    {
        let stdin_tx = lock_stdin(state)?;
        let sender = stdin_tx.as_ref().ok_or_else(|| "pi 未启动".to_string())?;
        sender.send(command.to_string()).map_err(|e| e.to_string())?;
    }

    {
        let mut pending = lock_pending(state);
        pending.insert(id.clone(), tx);
    }

    match rx.recv_timeout(timeout) {
        Ok(resp) => {
            let _ = take_pending(state, &id);
            ok_data(&resp)
        }
        Err(_) => {
            let _ = take_pending(state, &id);
            Err(format!(
                "pi 在 {timeout:?} 内未响应（id={id}）；可用 timeout_ms 放宽"
            ))
        }
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
    let command: Value =
        serde_json::from_str(&json).map_err(|e| format!("命令不是合法 JSON: {e}"))?;
    let timeout = timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_TIMEOUT);
    rpc_roundtrip(&state, command, timeout)
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

/// B1 回传通道：把宿主对 `extension_ui_request`（method=confirm/select/input）的
/// 决定回送内核。协议（pi bundle 实测）：stdin 一行
/// `{"type":"extension_ui_response","id","confirmed":bool}` —— confirm 处理器
/// 只读 `confirmed`（`cancelled:true` 等价于拒绝），因此这里无需额外字段。
/// fire-and-forget：内核不回应，超时兜底由扩展侧 fail-closed 负责。
#[tauri::command(async)]
pub fn pi_ui_response(json: String, state: State<PiState>) -> Result<(), String> {
    let command: Value =
        serde_json::from_str(&json).map_err(|e| format!("审批回应不是合法 JSON: {e}"))?;
    if command.get("type").and_then(|v| v.as_str()) != Some("extension_ui_response") {
        return Err("缺少 type=extension_ui_response".into());
    }
    if command.get("id").and_then(|v| v.as_str()).is_none() {
        return Err("缺少 id（对应 extension_ui_request 的 id）".into());
    }
    let stdin_tx = lock_stdin(&state)?;
    let sender = stdin_tx.as_ref().ok_or_else(|| "pi 未启动".to_string())?;
    sender
        .send(command.to_string())
        .map_err(|e| format!("回送审批回应失败: {e}"))
}

/// G3 checkpoint 根目录：`<app_config_dir>/checkpoints`。
/// 扩展（agent-tool-gate）经 spawn env `PI_CHECKPOINT_DIR` 读同一路径写备份。
fn checkpoint_base(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("checkpoints")
}

/// G3：轮次开始。先取会话树当前叶子（该轮 prompt 的父节点）写进 marker，
/// 再落盘返回 seq。取树失败不阻断发送：leaf_id=None 时 rewind 只还原文件、不 fork。
#[tauri::command(async)]
pub fn checkpoint_begin_turn(
    app: AppHandle,
    state: State<'_, PiState>,
    prompt_head: String,
) -> Result<u64, String> {
    let leaf_id = rpc_roundtrip(
        &state,
        serde_json::json!({ "type": "get_tree" }),
        Duration::from_secs(2),
    )
    .ok()
    .and_then(|v| {
        v.get("leafId")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
    });
    crate::checkpoint::begin_turn(&checkpoint_base(&app), leaf_id.as_deref(), &prompt_head)
}

/// G3：回到某轮之前——还原该轮改动过的文件 + fork 会话树到该轮 prompt 之前。
///
/// fork 走内核原生能力：`get_fork_messages` 拿 user 消息清单，按 marker 里的
/// prompt_head 定位该轮 entry，`fork(entryId)` 默认 position=before，
/// 语义正是「重开到这条 prompt 之前」。
///
/// 边界（对齐 Claude Code checkpoint 明示限制）：bash 命令产生的文件变更
/// **不在**快照范围，由 UI 在确认框与结果消息里明示。
#[tauri::command(async)]
pub fn checkpoint_rewind(
    app: AppHandle,
    state: State<'_, PiState>,
    seq: u64,
) -> Result<crate::checkpoint::RewindReport, String> {
    let base = checkpoint_base(&app);
    let mut rep = crate::checkpoint::rewind(&base, seq)?;
    let Some(marker) = crate::checkpoint::read_marker(&base, seq) else {
        return Ok(rep);
    };
    // 定位该轮 prompt 的 user entry：先按父节点精确关联（get_entries 带 parentId），
    // 失败再退文本匹配（get_fork_messages）。两条路都拿不到就不 fork，仅还原文件。
    let entry_id = locate_turn_entry(&state, &marker);
    if let Some(entry_id) = entry_id {
        match rpc_roundtrip(
            &state,
            serde_json::json!({ "type": "fork", "entryId": entry_id }),
            Duration::from_secs(10),
        ) {
            Ok(_) => rep.fork_entry_id = Some(entry_id),
            Err(e) => rep.failed.push(format!("fork 会话树失败: {e}")),
        }
    }
    Ok(rep)
}

/// 定位某轮 prompt 的 user entry：`get_entries` 按 parentId 精确关联优先，
/// `get_fork_messages` 文本匹配兜底。
fn locate_turn_entry(state: &PiState, marker: &crate::checkpoint::TurnMarker) -> Option<String> {
    if let Ok(en) = rpc_roundtrip(
        state,
        serde_json::json!({ "type": "get_entries" }),
        Duration::from_secs(5),
    ) {
        let entries: Vec<(String, Option<String>, Option<String>)> = en
            .get("entries")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|e| {
                        let id = e.get("id").and_then(|x| x.as_str())?.to_string();
                        let parent = e
                            .get("parentId")
                            .and_then(|x| x.as_str())
                            .map(|s| s.to_string());
                        let role = e
                            .get("message")
                            .and_then(|m| m.get("role"))
                            .and_then(|x| x.as_str())
                            .map(|s| s.to_string());
                        Some((id, parent, role))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if let Some(id) =
            crate::checkpoint::find_entry_by_parent(&entries, marker.leaf_id.as_deref())
        {
            return Some(id);
        }
    }
    // 兜底：文本匹配。prompt_head 取用户原文前 80 字符（非 preamble），
    // 相同文本多轮重复时取最后一条——重放场景下可接受。
    let fm = rpc_roundtrip(
        state,
        serde_json::json!({ "type": "get_fork_messages" }),
        Duration::from_secs(5),
    )
    .ok()?;
    let msgs: Vec<(String, String)> = fm
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    let id = m.get("entryId").and_then(|x| x.as_str())?;
                    let text = m.get("text").and_then(|x| x.as_str())?;
                    Some((id.to_string(), text.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    crate::checkpoint::find_fork_entry_id(&msgs, &marker.prompt_head)
}

/// A4 消息重放：读取事件 journal（B2 落盘的 `pi://event` 审计流）。
/// `last_n` 指定取末尾多少条（None = 全量），前端据此重建崩溃前的会话转写。
/// 返回按时间顺序的事件数组（含 enrich 后的 seq/ts_ms 锚点）。
#[tauri::command(async)]
pub fn pi_journal_read(
    last_n: Option<usize>,
    state: State<PiState>,
) -> Result<Vec<Value>, String> {
    let path = state
        .journal_path
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "journal 未启用（pi_start 未写入路径）".to_string())?;
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 journal 失败（{path:?}）: {e}"))?;
    let mut events: Vec<Value> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    if let Some(n) = last_n {
        let start = events.len().saturating_sub(n);
        events = events.split_off(start);
    }
    Ok(events)
}

/// 运行记录（WorkDSH「之前的运行记录」对位）：把 journal 按 `session_open`
/// 分段汇总成历史会话列表，新→旧排序由前端做。每段一条：cwd、起止时间、
/// 事件数、任务数与标题（段内第一条用户消息）。
/// 路径按 app_config_dir **确定性解析**——不依赖 state.journal_path（那要等
/// pi_start 才有），App 刚打开、内核未启动时也能看历史。
/// **必须 async**：读 journal 是磁盘 IO（与 IO_WATCHED 守卫同一约定）。
#[derive(Clone, serde::Serialize)]
pub struct JournalSessionSummary {
    /// journal 全局段号（0 起，按时间顺序）。前端回放时传回 loadReplay。
    /// 合并 run_meta（过滤/排序）时**不得重排段号**：回放按段号从原始
    /// journal 取事件，段号一变就会把别的项目的会话回放进当前对话。
    pub index: usize,
    pub cwd: String,
    pub started_at_ms: Option<u64>,
    pub ended_at_ms: Option<u64>,
    pub events: usize,
    /// 该段用户下发任务的次数（message_end 且 role=user）。
    pub prompts: usize,
    /// 段内第一条用户消息原文（含 preamble/附件块，由前端剥壳与截断展示）；
    /// run_meta 有非空 title 时被覆盖（见 `renamed`）。
    pub title: String,
    /// 置顶（run_meta sidecar）：pinned 段排在最前。
    pub pinned: bool,
    /// 归档（run_meta sidecar）：include_archived=false 时不出现在列表里。
    pub archived: bool,
    /// 标题是否被 run_meta 重写（前端据此显示「已重命名」标识）。
    pub renamed: bool,
}

/// journal 路径：与 pi_start 的落盘处完全一致（agent_dir = app_config_dir）。
fn journal_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join(".pi").join("journal").join("events.jsonl"))
}

/// 从一条 journal 事件提取「用户消息正文」（message_end 且 role=user）。
/// content 可能是字符串或 [{type:'text',text}] 块数组（与前端 extractText 同型）。
fn user_message_text(ev: &Value) -> Option<String> {
    if ev.get("type")?.as_str()? != "message_end" {
        return None;
    }
    let msg = ev.get("message")?;
    if msg.get("role")?.as_str()? != "user" {
        return None;
    }
    let text = match msg.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => return None,
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 合并 run_meta sidecar 到 journal 分段（纯函数，便于单测）。
///
/// 语义（对齐 WorkBuddy 运行记录菜单）：
/// - `deleted` 段永久过滤（软删除，journal 原文不动、段号不错位）；
/// - `archived` 段仅在 `include_archived` 时保留；
/// - 非空 `title` 覆盖段标题并置 `renamed`；
/// - `pinned` 段置顶，组内保持起止时间倒序（段号随时间递增，倒序即时间倒序）。
///
/// `index` 始终是 journal 全局段号：前端回放按段号取数
/// （`selectSessionByIndex`），过滤/排序都不得重排段号。
pub(crate) fn merge_run_meta(
    sessions: Vec<JournalSessionSummary>,
    entries: &[RunMetaEntry],
    include_archived: bool,
) -> Vec<JournalSessionSummary> {
    let mut out: Vec<JournalSessionSummary> = Vec::with_capacity(sessions.len());
    for mut session in sessions {
        let meta = entries
            .iter()
            .find(|e| e.cwd == session.cwd && e.index as usize == session.index);
        if let Some(meta) = meta {
            if meta.deleted {
                continue;
            }
            if meta.archived && !include_archived {
                continue;
            }
            session.pinned = meta.pinned;
            session.archived = meta.archived;
            if let Some(title) = meta
                .title
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
            {
                session.title = title.to_string();
                session.renamed = true;
            }
        }
        out.push(session);
    }
    // pinned 置顶；组内按段号倒序（= 起止时间倒序）。
    // `sort_by` 是稳定排序，同键元素保持 journal 顺序，不会引入抖动。
    out.sort_by(|a, b| b.pinned.cmp(&a.pinned).then_with(|| b.index.cmp(&a.index)));
    out
}

/// 列运行记录。journal 不存在/尚未产生返回空列表（首次使用不是错误，
/// 前端拿到空列表整体隐藏，不弹错打扰）。
///
/// `includeArchived`：是否连归档段一起返回（默认 false，由前端显式传）。
/// 段级置顶/重命名/归档/删除来自 run_meta sidecar（`run_meta.json`），
/// 按 `(cwd, index)` 合并；`index` 保持 journal 段号不变（回放锚点）。
#[tauri::command(async)]
#[allow(non_snake_case)]
pub fn pi_journal_sessions(
    app: AppHandle,
    includeArchived: bool,
    meta: State<'_, RunMetaState>,
) -> Result<Vec<JournalSessionSummary>, String> {
    let Some(path) = journal_file(&app) else {
        return Ok(Vec::new());
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()),
    };
    let mut sessions: Vec<JournalSessionSummary> = Vec::new();
    for line in content.lines() {
        let Ok(ev) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if ev.get("type").and_then(|t| t.as_str()) == Some("session_open") {
            sessions.push(JournalSessionSummary {
                index: sessions.len(),
                cwd: ev
                    .get("cwd")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string(),
                started_at_ms: ev.get("pi_ts").and_then(|t| t.as_u64()),
                ended_at_ms: None,
                events: 0,
                prompts: 0,
                title: String::new(),
                pinned: false,
                archived: false,
                renamed: false,
            });
            continue;
        }
        // 首个 session_open 之前的孤儿事件（legacy journal）归不进任何段，跳过。
        let Some(cur) = sessions.last_mut() else {
            continue;
        };
        cur.events += 1;
        if let Some(ts) = ev.get("pi_ts").and_then(|t| t.as_u64()) {
            cur.ended_at_ms = Some(ts);
        }
        if let Some(t) = user_message_text(&ev) {
            cur.prompts += 1;
            if cur.title.is_empty() {
                cur.title = t;
            }
        }
    }
    let entries = meta.store.lock().unwrap().entries.clone();
    Ok(merge_run_meta(sessions, &entries, includeArchived))
}

/// 停止内核：kill + wait 回收子进程。wait 是阻塞调用，必须 async 防主线程冻结。
///
/// G1：pending 不再静默 clear——进行中的 RPC（如 compact 长操作）逐条以
/// 「内核已停止」失败响应唤醒，调用方立即收尾而非干等 30s 超时。
#[tauri::command(async)]
pub fn pi_stop(state: State<PiState>) -> Result<(), String> {
    drain_pending(&state, "stop", "内核已停止，进行中的请求已丢弃");
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

/// 后备扩展源目录（已按优先级排序）：源码树(开发期热更) > 资源目录(打包副本)。
///
/// ⚠️ 内核会**无条件自动加载** `<PI_CODING_AGENT_DIR>/extensions`（即 app_config_dir，
/// `seed_defaults` 启动时已把清单扩展同步进去）——那里已有的扩展**绝不能**再经
/// `--extension` 显式传入，否则同一份扩展两处物理路径各注册一遍同名工具，
/// 内核因 `Tool "x" conflicts with ...` 启动即崩——这正是首页「有日志却无反应」的根因。
/// 此处目录只作为 agent 目录**缺失**某扩展时的兜底来源，真正的挑选交给
/// [`pick_unique_extensions`]。
fn extension_dirs(app: &AppHandle) -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    // 1) 源码树：开发期改动即时生效，优先于打包副本。
    for base in [std::env::current_dir().ok()].into_iter().flatten() {
        dirs.push(base.join("src-tauri").join("extensions"));
        dirs.push(base.join("extensions")); // cwd 即为 src-tauri 时
    }
    // 2) 资源目录：生产打包副本；开发态是 target/debug 的陈旧副本，放最后。
    if let Ok(d) = app.path().resource_dir() {
        dirs.push(d.join("extensions"));
    }
    dirs
}

/// 纯去重：每个扩展名只取**优先级最高**且存在的那一个物理文件。
///
/// 同一逻辑扩展可能同时存在于 `src-tauri/extensions`(源码)与
/// `target/debug/extensions`(构建副本)，内容相同但物理路径不同——必须只加载一份，
/// 否则内核工具名冲突启动即崩。抽成纯函数以便单测，不依赖 AppHandle。
fn pick_unique_extensions(
    dirs: &[std::path::PathBuf],
    names: &[String],
) -> Vec<std::path::PathBuf> {
    let mut chosen: std::collections::HashMap<String, std::path::PathBuf> =
        std::collections::HashMap::new();
    for dir in dirs {
        for name in names {
            if chosen.contains_key(name) {
                continue; // 已选定更高优先级的来源
            }
            let p = dir.join(name);
            if p.exists() {
                chosen.insert(name.clone(), p);
            }
        }
    }
    chosen.into_values().collect()
}

/// 过滤掉 agent 目录里已存在的扩展名（纯函数，便于单测）。
///
/// 内核对 `<PI_CODING_AGENT_DIR>/extensions` 是自动发现、无条件加载的；这些扩展
/// 再经 `--extension` 传入（无论同路径还是异路径）都会注册两份同名工具而启动失败。
fn names_missing_in(agent_ext_dir: Option<&std::path::Path>, names: &[String]) -> Vec<String> {
    match agent_ext_dir {
        Some(d) => names
            .iter()
            .filter(|n| !d.join(n).exists())
            .cloned()
            .collect(),
        None => names.to_vec(),
    }
}

/// 需要 `--extension` 显式传入的插件路径：agent 目录已有的交给内核自动加载，
/// 只为**缺失**的从源码树/资源目录补一份（缺失的插件不参与启动）。
fn find_extensions(app: &AppHandle) -> Vec<std::path::PathBuf> {
    // 单一真源：扩展清单以 pi-manifest.json#extensions 为准；缺失时退回硬编码默认。
    let names: Vec<String> = crate::capabilities::CapabilityManifest::discover()
        .map(|m| m.extensions.iter().cloned().collect())
        .unwrap_or_else(|| vec!["sandbox-env.ts".to_string(), "role-inject.ts".to_string()]);
    // agent 目录（= app_config_dir，与 PI_CODING_AGENT_DIR 同源）已有的跳过。
    let agent_ext_dir = app
        .path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("extensions"));
    let missing = names_missing_in(agent_ext_dir.as_deref(), &names);
    let dirs = extension_dirs(app);
    pick_unique_extensions(&dirs, &missing)
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

/// 把进行中的 RPC 响应通道全部以失败响应唤醒（A5 / G1）。
///
/// 内核即将停止/重启时，旧进程不会再回传任何响应；若直接清空 pending 表，
/// 等待方会永久阻塞在 `pi_call` 的 recv_timeout 上、前端卡在 streaming。
/// 改为逐条回送失败响应，让调用方拿到清晰错误后自行收尾。
pub fn drain_pending(state: &PiState, command: &str, error: &str) {
    if let Ok(mut pending) = state.pending.lock() {
        for (id, tx) in pending.drain() {
            let _ = tx.send(serde_json::json!({
                "id": id,
                "type": "response",
                "command": command,
                "success": false,
                "error": error
            }));
        }
    }
}

/// 重启场景的 drain：错误文案说明「重启」，调用方（前端）据此走自动补发。
pub fn drain_pending_on_restart(state: &PiState) {
    drain_pending(state, "restart", "内核重启，进行中的请求已丢弃")
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
                // `pub async fn` 声明的命令本身就是 future，Tauri 直接在异步运行时上
                // 执行，属性不写 (async) 也安全；只有 sync fn 才必须显式标注。
                let fn_is_async = lines[i].contains("async fn");
                assert!(
                    attr.contains("async") || fn_is_async,
                    "{file}: {name} 会阻塞等待，必须写成 #[tauri::command(async)]，否则冻结主线程（当前：{attr}）",
                );
            }
        }
    }

    /// 源码级回归守卫（AUDIT 待确认项①）：磁盘/子进程 IO 类命令同样必须 async。
    ///
    /// 2026-10-17 审计把确有 fs IO 或 `Command` 等待的命令逐个收编（纯内存态
    /// Mutex clone 类除外）。新增 IO 命令时加进 `IO_WATCHED`；把某个命令移出
    /// 名单前，先确认它体内没有任何 fs / spawn / 等待。
    ///
    /// 2026-10-17 QA Round 1 实测抓出 6 个逃逸（mcp_disconnect 的 child.kill/wait、
    /// library_set_enabled / skills_install / skills_uninstall / role_current 的 fs 读写、
    /// artifacts_open 的 stat + 拉起外部应用），已全部补标 async 并收编进本名单。
    /// 判据兼容两种安全形式：属性含 async，或声明为 `pub async fn`。
    #[test]
    fn io_commands_must_be_declared_async() {
        const IO_WATCHED: [(&str, &[&str]); 18] = [
            ("fs.rs", &["fs_read_dir", "fs_read_file", "fs_write_file", "reveal_path"]),
            ("pi_bridge.rs", &["pi_journal_read", "pi_journal_sessions"]),
            ("artifacts.rs", &["artifacts_scan", "artifacts_read", "artifacts_open"]),
            ("browser.rs", &["browser_open"]),
            ("conversation.rs", &["conversation_export", "conversation_import"]),
            ("attachments.rs", &["attachment_add"]),
            ("mcp.rs", &["mcp_connect", "mcp_disconnect"]),
            (
                "agent_ops.rs",
                &[
                    "agent_teams_list", "agent_team_create", "agent_memory_list",
                    "agent_memory_store", "agent_skillpool_list", "agent_skill_publish",
                    "agent_browser_status", "agent_browser_open",
                ],
            ),
            (
                "library.rs",
                &[
                    "library_tree", "library_read", "library_write", "library_create",
                    "library_import", "library_rename", "library_move", "library_remove",
                    "library_publish", "library_rollback", "library_search", "library_open",
                    "library_set_enabled",
                ],
            ),
            ("experts.rs", &["experts_list", "expert_draft_load", "expert_draft_save", "expert_publish"]),
            ("roles.rs", &["role_list", "role_set", "role_current"]),
            ("skills.rs", &["skills_install", "skills_install_from_url", "skills_uninstall"]),
            ("models.rs", &["settings_load", "settings_save"]),
            (
                "projects.rs",
                &[
                    "project_add", "project_update_config", "project_add_work_item",
                    "project_update_work_item", "project_remove_work_item", "project_add_asset",
                    "project_remove_asset", "project_link_task", "project_remove",
                    "project_rename", "project_reveal",
                    "project_set_path", "project_archive", "project_unarchive", "billing_status",
                ],
            ),
            (
                "run_meta.rs",
                &["run_meta_list", "run_meta_update", "open_replay_window"],
            ),
            (
                "connectors.rs",
                &[
                    "connectors_config", "connectors_create", "connectors_update",
                    "connectors_remove", "connectors_set_enabled", "connectors_set_selection",
                    "connectors_apply_scope",
                ],
            ),
            ("tools.rs", &["tools_activate", "tools_list"]),
            ("extensions.rs", &["extensions_list"]),
        ];

        for (file, names) in IO_WATCHED {
            // include_str! 只接受字面量路径，按文件名逐一映射。
            let src = match file {
                "fs.rs" => include_str!("fs.rs"),
                "pi_bridge.rs" => include_str!("pi_bridge.rs"),
                "artifacts.rs" => include_str!("artifacts.rs"),
                "browser.rs" => include_str!("browser.rs"),
                "conversation.rs" => include_str!("conversation.rs"),
                "attachments.rs" => include_str!("attachments.rs"),
                "mcp.rs" => include_str!("mcp.rs"),
                "agent_ops.rs" => include_str!("agent_ops.rs"),
                "library.rs" => include_str!("library.rs"),
                "experts.rs" => include_str!("experts.rs"),
                "roles.rs" => include_str!("roles.rs"),
                "skills.rs" => include_str!("skills.rs"),
                "models.rs" => include_str!("models.rs"),
                "projects.rs" => include_str!("projects.rs"),
                "run_meta.rs" => include_str!("run_meta.rs"),
                "connectors.rs" => include_str!("connectors.rs"),
                "tools.rs" => include_str!("tools.rs"),
                "extensions.rs" => include_str!("extensions.rs"),
                other => panic!("IO_WATCHED 里的 {other} 没有对应 include_str 分支"),
            };
            let lines: Vec<&str> = src.lines().collect();
            for name in names {
                let Some(i) = lines
                    .iter()
                    .position(|l| l.trim_start().starts_with(&format!("pub fn {name}(")) || l.trim_start().starts_with(&format!("pub async fn {name}(")))
                else {
                    panic!("{file}: 找不到命令 {name}（改名了？同步更新 IO_WATCHED）");
                };
                let attr = lines[..i]
                    .iter()
                    .rev()
                    .find(|l| l.trim_start().starts_with("#[tauri::command"))
                    .unwrap_or_else(|| panic!("{file}: {name} 不是 tauri 命令"));
                // `pub async fn` 声明的命令本身就是 future，Tauri 直接在异步运行时上
                // 执行，属性不写 (async) 也安全；只有 sync fn 才必须显式标注。
                let fn_is_async = lines[i].contains("async fn");
                assert!(
                    attr.contains("async") || fn_is_async,
                    "{file}: {name} 含磁盘/子进程 IO，必须写成 #[tauri::command(async)]（当前：{attr}）",
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

    /// A5：pi_restart 不再静默丢弃 in-flight 请求，而是以失败响应唤醒等待方。
    #[test]
    fn restart_drains_pending_with_error() {
        let state = PiState::default();
        let (tx, rx) = mpsc::channel();
        state
            .pending
            .lock()
            .unwrap()
            .insert("pi1".into(), tx);
        drain_pending_on_restart(&state);
        // pending 表已清空
        assert!(state.pending.lock().unwrap().is_empty());
        // 等待方拿到「内核重启」失败响应而非永久阻塞
        let resp = rx.recv().expect("等待方应被唤醒");
        assert_eq!(resp.get("success").and_then(|v| v.as_bool()), Some(false));
        assert!(
            resp.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .contains("内核重启"),
            "错误应说明内核重启：{resp}"
        );
    }

    /// G1：pi_stop 停止内核时，进行中的 RPC（compact 等长操作）必须收到
    /// 失败响应被唤醒，而不是被静默 clear——否则调用方干等 30s 超时。
    #[test]
    fn stop_drains_pending_with_error() {
        let state = PiState::default();
        let (tx, rx) = mpsc::channel();
        state
            .pending
            .lock()
            .unwrap()
            .insert("pi1".into(), tx);
        drain_pending(&state, "stop", "内核已停止，进行中的请求已丢弃");
        assert!(state.pending.lock().unwrap().is_empty());
        let resp = rx.recv().expect("等待方应被唤醒");
        assert_eq!(resp.get("success").and_then(|v| v.as_bool()), Some(false));
        let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("");
        assert!(err.contains("停止"), "错误应说明内核已停止：{resp}");
    }

    /// B2：journal 路径默认未设置；pi_start 之后才指向配置文件下的 events.jsonl。
    #[test]
    fn journal_path_unset_by_default() {
        let state = PiState::default();
        assert!(state.journal_path.lock().unwrap().is_none());
    }

    /// A4：journal 读回——全量按行解析为事件数组，`last_n` 只取末尾 N 条。
    /// 坏行（非 JSON / 空行）跳过，不中断重放。
    #[test]
    fn journal_read_parses_and_slices() {
        let dir = std::env::temp_dir().join(format!("pi-journal-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"message_start\"}\n",
                "not-json\n",
                "\n",
                "{\"type\":\"message_update\"}\n",
                "{\"type\":\"agent_settled\"}\n",
            ),
        )
        .unwrap();

        let state = PiState::default();
        *state.journal_path.lock().unwrap() = Some(path.clone());

        // 直接复用命令体同款逻辑：读文件 → 解析 → 截取。命令本身需要 Tauri
        // runtime，单测里验证同一段解析代码抽出的行为。
        let content = std::fs::read_to_string(&path).unwrap();
        let parse = |c: &str| -> Vec<Value> {
            c.lines()
                .filter(|l| !l.trim().is_empty())
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect()
        };
        let all = parse(&content);
        assert_eq!(all.len(), 3, "坏行与空行应被跳过");
        assert_eq!(all[0]["type"], "message_start");
        assert_eq!(all[2]["type"], "agent_settled");

        // last_n 截取语义与 pi_journal_read 一致：saturating_sub 后 split_off。
        let mut events = all.clone();
        let start = events.len().saturating_sub(2);
        let tail = events.split_off(start);
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0]["type"], "message_update");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// G4：pi_start 落一条 session_open（带 cwd）标记。内核 agent_start 不带
    /// cwd，回放无法区分消息属于哪个项目；桥补这条，回放据此按项目分段。
    #[test]
    fn session_open_marker_appends_with_cwd() {
        let dir = std::env::temp_dir().join(format!("pi-session-open-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.jsonl");
        append_session_open(&path, "/repo/a");
        append_session_open(&path, "/repo/b");
        let lines: Vec<Value> = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["type"], "session_open");
        assert_eq!(lines[0]["cwd"], "/repo/a");
        assert!(lines[0].get("pi_ts").is_some(), "带时间戳锚点");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 回归守卫：同一扩展名不得被多个候选目录重复选入，否则内核工具名冲突启动即崩
    /// （首页「有日志却无反应」的根因——dev 态 src-tauri/extensions 与
    /// target/debug/extensions 两份同源文件同时被 --extension 加载）。
    #[test]
    fn pick_unique_extensions_returns_one_source_per_name() {
        let root = std::env::temp_dir().join(format!("pi-ext-dedup-{}", std::process::id()));
        // 模拟开发态：源码树(src)与构建副本(out)都放了同一份 sandbox-env.ts
        let src = root.join("src-tauri").join("extensions");
        let out = root.join("target").join("debug").join("extensions");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(src.join("sandbox-env.ts"), b"// src").unwrap();
        std::fs::write(out.join("sandbox-env.ts"), b"// out").unwrap();
        // 另一个扩展只在 out 里有
        std::fs::write(out.join("role-inject.ts"), b"// role").unwrap();

        // 优先级：src 在前、out 在后
        let dirs = vec![src.clone(), out.clone()];
        let names = vec!["sandbox-env.ts".to_string(), "role-inject.ts".to_string()];
        let picked = pick_unique_extensions(&dirs, &names);

        // 每个扩展名恰好一个来源，绝不重复选入
        assert_eq!(picked.len(), 2, "不应重复选入同名扩展");
        assert!(picked.contains(&src.join("sandbox-env.ts")), "src 优先级更高");
        assert!(picked.contains(&out.join("role-inject.ts")));
        for p in &picked {
            assert!(p.exists(), "选中的扩展必须真实存在: {}", p.display());
        }

        std::fs::remove_dir_all(&root).ok();
    }

    /// 回归：agent 目录已有的扩展必须被过滤，缺失的才需要显式 `--extension`。
    /// 内核会自动加载 `<PI_CODING_AGENT_DIR>/extensions`，再传一份即同名工具冲突、
    /// 启动即崩（首页「有日志却无反应」的根因）。
    #[test]
    fn names_missing_in_skips_agent_dir_duplicates() {
        let root = std::env::temp_dir().join(format!("pw-names-missing-{}", std::process::id()));
        let agent = root.join("extensions");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(agent.join("sandbox-env.ts"), "export {}").unwrap();

        let names = vec![
            "sandbox-env.ts".to_string(),
            "role-inject.ts".to_string(),
        ];
        // agent 目录已有的 → 跳过；缺失的 → 保留
        assert_eq!(
            names_missing_in(Some(&agent), &names),
            vec!["role-inject.ts".to_string()]
        );
        // 取不到 agent 目录时全部保留（保守回退）
        assert_eq!(names_missing_in(None, &names), names);

        std::fs::remove_dir_all(&root).ok();
    }

    // ── run_meta 合并（运行记录菜单：置顶/重命名/归档/删除） ──────

    fn session(index: usize, cwd: &str) -> JournalSessionSummary {
        JournalSessionSummary {
            index,
            cwd: cwd.to_string(),
            started_at_ms: Some(1_000 + index as u64),
            ended_at_ms: Some(2_000 + index as u64),
            events: 3,
            prompts: 1,
            title: format!("原始标题 {index}"),
            pinned: false,
            archived: false,
            renamed: false,
        }
    }

    fn meta(
        cwd: &str,
        index: u32,
        pinned: bool,
        title: Option<&str>,
        archived: bool,
        deleted: bool,
    ) -> RunMetaEntry {
        RunMetaEntry {
            cwd: cwd.to_string(),
            index,
            pinned,
            title: title.map(|t| t.to_string()),
            archived,
            deleted,
        }
    }

    #[test]
    fn merge_keeps_plain_sessions_untouched() {
        let sessions = vec![session(0, "/repo/a"), session(1, "/repo/a")];
        let out = merge_run_meta(sessions, &[], false);
        assert_eq!(out.len(), 2);
        // 无任何元数据时只按既有约定排序：起止时间倒序（新→旧）。
        assert_eq!(out[0].index, 1);
        assert!(!out[0].pinned && !out[0].archived && !out[0].renamed);
        assert_eq!(out[0].title, "原始标题 1");
        assert_eq!(out[1].index, 0);
    }

    #[test]
    fn merge_filters_deleted_segments_permanently() {
        let sessions = vec![session(0, "/repo/a"), session(1, "/repo/a")];
        let entries = vec![meta("/repo/a", 0, false, None, false, true)];
        // deleted 与 include_archived 无关：永久过滤。
        assert!(merge_run_meta(sessions.clone(), &entries, false)
            .iter()
            .all(|s| s.index != 0));
        assert!(merge_run_meta(sessions, &entries, true)
            .iter()
            .all(|s| s.index != 0));
    }

    #[test]
    fn merge_hides_archived_unless_requested() {
        let sessions = vec![session(0, "/repo/a"), session(1, "/repo/a")];
        let entries = vec![meta("/repo/a", 0, false, None, true, false)];
        let hidden = merge_run_meta(sessions.clone(), &entries, false);
        assert_eq!(hidden.len(), 1);
        assert_eq!(hidden[0].index, 1);
        let shown = merge_run_meta(sessions, &entries, true);
        assert_eq!(shown.len(), 2);
        assert!(shown.iter().any(|s| s.index == 0 && s.archived));
    }

    #[test]
    fn merge_overrides_title_and_marks_renamed() {
        let sessions = vec![session(0, "/repo/a")];
        let entries = vec![meta("/repo/a", 0, false, Some("重点排查"), false, false)];
        let out = merge_run_meta(sessions, &entries, false);
        assert_eq!(out[0].title, "重点排查");
        assert!(out[0].renamed);
    }

    #[test]
    fn merge_pins_to_top_and_keeps_time_desc_within_groups() {
        // journal 段号随时间递增（0 最早，3 最新）。
        let sessions = vec![
            session(0, "/repo/a"),
            session(1, "/repo/a"),
            session(2, "/repo/a"),
            session(3, "/repo/a"),
        ];
        // 段 1 置顶；段 2 归档（include_archived=false 时应消失）。
        let entries = vec![
            meta("/repo/a", 1, true, None, false, false),
            meta("/repo/a", 2, false, None, true, false),
        ];
        let out = merge_run_meta(sessions, &entries, false);
        let order: Vec<usize> = out.iter().map(|s| s.index).collect();
        // pinned 组 [1] 在前，其余组内保持倒序 [3, 0]；
        // 段号即 journal 锚点，过滤/排序都不得重排。
        assert_eq!(order, vec![1, 3, 0]);
    }

    #[test]
    fn merge_matches_by_cwd_and_index() {
        let sessions = vec![session(0, "/repo/a"), session(0, "/repo/b")];
        let entries = vec![meta("/repo/b", 0, true, None, false, false)];
        let out = merge_run_meta(sessions, &entries, false);
        // 只有 /repo/b 的段 0 被置顶；/repo/a 的段 0 不受影响。
        assert_eq!(out[0].cwd, "/repo/b");
        assert!(out[0].pinned);
        assert_eq!(out[1].cwd, "/repo/a");
        assert!(!out[1].pinned);
    }
}
