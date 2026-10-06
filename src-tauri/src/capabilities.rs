use std::path::{Path, PathBuf};

use serde::Deserialize;

/// 能力清单：声明「每个能力由谁提供」，是前端面板与内核之间的单一真源。
/// 与 Tauri 自己的 `capabilities/` 权限体系是两回事，这里只描述产品能力。
#[derive(Debug, Clone, Deserialize)]
pub struct CapabilityManifest {
    pub version: u32,
    /// Pi 内核版本要求，与 package.json#piVersion 对应。
    pub kernel: Option<KernelPin>,
    pub skills: SkillCapabilities,
    pub tools: ToolCapabilities,
    /// 随内核加载的 extension 文件（相对 src-tauri 或 extensions 目录）。
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KernelPin {
    pub pi_version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SkillCapabilities {
    /// 技能发现目录（`<agent-dir>` 与项目 `.pi` 的相对写法）。
    pub dirs: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToolCapabilities {
    /// Pi 内置工具，作为工具白名单的基线。
    pub builtin: Vec<String>,
    /// 是否允许通过 `defaultTools` 注入外部工具名。
    pub injectable: Option<bool>,
}

impl CapabilityManifest {
    /// 加载并校验能力清单。路径缺失或字段非法都返回错误，由调用方决定是否致命。
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("读取能力清单失败: {e}"))?;
        let m: CapabilityManifest =
            serde_json::from_str(&text).map_err(|e| format!("能力清单不是合法 JSON: {e}"))?;
        if m.version != 1 {
            return Err(format!("不支持的能力清单版本: {}", m.version));
        }
        if m.skills.dirs.is_empty() {
            return Err("能力清单必须声明至少一个技能目录".into());
        }
        if m.tools.builtin.is_empty() {
            return Err("能力清单必须声明内置工具基线".into());
        }
        Ok(m)
    }

    /// 候选位置：打包资源目录 → 源码树（开发态）→ 当前目录。
    pub fn candidates() -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Ok(d) = std::env::var("CARGO_MANIFEST_DIR") {
            out.push(Path::new(&d).join("capabilities.json"));
        }
        out.push(Path::new("capabilities.json").to_path_buf());
        out
    }

    /// 取第一个可用清单；都没有则返回 None（不致命，能力退化为内置默认值）。
    pub fn discover() -> Option<Self> {
        for c in Self::candidates() {
            if let Ok(m) = Self::load(&c) {
                return Some(m);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"{
      "version": 1,
      "skills": { "dirs": ["<agent-dir>/skills", ".pi/skills"] },
      "tools": { "builtin": ["read", "bash", "edit", "write"], "injectable": true },
      "extensions": ["sandbox-env.ts", "role-inject.ts"]
    }"#;

    fn write(dir: &std::path::Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn parses_minimal_manifest() {
        let dir = std::env::temp_dir().join("piwb-cap-min");
        std::fs::create_dir_all(&dir).ok();
        let p = write(&dir, "capabilities.json", MINIMAL);
        let m = CapabilityManifest::load(&p).expect("最小清单应可解析");
        assert_eq!(m.version, 1);
        assert_eq!(m.skills.dirs.len(), 2);
        assert_eq!(m.tools.builtin.len(), 4);
        assert_eq!(m.extensions.len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_unknown_version() {
        let dir = std::env::temp_dir().join("piwb-cap-ver");
        std::fs::create_dir_all(&dir).ok();
        let bumped = MINIMAL.replace("\"version\": 1", "\"version\": 2");
        let p = write(&dir, "capabilities.json", &bumped);
        assert!(CapabilityManifest::load(&p).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_empty_skill_dirs() {
        let dir = std::env::temp_dir().join("piwb-cap-dirs");
        std::fs::create_dir_all(&dir).ok();
        let bad = MINIMAL.replace(
            "\"dirs\": [\"<agent-dir>/skills\", \".pi/skills\"]",
            "\"dirs\": []",
        );
        let p = write(&dir, "capabilities.json", &bad);
        let err = CapabilityManifest::load(&p).unwrap_err();
        assert!(err.contains("技能目录"), "空目录列表必须被拒绝，Got: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_malformed_json() {
        let dir = std::env::temp_dir().join("piwb-cap-bad");
        std::fs::create_dir_all(&dir).ok();
        let p = write(&dir, "capabilities.json", "{ not json");
        assert!(CapabilityManifest::load(&p).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
