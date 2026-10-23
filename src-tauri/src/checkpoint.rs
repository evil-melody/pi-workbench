//! G3 checkpoint/rewind：每个 prompt 轮次前打 turn 标记；Pi 扩展
//! （agent-tool-gate）在 edit/write 执行前把目标文件备份进 turn 目录；
//! rewind 还原文件 + fork 会话树到该 prompt 之前。
//!
//! 边界（对齐 Claude Code checkpoint 明示限制）：bash 命令产生的文件变更
//! **不在**快照范围——只在工具层拦 edit/write，不拦 shell。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 保留最近多少个 turn 的快照（更早的连目录一起删，防止无限增长）。
pub const MAX_TURNS: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnMarker {
    pub seq: u64,
    pub ts_ms: u64,
    /// 轮次开始时会话树的叶子（该轮 prompt 的父节点）；None=空会话首轮。
    pub leaf_id: Option<String>,
    /// prompt 正文前 80 字符，用于 rewind 时在 get_fork_messages 里定位 user entry。
    pub prompt_head: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RewindReport {
    pub seq: u64,
    /// 还原成功的绝对路径。
    pub restored: Vec<String>,
    /// 还原失败的「路径: 原因」。
    pub failed: Vec<String>,
    /// 成功 fork 到的 user entry（None=未找到匹配/无 leaf，仅还原了文件）。
    pub fork_entry_id: Option<String>,
}

/// turn 目录内的镜像相对路径：绝对路径去掉前导 `/`。
/// `/a/b/c.ts` → `a/b/c.ts`。还原时反向拼接即得绝对路径，无需编码表。
pub fn mirror_rel(abs: &Path) -> PathBuf {
    let s = abs.to_string_lossy();
    PathBuf::from(s.trim_start_matches('/'))
}

/// 从 `get_fork_messages` 结果里定位某轮 prompt 的 user entry。
/// `messages` 为 `(entry_id, text)`；取**最后一条**归一化文本包含 prompt_head 的
/// （同一文本可能多轮重复，最后一条即该轮最新落盘的那条）。
pub fn find_fork_entry_id(messages: &[(String, String)], prompt_head: &str) -> Option<String> {
    let head = normalize(prompt_head);
    if head.is_empty() {
        return None;
    }
    messages
        .iter()
        .rev()
        .find(|(_, text)| normalize(text).contains(&head))
        .map(|(id, _)| id.clone())
}

/// 归一化：去首尾空白、压缩内部连续空白，容忍 journal/内核侧的换行差异。
fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 从 `get_entries` 结果里按父节点定位该轮 prompt 的 user entry（精确关联）。
/// `entries` 为 `(id, parent_id, role)`，role=None 表示非 message 条目。
/// - `leaf_id = Some(l)`：父节点正是轮次开始时会话树叶子的那条 user message；
/// - `leaf_id = None`（空会话首轮）：第一条 user message。
pub fn find_entry_by_parent(
    entries: &[(String, Option<String>, Option<String>)],
    leaf_id: Option<&str>,
) -> Option<String> {
    match leaf_id {
        Some(l) => entries
            .iter()
            .find(|(_, parent, role)| {
                role.as_deref() == Some("user") && parent.as_deref() == Some(l)
            })
            .map(|(id, _, _)| id.clone()),
        None => entries
            .iter()
            .find(|(_, _, role)| role.as_deref() == Some("user"))
            .map(|(id, _, _)| id.clone()),
    }
}

/// 该 turn 的备份目录：`<checkpoint_dir>/turn-<seq>`。
pub fn turn_dir(base: &Path, seq: u64) -> PathBuf {
    base.join(format!("turn-{seq}"))
}

/// marker 文件路径：`<checkpoint_dir>/turn-<seq>.json`。
pub fn marker_path(base: &Path, seq: u64) -> PathBuf {
    base.join(format!("turn-{seq}.json"))
}

pub(crate) fn read_marker(base: &Path, seq: u64) -> Option<TurnMarker> {
    let raw = std::fs::read_to_string(marker_path(base, seq)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 目录下现存的最大 turn seq（无则 0）。
fn max_seq(base: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(base) else {
        return 0;
    };
    rd.filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_string_lossy().into_owned().into())
        .filter_map(|name| {
            name.strip_prefix("turn-")
                .and_then(|s| s.strip_suffix(".json"))
                .and_then(|s| s.parse::<u64>().ok())
        })
        .max()
        .unwrap_or(0)
}

/// 轮次开始：打 marker、返回 seq。超过 MAX_TURNS 时清掉最旧的。
/// 失败（磁盘等）返回 Err，调用方应降级放行而不是阻断发送。
pub fn begin_turn(base: &Path, leaf_id: Option<&str>, prompt_head: &str) -> Result<u64, String> {
    std::fs::create_dir_all(base).map_err(|e| format!("创建 checkpoint 目录失败: {e}"))?;
    let seq = max_seq(base) + 1;
    let marker = TurnMarker {
        seq,
        ts_ms: crate::pi_bridge::unix_ms(),
        leaf_id: leaf_id.map(|s| s.to_string()),
        prompt_head: prompt_head.chars().take(80).collect(),
    };
    let json = serde_json::to_string_pretty(&marker).map_err(|e| e.to_string())?;
    std::fs::write(marker_path(base, seq), json).map_err(|e| format!("写 marker 失败: {e}"))?;
    prune(base, seq);
    Ok(seq)
}

/// 只保留最近 MAX_TURNS 个 turn（marker + 目录一起删）。
fn prune(base: &Path, latest: u64) {
    if latest <= MAX_TURNS as u64 {
        return;
    }
    for seq in 1..=(latest - MAX_TURNS as u64) {
        let _ = std::fs::remove_file(marker_path(base, seq));
        let _ = std::fs::remove_dir_all(turn_dir(base, seq));
    }
}

/// 还原某个 turn 备份的全部文件。文件缺失等单点失败逐条记录，不影响其余还原。
pub fn rewind(base: &Path, seq: u64) -> Result<RewindReport, String> {
    let dir = turn_dir(base, seq);
    let mut rep = RewindReport {
        seq,
        restored: Vec::new(),
        failed: Vec::new(),
        fork_entry_id: None,
    };
    if !dir.exists() {
        rep.failed.push(format!("turn-{seq}: 快照目录不存在"));
        return Ok(rep);
    }
    let mut files = Vec::new();
    collect_files(&dir, &dir, &mut files);
    for rel in files {
        let abs = Path::new("/").join(&rel);
        // 完整性校验：镜像路径必须 round-trip 回同一绝对路径，
        // 否则说明备份目录被外部动过（或规则与扩展侧不一致），不还原。
        if mirror_rel(&abs) != rel {
            rep.failed
                .push(format!("{}: 备份路径镜像不一致，已跳过", abs.display()));
            continue;
        }
        let src = dir.join(&rel);
        if let Some(parent) = abs.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                rep.failed.push(format!("{}: 创建父目录失败", abs.display()));
                continue;
            }
        }
        match std::fs::copy(&src, &abs) {
            Ok(_) => rep.restored.push(abs.to_string_lossy().to_string()),
            Err(e) => rep.failed.push(format!("{}: {e}", abs.display())),
        }
    }
    Ok(rep)
}

/// 递归收集目录内所有文件（相对路径）。
fn collect_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.filter_map(|e| e.ok()) {
        let p = e.path();
        if p.is_dir() {
            collect_files(root, &p, out);
        } else if let Ok(rel) = p.strip_prefix(root) {
            out.push(rel.to_path_buf());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirror_rel_strips_leading_slash() {
        assert_eq!(
            mirror_rel(Path::new("/Users/x/proj/src/a.ts")),
            PathBuf::from("Users/x/proj/src/a.ts")
        );
        // 相对路径原样（扩展侧按 cwd 解析后传入的一律是绝对路径，这里防御性兜底）。
        assert_eq!(mirror_rel(Path::new("src/a.ts")), PathBuf::from("src/a.ts"));
    }

    #[test]
    fn turn_dir_and_marker_path_shapes() {
        let base = Path::new("/cp");
        assert_eq!(turn_dir(base, 7), PathBuf::from("/cp/turn-7"));
        assert_eq!(marker_path(base, 7), PathBuf::from("/cp/turn-7.json"));
    }

    #[test]
    fn find_fork_entry_id_matches_last_and_normalizes() {
        let msgs: Vec<(String, String)> = vec![
            ("e1".into(), "帮我改 foo".into()),
            ("e2".into(), "帮我改 foo".into()),
        ];
        // 同文本两轮：取最后一条（该轮最新）。
        assert_eq!(find_fork_entry_id(&msgs, "帮我改 foo"), Some("e2".into()));
        // 归一化：head 与文本空白形态不同也能命中。
        assert_eq!(
            find_fork_entry_id(&[("e9".into(), "a  b\nc".into())], "a b c"),
            Some("e9".into())
        );
    }

    #[test]
    fn find_fork_entry_id_empty_head_matches_nothing() {
        let msgs = vec![("e1".into(), "任意文本".into())];
        assert_eq!(find_fork_entry_id(&msgs, ""), None);
        assert_eq!(find_fork_entry_id(&msgs, "   "), None);
    }

    #[test]
    fn find_fork_entry_id_no_match_returns_none() {
        let msgs = vec![("e1".into(), "帮我改 foo".into())];
        assert_eq!(find_fork_entry_id(&msgs, "完全不相关的 prompt"), None);
    }

    #[test]
    fn find_entry_by_parent_locates_turn_prompt_exactly() {
        // (id, parent, role)：assistant/context_edit 条目 role=None。
        let entries: Vec<(String, Option<String>, Option<String>)> = vec![
            ("u1".into(), None, Some("user".into())),
            ("a1".into(), Some("u1".into()), Some("assistant".into())),
            ("u2".into(), Some("a1".into()), Some("user".into())),
            ("a2".into(), Some("u2".into()), Some("assistant".into())),
            ("u3".into(), Some("a2".into()), Some("user".into())),
        ];
        // 第二轮开始时的叶子是 a1 → 该轮 prompt = u2（文本相同也不会错位）。
        assert_eq!(
            find_entry_by_parent(&entries, Some("a1")),
            Some("u2".into())
        );
        // 空会话首轮：第一条 user message。
        assert_eq!(find_entry_by_parent(&entries, None), Some("u1".into()));
        // 叶子已不在树里（被压缩/切换）：精确关联失败，由文本匹配兜底。
        assert_eq!(find_entry_by_parent(&entries, Some("gone")), None);
    }

    // —— IO 层（临时目录，不碰真实配置目录）——

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cp-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn begin_turn_creates_marker_and_returns_increasing_seq() {
        let base = tmp("begin");
        assert_eq!(begin_turn(&base, Some("leaf1"), "第一轮 prompt").unwrap(), 1);
        assert_eq!(begin_turn(&base, None, "第二轮 prompt").unwrap(), 2);
        let m = read_marker(&base, 1).unwrap();
        assert_eq!(m.leaf_id.as_deref(), Some("leaf1"));
        assert_eq!(m.prompt_head, "第一轮 prompt");
        let m2 = read_marker(&base, 2).unwrap();
        assert_eq!(m2.leaf_id, None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn begin_turn_prunes_beyond_max() {
        let base = tmp("prune");
        for i in 0..=(MAX_TURNS as u64 + 2) {
            begin_turn(&base, None, &format!("p{i}")).unwrap();
        }
        // 只保留最近 MAX_TURNS 个。
        let markers = std::fs::read_dir(&base)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
            .count();
        assert_eq!(markers, MAX_TURNS);
        assert!(read_marker(&base, 1).is_none(), "最旧的 turn 应被清掉");
        assert!(read_marker(&base, MAX_TURNS as u64 + 3).is_some());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn rewind_restores_mirrored_files_and_reports() {
        let base = tmp("rewind");
        let src = tmp("rewind-src");
        let file = src.join("a.ts");
        std::fs::write(&file, "old").unwrap();
        begin_turn(&base, None, "p").unwrap();
        // 模拟扩展备份：镜像路径 + 旧内容。
        let dest = turn_dir(&base, 1).join(mirror_rel(&file));
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, "old").unwrap();
        // 期间文件被 agent 改掉。
        std::fs::write(&file, "new").unwrap();

        let rep = rewind(&base, 1).unwrap();
        assert_eq!(rep.restored, vec![file.to_string_lossy().to_string()]);
        assert!(rep.failed.is_empty());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "old");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&src);
    }

    #[test]
    fn rewind_missing_turn_dir_reports_failure_not_panic() {
        let base = tmp("rewind-missing");
        let rep = rewind(&base, 42).unwrap();
        assert!(rep.restored.is_empty());
        assert_eq!(rep.failed.len(), 1);
        assert!(rep.failed[0].contains("42"));
        let _ = std::fs::remove_dir_all(&base);
    }
}
