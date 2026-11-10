mod agent_ops;
mod attachments;
mod artifacts;
mod background;
mod browser;
mod capabilities;
mod checkpoint;
mod connectors;
mod codebase;
mod conversation;
mod diag;
mod experts;
mod extensions;
mod fs;
mod governance;
mod i18n;
mod library;
mod mcp;
mod memory_vec;
mod memory_store;
mod models;
mod net;
mod pi_bridge;
mod pi_events;
mod proactive;
pub mod projects;
mod roles;
mod run_meta;
mod skills;
mod state;
mod terminal;
mod tools;

use connectors::ConnectorRuntimeState;
use library::LibraryState;
use state::{McpState, PiState, ProjectsState, RolesState};
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须最先注册：驻留后台时第二次启动只聚焦已有窗口，
        // 避免两个进程各自跑一个调度器、同时写同一份主动任务账本。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            background::show_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            // 登录项带固定参数启动：setup 据此首帧隐藏窗口，做到「随登录静默启动」。
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(PiState::default())
        .manage(proactive::ProactiveState::default())
        .manage(background::BackgroundState::default())
        .manage(ProjectsState::default())
        .manage(run_meta::RunMetaState::default())
        .manage(McpState::default())
        .manage(RolesState::default())
        .manage(ConnectorRuntimeState::default())
        .manage(LibraryState::default())
        .manage(governance::GovernanceState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            governance::load(&handle, &app.state::<governance::GovernanceState>());
            projects::load(&handle, &app.state::<ProjectsState>());
            // 运行记录元数据（置顶/重命名/归档/删除）在磁盘上，启动时读回，
            // 否则每次重启侧栏里的置顶与重命名全部丢失。
            run_meta::load(&handle, &app.state::<run_meta::RunMetaState>());
            // 主动任务账本：启动时读回并把「上次崩在 Running」的任务标成中断/重排，
            // 然后拉起唯一的调度线程（10s 一轮，复用 pi_status 做并发判定）。
            proactive::load(&handle, &app.state::<proactive::ProactiveState>());
            // 后台偏好先于调度线程：托盘状态行与暂停开关要用到它。
            background::load(&handle, &app.state::<background::BackgroundState>());
            background::setup_tray(&handle)?;
            // 窗口默认不可见：登录项启动只驻留托盘；手动启动在 setup 里显式 show，
            // 两条路径都不会出现「先闪一下再隐藏」。
            if let Some(window) = handle.get_webview_window("main") {
                if std::env::args().any(|a| a == "--autostart") {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                }
            }
            proactive::start(handle.clone());
            mcp::load(&handle, &app.state::<McpState>());
            // 连接器定义在磁盘上，但运行时（进程 + 握手结果）只存在于内存，
            // 不恢复的话每次重启应用，列表里明明在的连接器都停在 Disabled。
            let connector_state = app.state::<ConnectorRuntimeState>();
            *connector_state.store.lock().unwrap() = connectors::load_store(&handle);
            connectors::restore(&handle, &connector_state, &app.state::<McpState>());
            // 资料库的资产表在磁盘上，启动时读回来；
            // 检索文本不恢复（它是产物，用到时按原件重算）。
            *app.state::<LibraryState>().store.lock().unwrap() =
                library::load_store(&handle);
            // 扩展默认文件从资源/源码同步到可写的 app_config_dir，
            // 这样 dev 和 prod 的读取位置一致，也不会因应用包只读导致安装失败。
            if let Err(e) = extensions::seed_defaults(&handle) {
                eprintln!("扩展默认文件同步失败: {}", e);
            }
            match capabilities::CapabilityManifest::discover() {
                Some(m) => {
                    println!(
                        "能力清单已加载：技能目录 {} 个，内置工具 {} 个，扩展 {} 个",
                        m.skills.dirs.len(),
                        m.tools.builtin.len(),
                        m.extensions.len()
                    );
                    if let Some(pinned) = m
                        .kernel
                        .as_ref()
                        .and_then(|k| k.pi_version.as_deref())
                        .map(|v| v.to_string())
                    {
                        check_pi_version(&pinned);
                    }
                }
                None => {
                    // 清单缺失只影响「能力 → 提供方」的可追溯性，不阻塞启动。
                    println!("提示：未找到 pi-manifest.json，能力清单退化为内置默认值");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pi_bridge::pi_start,
            pi_bridge::pi_restart,
            pi_bridge::pi_call,
            pi_bridge::pi_send,
            pi_bridge::pi_stop,
            pi_bridge::pi_status,
            pi_bridge::pi_doctor,
            pi_bridge::pi_ui_response,
            pi_bridge::pi_journal_read,
            pi_bridge::pi_journal_sessions,
            pi_bridge::checkpoint_begin_turn,
            pi_bridge::checkpoint_rewind,
            governance::governance_get,
            governance::governance_usage,
            memory_vec::memory_vec_status,
            memory_vec::memory_vec_search,
            memory_vec::memory_vec_reindex,
            fs::fs_read_dir,
            fs::fs_read_file,
            fs::fs_write_file,
            fs::reveal_path,
            artifacts::artifacts_scan,
            artifacts::artifacts_read,
            artifacts::artifacts_open,
            browser::browser_open,
            terminal::term_exec,
            projects::projects_list,
            projects::projects_templates,
            projects::project_add,
            projects::project_remove,
            projects::project_rename,
            projects::project_reveal,
            projects::project_get,
            projects::project_archive,
            projects::project_unarchive,
            projects::project_set_active,
            projects::project_set_path,
            projects::project_active,
            projects::project_update_config,
            projects::project_add_work_item,
            projects::project_update_work_item,
            projects::project_remove_work_item,
            projects::project_add_asset,
            projects::project_remove_asset,
            projects::project_link_task,
            projects::project_task_context,
            projects::billing_status,
            codebase::project_index_codebase,
            codebase::project_index_status,
            conversation::conversation_export,
            conversation::conversation_import,
            diag::app_log,
            attachments::attachment_add,
            mcp::mcp_connect,
            mcp::mcp_list,
            mcp::mcp_call,
            mcp::mcp_disconnect,
            connectors::connectors_list,
            connectors::connectors_config,
            connectors::connectors_create,
            connectors::connectors_update,
            connectors::connectors_remove,
            connectors::connectors_set_enabled,
            connectors::connectors_selection,
            connectors::connectors_set_selection,
            connectors::connectors_apply_scope,
            library::library_list,
            library::library_marks,
            library::library_stats,
            library::library_tree,
            library::library_read,
            library::library_write,
            library::library_create,
            library::library_import,
            library::library_rename,
            library::library_move,
            library::library_remove,
            library::library_set_enabled,
            library::library_publish,
            library::library_revisions,
            library::library_rollback,
            library::library_search,
            library::library_open,
            library::library_bytes,
            experts::experts_list,
            experts::expert_draft_load,
            experts::expert_draft_save,
            experts::expert_validate,
            experts::expert_request_confirmation,
            experts::expert_confirm,
            experts::expert_publish,
            roles::role_list,
            roles::role_set,
            roles::role_current,
            skills::skills_list,
            skills::skills_install,
            skills::skills_install_from_url,
            skills::skills_uninstall,
            tools::tools_list,
            extensions::extensions_list,
            extensions::extensions_install_from_url,
            tools::tools_activate,
            models::settings_load,
            models::settings_save,
            models::settings_test_model,
            agent_ops::agent_teams_list,
            agent_ops::agent_memory_list,
            agent_ops::agent_memory_trash,
            agent_ops::agent_memory_forget,
            agent_ops::agent_memory_restore,
            agent_ops::agent_memory_purge,
            agent_ops::agent_memory_update,
            agent_ops::agent_profile_get,
            agent_ops::agent_skillpool_list,
            agent_ops::agent_browser_status,
            agent_ops::agent_team_create,
            agent_ops::agent_memory_store,
            agent_ops::agent_skill_publish,
            agent_ops::agent_browser_open,
            run_meta::run_meta_list,
            run_meta::run_meta_update,
            run_meta::open_replay_window,
            proactive::proactive_snapshot,
            proactive::proactive_job_create,
            proactive::proactive_job_set_enabled,
            proactive::proactive_job_remove,
            proactive::proactive_job_run_now,
            proactive::proactive_job_set_grant,
            proactive::proactive_take_focus,
            proactive::proactive_inbox_mark,
            proactive::proactive_inbox_mark_all_read,
            background::background_get,
            background::background_set_close_action,
            background::background_set_autostart,
            background::background_set_paused,
            background::background_resolve_close,
            background::tray_relocalize,
        ])
        .on_window_event(|window, event| {
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            let app = window.app_handle();
            match background::close_action(app) {
                background::CloseAction::Ask => {
                    // 首次关闭：留给前端弹一次选择，结果持久化后不再询问。
                    api.prevent_close();
                    let _ = app.emit("background://ask-close", ());
                }
                background::CloseAction::Background => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                background::CloseAction::Quit => {
                    // 统一走 exit：RunEvent::Exit 里停内核、清策略文件。
                    api.prevent_close();
                    app.exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Pi Workbench")
        .run(|app, event| match event {
            // Dock 图标被点击且没有可见窗口时，把主窗口拉回来。
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => background::show_main(app),
            tauri::RunEvent::Exit => {
                // 彻底退出：停内核并清理无人值守授权，异常残留不会带进下一次启动。
                proactive::clear_policy(app);
                pi_bridge::shutdown_kernel(app.state::<PiState>().inner());
            }
            _ => {}
        });
}

/// 清单钉住的内核版本与实际 `pi` 不一致时给出警告。
/// 与 `scripts/app-dev.mjs` 的前置校验是两道闸门：那里拦启动，这里拦运行期静默错配。
fn check_pi_version(pinned: &str) {
    let out = std::process::Command::new("pi")
        .args(["--version"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok());
    let Some(out) = out else {
        return;
    };
    let actual = out.trim();
    if actual != pinned {
        println!(
            "警告：能力清单钉住 pi {pinned}，但 PATH 上的 pi 是 {actual}；面板与内核的语义可能不一致"
        );
    }
}
