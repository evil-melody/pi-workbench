//! 本地模型运行层：引擎探测、进程托管、模型目录、下载与接入。
//!
//! 边界：
//! - 不打包、不自带 llama.cpp，只接管本机已有 `llama-server`；
//! - 不改 Pi 内核，接入只写 `app-settings.json` 的模型条目，重启仍走既有 `pi_restart`；
//! - 所有落盘集中在 `<app_data>/local-models/`，避免模型散在多个目录。

mod catalog;
mod download;
mod probe;

use crate::models::{ModelConfig, AppSettings};
use probe::ProbeReport;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub use catalog::CatalogModel;

const READY_TIMEOUT_SECS: u64 = 90;

#[derive(Default)]
pub struct LocalEngineState {
    runtime: Mutex<Option<ManagedEngine>>,
    downloads: Mutex<HashMap<String, download::DownloadHandle>>,
}

struct ManagedEngine {
    child: Child,
    pid: u32,
    port: u16,
    model_file: String,
    model_name: String,
    base_url: String,
    started_at: u64,
    log_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineExit {
    pub at: u64,
    pub code: Option<i32>,
    /// manual / exited / signal
    pub kind: String,
    pub message: String,
    pub model: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct EngineHistory {
    last_exit: Option<EngineExit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub model_file: Option<String>,
    pub model_name: Option<String>,
    pub base_url: Option<String>,
    pub started_at: Option<u64>,
    pub last_exit: Option<EngineExit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PathsInfo {
    pub root: String,
    pub models_dir: String,
    pub logs_dir: String,
    pub engine_log: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HardwareInfo {
    pub total_memory_bytes: u64,
    /// macOS 统一内存：GPU 与系统共用同一池，显存不单列。
    pub unified_memory: bool,
    pub platform: String,
}

/// 目录条目附带本机适配判断：required_bytes 按 16k 上下文估算。
#[derive(Debug, Clone, Serialize)]
pub struct CatalogRow {
    #[serde(flatten)]
    pub model: CatalogModel,
    pub required_bytes: u64,
    /// comfortable / tight / no / unknown
    pub fit: String,
}

fn total_memory_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = Command::new("sysctl").args(["-n", "hw.memsize"]).output() {
            if let Ok(text) = String::from_utf8(out.stdout) {
                if let Ok(v) = text.trim().parse::<u64>() {
                    return v;
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(text) = fs::read_to_string("/proc/meminfo") {
            for line in text.lines() {
                if let Some(rest) = line.strip_prefix("MemTotal:") {
                    if let Some(kb) = rest
                        .split_whitespace()
                        .next()
                        .and_then(|v| v.parse::<u64>().ok())
                    {
                        return kb * 1024;
                    }
                }
            }
        }
    }
    0
}

#[derive(Debug, Clone, Serialize)]
pub struct InstalledModel {
    pub file: String,
    pub name: String,
    pub size_bytes: u64,
    pub modified_at: u64,
    pub quantization: String,
    pub in_use: bool,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Activation {
    pub model_id: String,
    pub model_name: String,
    pub base_url: String,
    pub needs_restart: bool,
}

/// 当前下载源。`active_tasks` 让设置页能提示「在途任务仍用旧源」。
#[derive(Debug, Clone, Serialize)]
pub struct DownloadSourceInfo {
    pub endpoint: String,
    /// mirror / official / custom
    pub mode: String,
    /// settings / env / default
    pub origin: String,
    pub mirror: &'static str,
    pub official: &'static str,
    pub active_tasks: usize,
}

fn root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("local-models"))
        .map_err(|e| format!("无法定位应用数据目录：{e}"))
}

fn paths(app: &AppHandle) -> Result<PathsInfo, String> {
    let root = root_dir(app)?;
    Ok(PathsInfo {
        models_dir: root.join("models").display().to_string(),
        logs_dir: root.join("logs").display().to_string(),
        engine_log: root.join("logs").join("engine.log").display().to_string(),
        root: root.display().to_string(),
    })
}

fn ensure_dirs(app: &AppHandle) -> Result<PathBuf, String> {
    let root = root_dir(app)?;
    fs::create_dir_all(root.join("models")).map_err(|e| format!("创建模型目录失败：{e}"))?;
    fs::create_dir_all(root.join("logs")).map_err(|e| format!("创建日志目录失败：{e}"))?;
    Ok(root)
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(root_dir(app)?.join("engine-state.json"))
}

fn load_history(app: &AppHandle) -> EngineHistory {
    history_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_exit(app: &AppHandle, exit: &EngineExit) {
    let Ok(path) = history_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let hist = EngineHistory {
        last_exit: Some(exit.clone()),
    };
    if let Ok(text) = serde_json::to_string_pretty(&hist) {
        let _ = fs::write(path, text);
    }
}

fn local_id(stem: &str) -> String {
    let cleaned: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '-' })
        .collect();
    format!("local-{cleaned}")
}

fn model_display_name(file: &str) -> String {
    catalog::find_by_file(file)
        .map(|m| m.name.to_string())
        .unwrap_or_else(|| file.trim_end_matches(".gguf").to_string())
}

fn quantization_of(file: &str) -> String {
    catalog::find_by_file(file)
        .map(|m| m.quantization.to_string())
        .unwrap_or_else(|| {
            let lower = file.to_lowercase();
            ["q4_k_m", "q4_0", "q5_k_m", "q8_0", "f16"]
                .iter()
                .find(|q| lower.contains(*q))
                .map(|q| q.to_uppercase())
                .unwrap_or_else(|| "—".to_string())
        })
}

fn now_ms() -> u64 {
    probe::now_ms()
}

fn status_of(app: &AppHandle, state: &LocalEngineState) -> EngineStatus {
    let guard = state.runtime.lock().ok();
    let last_exit = load_history(app).last_exit;
    let running: Option<&ManagedEngine> = guard.as_ref().and_then(|runtime| runtime.as_ref());
    match running {
        Some(engine) => EngineStatus {
            running: true,
            pid: Some(engine.pid),
            port: Some(engine.port),
            model_file: Some(engine.model_file.clone()),
            model_name: Some(engine.model_name.clone()),
            base_url: Some(engine.base_url.clone()),
            started_at: Some(engine.started_at),
            last_exit,
        },
        None => EngineStatus {
            running: false,
            pid: None,
            port: None,
            model_file: None,
            model_name: None,
            base_url: None,
            started_at: None,
            last_exit,
        },
    }
}

#[tauri::command]
pub async fn local_engine_probe() -> ProbeReport {
    tauri::async_runtime::spawn_blocking(probe::probe)
        .await
        .unwrap_or_else(|e| ProbeReport {
            found: false,
            usable: false,
            reason: Some(format!("探测任务异常：{e}")),
            checked: 0,
            checked_at: now_ms(),
            ..Default::default()
        })
}

#[tauri::command]
pub fn local_models_paths(app: AppHandle) -> Result<PathsInfo, String> {
    paths(&app)
}

#[tauri::command]
pub fn local_engine_status(app: AppHandle, state: State<'_, LocalEngineState>) -> EngineStatus {
    status_of(&app, &state)
}

#[tauri::command]
pub fn local_hardware_info() -> HardwareInfo {
    HardwareInfo {
        total_memory_bytes: total_memory_bytes(),
        unified_memory: cfg!(target_os = "macos"),
        platform: std::env::consts::OS.to_string(),
    }
}

#[tauri::command]
pub fn local_models_catalog() -> Vec<CatalogRow> {
    let total = total_memory_bytes();
    catalog::CATALOG
        .iter()
        .map(|m| {
            let required = catalog::estimate_peak_bytes(m, catalog::ESTIMATE_CTX);
            CatalogRow {
                model: m.clone(),
                required_bytes: required,
                fit: catalog::memory_fit(required, total).to_string(),
            }
        })
        .collect()
}

#[tauri::command]
pub fn local_download_source(
    app: AppHandle,
    state: State<'_, LocalEngineState>,
) -> DownloadSourceInfo {
    let settings = crate::models::settings_load(app);
    let (endpoint, origin) = catalog::resolve_endpoint(settings.download_source.as_deref());
    let active_tasks = state
        .downloads
        .lock()
        .map(|map| {
            map.values()
                .filter(|h| {
                    h.snapshot
                        .lock()
                        .map(|s| s.state == "downloading" || s.state == "cancelling")
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0);
    DownloadSourceInfo {
        mode: catalog::source_mode(&endpoint).to_string(),
        endpoint,
        origin: origin.to_string(),
        mirror: catalog::MIRROR_ENDPOINT,
        official: catalog::OFFICIAL_ENDPOINT,
        active_tasks,
    }
}

#[tauri::command]
pub fn local_models_list(
    app: AppHandle,
    state: State<'_, LocalEngineState>,
) -> Result<Vec<InstalledModel>, String> {
    let dir = ensure_dirs(&app)?.join("models");
    let running = state
        .runtime
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|e| e.model_file.clone()));
    let settings = crate::models::settings_load(app.clone());
    let active_id = settings.default_model_id.clone();

    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取模型目录失败：{e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(file) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !file.to_lowercase().ends_with(".gguf") {
            continue;
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let stem = file.trim_end_matches(".gguf");
        let lid = local_id(stem);
        out.push(InstalledModel {
            file: file.to_string(),
            name: model_display_name(file),
            size_bytes: meta.len(),
            modified_at: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            quantization: quantization_of(file),
            in_use: running.as_deref() == Some(file),
            active: active_id.as_deref() == Some(lid.as_str()),
        });
    }
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(out)
}

#[tauri::command]
pub fn local_downloads(state: State<'_, LocalEngineState>) -> Vec<download::DownloadSnapshot> {
    state
        .downloads
        .lock()
        .map(|map| {
            map.values()
                .filter_map(|h| h.snapshot.lock().ok().map(|s| s.clone()))
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn local_model_download(
    app: AppHandle,
    state: State<'_, LocalEngineState>,
    id: String,
) -> Result<download::DownloadSnapshot, String> {
    let model = catalog::find(&id).ok_or_else(|| format!("目录里没有这个模型：{id}"))?;
    let models_dir = ensure_dirs(&app)?.join("models");
    let final_path = models_dir.join(model.file);
    if final_path.exists() {
        return Err("该模型已下载，无需重复下载".to_string());
    }
    if let Some(existing) = state.downloads.lock().ok().and_then(|m| m.get(&id).cloned()) {
        if let Ok(snap) = existing.snapshot.lock() {
            if snap.state == "downloading" || snap.state == "cancelling" {
                return Ok(snap.clone());
            }
        }
    }

    let part_path = models_dir.join(format!("{}.part", model.file));
    // 源在任务启动时固定：之后改设置只影响新任务，续传不会跨域。
    let settings = crate::models::settings_load(app.clone());
    let (endpoint, _) = catalog::resolve_endpoint(settings.download_source.as_deref());
    let app_for_task = app.clone();
    let task = download::run(app_for_task, model, endpoint, final_path, part_path);
    let snapshot = task
        .snapshot
        .lock()
        .map(|s| s.clone())
        .map_err(|_| "下载任务状态不可用".to_string())?;
    if let Ok(mut map) = state.downloads.lock() {
        map.insert(id, task);
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn local_model_cancel(state: State<'_, LocalEngineState>, id: String) -> Result<(), String> {
    let map = state.downloads.lock().map_err(|e| e.to_string())?;
    let handle = map.get(&id).ok_or_else(|| "没有找到进行中的下载".to_string())?;
    handle.cancel.store(true, Ordering::Relaxed);
    if let Ok(mut snap) = handle.snapshot.lock() {
        if snap.state == "downloading" {
            snap.state = "cancelling".to_string();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn local_model_delete(
    app: AppHandle,
    state: State<'_, LocalEngineState>,
    file: String,
) -> Result<(), String> {
    let models_dir = ensure_dirs(&app)?.join("models");
    let path = safe_model_path(&models_dir, &file)?;
    if state
        .runtime
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|e| e.model_file.clone()))
        .as_deref()
        == Some(file.as_str())
    {
        return Err("引擎正在使用该模型，请先停止引擎再删除".to_string());
    }
    fs::remove_file(&path).map_err(|e| format!("删除失败：{e}"))?;
    let _ = fs::remove_file(models_dir.join(format!("{file}.part")));
    Ok(())
}

#[tauri::command]
pub async fn local_engine_start(
    app: AppHandle,
    state: State<'_, LocalEngineState>,
    file: String,
    ctx: Option<u32>,
) -> Result<EngineStatus, String> {
    let models_dir = ensure_dirs(&app)?.join("models");
    let model_path = safe_model_path(&models_dir, &file)?;
    if !model_path.is_file() {
        return Err(format!("模型文件不存在：{file}"));
    }

    {
        let guard = state.runtime.lock().map_err(|e| e.to_string())?;
        if let Some(engine) = guard.as_ref() {
            if engine.model_file == file {
                return Ok(status_of(&app, &state));
            }
            return Err(format!(
                "引擎正在运行 {}，请先停止后再切换模型",
                engine.model_name
            ));
        }
    }

    let report = tauri::async_runtime::spawn_blocking(probe::probe)
        .await
        .map_err(|e| format!("引擎探测失败：{e}"))?;
    if !report.usable {
        return Err(report
            .reason
            .unwrap_or_else(|| "未检测到可用的 llama-server".to_string()));
    }
    let engine_path = report.path.ok_or_else(|| "引擎路径为空".to_string())?;
    let port = pick_port()?;

    let log_path = root_dir(&app)?.join("logs").join("engine.log");
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("无法写入引擎日志：{e}"))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    let ctx = ctx.unwrap_or(4096).clamp(1024, 131072);
    let child = Command::new(&engine_path)
        .arg("-m")
        .arg(&model_path)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("-c")
        .arg(ctx.to_string())
        .arg("-ngl")
        .arg("99")
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .spawn()
        .map_err(|e| format!("启动引擎失败：{e}"))?;

    let pid = child.id();
    let started_at = now_ms();
    let base_url = format!("http://127.0.0.1:{port}/v1");
    let model_name = model_display_name(&file);
    if let Ok(mut guard) = state.runtime.lock() {
        *guard = Some(ManagedEngine {
            child,
            pid,
            port,
            model_file: file.clone(),
            model_name: model_name.clone(),
            base_url: base_url.clone(),
            started_at,
            log_path: log_path.clone(),
        });
    }
    spawn_monitor(app.clone());

    // 轮询 /health：llama-server 加载中返回 503，就绪后 200。
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;
    let health = format!("http://127.0.0.1:{port}/health");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(READY_TIMEOUT_SECS);

    loop {
        if state
            .runtime
            .lock()
            .map(|g| g.is_none())
            .unwrap_or(true)
        {
            let exit = load_history(&app).last_exit;
            let why = exit
                .map(|e| e.message)
                .unwrap_or_else(|| "进程已退出".to_string());
            return Err(format!("引擎启动后立即退出：{why}"));
        }
        if let Ok(resp) = client.get(&health).send().await {
            if resp.status().is_success() {
                break;
            }
        }
        if std::time::Instant::now() >= deadline {
            let _ = stop_engine(&app, &state);
            return Err(format!(
                "引擎启动超时（{READY_TIMEOUT_SECS} 秒）。最近日志：{}",
                tail_log(&log_path, 6)
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    }

    Ok(EngineStatus {
        running: true,
        pid: Some(pid),
        port: Some(port),
        model_file: Some(file),
        model_name: Some(model_name),
        base_url: Some(base_url),
        started_at: Some(started_at),
        last_exit: load_history(&app).last_exit,
    })
}

#[tauri::command]
pub fn local_engine_stop(
    app: AppHandle,
    state: State<'_, LocalEngineState>,
) -> Result<EngineStatus, String> {
    stop_engine(&app, &state)?;
    Ok(status_of(&app, &state))
}

/// 把当前引擎接入现有模型体系：写 `app-settings.json` 的模型条目并设为默认。
/// 真正的模型清单由既有 `pi_model_launch` 在下次 spawn 时写进 `models.json`。
#[tauri::command]
pub async fn local_model_activate(
    app: AppHandle,
    state: State<'_, LocalEngineState>,
    file: String,
) -> Result<Activation, String> {
    let (port, base_url) = {
        let guard = state.runtime.lock().map_err(|e| e.to_string())?;
        let engine = guard
            .as_ref()
            .ok_or_else(|| "引擎未运行，请先启动该模型".to_string())?;
        if engine.model_file != file {
            return Err(format!("当前运行的是 {}，请先启动所选模型", engine.model_name));
        }
        (engine.port, engine.base_url.clone())
    };

    let model_id_remote = fetch_model_id(port).await;
    let stem = file.trim_end_matches(".gguf");
    let id = local_id(stem);
    let name = model_display_name(&file);
    let model_name = model_id_remote.unwrap_or_else(|| stem.to_string());

    let mut settings: AppSettings = crate::models::settings_load(app.clone());
    let config = ModelConfig {
        id: id.clone(),
        name: format!("本地 · {name}"),
        provider: crate::models::LOCAL_PROVIDER.to_string(),
        base_url: base_url.clone(),
        model: model_name,
        api_key: String::new(),
        temperature: 0.6,
        max_tokens: 4096,
        enabled: true,
    };
    match settings.models.iter_mut().find(|m| m.id == id) {
        Some(existing) => *existing = config,
        None => settings.models.push(config),
    }
    settings.default_model_id = Some(id.clone());
    crate::models::settings_save(app.clone(), settings)?;

    Ok(Activation {
        model_id: id,
        model_name: name,
        base_url,
        needs_restart: true,
    })
}

fn safe_model_path(models_dir: &Path, file: &str) -> Result<PathBuf, String> {
    if file.is_empty() || file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err("模型文件名不合法".to_string());
    }
    Ok(models_dir.join(file))
}

fn pick_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("无法分配本地端口：{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    drop(listener);
    Ok(port)
}

async fn fetch_model_id(port: u16) -> Option<String> {
    let url = format!("http://127.0.0.1:{port}/v1/models");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()?;
    let resp = client.get(url).send().await.ok()?;
    let json: serde_json::Value = resp.json().await.ok()?;
    let id = json
        .get("data")?
        .as_array()?
        .first()?
        .get("id")?
        .as_str()?
        .to_string();
    // 实测 llama-server 把 `--model` 的绝对路径原样当作 id；
    // 这种路径不该写进 models.json，回退到文件名主干。
    if id.contains('/') || id.contains('\\') || id.ends_with(".gguf") {
        return None;
    }
    Some(id)
}

fn stop_engine(app: &AppHandle, state: &LocalEngineState) -> Result<(), String> {
    let engine = state
        .runtime
        .lock()
        .map_err(|e| e.to_string())?
        .take();
    let Some(mut engine) = engine else { return Ok(()) };
    let _ = engine.child.kill();
    let status = engine.child.wait().ok();
    save_exit(
        app,
        &EngineExit {
            at: now_ms(),
            code: status.and_then(|s| s.code()),
            kind: "manual".to_string(),
            message: "手动停止".to_string(),
            model: Some(engine.model_name.clone()),
        },
    );
    let _ = app.emit("local-engine://status", ());
    Ok(())
}

fn spawn_monitor(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let state = app.state::<LocalEngineState>();
        let exited = {
            let Ok(mut guard) = state.runtime.lock() else { break };
            match guard.as_mut() {
                None => break,
                Some(engine) => match engine.child.try_wait() {
                    Ok(Some(_)) => true,
                    Ok(None) => false,
                    Err(_) => true,
                },
            }
        };
        if !exited {
            continue;
        }
        let engine = {
            let Ok(mut guard) = state.runtime.lock() else { break };
            guard.take()
        };
        let Some(mut engine) = engine else { break };
        let status = engine.child.wait().ok();
        let code = status.and_then(|s| s.code());
        let message = if code == Some(0) {
            "进程正常退出（未收到停止指令）".to_string()
        } else {
            let tail = tail_log(&engine.log_path, 6);
            if tail.is_empty() {
                "进程异常退出，日志为空".to_string()
            } else {
                tail
            }
        };
        save_exit(
            &app,
            &EngineExit {
                at: now_ms(),
                code,
                kind: if code.is_none() { "signal" } else { "exited" }.to_string(),
                message,
                model: Some(engine.model_name),
            },
        );
        let _ = app.emit("local-engine://status", ());
        break;
    });
}

/// 尾部日志：引擎崩溃原因通常就在最后几行。
fn tail_log(path: &Path, lines: usize) -> String {
    let Ok(bytes) = fs::read(path) else { return String::new() };
    let start = bytes.len().saturating_sub(4096);
    let text = String::from_utf8_lossy(&bytes[start..]);
    let picked: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .rev()
        .take(lines)
        .collect();
    picked.into_iter().rev().collect::<Vec<_>>().join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal() {
        let dir = Path::new("/tmp/models");
        assert!(safe_model_path(dir, "../evil.gguf").is_err());
        assert!(safe_model_path(dir, "a/b.gguf").is_err());
        assert!(safe_model_path(dir, "ok.gguf").is_ok());
    }

    #[test]
    fn local_ids_are_stable() {
        assert_eq!(local_id("qwen2.5-1.5b"), "local-qwen2.5-1.5b");
        assert_eq!(local_id("a b"), "local-a-b");
    }

    #[test]
    fn catalog_rows_carry_fit_for_every_entry() {
        let rows = local_models_catalog();
        assert_eq!(rows.len(), catalog::CATALOG.len());
        for row in &rows {
            assert!(row.required_bytes > row.model.size_bytes, "{}", row.model.id);
            assert!(!row.fit.is_empty(), "{}", row.model.id);
        }
        eprintln!(
            "hardware total={} rows={}",
            total_memory_bytes(),
            rows.len()
        );
        for row in &rows {
            eprintln!(
                "{} need={} fit={}",
                row.model.id, row.required_bytes, row.fit
            );
        }
    }
}
