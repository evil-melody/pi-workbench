use std::collections::HashMap;
use std::process::Child;
use std::sync::mpsc::Sender;
use std::sync::atomic::{AtomicU64, Ordering};
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
