//! 记忆事件流：物化 + 24 小时软删除窗口。
//!
//! 磁盘仍是 `<config>/.pi/memory/memory.jsonl`，与 Pi 扩展共用同一份状态。
//! 后续写入的是**事件**而不是快照：
//!   `{op:"delete", id, ts, purgeAt}` / `{op:"restore", id, ts}` / `{op:"purge", id, ts}`
//!
//! 老行（只有 ts/text/tags）按新增条目处理，id 用 `memory_vec::entry_id` 现算，
//! 与向量表同一算法，两边 id 天然对齐。
//!
//! 到期硬失效由 `proactive` 的 10s tick 驱动（`purge_expired`），不新增线程。
//! 召回侧（Pi 扩展与向量检索）都按物化结果过滤，墓碑行不参与召回。

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

/// 删除后的可撤销窗口：24 小时。
pub const UNDO_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub ts: i64,
    pub text: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purge_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
}

pub fn memory_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    crate::agent_ops::agent_ops_root(app).map(|root| root.join("memory").join("memory.jsonl"))
}

fn audit_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    crate::agent_ops::agent_ops_root(app).map(|root| root.join("memory").join("memory-audit.jsonl"))
}

pub fn profile_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    crate::agent_ops::agent_ops_root(app).map(|root| root.join("memory").join("profile.json"))
}

fn read_raw(app: &tauri::AppHandle) -> Vec<Value> {
    let Some(f) = memory_file(app) else {
        return vec![];
    };
    let Ok(text) = std::fs::read_to_string(f) else {
        return vec![];
    };
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect()
}

/// 按行序重放事件，得到当前状态（含已删除但未过期的条目）。
pub fn materialize(lines: &[Value]) -> Vec<Entry> {
    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, Entry> = HashMap::new();
    for v in lines {
        let op = v.get("op").and_then(|x| x.as_str()).unwrap_or("add");
        match op {
            "add" => {
                let ts = v.get("ts").and_then(|x| x.as_i64()).unwrap_or(0);
                let Some(text) = v.get("text").and_then(|x| x.as_str()) else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                let id = v
                    .get("id")
                    .and_then(|x| x.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| crate::memory_vec::entry_id(ts, text));
                let tags = v
                    .get("tags")
                    .and_then(|x| x.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|t| t.as_str())
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                if !map.contains_key(&id) {
                    order.push(id.clone());
                }
                map.insert(
                    id.clone(),
                    Entry {
                        id,
                        ts,
                        text: text.to_string(),
                        tags,
                        deleted_at: None,
                        purge_at: None,
                        source: v
                            .get("source")
                            .and_then(|x| x.as_str())
                            .map(str::to_string),
                        job_id: v
                            .get("jobId")
                            .and_then(|x| x.as_str())
                            .map(str::to_string),
                    },
                );
            }
            "update" => {
                if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                    if let Some(e) = map.get_mut(id) {
                        if let Some(t) = v.get("text").and_then(|x| x.as_str()) {
                            if !t.trim().is_empty() {
                                e.text = t.to_string();
                            }
                        }
                        if let Some(a) = v.get("tags").and_then(|x| x.as_array()) {
                            e.tags = a
                                .iter()
                                .filter_map(|t| t.as_str())
                                .map(str::to_string)
                                .collect();
                        }
                    }
                }
            }
            "delete" => {
                let at = v.get("ts").and_then(|x| x.as_u64()).unwrap_or(0);
                let purge_at = v
                    .get("purgeAt")
                    .and_then(|x| x.as_u64())
                    .unwrap_or_else(|| at.saturating_add(UNDO_MS));
                if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                    if let Some(e) = map.get_mut(id) {
                        e.deleted_at = Some(at);
                        e.purge_at = Some(purge_at);
                    }
                }
            }
            "restore" => {
                if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                    if let Some(e) = map.get_mut(id) {
                        e.deleted_at = None;
                        e.purge_at = None;
                    }
                }
            }
            "purge" => {
                if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                    map.remove(id);
                    order.retain(|x| x != id);
                }
            }
            _ => {}
        }
    }
    order.into_iter().filter_map(|id| map.remove(&id)).collect()
}

/// 未删除条目（召回与列表的默认视图）。
pub fn active(app: &tauri::AppHandle) -> Vec<Entry> {
    materialize(&read_raw(app))
        .into_iter()
        .filter(|e| e.deleted_at.is_none())
        .collect()
}

/// 待撤销条目（24 小时窗口内）。
pub fn pending(app: &tauri::AppHandle) -> Vec<Entry> {
    materialize(&read_raw(app))
        .into_iter()
        .filter(|e| e.deleted_at.is_some())
        .collect()
}

/// 召回可用 id 集合：向量检索结果按它过滤，墓碑与已硬失效条目不会漏出。
pub fn active_ids(app: &tauri::AppHandle) -> HashSet<String> {
    active(app).into_iter().map(|e| e.id).collect()
}

fn append_line(app: &tauri::AppHandle, value: &Value) -> Result<(), String> {
    let f = memory_file(app).ok_or_else(|| "取配置目录失败".to_string())?;
    if let Some(dir) = f.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(f)
        .map_err(|e| e.to_string())?;
    file.write_all(format!("{value}\n").as_bytes())
        .map_err(|e| e.to_string())
}

/// 软删除：只追加墓碑行，24 小时内可 `restore`，到期由 tick 追加 `purge`。
pub fn soft_delete(app: &tauri::AppHandle, id: &str, now: u64) -> Result<Entry, String> {
    let mut entry = active(app)
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| "这条记忆不存在或已删除".to_string())?;
    let purge_at = now.saturating_add(UNDO_MS);
    append_line(
        app,
        &json!({ "op": "delete", "id": id, "ts": now, "purgeAt": purge_at }),
    )?;
    entry.deleted_at = Some(now);
    entry.purge_at = Some(purge_at);
    Ok(entry)
}

/// 撤销删除：只追加 `restore` 行，原记忆内容不变。
pub fn restore(app: &tauri::AppHandle, id: &str, now: u64) -> Result<Entry, String> {
    let mut entry = pending(app)
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| "这条记忆不在待撤销状态".to_string())?;
    append_line(app, &json!({ "op": "restore", "id": id, "ts": now }))?;
    entry.deleted_at = None;
    entry.purge_at = None;
    Ok(entry)
}

/// 到期硬失效：为超过撤销窗口的条目追加 `purge` 行，返回本次处理条数。
pub fn purge_expired(app: &tauri::AppHandle, now: u64) -> usize {
    let expired: Vec<String> = pending(app)
        .into_iter()
        .filter(|e| e.purge_at.map(|p| p <= now).unwrap_or(false))
        .map(|e| e.id)
        .collect();
    let mut done = 0;
    for id in expired {
        if append_line(app, &json!({ "op": "purge", "id": id, "ts": now })).is_ok() {
            done += 1;
        }
    }
    done
}

/// 审计记录：硬删除等不可逆动作留痕，追加到 `memory-audit.jsonl`。
fn append_audit(app: &tauri::AppHandle, value: &Value) -> Result<(), String> {
    let f = audit_file(app).ok_or_else(|| "取配置目录失败".to_string())?;
    if let Some(dir) = f.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(f)
        .map_err(|e| e.to_string())?;
    file.write_all(format!("{value}\n").as_bytes())
        .map_err(|e| e.to_string())
}

/// 立即永久删除：跳过 24 小时窗口直接硬失效，先写审计再落事件行。
/// 列表 / 召回 / 向量检索都按物化结果过滤，purge 之后任何路径都拿不到它。
pub fn purge_now(app: &tauri::AppHandle, id: &str, now: u64) -> Result<Entry, String> {
    let entry = materialize(&read_raw(app))
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| "这条记忆不存在".to_string())?;
    append_audit(
        app,
        &json!({
            "ts": now,
            "action": "purge",
            "reason": "manual",
            "id": id,
            "text": entry.text,
            "tags": entry.tags,
        }),
    )?;
    append_line(
        app,
        &json!({ "op": "purge", "id": id, "ts": now, "reason": "manual" }),
    )?;
    let _ = refresh_profile(app);
    Ok(entry)
}

/// 更正：追加 `update` 行，原行保留作审计；物化时以后者为准。
pub fn update(
    app: &tauri::AppHandle,
    id: &str,
    text: Option<&str>,
    tags: Option<&[String]>,
    now: u64,
) -> Result<Entry, String> {
    let entry = active(app)
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| "这条记忆不存在或已删除".to_string())?;
    let text = text.map(str::trim).filter(|s| !s.is_empty());
    if text.is_none() && tags.is_none() {
        return Err("没有要修改的内容".into());
    }
    let mut value = json!({ "op": "update", "id": id, "ts": now });
    if let Some(t) = text {
        value["text"] = json!(t);
    }
    if let Some(t) = tags {
        value["tags"] = json!(t);
    }
    append_line(app, &value)?;
    let _ = refresh_profile(app);
    Ok(materialize(&read_raw(app))
        .into_iter()
        .find(|e| e.id == id)
        .unwrap_or(entry))
}

// ── 画像折叠：保留标签 → 只读视图，不另立档案 ─────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileField {
    pub value: String,
    pub evidence: Vec<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preference: Option<ProfileField>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub taboo: Option<ProfileField>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<ProfileField>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow: Option<ProfileField>,
    pub generated_at: u64,
    pub source_mtime: u64,
}

/// 保留标签：`profile:<key>=<value>`，中英 key 等价。
fn profile_key(tag: &str) -> Option<(&'static str, String)> {
    let (k, v) = tag.strip_prefix("profile:")?.split_once('=')?;
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    let k = match k.trim() {
        "preference" | "偏好" => "preference",
        "taboo" | "禁忌" => "taboo",
        "goal" | "目标" | "长期目标" => "goal",
        "workflow" | "工作方式" | "常用工作方式" => "workflow",
        _ => return None,
    };
    Some((k, v.to_string()))
}

/// 纯函数：按标签折叠出画像。禁忌多条并存，其余取最新一条。
pub fn build_profile(entries: &[Entry], now: u64, mtime: u64) -> Profile {
    let mut latest: HashMap<&'static str, (i64, String, String)> = HashMap::new();
    let mut taboo: Vec<(i64, String, String)> = Vec::new();
    for e in entries {
        for tag in &e.tags {
            let Some((key, value)) = profile_key(tag) else {
                continue;
            };
            if key == "taboo" {
                if !taboo.iter().any(|x| x.1 == value) {
                    taboo.push((e.ts, value, e.id.clone()));
                }
                continue;
            }
            let newer = latest.get(key).map(|(ts, _, _)| e.ts > *ts).unwrap_or(true);
            if newer {
                latest.insert(key, (e.ts, value, e.id.clone()));
            }
        }
    }
    let mut out = Profile {
        generated_at: now,
        source_mtime: mtime,
        ..Default::default()
    };
    for (key, (ts, value, id)) in latest {
        let field = ProfileField {
            value,
            evidence: vec![id],
            updated_at: ts,
        };
        match key {
            "preference" => out.preference = Some(field),
            "goal" => out.goal = Some(field),
            "workflow" => out.workflow = Some(field),
            _ => {}
        }
    }
    if !taboo.is_empty() {
        let updated_at = taboo.iter().map(|x| x.0).max().unwrap_or(0);
        out.taboo = Some(ProfileField {
            value: taboo.iter().map(|x| x.1.clone()).collect::<Vec<_>>().join("；"),
            evidence: taboo.iter().map(|x| x.2.clone()).collect(),
            updated_at,
        });
    }
    out
}

/// 重算并原子写 `profile.json`；mtime 未变则直接返回缓存，避免每 10s 重解析。
pub fn refresh_profile(app: &tauri::AppHandle) -> Option<Profile> {
    let file = memory_file(app)?;
    let mtime = std::fs::metadata(&file)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let out = profile_file(app)?;
    if let Ok(text) = std::fs::read_to_string(&out) {
        if let Ok(cached) = serde_json::from_str::<Profile>(&text) {
            if cached.source_mtime == mtime {
                return Some(cached);
            }
        }
    }
    let profile = build_profile(&active(app), crate::proactive::now_ms(), mtime);
    if let Some(dir) = out.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = out.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_string_pretty(&profile).ok()?).is_err() {
        return Some(profile);
    }
    let _ = std::fs::rename(&tmp, &out);
    Some(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add(ts: i64, text: &str) -> Value {
        json!({ "ts": ts, "text": text, "tags": ["偏好"] })
    }

    #[test]
    fn legacy_lines_are_active_and_get_stable_id() {
        let out = materialize(&[add(1000, "用中文回复")]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, crate::memory_vec::entry_id(1000, "用中文回复"));
        assert!(out[0].deleted_at.is_none());
    }

    #[test]
    fn id_matches_pi_extension_algorithm() {
        // 与 `agent-memory.ts` 的 entryId 对齐：ts 小端 8 字节 + 文本，取 sha256 前 4 字节。
        assert_eq!(
            crate::memory_vec::entry_id(1_730_000_000_000, "用中文回复"),
            "1730000000000-f26d23d2"
        );
    }

    #[test]
    fn delete_then_restore_round_trip() {
        let mut lines = vec![add(1000, "用中文回复")];
        let id = crate::memory_vec::entry_id(1000, "用中文回复");
        lines.push(json!({ "op": "delete", "id": id, "ts": 2000, "purgeAt": 2000 + UNDO_MS }));
        let deleted = materialize(&lines);
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].deleted_at, Some(2000));
        lines.push(json!({ "op": "restore", "id": id, "ts": 3000 }));
        let restored = materialize(&lines);
        assert!(restored[0].deleted_at.is_none());
        assert!(restored[0].purge_at.is_none());
    }

    #[test]
    fn purge_removes_entry_from_view() {
        let id = crate::memory_vec::entry_id(1000, "用中文回复");
        let lines = vec![
            add(1000, "用中文回复"),
            json!({ "op": "delete", "id": id, "ts": 2000, "purgeAt": 2000 + UNDO_MS }),
            json!({ "op": "purge", "id": id, "ts": 9_000_000 }),
        ];
        assert!(materialize(&lines).is_empty());
    }

    #[test]
    fn delete_unknown_id_is_ignored() {
        let lines = vec![
            add(1000, "用中文回复"),
            json!({ "op": "delete", "id": "missing", "ts": 2000 }),
        ];
        let out = materialize(&lines);
        assert_eq!(out.len(), 1);
        assert!(out[0].deleted_at.is_none());
    }

    #[test]
    fn update_overrides_text_and_tags_but_keeps_id() {
        let id = crate::memory_vec::entry_id(1000, "用中文回复");
        let out = materialize(&[
            add(1000, "用中文回复"),
            json!({ "op": "update", "id": id, "ts": 4000, "text": "用英文回复", "tags": ["偏好"] }),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "用英文回复");
        assert_eq!(out[0].id, id);
    }

    #[test]
    fn purge_after_delete_leaves_no_trace_for_recall() {
        let id = crate::memory_vec::entry_id(1000, "用中文回复");
        let out = materialize(&[
            add(1000, "用中文回复"),
            json!({ "op": "delete", "id": id, "ts": 2000, "purgeAt": 2000 + UNDO_MS }),
            json!({ "op": "purge", "id": id, "ts": 2001, "reason": "manual" }),
        ]);
        assert!(out.is_empty());
    }

    #[test]
    fn profile_folds_latest_value_and_keeps_all_taboos() {
        let entries = materialize(&[
            json!({ "ts": 1000, "text": "偏好简洁", "tags": ["profile:preference=简洁"] }),
            json!({ "ts": 2000, "text": "偏好电报体", "tags": ["profile:preference=电报体"] }),
            json!({ "ts": 3000, "text": "不要感叹号", "tags": ["profile:taboo=不要用感叹号"] }),
            json!({ "ts": 4000, "text": "别自动提交", "tags": ["profile:taboo=不要自动提交 git"] }),
            json!({ "ts": 5000, "text": "无关条目", "tags": ["偏好"] }),
        ]);
        let p = build_profile(&entries, 6000, 7);
        assert_eq!(p.preference.unwrap().value, "电报体");
        let taboo = p.taboo.unwrap();
        assert_eq!(taboo.value, "不要用感叹号；不要自动提交 git");
        assert_eq!(taboo.evidence.len(), 2);
        assert!(p.goal.is_none());
        assert_eq!(p.source_mtime, 7);
    }

    #[test]
    fn profile_ignores_malformed_tags() {
        let entries = materialize(&[
            json!({ "ts": 1000, "text": "x", "tags": ["profile:preference=", "profile:unknown=v"] }),
        ]);
        let p = build_profile(&entries, 2000, 1);
        assert!(p.preference.is_none() && p.taboo.is_none());
    }
}
