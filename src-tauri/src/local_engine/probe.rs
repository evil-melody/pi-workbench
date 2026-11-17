//! 探测本机已有的 llama-server。
//!
//! P1 不下载、不打包引擎：只认用户机器上已经存在的可执行文件。
//! 必须区分三种状态：没装、装了能跑、装了跑不起来（附可读原因）。

use serde::Serialize;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Default)]
pub struct ProbeReport {
    pub found: bool,
    pub usable: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// 找到但跑不起来时的可读原因；未找到时也给一句可执行的下一步。
    pub reason: Option<String>,
    /// 实际检查过的候选路径数量，便于用户判断是不是没找对位置。
    pub checked: usize,
    pub checked_at: u64,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 按优先级收集候选：显式环境变量 → PATH → 常见安装位置 → LM Studio 内置后端。
pub fn candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    if let Some(p) = std::env::var_os("PI_LLAMA_SERVER") {
        let p = PathBuf::from(p);
        if p.is_file() {
            out.push(p);
        }
    }

    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join("llama-server");
            if p.is_file() {
                out.push(p);
            }
        }
    }

    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut fixed = vec![
        PathBuf::from("/opt/homebrew/bin/llama-server"),
        PathBuf::from("/usr/local/bin/llama-server"),
        PathBuf::from("/usr/bin/llama-server"),
    ];
    if let Some(home) = &home {
        fixed.push(home.join("llama.cpp/build/bin/llama-server"));
        fixed.push(home.join(".local/bin/llama-server"));
        if let Some(p) = find_lmstudio_backend(home) {
            fixed.push(p);
        }
    }
    for p in fixed {
        if p.is_file() {
            out.push(p);
        }
    }

    // 保留优先级顺序去重：环境变量指定 > PATH > 常见安装位置 > LM Studio。
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.clone()));
    out
}

/// LM Studio 把每个后端装在自己的版本目录里，需要浅层扫描。
fn find_lmstudio_backend(home: &Path) -> Option<PathBuf> {
    let root = home.join(".lmstudio/extensions/backends");
    scan_for_binary(&root, 0)
}

fn scan_for_binary(dir: &Path, depth: usize) -> Option<PathBuf> {
    if depth > 4 || !dir.is_dir() {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.file_name().and_then(|n| n.to_str()) == Some("llama-server") {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = scan_for_binary(&path, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

pub fn probe() -> ProbeReport {
    let list = candidates();
    let checked = list.len();
    let mut first_failure: Option<ProbeReport> = None;

    for path in list {
        match read_version(&path) {
            Ok(version) => {
                return ProbeReport {
                    found: true,
                    usable: true,
                    path: Some(path.display().to_string()),
                    version: Some(version),
                    reason: None,
                    checked,
                    checked_at: now_ms(),
                };
            }
            Err(reason) => {
                if first_failure.is_none() {
                    first_failure = Some(ProbeReport {
                        found: true,
                        usable: false,
                        path: Some(path.display().to_string()),
                        version: None,
                        reason: Some(reason),
                        checked,
                        checked_at: now_ms(),
                    });
                }
            }
        }
    }

    first_failure.unwrap_or(ProbeReport {
        found: false,
        usable: false,
        path: None,
        version: None,
        reason: Some(
            "未检测到 llama-server。请先安装 llama.cpp（如 brew install llama.cpp），\
             或把已有的 llama-server 加入 PATH / 设置环境变量 PI_LLAMA_SERVER。"
                .to_string(),
        ),
        checked,
        checked_at: now_ms(),
    })
}

/// 跑 `--version`。除退出码外，还要把动态库缺失、架构不匹配翻译成人话。
fn read_version(path: &Path) -> Result<String, String> {
    let mut child = Command::new(path)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| explain_spawn_error(path, &e))?;

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(80));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "执行 `{} --version` 超过 {} 秒未返回，可能卡在驱动初始化",
                    path.display(),
                    PROBE_TIMEOUT.as_secs()
                ));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("无法等待引擎进程：{e}"));
            }
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("读取引擎输出失败：{e}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    let first = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string();

    if output.status.success() {
        return Ok(if first.is_empty() {
            "版本未知（--version 没有输出）".to_string()
        } else {
            clip(&first, 160)
        });
    }

    let lower = text.to_lowercase();
    if lower.contains("library not loaded")
        || lower.contains("dyld")
        || lower.contains("image not found")
    {
        return Err(format!(
            "缺少动态库，引擎无法启动：{}",
            clip(first_non_empty(&text).unwrap_or("dyld: Library not loaded"), 200)
        ));
    }
    if lower.contains("illegal instruction") {
        return Err("CPU 指令集不兼容：这个构建要求更新的 CPU 指令集".to_string());
    }
    if lower.contains("address already in use") {
        return Err("端口已被占用：请先关闭占用该端口的进程".to_string());
    }
    let code = output
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal".to_string());
    Err(format!(
        "引擎返回退出码 {code}：{}",
        clip(first_non_empty(&text).unwrap_or("没有输出可读错误"), 200)
    ))
}

fn first_non_empty(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|line| !line.is_empty())
}

fn clip(text: &str, max: usize) -> String {
    let mut chars = text.chars();
    let clipped: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{clipped}…")
    } else {
        clipped
    }
}

fn explain_spawn_error(path: &Path, err: &std::io::Error) -> String {
    match err.kind() {
        ErrorKind::PermissionDenied => format!(
            "没有执行权限：{}\n可尝试 chmod +x \"{}\"",
            path.display(),
            path.display()
        ),
        ErrorKind::NotFound => format!(
            "文件不存在或解释器缺失：{}",
            path.display()
        ),
        _ => {
            #[cfg(unix)]
            {
                // ENOEXEC = 8：架构不匹配或不是可执行文件。
                if err.raw_os_error() == Some(8) {
                    return format!(
                        "无法执行：{} 不是可执行文件，或架构与本机不匹配",
                        path.display()
                    );
                }
            }
            format!("启动引擎失败：{err}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_reports_something() {
        // 不假设本机一定装了引擎：只要求返回结构完整、原因可读。
        let report = probe();
        println!("probe report: {report:?}");
        assert_eq!(report.found, report.path.is_some());
        if !report.usable {
            assert!(report.reason.as_deref().unwrap_or("").len() > 4);
        }
    }

    #[test]
    fn missing_binary_is_readable() {
        let err = read_version(Path::new("/definitely/not/llama-server")).unwrap_err();
        assert!(err.contains("不存在"));
    }

    #[cfg(unix)]
    fn fake_binary(name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("pi-probe-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("llama-server");
        fs::write(&path, body).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        // 首次执行这个脚本要等解释器冷启动，先跑一次热身，避免 3 秒探测超时误判。
        let _ = Command::new(&path).arg("--version").output();
        path
    }

    /// 「装了但跑不起来」要给出可读原因，而不是裸退出码。
    #[cfg(unix)]
    #[test]
    fn broken_binary_explains_missing_library() {
        let path = fake_binary(
            "dyld",
            "#!/bin/sh\necho 'dyld: Library not loaded: @rpath/libggml.dylib' >&2\nexit 1\n",
        );
        let err = read_version(&path).unwrap_err();
        assert!(err.contains("缺少动态库"), "unexpected reason: {err}");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// 「装了能跑」拿版本号，usable 判定依赖这里。
    #[cfg(unix)]
    #[test]
    fn working_binary_reports_version() {
        let path = fake_binary("ok", "#!/bin/sh\necho 'version: 5000 (abcdef)'\n");
        let version = read_version(&path).unwrap();
        assert!(version.contains("5000"), "unexpected version: {version}");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
