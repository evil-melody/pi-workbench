use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::capabilities::CapabilityManifest;
use crate::net::{fetch_text, require_http_url};
use crate::pi_bridge::{lock_seq, ok_data};
use crate::state::PiState;

/// Agent Skills 规范规定：name 由小写字母、数字、连字符组成，
/// 不得有首尾或连续连字符，最长 64 字符；description 最长 1024 字符。
/// 无 description 的技能 Pi 不会加载（skills.md：declared skills without descriptions are not loaded）。
const NAME_MAX: usize = 64;
const DESC_MAX: usize = 1024;

#[derive(Clone, Serialize)]
pub struct SkillEntry {
    /// 技能名（`/skill:<name>` 里的部分）。
    pub name: String,
    pub description: String,
    /// 资源类别：skill（可加载说明）| prompt（提示模板）| extension（扩展命令）。
    pub kind: String,
    /// SKILL.md 或资源文件的绝对路径。
    pub path: String,
    /// 这条记录的来源：disk（本仓库扫描磁盘）| kernel（Pi 的 get_commands 回报）。
    pub via: String,
    /// 作用域：user（<agent-dir>）| project（项目 .pi）| package（随包分发）。
    pub scope: String,
    /// 这条技能是怎么进来的：local（本地路径导入）| url（远端链接下载）| kernel（内核自带）。
    pub origin: String,
}

#[derive(Clone, Serialize)]
pub struct SkillInstallResult {
    pub entry: SkillEntry,
    /// Pi 在启动时枚举技能目录，因此新装技能只有重启内核才生效。
    pub needs_restart: bool,
}

#[derive(Clone, Serialize)]
pub struct SkillUninstallResult {
    pub name: String,
    pub removed_path: String,
    /// 卸载后内核缓存里的技能列表会过期，同样需要重启。
    pub needs_restart: bool,
}

/// 解析 SKILL.md 的 frontmatter，返回 (name, description)。
///
/// 校验不通过即返回错误——Pi 会静默跳过畸形技能，把校验前移到安装期优于
/// 让用户以为「装了却没生效」。
pub fn parse_skill_md(text: &str) -> Result<(String, String), String> {
    let Some(body) = extract_front_matter(text) else {
        return Err("缺少 YAML frontmatter（首行需为 --- )".into());
    };
    let (mut name, mut description) = (None, None);
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('-') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim();
        let value = unquote(value.trim());
        if key == "name" && name.is_none() {
            name = Some(value);
        } else if key == "description" && description.is_none() {
            description = Some(value);
        }
    }
    let name = name.ok_or_else(|| "frontmatter 缺少 name 字段".to_string())?;
    if name.is_empty() {
        return Err("name 不能为空".into());
    }
    if name.len() > NAME_MAX {
        return Err(format!("name 超过 {NAME_MAX} 字符: {name}"));
    }
    if !is_valid_name(&name) {
        return Err(format!(
            "name 不合法: {name}（仅允许小写字母、数字、单连字符分隔，如 pdf-tools）"
        ));
    }
    let description = description.ok_or_else(|| {
        "frontmatter 缺少 description 字段；Pi 不会加载没有 description 的技能".to_string()
    })?;
    if description.len() > DESC_MAX {
        return Err(format!("description 超过 {DESC_MAX} 字符"));
    }
    if description.trim().is_empty() {
        return Err("description 不能为空".into());
    }
    Ok((name, description))
}

/// 技能名规则：`^[a-z0-9]+(-[a-z0-9]+)*$`。
fn is_valid_name(name: &str) -> bool {
    // 首尾/连续连字符都会被 split 成空段，因此一次遍历即可同时挡掉三类非法形态。
    name.split('-').all(|part| {
        !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
    })
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    if v.len() >= 2 && (v.starts_with('"') && v.ends_with('"') || v.starts_with('\'') && v.ends_with('\''))
    {
        return v[1..v.len() - 1].to_string();
    }
    v.to_string()
}

/// 抽出 `--- ... ---` 之间的内容；不是 frontmatter 则返回 None。
fn extract_front_matter(text: &str) -> Option<&str> {
    let mut lines = text.lines();
    let first = lines.next()?.trim();
    if first != "---" {
        return None;
    }
    let rest = text.split_once('\n')?.1;
    let end = rest.find("\n---")?;
    Some(&rest[..end])
}

/// 递归扫描技能目录，返回其中所有合法 SKILL.md 的描述。
/// Pi 也是递归发现（`Directories containing SKILL.md are discovered recursively`），
/// 因此这里与内核用同一套规则，避免本仓库看到的内核看不到。
pub fn scan_skills(dir: &Path, scope: &str) -> Vec<SkillEntry> {
    let Some(rd) = fs::read_dir(dir).ok() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.filter_map(|e| e.ok()) {
        let path = entry.path();
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let is_skill_file = name.eq_ignore_ascii_case("SKILL.md");
        if path.is_dir() {
            // 单文件技能（直接放 SKILL.md 在目录里）同样合法。
            let nested = path.join("SKILL.md");
            if nested.exists() || path.join("skill.md").exists() {
                if let Some(e) = load_skill(&nested, scope, "skill") {
                    out.push(e);
                }
            } else {
                out.extend(scan_skills(&path, scope));
            }
        } else if is_skill_file && path.is_file() {
            if let Some(e) = load_skill(&path, scope, "skill") {
                out.push(e);
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn load_skill(skill_md: &Path, scope: &str, kind: &str) -> Option<SkillEntry> {
    let text = fs::read_to_string(skill_md).ok()?;
    let (name, description) = parse_skill_md(&text).ok()?;
    Some(SkillEntry {
        name,
        description,
        kind: kind.into(),
        path: skill_md.to_string_lossy().into_owned(),
        via: "disk".into(),
        scope: scope.into(),
        // 磁盘上已有的技能无法追溯是本地导入还是远端下载，按「本地」归类。
        origin: "local".into(),
    })
}

fn agent_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| e.to_string())
}

/// 用户级技能目录：`<agent-dir>/skills`，Pi 默认从这里发现用户技能。
fn user_skills_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = agent_dir(app)?.join("skills");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 项目级技能目录：工作目录下的 `.pi/skills`。
fn project_skills_dir(root: &str) -> PathBuf {
    Path::new(root).join(".pi").join("skills")
}

/// 列出技能：磁盘扫描（<agent-dir>/skills 与项目 .pi/skills）为主，
/// 内核已启动时再用 `get_commands` 补上 Pi 自己回报的命令（含 prompt / extension 两类）。
///
/// **必须 `async`**：内部会向内核发 RPC 并阻塞等待响应，而非 async 的 Tauri 命令
/// 跑在主线程上——技能面板一打开就会把整个界面冻住最多 10 秒。
#[tauri::command(async)]
pub fn skills_list(
    app: AppHandle,
    root: Option<String>,
    state: State<PiState>,
) -> Result<Vec<SkillEntry>, String> {
    let mut entries = Vec::new();

    // 扫描位置以 capabilities.json 为准；清单缺失或字段缺失时退回 Pi 的约定位置。
    let manifest = CapabilityManifest::discover();
    let dirs = manifest
        .as_ref()
        .map(|m| m.skills.dirs.clone())
        .unwrap_or_default();
    for (dir, scope) in skill_dirs(&dirs) {
        let resolved = expand_dir(&dir, &app, root.as_deref());
        if let Some(dir) = resolved {
            entries.extend(scan_skills(&dir, scope));
        }
    }

    // 内核侧清单：能反映 extension/prompt/skill 三类以及 package 来源，
    // 是检验「磁盘装的和内核看到的是否一致」的唯一权威来源。
    let kernel = rpc_get_commands(&state);
    if let Ok(list) = &kernel {
        for c in list {
            let kind = match c.kind.as_str() {
                "extension" | "prompt" | "skill" => c.kind.clone(),
                other => other.to_string(),
            };
            entries.push(SkillEntry {
                name: c.name.clone(),
                description: c.description.clone(),
                kind,
                path: c.path.clone(),
                via: "kernel".into(),
                scope: c.scope.clone(),
                origin: "kernel".into(),
            });
        }
    }

    entries.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.name.cmp(&b.name)));
    Ok(entries)
}

/// 把清单里的目录声明解析成实际路径，并带上作用域标注。
/// `<agent-dir>` 展开为用户配置目录；`.pi/skills` 展开为当前项目的项目级目录；
/// 其余按绝对路径处理。
fn skill_dirs(dirs: &[String]) -> Vec<(PathBuf, &'static str)> {
    if dirs.is_empty() {
        return vec![(
            std::path::PathBuf::from("<agent-dir>/skills"),
            "user",
        )];
    }
    dirs.iter()
        .map(|d| {
            let (scope, path) = if d == "<agent-dir>/skills" || d == "<agent-dir>" {
                ("user", d.to_string())
            } else if d == ".pi/skills" {
                ("project", d.to_string())
            } else {
                ("package", d.to_string())
            };
            (std::path::PathBuf::from(path), scope)
        })
        .collect()
}

fn expand_dir(dir: &Path, app: &AppHandle, root: Option<&str>) -> Option<PathBuf> {
    if dir == Path::new("<agent-dir>/skills") {
        return user_skills_dir(app).ok();
    }
    if dir == Path::new(".pi/skills") {
        return root.map(|r| project_skills_dir(r));
    }
    if dir.is_absolute() {
        return Some(dir.to_path_buf());
    }
    root.map(|r| Path::new(r).join(dir))
}

struct KernelCommand {
    name: String,
    description: String,
    kind: String,
    path: String,
    scope: String,
}

/// 向已启动的内核问一次 `get_commands`。内核没起或命令失败都返回 None——
/// 磁盘清单本身 already 可用，不该因为内核离线就让整个面板空掉。
fn rpc_get_commands(state: &PiState) -> Result<Vec<KernelCommand>, String> {
    // pending 必须在 send 之前登记：读线程在收到响应时立刻消费 pending，
    // 先发命令再登记会漏掉这条响应。
    let (tx, rx) = std::sync::mpsc::channel();
    let id = {
        let mut seq = lock_seq(state);
        *seq += 1;
        format!("pi{seq}")
    };
    {
        let mut pending = state.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.insert(id.clone(), tx);
    }
    let stdin_tx = state.stdin_tx.lock().map_err(|e| e.to_string())?;
    let sender = stdin_tx.as_ref().ok_or_else(|| "pi 未启动".to_string())?;
    let req = serde_json::json!({"id": id, "type": "get_commands"});
    sender.send(req.to_string()).map_err(|e| e.to_string())?;
    let resp = rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "get_commands 超时".to_string())?;
    let data = ok_data(&resp)?;
    let arr = data
        .get("commands")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for item in arr {
        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let info = item.get("sourceInfo");
        out.push(KernelCommand {
            // 内核给技能名带 `skill:` 前缀，展示时还原成裸名，避免与磁盘清单重名重复。
            name: name.trim_start_matches("skill:").to_string(),
            description: item
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            kind: item
                .get("source")
                .and_then(|v| v.as_str())
                .unwrap_or("extension")
                .to_string(),
            path: info
                .and_then(|i| i.get("path"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            scope: info
                .and_then(|i| i.get("scope"))
                .and_then(|v| v.as_str())
                .unwrap_or("temporary")
                .to_string(),
        });
    }
    Ok(out)
}

/// 校验 → 选目录 → 落盘。本地导入与远端下载共用同一条落盘路径，
/// 保证「装的 wherever 规则」只有一份实现，不会出现两条链路装到不同地方。
///
/// `in_project_guess` 是来源推断（本地：文件是否在项目内；远端：恒为 false，
/// 远端内容不该因为 URL 长得像路径就落进项目）。`project_scope` 是用户的显式声明，优先。
fn land_skill(
    user_dir: &Path,
    text: &str,
    in_project_guess: bool,
    root: Option<&str>,
    project_scope: Option<bool>,
    origin: &str,
) -> Result<SkillInstallResult, String> {
    // 先校验后落盘：写出去再发现 frontmatter 畸形，用户只会得到「装了却没生效」。
    let (name, description) = parse_skill_md(text)?;
    let in_project = project_scope.unwrap_or(false) || in_project_guess;
    let target_dir = if in_project {
        project_skills_dir(root.unwrap_or_default())
    } else {
        user_dir.to_path_buf()
    };
    // 技能存放形态是 `<技能目录>/<name>/SKILL.md`，因此要连 `<name>` 这一层一起建；
    // 只建技能目录会让写入必然 ENOENT（本地导入与远端下载共用的这条路径）。
    let skill_dir = target_dir.join(&name);
    fs::create_dir_all(&skill_dir).map_err(|e| e.to_string())?;
    let target = skill_dir.join("SKILL.md");
    fs::write(&target, text).map_err(|e| e.to_string())?;

    Ok(SkillInstallResult {
        entry: SkillEntry {
            name,
            description,
            kind: "skill".into(),
            path: target.to_string_lossy().into_owned(),
            via: "disk".into(),
            scope: if in_project { "project".into() } else { "user".into() },
            origin: origin.into(),
        },
        needs_restart: true,
    })
}

/// 预检并安装一个技能：解析 SKILL.md → 校验 frontmatter → 落盘到对应技能目录。
///
/// `path` 可以是 SKILL.md 本身，也可以是包含 SKILL.md 的目录。
/// 目标位置沿用来源：来自项目 `.pi/skills` 的装到项目级，其余装到用户级。
#[tauri::command]
pub fn skills_install(
    app: AppHandle,
    path: String,
    root: Option<String>,
    project_scope: Option<bool>,
) -> Result<SkillInstallResult, String> {
    let source = Path::new(&path);
    if !source.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    let skill_md = if source.is_dir() {
        let candidate = source.join("SKILL.md");
        if candidate.exists() {
            candidate
        } else {
            return Err(format!("目录里没有 SKILL.md: {path}"));
        }
    } else {
        source.to_path_buf()
    };
    let text = fs::read_to_string(&skill_md).map_err(|e| format!("读取失败: {e}"))?;

    let root = root.filter(|r| !r.is_empty());
    // 显式声明优先；否则按来源推断（来自项目 .pi/skills 的留在项目级）。
    let in_project_guess = root
        .as_ref()
        .map(|r| {
            is_under(Path::new(r), &skill_md) || skill_md.starts_with(project_skills_dir(r))
        })
        .unwrap_or(false);
    let user_dir = user_skills_dir(&app)?;
    land_skill(
        &user_dir,
        &text,
        in_project_guess,
        root.as_deref(),
        project_scope,
        "local",
    )
}

/// 从远端链接安装技能：下载 → 校验 → 落盘到与本地安装相同的位置。
///
/// 这让「社区市场」变成一条真实可用的链路：任何能给出 SKILL.md 直链的来源
/// （raw 链接、自建市场、gist）都可直接安装，落盘位置与本地导入完全一致。
#[tauri::command]
pub async fn skills_install_from_url(
    app: AppHandle,
    url: String,
    root: Option<String>,
    project_scope: Option<bool>,
) -> Result<SkillInstallResult, String> {
    let url = require_http_url(&url)?;
    let text = fetch_text(&url).await?;
    let user_dir = user_skills_dir(&app)?;
    land_skill(
        &user_dir,
        &text,
        false,
        root.as_deref(),
        project_scope,
        "url",
    )
}

/// 判断 `child` 是否位于 `root` 之内（按路径前缀，不做符号链接解析）。
fn is_under(root: &Path, child: &Path) -> bool {
    child.starts_with(root)
}

/// 卸载目标：`<技能目录>/<name>/SKILL.md`，先项目级后用户级。
/// 顺序与 `skills_install` 的落盘位置一致——装到哪就卸到哪，不会卸错地方。
pub fn uninstall_target(name: &str, root: Option<&str>, user_dir: &Path) -> Option<PathBuf> {
    if name.trim().is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".."
    {
        return None;
    }
    let candidates = [
        root.map(|r| project_skills_dir(r).join(name).join("SKILL.md")),
        Some(user_dir.join(name).join("SKILL.md")),
    ];
    candidates.into_iter().flatten().find(|p| p.exists())
}

/// 卸载一个技能：删掉 `SKILL.md`，目录随之空掉时一并清理。
///
/// 只认本应用安装过的形态（`<技能目录>/<name>/SKILL.md`）：
/// 用户手工放在别处的技能直接拒绝，避免「一点卸载就把原有资产删了」。
#[tauri::command]
pub fn skills_uninstall(
    app: AppHandle,
    name: String,
    root: Option<String>,
) -> Result<SkillUninstallResult, String> {
    let user_dir = user_skills_dir(&app)?;
    let target = uninstall_target(name.trim(), root.as_deref(), &user_dir)
        .ok_or_else(|| "未找到该技能（仅卸载本应用安装过的技能）".to_string())?;

    fs::remove_file(&target).map_err(|e| format!("删除失败: {e}"))?;

    // 目录空了才删目录：里面还有用户自己的东西就留着。
    if let Some(dir) = target.parent() {
        if fs::read_dir(dir).is_ok_and(|mut rd| rd.next().is_none()) {
            let _ = fs::remove_dir(dir);
        }
    }

    Ok(SkillUninstallResult {
        name: name.trim().to_string(),
        removed_path: target.to_string_lossy().into_owned(),
        needs_restart: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = "\
---
name: pdf-tools
description: Extract text and tables from PDF files.
---

# PDF tools
";

    #[test]
    fn parses_valid_front_matter() {
        let (name, desc) = parse_skill_md(VALID).expect("合法技能应通过");
        assert_eq!(name, "pdf-tools");
        assert!(desc.starts_with("Extract"));
    }

    #[test]
    fn rejects_missing_front_matter() {
        assert!(parse_skill_md("# only markdown\n").is_err());
    }

    #[test]
    fn rejects_missing_description() {
        assert!(parse_skill_md("---\nname: x\n---\nbody\n").is_err());
    }

    #[test]
    fn rejects_uppercase_name() {
        let md = "---\nname: PDF-Tools\ndescription: d\n---\n";
        assert!(parse_skill_md(md).is_err());
    }

    #[test]
    fn rejects_leading_hyphen_and_consecutive_hyphens() {
        assert!(parse_skill_md("---\nname: -bad\ndescription: d\n---\n").is_err());
        assert!(parse_skill_md("---\nname: a--b\ndescription: d\n---\n").is_err());
    }

    #[test]
    fn accepts_multi_hyphen_names() {
        let md = "---\nname: pdf-extract-tables\ndescription: d\n---\n";
        assert_eq!(parse_skill_md(md).unwrap().0, "pdf-extract-tables");
    }

    #[test]
    fn rejects_overlong_name() {
        let long = "a".repeat(NAME_MAX + 1);
        let md = format!("---\nname: {long}\ndescription: d\n---\n");
        assert!(parse_skill_md(&md).is_err());
    }

    #[test]
    fn rejects_overlong_description() {
        let long = "d".repeat(DESC_MAX + 1);
        let md = format!("---\nname: oke\ndescription: {long}\n---\n");
        assert!(parse_skill_md(&md).is_err());
    }

    #[test]
    fn strips_quoted_values() {
        let md = "---\nname: \"quoted-name\"\ndescription: 'desc text'\n---\n";
        let (name, desc) = parse_skill_md(md).unwrap();
        assert_eq!(name, "quoted-name");
        assert_eq!(desc, "desc text");
    }

    #[test]
    fn scans_directory_for_skills() {
        let dir = std::env::temp_dir().join("piwb-skills-scan");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("first-skill")).unwrap();
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::create_dir_all(dir.join("nested/second-skill")).unwrap();
        fs::create_dir_all(dir.join("broken")).unwrap();
        fs::write(dir.join("first-skill/SKILL.md"), VALID).unwrap();
        fs::write(dir.join("nested/second-skill/SKILL.md"), VALID).unwrap();
        // 畸形技能应被跳过而不是让整个扫描失败
        fs::write(dir.join("broken/SKILL.md"), "---\nname: BAD\ndescription:\n---\n").unwrap();

        let found = scan_skills(&dir, "user");
        assert_eq!(found.len(), 2, "只应发现合法技能");
        assert!(found.iter().all(|e| e.kind == "skill"));
        assert!(found.iter().all(|e| e.via == "disk"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn uninstall_rejects_path_like_names() {
        let user = Path::new("/home/u/.pi/skills");
        assert!(uninstall_target("../etc/passwd", Some("/proj"), user).is_none());
        assert!(uninstall_target("a/b", Some("/proj"), user).is_none());
        assert!(uninstall_target("  ", Some("/proj"), user).is_none());
    }

    #[test]
    fn uninstall_prefers_project_scope_then_user_scope() {
        let user = std::env::temp_dir().join("piwb-uninstall-user");
        let _ = fs::remove_dir_all(&user);
        fs::create_dir_all(user.join("keep-me")).unwrap();
        fs::write(user.join("keep-me/SKILL.md"), VALID).unwrap();
        fs::create_dir_all(user.join("only-user")).unwrap();
        fs::write(user.join("only-user/SKILL.md"), VALID).unwrap();

        // 项目级同名优先
        // 项目级落盘位置与 skills_install 一致：`.pi/skills/<name>/SKILL.md`
        let proj = std::env::temp_dir().join("piwb-uninstall-proj");
        let _ = fs::remove_dir_all(&proj);
        let proj_skill = proj.join(".pi").join("skills").join("dup");
        fs::create_dir_all(&proj_skill).unwrap();
        fs::write(proj_skill.join("SKILL.md"), VALID).unwrap();

        let hit = uninstall_target("dup", Some(proj.to_str().unwrap()), &user).expect("应命中项目级");
        assert_eq!(hit, proj_skill.join("SKILL.md"));

        // 项目级没有时才落到用户级
        let hit = uninstall_target("only-user", Some(proj.to_str().unwrap()), &user).expect("应命中用户级");
        assert_eq!(hit, user.join("only-user/SKILL.md"));

        // 两者都没有 → None（调用方据此拒绝）
        assert!(uninstall_target("missing", Some(proj.to_str().unwrap()), &user).is_none());

        fs::remove_dir_all(&user).unwrap();
        fs::remove_dir_all(&proj).unwrap();
    }

    #[test]
    fn is_under_detects_prefix() {
        assert!(is_under(Path::new("/a/b"), Path::new("/a/b/c.md")));
        assert!(!is_under(Path::new("/a/b"), Path::new("/a/bc.md")));
    }

    // 远端地址校验的测试随实现一起迁到 net.rs（三处出网场景共用一套规则）。
    #[test]
    fn remote_install_falls_back_to_user_scope_when_project_root_absent() {
        let user = std::env::temp_dir().join("piwb-url-install-user");
        let _ = fs::remove_dir_all(&user);
        fs::create_dir_all(&user).unwrap();
        let proj = std::env::temp_dir().join("piwb-url-install-proj");
        let _ = fs::remove_dir_all(&proj);
        fs::create_dir_all(&proj).unwrap();

        // 显式要求项目级 → 装到项目 .pi/skills
        let r = land_skill(&user, VALID, true, Some(proj.to_str().unwrap()), Some(true), "url")
            .unwrap();
        assert_eq!(r.entry.scope, "project", "显式项目级优先");
        assert_eq!(r.entry.origin, "url", "来源需标记为远端安装");
        assert!(proj.join(".pi/skills/pdf-tools/SKILL.md").exists());

        // 未指定项目级、也没有 root → 落到用户级
        let r = land_skill(&user, VALID, false, None, None, "url").unwrap();
        assert_eq!(r.entry.scope, "user");
        assert!(user.join("pdf-tools/SKILL.md").exists());

        fs::remove_dir_all(&user).unwrap();
        fs::remove_dir_all(&proj).unwrap();
    }

    #[test]
    fn remote_install_rejects_malformed_skill_before_writing() {
        // 校验失败时不得落盘：畸形内容写出去只会得到「装了却没生效」
        let user = std::env::temp_dir().join("piwb-url-install-bad");
        let _ = fs::remove_dir_all(&user);
        fs::create_dir_all(&user).unwrap();
        // 目标目录存在也没关系：frontmatter 校验必须先于落盘
        let r = land_skill(&user, "# no frontmatter\n", false, None, None, "url");
        assert!(r.is_err());
        assert!(!user.join("pdf-tools").exists(), "校验不通过时不得落盘");
        fs::remove_dir_all(&user).unwrap();
    }
}
