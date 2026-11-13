//! 后台驻留 / 登录项 / 托盘菜单（阶段 1 条目 3）。
//!
//! 进程模型：主窗口关闭只 `hide`，Tauri 进程与调度线程继续存活；Dock 图标保留。
//! 托盘菜单是驻留态的唯一入口：打开主窗口、暂停主动任务、查看下次任务、彻底退出。
//!
//! 边界：
//! - 登录项默认关闭，用户在设置页显式开启；
//! - 关窗行为首次询问一次，结果持久化到 `background.json`，设置页可改回「每次询问」；
//! - 彻底退出（托盘 / Dock / Cmd+Q）会停内核并清理预授权策略文件；
//! - 驻留态下重复启动由单实例插件聚焦已有窗口，不会出现第二个调度器。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;

use crate::proactive::{self, ProactiveState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseAction {
    Ask,
    Background,
    Quit,
}

impl Default for CloseAction {
    fn default() -> Self {
        Self::Ask
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prefs {
    #[serde(default, alias = "closeAction")]
    pub close_action: CloseAction,
    #[serde(default)]
    pub paused: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            close_action: CloseAction::Ask,
            paused: false,
        }
    }
}

#[derive(Default)]
pub struct BackgroundState {
    pub prefs: Mutex<Prefs>,
}

/// 托盘菜单里需要动态更新的项：文案与暂停勾选。
pub struct TrayHandles {
    pub open: MenuItem<tauri::Wry>,
    pub status: MenuItem<tauri::Wry>,
    pub pause: CheckMenuItem<tauri::Wry>,
    pub quit: MenuItem<tauri::Wry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackgroundInfo {
    pub close_action: CloseAction,
    pub paused: bool,
    pub autostart: bool,
}

fn prefs_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("background.json"))
}

fn persist(app: &AppHandle, prefs: &Prefs) {
    let Some(path) = prefs_file(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let Ok(body) = serde_json::to_string_pretty(prefs) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, body).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

/// 启动时读取偏好；文件缺失或损坏都回落到「每次询问 + 不暂停」。
pub fn load(app: &AppHandle, state: &BackgroundState) {
    let Some(path) = prefs_file(app) else { return };
    let Ok(raw) = fs::read_to_string(path) else {
        return;
    };
    let Ok(prefs) = serde_json::from_str::<Prefs>(&raw) else {
        return;
    };
    *state.prefs.lock().unwrap() = prefs;
}

pub fn close_action(app: &AppHandle) -> CloseAction {
    app.state::<BackgroundState>()
        .prefs
        .lock()
        .unwrap()
        .close_action
}

pub fn is_paused(app: &AppHandle) -> bool {
    app.state::<BackgroundState>().prefs.lock().unwrap().paused
}

fn info(app: &AppHandle, state: &BackgroundState) -> BackgroundInfo {
    let prefs = state.prefs.lock().unwrap().clone();
    BackgroundInfo {
        close_action: prefs.close_action,
        paused: prefs.paused,
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
    }
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit("background://changed", ());
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 托盘菜单：打开主窗口 / 状态行 / 暂停 / 退出。
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let paused = is_paused(app);
    let lang = crate::i18n::current(app);
    let open = MenuItem::with_id(
        app,
        "open",
        crate::i18n::tr(lang, "打开主窗口", "Open main window"),
        true,
        None::<&str>,
    )?;
    let status = MenuItem::with_id(app, "status", tray_status(app), false, None::<&str>)?;
    let pause = CheckMenuItem::with_id(
        app,
        "pause",
        crate::i18n::tr(lang, "暂停主动任务", "Pause proactive tasks"),
        true,
        paused,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        crate::i18n::tr(lang, "退出 Pi Workbench", "Quit Pi Workbench"),
        true,
        None::<&str>,
    )?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &status, &sep, &pause, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Pi Workbench")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "pause" => toggle_paused(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    app.manage(TrayHandles {
        open,
        status,
        pause,
        quit,
    });
    Ok(())
}

/// 状态行：下次任务时间（相对值）或明确的「无任务」。
pub fn tray_status(app: &AppHandle) -> String {
    let store = app.state::<ProactiveState>();
    let store = store.store.lock().unwrap();
    let lang = crate::i18n::current(app);
    proactive::next_run_label(&store, is_paused(app), proactive::now_ms(), lang)
}

/// 语言切换：原地改菜单文案，不重建托盘（避免图标闪烁、菜单收起）。
#[tauri::command]
pub fn tray_relocalize(app: AppHandle) -> Result<(), String> {
    let lang = crate::i18n::current(&app);
    if let Some(handles) = app.try_state::<TrayHandles>() {
        let _ = handles
            .open
            .set_text(crate::i18n::tr(lang, "打开主窗口", "Open main window"));
        let _ = handles.pause.set_text(crate::i18n::tr(
            lang,
            "暂停主动任务",
            "Pause proactive tasks",
        ));
        let _ = handles.quit.set_text(crate::i18n::tr(
            lang,
            "退出 Pi Workbench",
            "Quit Pi Workbench",
        ));
        let _ = handles.status.set_text(tray_status(&app));
    }
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some("Pi Workbench"));
    }
    Ok(())
}

/// 每个调度 tick 刷新一次：状态行与暂停勾选可能被其他入口改掉。
pub fn update_tray(app: &AppHandle) {
    let Some(handles) = app.try_state::<TrayHandles>() else {
        return;
    };
    let _ = handles.status.set_text(tray_status(app));
    let _ = handles.pause.set_checked(is_paused(app));
}

fn toggle_paused(app: &AppHandle) {
    let paused = {
        let state = app.state::<BackgroundState>();
        let mut prefs = state.prefs.lock().unwrap();
        prefs.paused = !prefs.paused;
        persist(app, &prefs);
        prefs.paused
    };
    if let Some(handles) = app.try_state::<TrayHandles>() {
        let _ = handles.pause.set_checked(paused);
    }
    update_tray(app);
    emit_changed(app);
}

// ── 命令 ──────────────────────────────────────────────────────

#[tauri::command]
pub fn background_get(
    app: AppHandle,
    state: State<BackgroundState>,
) -> Result<BackgroundInfo, String> {
    Ok(info(&app, &state))
}

#[tauri::command]
pub fn background_set_close_action(
    app: AppHandle,
    action: CloseAction,
    state: State<BackgroundState>,
) -> Result<BackgroundInfo, String> {
    {
        let mut prefs = state.prefs.lock().unwrap();
        prefs.close_action = action;
        persist(&app, &prefs);
    }
    emit_changed(&app);
    Ok(info(&app, &state))
}

#[tauri::command]
pub fn background_set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| format!("登录项设置失败: {e}"))?;
    emit_changed(&app);
    Ok(manager.is_enabled().unwrap_or(enabled))
}

#[tauri::command]
pub fn background_set_paused(
    app: AppHandle,
    paused: bool,
    state: State<BackgroundState>,
) -> Result<BackgroundInfo, String> {
    {
        let mut prefs = state.prefs.lock().unwrap();
        prefs.paused = paused;
        persist(&app, &prefs);
    }
    update_tray(&app);
    emit_changed(&app);
    Ok(info(&app, &state))
}

/// 首次关窗的询问结果：持久化选择，然后隐藏窗口或彻底退出。
#[tauri::command]
pub fn background_resolve_close(
    app: AppHandle,
    action: CloseAction,
    state: State<BackgroundState>,
) -> Result<(), String> {
    {
        let mut prefs = state.prefs.lock().unwrap();
        prefs.close_action = action;
        persist(&app, &prefs);
    }
    emit_changed(&app);
    match action {
        CloseAction::Background => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
            Ok(())
        }
        CloseAction::Quit => {
            app.exit(0);
            Ok(())
        }
        CloseAction::Ask => Ok(()),
    }
}
