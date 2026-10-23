//! 治理五件套（轻量版）：identity / access / audit / model-policy / usage。
//!
//! 对照 WORKDSH-ALIGN-26 第四节 P3：个人工具定位下不做企业级
//! 转发代理 / 多租户 / RBAC，只做单机可落地的最小闭环：
//!
//! - **identity**：操作者身份（`governance.json` 的 `identity.operator`），
//!   经 `governance_get` 暴露，前端把它注入任务前缀，模型知道服务对象。
//! - **access**：`model_policy` 在 `pi_start` 前校验，拒绝名单内的
//!   provider/model 直接拒绝启动内核（准入闸门）。
//! - **audit**：复用 B2 事件 journal（`pi://event` 落盘），审批/工具调用
//!   已在其中；本模块不重复落盘。
//! - **model-policy**：见 access；配置持久化在 `<app_config_dir>/governance.json`。
//! - **usage**：从 journal 的 `message_end` 事件解析 assistant 消息的
//!   `provider/model/usage`，按模型聚合 calls/tokens/cost。
//!
//! 聚合与校验均为纯函数，便于单测；命令层只做 IO 与状态编排。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

use crate::state::PiState;

// ---------------------------------------------------------------------------
// 配置（identity + model-policy）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IdentityConfig {
    /// 操作者标识。前端注入任务前缀；留空表示未配置。
    #[serde(default = "default_operator")]
    pub operator: String,
}

fn default_operator() -> String {
    "local-operator".to_string()
}

impl Default for IdentityConfig {
    fn default() -> Self {
        Self {
            operator: default_operator(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ModelPolicy {
    /// 允许的 provider 白名单；空 = 不限制。
    #[serde(default)]
    pub allowed_providers: Vec<String>,
    /// 拒绝名单：匹配模型名或 `provider/model` 全名，命中即拒绝启动。
    #[serde(default)]
    pub denied_models: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct GovernanceConfig {
    #[serde(default)]
    pub identity: IdentityConfig,
    #[serde(default)]
    pub model_policy: ModelPolicy,
}

/// 模型准入校验：白名单非空时 provider 必须在内；模型命中拒绝名单即拒绝。
///
/// 匹配规则：`denied_models` 里的条目与「模型名」或「`provider/model` 全名」
/// 精确比较（大小写不敏感），不做通配——个人工具下显式列出即可，避免误伤。
pub fn enforce_model_policy(
    policy: &ModelPolicy,
    provider: Option<&str>,
    model: Option<&str>,
) -> Result<(), String> {
    // 未显式配置模型时不拦截：默认 provider 无法可靠判定，
    // 准入闸门只管用户显式选择的 provider/model。
    if provider.is_none() && model.is_none() {
        return Ok(());
    }
    let provider = provider.map(|p| p.trim().to_lowercase()).unwrap_or_default();
    let model = model.map(|m| m.trim().to_lowercase()).unwrap_or_default();

    if !policy.allowed_providers.is_empty() {
        let allowed = policy
            .allowed_providers
            .iter()
            .any(|p| p.trim().to_lowercase() == provider);
        if !allowed {
            return Err(format!("model-policy：provider「{provider}」不在允许名单"));
        }
    }
    for denied in &policy.denied_models {
        let d = denied.trim().to_lowercase();
        if d.is_empty() {
            continue;
        }
        if d == model || d == format!("{provider}/{model}") {
            return Err(format!("model-policy：模型「{provider}/{model}」在拒绝名单"));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 用量聚合（usage）
// ---------------------------------------------------------------------------

/// 单模型的用量条目。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct UsageEntry {
    pub provider: String,
    pub model: String,
    pub calls: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total_tokens: u64,
    /// 成本合计（模型计价表的货币单位，由内核按 usage 折算）。
    pub cost_total: f64,
}

/// journal 用量聚合结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct UsageSummary {
    pub entries: Vec<UsageEntry>,
    pub total_calls: u64,
    pub total_tokens: u64,
    pub total_cost: f64,
    /// 参与统计的首末事件时间戳（`pi_ts`，Unix 毫秒）。
    pub first_ts_ms: Option<u64>,
    pub last_ts_ms: Option<u64>,
}

/// 从一条 journal 行提取 `(provider, model, usage)`。
///
/// 只认形状不认顺序：`type` 归一为 `message_end` 且内层 `message.role`
/// 是 assistant 才有效；字段缺失/类型不对一律返回 None（坏行跳过）。
fn parse_usage_event(line: &str) -> Option<(String, String, Value, u64)> {
    let ev: Value = serde_json::from_str(line).ok()?;
    let ty = ev.get("type")?.as_str()?.replace(['-', '_', '/'], "");
    if ty != "messageend" {
        return None;
    }
    let msg = ev.get("message")?;
    if msg.get("role")?.as_str()? != "assistant" {
        return None;
    }
    let provider = msg
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let model = msg
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let usage = msg.get("usage").cloned().unwrap_or(Value::Null);
    let ts = ev.get("pi_ts").and_then(|v| v.as_u64()).unwrap_or(0);
    Some((provider, model, usage, ts))
}

fn u64_of(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

/// 聚合 journal 文本为用量汇总。`since_ms` 过滤早于该时间戳的事件。
pub fn aggregate_usage(journal: &str, since_ms: Option<u64>) -> UsageSummary {
    let mut by_model: std::collections::BTreeMap<(String, String), UsageEntry> =
        std::collections::BTreeMap::new();
    let mut first_ts: Option<u64> = None;
    let mut last_ts: Option<u64> = None;

    for line in journal.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((provider, model, usage, ts)) = parse_usage_event(line) else {
            continue;
        };
        if let Some(since) = since_ms {
            if ts != 0 && ts < since {
                continue;
            }
        }
        if ts != 0 {
            first_ts = Some(first_ts.map_or(ts, |a: u64| a.min(ts)));
            last_ts = Some(last_ts.map_or(ts, |a: u64| a.max(ts)));
        }
        let e = by_model
            .entry((provider.clone(), model.clone()))
            .or_insert_with(|| UsageEntry {
                provider,
                model,
                ..UsageEntry::default()
            });
        e.calls += 1;
        e.input += u64_of(&usage, "input");
        e.output += u64_of(&usage, "output");
        e.cache_read += u64_of(&usage, "cacheRead");
        e.cache_write += u64_of(&usage, "cacheWrite");
        e.total_tokens += u64_of(&usage, "totalTokens");
        e.cost_total += usage
            .get("cost")
            .and_then(|c| c.get("total"))
            .and_then(|c| c.as_f64())
            .unwrap_or(0.0);
    }

    let mut summary = UsageSummary {
        entries: by_model.into_values().collect(),
        ..UsageSummary::default()
    };
    summary.entries.sort_by(|a, b| {
        b.total_tokens
            .cmp(&a.total_tokens)
            .then_with(|| a.provider.cmp(&b.provider))
            .then_with(|| a.model.cmp(&b.model))
    });
    for e in &summary.entries {
        summary.total_calls += e.calls;
        summary.total_tokens += e.total_tokens;
        summary.total_cost += e.cost_total;
    }
    summary.first_ts_ms = first_ts;
    summary.last_ts_ms = last_ts;
    summary
}

// ---------------------------------------------------------------------------
// 状态与命令
// ---------------------------------------------------------------------------

/// 治理状态：配置常驻内存（启动时从盘加载），路径指向 `governance.json`。
pub struct GovernanceState {
    pub config: Mutex<GovernanceConfig>,
    pub path: Mutex<Option<PathBuf>>,
}

impl Default for GovernanceState {
    fn default() -> Self {
        Self {
            config: Mutex::new(GovernanceConfig::default()),
            path: Mutex::new(None),
        }
    }
}

/// 启动时从 `<app_config_dir>/governance.json` 加载；文件缺失用默认值。
pub fn load(app: &AppHandle, state: &GovernanceState) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let path = dir.join("governance.json");
    let config = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    *state.path.lock().unwrap() = Some(path);
    *state.config.lock().unwrap() = config;
}

/// 读取当前治理配置（identity + model-policy）。
/// 必须 async：它是发送链路（taskContextPreamble）的第二跳，非 async 命令
/// 跑主线程，会排在被堵的主线程队列里让前端 await 永不返回——表现为
/// 「终端有 dispatch 日志、页面停在落地页毫无反应」。
#[tauri::command(async)]
pub fn governance_get(state: State<GovernanceState>) -> GovernanceConfig {
    state.config.lock().unwrap().clone()
}

/// journal 用量聚合（usage 五件套）：从 B2 事件 journal 统计 tokens/cost。
///
/// `since_ms`（可选）：只统计该时间戳之后的事件（本地日/周报场景）。
#[tauri::command(async)]
pub fn governance_usage(
    pi: State<PiState>,
    since_ms: Option<u64>,
) -> Result<UsageSummary, String> {
    let path = pi
        .journal_path
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "journal 未启用（内核未启动）".to_string())?;
    let file = fs::File::open(&path)
        .map_err(|e| format!("读取 journal 失败（{path:?}）: {e}"))?;
    let mut buf = String::new();
    let reader = BufReader::new(file);
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        buf.push_str(&line);
        buf.push('\n');
    }
    Ok(aggregate_usage(&buf, since_ms))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn policy(allowed: Vec<&str>, denied: Vec<&str>) -> ModelPolicy {
        ModelPolicy {
            allowed_providers: allowed.into_iter().map(String::from).collect(),
            denied_models: denied.into_iter().map(String::from).collect(),
        }
    }

    #[test]
    fn policy_allows_when_lists_empty() {
        assert!(enforce_model_policy(&policy(vec![], vec![]), Some("anthropic"), Some("claude-x")).is_ok());
    }

    #[test]
    fn policy_rejects_disallowed_provider() {
        let p = policy(vec!["anthropic"], vec![]);
        let err = enforce_model_policy(&p, Some("openai"), Some("gpt-x")).unwrap_err();
        assert!(err.contains("不在允许名单"), "got: {err}");
    }

    #[test]
    fn policy_rejects_denied_model_by_name() {
        let p = policy(vec![], vec!["gpt-x"]);
        let err = enforce_model_policy(&p, Some("openai"), Some("GPT-X")).unwrap_err();
        assert!(err.contains("拒绝名单"), "got: {err}");
    }

    #[test]
    fn policy_rejects_denied_model_by_full_name() {
        let p = policy(vec![], vec!["openai/gpt-x"]);
        assert!(enforce_model_policy(&p, Some("openai"), Some("gpt-x")).is_err());
        // 名字部分相同但 provider 不同 → 不命中全名条目。
        assert!(enforce_model_policy(&p, Some("anthropic"), Some("gpt-x")).is_ok());
    }

    #[test]
    fn policy_allows_when_no_model_configured() {
        // 未配置模型（默认启动）不拦截——准入闸门只管显式选择。
        assert!(enforce_model_policy(&policy(vec!["anthropic"], vec!["x"]), None, None).is_ok());
    }

    fn usage_line(provider: &str, model: &str, input: u64, output: u64, cost: f64, ts: u64) -> String {
        json!({
            "type": "message_end",
            "pi_ts": ts,
            "message": {
                "role": "assistant",
                "provider": provider,
                "model": model,
                "usage": {
                    "input": input,
                    "output": output,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "totalTokens": input + output,
                    "cost": { "total": cost }
                }
            }
        })
        .to_string()
    }

    #[test]
    fn usage_aggregates_by_model_and_sums_totals() {
        let journal = format!(
            "{}\n{}\n{}\n{}\n",
            usage_line("anthropic", "claude-a", 100, 50, 0.3, 1000),
            usage_line("anthropic", "claude-a", 200, 10, 0.2, 2000),
            usage_line("openai", "gpt-b", 10, 5, 0.01, 1500),
            usage_line("anthropic", "claude-a", 0, 0, 0.0, 3000),
        );
        let s = aggregate_usage(&journal, None);
        assert_eq!(s.entries.len(), 2);
        assert_eq!(s.total_calls, 4);
        assert_eq!(s.total_tokens, 100 + 50 + 200 + 10 + 10 + 5);
        let (c_cost, g_cost) = {
            let ca = s.entries.iter().find(|e| e.model == "claude-a").unwrap();
            let gb = s.entries.iter().find(|e| e.model == "gpt-b").unwrap();
            (ca.cost_total, gb.cost_total)
        };
        assert!((c_cost - 0.5).abs() < 1e-9);
        assert!((g_cost - 0.01).abs() < 1e-9);
        assert_eq!(s.first_ts_ms, Some(1000));
        assert_eq!(s.last_ts_ms, Some(3000));
        // 排序：按 totalTokens 降序，claude-a（370）在前。
        assert_eq!(s.entries[0].model, "claude-a");
    }

    #[test]
    fn usage_since_filter_excludes_older_events() {
        let journal = format!(
            "{}\n{}\n",
            usage_line("anthropic", "claude-a", 100, 50, 0.3, 1000),
            usage_line("anthropic", "claude-a", 200, 10, 0.2, 5000),
        );
        let s = aggregate_usage(&journal, Some(2000));
        assert_eq!(s.total_calls, 1);
        assert_eq!(s.total_tokens, 210);
        assert_eq!(s.first_ts_ms, Some(5000));
    }

    #[test]
    fn usage_skips_bad_lines_and_non_assistant() {
        let journal = format!(
            "not-json\n{{}}\n{}\n{}\n",
            json!({"type": "message_start", "message": {"role": "assistant", "usage": {"input": 9}}}),
            json!({"type": "message_end", "message": {"role": "user", "usage": {"input": 7}}}),
        );
        let s = aggregate_usage(&journal, None);
        assert!(s.entries.is_empty());
        assert_eq!(s.total_calls, 0);
    }

    #[test]
    fn usage_defaults_missing_fields() {
        // 缺 provider/model/usage 的 assistant 消息：按 unknown 聚合、数值为 0。
        let journal = json!({
            "type": "message_end",
            "message": { "role": "assistant", "content": [] }
        })
        .to_string();
        let s = aggregate_usage(&journal, None);
        assert_eq!(s.total_calls, 1);
        assert_eq!(s.total_tokens, 0);
        assert_eq!(s.entries[0].provider, "unknown");
    }
}
