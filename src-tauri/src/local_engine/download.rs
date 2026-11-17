//! 精选模型下载器。
//!
//! 规则：
//! - 下载中的文件统一落 `models/<file>.part`，完成校验后原子改名；
//! - 取消或失败保留 `.part`，下次点下载用 Range 续传；
//! - 进度写进共享快照并通过事件推送，切页面后重新拉快照即可恢复。

use super::catalog::{self, CatalogModel};
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const EVENT: &str = "local-model://download";
const TICK: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Serialize)]
pub struct DownloadSnapshot {
    pub id: String,
    pub file: String,
    pub name: String,
    /// downloading / cancelling / cancelled / completed / failed
    pub state: String,
    pub downloaded: u64,
    pub total: u64,
    pub speed_bps: u64,
    pub eta_secs: Option<u64>,
    pub message: Option<String>,
    /// 该任务启动时固定的下载源。中途改设置不会改变这里的值，
    /// 续传也不会跳到另一个域。
    pub endpoint: String,
}

pub struct DownloadHandle {
    pub cancel: Arc<AtomicBool>,
    pub snapshot: Arc<Mutex<DownloadSnapshot>>,
}

impl Clone for DownloadHandle {
    fn clone(&self) -> Self {
        Self {
            cancel: self.cancel.clone(),
            snapshot: self.snapshot.clone(),
        }
    }
}

pub fn new_handle(model: &CatalogModel, endpoint: &str) -> DownloadHandle {
    DownloadHandle {
        cancel: Arc::new(AtomicBool::new(false)),
        snapshot: Arc::new(Mutex::new(DownloadSnapshot {
            id: model.id.to_string(),
            file: model.file.to_string(),
            name: model.name.to_string(),
            state: "downloading".to_string(),
            downloaded: 0,
            total: model.size_bytes,
            speed_bps: 0,
            eta_secs: None,
            message: None,
            endpoint: endpoint.to_string(),
        })),
    }
}

fn update<F: FnOnce(&mut DownloadSnapshot)>(handle: &DownloadHandle, f: F) {
    if let Ok(mut guard) = handle.snapshot.lock() {
        f(&mut guard);
    }
}

fn emit(app: Option<&AppHandle>, handle: &DownloadHandle) {
    let snap = match handle.snapshot.lock() {
        Ok(g) => g.clone(),
        Err(_) => return,
    };
    if let Some(app) = app {
        let _ = app.emit(EVENT, snap);
    }
}

fn fail(app: Option<&AppHandle>, handle: &DownloadHandle, message: String) {
    update(handle, |s| {
        s.state = "failed".to_string();
        s.speed_bps = 0;
        s.eta_secs = None;
        s.message = Some(message);
    });
    emit(app, handle);
}

pub fn run(
    app: AppHandle,
    model: &'static CatalogModel,
    endpoint: String,
    final_path: std::path::PathBuf,
    part_path: std::path::PathBuf,
) -> DownloadHandle {
    let handle = new_handle(model, &endpoint);
    let bg = handle.clone();
    tauri::async_runtime::spawn(async move {
        run_inner(Some(app), model, endpoint, final_path, part_path, bg).await;
    });
    handle
}

async fn run_inner(
    app: Option<AppHandle>,
    model: &'static CatalogModel,
    endpoint: String,
    final_path: std::path::PathBuf,
    part_path: std::path::PathBuf,
    handle: DownloadHandle,
) {
    let h = handle;

    let url = catalog::download_url(model, &endpoint);
    let client = match reqwest::Client::builder()
        // 整体超时会掐断大文件流式下载（实测 469 MB 在 30 秒处被中断）；
        // 这里只约束连接与单次读取，整段下载由取消开关控制。
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .user_agent(concat!("pi-workbench/", env!("CARGO_PKG_VERSION")))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            fail(app.as_ref(), &h, format!("HTTP 客户端初始化失败：{e}"));
            return;
        }
    };

    let have = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    let mut req = client.get(&url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            fail(
                app.as_ref(),
                &h,
                format!("下载失败：无法连接 {url}\n{e}"),
            );
            return;
        }
    };

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        fail(
            app.as_ref(),
            &h,
            "模型文件不存在（HTTP 404），可能已从仓库移除；请刷新目录或选择其它模型。".to_string(),
        );
        return;
    }
    if !resp.status().is_success() {
        fail(app.as_ref(), &h, format!("下载失败：HTTP {}", resp.status()));
        return;
    }

    let resumed = have > 0 && resp.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut downloaded = if resumed { have } else { 0 };
    let total = match (resp.content_length(), resumed) {
        (Some(len), true) => have + len,
        (Some(len), false) => len,
        (None, _) => model.size_bytes,
    };
    if !resumed && have > 0 {
        // 服务端不支持 Range：从头开始，避免把新内容追加到旧片段后面。
        let _ = fs::remove_file(&part_path);
    }

    let mut file = match fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&part_path)
    {
        Ok(f) => f,
        Err(e) => {
            fail(app.as_ref(), &h, format!("无法写入模型目录：{e}"));
            return;
        }
    };

    update(&h, |s| {
        s.downloaded = downloaded;
        s.total = total;
    });
    emit(app.as_ref(), &h);

    let mut resp = resp;
    let started = Instant::now();
    let mut last_tick = Instant::now();
    let mut last_bytes = downloaded;
    let mut last_emit = Instant::now();
    // 实测长连接会被对端中途断开（error decoding response body）；
    // 断点续传本身就是现成的，这里补最多 3 次自动重连。
    let mut attempt = 0u32;

    loop {
        if h.cancel.load(Ordering::Relaxed) {
            let _ = file.flush();
            update(&h, |s| {
                s.state = "cancelled".to_string();
                s.downloaded = downloaded;
                s.speed_bps = 0;
                s.eta_secs = None;
            });
            emit(app.as_ref(), &h);
            return;
        }

        let chunk = match resp.chunk().await {
            Ok(c) => c,
            Err(e) => {
                attempt += 1;
                if attempt >= 3 || h.cancel.load(Ordering::Relaxed) {
                    let _ = file.flush();
                    fail(
                        app.as_ref(),
                        &h,
                        format!(
                            "下载中断：{e}\n已保留 {} 的临时文件，重新点下载可续传。",
                            human_size(downloaded)
                        ),
                    );
                    return;
                }
                update(&h, |s| {
                    s.message = Some(format!("连接中断，正在续传（第 {attempt} 次）"));
                });
                emit(app.as_ref(), &h);
                tokio::time::sleep(Duration::from_secs(2)).await;

                let req = client
                    .get(&url)
                    .header(reqwest::header::RANGE, format!("bytes={downloaded}-"));
                match req.send().await {
                    Ok(next) if next.status() == reqwest::StatusCode::PARTIAL_CONTENT => {
                        resp = next;
                    }
                    Ok(next) if next.status().is_success() => {
                        // 对端忽略 Range：清空片段，从头续写，避免新旧内容拼接。
                        let _ = file.flush();
                        file = match fs::OpenOptions::new()
                            .create(true)
                            .write(true)
                            .truncate(true)
                            .open(&part_path)
                        {
                            Ok(f) => f,
                            Err(e) => {
                                fail(app.as_ref(), &h, format!("无法写入模型目录：{e}"));
                                return;
                            }
                        };
                        downloaded = 0;
                        resp = next;
                    }
                    Ok(next) => {
                        fail(
                            app.as_ref(),
                            &h,
                            format!("续传失败：HTTP {}（重试 3 次仍不可用）", next.status()),
                        );
                        return;
                    }
                    Err(e) => {
                        fail(
                            app.as_ref(),
                            &h,
                            format!(
                                "续传失败：{e}\n已保留 {} 的临时文件，重新点下载可续传。",
                                human_size(downloaded)
                            ),
                        );
                        return;
                    }
                }
                last_tick = Instant::now();
                last_bytes = downloaded;
                continue;
            }
        };
        let Some(chunk) = chunk else { break };

        if let Err(e) = file.write_all(&chunk) {
            fail(app.as_ref(), &h, format!("写入失败：{e}（检查磁盘空间）"));
            return;
        }
        downloaded += chunk.len() as u64;

        if last_tick.elapsed() >= TICK {
            let elapsed = last_tick.elapsed().as_secs_f64();
            let speed = ((downloaded - last_bytes) as f64 / elapsed.max(0.001)) as u64;
            last_bytes = downloaded;
            last_tick = Instant::now();
            update(&h, |s| {
                s.downloaded = downloaded;
                s.total = total;
                s.speed_bps = speed;
                s.eta_secs = if speed > 0 && total > downloaded {
                    Some((total - downloaded) / speed)
                } else {
                    None
                };
            });
            if last_emit.elapsed() >= TICK {
                emit(app.as_ref(), &h);
                last_emit = Instant::now();
            }
        }
    }

    let _ = file.flush();
    drop(file);

    if let Err(msg) = validate(&part_path, model) {
        fail(app.as_ref(), &h, msg);
        return;
    }
    if let Err(e) = fs::rename(&part_path, &final_path) {
        fail(app.as_ref(), &h, format!("下载完成但保存失败：{e}"));
        return;
    }

    update(&h, |s| {
        s.state = "completed".to_string();
        s.downloaded = downloaded;
        s.total = downloaded.max(total);
        s.speed_bps = 0;
        s.eta_secs = Some(0);
        s.message = Some(format!(
            "下载完成，用时 {}",
            human_duration(started.elapsed())
        ));
    });
    emit(app.as_ref(), &h);
}

/// 校验文件头与目录声明的大小。大小不符时保留 `.part`，方便续传或排查镜像。
fn validate(path: &Path, model: &CatalogModel) -> Result<(), String> {
    let mut head = [0u8; 4];
    let mut f = fs::File::open(path).map_err(|e| format!("校验失败：{e}"))?;
    f.read_exact(&mut head)
        .map_err(|_| "校验失败：文件过短，不是有效的 GGUF".to_string())?;
    if &head != b"GGUF" {
        return Err(
            "校验失败：文件头不是 GGUF，可能下载到了错误页面或镜像返回了 HTML。".to_string(),
        );
    }
    let actual = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if actual != model.size_bytes {
        return Err(format!(
            "大小校验失败：期望 {}，实际 {}。已保留临时文件，可重新下载续传。",
            human_size(model.size_bytes),
            human_size(actual)
        ));
    }
    Ok(())
}

pub fn human_size(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    if bytes as f64 >= GB {
        format!("{:.2} GB", bytes as f64 / GB)
    } else {
        format!("{:.0} MB", bytes as f64 / MB)
    }
}

fn human_duration(d: Duration) -> String {
    let secs = d.as_secs();
    if secs >= 60 {
        format!("{} 分 {} 秒", secs / 60, secs % 60)
    } else {
        format!("{secs} 秒")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::sync::atomic::Ordering;
    use std::time::Instant;

    #[test]
    fn size_format_is_readable() {
        assert_eq!(human_size(491_400_032), "469 MB");
        assert_eq!(human_size(4_683_073_536), "4.36 GB");
    }

    #[test]
    fn gguf_magic_rejected_for_text() {
        let path = std::env::temp_dir().join("pi-local-model-not-gguf.bin");
        std::fs::write(&path, b"<html>not a model</html>").unwrap();
        let err = validate(&path, &catalog::CATALOG[0]).unwrap_err();
        assert!(err.contains("GGUF"));
        let _ = std::fs::remove_file(path);
    }

    /// 真机验收：走应用自己的下载链路，顺带验证取消与 Range 续传。
    /// 默认忽略，联网时显式执行：`cargo test downloads_and_resumes -- --ignored --nocapture`
    #[test]
    #[ignore = "network: downloads the smallest catalog model (~469 MB)"]
    fn downloads_and_resumes_through_app_chain() {
        let model: &'static CatalogModel = &catalog::CATALOG[0];
        let dir = std::env::temp_dir().join(format!("pi-download-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let final_path = dir.join(model.file);
        let part_path = dir.join(format!("{}.part", model.file));

        // 第一段：下到 8 MB 就取消，留下 .part。
        let first = new_handle(model, catalog::MIRROR_ENDPOINT);
        let cancel = first.cancel.clone();
        let snap = first.snapshot.clone();
        std::thread::spawn(move || loop {
            let got = snap.lock().map(|s| s.downloaded).unwrap_or(0);
            if got > 2 * 1024 * 1024 {
                cancel.store(true, Ordering::Relaxed);
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        });
        let t0 = Instant::now();
        tauri::async_runtime::block_on(run_inner(
            None,
            model,
            catalog::MIRROR_ENDPOINT.to_string(),
            final_path.clone(),
            part_path.clone(),
            first.clone(),
        ));
        let partial = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
        {
            let s = first.snapshot.lock().unwrap();
            println!("phase1 state={} downloaded={partial} elapsed={:?}", s.state, t0.elapsed());
            assert_eq!(s.state, "cancelled");
        }
        assert!(partial > 0, "取消后应保留 .part");
        assert!(!final_path.exists(), "取消不应产出最终文件");

        // 第二段：重新下载，应命中 Range 续传并完成校验。
        let second = new_handle(model, catalog::MIRROR_ENDPOINT);
        let t1 = Instant::now();
        tauri::async_runtime::block_on(run_inner(
            None,
            model,
            catalog::MIRROR_ENDPOINT.to_string(),
            final_path.clone(),
            part_path.clone(),
            second.clone(),
        ));
        let s = second.snapshot.lock().unwrap().clone();
        println!(
            "phase2 state={} downloaded={} message={:?} elapsed={:?}",
            s.state,
            s.downloaded,
            s.message,
            t1.elapsed()
        );
        assert_eq!(s.state, "completed", "message: {:?}", s.message);
        assert_eq!(fs::metadata(&final_path).unwrap().len(), model.size_bytes);
        assert!(!part_path.exists(), "完成后应移除 .part");
        let mut head = [0u8; 4];
        fs::File::open(&final_path)
            .unwrap()
            .read_exact(&mut head)
            .unwrap();
        assert_eq!(&head, b"GGUF");
        if std::env::var_os("PI_KEEP_MODEL").is_some() {
            println!("kept model at {}", final_path.display());
        } else {
            let _ = fs::remove_dir_all(&dir);
        }
    }
}
