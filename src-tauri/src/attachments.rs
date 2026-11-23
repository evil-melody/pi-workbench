use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

/// 附件落盘结果：路径供内核按路径读取，name/size 供气泡卡片显示。
#[derive(Serialize)]
pub struct AttachmentInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
}

/// 托管附件目录（app_config_dir/attachments），不存在就建。
fn attachments_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("取配置目录失败: {e}"))?
        .join("attachments");
    fs::create_dir_all(&dir).map_err(|e| format!("建附件目录失败: {e}"))?;
    Ok(dir)
}

/// 把已落盘的 dest 收口成前端要的 AttachmentInfo（name 取终名，size 读 metadata）。
fn info_of(dest: &Path) -> AttachmentInfo {
    let name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment")
        .to_string();
    let size = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    AttachmentInfo {
        path: dest.to_string_lossy().to_string(),
        name,
        size,
    }
}

/// 把用户从对话框选中的文件（图片/文档）复制进本应用的托管附件目录，
/// 返回**绝对路径**。前端把它写进 prompt 文本的「附件引用块」里交给 Pi——
///
/// 为什么是「落盘 + 路径引用」而不是直发多模态 content block：
/// 当前 Pi RPC 的 `prompt.message` 只接受字符串（实证的协议约束——传
/// `[{type:image_url,...}]` 这种 content 数组会报 `text.startsWith is not a function`）。
/// 所以多模态走引用路径的绕行方案，真·视觉理解等内核支持 content block 后再翻。
/// 附件统一收口到 `app_config_dir/attachments/`，避免散落、也便于导入时按同一目录找回。
#[tauri::command(async)]
pub fn attachment_add(app: tauri::AppHandle, src: String) -> Result<AttachmentInfo, String> {
    let src_path = Path::new(&src);
    if !src_path.exists() {
        return Err(format!("附件源文件不存在: {src}"));
    }
    let dir = attachments_dir(&app)?;
    let name = src_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(sanitize_name)
        .unwrap_or_else(|| "attachment".into());
    // 同名则加短后缀：否则上一轮的截图会被下一轮静默覆盖。
    let dest = uniquify(&dir, name);
    fs::copy(src_path, &dest).map_err(|e| format!("复制附件失败: {e}"))?;
    Ok(info_of(&dest))
}

/// 粘贴图片的字节通道：剪贴板里的图没有磁盘路径，`attachment_add` 吃不到。
/// 前端把 ClipboardItem 读成 base64 下发，这里解码后走**同一条**托管目录
/// （sanitize + uniquify + 同样的 AttachmentInfo 形状）——托盘与回放因此
/// 分不出图是拖进来的还是粘进来的，不需要第二套渲染。
///
/// ext 由前端按剪贴板 MIME 给（image/png → png）；只收白名单，
/// 其余一律 png 兜底——粘贴源是任意应用，扩展名不能信。
#[tauri::command(async)]
pub fn attachment_add_bytes(
    app: tauri::AppHandle,
    data: String,
    ext: Option<String>,
) -> Result<AttachmentInfo, String> {
    use base64::Engine;
    const MAX_BYTES: u64 = 32 * 1024 * 1024; // 32 MiB：剪贴板大图的上限保护
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "粘贴数据不是合法 base64".to_string())?;
    if bytes.is_empty() {
        return Err("粘贴数据为空".into());
    }
    if bytes.len() as u64 > MAX_BYTES {
        return Err(format!("粘贴图片超过 {MAX_BYTES} 字节上限"));
    }
    let dir = attachments_dir(&app)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = uniquify(&dir, paste_name(ext, stamp));
    fs::write(&dest, &bytes).map_err(|e| format!("写入附件失败: {e}"))?;
    Ok(info_of(&dest))
}

/// 粘贴附件的文件名：时间戳 + 白名单扩展名（其余一律 png 兜底——
/// 粘贴源是任意应用，扩展名不能信）。纯函数便于单测。
fn paste_name(ext: Option<String>, stamp: u128) -> String {
    let ext = match ext.map(|e| e.to_lowercase()) {
        Some(e) if matches!(e.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp") => e,
        _ => "png".into(),
    };
    format!("粘贴图片-{stamp}.{ext}")
}

/// 文件名只保留安全字符：字母/数字（含 CJK）/点/连字符/下划线；空格与斜杠等统一成下划线。
fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "attachment".into()
    } else {
        cleaned
    }
}

/// 目标目录里同名文件已存在时，返回带 `_1`/`_2` 后缀的空闲路径（不覆盖既有文件）。
fn uniquify(dir: &Path, name: String) -> PathBuf {
    let base = dir.join(&name);
    if !base.exists() {
        return base;
    }
    let stem = Path::new(&name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("attachment")
        .to_string();
    let ext = Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let mut i = 1;
    loop {
        let cand = dir.join(format!("{stem}_{i}{ext}"));
        if !cand.exists() {
            return cand;
        }
        i += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn sanitize_replaces_unsafe_chars() {
        assert_eq!(sanitize_name("my file/pic.png"), "my_file_pic.png");
        assert_eq!(sanitize_name("截图 1.png"), "截图_1.png");
        assert_eq!(sanitize_name(""), "attachment");
    }

    #[test]
    fn copy_roundtrip_and_uniquify_keeps_existing() {
        let tmp = std::env::temp_dir().join("pi_wb_attach_test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("demo.png");
        {
            let mut f = fs::File::create(&src).unwrap();
            f.write_all(b"hello").unwrap();
        }
        let dest1 = uniquify(&tmp, "demo.png".into());
        fs::copy(&src, &dest1).unwrap();
        assert!(dest1.exists());
        // 再次 uniquify 同名必须给出一个新候选，且不覆盖已存在的 dest1。
        let dest2 = uniquify(&tmp, "demo.png".into());
        assert_ne!(dest1, dest2);
        assert!(!dest2.exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn paste_name_whitelists_ext_and_falls_back() {
        // 白名单内原样（大小写归一），白名单外一律 png——粘贴源不可信。
        assert_eq!(paste_name(Some("JPEG".into()), 100), "粘贴图片-100.jpeg");
        assert_eq!(paste_name(Some("webp".into()), 100), "粘贴图片-100.webp");
        assert_eq!(paste_name(Some("exe".into()), 100), "粘贴图片-100.png");
        assert_eq!(paste_name(None, 100), "粘贴图片-100.png");
        // 时间戳区分 + uniquify：同毫秒两次也要给出不同路径
        let tmp = std::env::temp_dir().join("pi_wb_paste_test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let a = uniquify(&tmp, paste_name(Some("png".into()), 100));
        fs::write(&a, b"x").unwrap();
        let b = uniquify(&tmp, paste_name(Some("png".into()), 100));
        assert_ne!(a, b);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn paste_base64_decodes_roundtrip() {
        // 命令体里 base64 → 字节的同一路径必须在单测可覆盖：
        // 解码失败/空数据是前端 paste 的真实故障面（剪贴板是文本、SVG 等）。
        use base64::Engine;
        let eng = base64::engine::general_purpose::STANDARD;
        assert_eq!(eng.decode("aGVsbG8=").unwrap(), b"hello");
        assert!(eng.decode("not base64 !!").is_err());
        assert!(eng.decode("").unwrap().is_empty()); // 空粘贴要在这里就被拒
    }
}
