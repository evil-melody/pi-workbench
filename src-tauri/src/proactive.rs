//! 主动任务账本 / 调度器 / 收件箱（阶段 1 MVP）。
//!
//! 最小闭环：定时触发 → 任务落账 → 无人值守执行 → 结果进收件箱 → 系统通知。
//!
//! 复用而非新建：
//! - 执行仍然走既有 `pi_bridge` 的常驻内核（`start_kernel` + `send_prompt`），
//!   不另起进程、不绕过 `pi_status` 的「单进程单任务」判定；
//! - 结果从既有 journal（`<config>/.pi/journal/events.jsonl`）按字节偏移增量读取，
//!   不新写一份会话记录；
//! - 审批硬边界落在既有的 `agent-tool-gate.ts`，本模块只负责写预授权策略文件。
//!
//! 持久化：`<app_config_dir>/proactive.json`（任务账本 + 收件箱）。每次变更立即落盘，
//! 启动时 `recover` 把「上次崩在 Running」的任务标成 Interrupted 并安排重试，
//! 不会静默丢任务。

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::state::PiState;

/// 调度轮询间隔。定时任务的精度要求是 ±60s，10s 一轮足够且几乎不耗 CPU。
const TICK: Duration = Duration::from_secs(10);
/// 单次无人值守执行的总时限；超时中止本轮并记失败，避免永久占用调度位。
const JOB_TIMEOUT_MS: u64 = 10 * 60 * 1000;
/// 下发 prompt 后内核迟迟不开始执行（无 key / 扩展崩）的等待上限。
const START_GRACE_MS: u64 = 90 * 1000;
/// 收件箱正文上限：只收结论，不复制整段 transcript。
const RESULT_MAX_CHARS: usize = 8000;
/// 单任务失败重试次数上限（首次执行 + 3 次重试由 attempts 语义区分）。
const MAX_ATTEMPTS: u32 = 3;
/// 预授权策略文件的有效期：任务跑飞后策略不会无限期挂在那里。
const POLICY_TTL_MS: u64 = 15 * 60 * 1000;
/// 驻留后台时内核的空闲回收阈值。只回收，不影响调度 tick 与账本。
const KERNEL_IDLE_MS: u64 = 5 * 60 * 1000;

// ── 领域模型 ──────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    /// 到点未执行 / 等待重试。
    Pending,
    /// 正在执行（进程崩溃后会由 recover 改成 Interrupted）。
    Running,
    /// 最近一次执行失败且仍有重试机会，或已用尽重试。
    Failed,
    /// 最近一次执行成功。
    Done,
    /// 上次退出时正在执行，已明确标记中断。
    Interrupted,
}

/// 无人值守预授权：硬边界由 `agent-tool-gate.ts` 执行，这里只声明额度。
/// 默认最小权限——空 bash 白名单 + 仅项目目录可写。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    /// bash 命令前缀白名单。空 = 所有需审批的风险命令一律拒绝。
    #[serde(default)]
    pub bash_allow: Vec<String>,
    /// 允许写入的根目录（绝对路径）。
    #[serde(default)]
    pub write_roots: Vec<String>,
    /// 单次运行的风险动作（需审批的 bash/write）上限；只读调用不计。
    #[serde(default = "default_tool_cap")]
    pub max_tool_calls: u32,
}

fn default_tool_cap() -> u32 {
    40
}

impl Grant {
    fn for_cwd(cwd: &str) -> Self {
        Self {
            bash_allow: Vec::new(),
            write_roots: if cwd.trim().is_empty() {
                Vec::new()
            } else {
                vec![cwd.to_string()]
            },
            max_tool_calls: default_tool_cap(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub title: String,
    pub prompt: String,
    /// 任务的工作目录（项目根）。执行时内核会切到该目录。
    pub cwd: String,
    /// 周期（秒）。首次 `next_at` 由创建时间 + 周期得出。
    pub interval_secs: u64,
    /// 下次触发的 Unix ms。
    pub next_at: u64,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub status: JobStatus,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default = "default_max_attempts")]
    pub max_attempts: u32,
    #[serde(default)]
    pub last_run_at: Option<u64>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default = "default_grant")]
    pub grant: Grant,
}

fn default_true() -> bool {
    true
}

fn default_max_attempts() -> u32 {
    MAX_ATTEMPTS
}

fn default_grant() -> Grant {
    Grant {
        bash_allow: Vec::new(),
        write_roots: Vec::new(),
        max_tool_calls: default_tool_cap(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub job_id: String,
    pub title: String,
    pub body: String,
    pub created_at: u64,
    #[serde(default)]
    pub read: bool,
    /// `result` = 成功产物；`failure` = 失败告警。
    pub kind: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProactiveStore {
    #[serde(default)]
    pub jobs: Vec<Job>,
    #[serde(default)]
    pub inbox: Vec<InboxItem>,
}

#[derive(Default)]
pub struct ProactiveState {
    pub store: Mutex<ProactiveStore>,
    /// 当前正在执行的 job id（进程内唯一调度位）。
    pub running_job: Mutex<Option<String>>,
    /// 系统通知发出后等待「点击 → 应用激活」的定位目标。
    pending_focus: Mutex<Option<(FocusTarget, u64)>>,
}

/// 通知点击定位目标：收件箱条目 + 它对应的任务。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusTarget {
    pub job_id: String,
    pub inbox_id: String,
}

/// 风险动作额度用量（由工具门写入 `proactive-usage.json`，这里只读展示）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantUsage {
    pub job_id: String,
    pub used: u32,
    #[serde(default)]
    pub max: u32,
    #[serde(default)]
    pub at: u64,
}

/// 前端一次拿全：任务列表 + 收件箱 + 未读数 + 正在执行的任务 + 额度用量。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub jobs: Vec<Job>,
    pub inbox: Vec<InboxItem>,
    pub unread: usize,
    pub running_job: Option<String>,
    pub grant_usage: Option<GrantUsage>,
}

// ── 纯函数（便于单测） ────────────────────────────────────────

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 托盘状态行：下次任务时间；没有启用任务时给出明确状态。
/// 时间用相对值，避免再引入本地时区格式化依赖。
pub fn next_run_label(store: &ProactiveStore, paused: bool, now: u64, lang: &str) -> String {
    let en = crate::i18n::is_en(lang);
    let next = store
        .jobs
        .iter()
        .filter(|j| j.enabled)
        .min_by_key(|j| j.next_at);
    let prefix = if !paused {
        ""
    } else if en {
        "Paused · "
    } else {
        "已暂停 · "
    };
    let Some(job) = next else {
        return if en {
            format!("{prefix}No enabled scheduled tasks")
        } else {
            format!("{prefix}暂无启用的定时任务")
        };
    };
    let diff = job.next_at.saturating_sub(now);
    let when = if diff == 0 {
        if en { "very soon" } else { "即将执行" }.to_string()
    } else if diff < 60_000 {
        if en { "in less than a minute" } else { "不到 1 分钟后" }.to_string()
    } else if diff < 3_600_000 {
        if en {
            format!("in about {} min", diff / 60_000)
        } else {
            format!("约 {} 分钟后", diff / 60_000)
        }
    } else if diff < 48 * 3_600_000 {
        if en {
            format!("in about {} h", diff / 3_600_000)
        } else {
            format!("约 {} 小时后", diff / 3_600_000)
        }
    } else if en {
        format!("in about {} d", diff / (24 * 3_600_000))
    } else {
        format!("约 {} 天后", diff / (24 * 3_600_000))
    };
    if en {
        format!("{prefix}Next task: {when} ({})", job.title)
    } else {
        format!("{prefix}下一个任务：{when}（{}）", job.title)
    }
}

fn min_interval(secs: u64) -> u64 {
    // 低于 60s 的周期只会把内核打满，且与验收口径（±60s）不一致。
    secs.max(60)
}

/// 启动恢复：Running 一律视为「上次没跑完」。有重试机会就重新排队，否则记失败。
/// 返回被恢复的任务数，便于启动日志自证。
pub fn recover(store: &mut ProactiveStore, now: u64) -> usize {
    let mut touched = 0;
    for job in store.jobs.iter_mut() {
        if job.status != JobStatus::Running {
            continue;
        }
        touched += 1;
        job.status = JobStatus::Interrupted;
        job.attempts += 1;
        job.last_error = Some("应用退出时任务仍在执行，已标记中断".into());
        if job.attempts < job.max_attempts {
            job.next_at = now;
        } else {
            job.status = JobStatus::Failed;
            job.last_error = Some("应用多次在执行中退出，已停止重试".into());
        }
    }
    touched
}

/// 选出一个到点的任务。单调度位：一次只返回一个。
pub fn select_due(store: &ProactiveStore, now: u64) -> Option<Job> {
    store
        .jobs
        .iter()
        .filter(|j| j.enabled)
        .filter(|j| j.next_at <= now)
        .filter(|j| match j.status {
            JobStatus::Running => false,
            JobStatus::Failed => j.attempts < j.max_attempts,
            // Done / Pending / Interrupted：到点即跑。
            _ => true,
        })
        .min_by_key(|j| j.next_at)
        .cloned()
}

/// 开始执行：状态置 Running、attempts +1。
/// **不动 `next_at`**：下一次触发按「计划时刻 + 周期」推算，
/// 而不是「完成时刻 + 周期」，否则每次执行耗时会累加成永久漂移。
pub fn mark_running(job: &mut Job, now: u64) {
    job.status = JobStatus::Running;
    job.attempts += 1;
    job.last_run_at = Some(now);
}

/// 成功：按计划时刻排下一次周期（错过多个周期时直接跳到未来最近一个），
/// attempts 归零。这样调度偏差不随运行次数累积。
pub fn mark_done(job: &mut Job, now: u64, inbox_id: String) {
    job.status = JobStatus::Done;
    job.attempts = 0;
    job.last_error = None;
    let interval_ms = min_interval(job.interval_secs) * 1000;
    let missed = now.saturating_sub(job.next_at) / interval_ms;
    job.next_at += (missed + 1) * interval_ms;
}

/// 失败：还有机会就 60s × attempts 退避重试；用尽则停在 Failed。
pub fn mark_failed(job: &mut Job, now: u64, error: &str) {
    job.status = JobStatus::Failed;
    job.last_error = Some(error.to_string());
    if job.attempts < job.max_attempts {
        job.next_at = now + 60_000 * job.attempts.max(1) as u64;
    }
}

pub fn unread_count(store: &ProactiveStore) -> usize {
    store.inbox.iter().filter(|i| !i.read).count()
}

// ── 持久化 ────────────────────────────────────────────────────

fn store_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("proactive.json"))
}

fn policy_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("proactive-policy.json"))
}

fn usage_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("proactive-usage.json"))
}

/// 读工具门写入的额度用量；文件缺失/损坏都按「暂无用量」处理。
fn read_usage(app: &AppHandle) -> Option<GrantUsage> {
    let path = usage_file(app).ok()?;
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<GrantUsage>(&text).ok()
}

fn journal_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(".pi").join("journal").join("events.jsonl"))
}

/// 落盘：先写临时文件再 rename，崩溃时不会留下半个 JSON 账本。
fn persist(app: &AppHandle, store: &ProactiveStore) -> Result<(), String> {
    let path = store_file(app)?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// 清空预授权策略。启动与「用户在聊天里发消息」时调用：
/// 无人值守授权只在任务执行窗口内有效，异常退出留下的策略文件不能继续生效。
pub(crate) fn clear_policy(app: &AppHandle) {
    let _ = write_policy(app, None);
}

pub fn load(app: &AppHandle, state: &State<ProactiveState>) {
    // 上一次进程可能死在任务中途，策略文件还挂着；启动第一件事就是清掉。
    clear_policy(app);
    let Ok(path) = store_file(app) else {
        return;
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut store) = serde_json::from_str::<ProactiveStore>(&text) else {
        return;
    };
    let now = now_ms();
    let recovered = recover(&mut store, now);
    *state.store.lock().unwrap() = store;
    if recovered > 0 {
        let _ = persist(app, &state.store.lock().unwrap());
        append_audit(
            app,
            serde_json::json!({ "kind": "recover", "count": recovered, "at": now }),
        );
    }
}

fn append_audit(app: &AppHandle, entry: serde_json::Value) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let path = dir.join("proactive-audit.jsonl");
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = writeln!(f, "{}", entry);
    }
}

/// 写预授权策略：`agent-tool-gate.ts` 每次工具调用前读这个文件。
/// `None` = 清除（没有无人值守任务在跑，恢复原来的交互审批语义）。
fn write_policy(app: &AppHandle, job: Option<&Job>) -> Result<(), String> {
    let path = policy_file(app)?;
    let body = match job {
        None => serde_json::json!({ "activeJob": null }),
        Some(job) => {
            let now = now_ms();
            serde_json::json!({
                "activeJob": {
                    "id": job.id,
                    "startedAt": now,
                    "expiresAt": now + POLICY_TTL_MS,
                    "grant": job.grant,
                }
            })
        }
    };
    fs::write(&path, serde_json::to_string(&body).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

// ── 执行 ──────────────────────────────────────────────────────

/// 从 journal 的起始字节偏移读出本轮 assistant 正文。
/// 只认 `message_update.assistantMessageEvent.type == text_delta` 的增量；
/// 读不到就退化为 message_end 里的完整文本（部分 provider 不发增量）。
fn extract_assistant_text(path: &Path, offset: u64) -> String {
    let Ok(mut f) = fs::File::open(path) else {
        return String::new();
    };
    if f.seek(SeekFrom::Start(offset)).is_err() {
        return String::new();
    }
    let mut raw = String::new();
    if f.read_to_string(&mut raw).is_err() {
        return String::new();
    }
    let mut text = String::new();
    let mut fallback = String::new();
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("message_update") => {
                let ev = v.get("assistantMessageEvent");
                if ev.and_then(|e| e.get("type")).and_then(|t| t.as_str()) == Some("text_delta") {
                    if let Some(delta) = ev.and_then(|e| e.get("delta")).and_then(|d| d.as_str()) {
                        text.push_str(delta);
                    }
                }
            }
            Some("message_end") => {
                let msg = v.get("message");
                if msg.and_then(|m| m.get("role")).and_then(|r| r.as_str()) == Some("assistant") {
                    if let Some(t) = msg
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_array())
                        .map(|parts| {
                            parts
                                .iter()
                                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                                .collect::<String>()
                        })
                    {
                        if !t.trim().is_empty() {
                            fallback = t;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let out = if text.trim().is_empty() { fallback } else { text };
    out.chars().take(RESULT_MAX_CHARS).collect()
}

/// 等这一轮跑完：先等开始（内核可能冷启动），再等 running 归零。
fn wait_for_turn(state: &PiState, timeout_ms: u64) -> Result<(), String> {
    let started = now_ms();
    let mut seen_running = false;
    loop {
        let running = state.running_since.lock().unwrap().is_some();
        if running {
            seen_running = true;
        } else if seen_running {
            return Ok(());
        } else if state.stdin_tx.lock().unwrap().is_none() {
            return Err("内核进程已退出，任务未执行".into());
        } else if now_ms().saturating_sub(started) > START_GRACE_MS {
            return Err("内核 90 秒内未开始执行（检查模型配置 / API Key）".into());
        }
        if now_ms().saturating_sub(started) > timeout_ms {
            return Err("任务执行超时（10 分钟）".into());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn push_inbox(
    store: &mut ProactiveStore,
    job: &Job,
    kind: &str,
    title: String,
    body: String,
) -> String {
    let id = format!("in-{}-{}", now_ms(), store.inbox.len());
    store.inbox.insert(
        0,
        InboxItem {
            id: id.clone(),
            job_id: job.id.clone(),
            title,
            body,
            created_at: now_ms(),
            read: false,
            kind: kind.to_string(),
        },
    );
    // 收件箱只保留最近 200 条，避免账本无限膨胀。
    store.inbox.truncate(200);
    id
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// 主动任务 prompt：头部带 job 标识，扩展据此打 source/jobId 并限流单轮写入。
pub fn job_prompt(job: &Job) -> String {
    format!(
        "【主动任务 {}】{}\n（若本轮产生可复用的长期结论，用 memory_store 写入，单轮最多 3 条。）\n\n{}",
        job.id, job.title, job.prompt
    )
}

/// 执行一个到点任务。**串行**：由唯一的调度线程调用，天然不会并发。
fn execute(app: &AppHandle, mut job: Job) {
    let started_at = now_ms();
    write_policy(app, Some(&job)).ok();
    // 新一次运行重置额度用量；工具门会边跑边写回已用次数。
    if let Ok(path) = usage_file(app) {
        let _ = fs::remove_file(path);
    }
    append_audit(
        app,
        serde_json::json!({ "kind": "job_start", "job": job.id, "at": started_at }),
    );

    let pi = app.state::<PiState>();
    let gov = app.state::<crate::governance::GovernanceState>();
    if let Err(e) = crate::pi_bridge::start_kernel(app, Some(job.cwd.clone()), pi.inner(), gov.inner())
    {
        finish_failure(app, job, format!("拉起内核失败：{e}"));
        return;
    }
    let Ok(journal) = journal_file(app) else {
        finish_failure(app, job, "取 journal 路径失败".into());
        return;
    };
    let offset = fs::metadata(&journal).map(|m| m.len()).unwrap_or(0);

    if let Err(e) = crate::pi_bridge::send_prompt(pi.inner(), &job_prompt(&job)) {
        finish_failure(app, job, format!("下发任务失败：{e}"));
        return;
    }
    let outcome = wait_for_turn(pi.inner(), JOB_TIMEOUT_MS);
    let text = extract_assistant_text(&journal, offset);
    let _ = write_policy(app, None);

    match outcome {
        Ok(()) if text.trim().is_empty() => {
            finish_failure(app, job, "任务已结束但没有产生任何输出".into())
        }
        Ok(()) => {
            let now = now_ms();
            let inbox_id = {
                let state = app.state::<ProactiveState>();
                let mut store = state.store.lock().unwrap();
                let inbox_id = push_inbox(
                    &mut store,
                    &job,
                    "result",
                    job.title.clone(),
                    text.clone(),
                );
                if let Some(j) = store.jobs.iter_mut().find(|j| j.id == job.id) {
                    mark_done(j, now, inbox_id.clone());
                }
                let _ = persist(app, &store);
                inbox_id
            };
            append_audit(
                app,
                serde_json::json!({
                    "kind": "job_done", "job": job.id, "inbox": inbox_id,
                    "at": now, "chars": text.chars().count()
                }),
            );
            // 记录「点击通知 → 定位」目标；应用随后的 90 秒内首次获得焦点即消费。
            set_focus_target(app.state::<ProactiveState>().inner(), &job.id, &inbox_id);
            let preview: String = text.chars().take(120).collect();
            let lang = crate::i18n::current(app);
            let title = if crate::i18n::is_en(lang) {
                format!("Task completed · {}", job.title)
            } else {
                format!("任务完成 · {}", job.title)
            };
            notify(app, &title, &preview);
            let _ = app.emit("proactive://changed", ());
        }
        Err(e) => finish_failure(app, job, e),
    }
}

fn finish_failure(app: &AppHandle, mut job: Job, error: String) {
    let _ = write_policy(app, None);
    let now = now_ms();
    let lang = crate::i18n::current(app);
    let failure_title = if crate::i18n::is_en(lang) {
        format!("Task failed · {}", job.title)
    } else {
        format!("任务失败 · {}", job.title)
    };
    {
        let state = app.state::<ProactiveState>();
        let mut store = state.store.lock().unwrap();
        mark_failed(&mut job, now, &error);
        if let Some(j) = store.jobs.iter_mut().find(|j| j.id == job.id) {
            *j = job.clone();
        }
        // 失败告警进收件箱：无人值守场景下，用户不打开应用也得知道任务黄了。
        let inbox_id = push_inbox(
            &mut store,
            &job,
            "failure",
            failure_title.clone(),
            error.clone(),
        );
        set_focus_target(&state, &job.id, &inbox_id);
        let _ = persist(app, &store);
    }
    append_audit(
        app,
        serde_json::json!({
            "kind": "job_failed", "job": job.id, "error": error, "attempts": job.attempts, "at": now
        }),
    );
    notify(app, &failure_title, &error);
    let _ = app.emit("proactive://changed", ());
}

/// 调度主循环：一个线程、10s 一轮、串行执行。
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        tick(&app);
    });
}

fn tick(app: &AppHandle) {
    // 托盘状态行每 tick 刷新：暂停态与下次任务时间都可能变化。
    crate::background::update_tray(app);

    // 记忆 24 小时撤销窗口到期判定：复用本条 tick 驱动，不新增循环。
    // 放在暂停/在跑判定之前，保证这两个状态下也能按时硬失效。
    let purged = crate::memory_store::purge_expired(app, now_ms());
    if purged > 0 {
        let _ = app.emit("memory://changed", purged);
    }
    // 画像缓存按 mtime 失效；扩展在 before_agent_start 直接读这份只读视图。
    crate::memory_store::refresh_profile(app);

    let state = app.state::<ProactiveState>();
    if state.running_job.lock().unwrap().is_some() {
        return;
    }
    // 复用 pi_status 的并发判定：内核正跑用户的一轮时，排队等下一 tick。
    let pi = app.state::<PiState>();
    if pi.running_since.lock().unwrap().is_some() {
        return;
    }

    // 窗口隐藏且空闲满 5 分钟：回收内核。暂停态也回收，任务到点会重新拉起。
    crate::pi_bridge::reap_if_idle(app, &pi, KERNEL_IDLE_MS);

    if crate::background::is_paused(app) {
        return;
    }

    let now = now_ms();
    let due = {
        let store = state.store.lock().unwrap();
        select_due(&store, now)
    };
    let Some(mut job) = due else { return };

    mark_running(&mut job, now);
    *state.running_job.lock().unwrap() = Some(job.id.clone());
    {
        let mut store = state.store.lock().unwrap();
        if let Some(j) = store.jobs.iter_mut().find(|j| j.id == job.id) {
            *j = job.clone();
        }
        let _ = persist(app, &store);
    }

    // 调度线程是唯一执行入口：一次 panic 不能把整条主动服务链路带走，
    // 所以就地兜住并立即把任务标失败（而不是留一个永远 Running 的僵尸）。
    let panic_id = job.id.clone();
    let guarded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        execute(app, job);
    }));
    if guarded.is_err() {
        // 任务不能停在 Running：立刻标失败并留审计，下一次 tick 可重试。
        let now = now_ms();
        {
            let mut store = state.store.lock().unwrap();
            if let Some(j) = store.jobs.iter_mut().find(|j| j.id == panic_id) {
                mark_failed(j, now, "调度执行异常，已标记失败");
            }
            let _ = persist(app, &store);
        }
        append_audit(
            app,
            serde_json::json!({ "kind": "scheduler_panic", "job": panic_id, "at": now }),
        );
    }
    *state.running_job.lock().unwrap() = None;
    let _ = app.emit("proactive://changed", ());
}

// ── 命令层 ────────────────────────────────────────────────────

fn snapshot(app: &AppHandle, state: &ProactiveState) -> Snapshot {
    let store = state.store.lock().unwrap();
    Snapshot {
        jobs: store.jobs.clone(),
        inbox: store.inbox.clone(),
        unread: unread_count(&store),
        running_job: state.running_job.lock().unwrap().clone(),
        grant_usage: read_usage(app),
    }
}

#[tauri::command(async)]
pub fn proactive_snapshot(app: AppHandle, state: State<'_, ProactiveState>) -> Snapshot {
    snapshot(&app, &state)
}

/// 新建任务。周期最小 60s；首次触发 = 创建时刻 + 一个周期。
#[tauri::command(async)]
#[allow(non_snake_case)]
pub fn proactive_job_create(
    app: AppHandle,
    title: String,
    prompt: String,
    cwd: String,
    interval_secs: u64,
    state: State<'_, ProactiveState>,
) -> Result<Snapshot, String> {
    if title.trim().is_empty() {
        return Err("任务标题不能为空".into());
    }
    if prompt.trim().is_empty() {
        return Err("任务内容不能为空".into());
    }
    if cwd.trim().is_empty() {
        return Err("必须绑定项目目录，否则无人值守会跑在任意目录".into());
    }
    let now = now_ms();
    let interval = min_interval(interval_secs);
    let job = Job {
        id: format!("job-{now}-{}", state.store.lock().unwrap().jobs.len()),
        title: title.trim().to_string(),
        prompt: prompt.trim().to_string(),
        cwd: cwd.trim().to_string(),
        interval_secs: interval,
        next_at: now + interval * 1000,
        enabled: true,
        status: JobStatus::Pending,
        attempts: 0,
        max_attempts: MAX_ATTEMPTS,
        last_run_at: None,
        last_error: None,
        grant: Grant::for_cwd(cwd.trim()),
    };
    {
        let mut store = state.store.lock().unwrap();
        store.jobs.push(job);
        persist(&app, &store)?;
    }
    Ok(snapshot(&app, &state))
}

#[tauri::command(async)]
#[allow(non_snake_case)]
pub fn proactive_job_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
    state: State<'_, ProactiveState>,
) -> Result<Snapshot, String> {
    {
        let mut store = state.store.lock().unwrap();
        let Some(job) = store.jobs.iter_mut().find(|j| j.id == id) else {
            return Err("任务不存在".into());
        };
        job.enabled = enabled;
        if enabled && job.status == JobStatus::Running {
            job.status = JobStatus::Pending;
        }
        persist(&app, &store)?;
    }
    Ok(snapshot(&app, &state))
}

#[tauri::command(async)]
#[allow(non_snake_case)]
pub fn proactive_job_remove(
    app: AppHandle,
    id: String,
    state: State<'_, ProactiveState>,
) -> Result<Snapshot, String> {
    {
        let mut store = state.store.lock().unwrap();
        store.jobs.retain(|j| j.id != id);
        persist(&app, &store)?;
    }
    Ok(snapshot(&app, &state))
}

/// 立即执行一次：只把 next_at 提前，仍由调度线程串行取走，
/// 不绕过 `pi_status` 另起一条执行路径。
#[tauri::command(async)]
pub fn proactive_job_run_now(
    app: AppHandle,
    id: String,
    state: State<'_, ProactiveState>,
) -> Result<Snapshot, String> {
    {
        let mut store = state.store.lock().unwrap();
        let Some(job) = store.jobs.iter_mut().find(|j| j.id == id) else {
            return Err("任务不存在".into());
        };
        job.next_at = now_ms();
        job.attempts = 0;
        persist(&app, &store)?;
    }
    Ok(snapshot(&app, &state))
}

/// 修改预授权：只有空闲任务可改，避免运行中途提权。
/// 写入根不可编辑（固定为任务的项目目录），只允许调整 bash 命令前缀与风险动作额度。
#[tauri::command(async)]
#[allow(non_snake_case)]
pub fn proactive_job_set_grant(
    app: AppHandle,
    id: String,
    bash_allow: Vec<String>,
    max_tool_calls: u32,
    state: State<'_, ProactiveState>,
) -> Result<Snapshot, String> {
    {
        let mut store = state.store.lock().unwrap();
        let Some(job) = store.jobs.iter_mut().find(|j| j.id == id) else {
            return Err("任务不存在".into());
        };
        if job.status == JobStatus::Running {
            return Err("任务执行中，预授权不可修改（避免中途提权）".into());
        }
        if max_tool_calls == 0 || max_tool_calls > 200 {
            return Err("风险动作额度必须在 1 到 200 之间".into());
        }
        let mut allow: Vec<String> = Vec::new();
        for raw in bash_allow {
            let prefix = raw.trim();
            if prefix.is_empty() {
                continue;
            }
            if prefix.chars().count() > 120 {
                return Err(format!("命令前缀过长：{prefix}"));
            }
            // 前缀匹配是文本比较；允许分隔符等于允许拼接任意命令。
            if prefix
                .chars()
                .any(|c| matches!(c, ';' | '\n' | '\r' | '|' | '&' | '`' | '$'))
            {
                return Err(format!("命令前缀不能包含分隔符或变量展开：{prefix}"));
            }
            if !allow.iter().any(|p| p == prefix) {
                allow.push(prefix.to_string());
            }
        }
        job.grant.bash_allow = allow;
        job.grant.max_tool_calls = max_tool_calls;
        persist(&app, &store)?;
    }
    Ok(snapshot(&app, &state))
}

/// 取出一次「通知点击」定位目标。
/// 桌面通知没有可靠的点击回调，这里用「应用重新获得焦点」作为点击代理：
/// 通知发出后 90 秒内首次取用有效，取完即清，避免普通切窗口误触发。
#[tauri::command(async)]
pub fn proactive_take_focus(state: State<'_, ProactiveState>) -> Option<FocusTarget> {
    let mut guard = state.pending_focus.lock().unwrap();
    match guard.take() {
        Some((target, at)) if now_ms().saturating_sub(at) <= 90_000 => Some(target),
        _ => None,
    }
}

fn set_focus_target(state: &ProactiveState, job_id: &str, inbox_id: &str) {
    *state.pending_focus.lock().unwrap() = Some((
        FocusTarget {
            job_id: job_id.to_string(),
            inbox_id: inbox_id.to_string(),
        },
        now_ms(),
    ));
}

#[tauri::command(async)]
pub fn proactive_inbox_mark(
    app: AppHandle,
    id: String,
    read: bool,
    state: State<'_, ProactiveState>,
) -> Result<Snapshot, String> {
    {
        let mut store = state.store.lock().unwrap();
        for item in store.inbox.iter_mut().filter(|i| i.id == id) {
            item.read = read;
        }
        persist(&app, &store)?;
    }
    Ok(snapshot(&app, &state))
}

#[tauri::command(async)]
pub fn proactive_inbox_mark_all_read(
    app: AppHandle,
    state: State<'_, ProactiveState>,
) -> Result<Snapshot, String> {
    {
        let mut store = state.store.lock().unwrap();
        for item in store.inbox.iter_mut() {
            item.read = true;
        }
        persist(&app, &store)?;
    }
    Ok(snapshot(&app, &state))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str, next_at: u64) -> Job {
        Job {
            id: id.into(),
            title: id.into(),
            prompt: "p".into(),
            cwd: "/repo".into(),
            interval_secs: 3600,
            next_at,
            enabled: true,
            status: JobStatus::Pending,
            attempts: 0,
            max_attempts: MAX_ATTEMPTS,
            last_run_at: None,
            last_error: None,
            grant: Grant::for_cwd("/repo"),
        }
    }

    #[test]
    fn select_due_picks_earliest_enabled() {
        let mut store = ProactiveStore::default();
        store.jobs.push(job("late", 2_000));
        store.jobs.push(job("early", 1_000));
        let picked = select_due(&store, 5_000).unwrap();
        assert_eq!(picked.id, "early", "应按 next_at 取最早到点的");
    }

    #[test]
    fn select_due_skips_disabled_running_and_exhausted() {
        let mut store = ProactiveStore::default();
        let mut disabled = job("disabled", 0);
        disabled.enabled = false;
        let mut running = job("running", 0);
        running.status = JobStatus::Running;
        let mut exhausted = job("exhausted", 0);
        exhausted.status = JobStatus::Failed;
        exhausted.attempts = MAX_ATTEMPTS;
        store.jobs = vec![disabled, running, exhausted];
        assert!(select_due(&store, 10_000).is_none());
    }

    #[test]
    fn select_due_retries_failed_with_attempts_left() {
        let mut store = ProactiveStore::default();
        let mut failed = job("retry", 0);
        failed.status = JobStatus::Failed;
        failed.attempts = 1;
        store.jobs.push(failed);
        assert_eq!(select_due(&store, 10).unwrap().id, "retry");
    }

    #[test]
    fn recover_marks_running_interrupted_and_requeues() {
        let mut store = ProactiveStore::default();
        let mut running = job("r", 0);
        running.status = JobStatus::Running;
        running.attempts = 1;
        store.jobs.push(running);

        let n = recover(&mut store, 9_000);
        assert_eq!(n, 1);
        assert_eq!(store.jobs[0].status, JobStatus::Interrupted);
        assert_eq!(store.jobs[0].next_at, 9_000, "有重试机会应立即重新排队");
        assert_eq!(store.jobs[0].attempts, 2);
    }

    #[test]
    fn recover_stops_after_max_attempts() {
        let mut store = ProactiveStore::default();
        let mut running = job("r", 0);
        running.status = JobStatus::Running;
        running.attempts = MAX_ATTEMPTS - 1;
        store.jobs.push(running);

        recover(&mut store, 9_000);
        assert_eq!(store.jobs[0].status, JobStatus::Failed);
    }

    #[test]
    fn mark_failed_backs_off_then_stops() {
        let mut j = job("j", 0);
        j.attempts = 1;
        mark_failed(&mut j, 10_000, "boom");
        assert_eq!(j.status, JobStatus::Failed);
        assert_eq!(j.next_at, 70_000, "第一次失败退避 60s");

        j.attempts = MAX_ATTEMPTS;
        mark_failed(&mut j, 10_000, "boom");
        assert_eq!(j.next_at, 70_000, "用尽重试后不再推进 next_at（停在最后一次退避值）");
    }

    #[test]
    fn mark_done_resets_attempts_and_schedules_next() {
        let mut j = job("j", 0);
        j.attempts = 2;
        mark_done(&mut j, 1_000, "inbox".into());
        assert_eq!(j.status, JobStatus::Done);
        assert_eq!(j.attempts, 0);
        // 按计划时刻推进：0 + 1 个周期，而不是「完成时刻 + 周期」。
        assert_eq!(j.next_at, 3600 * 1000);
    }

    #[test]
    fn mark_done_catches_up_without_double_run() {
        let mut j = job("j", 0);
        j.interval_secs = 60;
        // 迟了 10 个周期才完成：直接跳到第 11 个周期，不补跑。
        mark_done(&mut j, 10 * 60_000 + 5_000, "inbox".into());
        assert_eq!(j.next_at, 11 * 60_000);
    }

    /// 长跑验证的缩短版：1000 个周期，每个周期都晚 5s 完成，
    /// 计划时刻必须严格等于 `周期 × 次数`，偏差为 0。
    #[test]
    fn scheduler_does_not_drift_over_1000_cycles() {
        let mut j = job("j", 0);
        j.interval_secs = 60;
        let interval = 60_000;
        for _ in 0..1000 {
            let now = j.next_at + 5_000; // 模拟 tick 延迟与执行耗时
            mark_running(&mut j, now);
            mark_done(&mut j, now, "inbox".into());
        }
        assert_eq!(j.next_at, 1000 * interval, "1000 个周期后计划时刻零漂移");
    }

    #[test]
    fn interval_is_clamped_to_one_minute() {
        assert_eq!(min_interval(5), 60);
        assert_eq!(min_interval(3600), 3600);
    }

    #[test]
    fn next_run_label_reports_nearest_enabled_job() {
        let mut store = ProactiveStore::default();
        store.jobs.push(job("晚", 3 * 60_000));
        store.jobs.push(job("近", 2 * 60_000));
        let label = next_run_label(&store, false, 0, "zh");
        assert_eq!(label, "下一个任务：约 2 分钟后（近）");
    }

    #[test]
    fn next_run_label_handles_paused_and_empty() {
        let mut store = ProactiveStore::default();
        assert_eq!(next_run_label(&store, false, 0, "zh"), "暂无启用的定时任务");

        let mut disabled = job("停用", 60_000);
        disabled.enabled = false;
        store.jobs.push(disabled);
        assert_eq!(
            next_run_label(&store, true, 0, "zh"),
            "已暂停 · 暂无启用的定时任务"
        );

        store.jobs[0].enabled = true;
        assert!(next_run_label(&store, true, 0, "zh").starts_with("已暂停 · 下一个任务："));
    }

    #[test]
    fn unread_count_only_counts_unread() {
        let mut store = ProactiveStore::default();
        store.inbox.push(InboxItem {
            id: "a".into(),
            job_id: "j".into(),
            title: "t".into(),
            body: "b".into(),
            created_at: 0,
            read: false,
            kind: "result".into(),
        });
        store.inbox.push(InboxItem {
            id: "b".into(),
            job_id: "j".into(),
            title: "t".into(),
            body: "b".into(),
            created_at: 0,
            read: true,
            kind: "result".into(),
        });
        assert_eq!(unread_count(&store), 1);
    }
}
