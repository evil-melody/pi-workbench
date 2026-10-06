/// 前端日志桥：把 webview 侧的 console 输出与关键路径打点原样打到终端。
///
/// 「点了没反应」「整窗卡死」这类缺陷只发生在真实运行时 —— 类型检查、构建、
/// 渲染回归全抓不到，而桌面 App 里 devtools 又不常驻。没有这条桥，排障只能靠猜。
/// 有了它，用户复现时打开终端就能看到前端最后走到了哪一步。
///
/// **必须 async**：日志在高频路径上调用（`message_update` 节流后的落点除外），
/// 且 `invoke` 本身有 IPC 开销，不能落在主线程上。
#[tauri::command(async)]
pub fn app_log(level: String, mut msg: String) {
    // 超长消息截断：避免一条巨型 JSON 把终端刷爆，反而看不到后续现场。
    const MAX: usize = 1000;
    msg = msg.replace('\n', " ");
    if msg.chars().count() > MAX {
        let taken: String = msg.chars().take(MAX).collect();
        msg = format!("{}…（已截断 {} 字符）", taken, msg.chars().count() - MAX);
    }
    eprintln!("[web:{}] {}", level, msg);
}
