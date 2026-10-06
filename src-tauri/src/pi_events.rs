//! `pi://event` 记录增强：给消费端补出它拿不到的信息。
//!
//! 桥对 Pi 内核协议只做「响应 / 事件」二分转发，原样透传。代价是内核不发的
//! 细粒度事件（工具调用、工具返回）前端永远拿不到——因为没人生成它们。
//!
//! 这里只做三件**确定没人在做**的事，其余一概不碰：
//!
//! 1. **补元信息**：`pi_ts`（桥接收时刻）、`pi_seq`（跨连接单调序号）。
//!    内核事件的到达顺序在长跑会话里不可靠，前端排序需要稳定锚点。
//! 2. **结构化过程标量**：子进程退出时桥 emit 的是裸字符串 `"process_exit"`。
//!    改成对象后与其余事件同构，消费端不必再为两种形状各写一套分支。
//! 3. **工具事件合成**：`message_update` 的内层块里若带工具调用 /
//!    工具返回，桥展开成独立事件推送。这样轨迹面板不必等内核补协议，
//!    而消费端 `classifyEvent` 已能识别 `tool_call` / `tool_result`。
//!
//! 合成一律**按字段形状推断**，不硬编码内核事件名：内核一旦自己发了这些
//! 事件，外层 type 就不是 `message_update`，不会进入合成分支，因此不会重复。
//! 不认得的形状一律原样透传——**绝不丢事件**。

use serde_json::{json, Value};

/// 附加到每条事件上的元信息。
pub struct EventMeta {
    /// 本次内核连接内单调序号，用于前端稳定排序。
    pub seq: u64,
    /// 桥接收该事件的 Unix 毫秒时间戳。
    pub ts_ms: u64,
}

/// 事件名归一：小写去分隔符，让 `turn/start` 与 `turn_start` 等价。
fn norm_type(raw: &str) -> String {
    let mut s = raw.trim().to_lowercase();
    for sep in [' ', '-', '/', '_'] {
        s = s.replace(sep, "");
    }
    s
}

/// 取事件的 `type` 字段（只接受字符串）。
fn event_type(v: &Value) -> Option<String> {
    v.get("type")
        .and_then(|t| t.as_str())
        .map(|t| t.to_string())
}

/// 事件里第一个非空字符串的取值键。
fn first_string(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(|x| x.as_str()) {
            if !s.trim().is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// 事件里第一个对象型取值键。
fn first_object<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    for k in keys {
        if let Some(o) = v.get(*k) {
            if o.is_object() {
                return Some(o);
            }
        }
    }
    None
}

const NAME_KEYS: &[&str] = &["toolName", "tool_name", "toolname", "tool", "name"];
const ARG_KEYS: &[&str] = &["args", "arguments", "parameters", "input"];
const OUT_KEYS: &[&str] = &["output", "result", "content", "value"];

/// 给事件打上元信息（对象事件）。非对象原样返回。
fn with_meta(mut v: Value, meta: &EventMeta) -> Value {
    if let Some(obj) = v.as_object_mut() {
        obj.insert("pi_ts".into(), Value::Number(meta.ts_ms.into()));
        obj.insert("pi_seq".into(), Value::Number(meta.seq.into()));
    }
    v
}

/// 合成一条工具事件。
fn synthetic(kind: &str, name: &str, detail: Option<Value>, meta: &EventMeta) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("type".into(), Value::String(kind.to_string()));
    obj.insert(
        "toolName".into(),
        Value::String(name.trim().to_string().to_lowercase()),
    );
    if let Some(d) = detail {
        obj.insert("toolArgs".into(), d);
    }
    with_meta(Value::Object(obj), meta)
}

/// 内层块：是否是工具调用，以及它是 call 还是 result。
///
/// 返回 `(kind, name, detail)`；`None` 表示不是工具块。
fn tool_block(block: &Value) -> Option<(String, String, Option<Value>)> {
    let t = event_type(block)?;
    if !norm_type(&t).starts_with("tool") {
        return None;
    }
    let name = first_string(block, NAME_KEYS).unwrap_or_else(|| "unknown".to_string());
    // 有输出字段 → 这是一次执行的结果；否则按调用处理。
    let has_out = OUT_KEYS
        .iter()
        .any(|k| block.get(*k).map(|x| !x.is_null()).unwrap_or(false));
    if has_out {
        let detail = OUT_KEYS
            .iter()
            .find_map(|k| block.get(*k).filter(|x| !x.is_null()))
            .cloned();
        Some(("tool_result".to_string(), name, detail))
    } else {
        let detail = first_object(block, ARG_KEYS).cloned();
        Some(("tool_call".to_string(), name, detail))
    }
}

/// 对一条原始事件做增强，结果追加进 `out`。
///
/// 返回新增条数。`out` 在入口处即已有原始事件，调用方按序消费即可。
pub fn enrich(raw: &Value, meta: &EventMeta, out: &mut Vec<Value>) {
    // 过程标量：子进程退出信号。结构化后与其余事件同构。
    if let Value::String(s) = raw {
        if norm_type(s) == "processexit" {
            out.push(with_meta(
                json!({ "type": "process_exit", "success": true }),
                meta,
            ));
        } else {
            out.push(raw.clone());
        }
        return;
    }

    if !raw.is_object() {
        out.push(raw.clone());
        return;
    }

    out.push(with_meta(raw.clone(), meta));

    // 工具事件合成：只在 message_update 的内层块里做，避免与内核
    // 自己发的独立 tool_call 事件重复（那种情况外层 type 就是 tool_call）。
    let outer = event_type(raw).unwrap_or_default();
    if norm_type(&outer) != "messageupdate" {
        return;
    }
    let Some(assistant) = first_object(raw, &["assistantMessageEvent"]) else {
        return;
    };
    let Some((kind, name, detail)) = tool_block(assistant) else {
        return;
    };
    out.push(synthetic(&kind, &name, detail, meta));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> EventMeta {
        EventMeta {
            seq: 7,
            ts_ms: 1_700_000_000_000,
        }
    }

    fn msg_update(inner: Value) -> Value {
        json!({ "type": "message_update", "assistantMessageEvent": inner })
    }

    #[test]
    fn bare_process_exit_is_structured() {
        let m = meta();
        let mut out = Vec::new();
        enrich(&Value::String("process_exit".into()), &m, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(event_type(&out[0]).as_deref(), Some("process_exit"));
        assert_eq!(out[0].get("pi_seq").unwrap(), &json!(7));
        assert_eq!(out[0].get("pi_ts").unwrap(), &json!(1_700_000_000_000u64));
    }

    #[test]
    fn bare_other_scalar_passes_through() {
        let m = meta();
        let mut out = Vec::new();
        enrich(&Value::String("agent_settled".into()), &m, &mut out);
        assert_eq!(out.len(), 1);
        assert!(out[0].is_string());
    }

    #[test]
    fn non_object_passes_through() {
        let m = meta();
        let mut out = Vec::new();
        enrich(&Value::Null, &m, &mut out);
        enrich(&Value::Number(42.into()), &m, &mut out);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn object_gets_meta_without_losing_payload() {
        let m = meta();
        let raw = json!({ "type": "agent_settled" });
        let mut out = Vec::new();
        enrich(&raw, &m, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(event_type(&out[0]).as_deref(), Some("agent_settled"));
        assert!(out[0].get("pi_seq").is_some());
        assert!(out[0].get("pi_ts").is_some());
    }

    #[test]
    fn tool_use_block_synthesizes_tool_call() {
        let m = meta();
        let raw = msg_update(json!({
            "type": "tool_use",
            "name": "Read",
            "args": { "path": "/tmp/a.rs" }
        }));
        let mut out = Vec::new();
        enrich(&raw, &m, &mut out);
        // 原始事件 + 合成事件
        assert_eq!(out.len(), 2);
        assert_eq!(event_type(&out[1]).as_deref(), Some("tool_call"));
        assert_eq!(
            out[1].get("toolName").and_then(|v| v.as_str()),
            Some("read")
        );
        assert!(out[1].get("toolArgs").is_some());
        assert_eq!(out[1].get("pi_seq").unwrap(), &json!(7));
    }

    #[test]
    fn tool_result_block_synthesizes_tool_result() {
        let m = meta();
        let raw = msg_update(json!({
            "type": "tool_result",
            "toolName": "Read",
            "output": "fn main() {}"
        }));
        let mut out = Vec::new();
        enrich(&raw, &m, &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(event_type(&out[1]).as_deref(), Some("tool_result"));
        assert_eq!(
            out[1].get("toolName").and_then(|v| v.as_str()),
            Some("read")
        );
        assert_eq!(
            out[1].get("toolArgs").and_then(|v| v.as_str()),
            Some("fn main() {}")
        );
    }

    #[test]
    fn text_delta_adds_nothing() {
        let m = meta();
        let raw = msg_update(json!({ "type": "text_delta", "delta": "hi" }));
        let mut out = Vec::new();
        enrich(&raw, &m, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(event_type(&out[0]).as_deref(), Some("message_update"));
    }

    #[test]
    fn independent_tool_event_is_not_duplicated() {
        let m = meta();
        let raw = json!({ "type": "tool_call", "name": "Bash" });
        let mut out = Vec::new();
        enrich(&raw, &m, &mut out);
        assert_eq!(out.len(), 1, "内核自带 tool_call 不应再合成一条");
    }

    #[test]
    fn meta_seq_stays_unique_across_events() {
        let m = meta();
        let a = json!({ "type": "agent_settled" });
        let b = json!({ "type": "agent_settled" });
        let mut out = Vec::new();
        enrich(&a, &m, &mut out);
        enrich(&b, &EventMeta { seq: 8, ..m }, &mut out);
        let seqs: Vec<u64> = out
            .iter()
            .filter_map(|v| v.get("pi_seq").and_then(|s| s.as_u64()))
            .collect();
        assert_eq!(seqs, vec![7, 8]);
    }
}
