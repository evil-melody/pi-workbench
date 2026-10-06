use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::state::RolesState;

/// 一个「专家角色」= 注入 Pi 系统提示的追加段 + 元信息。
/// 系统提示总量受蓝图约束（<2000 token），故内置角色均控制在数百 token 量级。
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Role {
    pub id: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
}

const GENERAL_PROMPT: &str = "\
你是 pi-workbench 的通用助手，运行在 pi 这个 coding agent 内核上。

默认行为：
1. 先确认需求边界与约束，再给方案；动手改文件前先说明会改哪些文件、为什么。
2. 回答先给结论，再给依据（文件:行号 / 命令输出 / 日志原文）。
3. 不确定就说不确定，并列出你已核实与未核实的部分，不要编造 API、路径、版本号。
4. 需要执行的代码要给出可复制的完整命令，不要写「自行参考文档」。";

const AIDER_PROMPT: &str = "\
你现在是 Aider 风格的编程搭档（pair programmer），在 pi 这个 coding agent 里做真实的代码修改。

工作方式：
1. 先建结构认知再动手。用 Grep/Glob/读文件确认符号定义与调用点，不要凭上下文猜测就写文件。
2. 最小 diff：只改必须改的行，以字符级 SEARCH/REPLACE 定位改动；为了省事重写整个文件是错误做法。
3. 测试驱动：改动涉及行为时先跑项目已有的测试 / 类型检查 / lint。失败就把报错原文回灌下一轮自我修复；修实现，不改测试与断言来迁就实现。
4. 一次变更一个原子提交（仓库已是 git 且用户未禁止时）：Conventional 风格信息，例如 feat(auth): refresh token rotation。非 git 目录不要臆造提交。
5. 交付前自检：类型能过、lint 无新增告警、相关测试通过。无法确认就明说「未验证」，不要用「应该可以」糊过去。
6. 只读优先：用户说「只解释 / 只诊断 / 别改文件」时，一律不写任何文件，只给结论与建议。

表达：中文回复，技术术语保留英文原词；命令、报错、日志原样贴出。
不确定就直接提问：给出证据与不确定的点，不编造 API、文件路径或版本号。";

/// 内置角色。USER_ROLES_DIR 下同名 id 的 .md 会覆盖内置定义。
pub fn builtin_roles() -> Vec<Role> {
    vec![
        Role {
            id: "general".into(),
            name: "通用助手".into(),
            description: "默认人格：先确认边界再给方案，结论先行、依据到行号。".into(),
            prompt: GENERAL_PROMPT.into(),
        },
        Role {
            id: "aider-programmer".into(),
            name: "Aider 编程专家".into(),
            description: "Aider 范式编程搭档：repo map 先行、最小 diff、测试驱动、原子提交、只读优先。".into(),
            prompt: AIDER_PROMPT.into(),
        },
    ]
}

/// 解析角色 md：首行 `<!-- role: id | name -->`，其余正文为 prompt。
pub fn parse_role_md(text: &str) -> Option<(String, String, String)> {
    let first = text.lines().next()?.trim();
    let rest = text.splitn(2, '\n').nth(1).unwrap_or("").trim_matches('\n');
    let body = rest.trim();
    if !first.starts_with("<!-- role:") {
        return None;
    }
    let inner = first
        .trim_start_matches("<!-- role:")
        .trim_end_matches("-->")
        .trim();
    let mut parts = inner.splitn(2, '|');
    let id = parts.next()?.trim().to_string();
    if id.is_empty() || body.is_empty() {
        return None;
    }
    let name = parts
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id.clone());
    Some((id, name, body.to_string()))
}

/// 把角色渲染回 md，供 role_set 落盘。
pub fn render_role_md(role: &Role) -> String {
    format!("<!-- role: {} | {} -->\n\n{}\n", role.id, role.name, role.prompt)
}

fn roles_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("roles");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn project_roles_file(root: Option<String>) -> Option<PathBuf> {
    let root = root?;
    let dir = PathBuf::from(root).join(".pi").join("roles");
    Some(dir.join("current.md"))
}

/// 用户自定义角色：与内置同 id 时覆盖内置定义。
pub fn user_roles(app: &AppHandle) -> Vec<Role> {
    let dir = match roles_dir(app) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect())
        .unwrap_or_default();
    files.sort();
    for f in files {
        if f.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if f.file_name().map(|n| n == "current.md").unwrap_or(false) {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&f) {
            if let Some((id, name, prompt)) = parse_role_md(&text) {
                out.push(Role {
                    id,
                    name,
                    description: "用户自定义角色".into(),
                    prompt,
                });
            }
        }
    }
    out
}

pub fn all_roles(app: &AppHandle) -> Vec<Role> {
    let mut roles = builtin_roles();
    for r in user_roles(app) {
        if let Some(existing) = roles.iter_mut().find(|x| x.id == r.id) {
            *existing = r;
        } else {
            roles.push(r);
        }
    }
    roles
}

#[tauri::command]
pub fn role_list(app: AppHandle) -> Vec<Role> {
    all_roles(&app)
}

/// 切换角色：把选中角色的 prompt 写进项目级 `.pi/roles/current.md`。
/// Pi extension（role-inject）每轮从该文件读取并追加到系统提示，因此切换即时生效、无需重启内核。
#[tauri::command]
pub fn role_set(
    app: AppHandle,
    state: State<RolesState>,
    id: String,
    root: Option<String>,
) -> Result<Role, String> {
    let role = all_roles(&app)
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| format!("未知角色: {id}"))?;

    if let Some(file) = project_roles_file(root.clone()) {
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&file, render_role_md(&role)).map_err(|e| e.to_string())?;
    }
    *state.current.lock().unwrap() = Some(role.id.clone());
    Ok(role)
}

#[tauri::command]
pub fn role_current(
    app: AppHandle,
    state: State<RolesState>,
    root: Option<String>,
) -> Option<Role> {
    let id = {
        let guard = state.current.lock().unwrap();
        guard.clone()
    };
    let id = id.or_else(|| {
        project_roles_file(root.clone())
            .and_then(|f| fs::read_to_string(f).ok())
            .and_then(|t| parse_role_md(&t).map(|(id, _, _)| id))
    })?;
    all_roles(&app).into_iter().find(|r| r.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_roles_cover_general_and_aider() {
        let roles = builtin_roles();
        assert!(roles.iter().any(|r| r.id == "general"));
        assert!(roles.iter().any(|r| r.id == "aider-programmer"));
    }

    #[test]
    fn aider_role_stays_within_token_budget() {
        let role = builtin_roles()
            .into_iter()
            .find(|r| r.id == "aider-programmer")
            .unwrap();
        // 蓝图约束：单角色 system prompt 追加段 < 2000 token（中文按 1 字≈1.5 token 粗估）。
        assert!(role.prompt.chars().count() < 1400, "角色提示词过长");
        assert!(role.prompt.contains("SEARCH/REPLACE"), "需保留字符级编辑约定");
        assert!(role.prompt.contains("测试"), "需保留测试驱动约定");
    }

    #[test]
    fn role_md_roundtrip_preserves_prompt() {
        let role = builtin_roles()
            .into_iter()
            .find(|r| r.id == "aider-programmer")
            .unwrap();
        let md = render_role_md(&role);
        let (id, name, body) = parse_role_md(&md).expect("需能解析回写出的 md");
        assert_eq!(id, "aider-programmer");
        assert_eq!(name, role.name);
        assert_eq!(body, role.prompt);
    }

    #[test]
    fn role_md_without_header_is_rejected() {
        assert!(parse_role_md("没有头\n\n正文").is_none());
    }
}
