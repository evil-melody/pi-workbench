use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

use serde_json::json;
use tauri::{AppHandle, Emitter};

/// 在指定 cwd 运行 shell 命令，按行流式推到前端（term://output / term://done）。
///
/// cwd 必须先过 `fs::resolve(root, cwd)`：前端给的路径此前不设边界，
/// 传 `/` 就等于在宿主机任意目录执行命令。root 是当前项目根。
#[tauri::command]
pub fn term_exec(
    app: AppHandle,
    id: String,
    cwd: String,
    cmd: String,
    root: String,
) -> Result<(), String> {
    if root.trim().is_empty() {
        return Err("终端缺少项目根目录（root），拒绝执行".to_string());
    }
    let dir = crate::fs::resolve(&root, &cwd)?;
    if !dir.is_dir() {
        return Err(format!("终端工作目录不存在: {}", dir.display()));
    }
    std::thread::spawn(move || {
        match Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .current_dir(&dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(mut child) => {
                let stdout = child.stdout.take().unwrap();
                let stderr = child.stderr.take().unwrap();

                let app_o = app.clone();
                let id_o = id.clone();
                let t_out = std::thread::spawn(move || {
                    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                        let _ = app_o.emit(
                            "term://output",
                            json!({ "id": id_o, "stream": "out", "line": line }),
                        );
                    }
                });

                let app_e = app.clone();
                let id_e = id.clone();
                let t_err = std::thread::spawn(move || {
                    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                        let _ = app_e.emit(
                            "term://output",
                            json!({ "id": id_e, "stream": "err", "line": line }),
                        );
                    }
                });

                let _ = t_out.join();
                let _ = t_err.join();
                let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                let _ = app.emit("term://done", json!({ "id": id, "code": code }));
            }
            Err(e) => {
                let _ = app.emit(
                    "term://output",
                    json!({ "id": id, "stream": "err", "line": format!("启动命令失败: {e}") }),
                );
                let _ = app.emit("term://done", json!({ "id": id, "code": -1 }));
            }
        }
    });
    Ok(())
}
