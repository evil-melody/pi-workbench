use std::fs;

/// 把一段已序列化的会话 JSON 写到用户指定的路径。
///
/// 路径来自前端 `plugin-dialog` 的保存框（用户显式选定），后端只负责落盘，
/// 不替用户决定位置——这样导出落在哪完全由用户控制，也避免后端写任意路径。
#[tauri::command]
pub fn conversation_export(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("写入会话文件失败: {e}"))
}

/// 读取用户指定的会话 JSON 文件，原样返回字符串交给前端反序列化。
///
/// 校验放在前端（`deserializeConversation`）：后端只做「读文件 + 透传」，
/// 不去猜业务格式，调用方拿到字符串自己决定怎么解析。
#[tauri::command]
pub fn conversation_import(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("读取会话文件失败: {e}"))
}
