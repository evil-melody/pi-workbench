//! Pi 托管包透传（#96）。
//!
//! 原则：**复用，不重建**。安装/卸载/更新的源语法、落盘位置、settings.json
//! 持久化全部由 `pi` CLI 自己完成，这里只负责起子进程并原样转发；
//! 本模块不解析 `npm:` / `git:` / 本地路径的语义。
//!
//! 与内核共用同一份配置目录：`PI_CODING_AGENT_DIR` 注入 `app_config_dir`，
//! 和 `pi_bridge::pi_start` 保持同源，CLI 装完内核重启即可见。
//!
//! 唯一保留的校验是防选项注入：source 以 `-` 开头或含控制字符直接拒绝
//! （`pi install --evil-flag` 会被 pi 当成参数而不是源）。

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// 一个已安装的托管包条目，来自 `pi list` 的输出解析。
#[derive(Debug, Clone, Serialize)]
pub struct PkgEntry {
    /// pi 眼中的源（npm:@scope/pkg、github.com/user/repo、./local 等），原样回显。
    pub source: String,
    /// 落盘位置（`pi list` 第二行缩进路径）；未装成功时为空串。
    pub installed_path: String,
    /// user / project（`pi list` 的分段标题）。
    pub scope: String,
}

/// 一个可更新项（#96 更新检测）。
///
/// 检测走平台标准工具而非复制 pi 私有逻辑：npm 比 `package.json` 版本与
/// `npm view <name> version`；git 比本地 HEAD 与该检出 upstream 分支的
/// `git ls-remote` 远端头。git 的「跟踪哪条远端分支」由检出自身的 config 决定，
/// 我们不猜 pi 的 host 归一化与 ref 规则。
#[derive(Debug, Clone, Serialize)]
pub struct PkgUpdateInfo {
    pub source: String,
    pub kind: String,
    pub current: String,
    pub latest: String,
}

/// 去 ANSI 转义序列（chalk 在非 TTY 下一般自动关闭，这里是二道保险）。
fn strip_ansi(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            // ESC [ … final(0x40-0x7E)；ESC 单字符也按序列吃掉。
            i += 1;
            if i < bytes.len() && bytes[i] == b'[' {
                i += 1;
                while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                    i += 1;
                }
            }
            if i < bytes.len() {
                i += 1;
            }
            continue;
        }
        // 按 UTF-8 边界回退：s 是 str，直接取字节切片可能切断多字节字符，
        // 用 from_utf8 安全解码当前字节。
        let start = i;
        while i < bytes.len() && bytes[i] != 0x1b {
            i += 1;
        }
        if let Ok(chunk) = std::str::from_utf8(&bytes[start..i]) {
            out.push_str(chunk);
        }
    }
    out
}

/// 源字符串的最小防线：非空、无控制字符、不以 `-` 开头（防选项注入）。
fn validate_source(source: &str) -> Result<&str, String> {
    let s = source.trim();
    if s.is_empty() {
        return Err("安装源不能为空".into());
    }
    if s.len() > 512 {
        return Err("安装源过长".into());
    }
    if s.starts_with('-') {
        return Err("安装源不能以 - 开头（会被 Pi 当成命令行参数）".into());
    }
    if s.chars().any(|c| c.is_control()) {
        return Err("安装源含控制字符".into());
    }
    Ok(s)
}

/// 解析 pi 可执行文件并产出（bin 路径, 合并 PATH）——run_pi 与更新检测共用。
fn resolve_bin_and_path(app: &AppHandle) -> Result<(std::path::PathBuf, String), String> {
    let bin = crate::pi_bridge::resolve_pi_bin(app)?;
    let bin_dir = bin
        .path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::path::PathBuf::from("/usr/bin"));
    let path_env = crate::pi_bridge::pi_path_env(&bin_dir);
    Ok((bin.path, path_env))
}

/// 起一个 pi 子命令并等待退出。stdin 必须置空：交互式 pi 读 stdin 会挂起。
/// 超时看门狗杀进程，避免网络挂死时永久占用。
fn run_pi(
    app: &AppHandle,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let (bin_path, path_env) = resolve_bin_and_path(app)?;
    let agent_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("取配置目录失败: {e}"))?;
    let mut child = Command::new(&bin_path)
        .args(args)
        .env("PI_CODING_AGENT_DIR", &agent_dir)
        .env("PATH", path_env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 pi 失败: {e}"))?;
    let deadline = std::time::Instant::now() + timeout;
    let out = loop {
        match child.try_wait() {
            Ok(Some(_)) => break child.wait_with_output(),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("pi {} 超时（{}s）", args[0], timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待 pi 进程失败: {e}")),
        }
    };
    let out = out.map_err(|e| format!("读取 pi 输出失败: {e}"))?;
    let stdout = strip_ansi(&String::from_utf8_lossy(&out.stdout));
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = strip_ansi(&String::from_utf8_lossy(&out.stderr));
    let tail: Vec<&str> = stderr
        .lines()
        .filter(|l| !l.trim().is_empty())
        .rev()
        .take(3)
        .collect();
    let msg = if tail.is_empty() { stdout } else { tail.join("\n") };
    Err(format!("pi {} 失败: {}", args.join(" "), msg))
}

/// 跑外部工具（npm / git）做更新检测；失败返回 Err 由调用方降级跳过。
/// `path` 传入合并后的 PATH：GUI 进程那份缺 Node 目录，裸 `npm` 会 spawn 失败。
fn run_tool(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    path: Option<&str>,
    timeout: Duration,
) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(p) = path {
        cmd.env("PATH", p);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd.spawn().map_err(|e| format!("启动 {program} 失败: {e}"))?;
    let deadline = std::time::Instant::now() + timeout;
    let out = loop {
        match child.try_wait() {
            Ok(Some(_)) => break child.wait_with_output(),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{program} 超时"));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("等待 {program} 失败: {e}")),
        }
    };
    let out = out.map_err(|e| format!("读取 {program} 输出失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{program} 退出码非零: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// 解析 `pi list` 输出为托管包条目。纯函数，便于单测。
///
/// 格式（pi 0.87.x 的 package-manager-cli）：
///   `User packages:` / `Project packages:` 分段标题；
///   包行缩进两格（`(filtered)` 后缀照抄）；路径行缩进四格跟在包行后。
fn parse_pkg_list(text: &str) -> Vec<PkgEntry> {
    let mut out: Vec<PkgEntry> = Vec::new();
    let mut scope = String::new();
    let mut pending: Option<PkgEntry> = None;
    for raw in text.lines() {
        let line = strip_ansi(raw);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.eq_ignore_ascii_case("user packages:") {
            scope = "user".into();
            continue;
        }
        if trimmed.eq_ignore_ascii_case("project packages:") {
            scope = "project".into();
            continue;
        }
        // 空清单提示行不是包（`pi list` 在无包时打印这一行）。
        if trimmed.eq_ignore_ascii_case("no packages installed.") {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent <= 2 {
            // 包行：先结算上一条未闭合的路径
            if let Some(prev) = pending.take() {
                out.push(prev);
            }
            let source = trimmed
                .strip_suffix(" (filtered)")
                .unwrap_or(trimmed)
                .to_string();
            pending = Some(PkgEntry {
                source,
                installed_path: String::new(),
                scope: scope.clone(),
            });
        } else if let Some(entry) = pending.as_mut() {
            if entry.installed_path.is_empty() {
                entry.installed_path = trimmed.to_string();
            }
        }
    }
    if let Some(prev) = pending.take() {
        out.push(prev);
    }
    out
}

/// npm 源里的包名（去掉 `npm:` 前缀与可选版本后缀）。纯函数，便于单测。
/// 只用于 `npm view <name>`；安装语义仍由 pi 自己解析。
fn npm_package_name(source: &str) -> Option<String> {
    let rest = source.strip_prefix("npm:")?;
    // scoped: @scope/name[@version] → 从第二个 @ 起才是版本
    let cut = if let Some(body) = rest.strip_prefix('@') {
        body.find('@').map(|i| 1 + i)
    } else {
        rest.find('@')
    };
    Some(cut.map(|i| rest[..i].to_string()).unwrap_or_else(|| rest.to_string()))
}

/// git 检出是否落后于其自身 config 声明的 upstream（平台标准语义，零 pi 逻辑）。
/// 返回 (本地短哈希, 远端短哈希)；无 upstream config / 已是最新 / 查询失败返回 None。
fn git_behind_info(path: &Path, tool_path: &str) -> Option<(String, String)> {
    // `origin/main` → 远端名 `origin` + 分支 `main`（ls-remote 的 refspec 不带远端前缀）。
    let upstream = run_tool(
        "git",
        &["rev-parse", "--abbrev-ref", "@{upstream}"],
        Some(path),
        Some(tool_path),
        Duration::from_secs(10),
    )
    .ok()?;
    let (remote, branch) = upstream.split_once('/')?;
    let remote_sha = run_tool(
        "git",
        &["ls-remote", remote, branch],
        Some(path),
        Some(tool_path),
        Duration::from_secs(20),
    )
    .ok()?;
    let latest = remote_sha.split_whitespace().next()?.to_string();
    let local = run_tool(
        "git",
        &["rev-parse", "HEAD"],
        Some(path),
        Some(tool_path),
        Duration::from_secs(10),
    )
    .ok()?;
    if local == latest {
        return None;
    }
    Some((local.chars().take(7).collect(), latest.chars().take(7).collect()))
}

#[tauri::command(async)]
pub fn pi_pkg_list(app: AppHandle) -> Result<Vec<PkgEntry>, String> {
    let text = run_pi(&app, &["list"], Duration::from_secs(60))?;
    Ok(parse_pkg_list(&text))
}

#[tauri::command(async)]
pub fn pi_pkg_install(app: AppHandle, source: String) -> Result<String, String> {
    let source = validate_source(&source)?.to_string();
    // 180s：npm 拉依赖 / git clone 都可能慢，透传命令给足预算。
    let text = run_pi(&app, &["install", &source], Duration::from_secs(180))?;
    Ok(text.trim().to_string())
}

#[tauri::command(async)]
pub fn pi_pkg_remove(app: AppHandle, source: String) -> Result<String, String> {
    let source = validate_source(&source)?.to_string();
    let text = run_pi(&app, &["remove", &source], Duration::from_secs(60))?;
    Ok(text.trim().to_string())
}

/// 全量更新托管包（`pi update --extensions`）。
#[tauri::command(async)]
pub fn pi_pkg_update_all(app: AppHandle) -> Result<String, String> {
    let text = run_pi(&app, &["update", "--extensions"], Duration::from_secs(180))?;
    Ok(text.trim().to_string())
}

/// 单包更新（`pi update --extension <source>`）。
#[tauri::command(async)]
pub fn pi_pkg_update_one(app: AppHandle, source: String) -> Result<String, String> {
    let source = validate_source(&source)?.to_string();
    let text = run_pi(
        &app,
        &["update", "--extension", &source],
        Duration::from_secs(180),
    )?;
    Ok(text.trim().to_string())
}

/// 更新检测：npm 读已装 package.json + `npm view`；git 比 upstream 远端头。
/// 检测失败的单项静默跳过（离线 / 无网络权限时不让整页报错）。
#[tauri::command(async)]
pub fn pi_pkg_check_updates(app: AppHandle) -> Result<Vec<PkgUpdateInfo>, String> {
    let pkgs = pi_pkg_list_sync(&app)?;
    // npm/git 与 pi 共用同一份合并 PATH（GUI 进程那份缺 Node 目录）。
    let (_, tool_path) = resolve_bin_and_path(&app)?;
    let mut out = Vec::new();
    for pkg in pkgs {
        if pkg.installed_path.is_empty() {
            continue;
        }
        if let Some(name) = npm_package_name(&pkg.source) {
            let current = std::fs::read_to_string(Path::new(&pkg.installed_path).join("package.json"))
                .ok()
                .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(str::to_string))
                .unwrap_or_default();
            let Ok(latest) = run_tool(
                "npm",
                &["view", &name, "version"],
                None,
                Some(&tool_path),
                Duration::from_secs(30),
            )
            else {
                continue;
            };
            if !current.is_empty() && current != latest {
                out.push(PkgUpdateInfo {
                    source: pkg.source.clone(),
                    kind: "npm".into(),
                    current,
                    latest,
                });
            }
        } else if let Some((local, latest)) =
            git_behind_info(Path::new(&pkg.installed_path), &tool_path)
        {
            out.push(PkgUpdateInfo {
                source: pkg.source.clone(),
                kind: "git".into(),
                current: local,
                latest,
            });
        }
    }
    Ok(out)
}

/// `pi_pkg_check_updates` 的实现体（命令函数带 AppHandle 注入不便内部复用）。
fn pi_pkg_list_sync(app: &AppHandle) -> Result<Vec<PkgEntry>, String> {
    let text = run_pi(app, &["list"], Duration::from_secs(60))?;
    Ok(parse_pkg_list(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_sequences() {
        assert_eq!(strip_ansi("\x1b[1mUser packages:\x1b[0m"), "User packages:");
        assert_eq!(strip_ansi("npm:@foo/bar\x1b[2m  /path\x1b[0m"), "npm:@foo/bar  /path");
        assert_eq!(strip_ansi("plain 中文"), "plain 中文");
    }

    #[test]
    fn validates_source_against_option_injection() {
        assert!(validate_source("npm:@earendil-works/pi-web-access").is_ok());
        assert!(validate_source("./local-ext").is_ok());
        assert!(validate_source("github.com/user/repo").is_ok());
        assert_eq!(validate_source("  ").unwrap_err(), "安装源不能为空");
        assert!(validate_source("--evil").unwrap_err().contains("- 开头"));
        assert!(validate_source("a\nb").unwrap_err().contains("控制字符"));
        assert!(validate_source(&"x".repeat(600)).unwrap_err().contains("过长"));
    }

    #[test]
    fn parses_list_sections() {
        let text = "\
User packages:
  npm:@earendil-works/pi-web-access
    /Users/x/Library/Application Support/com.piworkbench.app/npm/node_modules/@earendil-works/pi-web-access
  github.com/anthropics/skills
    /Users/x/Library/Application Support/com.piworkbench.app/git/github.com/anthropics/skills

Project packages:
  ./local-ext (filtered)
";
        let pkgs = parse_pkg_list(text);
        assert_eq!(pkgs.len(), 3);
        assert_eq!(pkgs[0].source, "npm:@earendil-works/pi-web-access");
        assert_eq!(pkgs[0].scope, "user");
        assert!(pkgs[0].installed_path.ends_with("pi-web-access"));
        assert_eq!(pkgs[1].source, "github.com/anthropics/skills");
        assert_eq!(pkgs[2].source, "./local-ext");
        assert_eq!(pkgs[2].scope, "project");
        assert_eq!(pkgs[2].installed_path, "", "filtered 项没有路径行");
    }

    #[test]
    fn parses_empty_list() {
        assert!(parse_pkg_list("No packages installed.").is_empty());
        assert!(parse_pkg_list("").is_empty());
    }

    #[test]
    fn extracts_npm_package_names() {
        assert_eq!(
            npm_package_name("npm:@scope/pkg"),
            Some("@scope/pkg".into())
        );
        assert_eq!(
            npm_package_name("npm:@scope/pkg@1.2.3"),
            Some("@scope/pkg".into())
        );
        assert_eq!(npm_package_name("npm:plain"), Some("plain".into()));
        assert_eq!(npm_package_name("npm:plain@^2.0.0"), Some("plain".into()));
        assert_eq!(npm_package_name("github.com/u/r"), None);
        assert_eq!(npm_package_name("./local"), None);
    }
}
