//! Git worktree 管理引擎：分支名寻址 + 状态总览 + 外部 agent 派发。
//!
//! 业界参照（2026-11 核实）：
//! - Worktrunk（worktrunk.dev）：分支名寻址、路径由模板计算、wt list 带状态；
//! - Claude Code `--worktree` / Codex worktrees：`.worktreeinclude` 拷贝
//!   gitignored 文件（.env 等）到新 worktree；
//! - Paradev（原 Superset）：端口是 worktree 的属性（本实现用 hash 分配），
//!   生命周期脚本交给调用方，本模块只做引擎。
//!
//! 二期（Pi 并行内核）：当前 PiState 是单内核单 cwd（见 state.rs），一个
//! worktree 一个 Pi 内核会话需要把 PiState 改成按 cwd 的多内核表，另行开工。
//! 本期外部 agent（claude / codex / 自定义命令）通过 `wt_agent` 在 worktree
//! 内派发，输出流式回传。

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ---------- 数据结构 ----------

#[derive(Debug, Clone, Serialize)]
pub struct WorktreeInfo {
    /// 检出的分支名（detached 时为空）。
    pub branch: String,
    /// worktree 绝对路径。
    pub path: String,
    /// 是否主工作区（仓库本身）。
    pub is_main: bool,
    /// 未提交改动文件数（含未跟踪）。
    pub dirty: u32,
    /// 相对 base 分支领先提交数。
    pub ahead: u32,
    /// 相对 base 分支落后提交数。
    pub behind: u32,
    /// 用于比较的 base 分支（main / master / 当前分支兜底）。
    pub base: String,
    /// 最近一次提交标题。
    pub last_commit: String,
    /// 最近一次提交时间（Unix 秒；无提交为 0）。
    pub last_commit_at: i64,
    /// 派生的 dev server 端口（hash 分配，30000-39999）。
    pub port: u16,
}

#[derive(Debug, Serialize)]
pub struct DiffFile {
    pub path: String,
    pub adds: i64,
    pub dels: i64,
}

#[derive(Debug, Serialize)]
pub struct DiffSummary {
    pub files: Vec<DiffFile>,
    /// 相对 base 的提交标题列表（旧 → 新）。
    pub commits: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct MergeOutcome {
    /// 每一步的执行记录（含失败原因），前端直接展示。
    pub steps: Vec<String>,
    /// 合并后是否清理了源 worktree 与分支。
    pub cleaned: bool,
}

#[derive(Debug, Deserialize)]
pub struct AgentLaunch {
    /// worktree 分支名（据此定位 worktree 路径）。
    pub branch: String,
    /// 预设：claude / codex / custom。
    pub agent: String,
    /// 任务 prompt。
    pub prompt: String,
    /// agent = custom 时：命令模板，`{prompt}` 占位符会被替换为
    /// shell 安全转义后的 prompt；无占位符则原样执行。
    #[serde(default)]
    pub custom_cmd: String,
}

// ---------- 舰队（并行派发）持久化 ----------

/// 一条 lane = 一个 worktree 上的一次 agent 执行。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FleetLane {
    pub branch: String,
    pub path: String,
    /// 前端生成的流 id，用于配对 `wt://agent-output`。
    pub id: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

/// 一次舰队派发 = 一个任务打到 N 个 worktree。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FleetRun {
    pub id: String,
    pub task: String,
    pub agent: String,
    pub lanes: Vec<FleetLane>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 内存登记表：运行中的 lane 状态实时反映在这里。
/// 磁盘账本（`<root>/.pi/fleets.jsonl`）由事件驱动追加，重启后可回放。
static FLEETS: Mutex<Option<HashMap<String, FleetRun>>> = Mutex::new(None);

fn fleets_locked() -> std::sync::MutexGuard<'static, Option<HashMap<String, FleetRun>>> {
    let mut g = match FLEETS.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if g.is_none() {
        *g = Some(HashMap::new());
    }
    g
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn fleet_log_path(root: &Path) -> PathBuf {
    root.join(".pi").join("fleets.jsonl")
}

/// 追加一条舰队事件到磁盘账本。失败不阻塞派发——账本丢了只是看板少一条历史。
fn append_fleet_event(root: &Path, run: &FleetRun) {
    let line = serde_json::to_string(run).unwrap_or_default();
    if line.is_empty() {
        return;
    }
    let path = fleet_log_path(root);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
        let _ = f.write_all(b"\n");
    }
}

// ---------- 内部工具 ----------

/// 在 dir 下执行 git，非零退出或无输出时返回 Err。
fn git_in(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git {args:?} 启动失败: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {args:?} 退出码 {:?}", out.status.code())
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// 宽松版 git：失败返回 None（列表场景里单个 worktree 查状态失败不应炸整页）。
fn git_ok(dir: &Path, args: &[&str]) -> Option<String> {
    git_in(dir, args).ok()
}

/// base 分支探测：origin/HEAD → main → master → 当前分支。
fn default_base(root: &Path, current: &str) -> String {
    for cand in ["origin/HEAD", "main", "master"] {
        let ok = if cand == "origin/HEAD" {
            git_ok(root, &["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])
        } else {
            git_ok(root, &["rev-parse", "--verify", "-q", &format!("refs/heads/{cand}")])
                .map(|_| cand.to_string())
        };
        if let Some(b) = ok {
            if !b.is_empty() {
                return b;
            }
        }
    }
    current.to_string()
}

/// 分支名 → 安全路径段：斜杠折叠，仅保留字母数字与 . - _。
fn sanitize_branch(branch: &str) -> String {
    branch
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

/// worktree 路径模板：与仓库同级 `{repo}.{branch}`（Worktrunk 默认布局）。
fn worktree_path_for(root: &Path, branch: &str) -> PathBuf {
    let name = root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".to_string());
    let dir = root.parent().unwrap_or(root);
    dir.join(format!("{name}.{}", sanitize_branch(branch)))
}

/// hash 端口：分支名决定端口，同一分支稳定，不同分支大概率不撞（2^16 空间取 1 万段）。
fn hash_port(branch: &str) -> u16 {
    let mut h = DefaultHasher::new();
    branch.hash(&mut h);
    30000 + (h.finish() % 10000) as u16
}

/// 单引号 shell 转义：把 `'` 变成 `'"'"'`，整段再包一层单引号。
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

/// `.worktreeinclude`：逐行相对路径，存在即拷贝到新 worktree
///（Claude Code / Codex 同款约定，覆盖 .env 这类 gitignored 文件）。
fn copy_worktreeinclude(root: &Path, dest: &Path) -> Vec<String> {
    let list = root.join(".worktreeinclude");
    let Ok(text) = std::fs::read_to_string(&list) else {
        return vec![];
    };
    let mut copied = vec![];
    for line in text.lines() {
        let rel = line.trim();
        if rel.is_empty() || rel.starts_with('#') {
            continue;
        }
        let from = root.join(rel);
        let to = dest.join(rel);
        if from.is_file()
            && std::fs::create_dir_all(to.parent().unwrap_or(dest)).is_ok()
            && std::fs::copy(&from, &to).is_ok()
        {
            copied.push(rel.to_string());
        }
    }
    copied
}

fn require_repo(root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root.trim());
    if root.as_os_str().is_empty() || !root.is_dir() {
        return Err("worktrees/项目根目录不存在".to_string());
    }
    // rev-parse --is-inside-work-tree 在裸仓库/非仓库下会失败。
    let inside = git_in(&root, &["rev-parse", "--is-inside-work-tree"])?;
    if inside != "true" {
        return Err("worktrees/目录不是 git 仓库".to_string());
    }
    Ok(root)
}

/// 列出全部 worktree（porcelain 解析），并逐个补状态。
fn collect_worktrees(root: &Path) -> Result<Vec<WorktreeInfo>, String> {
    let head = git_in(root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let base = default_base(root, &head);
    let porcelain = git_in(root, &["worktree", "list", "--porcelain"])?;
    let main_path = git_in(root, &["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .ok()
        .map(|p| {
            // git-common-dir 返回 `<repo>/.git`，取父目录即主工作区。
            PathBuf::from(p)
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| root.to_path_buf())
        })
        .unwrap_or_else(|| root.to_path_buf());

    let mut out = vec![];
    let mut current_path: Option<PathBuf> = None;
    let mut current_branch: Option<String> = None;
    let flush = |path: &Option<PathBuf>,
                 branch: &Option<String>,
                 out: &mut Vec<WorktreeInfo>,
                 _root: &Path,
                     base: &str,
                     main_path: &Path| {
        let (Some(path), Some(branch)) = (path, branch) else {
            return;
        };
        if branch.is_empty() {
            return; // detached HEAD：本期不支持作为可寻址 worktree
        }
        let dirty = git_ok(path, &["status", "--porcelain"])
            .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u32)
            .unwrap_or(0);
        let (mut ahead, mut behind) = (0u32, 0u32);
        if let Some(counts) = git_ok(
            path,
            &["rev-list", "--left-right", "--count", &format!("{base}...HEAD")],
        ) {
            // 输出形如 "behind<TAB>ahead"；base 不存在时命令失败，保持 0。
            let mut it = counts.split_whitespace();
            if let (Some(b), Some(a)) = (it.next(), it.next()) {
                behind = b.parse().unwrap_or(0);
                ahead = a.parse().unwrap_or(0);
            }
        }
        let (last_commit, last_commit_at) = git_ok(
            path,
            &["log", "-1", "--format=%s%x1f%ct"],
        )
        .and_then(|s| {
            let mut it = s.split('\x1f');
            Some((
                it.next().unwrap_or("").to_string(),
                it.next().and_then(|t| t.parse::<i64>().ok()).unwrap_or(0),
            ))
        })
        .unwrap_or_default();
        out.push(WorktreeInfo {
            branch: branch.clone(),
            path: path.to_string_lossy().to_string(),
            is_main: path.as_os_str() == main_path.as_os_str(),
            dirty,
            ahead,
            behind,
            base: base.to_string(),
            last_commit,
            last_commit_at,
            port: hash_port(branch),
        });
    };

    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&current_path, &current_branch, &mut out, root, &base, &main_path);
            current_path = Some(PathBuf::from(p));
            current_branch = None;
        } else if let Some(b) = line.strip_prefix("branch ") {
            current_branch = Some(b.trim_start_matches("refs/heads/").to_string());
        }
    }
    flush(&current_path, &current_branch, &mut out, root, &base, &main_path);
    Ok(out)
}

fn find_worktree<'a>(list: &'a [WorktreeInfo], branch: &str) -> Option<&'a WorktreeInfo> {
    list.iter().find(|w| w.branch == branch)
}

// ---------- Tauri 命令 ----------

/// 列出项目仓库的全部 worktree 与状态（dirty / ahead / behind / 端口）。
#[tauri::command]
pub fn wt_list(root: String) -> Result<Vec<WorktreeInfo>, String> {
    let root = require_repo(&root)?;
    collect_worktrees(&root)
}

/// 创建分支 + worktree，拷贝 `.worktreeinclude`，返回新 worktree 信息。
#[tauri::command]
pub fn wt_create(root: String, branch: String, base: Option<String>) -> Result<WorktreeInfo, String> {
    let root = require_repo(&root)?;
    let branch = branch.trim().to_string();
    if branch.is_empty() {
        return Err("worktrees/分支名不能为空".to_string());
    }
    let list = collect_worktrees(&root)?;
    if find_worktree(&list, &branch).is_some() {
        return Err(format!("worktrees/分支 {} 已有 worktree", branch));
    }
    let path = worktree_path_for(&root, &branch);
    if path.exists() {
        return Err(format!("worktrees/目标目录已存在: {}", path.display()));
    }
    let base = base
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| default_base(&root, ""));

    git_in(&root, &["worktree", "add", "-b", &branch, &path.to_string_lossy(), &base])?;
    // `.worktreeinclude` 覆盖 .env 等 gitignored 文件；拷不到不阻塞创建。
    let _copied = copy_worktreeinclude(&root, &path);
    collect_worktrees(&root)?
        .into_iter()
        .find(|w| w.branch == branch)
        .ok_or_else(|| "worktrees/创建后未在列表中找到新 worktree".to_string())
}

/// 删除 worktree 与分支。dirty 且未 force 时拒绝（防丢改动）。
#[tauri::command]
pub fn wt_remove(root: String, branch: String, force: Option<bool>) -> Result<(), String> {
    let root = require_repo(&root)?;
    let list = collect_worktrees(&root)?;
    let wt = find_worktree(&list, &branch)
        .ok_or_else(|| format!("worktrees/分支 {} 没有 worktree", branch))?
        .clone();
    if wt.is_main {
        return Err("worktrees/主工作区不能删除".to_string());
    }
    if wt.dirty > 0 && !force.unwrap_or(false) {
        return Err(format!("worktrees/{} 有 {} 个未提交改动，确认后加 force 重试", branch, wt.dirty));
    }
    git_in(&root, &["worktree", "remove", "--force", &wt.path])?;
    // 分支删除失败不阻塞（可能是共享分支），但把原因带出去。
    if let Err(e) = git_in(&root, &["branch", "-D", &branch]) {
        return Err(format!("worktrees/worktree 已删除，分支删除失败: {e}"));
    }
    Ok(())
}

/// 合并链：源 worktree 提交全部改动 → 目标分支 squash 合并 → 清理源 worktree 与分支。
///
/// git 限制：目标分支必须检出在某个 worktree 里才能在其目录执行合并。
#[tauri::command]
pub fn wt_merge(root: String, branch: String, target: Option<String>) -> Result<MergeOutcome, String> {
    let root = require_repo(&root)?;
    let list = collect_worktrees(&root)?;
    let src = find_worktree(&list, &branch)
        .ok_or_else(|| format!("worktrees/分支 {} 没有 worktree", branch))?
        .clone();
    let head = git_in(&root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let target = target
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(&head)
        .to_string();
    let dst = find_worktree(&list, &target)
        .ok_or_else(|| format!("worktrees/目标分支 {} 未检出在任何 worktree", target))?
        .clone();

    let mut steps = vec![];
    let src_path = PathBuf::from(&src.path);
    let dst_path = PathBuf::from(&dst.path);

    // 0) 空分支守卫：无改动也无领先提交，squash 合并会撞 "nothing to commit"。
    if src.dirty == 0 && src.ahead == 0 {
        return Ok(MergeOutcome {
            steps: vec![format!("○ {} 相对 {} 没有任何差异，无需合并", branch, target)],
            cleaned: false,
        });
    }

    // 1) 源 worktree 提交全部改动（无改动则跳过）。
    if src.dirty > 0 {
        let msg = format!("worktree {} 提交未保存改动", branch);
        git_in(&src_path, &["add", "-A"])?;
        git_in(&src_path, &["commit", "-m", &msg])?;
        steps.push(format!("✓ 提交 {} 个改动文件到 {}", src.dirty, branch));
    } else {
        steps.push(format!("○ {} 无未提交改动", branch));
    }

    // 2) squash 合并到目标分支。冲突即中止并保留现场让用户处理。
    if let Err(e) = git_in(&dst_path, &["merge", "--squash", &branch]) {
        let _ = git_in(&dst_path, &["merge", "--abort"]);
        return Err(format!("worktrees/squash 合并冲突或失败: {e}"));
    }
    let subject = git_in(&src_path, &["log", "-1", "--format=%s"]).unwrap_or_default();
    let commit_msg = if subject.is_empty() {
        format!("Merge worktree {}", branch)
    } else {
        subject
    };
    git_in(&dst_path, &["commit", "-m", &commit_msg])?;
    steps.push(format!("✓ squash 合并 {} → {}（{commit_msg}）", branch, target));

    // 3) 清理源 worktree 与分支（提交已进目标，-D 安全）。
    let mut cleaned = false;
    if !src.is_main {
        match git_in(&root, &["worktree", "remove", "--force", &src.path]) {
            Ok(_) => {
                let _ = git_in(&root, &["branch", "-D", &branch]);
                steps.push(format!("✓ 已清理 worktree 与分支 {}", branch));
                cleaned = true;
            }
            Err(e) => steps.push(format!("✗ 清理 worktree 失败: {e}（分支保留）")),
        }
    }
    Ok(MergeOutcome { steps, cleaned })
}

/// 相对 base 的 diff 概览：文件级 numstat + 提交列表。
#[tauri::command]
pub fn wt_diff(root: String, branch: String) -> Result<DiffSummary, String> {
    let root = require_repo(&root)?;
    let list = collect_worktrees(&root)?;
    let wt = find_worktree(&list, &branch)
        .ok_or_else(|| format!("worktrees/分支 {} 没有 worktree", branch))?;
    let base = &wt.base;
    let path = PathBuf::from(&wt.path);
    let numstat = git_in(&path, &["diff", "--numstat", &format!("{base}...HEAD")])?;
    let mut files = vec![];
    for line in numstat.lines().filter(|l| !l.trim().is_empty()) {
        let mut it = line.split('\t');
        let (adds, dels, p) = (
            it.next().unwrap_or("0"),
            it.next().unwrap_or("0"),
            it.next().unwrap_or(""),
        );
        if p.is_empty() {
            continue;
        }
        files.push(DiffFile {
            path: p.to_string(),
            adds: adds.parse().unwrap_or(0),
            dels: dels.parse().unwrap_or(0),
        });
    }
    let log = git_in(&path, &["log", "--format=%s", &format!("{base}..HEAD")])?;
    let mut commits: Vec<String> = log.lines().filter(|l| !l.trim().is_empty()).map(String::from).collect();
    commits.reverse();
    Ok(DiffSummary { files, commits })
}

/// 反废话纪律拼接：真源在 agent_style，所有执行器（claude/codex/pi/custom）
/// 通吃，不依赖对方认不认某个环境变量。
fn with_terse(prompt: String) -> String {
    let directive = crate::agent_style::terse_directive();
    if directive.is_empty() {
        prompt
    } else {
        format!("{prompt}\n\n{directive}")
    }
}

fn build_agent_cmd(launch: &AgentLaunch, prompt: &str) -> Result<String, String> {
    let cmd = match launch.agent.as_str() {
        "claude" => format!("claude -p {}", sh_quote(prompt)),
        "codex" => format!("codex exec {}", sh_quote(prompt)),
        // pi headless：-p 处理完退出，--no-session 不落会话文件（worktree 会话
        // 由 worktree 本身的 journal/分支承载，不重复存档）。
        "pi" => format!("pi -p --no-session {}", sh_quote(prompt)),
        "custom" => {
            let tpl = launch.custom_cmd.trim();
            if tpl.is_empty() {
                return Err("worktrees/自定义命令为空".to_string());
            }
            if tpl.contains("{prompt}") {
                tpl.replace("{prompt}", &sh_quote(prompt))
            } else {
                tpl.to_string()
            }
        }
        other => return Err(format!("worktrees/未知 agent: {other}")),
    };
    Ok(cmd)
}

/// 单条 lane 的 spawn + 流式回传；结束时回写舰队状态。
/// `fleet_id` 为 None 时是独立派发（不进看板）。
fn spawn_lane(
    app: AppHandle,
    root: PathBuf,
    wt: WorktreeInfo,
    stream_id: String,
    cmd: String,
    fleet_id: Option<String>,
) {
    std::thread::spawn(move || {
        let emit_line = |app: &AppHandle, id: &str, line: String| {
            let _ = app.emit(
                "wt://agent-output",
                serde_json::json!({ "id": id, "line": line }),
            );
        };
        emit_line(&app, &stream_id, format!("$ {cmd}"));
        let code = match Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .current_dir(&wt.path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(mut child) => {
                let stdout = child.stdout.take().unwrap();
                let stderr = child.stderr.take().unwrap();
                let app_o = app.clone();
                let id_o = stream_id.clone();
                let t_out = std::thread::spawn(move || {
                    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                        let _ = app_o.emit(
                            "wt://agent-output",
                            serde_json::json!({ "id": id_o, "line": line }),
                        );
                    }
                });
                let app_e = app.clone();
                let id_e = stream_id.clone();
                let t_err = std::thread::spawn(move || {
                    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                        let _ = app_e.emit(
                            "wt://agent-output",
                            serde_json::json!({ "id": id_e, "stream": "err", "line": line }),
                        );
                    }
                });
                let _ = t_out.join();
                let _ = t_err.join();
                child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1)
            }
            Err(e) => {
                emit_line(&app, &stream_id, format!("启动失败: {e}"));
                -1
            }
        };
        let _ = app.emit(
            "wt://agent-done",
            serde_json::json!({ "id": stream_id, "code": code }),
        );
        // 回写舰队 lane 状态（看板据此显示 运行中/成功/失败）。
        if let Some(fid) = fleet_id {
            {
                let mut guard = fleets_locked();
                let table = guard.as_mut().unwrap();
                if let Some(run) = table.get_mut(&fid) {
                    for lane in run.lanes.iter_mut() {
                        if lane.id == stream_id {
                            lane.status = if code == 0 { "done" } else { "failed" }.into();
                            lane.exit_code = Some(code);
                            lane.ended_at = Some(now_secs());
                        }
                    }
                    run.updated_at = now_secs();
                    append_fleet_event(&root, run);
                }
            }
        }
    });
}

/// 在单个 worktree 内派发外部 agent（单卡派发，不进舰队看板）。
#[tauri::command]
pub fn wt_agent(app: AppHandle, root: String, launch: AgentLaunch, id: String) -> Result<(), String> {
    let root = require_repo(&root)?;
    let list = collect_worktrees(&root)?;
    let wt = find_worktree(&list, &launch.branch)
        .ok_or_else(|| format!("worktrees/分支 {} 没有 worktree", launch.branch))?
        .clone();
    let prompt = launch.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("worktrees/任务 prompt 不能为空".to_string());
    }
    let prompt = with_terse(prompt);
    let cmd = build_agent_cmd(&launch, &prompt)?;
    spawn_lane(app, root, wt, id, cmd, None);
    Ok(())
}

/// 舰队派发入参：一个任务打到 N 个分支。
#[derive(Debug, Deserialize)]
pub struct FleetLaunch {
    pub task: String,
    pub agent: String,
    #[serde(default)]
    pub custom_cmd: String,
    /// 目标分支（worktree 必须已存在；新分支由前端先 wt_create 建好）。
    pub branches: Vec<String>,
}

/// 一次派发 N 条 lane，返回 fleet；lane 状态经 `wt_fleet_list` 查询。
/// 输出仍走 `wt://agent-output`（流 id = `<fleet>:<安全分支名>`）。
#[tauri::command(rename_all = "snake_case")]
pub fn wt_fleet_launch(
    app: AppHandle,
    root: String,
    launch: FleetLaunch,
    fleet_id: String,
) -> Result<FleetRun, String> {
    let root = require_repo(&root)?;
    let task = launch.task.trim().to_string();
    if task.is_empty() {
        return Err("worktrees/任务不能为空".to_string());
    }
    if launch.branches.is_empty() {
        return Err("worktrees/至少一个目标分支".to_string());
    }
    let list = collect_worktrees(&root)?;
    let prompt = with_terse(task.clone());
    let now = now_secs();
    let mut lanes = Vec::new();
    for branch in &launch.branches {
        let wt = find_worktree(&list, branch)
            .ok_or_else(|| format!("worktrees/分支 {branch} 没有 worktree"))?
            .clone();
        let agent_launch = AgentLaunch {
            branch: branch.clone(),
            agent: launch.agent.clone(),
            prompt: prompt.clone(),
            custom_cmd: launch.custom_cmd.clone(),
        };
        let cmd = build_agent_cmd(&agent_launch, &prompt)?;
        let stream_id = format!("{fleet_id}:{}", sanitize_branch(branch));
        lanes.push(FleetLane {
            branch: branch.clone(),
            path: wt.path.clone(),
            id: stream_id.clone(),
            status: "running".into(),
            exit_code: None,
            started_at: now,
            ended_at: None,
        });
        spawn_lane(app.clone(), root.clone(), wt, stream_id, cmd, Some(fleet_id.clone()));
    }
    let run = FleetRun {
        id: fleet_id.clone(),
        task,
        agent: launch.agent.clone(),
        lanes,
        created_at: now,
        updated_at: now,
    };
    {
        let mut guard = fleets_locked();
        guard.as_mut().unwrap().insert(fleet_id, run.clone());
    }
    append_fleet_event(&root, &run);
    Ok(run)
}

/// 舰队看板数据：内存表 + 磁盘账本合并（重启后仍能看历史）。
#[tauri::command]
pub fn wt_fleet_list(root: String) -> Result<Vec<FleetRun>, String> {
    let root = require_repo(&root)?;
    let mut merged: HashMap<String, FleetRun> = HashMap::new();
    // 先回放磁盘账本（旧 → 新，后来的行覆盖前面的）。
    if let Ok(text) = std::fs::read_to_string(fleet_log_path(&root)) {
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            if let Ok(run) = serde_json::from_str::<FleetRun>(line) {
                merged.insert(run.id.clone(), run);
            }
        }
    }
    // 内存表覆盖：进程内状态永远是最新的。
    let guard = fleets_locked();
    if let Some(table) = guard.as_ref() {
        for (id, run) in table {
            merged.insert(id.clone(), run.clone());
        }
    }
    let mut out: Vec<FleetRun> = merged.into_values().collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

// ---------- 合并冲突预测（Clash 思路） ----------

/// 一对 worktree 之间的文件级重叠。
#[derive(Debug, Serialize)]
pub struct ConflictPair {
    pub a: String,
    pub b: String,
    pub file: String,
    /// 重叠的行区间（1-based 闭区间）；medium 时为空。
    pub lines: Vec<[i64; 2]>,
    /// high = 行区间相交（几乎必冲突）；medium = 同文件不相交（git 或可自动合）。
    pub level: String,
}

/// 取 worktree 相对 base 的改动行区间：`git diff --unified=0 base...HEAD`
/// 的 hunk 头 `@@ -a,b +c,d @@` 给出新侧行范围。
fn changed_hunks(wt_path: &Path, base: &str) -> HashMap<String, Vec<[i64; 2]>> {
    let mut out: HashMap<String, Vec<[i64; 2]>> = HashMap::new();
    let Ok(diff) = git_in(wt_path, &["diff", "--unified=0", &format!("{base}...HEAD")]) else {
        return out;
    };
    let mut current = String::new();
    for line in diff.lines() {
        if let Some(p) = line.strip_prefix("+++ b/") {
            current = p.trim().to_string();
        } else if line.starts_with("@@ ") {
            if let Some(plus) = line.split_whitespace().find(|t| t.starts_with('+')) {
                let body = plus.trim_start_matches('+');
                let (start, count) = match body.split_once(',') {
                    Some((s, c)) => (s.parse::<i64>().unwrap_or(0), c.parse::<i64>().unwrap_or(1)),
                    None => (body.parse::<i64>().unwrap_or(0), 1),
                };
                if start > 0 && !current.is_empty() {
                    out.entry(current.clone()).or_default().push([start, start + count - 1]);
                }
            }
        }
    }
    out
}

/// 冲突预测：所有非主 worktree 两两比较改动行区间。
///
/// 只回答「哪些文件/行会撞」——语义冲突（同函数不同改法）仍靠任务拆解与
/// review 兜底，这是业界共识（Worktrunk / Claude Code 文档均如此）。
#[tauri::command]
pub fn wt_conflicts(root: String) -> Result<Vec<ConflictPair>, String> {
    let root = require_repo(&root)?;
    let list = collect_worktrees(&root)?;
    let mut hunks: Vec<(String, HashMap<String, Vec<[i64; 2]>>)> = Vec::new();
    for wt in &list {
        if wt.is_main {
            continue;
        }
        let h = changed_hunks(Path::new(&wt.path), &wt.base);
        if !h.is_empty() {
            hunks.push((wt.branch.clone(), h));
        }
    }
    let mut pairs = Vec::new();
    for i in 0..hunks.len() {
        for j in (i + 1)..hunks.len() {
            let (a, ha) = &hunks[i];
            let (b, hb) = &hunks[j];
            for (file, ranges_a) in ha {
                let Some(ranges_b) = hb.get(file) else { continue };
                let mut overlap: Vec<[i64; 2]> = Vec::new();
                for [s1, e1] in ranges_a {
                    for [s2, e2] in ranges_b {
                        let (lo, hi) = ((*s1).max(*s2), (*e1).min(*e2));
                        if lo <= hi {
                            overlap.push([lo, hi]);
                        }
                    }
                }
                let level = if overlap.is_empty() { "medium" } else { "high" };
                pairs.push(ConflictPair {
                    a: a.clone(),
                    b: b.clone(),
                    file: file.clone(),
                    lines: overlap,
                    level: level.into(),
                });
            }
        }
    }
    pairs.sort_by(|x, y| y.level.cmp(&x.level).then(x.file.cmp(&y.file)));
    Ok(pairs)
}
