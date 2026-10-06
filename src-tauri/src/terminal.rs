use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

use serde_json::json;
use tauri::{AppHandle, Emitter};

/// 在指定 cwd 运行 shell 命令，按行流式推到前端（term://output / term://done）。
#[tauri::command]
pub fn term_exec(app: AppHandle, id: String, cwd: String, cmd: String) {
    std::thread::spawn(move || {
        match Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .current_dir(&cwd)
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
                    for line in BufReader::new(stdout).lines().flatten() {
                        let _ = app_o.emit(
                            "term://output",
                            json!({ "id": id_o, "stream": "out", "line": line }),
                        );
                    }
                });

                let app_e = app.clone();
                let id_e = id.clone();
                let t_err = std::thread::spawn(move || {
                    for line in BufReader::new(stderr).lines().flatten() {
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
}
