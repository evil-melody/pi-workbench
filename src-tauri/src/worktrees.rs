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
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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

/// 在 worktree 内派发外部 agent（claude / codex / 自定义命令）。
/// 输出按行经 `wt://agent-output` 流式回传，结束发 `wt://agent-done`。
/// 返回 agentId 供前端配对流。
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
    let cmd = match launch.agent.as_str() {
        "claude" => format!("claude -p {}", sh_quote(&prompt)),
        "codex" => format!("codex exec {}", sh_quote(&prompt)),
        // pi headless：-p 处理完退出，--no-session 不落会话文件（worktree 会话
        // 由 worktree 本身的 journal/分支承载，不重复存档）。
        "pi" => format!("pi -p --no-session {}", sh_quote(&prompt)),
        "custom" => {
            let tpl = launch.custom_cmd.trim();
            if tpl.is_empty() {
                return Err("worktrees/自定义命令为空".to_string());
            }
            if tpl.contains("{prompt}") {
                tpl.replace("{prompt}", &sh_quote(&prompt))
            } else {
                tpl.to_string()
            }
        }
        other => return Err(format!("worktrees/未知 agent: {other}")),
    };

    let dir = PathBuf::from(wt.path);
    std::thread::spawn(move || {
        let emit_line = |app: &AppHandle, id: &str, line: String| {
            let _ = app.emit(
                "wt://agent-output",
                serde_json::json!({ "id": id, "line": line }),
            );
        };
        emit_line(&app, &id, format!("$ {cmd}"));
        match Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .current_dir(&dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(mut child) => {
                let stdout = child.stdout.take().unwrap();
                let stderr = child.stderr.take().unwrap();
                let app_o = app.clone();
                let id_o = id.clone();
                let t_out = std::thread::spawn(move || {
                    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                        let _ = app_o.emit(
                            "wt://agent-output",
                            serde_json::json!({ "id": id_o, "line": line }),
                        );
                    }
                });
                let app_e = app.clone();
                let id_e = id.clone();
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
                let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                let _ = app.emit("wt://agent-done", serde_json::json!({ "id": id, "code": code }));
            }
            Err(e) => {
                emit_line(&app, &id, format!("启动失败: {e}"));
                let _ = app.emit("wt://agent-done", serde_json::json!({ "id": id, "code": -1 }));
            }
        }
    });
    Ok(())
}
