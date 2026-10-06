use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

/// 把用户从对话框选中的文件（图片/文档）复制进本应用的托管附件目录，
/// 返回**绝对路径**。前端把它写进 prompt 文本的「附件引用块」里交给 Pi——
///
/// 为什么是「落盘 + 路径引用」而不是直发多模态 content block：
/// 当前 Pi RPC 的 `prompt.message` 只接受字符串（实证的协议约束——传
/// `[{type:image_url,...}]` 这种 content 数组会报 `text.startsWith is not a function`）。
/// 所以多模态走引用路径的绕行方案，真·视觉理解等内核支持 content block 后再翻。
/// 附件统一收口到 `app_config_dir/attachments/`，避免散落、也便于导入时按同一目录找回。
#[tauri::command]
pub fn attachment_add(app: tauri::AppHandle, src: String) -> Result<String, String> {
    let src_path = Path::new(&src);
    if !src_path.exists() {
        return Err(format!("附件源文件不存在: {src}"));
    }
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("取配置目录失败: {e}"))?
        .join("attachments");
    fs::create_dir_all(&dir).map_err(|e| format!("建附件目录失败: {e}"))?;

    let name = src_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(sanitize_name)
        .unwrap_or_else(|| "attachment".into());
    // 同名则加短后缀：否则上一轮的截图会被下一轮静默覆盖。
    let dest = uniquify(&dir, name);
    fs::copy(src_path, &dest).map_err(|e| format!("复制附件失败: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
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
}
