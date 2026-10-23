//! 项目级代码库索引：把项目工作目录喂给 `codebase-memory-mcp`，
//! 让 Pi 能检索/查询当前项目的结构与代码。
//!
//! 设计要点：
//!   · 索引是异步后台任务，不阻塞 UI；
//!   · 结果（时间、节点数、边数、错误）持久化到项目记录；
//!   · 不硬编码二进制位置，优先 PATH，再回退常用安装路径；
//!   · 失败时保留错误文本，不吞错。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::projects::require_project;
use crate::state::ProjectsState;

const TOOL_NAME: &str = "codebase-memory-mcp";

/// 索引结果，供前端展示「有没有在跑 / 成功没 / 规模多大」。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseIndexStatus {
    pub project_id: String,
    pub project_name: String,
    pub status: String,
    pub nodes: usize,
    pub edges: usize,
    pub indexed_at: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseIndexMeta {
    pub project_name: Option<String>,
    pub nodes: Option<usize>,
    pub edges: Option<usize>,
    pub indexed_at: Option<u64>,
    pub error: Option<String>,
}

/// 定位 `codebase-memory-mcp` 二进制。
///
/// 优先环境变量 `CODEBASE_MEMORY_MCP_PATH`，其次 PATH，
/// 最后回退几个常用安装位置（pipx / cargo / homebrew / .local）。
fn find_binary() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("CODEBASE_MEMORY_MCP_PATH") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Ok(pb);
        }
    }

    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(std::path::MAIN_SEPARATOR) {
            let candidate = Path::new(dir).join(TOOL_NAME);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    let home = std::env::var("HOME").map_err(|_| "无法取得 HOME 环境变量".to_string())?;
    let home = PathBuf::from(home);
    let candidates = [
        home.join(".local").join("bin").join(TOOL_NAME),
        home.join(".cargo").join("bin").join(TOOL_NAME),
        PathBuf::from("/opt/homebrew/bin").join(TOOL_NAME),
        PathBuf::from("/usr/local/bin").join(TOOL_NAME),
        PathBuf::from("/usr/bin").join(TOOL_NAME),
    ];
    for c in candidates {
        if c.is_file() {
            return Ok(c);
        }
    }
    Err(format!("找不到 {} 二进制。请安装 codebase-memory-mcp 或设置 CODEBASE_MEMORY_MCP_PATH", TOOL_NAME))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// 索引硬超时（秒）。实测全仓 ~10s 即完成；超时 = CLI 挂死（守护进程卡住等），
/// 必须杀掉并把失败亮出来，绝不让前端「索引代码库中…」永远转圈。
const INDEX_TIMEOUT_SECS: u64 = 300;

/// 运行一次 `codebase-memory-mcp cli --json index_repository {"repo_path":...}`。
///
/// 注意：CLI 会在 JSON 之前打印 deprecation warning 之类的前导行，
/// 所以这里只截取第一个 `{` 到最后一个 `}` 之间的内容当作 JSON。
/// 用 spawn + try_wait 轮询实现硬超时（std 没有带超时的 output()）。
fn run_index(repo_path: &str) -> Result<Value, String> {
    let bin = find_binary()?;
    let arg = serde_json::json!({ "repo_path": repo_path }).to_string();
    let mut child = Command::new(&bin)
        .args(["cli", "--json", "index_repository", &arg])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 {} 失败: {}", TOOL_NAME, e))?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(INDEX_TIMEOUT_SECS);
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Ok(st),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    // 超时：杀进程树（直接 kill 本进程即可，CLI 无子进程树）。
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(format!(
                        "索引超过 {}s 未完成，已强制终止（CLI 挂死或仓库过大）",
                        INDEX_TIMEOUT_SECS
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => break Err(format!("等待 {} 退出失败: {}", TOOL_NAME, e)),
        }
    };

    let status = match status {
        Ok(s) => s,
        Err(msg) => return Err(msg),
    };

    if !status.success() {
        // 被杀/非零退出：stderr 已随管道持有，读出来定位。
        let mut err = String::new();
        if let Some(mut se) = child.stderr.take() {
            use std::io::Read;
            let _ = se.read_to_string(&mut err);
        }
        return Err(format!("{} 退出码非零: {}", TOOL_NAME, err));
    }

    let mut stdout = String::new();
    if let Some(mut so) = child.stdout.take() {
        use std::io::Read;
        let _ = so.read_to_string(&mut stdout);
    }
    let text = stdout;
    let trimmed = text.trim();
    let start = trimmed.find('{').ok_or_else(|| format!("{} 没有输出 JSON:\n{}", TOOL_NAME, trimmed))?;
    let end = trimmed.rfind('}').ok_or_else(|| format!("{} 输出没有闭合的 JSON:\n{}", TOOL_NAME, trimmed))?;
    let json_str = &trimmed[start..=end];

    let wrapper: Value = serde_json::from_str(json_str)
        .map_err(|e| format!("{} 输出不是 JSON: {}\n---\n{}", TOOL_NAME, e, json_str))?;

    if wrapper.get("isError").and_then(|v| v.as_bool()).unwrap_or(false) {
        let msg = wrapper
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("未知错误")
            .to_string();
        return Err(format!("{} 报告错误: {}", TOOL_NAME, msg));
    }

    Ok(wrapper)
}

/// 从 CLI 返回的 structuredContent 里提取索引元信息。
fn parse_index_result(json: Value) -> Result<CodebaseIndexMeta, String> {
    let body = json
        .get("structuredContent")
        .cloned()
        .or_else(|| {
            // 老版本可能把结构化结果塞在 content[0].text 里，做一层兼容。
            json.get("content")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
        })
        .unwrap_or(json);

    let project_name = body.get("project").and_then(|v| v.as_str()).map(String::from);
    let nodes = body.get("nodes").and_then(|v| v.as_u64()).map(|n| n as usize);
    let edges = body.get("edges").and_then(|v| v.as_u64()).map(|n| n as usize);
    let status = body.get("status").and_then(|v| v.as_str()).map(String::from);

    if status.as_deref() != Some("indexed") {
        return Err(format!("索引未完成: {:?}", status));
    }

    Ok(CodebaseIndexMeta {
        project_name,
        nodes,
        edges,
        indexed_at: Some(now_ms()),
        error: None,
    })
}

/// 触发项目代码库索引，后台运行，返回最终状态。
#[tauri::command(async)]
#[allow(non_snake_case)]
pub async fn project_index_codebase(
    app: AppHandle,
    id: String,
    state: State<'_, ProjectsState>,
) -> Result<CodebaseIndexStatus, String> {
    // 先在校验阶段取路径：失败立即返回，不发起后台任务。
    let repo_path = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let project = require_project(&store, &id)?;
        let raw = project.path.as_deref().ok_or_else(|| "项目没有工作目录".to_string())?;
        let canon = fs::canonicalize(raw).map_err(|e| format!("工作目录不存在: {e}"))?;
        canon.to_string_lossy().into_owned()
    };

    let app2 = app.clone();
    let id2 = id.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let meta = match run_index(&repo_path).and_then(parse_index_result) {
            Ok(m) => m,
            Err(e) => {
                let st = app2.state::<ProjectsState>();
                {
                    // 锁作用域必须在这里收掉：save() 内部会对同一把 std Mutex 再次
                    // lock —— 持锁调 save 是自死锁（症状：前端「索引代码库中…」永远
                    // 转圈、projects.json 里 codebase_* 字段永远不落盘）。
                    let mut store = st.store.lock().map_err(|x| x.to_string())?;
                    crate::projects::set_codebase_status(
                        &mut store,
                        &id2,
                        None,
                        None,
                        None,
                        None,
                        Some(e.clone()),
                    );
                }
                crate::projects::save(&app2, &st)?;
                return Err(e);
            }
        };

        let st = app2.state::<ProjectsState>();
        {
            // 同上：先落库（持锁）、放锁、再持久化，绝不持锁跨 save()。
            let mut store = st.store.lock().map_err(|x| x.to_string())?;
            crate::projects::set_codebase_status(
                &mut store,
                &id2,
                meta.project_name.clone(),
                meta.nodes,
                meta.edges,
                meta.indexed_at,
                None,
            );
        }
        crate::projects::save(&app2, &st)?;

        Ok(CodebaseIndexStatus {
            project_id: id2.clone(),
            project_name: meta.project_name.clone().unwrap_or_default(),
            status: "indexed".into(),
            nodes: meta.nodes.unwrap_or(0),
            edges: meta.edges.unwrap_or(0),
            indexed_at: meta.indexed_at.unwrap_or(0),
            error: None,
        })
    })
    .await
    .map_err(|e| format!("索引任务异常: {e}"))?;

    result
}

/// 读取项目当前的代码库索引状态（不触发重建）。
#[tauri::command]
#[allow(non_snake_case)]
pub fn project_index_status(id: String, state: State<'_, ProjectsState>) -> Result<CodebaseIndexStatus, String> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let project = require_project(&store, &id)?;
    let status = if project.codebase_indexed_at.is_some() {
        "indexed"
    } else if project.codebase_index_error.is_some() {
        "error"
    } else {
        "none"
    };
    Ok(CodebaseIndexStatus {
        project_id: id,
        project_name: project.codebase_project_name.clone().unwrap_or_default(),
        status: status.into(),
        nodes: project.codebase_nodes.unwrap_or(0),
        edges: project.codebase_edges.unwrap_or(0),
        indexed_at: project.codebase_indexed_at.unwrap_or(0),
        error: project.codebase_index_error.clone(),
    })
}
