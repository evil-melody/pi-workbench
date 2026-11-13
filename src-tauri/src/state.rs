use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use serde_json::Value;

#[derive(Default)]
pub struct PiState {
    /// Pi 子进程。
    pub child: Mutex<Option<Child>>,
    /// 写入 Pi stdin 的通道。
    pub stdin_tx: Mutex<Option<Sender<String>>>,
    /// 待匹配的 RPC 响应：命令 id → 响应通道。
    /// 全双工的关键：命令发出后不等独占管道，响应按 id 回到各自的发起方，
    /// 因此多个命令可并发下发，且响应乱序/交错（事件夹在中间）仍能正确配对。
    pub pending: Mutex<HashMap<String, Sender<Value>>>,
    /// 命令发号源（跨线程共享，必须串行自增）。
    pub seq: Mutex<u64>,
    /// 当前子进程的启动签名（cwd + provider + model）。
    /// 签名不变就复用已在跑的内核：Pi 的 cwd 在进程启动时固定、没有 set_cwd RPC，
    /// 所以「常驻」只能在同签名内成立；换项目/换模型才允许重启。
    pub launch_sig: Mutex<Option<String>>,
    /// 当前子进程的工作目录。pi_restart 需要用它原地重启（换模型/换工具白名单后）。
    pub launch_cwd: Mutex<Option<String>>,
    /// 事件 journal 落盘路径：每条 pi://event 追加写入该 jsonl，供审计/回放（B2）。
    /// 未启动时为 None；每次 pi_start 重新指向 <app_config_dir>/.pi/journal/events.jsonl。
    pub journal_path: Mutex<Option<PathBuf>>,
    /// 当前轮次的开始时刻（Unix ms），空 = 空闲。
    /// 由 `pi://event` 的 agent_start / agent_settled 维护，`pi_status` 对外暴露。
    /// 主动任务调度必须先读它：内核是单进程单任务，并行发起第二轮只会互相踩。
    pub running_since: Mutex<Option<u64>>,
    /// 最近一次内核退出（码, 时刻）：主动任务据此区分「正常停」与「崩溃」，决定是否重试。
    pub last_exit: Mutex<Option<(i32, u64)>>,
    /// 最近一次内核活动时刻（Unix ms）：启动、下发、每条 stdout 记录都会刷新。
    /// 驻留后台时据此判断「空闲满 5 分钟」，回收内核进程。
    pub last_event_at: AtomicU64,
    /// 停止世代：`stop_child` 每次主动停子进程自增。
    /// 读线程拿自己启动时的世代比对——对不上就是计划内停止，
    /// 不触发「意外退出 → 自动重启」，也就不会把换项目误判成崩溃。
    pub stop_epoch: AtomicU64,
    /// 上次自动重启时刻（Unix ms）：崩溃循环的保护，60s 内只重启一次。
    pub auto_restart_at: Mutex<Option<u64>>,
    /// 运行链路信封：给每条内核事件补 runId / spanId / 起止时间。
    /// 只由桥线程与下发命令写入；读 journal 的老数据不经过它。
    pub run: Mutex<crate::pi_run::RunTracker>,
}

#[derive(Default)]
pub struct ProjectsState {
    /// 项目的全部领域数据（project / config 修订 / 计划项 / 资产 / 任务 / 活动）。
    /// 放在一个 store 里而不是各存一份，避免「计划项改了但项目时间戳没动」这类不一致。
    pub store: Mutex<crate::projects::ProjectStore>,
    pub active: Mutex<Option<String>>,
}

/// 当前生效角色 id（决定 Pi 每轮注入哪段系统提示）。
#[derive(Default)]
pub struct RolesState {
    pub current: Mutex<Option<String>>,
}

/// MCP Gateway：每个连接是一个长驻 stdio 子进程，工具按需从 tools/list 聚合。
#[derive(Default)]
pub struct McpState {
    pub servers: Mutex<HashMap<String, McpServer>>,
    pub pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    /// 全局单调 JSON-RPC id 源。pending 表是全局共享的，
    /// 若每个 server 各起计数器，两个 server 都会发出 id=1，响应会被错配给前一个 server。
    pub seq: Arc<AtomicU64>,
}

impl McpState {
    pub fn next_id(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::SeqCst) + 1
    }
}

pub struct McpServer {
    pub child: Child,
    pub stdin_tx: Sender<String>,
    pub tools: Vec<Value>,
    pub command: String,
    pub args: Vec<String>,
}

impl McpServer {
    pub fn new(
        child: Child,
        stdin_tx: Sender<String>,
        tools: Vec<Value>,
        command: String,
        args: Vec<String>,
    ) -> Self {
        Self {
            child,
            stdin_tx,
            tools,
            command,
            args,
        }
    }
}
