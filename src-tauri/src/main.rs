#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod database;
mod ocr;
mod ocr_preload;
mod detect;
mod commands;
mod clipboard_monitor;
mod everything_search;
#[cfg(target_os = "windows")]
mod hooks;

use database::DbState;
use std::sync::Mutex;
use tauri::{
    CustomMenuItem, GlobalShortcutManager, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem,
};
use tauri_plugin_autostart::MacosLauncher;

// (content, kind, source_app, content_html)
pub struct PendingClipState(Mutex<Option<(String, String, Option<String>, Option<String>)>>);

/// Force-bring a Tauri window to the foreground (Win32 fallback).
fn show_main_window(window: &tauri::Window) {
    let _ = window.show();
    let _ = window.set_focus();
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SetForegroundWindow, SW_RESTORE};
        if let Ok(hwnd_raw) = window.hwnd() {
            unsafe {
                let hwnd = windows::Win32::Foundation::HWND(hwnd_raw.0);
                let _ = ShowWindow(hwnd, SW_RESTORE);
                let _ = SetForegroundWindow(hwnd);
            }
        }
    }
}

pub fn register_dual_shortcuts(app_handle: tauri::AppHandle, s_expanded: &str, s_minimal: &str) {
    let mut sm = app_handle.global_shortcut_manager();

    let h_exp = app_handle.clone();
    let _ = sm.register(s_expanded, move || {
        if let Some(window) = h_exp.get_window("main") {
            if window.is_visible().unwrap_or(false) {
                let _ = h_exp.emit_all("window:hotkey-trigger", "expanded");
            } else {
                show_main_window(&window);
                let _ = h_exp.emit_all("window:show-mode", "expanded");
            }
        }
    });

    let h_min = app_handle.clone();
    let _ = sm.register(s_minimal, move || {
        if let Some(window) = h_min.get_window("main") {
            if window.is_visible().unwrap_or(false) {
                let _ = h_min.emit_all("window:hotkey-trigger", "minimalist");
            } else {
                show_main_window(&window);
                let _ = h_min.emit_all("window:show-mode", "minimalist");
            }
        }
    });
}

fn main() {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
    }

    std::panic::set_hook(Box::new(|panic_info| {
        let payload = panic_info.payload();
        let message = if let Some(s) = payload.downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic".to_string()
        };
        let location = panic_info.location()
            .map(|l| format!(" at {}:{}", l.file(), l.line()))
            .unwrap_or_default();
        eprintln!("!!! RUST PANIC !!!: {}{}", message, location);
    }));

    let quit = CustomMenuItem::new("quit".to_string(), "Quit");
    let show = CustomMenuItem::new("show".to_string(), "Show/Hide");
    let tray_menu = SystemTrayMenu::new()
        .add_item(show)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);
    let system_tray = SystemTray::new().with_menu(tray_menu);

    let tauri_app = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .system_tray(system_tray)
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::LeftClick { .. } => {
                if let Some(window) = app.get_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        show_main_window(&window);
                    }
                }
            }
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "quit" => std::process::exit(0),
                "show" => {
                    if let Some(window) = app.get_window("main") {
                        if window.is_visible().unwrap_or(false) {
                            let _ = window.hide();
                        } else {
                            show_main_window(&window);
                        }
                    }
                }
                _ => {}
            },
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_clips,
            commands::get_clips_page,
            commands::copy_to_clipboard,
            commands::simulate_v_key,
            commands::hide_window,
            commands::toggle_favorite,
            commands::delete_clip,
            commands::batch_delete_clips,
            commands::perform_ocr,
            commands::get_shortcut,
            commands::update_shortcut,
            commands::toggle_always_on_top,
            commands::toggle_pin,
            commands::clear_history,
            commands::apply_retention_policy,
            commands::open_float_window,
            commands::get_setting,
            commands::save_setting,
            commands::toggle_double_ctrl,
            commands::get_stats,
            commands::get_stats_by_range,
            commands::get_recent_text_content,
            commands::get_recent_content_by_range,
            commands::get_all_tags_with_counts,
            commands::get_source_app_stats,
            commands::get_snippets,
            commands::create_snippet,
            commands::update_snippet,
            commands::delete_snippet,
            commands::extract_entities,
            commands::fuzzy_search_clips,
            commands::search_files,
            commands::open_path,
            commands::update_clip_tags,
            commands::user_prompt_decision,
            commands::export_clips_to_json,
            commands::import_clips_from_json,
        ])
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                let _ = event.window().hide();
                api.prevent_close();
            }
        })
        .setup(|app| {
            // Initialize DB and manage as shared state
            let conn = database::init(&app.handle()).expect("Failed to initialize database");
            let db_state = DbState(Mutex::new(conn));

            // Run auto-cleanup
            {
                let conn = db_state.0.lock().unwrap();
                if let Ok(Some(days_str)) = database::get_setting(&conn, "retention_days") {
                    if let Ok(days) = days_str.parse::<i64>() {
                        let _ = database::cleanup_by_retention(&conn, days);
                    }
                }
            }

            app.manage(db_state);
            app.manage(PendingClipState(Mutex::new(None)));

            let handle = app.handle();

            // Register global shortcuts
            {
                let db = app.state::<DbState>();
                let conn = db.0.lock().unwrap();
                let s_expanded = database::get_setting(&conn, "shortcut")
                    .ok().flatten().unwrap_or_else(|| "CmdOrCtrl+Space".to_string());
                let s_minimal = database::get_setting(&conn, "mini_shortcut")
                    .ok().flatten().unwrap_or_else(|| "CmdOrCtrl+M".to_string());
                drop(conn);
                register_dual_shortcuts(handle.clone(), &s_expanded, &s_minimal);
            }

            // Start double-Ctrl hook (Windows)
            #[cfg(target_os = "windows")]
            {
                let db = app.state::<DbState>();
                let conn = db.0.lock().unwrap();
                let enabled = database::get_setting(&conn, "doubleCtrlEnabled")
                    .ok().flatten()
                    .map(|v| v == "true")
                    .unwrap_or(true);
                drop(conn);
                hooks::set_enabled(enabled);
                hooks::start_hook(app.handle());
            }

            // Start clipboard monitor
            clipboard_monitor::start(handle);

            // Warm-start the ONNX OCR models off the main thread so first-OCR
            // doesn't pay the ~hundreds-of-ms load cost. Safe if models missing.
            ocr::warm_start(app.handle());
            // Start the background OCR preload worker. It consumes image
            // clips off a bounded queue and pre-populates the DB cache so
            // `perform_ocr` on user click is instant.
            ocr_preload::start_worker(app.handle());

            // Force-reset main-window position + size on every boot. Webview2
            // caches window geometry and on a dev loop where the window once
            // opened on a secondary monitor / scaled display that's no longer
            // there, the cached coords can park it entirely off-screen — the
            // user sees "nothing happened" when clicking the tray. Re-centering
            // at a sane default every launch avoids that ghost-window class of
            // bug at essentially zero cost.
            if let Some(window) = app.get_window("main") {
                use tauri::LogicalSize;
                let _ = window.set_size(LogicalSize::new(800.0, 600.0));
                let _ = window.center();
                let _ = window.show();
                let _ = window.set_focus();
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    tauri_app.run(|_app_handle, _e| {});
}
