//! B5 语义向量召回（P3 演进，方案 C：Rust 侧 LanceDB）。
//!
//! 与词面召回（`agent-memory.ts` 的 bigram 评分，跑在 Pi 进程内）互补：
//! 词面解决「字面命中」，本模块解决「意思相同、字面不同」的同义改写盲区。
//!
//! 架构约束：LanceDB 是 native 依赖，Pi 扩展进程加载不了（extension 只能
//! 用 node: 内置模块），所以向量层落在 Tauri（Rust）侧：
//!
//! - 存储：`<app_config_dir>/memory_vec/` 下的 LanceDB 表 `memory_vectors`
//!   （id / text / tags / ts / vector），无服务端、本地目录形态。
//! - 向量化：HTTP 调本机 embedding 服务（默认 Ollama `/api/embed`），
//!   endpoint 与模型经 `<app_config_dir>/memory_vec.json` 配置。
//! - 写入：`agent_memory_store` 落盘后 fire-and-forget 向量化（失败只记日志，
//!   不阻塞词面主路径）；`memory_vec_reindex` 全量重建。
//! - 检索：`memory_vec_search` 命令（前端/命令层消费）。
//!
//! 已知边界：agent 的 `memory_recall` 工具在 Pi 进程内，够不到 Rust 侧
//! LanceDB，仍是词面召回；向量结果供外壳层消费（见 gap md 7.3）。

// lancedb 0.21 只 re-export arrow_schema；array 类型走直接依赖 arrow-array（55.x 对齐）。
use arrow_array::{
    types::Float32Type, FixedSizeListArray, Float32Array, Float64Array, Int64Array, RecordBatch,
    RecordBatchIterator, StringArray,
};
use arrow_schema::{ArrowError, DataType, Field, Schema};
use futures::StreamExt;
use lancedb::query::{ExecutableQuery, QueryBase};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

const TABLE: &str = "memory_vectors";
const DEFAULT_BASE_URL: &str = "http://127.0.0.1:11434";
const DEFAULT_MODEL: &str = "bge-m3";

/// embedding 服务配置（`<config>/memory_vec.json`，缺省走本机 Ollama）。
#[derive(Debug, Clone)]
pub struct EmbedConfig {
    pub base_url: String,
    pub model: String,
}

impl Default for EmbedConfig {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.into(),
            model: DEFAULT_MODEL.into(),
        }
    }
}

impl EmbedConfig {
    fn load(app: &AppHandle) -> Self {
        let Some(dir) = app.path().app_config_dir().ok() else {
            return Self::default();
        };
        let Ok(text) = std::fs::read_to_string(dir.join("memory_vec.json")) else {
            return Self::default();
        };
        let v: Value = serde_json::from_str(&text).unwrap_or_default();
        Self {
            base_url: v
                .get("baseUrl")
                .and_then(|x| x.as_str())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(DEFAULT_BASE_URL)
                .to_string(),
            model: v
                .get("model")
                .and_then(|x| x.as_str())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(DEFAULT_MODEL)
                .to_string(),
        }
    }
}

/// 记忆向量库目录：`<app_config_dir>/memory_vec`。
fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("memory_vec"))
        .map_err(|e| format!("取配置目录失败: {e}"))
}

async fn open_db(app: &AppHandle) -> Result<lancedb::Connection, String> {
    let path = db_path(app)?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    lancedb::connect(path.to_str().ok_or("向量库路径非 UTF-8")?)
        .execute()
        .await
        .map_err(|e| format!("打开向量库失败: {e}"))
}

/// 拿表：表不存在返回 None（建表延迟到首条写入，dim 由 embedding 决定）。
async fn open_table(db: &lancedb::Connection) -> Result<Option<lancedb::table::Table>, String> {
    let names = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("读向量库表清单失败: {e}"))?;
    if !names.iter().any(|n| n == TABLE) {
        return Ok(None);
    }
    Ok(Some(
        db.open_table(TABLE)
            .execute()
            .await
            .map_err(|e| format!("打开向量表失败: {e}"))?,
    ))
}

/// 单条 batch 转 RecordBatchReader（lancedb add/create_table 的 IntoArrow 入参）。
fn reader_for(
    batch: RecordBatch,
) -> RecordBatchIterator<std::iter::Once<Result<RecordBatch, ArrowError>>> {
    let schema = batch.schema();
    RecordBatchIterator::new(std::iter::once(Ok(batch)), schema)
}

/// 调 embedding 服务（Ollama 形状：POST /api/embed {model, input} → embeddings[0]）。
pub async fn embed(cfg: &EmbedConfig, text: &str) -> Result<Vec<f32>, String> {
    let url = format!("{}/api/embed", cfg.base_url.trim_end_matches('/'));
    // no_proxy 是硬要求：embedding 目标默认是本机 Ollama，环境里的 HTTP_PROXY
    // （系统代理/沙箱代理）会把 loopback 请求劫持到代理进程，代理解不到本地
    // 临时端口 → "error sending request"。本地服务必须直连。
    let resp = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| format!("embedding 客户端构建失败: {e}"))?
        .post(&url)
        .json(&json!({ "model": cfg.model, "input": text }))
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| {
            // 带上错误源链：reqwest 顶层 "error sending request" 不含真实死因
            // （连接被拒/代理劫持/DNS），排障必须看 source。
            let mut src = std::error::Error::source(&e);
            let mut chain = String::new();
            while let Some(s) = src {
                chain.push_str(&format!(" ← {s}"));
                src = std::error::Error::source(s);
            }
            format!("embedding 请求失败（{url}）: {e}{chain}")
        })?;
    if !resp.status().is_success() {
        return Err(format!(
            "embedding 服务返回 {}（{url}）——请确认本机 embedding 服务（默认 Ollama）已启动且拉了模型 {}",
            resp.status(),
            cfg.model
        ));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("embedding 响应解析失败: {e}"))?;
    let vec: Vec<f32> = body
        .get("embeddings")
        .and_then(|x| x.get(0))
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().filter_map(|f| f.as_f64().map(|f| f as f32)).collect())
        .ok_or_else(|| "embedding 响应缺少 embeddings[0]".to_string())?;
    if vec.is_empty() {
        return Err("embedding 返回空向量".into());
    }
    Ok(vec)
}

/// 记忆条目稳定 id：ts + 文本哈希前 8 位（同一 entry 重复 reindex 幂等）。
pub fn entry_id(ts: i64, text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(ts.to_le_bytes());
    h.update(text.as_bytes());
    format!("{ts}-{}", hex_short(&h.finalize()))
}

fn hex_short(digest: &[u8]) -> String {
    digest.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

fn schema_for(dim: i32) -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("text", DataType::Utf8, false),
        Field::new("tags", DataType::Utf8, false),
        Field::new("ts", DataType::Int64, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), dim),
            false,
        ),
    ]))
}

/// 造一行数据的 RecordBatch（dim 由向量长度决定）。
fn batch_for(id: &str, text: &str, tags: &str, ts: i64, vec: &[f32]) -> RecordBatch {
    let dim = vec.len() as i32;
    let fsl = FixedSizeListArray::from_iter_primitive::<Float32Type, _, _>(
        std::iter::once(Some(vec.iter().map(|v| Some(*v)).collect::<Vec<_>>())),
        dim,
    );
    RecordBatch::try_new(
        schema_for(dim),
        vec![
            Arc::new(StringArray::from(vec![id])),
            Arc::new(StringArray::from(vec![text])),
            Arc::new(StringArray::from(vec![tags])),
            Arc::new(Int64Array::from(vec![ts])),
            Arc::new(fsl),
        ],
    )
    .expect("向量批构造失败")
}

/// 写入/更新一条向量（同 id 先删后写，幂等）。表不存在时由 batch 推断
/// schema 建表（dim 与 embedding 模型绑定）。
pub async fn upsert_vector_at(
    db: &lancedb::Connection,
    id: &str,
    text: &str,
    tags: &str,
    ts: i64,
    vec: &[f32],
) -> Result<(), String> {
    let batch = batch_for(id, text, tags, ts, vec);
    match open_table(db).await? {
        // 表已存在：幂等先删同 id 再写。
        Some(table) => {
            let _ = table.delete(&format!("id = '{id}'")).await;
            table
                .add(reader_for(batch))
                .execute()
                .await
                .map_err(|e| format!("写向量失败: {e}"))?;
        }
        // 首条写入：由 batch 推断 schema 建表（dim 与 embedding 模型绑定）。
        None => {
            db.create_table(TABLE, reader_for(batch))
                .execute()
                .await
                .map_err(|e| format!("创建向量表失败: {e}"))?;
        }
    }
    Ok(())
}

/// 写入/更新一条向量（AppHandle 包装，表不存在延迟建表）。
pub async fn upsert_vector(
    app: &AppHandle,
    id: &str,
    text: &str,
    tags: &str,
    ts: i64,
    vec: &[f32],
) -> Result<(), String> {
    let db = open_db(app).await?;
    upsert_vector_at(&db, id, text, tags, ts, vec).await
}

/// 语义检索：query 向量最近邻 top_k，score = 1/(1+L2 距离) 归一。
pub async fn search_at(
    db: &lancedb::Connection,
    query_vec: Vec<f32>,
    top_k: u32,
) -> Result<Vec<Value>, String> {
    let Some(table) = open_table(db).await? else {
        return Ok(vec![]);
    };
    // 空表直接返回，避免 nearest_to 在零行表上报错。
    if table
        .count_rows(None)
        .await
        .map_err(|e| format!("读向量表行数失败: {e}"))?
        == 0
    {
        return Ok(vec![]);
    }
    let batches = table
        .query()
        .nearest_to(query_vec)
        .map_err(|e| format!("向量检索失败: {e}"))?
        .limit(top_k as usize)
        .execute()
        .await
        .map_err(|e| format!("向量检索失败: {e}"))?;

    let mut out = Vec::new();
    let mut batches = batches;
    while let Some(rb) = batches.next().await {
        let rb = rb.map_err(|e| format!("读检索结果失败: {e}"))?;
        let n = rb.num_rows();
        let col = |name: &str| rb.column_by_name(name);
        let ids = col("id").and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let texts = col("text").and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let tags = col("tags").and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let dist: Option<Vec<f32>> = col("distance")
            .map(|c| {
                if let Some(a) = c.as_any().downcast_ref::<Float32Array>() {
                    a.values().to_vec()
                } else if let Some(a) = c.as_any().downcast_ref::<Float64Array>() {
                    a.values().iter().map(|v| *v as f32).collect()
                } else {
                    vec![1.0; n]
                }
            })
            .or_else(|| Some(vec![1.0; n]));
        for i in 0..n {
            let id = ids.map(|a| a.value(i)).unwrap_or_default().to_string();
            let text = texts.map(|a| a.value(i)).unwrap_or_default().to_string();
            let tags_v = tags.map(|a| a.value(i)).unwrap_or_default().to_string();
            let d = dist.as_ref().and_then(|v| v.get(i).copied()).unwrap_or(1.0);
            out.push(json!({
                "id": id,
                "text": text,
                "tags": tags_v,
                "distance": d,
                "score": 1.0 / (1.0 + d.max(0.0)),
            }));
        }
    }
    Ok(out)
}

/// 语义检索（AppHandle 包装）。
pub async fn search_vectors(
    app: &AppHandle,
    query_vec: Vec<f32>,
    top_k: u32,
) -> Result<Vec<Value>, String> {
    let db = open_db(app).await?;
    search_at(&db, query_vec, top_k).await
}

/// 全量重建：读 `<root>/memory/memory.jsonl` 逐条向量化写入。
/// embedding 失败的条目跳过并计数（不阻塞其余条目）。
pub async fn reindex(app: &AppHandle) -> Result<Value, String> {
    let cfg = EmbedConfig::load(app);
    let Some(root) = crate::agent_ops::agent_ops_root(app) else {
        return Err("取配置目录失败".into());
    };
    let f = root.join("memory").join("memory.jsonl");
    let text = std::fs::read_to_string(&f).unwrap_or_default();
    let mut indexed = 0usize;
    let mut skipped = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            skipped += 1;
            continue;
        };
        let ts = v.get("ts").and_then(|x| x.as_i64()).unwrap_or(0);
        let Some(entry_text) = v.get("text").and_then(|x| x.as_str()).map(str::to_string) else {
            skipped += 1;
            continue;
        };
        let tags = v
            .get("tags")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|t| t.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        match embed(&cfg, &entry_text).await {
            Ok(vec) => {
                let id = entry_id(ts, &entry_text);
                if let Err(e) = upsert_vector(app, &id, &entry_text, &tags, ts, &vec).await {
                    errors.push(e);
                } else {
                    indexed += 1;
                }
            }
            Err(e) => {
                skipped += 1;
                if errors.len() < 3 {
                    errors.push(e);
                }
            }
        }
    }
    Ok(json!({ "indexed": indexed, "skipped": skipped, "errors": errors }))
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 向量库状态（表是否存在 + 条目数 + embedding 配置）。
#[tauri::command(async)]
pub async fn memory_vec_status(app: AppHandle) -> Result<Value, String> {
    let cfg = EmbedConfig::load(&app);
    let db = open_db(&app).await?;
    let table = open_table(&db).await?;
    let rows: usize = match &table {
        Some(t) => t
            .count_rows(None)
            .await
            .map_err(|e| format!("读行数失败: {e}"))?,
        None => 0,
    };
    Ok(json!({
        "table": TABLE,
        "exists": table.is_some(),
        "rows": rows,
        "embedding": { "baseUrl": cfg.base_url, "model": cfg.model },
        "agentToolNote": "Pi 进程内的 memory_recall 工具为词面召回；向量结果供外壳层消费",
    }))
}

/// 语义检索：`query` 向量化后最近邻 top_k。
#[tauri::command(async)]
pub async fn memory_vec_search(
    app: AppHandle,
    query: String,
    top_k: Option<u32>,
) -> Result<Vec<Value>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("检索词不能为空".into());
    }
    let cfg = EmbedConfig::load(&app);
    let vec = embed(&cfg, &q).await?;
    search_vectors(&app, vec, top_k.unwrap_or(8)).await
}

/// 全量重建向量索引。
#[tauri::command(async)]
pub async fn memory_vec_reindex(app: AppHandle) -> Result<Value, String> {
    reindex(&app).await
}

/// `agent_memory_store` 落盘后的向量化钩子：fire-and-forget，失败仅记日志。
pub fn spawn_upsert(app: &AppHandle, ts: i64, text: String, tags: Vec<String>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let cfg = EmbedConfig::load(&app);
        let tags_str = tags.join(",");
        match embed(&cfg, &text).await {
            Ok(vec) => {
                let id = entry_id(ts, &text);
                if let Err(e) = upsert_vector(&app, &id, &text, &tags_str, ts, &vec).await {
                    eprintln!("[memory_vec] upsert 失败: {e}");
                }
            }
            Err(e) => eprintln!("[memory_vec] embed 失败（词面主路径不受影响）: {e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_id_is_stable_and_distinct() {
        let a = entry_id(123, "同一段文本");
        let b = entry_id(123, "同一段文本");
        let c = entry_id(456, "同一段文本");
        assert_eq!(a, b, "同 ts 同文本应幂等");
        assert_ne!(a, c, "不同 ts 应不同 id");
    }

    #[test]
    fn embed_parses_ollama_shape() {
        // stub HTTP server 返回 Ollama /api/embed 形状，验证解析与 URL 拼接。
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let body = r#"{"embeddings":[[0.25,0.5,0.75,1.0]]}"#;
            // 循环 accept：探活连接与真实请求各占一次连接，不能只应答一次。
            // 必须先读完请求头再应答：不等请求就抢答会让 hyper 报
            // "received unexpected message from connection"。
            for mut stream in listener.incoming().flatten() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                );
            }
        });
        // 沙箱等受限环境可能禁 loopback 出站：连不上就跳过（解析逻辑在正常环境仍被验证）。
        if std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            std::time::Duration::from_secs(2),
        )
        .is_err()
        {
            eprintln!("[skip] loopback 出站被禁（沙箱环境），跳过 HTTP stub 验证");
            return;
        }
        let cfg = EmbedConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            model: "bge-m3".into(),
        };
        let vec = tauri::async_runtime::block_on(embed(&cfg, "测试文本")).unwrap();
        assert_eq!(vec, vec![0.25, 0.5, 0.75, 1.0]);
    }

    #[test]
    fn embed_error_mentions_service_hint() {
        // 端口上没有服务 → 请求失败，错误信息应提示 embedding 服务。
        let cfg = EmbedConfig {
            base_url: "http://127.0.0.1:9".into(), // discard 端口，必拒绝
            model: "x".into(),
        };
        let err = tauri::async_runtime::block_on(embed(&cfg, "t")).unwrap_err();
        assert!(err.contains("embedding"), "got: {err}");
    }

    #[test]
    fn batch_shape_matches_schema() {
        let batch = batch_for("id1", "文本", "tag1,tag2", 42, &[0.1, 0.2, 0.3, 0.4]);
        assert_eq!(batch.num_rows(), 1);
        assert_eq!(batch.num_columns(), 5);
        let fsl = batch
            .column(4)
            .as_any()
            .downcast_ref::<FixedSizeListArray>()
            .unwrap();
        assert_eq!(fsl.value_length(), 4);
    }

    #[test]
    fn lancedb_roundtrip_upsert_and_search() {
        // 真库往返：临时目录建表（首条 create_table 路径）→ 写 3 条向量
        // → 幂等（删同 id 再写，行数不变）→ 最近邻命中预期条目。
        let dir = std::env::temp_dir().join(format!("pi-mvec-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = tauri::async_runtime::block_on(async {
            lancedb::connect(dir.to_str().unwrap())
                .execute()
                .await
                .unwrap()
        });

        // 表不存在 → 首条走 create_table（与 upsert_vector 的 None 分支同路径）。
        let first = batch_for("a", "数据库连接失败排查", "", 1, &[1.0f32, 0.0, 0.0]);
        tauri::async_runtime::block_on(async {
            db.create_table(TABLE, reader_for(first))
                .execute()
                .await
                .unwrap();
        });

        let table = tauri::async_runtime::block_on(async { open_table(&db).await.unwrap().unwrap() });
        let rows = vec![
            ("b", "前端样式美化", &[0.0f32, 1.0, 0.0]),
            ("c", "发布上线检查清单", &[0.0, 0.0, 1.0]),
        ];
        for (id, text, vec) in rows {
            let batch = batch_for(id, text, "", 1, vec.as_slice());
            tauri::async_runtime::block_on(async {
                table.add(reader_for(batch)).execute().await.unwrap();
            });
        }
        // 幂等：同 id 重写（删后写）不报错、行数不变。
        tauri::async_runtime::block_on(async {
            table.delete("id = 'a'").await.unwrap();
            table
                .add(reader_for(batch_for(
                    "a",
                    "数据库连接失败排查",
                    "",
                    1,
                    &[1.0, 0.0, 0.0],
                )))
                .execute()
                .await
                .unwrap();
        });
        let count = tauri::async_runtime::block_on(async { table.count_rows(None).await.unwrap() });
        assert_eq!(count, 3, "删后写应保持 3 行");

        let hits = tauri::async_runtime::block_on(async {
            let batches = table
                .query()
                .nearest_to(vec![0.9f32, 0.1, 0.0])
                .unwrap()
                .limit(1)
                .execute()
                .await
                .unwrap();
            let mut out = Vec::new();
            let mut batches = batches;
            while let Some(b) = batches.next().await {
                let rb = b.unwrap();
                let ids = rb
                    .column_by_name("id")
                    .unwrap()
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .unwrap();
                out.push(ids.value(0).to_string());
            }
            out
        });
        assert_eq!(hits, vec!["a".to_string()], "最近邻应命中数据库条目");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ---------------------------------------------------------------------------
// A/B 召回基准（B5 待办①）：词面 vs 向量 vs 混合(RRF)
//
// 目的：用 20 组「同义改写」查询对，量化向量召回相对词面召回在「字面不同、
// 意思相同」场景上的提升。真实语义需本机 Ollama（bge-m3）；离线态用确定性
// 合成语义代理（概念词表聚类）验证「管线 + 方法论」端到端可跑，明确标注
// 非真实模型评估。切真实路径：`EMBED_REAL=1 cargo test ab_recall`。
// ---------------------------------------------------------------------------

#[cfg(test)]
mod ab_bench {
    use super::*;
    use std::collections::HashMap;

    // —— 词面评分（忠实移植 agent-memory.ts 的 queryTerms/scoreOf）——
    fn query_terms(q: &str) -> Vec<String> {
        let seps: &[char] = &[
            ' ', ',', '，', '。', ';', '；', '!', '！', '?', '？', '\'', '"', '(', ')', '（', '）',
            '[', ']', '{', '}',
        ];
        let mut terms = Vec::new();
        for seg in q.to_lowercase().split(|c: char| seps.contains(&c)) {
            if seg.is_empty() {
                continue;
            }
            let has_cjk = seg.chars().any(|c| {
                ('\u{3000}'..='\u{9fff}').contains(&c)
                    || ('\u{3040}'..='\u{30ff}').contains(&c)
                    || ('\u{ac00}'..='\u{d7af}').contains(&c)
            });
            if has_cjk {
                let chars: Vec<char> = seg.chars().collect();
                if chars.len() == 1 {
                    terms.push(chars[0].to_string());
                } else {
                    for i in 0..chars.len() - 1 {
                        terms.push(chars[i..i + 2].iter().collect());
                    }
                }
            } else {
                terms.push(seg.to_string());
            }
        }
        let mut uniq = Vec::new();
        for t in terms {
            if !uniq.contains(&t) {
                uniq.push(t);
            }
        }
        uniq
    }

    fn lex_score(q: &str, text: &str, tags: &str, ts: i64, now: i64) -> f64 {
        let text = text.to_lowercase();
        let tags = tags.to_lowercase();
        let terms = query_terms(q);
        if terms.is_empty() {
            return 0.0;
        }
        let mut hit = 0.0_f64;
        for t in &terms {
            let w = (t.chars().count().min(4)) as f64;
            if text.contains(t.as_str()) {
                hit += w;
            }
            if tags.contains(t.as_str()) {
                hit += w * 2.0;
            }
        }
        if hit == 0.0 {
            return 0.0;
        }
        let coverage = hit / (terms.len() as f64 * 4.0 * 3.0);
        let age_days = ((now - ts).max(0) as f64) / 86_400_000.0;
        let recency = 0.2 * 0.5_f64.powf(age_days / 7.0);
        coverage + recency
    }

    // —— 离线合成语义代理（确定性；贴合 20 组语料的领域概念词表）——
    const CONCEPTS: &[&str] = &[
        "数据库", "db", "sql", "连接", "connect", "网络", "network", "失败", "fail", "error",
        "排查", "debug", "前端", "frontend", "样式", "style", "ui", "发布", "deploy", "上线",
        "release", "记忆", "memory", "检索", "search", "召回", "recall", "向量", "vector",
        "embedding", "语义", "semantic", "权限", "auth", "登录", "login", "密码", "password",
        "缓存", "cache", "redis", "性能", "perf", "慢", "slow", "依赖", "dependency", "包",
        "测试", "test", "日志", "log", "配置", "config", "接口", "api", "构建", "build",
        "仓库", "git", "容器", "docker", "镜像", "image",
    ];

    struct Lcg(u64);
    impl Lcg {
        fn new(seed: u64) -> Self {
            Lcg(seed)
        }
        fn next_u64(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.0
        }
        fn next_f32(&mut self) -> f32 {
            (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32 * 2.0 - 1.0
        }
    }

    fn concept_vec(idx: usize, dim: usize) -> Vec<f32> {
        let mut r = Lcg::new(0xABCDEF ^ ((idx as u64).wrapping_mul(2654435761)));
        (0..dim).map(|_| r.next_f32()).collect()
    }

    fn embed_proxy(text: &str) -> Vec<f32> {
        let dim = 32;
        let low = text.to_lowercase();
        let mut vec = vec![0.0f32; dim];
        let mut matched = false;
        for (i, c) in CONCEPTS.iter().enumerate() {
            if low.contains(&c.to_lowercase()) {
                for (j, v) in concept_vec(i, dim).iter().enumerate() {
                    vec[j] += v;
                }
                matched = true;
            }
        }
        if !matched {
            for ch in low.chars() {
                let h = ch as usize;
                for (j, v) in concept_vec(h % CONCEPTS.len().max(1) + 100, dim)
                    .iter()
                    .enumerate()
                {
                    vec[j] += v * 0.3;
                }
            }
        }
        let norm = (vec.iter().map(|x| x * x).sum::<f32>()).sqrt();
        if norm > 0.0 {
            for x in &mut vec {
                *x /= norm;
            }
        }
        vec
    }

    // 语料：0..=19 为改写对目标条目，20..=25 为干扰项。
    const CORPUS: &[(&str, &str)] = &[
        ("PostgreSQL 数据库连接失败（ERR_HOST_UNREACHABLE）排查", "db,网络"),
        ("前端 CSS 样式在 Safari 下错位修复", "前端,样式"),
        ("生产环境发布上线回滚流程 checklist", "发布,上线"),
        ("Redis 缓存雪崩与击穿的应对方案", "缓存,redis"),
        ("记忆层 memory_recall 词面召回评分逻辑", "记忆,检索"),
        ("语义向量召回用 bge-m3 做 embedding", "向量,embedding,语义"),
        ("JWT 权限校验在网关层统一拦截", "权限,登录"),
        ("用户密码使用 bcrypt 加盐哈希存储", "密码"),
        ("npm 依赖版本冲突导致构建失败", "依赖,构建"),
        ("Vitest 组件测试在 jsdom 下超时", "测试"),
        ("Tauri 应用日志输出到哪查", "日志"),
        ("OpenAI 接口限流 429 重试策略", "接口,api"),
        ("LanceDB 向量表延迟建表按维度", "向量"),
        ("Ollama 本地 embedding 服务拉起", "embedding"),
        ("前端水印注入构建产物时间戳", "前端,构建"),
        ("Redis 慢查询拖垮接口性能", "缓存,redis,性能"),
        ("记忆语义召回解决同义改写盲区", "记忆,语义"),
        ("网关鉴权失败返回 401 统一处理", "权限,接口"),
        ("SQLite 全文检索 FTS5 配置", "检索"),
        ("Docker 镜像构建层缓存优化", "构建,缓存"),
        // 干扰项
        ("Git 分支合并冲突解决", "仓库,git"),
        ("Kubernetes Pod 调度 Pending 排查", "容器"),
        ("React 状态管理用 Pinia", "前端"),
        ("Python 异步 asyncio 事件循环", "测试"),
        ("Nginx 反向代理配置 HTTPS", "配置,接口"),
        ("PostgreSQL 索引 B-tree 调优", "db,性能"),
    ];

    // 20 组同义改写查询：query → 目标条目索引（与 CORPUS 0..=19 对齐）。
    const PAIRS: &[&str] = &[
        "连不上数据库怎么排查网络问题",
        "网页在 Safari 上 UI 布局乱了怎么修",
        "部署到生产后怎么回退版本",
        "redis 缓存集中失效怎么防击穿",
        "长期记忆怎么被检索召回",
        "语义向量检索怎么实现",
        "没权限调用接口被拦截怎么办",
        "用户密码如何安全保存",
        "装包后 build 报错版本不对",
        "单测跑着跑着卡住超时才挂",
        "桌面端运行日志在哪里看",
        "调外部 api 被限流怎么重试",
        "向量数据库怎么按维度建索引",
        "本机跑文本向量化模型",
        "打包时给页面打时间水印",
        "缓存操作太慢影响响应速度",
        "语义相同的记忆查不到",
        "调用接口返回未授权怎么处理",
        "本地库怎么做全文搜索",
        "容器打包怎么利用缓存加速",
    ];

    const KS: [usize; 3] = [1, 3, 5];

    fn hit_at(order: &[String], target: &str) -> [bool; 3] {
        let mut out = [false; 3];
        for k in 0..3 {
            out[k] = order.iter().take(KS[k]).any(|x| x == target);
        }
        out
    }

    fn rrf_fuse(lex: &[String], vec: &[String], n: usize) -> Vec<String> {
        const K: f64 = 60.0;
        let mut score: HashMap<String, f64> = HashMap::new();
        for (rank, id) in lex.iter().enumerate() {
            *score.entry(id.clone()).or_insert(0.0) += 1.0 / (K + (rank + 1) as f64);
        }
        for (rank, id) in vec.iter().enumerate() {
            *score.entry(id.clone()).or_insert(0.0) += 1.0 / (K + (rank + 1) as f64);
        }
        let mut ids: Vec<String> = (0..n).map(|i| format!("c{i}")).collect();
        ids.sort_by(|a, b| score[b].partial_cmp(&score[a]).unwrap_or(std::cmp::Ordering::Equal));
        ids
    }

    #[derive(Default)]
    struct AbAgg {
        lex: [u64; 3],
        vec: [u64; 3],
        hyb: [u64; 3],
        vec_retrieved: u64,
        vec_only: u64, // 向量命中而词面未命中的改写对数量
        n: u64,
    }

    async fn do_embed(text: &str, real: bool) -> Vec<f32> {
        if real {
            if let Ok(v) = embed(&EmbedConfig::default(), text).await {
                return v;
            }
        }
        embed_proxy(text)
    }

    async fn run_ab(real: bool) -> AbAgg {
        let tag = if real { "real" } else { "proxy" };
        let dir = std::env::temp_dir().join(format!(
            "pi-ab-{}-{}-{}",
            std::process::id(),
            tag,
            if real { "r" } else { "p" }
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = lancedb::connect(dir.to_str().unwrap())
            .execute()
            .await
            .unwrap();

        // 建索引
        for (i, (text, tags)) in CORPUS.iter().enumerate() {
            let v = do_embed(text, real).await;
            upsert_vector_at(&db, &format!("c{i}"), text, tags, 0, &v)
                .await
                .unwrap();
        }

        let mut agg = AbAgg::default();
        println!(
            "
=== B5 A/B 召回基准（mode={}）===",
            if real {
                "REAL bge-m3 (Ollama /api/embed)"
            } else {
                "OFFLINE PROXY (合成语义，非真实模型)"
            }
        );
        println!(
            "{:<5}{:<40}{:<6}{:<6}{:<6}{:<6}{:<6}{:<6}",
            "pair", "query", "L@1", "L@3", "L@5", "V@1", "V@3", "V@5"
        );
        for (pi, q) in PAIRS.iter().enumerate() {
            let target = format!("c{pi}");
            let mut lex: Vec<(usize, f64)> = CORPUS
                .iter()
                .enumerate()
                .map(|(i, (t, tg))| (i, lex_score(q, t, tg, 0, i64::MAX)))
                .collect();
            lex.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            let lex_order: Vec<String> = lex.iter().map(|(i, _)| format!("c{i}")).collect();

            let qv = do_embed(q, real).await;
            let res = search_at(&db, qv, CORPUS.len() as u32).await.unwrap();
            let vec_order: Vec<String> = res
                .iter()
                .map(|v| v["id"].as_str().unwrap().to_string())
                .collect();
            let hyb_order = rrf_fuse(&lex_order, &vec_order, CORPUS.len());

            let lh = hit_at(&lex_order, &target);
            let vh = hit_at(&vec_order, &target);
            let hh = hit_at(&hyb_order, &target);
            for k in 0..3 {
                agg.lex[k] += lh[k] as u64;
                agg.vec[k] += vh[k] as u64;
                agg.hyb[k] += hh[k] as u64;
            }
            if !lh[2] && vh[2] {
                agg.vec_only += 1;
            }
            if !vec_order.is_empty() {
                agg.vec_retrieved += 1;
            }
            agg.n += 1;
            let trunc: String = if q.chars().count() > 38 {
                q.chars().take(38).collect()
            } else {
                q.to_string()
            };
            println!(
                "{:<5}{:<40}{:<6}{:<6}{:<6}{:<6}{:<6}{:<6}",
                pi,
                trunc,
                if lh[0] { 1 } else { 0 },
                if lh[1] { 1 } else { 0 },
                if lh[2] { 1 } else { 0 },
                if vh[0] { 1 } else { 0 },
                if vh[1] { 1 } else { 0 },
                if vh[2] { 1 } else { 0 },
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
        agg
    }

    #[test]
    fn ab_recall() {
        let real_probe = std::env::var("EMBED_REAL").is_ok()
            && tauri::async_runtime::block_on(embed(&EmbedConfig::default(), "probe")).is_ok();
        let agg = tauri::async_runtime::block_on(run_ab(real_probe));
        let n = agg.n as f64;

        // 结构断言（两种模式都成立）：向量检索管线对每条查询都返回结果。
        assert_eq!(
            agg.vec_retrieved, agg.n,
            "向量检索应对每条查询返回结果（管线异常）"
        );

        if real_probe {
            println!(
                "
AGGREGATE hit-rate (n={}):",
                agg.n
            );
            println!(
                "  词面 lexical : @1 {:.0}%  @3 {:.0}%  @5 {:.0}%",
                agg.lex[0] as f64 / n * 100.0,
                agg.lex[1] as f64 / n * 100.0,
                agg.lex[2] as f64 / n * 100.0
            );
            println!(
                "  向量 vector  : @1 {:.0}%  @3 {:.0}%  @5 {:.0}%",
                agg.vec[0] as f64 / n * 100.0,
                agg.vec[1] as f64 / n * 100.0,
                agg.vec[2] as f64 / n * 100.0
            );
            println!(
                "  混合 hybrid  : @1 {:.0}%  @3 {:.0}%  @5 {:.0}%",
                agg.hyb[0] as f64 / n * 100.0,
                agg.hyb[1] as f64 / n * 100.0,
                agg.hyb[2] as f64 / n * 100.0
            );
            println!(
                "  向量独有命中（词面漏召、向量补回）: {} / {} 对",
                agg.vec_only, agg.n
            );
            // 真实语义嵌入：向量在「同义改写」集上应明显优于词面。
            assert!(
                agg.vec[2] > agg.lex[2],
                "真实 embedding 下向量召回应优于词面：vec@5={} lex@5={}",
                agg.vec[2],
                agg.lex[2]
            );
        } else {
            println!(
                "
[OFFLINE PROXY] 上表为合成语义（概念词表聚类）的管线冒烟结果，数值不反映真实语义召回质量；"
            );
            println!(
                "[OFFLINE PROXY] 真实 A/B：启动 Ollama 拉 bge-m3 后 `EMBED_REAL=1 cargo test ab_recall -- --nocapture`"
            );
            println!(
                "[OFFLINE PROXY] 管线校验通过：向量检索对 {} 条查询全部返回结果（vec_retrieved={}）。",
                agg.n, agg.vec_retrieved
            );
        }
    }
}
