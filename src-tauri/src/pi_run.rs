//! 运行链路信封：给内核事件补 `runId` / `agentId` / `spanId` / `parentSpanId` 与起止时间。
//!
//! 内核协议本身不带这三个归属字段，但事件流里已经有足够的先后关系：
//! `agent_start → turn_start → message_start/end → tool_execution_* → agent_settled`。
//! 这里在桥的 stdout 线程里做一次纯增量标注——**不改内核、不改事件语义**，
//! 只往事件对象里多插几个键：
//!
//! - `runId` / `runStartedAt`：一次请求（一条 prompt）对应的运行。
//!   由 `pi_send` 下发 prompt 时开新 run；内核没经 prompt 就开跑（无人值守兜底）时
//!   在 `agent_start` 惰性补一个。
//! - `agentId`：主理人固定 `main`；团队成员走各自子进程的调度日志，不经过这里。
//! - `spanId` / `parentSpanId` / `spanKind`：环节归属。`turn` 为根，`model` 挂 turn，
//!   `tool` / `gate` 挂当前 model（没有 model 时挂 turn），`retry` 挂 turn。
//! - `spanStartedAt` / `spanEndedAt`：环节起止（Unix ms）。结束事件才写 ended。
//!
//! **向后兼容**：老 journal 没有这些键，读取方按缺省降级即可；这里只插入、
//! 从不删除或改名任何既有字段，也不假设某个事件一定存在。

use std::collections::HashMap;

use serde_json::{json, Map, Value};

/// 主理人（内核单进程）的 agent 标识。
pub const AGENT_MAIN: &str = "main";

const PROMPT_CLIP: usize = 160;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 事件名归一：小写去分隔符，`turn/start` 与 `turn_start` 等价。
fn norm(raw: &str) -> String {
    let mut s = raw.trim().to_lowercase();
    for sep in [' ', '-', '/', '_'] {
        s = s.replace(sep, "");
    }
    s
}

fn clip_prompt(s: &str) -> String {
    let one = s.replace(['\n', '\r'], " ");
    let one = one.trim();
    if one.chars().count() <= PROMPT_CLIP {
        return one.to_string();
    }
    let cut: String = one.chars().take(PROMPT_CLIP).collect();
    format!("{cut}…")
}

#[derive(Clone)]
struct Span {
    id: String,
    started_at: u64,
    parent: Option<String>,
}

impl Span {
    fn new(id: String, started_at: u64, parent: Option<String>) -> Self {
        Self {
            id,
            started_at,
            parent,
        }
    }
}

/// 本次运行挂载的专家身份。链路图靠它把环节归到具体专家。
#[derive(Clone, Debug, Default)]
pub struct ExpertTag {
    pub id: String,
    pub name: String,
}

/// 一次运行 + 当前打开的环节。字段只在桥线程里读写（外层 Mutex 由调用方持有）。
#[derive(Default)]
pub struct RunTracker {
    run_id: Option<String>,
    run_started_at: u64,
    runs: u64,
    spans: u64,
    turn: Option<Span>,
    model: Option<Span>,
    retry: Option<Span>,
    tools: HashMap<String, Span>,
    gates: HashMap<String, Span>,
    /// 当前运行的专家：跨 follow_up / steer 保持不变，直到下一次显式切换。
    expert: Option<ExpertTag>,
}

impl RunTracker {
    fn next_span(&mut self, prefix: &str, started_at: u64, parent: Option<String>) -> Span {
        self.spans += 1;
        Span::new(format!("{prefix}-{}", self.spans), started_at, parent)
    }

    /// 确保当前有一个 run；返回 `(runId, runStartedAt)`。
    fn ensure_run(&mut self, now: u64) -> (String, u64) {
        if let Some(id) = &self.run_id {
            return (id.clone(), self.run_started_at);
        }
        self.runs += 1;
        let id = format!("run-{now:x}-{}", self.runs);
        self.run_id = Some(id.clone());
        self.run_started_at = now;
        (id, now)
    }

    /// 开一次新运行（一条 prompt 一条）。返回可直接推送/落盘的 `run_start` 事件。
    pub fn begin_run(&mut self, prompt: &str) -> Value {
        let now = now_ms();
        self.runs += 1;
        let id = format!("run-{now:x}-{}", self.runs);
        self.run_id = Some(id.clone());
        self.run_started_at = now;
        self.turn = None;
        self.model = None;
        self.retry = None;
        self.tools.clear();
        self.gates.clear();
        let mut ev = json!({
            "type": "run_start",
            "runId": id,
            "agentId": AGENT_MAIN,
            "runStartedAt": now,
            "prompt": clip_prompt(prompt),
            "pi_ts": now,
        });
        if let Some(expert) = &self.expert {
            ev["expertId"] = json!(expert.id);
            ev["expertName"] = json!(expert.name);
        }
        ev
    }

    /// 当前 runId（没有在飞的运行时为 None）。排队消息落 journal 时用它挂归属。
    pub fn current_run(&self) -> Option<String> {
        self.run_id.clone()
    }

    /// 切换/清空当前专家身份（下一轮 prompt 生效，已开的事件不回溯）。
    pub fn set_expert(&mut self, expert: Option<ExpertTag>) {
        self.expert = expert;
    }

    /// 审批结论：配对 `extension_ui_request` 开出的 gate span，返回 `gate_decision` 事件。
    pub fn gate_decision(&mut self, gate_id: &str, confirmed: bool) -> Option<Value> {
        let now = now_ms();
        let span = self.gates.remove(gate_id)?;
        let (run_id, run_started_at) = self.ensure_run(now);
        let mut obj = Map::new();
        obj.insert("type".into(), json!("gate_decision"));
        obj.insert("runId".into(), json!(run_id));
        obj.insert("runStartedAt".into(), json!(run_started_at));
        obj.insert("agentId".into(), json!(AGENT_MAIN));
        obj.insert("gateId".into(), json!(gate_id));
        obj.insert("confirmed".into(), json!(confirmed));
        obj.insert("spanId".into(), json!(span.id));
        obj.insert("spanKind".into(), json!("gate"));
        obj.insert("spanStartedAt".into(), json!(span.started_at));
        obj.insert("spanEndedAt".into(), json!(now));
        if let Some(p) = span.parent {
            obj.insert("parentSpanId".into(), json!(p));
        }
        obj.insert("pi_ts".into(), json!(now));
        Some(Value::Object(obj))
    }

    fn run_fields(&self, obj: &mut Map<String, Value>) {
        if let Some(id) = &self.run_id {
            obj.insert("runId".into(), json!(id));
            if self.run_started_at > 0 {
                obj.insert("runStartedAt".into(), json!(self.run_started_at));
            }
            obj.insert("agentId".into(), json!(AGENT_MAIN));
            if let Some(expert) = &self.expert {
                obj.insert("expertId".into(), json!(expert.id));
                obj.insert("expertName".into(), json!(expert.name));
            }
        }
    }

    fn span_fields(obj: &mut Map<String, Value>, kind: &str, span: &Span, ended_at: Option<u64>) {
        obj.insert("spanKind".into(), json!(kind));
        obj.insert("spanId".into(), json!(span.id));
        obj.insert("spanStartedAt".into(), json!(span.started_at));
        if let Some(p) = &span.parent {
            obj.insert("parentSpanId".into(), json!(p));
        }
        if let Some(end) = ended_at {
            obj.insert("spanEndedAt".into(), json!(end));
        }
    }

    /// 当前环节的父节点：模型优先，其次轮次。
    fn current_parent(&self) -> Option<String> {
        self.model
            .as_ref()
            .or(self.turn.as_ref())
            .map(|s| s.id.clone())
    }

    /// 给一条事件补信封字段。非对象事件一律不碰。
    pub fn stamp(&mut self, ev: &mut Value, now: u64) {
        let Some(obj) = ev.as_object_mut() else {
            return;
        };
        let ty = obj
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let nt = norm(&ty);
        let msg_role = obj
            .get("message")
            .and_then(|m| m.get("role"))
            .and_then(|r| r.as_str())
            .unwrap_or_default()
            .to_string();

        match nt.as_str() {
            // 一次运行开始：可能在 prompt 之前（无人值守），惰性补 run。
            "agentstart" => {
                let _ = self.ensure_run(now);
                self.run_fields(obj);
                // 上一轮的 turn 还开着却来了新 agent_start：按旧轮收口，不叠两个根。
                if let Some(t) = self.turn.take() {
                    Self::span_fields(obj, "turn", &t, Some(now));
                    self.model = None;
                }
            }
            "turnstart" => {
                let _ = self.ensure_run(now);
                self.run_fields(obj);
                let span = self.next_span("turn", now, None);
                Self::span_fields(obj, "turn", &span, None);
                self.turn = Some(span);
                self.model = None;
                self.retry = None;
            }
            "turnend" => {
                self.run_fields(obj);
                if let Some(span) = self.turn.take() {
                    Self::span_fields(obj, "turn", &span, Some(now));
                }
                self.model = None;
            }
            "messagestart" => {
                let _ = self.ensure_run(now);
                self.run_fields(obj);
                if msg_role == "assistant" {
                    let parent = self.current_parent();
                    let span = self.next_span("model", now, parent);
                    Self::span_fields(obj, "model", &span, None);
                    self.model = Some(span);
                }
            }
            "messageend" => {
                self.run_fields(obj);
                if msg_role == "assistant" {
                    if let Some(span) = self.model.take() {
                        Self::span_fields(obj, "model", &span, Some(now));
                    }
                }
            }
            "messageupdate" | "messagedelta" => {
                self.run_fields(obj);
                if let Some(span) = self.model.clone() {
                    Self::span_fields(obj, "model", &span, None);
                } else if let Some(span) = self.turn.clone() {
                    Self::span_fields(obj, "turn", &span, None);
                }
            }
            "toolexecutionstart" => {
                let _ = self.ensure_run(now);
                self.run_fields(obj);
                let call_id = obj
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let parent = self.current_parent();
                let span = self.next_span("tool", now, parent);
                Self::span_fields(obj, "tool", &span, None);
                if let Some(id) = call_id {
                    self.tools.insert(id, span);
                }
            }
            "toolexecutionend" => {
                self.run_fields(obj);
                let call_id = obj
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let span = call_id
                    .as_ref()
                    .and_then(|id| self.tools.remove(id))
                    .or_else(|| {
                        let parent = self.current_parent();
                        Some(Span::new(format!("tool-{now:x}"), now, parent))
                    });
                if let Some(span) = span {
                    Self::span_fields(obj, "tool", &span, Some(now));
                }
            }
            // 工具门 / 扩展审批：confirm 请求开 gate span，等待决定的时长就是这一段的耗时。
            "extensionuirequest" => {
                let method = obj
                    .get("method")
                    .and_then(|v| v.as_str())
                    .unwrap_or("confirm");
                if method != "confirm" {
                    return;
                }
                let _ = self.ensure_run(now);
                self.run_fields(obj);
                if let Some(id) = obj.get("id").and_then(|v| v.as_str()).map(str::to_string) {
                    let parent = self.current_parent();
                    let span = self.next_span("gate", now, parent);
                    Self::span_fields(obj, "gate", &span, None);
                    self.gates.insert(id, span);
                }
            }
            "autoretrystart" => {
                let _ = self.ensure_run(now);
                self.run_fields(obj);
                let parent = self.turn.as_ref().map(|s| s.id.clone());
                let span = self.next_span("retry", now, parent);
                Self::span_fields(obj, "retry", &span, None);
                self.retry = Some(span);
            }
            "autoretryend" => {
                self.run_fields(obj);
                if let Some(span) = self.retry.take() {
                    Self::span_fields(obj, "retry", &span, Some(now));
                }
            }
            // 一轮收口：turn span 结束，run 本身仍在（重试/后续轮次可能续跑）。
            "agentsettled" | "agentend" => {
                self.run_fields(obj);
                if let Some(span) = self.turn.take() {
                    Self::span_fields(obj, "turn", &span, Some(now));
                }
                self.model = None;
                if nt == "agentsettled" {
                    obj.insert("runEndedAt".into(), json!(now));
                    obj.insert("runStatus".into(), json!("ok"));
                    self.run_id = None;
                    self.run_started_at = 0;
                    self.tools.clear();
                    self.gates.clear();
                    self.retry = None;
                }
            }
            "processexit" => {
                self.run_fields(obj);
                if self.run_id.is_some() {
                    obj.insert("runEndedAt".into(), json!(now));
                    obj.insert("runStatus".into(), json!("interrupted"));
                }
                self.run_id = None;
                self.run_started_at = 0;
                self.turn = None;
                self.model = None;
                self.retry = None;
                self.tools.clear();
                self.gates.clear();
            }
            _ => {
                // 其余事件（session_open / entry_appended / compaction_* 等）：
                // 在 run 内就带上归属，超出 run 边界的不硬塞。
                self.run_fields(obj);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamped(tracker: &mut RunTracker, mut ev: Value, at: u64) -> Value {
        tracker.stamp(&mut ev, at);
        ev
    }

    #[test]
    fn run_start_carries_prompt_and_id() {
        let mut tr = RunTracker::default();
        let ev = tr.begin_run("帮我改个 bug");
        assert_eq!(ev["type"], "run_start");
        assert_eq!(ev["agentId"], AGENT_MAIN);
        assert!(ev["runId"].as_str().unwrap().starts_with("run-"));
        assert_eq!(ev["prompt"], "帮我改个 bug");
    }

    #[test]
    fn turn_and_model_and_tool_spans_pair() {
        let mut tr = RunTracker::default();
        tr.begin_run("x");
        let turn = stamped(&mut tr, json!({ "type": "turn_start" }), 100);
        let turn_id = turn["spanId"].as_str().unwrap().to_string();
        assert_eq!(turn["spanKind"], "turn");

        let ms = stamped(
            &mut tr,
            json!({ "type": "message_start", "message": { "role": "assistant" } }),
            110,
        );
        let model_id = ms["spanId"].as_str().unwrap().to_string();
        assert_eq!(ms["parentSpanId"], turn_id);

        let ts = stamped(
            &mut tr,
            json!({ "type": "tool_execution_start", "toolCallId": "c1", "toolName": "bash" }),
            120,
        );
        assert_eq!(ts["parentSpanId"], model_id);
        assert_eq!(ts["runId"], turn["runId"]);

        let te = stamped(
            &mut tr,
            json!({ "type": "tool_execution_end", "toolCallId": "c1", "isError": true }),
            180,
        );
        assert_eq!(te["spanId"], ts["spanId"]);
        assert_eq!(te["spanStartedAt"], 120);
        assert_eq!(te["spanEndedAt"], 180);

        let me = stamped(
            &mut tr,
            json!({ "type": "message_end", "message": { "role": "assistant" } }),
            200,
        );
        assert_eq!(me["spanId"], model_id);
        assert_eq!(me["spanEndedAt"], 200);

        let se = stamped(&mut tr, json!({ "type": "agent_settled" }), 220);
        assert_eq!(se["spanEndedAt"], 220);
        assert_eq!(se["runStatus"], "ok");
        assert_eq!(se["runEndedAt"], 220);
    }

    #[test]
    fn gate_decision_pairs_with_request() {
        let mut tr = RunTracker::default();
        tr.begin_run("x");
        let req = stamped(
            &mut tr,
            json!({ "type": "extension_ui_request", "id": "g1", "method": "confirm" }),
            300,
        );
        assert_eq!(req["spanKind"], "gate");
        let gate_span = req["spanId"].as_str().unwrap().to_string();
        let dec = tr.gate_decision("g1", false).expect("应配对到 gate span");
        assert_eq!(dec["type"], "gate_decision");
        assert_eq!(dec["confirmed"], false);
        assert_eq!(dec["spanId"], gate_span);
        assert_eq!(dec["spanStartedAt"], 300);
        assert!(dec["spanEndedAt"].as_u64().unwrap() >= 300);
        // 同一个 id 只能配对一次。
        assert!(tr.gate_decision("g1", true).is_none());
    }

    #[test]
    fn non_confirm_ui_request_is_untouched() {
        let mut tr = RunTracker::default();
        tr.begin_run("x");
        let ev = stamped(
            &mut tr,
            json!({ "type": "extension_ui_request", "id": "n1", "method": "notify" }),
            10,
        );
        assert!(ev.get("spanKind").is_none());
    }

    #[test]
    fn events_outside_run_do_not_gain_run_fields() {
        let mut tr = RunTracker::default();
        let ev = stamped(&mut tr, json!({ "type": "session_open", "cwd": "/tmp" }), 1);
        assert!(ev.get("runId").is_none());
    }

    #[test]
    fn process_exit_closes_open_run_as_interrupted() {
        let mut tr = RunTracker::default();
        tr.begin_run("x");
        stamped(&mut tr, json!({ "type": "turn_start" }), 1);
        let ev = stamped(&mut tr, json!({ "type": "process_exit" }), 9);
        assert_eq!(ev["runStatus"], "interrupted");
        assert_eq!(ev["runEndedAt"], 9);
    }

    #[test]
    fn legacy_event_without_type_is_safe() {
        let mut tr = RunTracker::default();
        let ev = stamped(&mut tr, json!({ "foo": 1 }), 1);
        assert_eq!(ev["foo"], 1);
    }
}
