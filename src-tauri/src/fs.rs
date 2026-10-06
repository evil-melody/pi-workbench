use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileNode>>,
}

/// 把请求路径约束在 root 之内。
///
/// 文件接口此前接受任意绝对路径，等同路径穿越：前端或 Pi 给出一个绝对路径即可
/// 读写项目外的任意文件。这里先 canonicalize 解析符号链接，再做前缀判定，
/// 因此 `proj/link -> /etc` 这类软链逃逸同样会被拦下。
pub fn resolve(root: &str, target: &str) -> Result<PathBuf, String> {
    let r = Path::new(root)
        .canonicalize()
        .map_err(|e| format!("根路径无效: {root} ({e})"))?;
    let p = Path::new(target);
    let cand = if p.is_absolute() {
        p.to_path_buf()
    } else {
        r.join(p)
    };
    let norm = match cand.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            // 目标尚不存在（例如新建文件）时用父目录判定，父目录必须在根内。
            let parent = cand
                .parent()
                .ok_or_else(|| format!("非法路径: {target}"))?
                .canonicalize()
                .map_err(|e| format!("父目录不可访问: {target} ({e})"))?;
            parent.join(cand.file_name().unwrap_or_default())
        }
    };
    if norm.starts_with(&r) {
        Ok(norm)
    } else {
        Err(format!("路径越界: {target} 不在 {root} 内"))
    }
}

#[tauri::command]
pub fn fs_read_dir(path: String, root: String) -> Result<Vec<FileNode>, String> {
    let dir = resolve(&root, &path)?;
    let mut nodes = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        let is_dir = p.is_dir();
        nodes.push(FileNode {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: p.to_string_lossy().into_owned(),
            is_dir,
            children: None,
        });
    }
    nodes.sort_by(|a, b| {
        (b.is_dir, a.name.to_lowercase()).cmp(&(a.is_dir, b.name.to_lowercase()))
    });
    Ok(nodes)
}

#[tauri::command]
pub fn fs_read_file(path: String, root: String) -> Result<String, String> {
    let f = resolve(&root, &path)?;
    fs::read_to_string(&f).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_write_file(path: String, content: String, root: String) -> Result<(), String> {
    let f = resolve(&root, &path)?;
    fs::write(&f, content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_outside_root() {
        assert!(
            resolve("/tmp", "/etc/passwd").is_err(),
            "越界绝对路径必须被拒绝"
        );
    }

    #[test]
    fn allows_path_inside_root() {
        let d = std::env::temp_dir().join("piwb-fs-ok");
        fs::create_dir_all(d.join("sub")).ok();
        let inside = d.join("sub").join("a.txt").to_string_lossy().to_string();
        assert!(resolve(d.to_string_lossy().as_ref(), &inside).is_ok());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn rejects_relative_traversal() {
        let d = std::env::temp_dir().join("piwb-fs-trav");
        fs::create_dir_all(d.join("proj")).ok();
        assert!(
            resolve(d.join("proj").to_string_lossy().as_ref(), "../../etc/passwd").is_err(),
            "相对路径穿越必须被拒绝"
        );
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let d = std::env::temp_dir().join("piwb-fs-link");
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("proj")).ok();
        let _ = symlink("/etc", d.join("proj").join("link"));
        assert!(
            resolve(
                d.join("proj").to_string_lossy().as_ref(),
                d.join("proj").join("link").to_string_lossy().as_ref()
            )
            .is_err(),
            "软链逃逸必须被拒绝"
        );
        let _ = fs::remove_dir_all(&d);
    }
}
