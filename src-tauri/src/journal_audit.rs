//! journal 自检与修复。
//!
//! journal 是 `<config>/.pi/journal/events.jsonl`：一行一个事件，只追加。
//! 历史版本用「单行小于 PIPE_BUF，追加写天然原子」的假设直接并发写，
//! 结果旧内核的 `process_exit` 与新内核的 `session_open` 在同一毫秒交错，
//! 半行拼成坏 JSON。这里提供只读自检与可预览的修复：坏行备份后剔除，
//! 缺收尾的 run 补一条 `run_end`，原文件先备份再原子替换。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

/// 一条问题记录：行号从 1 起，与编辑器/`sed -n` 一致。
#[derive(Debug, Clone, Serialize)]
pub struct Issue {
    pub line: usize,
    pub kind: String,
    pub detail: String,
}

/// 修复计划：只描述动作，不落盘。
#[derive(Debug, Clone, Serialize)]
pub struct Plan {
    /// 要剔除的行号（坏 JSON / 尾行残片）。
    pub drop_lines: Vec<usize>,
    /// 要补齐收尾的 runId。
    pub close_runs: Vec<String>,
    pub backup_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub path: String,
    pub total_lines: usize,
    pub valid_lines: usize,
    pub issues: Vec<Issue>,
    /// 按 runId 统计的重复 run_start 次数。
    pub duplicate_runs: Vec<String>,
    /// 有 run_start 但没有收尾的 runId。
    pub open_runs: Vec<String>,
    pub plan: Plan,
}

fn ts_of(v: &Value) -> Option<u64> {
    v.get("pi_ts")
        .and_then(|t| t.as_u64())
        .or_else(|| v.get("ts_ms").and_then(|t| t.as_u64()))
}

fn run_id_of(v: &Value) -> Option<&str> {
    v.get("runId").and_then(|r| r.as_str())
}

/// 收尾判定：`run_end` 或 `agent_settled` 都算本轮结束。
fn is_run_end(v: &Value) -> bool {
    matches!(
        v.get("type").and_then(|t| t.as_str()),
        Some("run_end") | Some("agent_settled")
    )
}

pub fn check_file(path: &Path) -> Result<Report, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("读取 journal 失败（{path:?}）: {e}"))?;
    let truncated_tail = !raw.is_empty() && !raw.ends_with('\n');
    let mut issues = Vec::new();
    let mut parsed: Vec<(usize, Value)> = Vec::new();
    let mut total = 0usize;
    let mut starts: std::collections::HashMap<String, usize> = Default::default();
    let mut ended: std::collections::HashSet<String> = Default::default();

    for (idx, line) in raw.lines().enumerate() {
        let no = idx + 1;
        if line.trim().is_empty() {
            continue;
        }
        total += 1;
        match serde_json::from_str::<Value>(line) {
            Ok(v) => {
                if let Some(id) = run_id_of(&v) {
                    if v.get("type").and_then(|t| t.as_str()) == Some("run_start") {
                        *starts.entry(id.to_string()).or_default() += 1;
                    }
                    if is_run_end(&v) {
                        ended.insert(id.to_string());
                    }
                }
                parsed.push((no, v));
            }
            Err(e) => issues.push(Issue {
                line: no,
                kind: "bad_json".into(),
                detail: e.to_string(),
            }),
        }
    }

    if truncated_tail {
        issues.push(Issue {
            line: total,
            kind: "truncated_tail".into(),
            detail: "文件末尾没有换行，最后一行可能被截断".into(),
        });
    }

    // 时间戳倒退：内核事件与桥侧事件共用一条时间线，正常应单调不减。
    let mut last: Option<(usize, u64)> = None;
    for (no, v) in &parsed {
        let Some(ts) = ts_of(v) else { continue };
        if let Some((prev_no, prev)) = last {
            if ts < prev {
                issues.push(Issue {
                    line: *no,
                    kind: "ts_regression".into(),
                    detail: format!("pi_ts {ts} 早于第 {prev_no} 行的 {prev}"),
                });
            }
        }
        last = Some((*no, ts));
    }

    let duplicate_runs: Vec<String> = starts
        .iter()
        .filter(|(_, n)| **n > 1)
        .map(|(id, _)| id.clone())
        .collect();
    for id in &duplicate_runs {
        issues.push(Issue {
            line: 0,
            kind: "duplicate_run".into(),
            detail: format!("runId {id} 出现多次 run_start"),
        });
    }

    let open_runs: Vec<String> = starts
        .keys()
        .filter(|id| !ended.contains(*id))
        .cloned()
        .collect();
    for id in &open_runs {
        issues.push(Issue {
            line: 0,
            kind: "open_run".into(),
            detail: format!("runId {id} 有开始没有收尾"),
        });
    }

    // 只有坏 JSON 才剔除。缺换行的尾行若本身是完整 JSON 就保留——
    // 重写时统一补换行，错删一条合法事件比留个缺换行更糟。
    let mut drop_lines: Vec<usize> = issues
        .iter()
        .filter(|i| i.kind == "bad_json" && i.line > 0)
        .map(|i| i.line)
        .collect();
    drop_lines.sort_unstable();
    drop_lines.dedup();

    Ok(Report {
        path: path.display().to_string(),
        total_lines: total,
        valid_lines: parsed.len(),
        issues,
        duplicate_runs,
        open_runs: open_runs.clone(),
        plan: Plan {
            drop_lines,
            close_runs: open_runs,
            backup_path: backup_path(path).display().to_string(),
        },
    })
}

fn backup_path(path: &Path) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "events.jsonl".into());
    // 同一秒内重复修复不能覆盖已有备份：撞名就加序号。
    let mut candidate = path.with_file_name(format!("{name}.bak-{stamp}"));
    let mut n = 1;
    while candidate.exists() {
        candidate = path.with_file_name(format!("{name}.bak-{stamp}-{n}"));
        n += 1;
    }
    candidate
}

/// 修复：备份原文件 → 写临时文件 → 原子替换。
/// `apply` 为 false 时只返回计划，不动磁盘。
pub fn repair(path: &Path, apply: bool) -> Result<(Report, bool), String> {
    let report = check_file(path)?;
    if !apply {
        return Ok((report, false));
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("读取 journal 失败: {e}"))?;
    let len_before = raw.len();
    let drop_set: std::collections::HashSet<usize> = report.plan.drop_lines.iter().copied().collect();
    let mut out = String::with_capacity(raw.len());
    let mut dropped = 0usize;
    for (idx, line) in raw.lines().enumerate() {
        if drop_set.contains(&(idx + 1)) {
            dropped += 1;
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    // 补齐收尾：open_runs 里每个 runId 补一条 run_end，时间戳取最后一条事件的时间。
    let tail_ts = raw.lines().rev().find_map(|l| {
        serde_json::from_str::<Value>(l)
            .ok()
            .and_then(|v| ts_of(&v))
    });
    for id in &report.plan.close_runs {
        let ev = serde_json::json!({
            "type": "run_end",
            "runId": id,
            "pi_ts": tail_ts.unwrap_or(0),
            "repaired": true,
        });
        out.push_str(&serde_json::to_string(&ev).unwrap_or_default());
        out.push('\n');
    }

    let tmp = path.with_extension("jsonl.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("写临时文件失败: {e}"))?;
        f.write_all(out.as_bytes())
            .and_then(|_| f.sync_all())
            .map_err(|e| format!("写临时文件失败: {e}"))?;
    }
    // 修复期间内核仍在追加时，rename 会把这期间写的事件一起丢掉；宁可中止。
    if fs::metadata(path).map(|m| m.len() as usize).unwrap_or(len_before) != len_before {
        let _ = fs::remove_file(&tmp);
        return Err("journal 在修复期间被追加写入，已中止（请先停止内核再修复）".into());
    }
    let backup = backup_path(path);
    fs::copy(path, &backup).map_err(|e| format!("备份失败（{backup:?}）: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("替换 journal 失败: {e}"))?;
    eprintln!("[journal] 修复完成：剔除 {dropped} 行，备份 {backup:?}");
    Ok((check_file(path)?, true))
}

/// 自检：扫描 journal，输出问题清单 + 修复计划（只读，不动磁盘）。
#[tauri::command(async)]
pub fn journal_check(app: AppHandle, path: Option<String>) -> Result<Report, String> {
    check_file(&resolve_path(&app, path)?)
}

/// 修复预览：与自检同一份报告，`apply=false` 保证不落盘。
#[tauri::command(async)]
pub fn journal_repair_preview(app: AppHandle, path: Option<String>) -> Result<Report, String> {
    repair(&resolve_path(&app, path)?, false).map(|(r, _)| r)
}

/// 修复执行：备份 → 写临时文件 → 原子替换。只在用户显式触发时调用。
#[tauri::command(async)]
pub fn journal_repair_apply(app: AppHandle, path: Option<String>) -> Result<Report, String> {
    repair(&resolve_path(&app, path)?, true).map(|(r, _)| r)
}

/// 路径优先取调用方显式传入，否则与 pi_start 落盘处同一份（app_config_dir）。
fn resolve_path(app: &AppHandle, path: Option<String>) -> Result<PathBuf, String> {
    if let Some(p) = path.map(PathBuf::from).filter(|p| !p.as_os_str().is_empty()) {
        return Ok(p);
    }
    crate::pi_bridge::journal_file(app).ok_or_else(|| "无法解析 journal 路径".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        // 目录名必须与 pi_bridge 的 journal 单测区分：两边同用 <pid> 时并行跑会互删。
        let dir = std::env::temp_dir().join(format!("pi-journal-audit-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    /// 手动诊断入口（跑真实 journal）：
    /// `PI_JOURNAL=<path> cargo test --lib real_journal_self_check -- --ignored --nocapture`
    /// 只读自检原文件；修复在副本上验证，不覆盖原始 journal。
    #[test]
    #[ignore]
    fn real_journal_self_check() {
        let Ok(raw_path) = std::env::var("PI_JOURNAL") else {
            return;
        };
        let real = Path::new(&raw_path);
        let before = check_file(real).unwrap();
        eprintln!(
            "[real] total={} valid={} bad={:?} open_runs={:?}",
            before.total_lines,
            before.valid_lines,
            before
                .issues
                .iter()
                .filter(|i| i.kind == "bad_json")
                .map(|i| i.line)
                .collect::<Vec<_>>(),
            before.open_runs
        );

        let dir = std::env::temp_dir().join(format!("pi-journal-real-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let copy = dir.join("events.jsonl");
        fs::copy(real, &copy).unwrap();
        let (after, applied) = repair(&copy, true).unwrap();
        eprintln!(
            "[repair] applied={applied} total={} valid={} bad={} appended_close={}",
            after.total_lines,
            after.valid_lines,
            after.issues.iter().filter(|i| i.kind == "bad_json").count(),
            before.plan.close_runs.len(),
        );
        assert!(applied);
        assert!(after.issues.iter().all(|i| i.kind != "bad_json"));
        assert_eq!(after.valid_lines, after.total_lines);
        fs::remove_dir_all(&dir).ok();
    }

    /// 手动执行入口（真实 journal 修复）：
    /// `PI_JOURNAL_APPLY=<path> cargo test --lib real_journal_repair_apply -- --ignored --nocapture`
    /// 预览 → 确认文件未增长 → 备份 + 原子替换；任何一步不符直接失败。
    #[test]
    #[ignore]
    fn real_journal_repair_apply() {
        let Ok(raw_path) = std::env::var("PI_JOURNAL_APPLY") else {
            return;
        };
        let path = Path::new(&raw_path);
        let size_before = fs::metadata(path).unwrap().len();
        let preview = repair(path, false).unwrap().0;
        eprintln!("[preview] {}", serde_json::to_string_pretty(&preview).unwrap());
        assert_eq!(
            fs::metadata(path).unwrap().len(),
            size_before,
            "预览期间文件被追加，已中止"
        );

        let (after, applied) = repair(path, true).unwrap();
        assert!(applied);
        let bad = |r: &Report| r.issues.iter().filter(|i| i.kind == "bad_json").count();
        eprintln!(
            "[apply] before total={} valid={} bad={} | after total={} valid={} bad={} closes={} backup={}",
            preview.total_lines,
            preview.valid_lines,
            bad(&preview),
            after.total_lines,
            after.valid_lines,
            bad(&after),
            preview.plan.close_runs.len(),
            preview.plan.backup_path,
        );
        assert_eq!(bad(&after), 0, "修复后仍有坏行");
        assert_eq!(
            after.total_lines,
            preview.valid_lines + preview.plan.close_runs.len(),
            "修复后行数应与「合法行 + 补收尾」一致"
        );
        assert_eq!(after.open_runs.len(), 0, "修复后不应残留孤立 run");
    }

    #[test]
    fn detects_interleaved_lines() {
        let p = tmp("interleaved.jsonl");
        fs::write(
            &p,
            concat!(
                "{\"cwd\":\"/a\",\"pi_ts\":1,\"type\":\"session_open\"}\n",
                "{\"{\"pi_seq\":1,\"pi_ts\":2,\"type\":\"process_exit\"}cwd\n",
                "\":\"/b\",\"pi_ts\":2,\"type\":\"session_open\"}\n",
                "{\"pi_ts\":3,\"type\":\"kernel_start\"}\n",
            ),
        )
        .unwrap();
        let r = check_file(&p).unwrap();
        assert_eq!(r.total_lines, 4);
        assert_eq!(r.valid_lines, 2);
        assert_eq!(r.plan.drop_lines, vec![2, 3]);
    }

    #[test]
    fn detects_open_run_and_ts_regression() {
        let p = tmp("runs.jsonl");
        fs::write(
            &p,
            concat!(
                "{\"type\":\"run_start\",\"runId\":\"r1\",\"pi_ts\":10}\n",
                "{\"type\":\"message\",\"runId\":\"r1\",\"pi_ts\":5}\n",
            ),
        )
        .unwrap();
        let r = check_file(&p).unwrap();
        assert!(r.issues.iter().any(|i| i.kind == "ts_regression"));
        assert_eq!(r.open_runs, vec!["r1".to_string()]);
    }

    #[test]
    fn repair_drops_bad_lines_and_keeps_backup() {
        let p = tmp("repair.jsonl");
        fs::write(
            &p,
            concat!(
                "{\"type\":\"run_start\",\"runId\":\"r1\",\"pi_ts\":1}\n",
                "{\"broken\":\n",
                "{\"type\":\"message\",\"runId\":\"r1\",\"pi_ts\":2}\n",
            ),
        )
        .unwrap();
        let (before, applied) = repair(&p, false).unwrap();
        assert!(!applied);
        assert!(before.plan.drop_lines.contains(&2));
        let (after, applied) = repair(&p, true).unwrap();
        assert!(applied);
        assert!(after.issues.iter().all(|i| i.kind != "bad_json"));
        assert!(std::path::Path::new(&before.plan.backup_path).exists());
        let text = fs::read_to_string(&p).unwrap();
        // 坏行已剔除，open run 被补齐收尾。
        assert_eq!(text.lines().filter(|l| !l.trim().is_empty()).count(), 3);
        assert!(text.contains("\"repaired\":true"));
    }
}
