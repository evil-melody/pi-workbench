/**
 * 智能体运行层后端：读写扩展落盘的运行态（`<app_config_dir>/.pi/<kind>/`），
 * 供 Vue 面板查询与管理。与 Pi extension（`agent-*.ts`）共用同一份状态，
 * 因此「人面」（面板点出来的）与「agent 面」（模型调出来的）看到的是同一份事实。
 *
 * 覆盖四类运行态：
 *   · teams        团队编排（成员 + 协调策略 + 调度日志）
 *   · memory       长期记忆（ts/text/tags 追加流）
 *   · skills-pool  技能池（可复用的 SKILL.md）
 *   · browser      浏览器会话（最近一次操作）
 *
 * 设计要点：
 *   · 所有命令在缺目录 / 缺文件时返回空数组或默认值，绝不 panic。
 *   · 根目录取 `app_config_dir()`（即 Pi 的 `PI_CODING_AGENT_DIR`），与 extension 共根。
 *   · 写命令（team_create / memory_store / skill_publish / browser_open）让面板脱离内核也能管理，
 *     写出的状态会被对应的 Pi 工具读取，形成「人面 + agent 面」闭环。
 */
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

/// 运行态根目录：`<app_config_dir>/.pi`。
pub(crate) fn agent_ops_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(".pi"))
}

fn team_def_path(root: &Path, id: &str) -> PathBuf {
    root.join("teams").join(format!("{id}.json"))
}
/// 软删除后的定义文件：运行日志 `<id>.jsonl` 原地保留，历史运行记录仍可查。
fn team_deleted_path(root: &Path, id: &str) -> PathBuf {
    root.join("teams").join(format!("{id}.deleted.json"))
}
fn team_run_log(root: &Path, id: &str) -> PathBuf {
    root.join("teams").join(format!("{id}.jsonl"))
}
fn team_cancel_path(root: &Path, id: &str) -> PathBuf {
    root.join("teams").join(format!("{id}.cancel"))
}

/// 团队目录下的人工关卡文件：`<id>.gate.<key>.json`（待放行）与
/// `<id>.gate.<key>.decision.json`（放行决定）。
///
/// 关键设计：`<key>` 的生成规则只存在于 TS 扩展里，Rust 不复刻哈希算法——
/// 它靠扫描目录找到待放行文件，再按同名规则写 `.decision.json`。
/// 两处各写一份哈希，迟早会漂移成「面板点了放行、扩展永远收不到」。
fn team_gate_files(root: &Path, id: &str) -> Vec<PathBuf> {
    let dir = root.join("teams");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let prefix = format!("{id}.gate.");
    entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            name.starts_with(&prefix)
                && name.ends_with(".json")
                && !name.ends_with(".decision.json")
        })
        .collect()
}

fn safe_team_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("非法团队 id".into());
    }
    Ok(id.to_string())
}

/// 团队定义的校验与归一化：create / update 共用，保证「成员非空」「牵头人在成员里」。
#[derive(Debug)]
struct TeamInput {
    name: String,
    members: Vec<String>,
    strategy: String,
    lead: String,
    on_failure: String,
    /// 人工关卡成员：这些成员开跑前必须有人放行（LoopForge human-gate）。
    gates: Vec<String>,
    /// 成员级执行器 / 模型覆盖。
    member_overrides: Value,
}

fn normalize_team(
    name: String,
    members: Vec<String>,
    strategy: Option<String>,
    lead: Option<String>,
    on_failure: Option<String>,
    gates: Option<Vec<String>>,
    member_overrides: Option<Value>,
    reject_duplicates: bool,
) -> Result<TeamInput, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("团队名不能为空".into());
    }
    let mut unique: Vec<String> = Vec::new();
    for raw in members {
        let m = raw.trim().to_string();
        if m.is_empty() {
            continue;
        }
        if unique.contains(&m) {
            // 编辑时重复成员会让同一角色跑两遍，明确拒绝；创建沿用去重归一化。
            if reject_duplicates {
                return Err(format!("成员不能重复：{m}"));
            }
            continue;
        }
        unique.push(m);
    }
    if unique.is_empty() {
        return Err("成员至少 1 个".into());
    }
    let strategy = match strategy.as_deref() {
        Some(s @ ("sequential" | "parallel" | "debate")) => s.to_string(),
        _ => "sequential".to_string(),
    };
    let lead = lead
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| unique[0].clone());
    if !unique.contains(&lead) {
        return Err("牵头人必须是团队成员".into());
    }
    let on_failure = match on_failure.as_deref() {
        Some(s @ ("stop" | "continue" | "retry")) => s.to_string(),
        _ => "stop".to_string(),
    };
    // 关卡只允许指向真实成员：指向不存在的成员等于关卡永不触发，
    // 用户以为有人审，实际直接放行——必须报错而不是静默丢弃。
    let mut gate_list: Vec<String> = Vec::new();
    for raw in gates.unwrap_or_default() {
        let g = raw.trim().to_string();
        if g.is_empty() {
            continue;
        }
        if !unique.contains(&g) {
            return Err(format!("关卡成员不在团队里：{g}"));
        }
        if !gate_list.contains(&g) {
            gate_list.push(g);
        }
    }
    // 覆盖项只保留成员键在团队里的条目；其余键写进去也永远不会被调度读到。
    let overrides = match member_overrides {
        Some(Value::Object(map)) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if !unique.contains(&k) {
                    continue;
                }
                if v.is_object() {
                    out.insert(k, v);
                }
            }
            Value::Object(out)
        }
        _ => Value::Object(serde_json::Map::new()),
    };
    Ok(TeamInput {
        name,
        members: unique,
        strategy,
        lead,
        on_failure,
        gates: gate_list,
        member_overrides: overrides,
    })
}

/// 写 JSON 定义：先写临时文件再 rename，避免编辑中途崩溃留下半个定义。
fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(value).unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 日志里尚未收口的运行：没有 run_end / plan-only，且最后一条事件仍在超时窗口内。
/// 成员单次最长 90s，窗口取 120s，既不会把崩溃后的僵死记录永久当成「运行中」，
/// 也不会在成员长时间跑动时误报「已结束」。
fn open_run(log: &Path) -> Option<(String, u64)> {
    let text = std::fs::read_to_string(log).ok()?;
    let now = now_ms();
    let mut order: Vec<String> = Vec::new();
    let mut state: std::collections::HashMap<String, (u64, bool)> =
        std::collections::HashMap::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let id = v
            .get("runId")
            .and_then(|x| x.as_str())
            .unwrap_or("—")
            .to_string();
        let at = v.get("at").and_then(|x| x.as_u64()).unwrap_or(0);
        let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let closed = ty == "run_end"
            || ty == "run_cancelled"
            || v.get("note").and_then(|n| n.as_str()) == Some("plan-only");
        if !state.contains_key(&id) {
            order.push(id.clone());
        }
        let e = state.entry(id).or_insert((0, false));
        if at >= e.0 {
            e.0 = at;
        }
        if closed {
            e.1 = true;
        }
    }
    order.iter().rev().find_map(|id| {
        let (at, closed) = state[id];
        (!closed && now.saturating_sub(at) <= 120_000).then(|| (id.clone(), at))
    })
}

/// 短 id：纳秒时间戳 + pid，足够本地唯一。
fn short_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}{:x}", nanos % 0xffff_ffff, std::process::id())
}

/// 团队定义 + 历史调度条数。
#[tauri::command(async)]
pub fn agent_teams_list(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let Some(root) = agent_ops_root(&app) else {
        return Ok(vec![]);
    };
    let dir = root.join("teams");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let file_name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        let Ok(def) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        // 同目录还有 <id>-blackboard.json（成员产出数组），没有 id，必须跳过，
        // 否则每次调度后列表里都会多出一支空团队。
        let id = def
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() || def.get("members").and_then(|v| v.as_array()).is_none() {
            continue;
        }
        // 删除是软删除：定义改名 <id>.deleted.json，运行日志原地保留供历史查询。
        let deleted = file_name.ends_with(".deleted.json");
        let log = team_run_log(&root, &id);
        // 调度次数按「一次 dispatch 一条 run_end」统计，不能数日志行数。
        let runs = if log.exists() {
            std::fs::read_to_string(&log)
                .map(|s| {
                    s.lines()
                        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                        .filter(|v| {
                            v.get("type").and_then(|t| t.as_str()) == Some("run_end")
                                || v.get("note").and_then(|n| n.as_str()) == Some("plan-only")
                        })
                        .count()
                })
                .unwrap_or(0)
        } else {
            0
        };
        // 已删除团队不再有「正在运行」语义：它的定义已经不能被调度。
        let active_run = if deleted { None } else { open_run(&log) };
        let running = active_run.is_some();
        let active_run_id = active_run.map(|(rid, _)| rid);
        out.push(json!({
            "id": id,
            "name": def.get("name").cloned().unwrap_or(Value::Null),
            "members": def.get("members").cloned().unwrap_or(json!([])),
            "strategy": def.get("strategy").cloned().unwrap_or(Value::Null),
            "lead": def.get("lead").cloned().unwrap_or(Value::Null),
            "on_failure": def.get("on_failure").cloned().unwrap_or(Value::Null),
            "created_at": def.get("created_at").cloned().unwrap_or(Value::Null),
            "updated_at": def.get("updated_at").cloned().unwrap_or(Value::Null),
            "deleted": deleted,
            "running": running,
            "active_run_id": active_run_id,
            "runs": runs,
        }));
    }
    Ok(out)
}

/// 某团队的调度日志（逐行 JSON），供「智能体分道」按成员分道展示。
///
/// 磁盘日志保持内核原样（`runId`），只在 IPC 边界把字段名换成 snake_case。
#[tauri::command(async, rename_all = "snake_case")]
pub fn agent_team_runs(app: tauri::AppHandle, team_id: String) -> Result<Vec<Value>, String> {
    let Some(root) = agent_ops_root(&app) else {
        return Ok(vec![]);
    };
    let id = team_id.trim();
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("非法团队 id".into());
    }
    let log = root.join("teams").join(format!("{id}.jsonl"));
    if !log.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&log).map_err(|e| e.to_string())?;
    Ok(text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .map(ipc_run_event)
        .collect())
}

/// 日志事件 → IPC 事件：`runId` 只在磁盘格式里存在，IPC 统一 `run_id`。
fn ipc_run_event(mut event: Value) -> Value {
    if let Some(obj) = event.as_object_mut() {
        if let Some(run_id) = obj.remove("runId") {
            obj.insert("run_id".into(), run_id);
        }
    }
    event
}

/// 新建团队：写 `<root>/teams/<id>.json`。
#[tauri::command(async, rename_all = "snake_case")]
pub fn agent_team_create(
    app: tauri::AppHandle,
    name: String,
    members: Vec<String>,
    strategy: Option<String>,
    lead: Option<String>,
    on_failure: Option<String>,
    gates: Option<Vec<String>>,
    member_overrides: Option<Value>,
) -> Result<Value, String> {
    let root = agent_ops_root(&app).ok_or_else(|| "取配置目录失败".to_string())?;
    // 去重保序：重复成员会让同一角色在团队里跑两遍，与 Pi 工具侧行为保持一致。
    let input = normalize_team(
        name,
        members,
        strategy,
        lead,
        on_failure,
        gates,
        member_overrides,
        false,
    )?;
    let def = json!({
        "id": short_id(),
        "name": input.name,
        "members": input.members,
        "lead": input.lead,
        "strategy": input.strategy,
        "on_failure": input.on_failure,
        "gates": input.gates,
        "member_overrides": input.member_overrides,
        "created_at": now_ms(),
    });
    let dir = root.join("teams");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = def
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    write_json_atomic(&team_def_path(&root, &id), &def)?;
    Ok(def)
}

/// 编辑团队定义：名称 / 成员 / 牵头人 / 失败策略。
///
/// 只改磁盘上的定义，正在跑的调度在 `team_dispatch` 开头已把定义读进内存（快照），
/// 因此旧实例按旧定义跑完，新定义从下一次调度开始生效。
#[tauri::command(async, rename_all = "snake_case")]
pub fn agent_team_update(
    app: tauri::AppHandle,
    id: String,
    name: String,
    members: Vec<String>,
    strategy: Option<String>,
    lead: Option<String>,
    on_failure: Option<String>,
    gates: Option<Vec<String>>,
    member_overrides: Option<Value>,
) -> Result<Value, String> {
    let root = agent_ops_root(&app).ok_or_else(|| "取配置目录失败".to_string())?;
    let id = safe_team_id(&id)?;
    let path = team_def_path(&root, &id);
    if !path.exists() {
        return Err("团队不存在或已删除".into());
    }
    let old: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    // 编辑是显式操作：重复成员直接报错，不静默去重。
    let input = normalize_team(
        name,
        members,
        strategy,
        lead,
        on_failure,
        gates,
        member_overrides,
        true,
    )?;
    let def = json!({
        "id": id,
        "name": input.name,
        "members": input.members,
        "lead": input.lead,
        "strategy": input.strategy,
        "on_failure": input.on_failure,
        "gates": input.gates,
        "member_overrides": input.member_overrides,
        "created_at": old.get("created_at").cloned().unwrap_or(Value::Null),
        "updated_at": now_ms(),
    });
    write_json_atomic(&path, &def)?;
    Ok(def)
}

/// 删除团队：定义改名为 `<id>.deleted.json`（软删除），运行日志原地保留。
///
/// 删除不影响已经跑起来的实例——调度持有定义快照；正在运行时界面会先提示，
/// 并允许先取消再删。
#[tauri::command(async)]
pub fn agent_team_delete(app: tauri::AppHandle, id: String) -> Result<Value, String> {
    let root = agent_ops_root(&app).ok_or_else(|| "取配置目录失败".to_string())?;
    let id = safe_team_id(&id)?;
    let path = team_def_path(&root, &id);
    if !path.exists() {
        return Err("团队不存在或已删除".into());
    }
    std::fs::rename(&path, team_deleted_path(&root, &id)).map_err(|e| e.to_string())?;
    // 不动 <id>.cancel：用户可能刚点过「先取消运行」，删除不能把取消请求抹掉。
    Ok(json!({ "id": id, "deleted": true, "runs_preserved": true }))
}

/// 请求取消某次运行：写 `<id>.cancel`（带 runId）。
///
/// 真正停进程由 Pi extension 执行：成员子进程在跑动中每 400ms 读一次该文件，
/// 命中本次 runId 就 kill 子进程，并把运行记录收口成「已取消」。
#[tauri::command(async, rename_all = "snake_case")]
pub fn agent_team_cancel(
    app: tauri::AppHandle,
    team_id: String,
    run_id: Option<String>,
) -> Result<Value, String> {
    let root = agent_ops_root(&app).ok_or_else(|| "取配置目录失败".to_string())?;
    let id = safe_team_id(&team_id)?;
    let log = team_run_log(&root, &id);
    let Some((open_id, _)) = open_run(&log) else {
        return Err("该团队当前没有进行中的运行".into());
    };
    if let Some(want) = run_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if want != open_id {
            return Err("该运行已结束，无需取消".into());
        }
    }
    let dir = root.join("teams");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 磁盘标记沿用 extension 读取的 `runId`；IPC 返回统一 `run_id`。
    let at = now_ms();
    let payload = json!({ "runId": open_id, "at": at });
    std::fs::write(team_cancel_path(&root, &id), payload.to_string())
        .map_err(|e| e.to_string())?;
    Ok(json!({ "run_id": open_id, "at": at }))
}

/// 待放行的人工关卡列表：扫团队目录里的 `<id>.gate.*.json`。
///
/// 面板据此显示「等人放行」的卡片；扩展那边此刻正阻塞在 awaitGate 里。
#[tauri::command(async, rename_all = "snake_case")]
pub fn agent_team_gates(app: tauri::AppHandle, team_id: String) -> Result<Vec<Value>, String> {
    let root = agent_ops_root(&app).ok_or_else(|| "取配置目录失败".to_string())?;
    let id = safe_team_id(&team_id)?;
    let mut out = Vec::new();
    for file in team_gate_files(&root, &id) {
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let Ok(mut v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        // 带上文件名：放行时要写到同名 `.decision.json`，Rust 不复刻 key 算法。
        if let Some(obj) = v.as_object_mut() {
            obj.insert(
                "file".into(),
                Value::String(
                    file.file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string(),
                ),
            );
        }
        out.push(v);
    }
    out.sort_by(|a, b| {
        a.get("at")
            .and_then(|x| x.as_u64())
            .unwrap_or(0)
            .cmp(&b.get("at").and_then(|x| x.as_u64()).unwrap_or(0))
    });
    Ok(out)
}

/// 人工关卡放行 / 驳回：写 `<gate 文件同名>.decision.json`，扩展读到即继续。
#[tauri::command(async, rename_all = "snake_case")]
pub fn agent_team_gate_decide(
    app: tauri::AppHandle,
    team_id: String,
    member: String,
    run_id: Option<String>,
    decision: String,
) -> Result<Value, String> {
    let root = agent_ops_root(&app).ok_or_else(|| "取配置目录失败".to_string())?;
    let id = safe_team_id(&team_id)?;
    let member = member.trim().to_string();
    if member.is_empty() {
        return Err("成员不能为空".into());
    }
    // 只认 approve / reject：拼错的决定不能当成放行。
    let decision = match decision.trim() {
        "approve" => "approve",
        "reject" => "reject",
        _ => return Err("关卡决定只能是 approve 或 reject".into()),
    };
    let files = team_gate_files(&root, &id);
    let mut hit: Option<(PathBuf, Value)> = None;
    for file in files {
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if v.get("member").and_then(|m| m.as_str()) != Some(member.as_str()) {
            continue;
        }
        // 指定了 runId 就必须匹配：同一成员可能排队过多次，放行错的那次会串味。
        if let Some(want) = run_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            if v.get("runId").and_then(|m| m.as_str()) != Some(want) {
                continue;
            }
        }
        hit = Some((file, v));
        break;
    }
    let Some((file, gate)) = hit else {
        return Err("该关卡已不在等待中（可能已放行或已超时）".into());
    };
    let stem = file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let decision_path = root.join("teams").join(format!("{stem}.decision.json"));
    let payload = json!({
        "runId": gate.get("runId").cloned().unwrap_or(Value::Null),
        "member": member,
        "decision": decision,
        "at": now_ms(),
    });
    std::fs::write(&decision_path, payload.to_string()).map_err(|e| e.to_string())?;
    Ok(json!({ "member": member, "decision": decision }))
}

/// 记忆条目（物化后的有效条目，最近 200 条，含 id/ts/text/tags）。
/// 墓碑行不在这里出现；待撤销条目走 `agent_memory_trash`。
#[tauri::command(async)]
pub fn agent_memory_list(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    Ok(crate::memory_store::active(&app)
        .into_iter()
        .take(200)
        .filter_map(|e| serde_json::to_value(e).ok())
        .collect())
}

/// 待撤销条目：24 小时窗口内可恢复，到期由调度 tick 硬失效。
#[tauri::command(async)]
pub fn agent_memory_trash(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    Ok(crate::memory_store::pending(&app)
        .into_iter()
        .filter_map(|e| serde_json::to_value(e).ok())
        .collect())
}

/// 删除记忆：进入 24 小时待撤销态，召回立即不可见。
#[tauri::command(async)]
pub fn agent_memory_forget(app: tauri::AppHandle, id: String) -> Result<Vec<Value>, String> {
    crate::memory_store::soft_delete(&app, &id, crate::proactive::now_ms())?;
    agent_memory_list(app)
}

/// 撤销删除：把待撤销条目恢复为有效记忆。
#[tauri::command(async)]
pub fn agent_memory_restore(app: tauri::AppHandle, id: String) -> Result<Vec<Value>, String> {
    crate::memory_store::restore(&app, &id, crate::proactive::now_ms())?;
    agent_memory_list(app)
}

/// 立即永久删除：跳过 24 小时窗口硬失效，写审计后不可恢复。
#[tauri::command(async)]
pub fn agent_memory_purge(app: tauri::AppHandle, id: String) -> Result<Vec<Value>, String> {
    crate::memory_store::purge_now(&app, &id, crate::proactive::now_ms())?;
    agent_memory_list(app)
}

/// 更正一条记忆：追加 `update` 事件行，原行保留作审计。
#[tauri::command(async)]
pub fn agent_memory_update(
    app: tauri::AppHandle,
    id: String,
    text: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Vec<Value>, String> {
    crate::memory_store::update(
        &app,
        &id,
        text.as_deref(),
        tags.as_deref(),
        crate::proactive::now_ms(),
    )?;
    agent_memory_list(app)
}

/// 用户画像：由记忆保留标签折叠而成，只读视图，不另立档案。
#[tauri::command(async)]
pub fn agent_profile_get(app: tauri::AppHandle) -> Result<Value, String> {
    match crate::memory_store::refresh_profile(&app) {
        Some(p) => serde_json::to_value(p).map_err(|e| e.to_string()),
        None => Ok(json!({ "generated_at": 0, "source_mtime": 0 })),
    }
}

/// 写入一条记忆：追加到 `<root>/memory/memory.jsonl`。
#[tauri::command(async)]
pub fn agent_memory_store(
    app: tauri::AppHandle,
    text: String,
    tags: Vec<String>,
) -> Result<Value, String> {
    let root = agent_ops_root(&app).ok_or_else(|| "取配置目录失败".to_string())?;
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("记忆内容不能为空".into());
    }
    let ts = now_ms() as i64;
    let id = crate::memory_vec::entry_id(ts, &text);
    let entry = json!({ "id": id, "ts": ts, "text": text, "tags": tags, "source": "ui" });
    let dir = root.join("memory");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("memory.jsonl"))
        .map_err(|e| e.to_string())?;
    f.write_all(format!("{}\n", entry).as_bytes())
        .map_err(|e| e.to_string())?;
    // B5 向量化钩子：fire-and-forget，失败只记日志，词面主路径不受影响。
    crate::memory_vec::spawn_upsert(&app, ts, text, tags);
    crate::memory_store::refresh_profile(&app);
    Ok(entry)
}

/// 技能池中的技能（名称 + 描述）。
#[tauri::command(async)]
pub fn agent_skillpool_list(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let Some(root) = agent_ops_root(&app) else {
        return Ok(vec![]);
    };
    let dir = root.join("skills-pool");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let skill = entry.path().join("SKILL.md");
        if !skill.exists() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let body = std::fs::read_to_string(&skill).unwrap_or_default();
        let description = body
            .lines()
            .find_map(|l| l.trim().strip_prefix("description:"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        out.push(json!({ "name": name, "description": description }));
    }
    Ok(out)
}

/// 发布技能到技能池：写 `<root>/skills-pool/<name>/SKILL.md`。
#[tauri::command(async)]
pub fn agent_skill_publish(
    app: tauri::AppHandle,
    name: String,
    description: String,
    body: String,
) -> Result<Value, String> {
    let root = agent_ops_root(&app).ok_or_else(|| "取配置目录失败".to_string())?;
    let name = name.trim().to_string();
    if !is_valid_skill_name(&name) {
        return Err("技能名需小写字母/数字/单连字符且 ≤64".into());
    }
    if description.trim().is_empty() {
        return Err("description 不能为空".into());
    }
    let dir = root.join("skills-pool").join(&name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let md = format!(
        "---\nname: {name}\ndescription: {}\n---\n{}\n",
        description.trim(),
        body
    );
    std::fs::write(dir.join("SKILL.md"), md).map_err(|e| e.to_string())?;
    Ok(json!({ "name": name, "description": description.trim() }))
}

/// 浏览器会话状态（最近一次 session.json；无则 inactive）。
#[tauri::command(async)]
pub fn agent_browser_status(app: tauri::AppHandle) -> Result<Value, String> {
    let Some(root) = agent_ops_root(&app) else {
        return Ok(json!({ "active": false }));
    };
    let f = root.join("browser").join("session.json");
    if !f.exists() {
        return Ok(json!({ "active": false }));
    }
    let text = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
    let Ok(mut v) = serde_json::from_str::<Value>(&text) else {
        return Ok(json!({ "active": false }));
    };
    if let Some(obj) = v.as_object_mut() {
        obj.insert("active".into(), Value::Bool(true));
    }
    Ok(v)
}

/// 在用户真实浏览器中打开网址（桌面 agent 友好的外部跳转）。
#[tauri::command(async)]
pub fn agent_browser_open(app: tauri::AppHandle, url: String) -> Result<Value, String> {
    let root = agent_ops_root(&app).ok_or_else(|| "取配置目录失败".to_string())?;
    let url = url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("url 需以 http(s):// 开头".into());
    }
    let res = match std::env::consts::OS {
        "macos" => Command::new("open").arg(&url).output(),
        "windows" => Command::new("cmd").args(["/c", "start", "", &url]).output(),
        _ => Command::new("xdg-open").arg(&url).output(),
    };
    let dir = root.join("browser");
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(
        dir.join("session.json"),
        serde_json::to_string_pretty(&json!({ "url": url, "method": "open", "at": now_ms() }))
            .unwrap(),
    );
    match res {
        Ok(_) => Ok(json!({ "url": url, "opened": true })),
        Err(e) => Err(format!("打开浏览器失败：{e}；请手动访问 {url}")),
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn is_valid_skill_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 64
        && n.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !n.starts_with('-')
        && !n.ends_with('-')
        && !n.contains("--")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn team(members: &[&str], lead: Option<&str>, reject: bool) -> Result<TeamInput, String> {
        normalize_team(
            "T".into(),
            members.iter().map(|s| s.to_string()).collect(),
            None,
            lead.map(String::from),
            None,
            None,
            None,
            reject,
        )
    }

    #[test]
    fn team_edit_validation_guards() {
        assert!(team(&[], None, true).unwrap_err().contains("至少 1"));
        assert!(team(&["a"], Some("b"), true).unwrap_err().contains("牵头人"));
        assert!(team(&["a", "a"], None, true).unwrap_err().contains("不能重复"));
        // 创建路径沿用去重归一化，与 Pi 工具 team_create 行为一致。
        assert_eq!(team(&["a", "a", "b"], None, false).unwrap().members, vec!["a", "b"]);
    }

    #[test]
    fn open_run_only_reports_unclosed_recent_runs() {
        let dir = std::env::temp_dir().join(format!("pi-teams-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("t.jsonl");
        let now = now_ms();
        let write = |rows: Vec<Value>| {
            std::fs::write(
                &log,
                rows.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n"),
            )
            .unwrap();
        };
        write(vec![
            json!({"runId": "a", "type": "member_start", "at": now - 10_000}),
            json!({"runId": "a", "type": "run_end", "at": now - 9_000}),
            json!({"runId": "b", "type": "member_start", "at": now - 5_000}),
        ]);
        assert_eq!(open_run(&log).map(|(id, _)| id).as_deref(), Some("b"));
        // 崩溃后遗留的半截记录超过窗口就不再算「运行中」。
        write(vec![json!({"runId": "c", "type": "member_start", "at": now - 600_000})]);
        assert!(open_run(&log).is_none());
        write(vec![json!({"runId": "d", "note": "plan-only", "at": now})]);
        assert!(open_run(&log).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
