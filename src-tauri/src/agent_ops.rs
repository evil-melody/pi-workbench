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
use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;

/// 运行态根目录：`<app_config_dir>/.pi`。
fn agent_ops_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(".pi"))
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
#[tauri::command]
pub fn agent_teams_list(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let Some(root) = agent_ops_root(&app) else {
        return Ok(vec![]);
    };
    let dir = root.join("teams");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        let Ok(def) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let id = def.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let log = root.join("teams").join(format!("{id}.jsonl"));
        let runs = if log.exists() {
            std::fs::read_to_string(&log)
                .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count())
                .unwrap_or(0)
        } else {
            0
        };
        out.push(json!({
            "id": id,
            "name": def.get("name").cloned().unwrap_or(Value::Null),
            "members": def.get("members").cloned().unwrap_or(json!([])),
            "strategy": def.get("strategy").cloned().unwrap_or(Value::Null),
            "created_at": def.get("created_at").cloned().unwrap_or(Value::Null),
            "runs": runs,
        }));
    }
    Ok(out)
}

/// 新建团队：写 `<root>/teams/<id>.json`。
#[tauri::command]
pub fn agent_team_create(
    app: tauri::AppHandle,
    name: String,
    members: Vec<String>,
    strategy: Option<String>,
) -> Result<Value, String> {
    let root = agent_ops_root(&app).ok_or_else(|| "取配置目录失败".to_string())?;
    let name = name.trim().to_string();
    let members: Vec<String> = members.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if name.is_empty() {
        return Err("团队名不能为空".into());
    }
    if members.is_empty() {
        return Err("成员至少 1 个".into());
    }
    let strategy = match strategy.as_deref() {
        Some(s @ ("sequential" | "parallel" | "debate")) => s.to_string(),
        _ => "sequential".to_string(),
    };
    let def = json!({
        "id": short_id(),
        "name": name,
        "members": members,
        "strategy": strategy,
        "created_at": now_ms(),
    });
    let dir = root.join("teams");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = def.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    std::fs::write(dir.join(format!("{id}.json")), serde_json::to_string_pretty(&def).unwrap())
        .map_err(|e| e.to_string())?;
    Ok(def)
}

/// 记忆条目（最近 200 条，含 ts/text/tags）。
#[tauri::command]
pub fn agent_memory_list(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let Some(root) = agent_ops_root(&app) else {
        return Ok(vec![]);
    };
    let f = root.join("memory").join("memory.jsonl");
    if !f.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            out.push(v);
        }
        if out.len() >= 200 {
            break;
        }
    }
    Ok(out)
}

/// 写入一条记忆：追加到 `<root>/memory/memory.jsonl`。
#[tauri::command]
pub fn agent_memory_store(app: tauri::AppHandle, text: String, tags: Vec<String>) -> Result<Value, String> {
    let root = agent_ops_root(&app).ok_or_else(|| "取配置目录失败".to_string())?;
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("记忆内容不能为空".into());
    }
    let entry = json!({ "ts": now_ms(), "text": text, "tags": tags });
    let dir = root.join("memory");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("memory.jsonl"))
        .map_err(|e| e.to_string())?;
    f.write_all(format!("{}\n", entry).as_bytes()).map_err(|e| e.to_string())?;
    Ok(entry)
}

/// 技能池中的技能（名称 + 描述）。
#[tauri::command]
pub fn agent_skillpool_list(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let Some(root) = agent_ops_root(&app) else {
        return Ok(vec![]);
    };
    let dir = root.join("skills-pool");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
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
#[tauri::command]
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
    let md = format!("---\nname: {name}\ndescription: {}\n---\n{}\n", description.trim(), body);
    std::fs::write(dir.join("SKILL.md"), md).map_err(|e| e.to_string())?;
    Ok(json!({ "name": name, "description": description.trim() }))
}

/// 浏览器会话状态（最近一次 session.json；无则 inactive）。
#[tauri::command]
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
#[tauri::command]
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
        serde_json::to_string_pretty(&json!({ "url": url, "method": "open", "at": now_ms() })).unwrap(),
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
    !n.is_empty() && n.len() <= 64 && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') &&
        !n.starts_with('-') && !n.ends_with('-') && !n.contains("--")
}
