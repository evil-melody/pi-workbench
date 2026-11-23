//! 精选本地模型目录。
//!
//! 只收录已在 HuggingFace 实际存在、文件名与大小核对过的 GGUF。
//! 不接 HuggingFace 搜索：目录是白名单，避免任意仓库/许可/断供带来的不可控。
//! 大小用于下载前预检与下载后校验。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CatalogModel {
    pub id: &'static str,
    pub name: &'static str,
    pub repo: &'static str,
    pub file: &'static str,
    pub params: &'static str,
    pub quantization: &'static str,
    pub size_bytes: u64,
    pub license: &'static str,
    /// chat / code / light，前端据此筛选与翻译。
    pub tag: &'static str,
    /// KV cache 估算用：层数与每层 K/V 维度（kv_heads × head_dim，已核对上游 config.json）。
    pub layers: u16,
    pub kv_dim: u16,
}

/// 目录体积估算统一按 16k 上下文（低于 Pi 系统提示所需会直接失败）。
pub const ESTIMATE_CTX: u64 = 16_384;
/// 运行时与计算缓冲（llama.cpp 自身、临时张量、系统余量）。
const RUNTIME_OVERHEAD_BYTES: u64 = 1_610_612_736;

pub const CATALOG: &[CatalogModel] = &[
    CatalogModel {
        id: "qwen2.5-0.5b-instruct-q4_k_m",
        name: "Qwen2.5 0.5B Instruct",
        repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
        file: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
        params: "0.5B",
        quantization: "Q4_K_M",
        size_bytes: 491_400_032,
        license: "Apache-2.0",
        tag: "light",
        layers: 24,
        kv_dim: 128,
    },
    CatalogModel {
        id: "qwen3-0.6b-q8_0",
        name: "Qwen3 0.6B",
        repo: "Qwen/Qwen3-0.6B-GGUF",
        file: "Qwen3-0.6B-Q8_0.gguf",
        params: "0.6B",
        quantization: "Q8_0",
        size_bytes: 639_446_688,
        license: "Apache-2.0",
        tag: "light",
        layers: 28,
        kv_dim: 1024,
    },
    CatalogModel {
        id: "llama-3.2-1b-instruct-q4_k_m",
        name: "Llama 3.2 1B Instruct",
        repo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
        file: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
        params: "1B",
        quantization: "Q4_K_M",
        size_bytes: 807_694_464,
        license: "Llama 3.2 Community License",
        tag: "chat",
        layers: 16,
        kv_dim: 512,
    },
    CatalogModel {
        id: "qwen2.5-1.5b-instruct-q4_k_m",
        name: "Qwen2.5 1.5B Instruct",
        repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
        file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
        params: "1.5B",
        quantization: "Q4_K_M",
        size_bytes: 1_117_320_736,
        license: "Apache-2.0",
        tag: "chat",
        layers: 28,
        kv_dim: 256,
    },
    CatalogModel {
        id: "qwen2.5-coder-1.5b-instruct-q4_k_m",
        name: "Qwen2.5 Coder 1.5B Instruct",
        repo: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF",
        file: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
        params: "1.5B",
        quantization: "Q4_K_M",
        size_bytes: 1_117_320_768,
        license: "Apache-2.0",
        tag: "code",
        layers: 28,
        kv_dim: 256,
    },
    CatalogModel {
        id: "deepseek-r1-distill-qwen-1.5b-q4_k_m",
        name: "DeepSeek R1 Distill Qwen 1.5B",
        repo: "unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF",
        file: "DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf",
        params: "1.5B",
        quantization: "Q4_K_M",
        size_bytes: 1_117_321_312,
        license: "Apache-2.0",
        tag: "chat",
        layers: 28,
        kv_dim: 256,
    },
    CatalogModel {
        id: "qwen3-1.7b-q8_0",
        name: "Qwen3 1.7B",
        repo: "Qwen/Qwen3-1.7B-GGUF",
        file: "Qwen3-1.7B-Q8_0.gguf",
        params: "1.7B",
        quantization: "Q8_0",
        size_bytes: 1_834_426_016,
        license: "Apache-2.0",
        tag: "chat",
        layers: 28,
        kv_dim: 1024,
    },
    CatalogModel {
        id: "llama-3.2-3b-instruct-q4_k_m",
        name: "Llama 3.2 3B Instruct",
        repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
        file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        params: "3B",
        quantization: "Q4_K_M",
        size_bytes: 2_019_377_696,
        license: "Llama 3.2 Community License",
        tag: "chat",
        layers: 28,
        kv_dim: 1024,
    },
    CatalogModel {
        id: "phi-3.5-mini-instruct-q4_k_m",
        name: "Phi-3.5 mini Instruct",
        repo: "bartowski/Phi-3.5-mini-instruct-GGUF",
        file: "Phi-3.5-mini-instruct-Q4_K_M.gguf",
        params: "3.8B",
        quantization: "Q4_K_M",
        size_bytes: 2_393_232_672,
        license: "MIT",
        tag: "chat",
        layers: 32,
        kv_dim: 3072,
    },
    CatalogModel {
        id: "qwen3-4b-q4_k_m",
        name: "Qwen3 4B",
        repo: "Qwen/Qwen3-4B-GGUF",
        file: "Qwen3-4B-Q4_K_M.gguf",
        params: "4B",
        quantization: "Q4_K_M",
        size_bytes: 2_497_280_256,
        license: "Apache-2.0",
        tag: "chat",
        layers: 36,
        kv_dim: 1024,
    },
    CatalogModel {
        id: "qwen2.5-coder-7b-instruct-q4_k_m",
        name: "Qwen2.5 Coder 7B Instruct",
        repo: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
        file: "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
        params: "7B",
        quantization: "Q4_K_M",
        size_bytes: 4_683_073_536,
        license: "Apache-2.0",
        tag: "code",
        layers: 28,
        kv_dim: 512,
    },
    CatalogModel {
        id: "qwen3-8b-q4_k_m",
        name: "Qwen3 8B",
        repo: "Qwen/Qwen3-8B-GGUF",
        file: "Qwen3-8B-Q4_K_M.gguf",
        params: "8B",
        quantization: "Q4_K_M",
        size_bytes: 5_027_783_488,
        license: "Apache-2.0",
        tag: "chat",
        layers: 36,
        kv_dim: 1024,
    },
];

/// 峰值内存估算：权重文件 + KV cache + 运行时开销。
///
/// KV cache = 2(K/V) × 层数 × kv_dim × ctx × 2 字节（fp16）。
/// 与 llama.cpp 的 `--ctx-size` 线性相关；Mac 统一内存下即整机内存占用。
pub fn estimate_peak_bytes(model: &CatalogModel, ctx: u64) -> u64 {
    let kv = 2 * model.layers as u64 * model.kv_dim as u64 * ctx * 2;
    model.size_bytes + kv + RUNTIME_OVERHEAD_BYTES
}

/// 适配等级：comfortable / tight / no / unknown（取不到机器内存）。
///
/// 阈值按整机内存占比：≤55% 可流畅，≤85% 勉强，其余跑不动。
pub fn memory_fit(required: u64, total: u64) -> &'static str {
    if total == 0 {
        return "unknown";
    }
    if required * 100 <= total * 55 {
        "comfortable"
    } else if required * 100 <= total * 85 {
        "tight"
    } else {
        "no"
    }
}

pub fn find(id: &str) -> Option<&'static CatalogModel> {
    CATALOG.iter().find(|m| m.id == id)
}

pub fn find_by_file(file: &str) -> Option<&'static CatalogModel> {
    CATALOG.iter().find(|m| m.file == file)
}

/// 默认镜像：实测可用的国内地址。
pub const MIRROR_ENDPOINT: &str = "https://hf-mirror.com";
/// 直连官方：慢且长连接易被切断，保留给镜像不可用的场景。
pub const OFFICIAL_ENDPOINT: &str = "https://huggingface.co";

fn normalize(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// 解析下载源，优先级：应用设置 > 环境变量 > 默认镜像。
///
/// 返回值第二项是来源标记（settings / env / default），前端只用于提示，
/// 不参与 URL 拼装。
pub fn resolve_endpoint(setting: Option<&str>) -> (String, &'static str) {
    if let Some(v) = setting.map(str::trim).filter(|v| !v.is_empty()) {
        return (normalize(v), "settings");
    }
    if let Ok(env) = std::env::var("PI_HF_ENDPOINT") {
        let v = env.trim();
        if !v.is_empty() {
            return (normalize(v), "env");
        }
    }
    (MIRROR_ENDPOINT.to_string(), "default")
}

/// 把已保存的 endpoint 归类成镜像 / 官方 / 自定义，供设置页回显选中项。
pub fn source_mode(endpoint: &str) -> &'static str {
    match normalize(endpoint).as_str() {
        v if v == MIRROR_ENDPOINT => "mirror",
        v if v == OFFICIAL_ENDPOINT => "official",
        _ => "custom",
    }
}

/// 下载 URL 必须由任务启动时解析好的 endpoint 拼装：
/// 中途改设置不能把续传请求指到另一个域。
pub fn download_url(model: &CatalogModel, endpoint: &str) -> String {
    format!("{}/{}/resolve/main/{}", normalize(endpoint), model.repo, model.file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_and_files_are_unique() {
        for (i, a) in CATALOG.iter().enumerate() {
            for b in &CATALOG[i + 1..] {
                assert_ne!(a.id, b.id);
                assert_ne!(a.file, b.file);
            }
        }
    }

    #[test]
    fn catalog_sizes_are_plausible() {
        for m in CATALOG {
            assert!(m.size_bytes > 100 * 1024 * 1024, "{} size too small", m.id);
        }
    }

    #[test]
    fn download_url_joins_cleanly() {
        let url = download_url(&CATALOG[0], MIRROR_ENDPOINT);
        assert_eq!(
            url,
            "https://hf-mirror.com/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"
        );
        let trailing = download_url(&CATALOG[0], "https://example.com/");
        assert!(trailing.starts_with("https://example.com/Qwen/"));
        assert!(!trailing.contains("//resolve"));
    }

    #[test]
    fn memory_estimate_scales_with_ctx() {
        let m = find("qwen2.5-1.5b-instruct-q4_k_m").unwrap();
        let peak = estimate_peak_bytes(m, ESTIMATE_CTX);
        assert_eq!(
            peak,
            m.size_bytes + 2 * 28 * 256 * ESTIMATE_CTX * 2 + RUNTIME_OVERHEAD_BYTES
        );
        assert!(estimate_peak_bytes(m, 32_768) > peak);
        for m in CATALOG {
            assert!(m.layers > 0 && m.kv_dim > 0, "{} 缺 KV 参数", m.id);
        }
    }

    #[test]
    fn fit_thresholds_use_total_memory() {
        let gb = 1024u64 * 1024 * 1024;
        let total = 16 * gb;
        assert_eq!(memory_fit(8 * gb, total), "comfortable");
        assert_eq!(memory_fit(12 * gb, total), "tight");
        assert_eq!(memory_fit(15 * gb, total), "no");
        assert_eq!(memory_fit(8 * gb, 0), "unknown");
    }
}
