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

/// 一个受影响文件：绝对路径 + 它归属的最早备份轮（还原到该轮开始前的状态）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RewindFile {
    pub path: String,
    pub from_seq: u64,
}

/// #76 M3：回退**之前**的 dry-run——确认框拿它列「将还原 / 将被删除」，
/// 与 `rewind` 共用同一段收集逻辑，所见即所得（预览说什么，还原就做什么）。
#[derive(Debug, Clone, Serialize)]
pub struct RewindPreview {
    pub seq: u64,
    /// 第 seq 轮起被 edit/write 改过的文件——将还原到各文件最早备份的内容。
    pub restore: Vec<RewindFile>,
    /// 第 seq 轮起 write 新建的文件——将随回退删除。
    pub delete: Vec<RewindFile>,
    /// 收集异常（镜像不一致等），与 rewind 的 failed 同语义。
    pub failed: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RewindReport {
    pub seq: u64,
    /// 还原成功的文件（含归属轮）。
    pub restored: Vec<RewindFile>,
    /// 随回退删除的新建文件。
    pub removed: Vec<RewindFile>,
    /// 还原/删除失败的「路径: 原因」。
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

/// `.created` 哨兵子目录名：write 新建文件的标记落 `turn-<seq>/.created/<镜像路径>`。
/// 备份本体只覆盖「改前存在」的文件，新建文件必须另有标记才能在回退时删除——
/// 这是「将被删除」分类的唯一来源（#76 M3）。
pub const CREATED_SENTINEL_DIR: &str = ".created";

/// 收集第 from_seq 轮起（含）所有 turn 备份的受影响文件。
/// rewind 与 preview 共用——预览说什么，还原就做什么（所见即所得）。
///
/// - restore：同一文件多轮备份只取**最早**那份（回退到 from_seq 之前的状态）；
/// - delete：`.created/` 哨兵对应的新建文件（同样取最早哨兵归属轮）；
/// - 镜像 round-trip 校验失败逐条进 failed，不影响其余收集。
fn collect_since(base: &Path, from_seq: u64) -> (Vec<RewindFile>, Vec<RewindFile>, Vec<String>) {
    let mut restore: Vec<RewindFile> = Vec::new();
    let mut delete: Vec<RewindFile> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let Ok(rd) = std::fs::read_dir(base) else {
        failed.push(format!("checkpoint 目录不可读: {}", base.display()));
        return (restore, delete, failed);
    };
    let mut seqs: Vec<u64> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter_map(|name| {
            name.strip_prefix("turn-")
                .and_then(|s| s.strip_suffix(".json"))
                .and_then(|s| s.parse::<u64>().ok())
        })
        .filter(|s| *s >= from_seq)
        .collect();
    seqs.sort_unstable();
    if seqs.is_empty() {
        failed.push(format!("turn-{from_seq} 起没有可用的快照"));
        return (restore, delete, failed);
    }
    for seq in seqs {
        let dir = turn_dir(base, seq);
        let mut files = Vec::new();
        collect_files(&dir, &dir, &mut files);
        for rel in files {
            let rel_str = rel.to_string_lossy().to_string();
            // 哨兵：新建文件的可删标记，不参与还原。
            if let Some(mirror) = rel_str
                .strip_prefix(&format!("{CREATED_SENTINEL_DIR}/"))
                .or_else(|| rel_str.strip_prefix(&format!("{CREATED_SENTINEL_DIR}\\")))
            {
                let abs = Path::new("/").join(mirror);
                if mirror_rel(&abs) != PathBuf::from(mirror) {
                    failed.push(format!("{}: 哨兵路径镜像不一致，已跳过", abs.display()));
                    continue;
                }
                let path = abs.to_string_lossy().to_string();
                if !delete.iter().any(|f| f.path == path) {
                    delete.push(RewindFile { path, from_seq: seq });
                }
                continue;
            }
            let abs = Path::new("/").join(&rel);
            // 完整性校验：镜像路径必须 round-trip 回同一绝对路径，
            // 否则说明备份目录被外部动过（或规则与扩展侧不一致），不还原。
            if mirror_rel(&abs) != rel {
                failed.push(format!("{}: 备份路径镜像不一致，已跳过", abs.display()));
                continue;
            }
            let path = abs.to_string_lossy().to_string();
            // 多轮备份取最早：更晚轮次的同文件备份不覆盖首次记录。
            if !restore.iter().any(|f| f.path == path) {
                restore.push(RewindFile { path, from_seq: seq });
            }
        }
    }
    restore.sort_by(|a, b| a.path.cmp(&b.path));
    delete.sort_by(|a, b| a.path.cmp(&b.path));
    (restore, delete, failed)
}

/// #76 M3：回退前 dry-run——列「将还原 / 将被删除」，不落任何盘。
pub fn preview(base: &Path, from_seq: u64) -> RewindPreview {
    let (restore, delete, failed) = collect_since(base, from_seq);
    RewindPreview { seq: from_seq, restore, delete, failed }
}

/// 还原第 from_seq 轮起的全部备份 + 删除其间新建的文件。
/// 单点失败逐条记录，不影响其余操作。
pub fn rewind(base: &Path, seq: u64) -> Result<RewindReport, String> {
    let (restore, delete, mut failed) = collect_since(base, seq);
    let mut rep = RewindReport {
        seq,
        restored: Vec::new(),
        removed: Vec::new(),
        failed: Vec::new(),
        fork_entry_id: None,
    };
    for f in &restore {
        let abs = Path::new(&f.path);
        let src = turn_dir(base, f.from_seq).join(mirror_rel(abs));
        if let Some(parent) = abs.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                failed.push(format!("{}: 创建父目录失败", abs.display()));
                continue;
            }
        }
        match std::fs::copy(&src, abs) {
            Ok(_) => rep.restored.push(f.clone()),
            Err(e) => failed.push(format!("{}: {e}", abs.display())),
        }
    }
    for f in &delete {
        let abs = Path::new(&f.path);
        // 文件已被外部删除视为成功——回退语义已达成，不必报错吓用户。
        let gone = !abs.exists() || std::fs::remove_file(abs).is_ok();
        // 哨兵本体一并清掉：留着下次 preview 还会列它。
        let sentinel = turn_dir(base, f.from_seq)
            .join(CREATED_SENTINEL_DIR)
            .join(mirror_rel(abs));
        let _ = std::fs::remove_file(sentinel);
        if gone {
            rep.removed.push(f.clone());
        } else {
            failed.push(format!("{}: 删除新建文件失败", abs.display()));
        }
    }
    rep.failed = failed;
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
        assert_eq!(
            begin_turn(&base, Some("leaf1"), "第一轮 prompt").unwrap(),
            1
        );
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
        assert_eq!(rep.restored.len(), 1);
        assert_eq!(rep.restored[0].path, file.to_string_lossy().to_string());
        assert_eq!(rep.restored[0].from_seq, 1);
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

    // —— #76 M3：区间语义 + 新建文件哨兵 ——

    /// 在 turn-<seq> 备份一个文件（模拟扩展 first-write-wins）。
    fn seed_backup(base: &Path, seq: u64, file: &Path, content: &str) {
        let dest = turn_dir(base, seq).join(mirror_rel(file));
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, content).unwrap();
    }

    /// 在 turn-<seq> 落一个 `.created` 哨兵（模拟扩展 write-新建）。
    fn seed_sentinel(base: &Path, seq: u64, file: &Path) {
        let dest = turn_dir(base, seq)
            .join(CREATED_SENTINEL_DIR)
            .join(mirror_rel(file));
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, "").unwrap();
    }

    #[test]
    fn rewind_range_union_takes_earliest_backup_per_file() {
        let base = tmp("rewind-range");
        let src = tmp("rewind-range-src");
        let a = src.join("a.ts");
        let b = src.join("b.ts");
        begin_turn(&base, None, "p1").unwrap();
        begin_turn(&base, None, "p2").unwrap();
        // a 两轮都改过：turn-1 备份 v1、turn-2 备份 v2——回退到 1 应取最早的 v1。
        seed_backup(&base, 1, &a, "a-v1");
        seed_backup(&base, 2, &a, "a-v2");
        seed_backup(&base, 2, &b, "b-v1");
        std::fs::write(&a, "a-now").unwrap();
        std::fs::write(&b, "b-now").unwrap();

        let rep = rewind(&base, 1).unwrap();
        assert!(rep.failed.is_empty(), "{:?}", rep.failed);
        assert_eq!(rep.restored.len(), 2);
        let fa = rep.restored.iter().find(|f| f.path == a.to_string_lossy()).unwrap();
        assert_eq!(fa.from_seq, 1, "多轮备份取最早");
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "a-v1");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "b-v1");

        // 从第 2 轮起回退：区间只剩 turn-2——a 还原到 v2（不是 v1）、b 到 v1。
        std::fs::write(&a, "a-now2").unwrap();
        let rep2 = rewind(&base, 2).unwrap();
        assert_eq!(rep2.restored.len(), 2);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "a-v2", "区间起点决定取哪份备份");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "b-v1");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&src);
    }

    #[test]
    fn rewind_deletes_created_files_via_sentinel() {
        let base = tmp("rewind-created");
        let src = tmp("rewind-created-src");
        let new_file = src.join("fresh.ts");
        begin_turn(&base, None, "p").unwrap();
        // write 新建：无备份、有哨兵；文件真实存在。
        seed_sentinel(&base, 1, &new_file);
        std::fs::write(&new_file, "created").unwrap();

        let rep = rewind(&base, 1).unwrap();
        assert!(rep.failed.is_empty(), "{:?}", rep.failed);
        assert!(rep.restored.is_empty());
        assert_eq!(rep.removed.len(), 1);
        assert_eq!(rep.removed[0].path, new_file.to_string_lossy().to_string());
        assert!(!new_file.exists(), "新建文件随回退删除");
        // 哨兵本体已清：再 preview 不会重复列它。
        let pv = preview(&base, 1);
        assert!(pv.delete.is_empty());
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&src);
    }

    #[test]
    fn rewind_tolerates_already_deleted_created_file() {
        let base = tmp("rewind-created-gone");
        let src = tmp("rewind-created-gone-src");
        let new_file = src.join("gone.ts");
        begin_turn(&base, None, "p").unwrap();
        seed_sentinel(&base, 1, &new_file);
        // 用户自己删了新建文件——回退语义已达成，不算失败。

        let rep = rewind(&base, 1).unwrap();
        assert_eq!(rep.removed.len(), 1);
        assert!(rep.failed.is_empty(), "{:?}", rep.failed);
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&src);
    }

    #[test]
    fn preview_lists_restore_and_delete_without_touching_disk() {
        let base = tmp("preview");
        let src = tmp("preview-src");
        let edited = src.join("e.ts");
        let created = src.join("c.ts");
        begin_turn(&base, None, "p1").unwrap();
        begin_turn(&base, None, "p2").unwrap();
        seed_backup(&base, 2, &edited, "old");
        seed_sentinel(&base, 2, &created);
        std::fs::write(&edited, "new").unwrap();
        std::fs::write(&created, "x").unwrap();

        let pv = preview(&base, 1);
        assert!(pv.failed.is_empty(), "{:?}", pv.failed);
        assert_eq!(pv.restore.len(), 1);
        assert_eq!(pv.restore[0].from_seq, 2, "归属最早备份轮");
        assert_eq!(pv.delete.len(), 1);
        // dry-run 不落盘：文件内容原样。
        assert_eq!(std::fs::read_to_string(&edited).unwrap(), "new");
        assert!(created.exists());
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&src);
    }
}
