use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::capabilities::CapabilityManifest;
use crate::net::{fetch_text, require_http_url};

/// 一个随内核加载的 Pi extension 的清单条目。
///
/// `enabled` 不是一份独立的开关状态，而是「它的工具是否落在 settings.json 的
/// `defaultTools` 里」——因此 UI 显示的启用态与内核实际行为一致，不会出现两处各说各话。
///
/// `loaded` 是另一层：扩展文件是否物理在 `extensions/` 目录里。pi 0.87.1 内核
/// **无条件自动加载 agent 目录下全部扩展**（`-ne` 也只关发现，传 `-e` 仍加载），
/// 所以「不加载某个扩展」的唯一诚实做法是把文件移出该目录——见 `extensions_set_enabled`。
#[derive(Debug, Clone, Serialize)]
pub struct ExtensionInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    /// tool（registerTool × N）或 command（registerCommand）。
    pub kind: String,
    pub path: String,
    pub tools: Vec<String>,
    pub enabled: bool,
    /// 扩展文件当前是否在加载目录（停用项在 extensions-disabled/）。
    pub loaded: bool,
    /// 是否可从本机删除（manifest 声明的默认扩展只读，只能停用不能删）。
    pub removable: bool,
}

/// 停用扩展的隔离目录：与 `extensions/` 同级，内核不会发现它。
fn disabled_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("extensions-disabled");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 头部注释里的 `@key: value` 行。
/// 用注释而不是单独的 manifest 文件，是为了让扩展自带说明，不必再维护一份会漂移的元数据。
fn header_field(header: &str, key: &str) -> Option<String> {
    let needle = format!("@{key}:");
    header
        .lines()
        .map(|line| line.trim().trim_start_matches('*').trim())
        .find(|line| line.starts_with(&needle))
        .and_then(|line| line.split_once(':'))
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 头注释里第一条散文（去掉 `*` 前缀），作为没有 `@description` 时的兜底。
fn header_summary(header: &str) -> Option<String> {
    header
        .lines()
        .skip(2)
        .map(|line| line.trim().trim_start_matches('*').trim())
        .find(|line| line.len() >= 8 && !line.starts_with('/') && !line.starts_with('@'))
        .map(|line| line.to_string())
}

/// 取某个 `callee(...)` 调用的全部实参文本（按括号配平切分），不引入正则依赖。
fn call_args(source: &str, callee: &str) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    let mut search = 0usize;
    while let Some(hit) = source[search..].find(callee) {
        let anchor = search + hit + callee.len();
        // 调用名是标识符，它左边的最后一次出现 '(' 才是这次调用的括号；
        // 直接向右找会命中实参内部的嵌套括号。
        let Some(open) = source[..anchor].rfind('(') else {
            break;
        };
        let mut i = open + 1;
        let mut depth = 1usize;
        while i < bytes.len() && depth > 0 {
            match bytes[i] {
                b'(' => depth += 1,
                b')' => depth -= 1,
                _ => {}
            }
            i += 1;
        }
        if depth == 0 {
            out.push(source[open + 1..i - 1].to_string());
        }
        // 跳过本次调用的实参：里面可能嵌套同名的其它调用。
        search = open + 1;
    }
    out
}

/// 实参里的第一个双引号字符串。
fn first_string(args: &str) -> Option<String> {
    let start = args.find('"')? + 1;
    let end = args[start..].find('"')? + start;
    Some(args[start..end].to_string())
}

/// 实参里的最后一个双引号字符串。
fn last_string(args: &str) -> Option<String> {
    let end = args.rfind('"')?;
    let start = args[..end].rfind('"')? + 1;
    Some(args[start..end].to_string())
}

/// 抓出扩展注册的工具名与命令名。
/// `registerTool` 单参：名称即工具名；`registerCommand` 双参：第二个实参才是命令名。
fn registered_names(source: &str) -> (Vec<String>, Vec<String>) {
    let mut tools: Vec<String> = Vec::new();
    let mut commands: Vec<String> = Vec::new();

    for args in call_args(source, "registerTool(") {
        if let Some(name) = first_string(&args) {
            if !tools.iter().any(|t| *t == name) {
                tools.push(name);
            }
        }
    }
    for args in call_args(source, "registerCommand(") {
        // 实参形如 `"tool", "cmd", {...}`：命令名是对象字面量之前最后一个干净字符串。
        let head = match args.find('{') {
            Some(idx) => &args[..idx],
            None => args.as_str(),
        };
        let found = last_string(head);
        if let Some(name) = found.filter(|_| commands.len() < 32) {
            if !commands.iter().any(|c| *c == name) {
                commands.push(name);
            }
        }
    }

    (tools, commands)
}

/// 从下载链接里取扩展文件名（`extensions/<name>.ts` 里的 `<name>`）。
///
/// 只取最后一个 `/` 之后的一段并剥掉查询串/锚点：这样 `../../evil.ts`
/// 里的路径穿越会被自然消解，落盘位置只由文件名决定。
fn extension_name_from_url(url: &str) -> Option<String> {
    let path = url.split_once('?').map(|(p, _)| p).unwrap_or(url);
    let path = path.split_once('#').map(|(p, _)| p).unwrap_or(path);
    let last = path.rsplit('/').next()?;
    let stem = last.strip_suffix(".ts")?;
    if stem.is_empty() || stem.len() > NAME_MAX {
        return None;
    }
    if !stem
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(stem.to_string())
}

/// 安全文件名上界：与技能名同量级，避免一个超长名字把目录结构搞乱。
const NAME_MAX: usize = 64;

fn is_enabled(tools: &[String], active: &[String]) -> bool {
    !tools.is_empty() && tools.iter().all(|t| active.iter().any(|a| a == t))
}

/// 扩展的持久化目录：放在 app_config_dir 下，dev/prod 一致且可写。
///
/// 安装扩展、同步默认扩展都落在这里，而不是可读的资源包或源码目录。
pub fn extensions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("extensions");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 默认扩展的候选来源目录：
///   1. 打包资源目录（prod）；
///   2. 源码树 src-tauri/extensions（dev，通过 CARGO_MANIFEST_DIR 定位）；
///   3. 当前可执行文件同级 extensions（向后兼容）。
fn extension_source_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(d) = app.path().resource_dir() {
        out.push(d.join("extensions"));
    }
    if let Ok(d) = std::env::var("CARGO_MANIFEST_DIR") {
        out.push(Path::new(&d).join("extensions"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(p) = exe.parent() {
            out.push(p.join("extensions"));
        }
    }
    out
}

/// 启动时把能力清单声明的默认扩展同步到持久化目录。
/// 只复制「目标不存在」的文件，避免覆盖用户已安装的同名扩展。
pub fn seed_defaults(app: &AppHandle) -> Result<(), String> {
    let Some(manifest) = CapabilityManifest::discover() else {
        return Ok(());
    };
    let target = extensions_dir(app)?;
    let sources = extension_source_dirs(app);
    // 用户停用（移入 extensions-disabled/）的默认扩展不能再被 seed 复制回来——
    // 否则「停用」在下次启动就失效，开关就是假的。
    let disabled = disabled_dir(app)?;

    for id in &manifest.extensions {
        if id.ends_with(".ts") && disabled.join(id).exists() {
            continue;
        }
        sync_default_file(&sources, id, &target)?;
    }
    Ok(())
}

/// 从候选源目录找一个扩展文件，复制到目标目录（目标缺失时；或源更新时覆盖）。
///
/// 内核会自动加载目标目录（= agent 目录）下的全部扩展，`--extension` 无法覆盖它们
/// （同名工具双注册会启动即崩），所以 dev 期对源码扩展的修改**只能靠这里的同步**
/// 生效：目标存在但源文件 mtime 更新时覆盖写入。
fn sync_default_file(sources: &[PathBuf], id: &str, target: &Path) -> Result<(), String> {
    let dest = target.join(id);
    for src in sources {
        let candidate = src.join(id);
        if !candidate.exists() {
            continue;
        }
        if dest.exists() {
            let dest_time = fs::metadata(&dest).and_then(|m| m.modified()).ok();
            let src_time = fs::metadata(&candidate).and_then(|m| m.modified()).ok();
            // 目标不比源旧（含两者都取不到 mtime 的保守情形）：无需同步。
            match (dest_time, src_time) {
                (Some(d), Some(s)) if d >= s => return Ok(()),
                _ => {}
            }
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(&candidate, &dest).map_err(|e| format!("复制默认扩展 {} 失败: {}", id, e))?;
        return Ok(());
    }
    Ok(())
}

/// 清单 id 的唯一真源：manifest 声明项 ∪ 加载目录实际文件 ∪ 停用目录实际文件。
///
/// 原先只列 manifest，导致「从链接安装」的扩展落盘后永远不进 UI（真 bug）——
/// 装完返回找不到就报「读取失败」，但文件其实在。这里改成联合，加载态由文件位置判定。
fn extension_ids(app: &AppHandle) -> Vec<String> {
    let declared = CapabilityManifest::discover()
        .map(|m| m.extensions)
        .unwrap_or_default();
    collect_ids(
        &declared,
        &[extensions_dir(app), disabled_dir(app)].into_iter().flatten().collect::<Vec<_>>(),
    )
}

/// 纯函数：声明项 ∪ 各目录实际 `.ts` 文件，去重排序。与文件 IO/AppHandle 解耦，便于单测。
fn collect_ids(declared: &[String], dirs: &[PathBuf]) -> Vec<String> {
    let mut out = declared.to_vec();
    for dir in dirs {
        if let Ok(entries) = fs::read_dir(dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.ends_with(".ts") && !out.contains(&name) {
                    out.push(name);
                }
            }
        }
    }
    out.sort();
    out
}

/// 扫描能力清单声明的 extension + 目录里实际落盘的扩展，产出前端可直接渲染的清单。
///
/// 文件不可读时退化为占位条目，让 UI 能明确显示「声明了但读不到」而不是静默消失。
pub fn list(app: &AppHandle) -> Vec<ExtensionInfo> {
    let ids = extension_ids(app);
    let dir = match extensions_dir(app) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let disabled = disabled_dir(app).unwrap_or_else(|_| dir.clone());
    let active = crate::tools::active_tools(app);
    let declared = CapabilityManifest::discover()
        .map(|m| m.extensions)
        .unwrap_or_default();

    ids.into_iter()
        .map(|id| {
            let path = dir.join(&id);
            let loaded = path.exists() && path.is_file();
            let source = if loaded {
                &path
            } else {
                &disabled.join(&id)
            };
            match std::fs::read_to_string(source) {
                Ok(text) => {
                    let header = text.splitn(2, "*/").next().unwrap_or("").to_string();
                    let (tools, commands) = registered_names(&text);
                    let name = header_field(&header, "name")
                        .or_else(|| header_summary(&header))
                        .unwrap_or_else(|| {
                            id.trim_end_matches(".ts")
                                .split('-')
                                .map(|part| {
                                    let mut chars = part.chars();
                                    chars
                                        .next()
                                        .map(|c| {
                                            c.to_uppercase().collect::<String>() + chars.as_str()
                                        })
                                        .unwrap_or_default()
                                })
                                .collect::<Vec<String>>()
                                .join(" ")
                        });
                    let description = header_field(&header, "description")
                        .or_else(|| header_summary(&header))
                        .unwrap_or_else(|| "未提供说明".into());
                    let bound: Vec<String> = if tools.is_empty() {
                        commands.clone()
                    } else {
                        tools.clone()
                    };
                    ExtensionInfo {
                        id: id.clone(),
                        name,
                        description,
                        kind: if tools.is_empty() { "command" } else { "tool" }.to_string(),
                        path: source.to_string_lossy().into_owned(),
                        tools: bound,
                        enabled: loaded && is_enabled(&tools, &active),
                        loaded,
                        removable: !declared.contains(&id),
                    }
                }
                Err(_) => ExtensionInfo {
                    id: id.clone(),
                    name: id.clone(),
                    description: "未提供（扩展文件不可读）".into(),
                    kind: "unknown".into(),
                    path: source.to_string_lossy().into_owned(),
                    tools: Vec::new(),
                    enabled: false,
                    loaded,
                    removable: !declared.contains(&id),
                },
            }
        })
        .collect()
}

#[tauri::command(async)]
pub fn extensions_list(app: AppHandle) -> Vec<ExtensionInfo> {
    list(&app)
}

/// 从远端链接装一个扩展：下载 → 落盘到 `extensions/<name>.ts`。
///
/// 落盘后重新扫一遍清单再返回， caller 拿到的是真实结果而不是「我以为装好了」；
/// 扫不到就说明写坏了，直接报错。扩展目录里的文件会被内核加载执行，
/// 因此这里对文件名做了白名单，而不是把链接原样当路径用。
#[tauri::command]
pub async fn extensions_install_from_url(
    app: AppHandle,
    url: String,
) -> Result<ExtensionInfo, String> {
    let url = require_http_url(&url)?;
    let name = extension_name_from_url(&url)
        .ok_or_else(|| "链接需指向一个 .ts 扩展文件，例如 https://…/role-inject.ts".to_string())?;
    let text = fetch_text(&url).await?;

    let dir = extensions_dir(&app)?;
    let target = dir.join(format!("{name}.ts"));
    fs::write(&target, text).map_err(|e| e.to_string())?;

    list(&app)
        .into_iter()
        .find(|e| e.id == format!("{name}.ts"))
        .ok_or_else(|| "扩展已落盘但读取失败，请检查文件是否完整".to_string())
}

/// 加载开关：把 `.ts` 文件在 `extensions/` 与 `extensions-disabled/` 之间搬运。
///
/// 不写 settings.json 的负项（pi 0.87.1 不认这一版语法），也不留副账——文件位置本身就是状态。
/// 内核下次启动才看到变更，返回最新清单让 UI 立即收敛。
#[tauri::command(async)]
pub fn extensions_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<Vec<ExtensionInfo>, String> {
    if !id.ends_with(".ts") || id.contains('/') || id.contains('\\') || id.len() > NAME_MAX + 3 {
        return Err("扩展 id 非法".into());
    }
    let on = extensions_dir(&app)?;
    let off = disabled_dir(&app)?;
    let (from, to) = if enabled { (&off, &on) } else { (&on, &off) };
    let src = from.join(&id);
    if !src.is_file() {
        // 目标态已成立（重复点击/外部已改动）→ 幂等返回，不报错。
        if to.join(&id).is_file() {
            return Ok(list(&app));
        }
        return Err(format!("扩展文件不存在: {id}"));
    }
    fs::rename(&src, to.join(&id)).map_err(|e| format!("切换扩展状态失败: {e}"))?;
    Ok(list(&app))
}

/// 卸载：删除已安装扩展的文件。manifest 声明的默认扩展只读（只能停用），防止
/// seed_defaults 下次启动又复制回来造成「删了又出现」的假象。
#[tauri::command(async)]
pub fn extensions_remove(app: AppHandle, id: String) -> Result<Vec<ExtensionInfo>, String> {
    if !id.ends_with(".ts") || id.contains('/') || id.contains('\\') || id.len() > NAME_MAX + 3 {
        return Err("扩展 id 非法".into());
    }
    let declared = CapabilityManifest::discover()
        .map(|m| m.extensions)
        .unwrap_or_default();
    if declared.contains(&id) {
        return Err("内置扩展不能删除，只能停用".into());
    }
    let on = extensions_dir(&app)?;
    let off = disabled_dir(&app)?;
    let mut removed = false;
    for dir in [&on, &off] {
        let path = dir.join(&id);
        if path.is_file() {
            fs::remove_file(&path).map_err(|e| format!("删除扩展失败: {e}"))?;
            removed = true;
        }
    }
    if !removed {
        return Err(format!("扩展不存在: {id}"));
    }
    Ok(list(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = r#"/**
 * @name: 代码检索
 * @description: 在仓库里做结构化检索
 */
registerTool("search_symbols", "列出符号", { async handler() {} });
registerTool("search_text", "全文检索", { async handler() {} });
registerCommand("search", "find", {});
"#;

    #[test]
    fn collect_ids_unions_declared_and_disk_files() {
        let tmp = std::env::temp_dir().join(format!("pw-ext-ids-{}", std::process::id()));
        let on = tmp.join("on");
        let off = tmp.join("off");
        fs::create_dir_all(&on).unwrap();
        fs::create_dir_all(&off).unwrap();
        fs::write(on.join("from-url.ts"), "// x").unwrap();
        fs::write(off.join("disabled.ts"), "// x").unwrap();
        fs::write(on.join("notes.txt"), "// not an extension").unwrap();

        let declared = vec!["builtin.ts".to_string(), "from-url.ts".to_string()];
        let ids = collect_ids(&declared, &[on.clone(), off.clone()]);
        assert_eq!(
            ids,
            vec![
                "builtin.ts".to_string(),
                "disabled.ts".to_string(),
                "from-url.ts".to_string(),
            ],
            "声明项 ∪ 两目录 .ts 文件，去重排序，非 .ts 不进清单"
        );
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn extension_id_validates_path_traversal() {
        let valid = |id: &str| {
            id.ends_with(".ts")
                && !id.contains('/')
                && !id.contains('\\')
                && id.len() <= NAME_MAX + 3
        };
        assert!(valid("my-ext.ts"));
        assert!(!valid("../../evil.ts"));
        assert!(!valid("sub/ext.ts"));
        assert!(!valid("notes.txt"));
    }

    #[test]
    fn reads_tool_and_command_names() {
        let (tools, commands) = registered_names(SOURCE);
        assert_eq!(tools, vec!["search_symbols", "search_text"]);
        assert_eq!(commands, vec!["find"]);
    }

    #[test]
    fn call_args_respects_nested_parens() {
        let args = call_args("f(a(b, c), d)", "f(");
        assert_eq!(args, vec!["a(b, c), d"]);
        assert!(call_args("no-hit", "missing(").is_empty());
    }

    #[test]
    fn reads_header_fields() {
        let header = SOURCE.splitn(2, "*/").next().unwrap_or("");
        assert_eq!(
            header_field(header, "name"),
            Some("代码检索".to_string()),
            "@name 必须被解析出来"
        );
        assert_eq!(
            header_field(header, "description"),
            Some("在仓库里做结构化检索".to_string())
        );
        assert_eq!(header_field(header, "missing"), None);
    }

    #[test]
    fn extension_name_from_url_ignores_query_and_directory() {
        assert_eq!(
            extension_name_from_url("https://x.com/exts/role-inject.ts?raw=1"),
            Some("role-inject".into())
        );
        assert_eq!(
            extension_name_from_url("https://x.com/exts/role-inject.ts#top"),
            Some("role-inject".into())
        );
        assert_eq!(
            extension_name_from_url("https://x.com/exts/my_ext2.ts"),
            Some("my_ext2".into())
        );
    }

    #[test]
    fn extension_name_from_url_rejects_unsafe_targets() {
        // 非 ts / 目录 / 空名 / 非法字符 / 超长
        assert_eq!(extension_name_from_url("https://x.com/a.js"), None);
        assert_eq!(extension_name_from_url("https://x.com/dir/"), None);
        assert_eq!(extension_name_from_url("https://x.com/.ts"), None);
        assert_eq!(extension_name_from_url("https://x.com/my ext.ts"), None);
        assert_eq!(
            extension_name_from_url("https://x.com/a..ts"),
            None,
            "名字非法即拒绝，不做转义猜测"
        );
        let long = "a".repeat(NAME_MAX + 1);
        assert_eq!(
            extension_name_from_url(&format!("https://x.com/{long}.ts")),
            None
        );
    }

    #[test]
    fn enabled_requires_every_tool_present() {
        assert!(is_enabled(
            &["a".into(), "b".into()],
            &["a".into(), "b".into(), "c".into()]
        ));
        assert!(!is_enabled(&["a".into(), "b".into()], &["a".into()]));
        assert!(!is_enabled(&[], &["a".into()]));
    }

    #[test]
    fn sync_default_file_copies_when_missing() {
        let tmp = std::env::temp_dir().join(format!("piwb-ext-sync-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("src");
        let dst = tmp.join("dst");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("role-inject.ts"), "// test").unwrap();

        // 第一次复制成功
        sync_default_file(&[src.clone()], "role-inject.ts", &dst).unwrap();
        assert!(dst.join("role-inject.ts").exists());
        assert_eq!(
            std::fs::read_to_string(dst.join("role-inject.ts")).unwrap(),
            "// test"
        );

        // 源被改写（mtime 同秒内不保证更旧）→ 再同步按 mtime 判断；
        // mtime 相同（d >= s）时保持目标不动，避免无谓重写。
        // mtime 前移时才覆盖 —— 该路径由 sync_default_file_refreshes_stale_dest 覆盖。
        std::fs::write(src.join("role-inject.ts"), "// changed").unwrap();
        sync_default_file(&[src], "role-inject.ts", &dst).unwrap();
        let dest_content = std::fs::read_to_string(dst.join("role-inject.ts")).unwrap();
        assert!(
            dest_content == "// test" || dest_content == "// changed",
            "目标内容必须是两个已知版本之一，不应损坏"
        );

        std::fs::remove_dir_all(&tmp).ok();
    }

    /// 回归：内核自动加载 agent 目录扩展、`--extension` 不能覆盖同名工具，
    /// 所以 dev 期源码扩展的修改只能靠 sync_default_file 的 mtime 刷新落进 agent 目录。
    #[test]
    fn sync_default_file_refreshes_stale_dest() {
        let tmp = std::env::temp_dir().join(format!("pw-sync-refresh-{}", std::process::id()));
        let src = tmp.join("src");
        let dst = tmp.join("dst");
        std::fs::create_dir_all(&src).ok();
        std::fs::create_dir_all(&dst).ok();

        std::fs::write(src.join("agent-memory.ts"), "// v1").unwrap();
        let sources = vec![src.clone()];

        // 首次：目标缺失 → 复制
        sync_default_file(&sources, "agent-memory.ts", &dst).unwrap();
        assert_eq!(
            std::fs::read_to_string(dst.join("agent-memory.ts")).unwrap(),
            "// v1"
        );

        // 源更新（内容变更 + mtime 前移）→ 再次同步必须覆盖，否则 dev 改动永远不生效
        std::fs::write(src.join("agent-memory.ts"), "// v2").unwrap();
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(src.join("agent-memory.ts"))
            .unwrap()
            .set_modified(future)
            .unwrap();
        sync_default_file(&sources, "agent-memory.ts", &dst).unwrap();
        assert_eq!(
            std::fs::read_to_string(dst.join("agent-memory.ts")).unwrap(),
            "// v2",
            "源更新后目标必须被刷新"
        );

        // 目标比源新（不会被旧源回滚）
        std::fs::write(src.join("agent-memory.ts"), "// v0").unwrap();
        sync_default_file(&sources, "agent-memory.ts", &dst).unwrap();
        assert_eq!(
            std::fs::read_to_string(dst.join("agent-memory.ts")).unwrap(),
            "// v2",
            "更旧源不得覆盖新目标"
        );

        std::fs::remove_dir_all(&tmp).ok();
    }
}
