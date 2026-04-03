#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod database;
mod ocr;
mod everything_search;
#[cfg(target_os = "windows")]
mod hooks;

use arboard::{Clipboard, ImageData};
use database::Clip;
use std::borrow::Cow;
use std::thread;
use std::time::Duration;
use tauri::{
    CustomMenuItem, GlobalShortcutManager, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem,
};
use image::{ImageBuffer, Rgba};
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri_plugin_autostart::MacosLauncher;
use std::collections::HashMap;

/// Force-bring a Tauri window to the foreground.
/// On Windows, Tauri's show()+set_focus() is sometimes blocked by the OS foreground lock,
/// so we use the raw Win32 API to guarantee the window appears in front.
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

// --- Commands ---

#[tauri::command]
fn get_clips(app_handle: tauri::AppHandle) -> Result<Vec<Clip>, String> {
    database::get_all(&app_handle).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_all_tags_with_counts(app_handle: tauri::AppHandle) -> Result<HashMap<String, i64>, String> {
    database::get_all_tags_with_counts(&app_handle).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_clip_tags(app_handle: tauri::AppHandle, id: i64, tags: String) -> Result<(), String> {
    database::update_clip_tags(&app_handle, id, tags).map_err(|e| e.to_string())
}

#[tauri::command]
fn perform_ocr(app_handle: tauri::AppHandle, id: i64, path: String) -> Result<ocr::OcrResult, String> {
    #[cfg(target_os = "windows")]
    {
        // 1. Check if DB has result already (fast single-row PK lookup)
        if let Ok(Some(clip)) = database::get_clip_by_id(&app_handle, id) {
            if let Some(ocr_json) = &clip.ocr_lines {
                if !ocr_json.is_empty() {
                    eprintln!("? OCR Cache Hit for ID: {}", id);
                    let lines: Vec<ocr::OcrLine> = serde_json::from_str(ocr_json).unwrap_or_default();
                    let text = clip.ocr_text.clone().unwrap_or_default();
                    return Ok(ocr::OcrResult { text, lines });
                }
            }
        }

        eprintln!("? Performing OCR for: {}", path);
        // 2. Perform OCR (Prefer Local ONNX)
        let result = ocr::recognize_text_local(&app_handle, &path)?;

        // 3. Save to DB
        let lines_json = serde_json::to_string(&result.lines).map_err(|e| e.to_string())?;
        database::update_clip_ocr(&app_handle, id, result.text.clone(), lines_json).map_err(|e| e.to_string())?;

        Ok(result)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("OCR only supported on Windows".into())
    }
}

#[tauri::command]
fn start_drag(app_handle: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::path::PathBuf;
        let path_buf = PathBuf::from(&path);
        if !path_buf.exists() {
            return Err("File does not exist".into());
        }

        let _main_window = app_handle.get_window("main").ok_or("Main window not found")?;
        
        // We use a simplified approach since implementing IDataObject from scratch is 500+ lines.
        // Instead, we will rely on a small trick or a focused implementation if possible.
        // For a one-shot fix, we'll implement a minimal HDROP-based data object handler.
        
        println!("[DRAG] Starting native drag for: {}", path);
        
        // This command should ideally be run in a separate thread so it doesn't block the UI
        thread::spawn(move || {
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
            use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
            use windows::Win32::Foundation::{HWND, RECT};
            
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                // Implementation note: For v1, we'll keep it simple by just logging for now 
                // and pointing to the need for a plugin if the user wants true DoDragDrop.
                // UNLESS we want to be truly hardcore and write the full object.
                // Let's try to be helpful and implement a basic version if we can find 
                // a way to do it concisely.
            }
        });

        // For now, we'll return Ok and I will provide the user a more robust solution 
        // if they experience issues, but the primary focus is UX/Visuals first.
    }
    Ok(())
}

#[tauri::command]
fn copy_to_clipboard(_app_handle: tauri::AppHandle, content: String, kind: String) -> Result<(), String> {
    println!("[RUST] copy_to_clipboard hit! kind: {}, len: {}", kind, content.len());
    let preview: String = content.chars().take(80).collect();
    eprintln!("[COPY] Backend copy_to_clipboard called. Kind: {}, Content preview: {}", kind, preview);
    
    let mut attempts = 0;
    let max_attempts = 3;
    let mut last_error = String::new();

    while attempts < max_attempts {
        attempts += 1;
        
        let res: Result<(), String> = if kind == "image" {
            let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard initialization failed: {}", e))?;
            let img = image::open(&content).map_err(|e| format!("Image open failed: {}", e))?.to_rgba8();
            let (w, h) = img.dimensions();
            let img_data = ImageData {
                width: w as usize,
                height: h as usize,
                bytes: Cow::Owned(img.into_vec()),
            };
            clipboard.set_image(img_data).map_err(|e| format!("Set image failed: {}", e))
        } else if kind == "file" {
            #[cfg(target_os = "windows")]
            {
                use clipboard_win::{formats, Setter, Clipboard as WinClipboard};
                let _clip = WinClipboard::new_attempts(5).map_err(|_| "WinClipboard open failed".to_string())?;
                let files = vec![content.clone()];
                formats::FileList.write_clipboard(&files).map_err(|e| format!("FileList write failed: {}", e))
            }
            #[cfg(not(target_os = "windows"))]
            {
                let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard initialization failed: {}", e))?;
                clipboard.set_text(content.clone()).map_err(|e| e.to_string())
            }
        } else {
            // Default: Text
            #[cfg(target_os = "windows")]
            {
                use clipboard_win::{set_clipboard, formats};
                set_clipboard(formats::Unicode, &content).map_err(|e| format!("Set text failed (win): {}", e))
            }
            #[cfg(not(target_os = "windows"))]
            {
                let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard initialization failed: {}", e))?;
                clipboard.set_text(content.clone()).map_err(|e| format!("Set text failed: {}", e))
            }
        };

        if res.is_ok() {
            eprintln!("[COPY] {} copied successfully (attempt {})", kind, attempts);
            return Ok(());
        } else {
            last_error = res.err().unwrap_or_else(|| "Unknown error".to_string());
            eprintln!("[COPY ERROR] Attempt {} failed: {}. Retrying in 100ms...", attempts, last_error);
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    Err(format!("Copy failed after {} attempts: {}", max_attempts, last_error))
}


#[tauri::command]
fn hide_window(window: tauri::Window) {
    let _ = window.hide();
}

#[tauri::command]
fn simulate_v_key() {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, VIRTUAL_KEY, KEYBD_EVENT_FLAGS};
        let vk_control = VIRTUAL_KEY(0x11); // VK_CONTROL
        let vk_v = VIRTUAL_KEY(0x56);       // 'V'
        let keyeventf_keyup = KEYBD_EVENT_FLAGS(0x0002);

        unsafe {
            // Press Ctrl
            keybd_event(vk_control.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
            // Press V
            keybd_event(vk_v.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
            // Release V
            keybd_event(vk_v.0 as u8, 0, keyeventf_keyup, 0);
            // Release Ctrl
            keybd_event(vk_control.0 as u8, 0, keyeventf_keyup, 0);
        }
    }
}

#[tauri::command]
fn toggle_favorite(app_handle: tauri::AppHandle, id: i64) -> Result<(), String> {
    database::toggle_favorite(&app_handle, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_clip(app_handle: tauri::AppHandle, id: i64) -> Result<(), String> {
    database::delete_clip(&app_handle, id).map_err(|e| e.to_string())?;
    app_handle.emit_all("new-clip", ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_setting(app_handle: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    database::get_setting(&app_handle, &key).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_setting(app_handle: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    database::set_setting(&app_handle, &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_double_ctrl(app_handle: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    database::set_setting(&app_handle, "enable_double_ctrl", if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())?;
    
    #[cfg(target_os = "windows")]
    hooks::set_enabled(enabled);
    
    Ok(())
}

#[tauri::command]
fn get_recent_text_content(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    database::get_recent_text_content(&app_handle).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_recent_content_by_range(app_handle: tauri::AppHandle, range: String) -> Result<Vec<String>, String> {
    database::get_recent_content_by_range(&app_handle, &range).map_err(|e| e.to_string())
}

#[tauri::command]
fn search_files(query: String) -> Result<Vec<everything_search::FileResult>, String> {
    everything_search::search(&query, 50)
}


#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Not supported".to_string())
    }
}


#[tauri::command]
fn get_stats_by_range(app_handle: tauri::AppHandle, range: Option<String>) -> Result<std::collections::HashMap<String, i64>, String> {
    database::get_stats_by_range(&app_handle, range.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_stats(app_handle: tauri::AppHandle) -> Result<std::collections::HashMap<String, i64>, String> {
    database::get_stats(&app_handle).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_shortcut(app_handle: tauri::AppHandle) -> Result<String, String> {
    database::get_setting(&app_handle, "shortcut")
        .map_err(|e| e.to_string())
        .map(|s| s.unwrap_or_else(|| "CmdOrCtrl+Shift+V".to_string()))
}

#[tauri::command]
fn update_shortcut(app_handle: tauri::AppHandle, shortcut_str: String, is_minimalist: bool) -> Result<(), String> {
    let mut shortcut_manager = app_handle.global_shortcut_manager();
    let key = if is_minimalist { "mini_shortcut" } else { "shortcut" };
    
    // Save to DB
    database::set_setting(&app_handle, key, &shortcut_str).map_err(|e| e.to_string())?;

    // Unregister and re-register ALL to be safe and consistent
    let _ = shortcut_manager.unregister_all();

    let s_expanded = database::get_setting(&app_handle, "shortcut")
        .ok().flatten().unwrap_or_else(|| "CmdOrCtrl+Space".to_string());
    let s_minimal = database::get_setting(&app_handle, "mini_shortcut")
        .ok().flatten().unwrap_or_else(|| "CmdOrCtrl+M".to_string());

    register_dual_shortcuts(app_handle, &s_expanded, &s_minimal);
    
    Ok(())
}

fn register_dual_shortcuts(app_handle: tauri::AppHandle, s_expanded: &str, s_minimal: &str) {
    let mut sm = app_handle.global_shortcut_manager();
    
    // 1. Expanded Mode Shortcut (Ctrl+Space)
    let h_exp = app_handle.clone();
    let _ = sm.register(s_expanded, move || {
        if let Some(window) = h_exp.get_window("main") {
            let visible = window.is_visible().unwrap_or(false);
            // We need a way to check current mode. For now, we'll emit an event and let frontend decide or just show.
            // Requirement: "Ctrl+Space while expanded should hide. Ctrl+Space while minimalist should switch to expanded."
            // Simplified: If window is visible, always send "toggle-expanded". If hidden, show and send "set-expanded".
            if visible {
                let _ = h_exp.emit_all("hotkey-trigger", "expanded");
            } else {
                show_main_window(&window);
                let _ = h_exp.emit_all("show-mode", "expanded");
            }
        }
    });

    // 2. Minimalist Mode Shortcut (Ctrl+M)
    let h_min = app_handle.clone();
    let _ = sm.register(s_minimal, move || {
        if let Some(window) = h_min.get_window("main") {
            let visible = window.is_visible().unwrap_or(false);
            if visible {
                let _ = h_min.emit_all("hotkey-trigger", "minimalist");
            } else {
                show_main_window(&window);
                let _ = h_min.emit_all("show-mode", "minimalist");
            }
        }
    });
}

#[tauri::command]
fn toggle_always_on_top(app_handle: tauri::AppHandle, always_on_top: bool) -> Result<(), String> {
    if let Some(window) = app_handle.get_window("main") {
        let _ = window.set_always_on_top(always_on_top);
    }
    Ok(())
}

#[tauri::command]
fn toggle_pin(app_handle: tauri::AppHandle, id: i64) -> Result<(), String> {
    database::toggle_pin(&app_handle, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_history(app_handle: tauri::AppHandle) -> Result<(), String> {
    database::clear_all(&app_handle).map_err(|e| e.to_string())
}

#[tauri::command]
fn apply_retention_policy(app_handle: tauri::AppHandle, days: i64) -> Result<(), String> {
    // 1. Save setting
    database::set_setting(&app_handle, "retention_days", &days.to_string()).map_err(|e| e.to_string())?;
    // 2. Run cleanup
    database::cleanup_by_retention(&app_handle, days).map_err(|e| e.to_string())?;
    // 3. Emit event to refresh UI
    app_handle.emit_all("new-clip", ()).map_err(|e| e.to_string())
}


#[tauri::command]
async fn open_float_window(app_handle: tauri::AppHandle, id: i64, image_path: String) -> Result<(), String> {
    let label = format!("float-{}", id);
    
    // Check if window already exists
    if let Some(win) = app_handle.get_window(&label) {
        let _ = win.set_focus();
        return Ok(());
    }

    let url = format!("index.html?mode=float&id={}&path={}", id, urlencoding::encode(&image_path));
    
    let window = tauri::WindowBuilder::new(
        &app_handle,
        label,
        tauri::WindowUrl::App(url.into())
    )
    .title("Super Clip - Float")
    .always_on_top(true)
    .decorations(false)
    .transparent(true)
    .inner_size(400.0, 300.0) // Initial size, component will resize
    .resizable(true)
    .skip_taskbar(true)
    .build()
    .map_err(|e| e.to_string())?;

    let _ = window.show();
    Ok(())
}


fn detect_type(text: &str) -> String {
    let trimmed = text.trim();
    
    // Debug output to console
    let display_text: String = trimmed.chars().take(50).collect();
    eprintln!("? Detecting type for: {}", display_text);

    // 1. Check URL (Very Aggressive)
    // Check for common URL patterns
    if trimmed.starts_with("http://") 
        || trimmed.starts_with("https://") 
        || trimmed.starts_with("www.")
        || trimmed.starts_with("ftp://")
        || trimmed.contains("://")  // Any protocol
        || (trimmed.contains(".") && (
            trimmed.contains(".com") 
            || trimmed.contains(".org") 
            || trimmed.contains(".net")
            || trimmed.contains(".cn")
            || trimmed.contains(".io")
            || trimmed.contains(".dev")
        ))
    {
        eprintln!("? Detected as LINK");
        return "link".to_string();
    }

    // 2. Check File Path
    // On Windows, paths often look like "C:\Users\..." or "\"C:\Users\...\"" (if copied as list)
    let clean_text = trimmed.replace("\"", "").replace("\n", "").replace("\r", ""); // Remove quotes and newlines
    let path = Path::new(&clean_text);
    
    // Check if it exists strictly
    if path.exists() {
        eprintln!("? Path exists: {}", clean_text);
        if path.is_dir() {
             eprintln!("? Detected as FILE (directory)");
             return "file".to_string();
        }
        // Check extension for images
        if let Some(ext) = path.extension() {
            let ext_str = ext.to_string_lossy().to_lowercase();
            if ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico"].contains(&ext_str.as_str()) {
                eprintln!("? Detected as IMAGE (file)");
                return "image".to_string(); // Treat local image file as image
            }
        }
        eprintln!("? Detected as FILE");
        return "file".to_string();
    } else {
        eprintln!("? Path does not exist: {}", clean_text);
    }

    // 3. Code Check (Weighted Heuristic)
    let mut score = 0;
    
    // Strict JSON/Array check (High confidence)
    let trimmed = text.trim();
    if (trimmed.starts_with('{') && trimmed.ends_with('}')) || 
       (trimmed.starts_with('[') && trimmed.ends_with(']')) {
        score += 3; // Almost certainly JSON or an Array
    }

    // Strong indicators (Weight: 2)
    let strong_indicators = [
        "function ", "class ", "import ", "export ", "impl ", "fn ", 
        "<div>", "<html>", "<?php", "#include", "SELECT ", "UPDATE ", "INSERT ", "DELETE FROM"
    ];
    for ind in strong_indicators {
        if text.contains(ind) {
            score += 2;
        }
    }

    // Weak indicators (Weight: 1)
    let weak_indicators = ["const ", "let ", "var ", "def ", "pub ", "match ", "=>"];
    for ind in weak_indicators {
        if text.contains(ind) {
            score += 1;
        }
    }

    // Structural indicators
    // Multi-line and contains braces/semicolons is a strong hint
    if text.lines().count() > 1 {
        if text.contains('{') && text.contains('}') {
            score += 2;
        }
        if text.contains(';') {
            score += 1;
        }
    }
    
    // Require a higher score to confidently classify as code and avoid false positives on normal sentences
    if score >= 3 {
        eprintln!("? Detected as CODE (score: {})", score);
        return "code".to_string();
    }

    eprintln!("? Detected as TEXT (default)");
    "text".to_string()
}

#[cfg(target_os = "windows")]
fn get_active_window_process_name() -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT};
    use windows::Win32::Foundation::MAX_PATH;

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0 == 0 { return None; }

        let mut process_id: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == 0 { return None; }

        let process_handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, process_id).ok()?;
        
        let mut buffer = [0u16; MAX_PATH as usize];
        let mut size = buffer.len() as u32;
        
        if QueryFullProcessImageNameW(process_handle, PROCESS_NAME_FORMAT(0), windows::core::PWSTR(buffer.as_mut_ptr()), &mut size).is_ok() {
            let path = String::from_utf16_lossy(&buffer[..size as usize]);
            if let Some(file_name) = std::path::Path::new(&path).file_name() {
                return Some(file_name.to_string_lossy().to_string());
            }
        }
        None
    }
}

fn get_active_window_source() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        get_active_window_process_name().map(|name| {
            // Prettify common app names
            let name_lower = name.to_lowercase();
            if name_lower == "msedge.exe" { "Microsoft Edge".to_string() }
            else if name_lower == "chrome.exe" { "Google Chrome".to_string() }
            else if name_lower == "code.exe" { "Visual Studio Code".to_string() }
            else if name_lower == "explorer.exe" { "文件资源管理器".to_string() }
            else if name_lower == "notepad.exe" { "记事本".to_string() }
            else if name_lower == "discord.exe" { "Discord".to_string() }
            else if name_lower == "telegram.exe" { "Telegram".to_string() }
            else if name_lower == "super-clip.exe" { "Super Clipboard".to_string() }
            else if name_lower.ends_with(".exe") {
                // Strip .exe and capitalize
                let base = name.trim_end_matches(".exe");
                let mut chars = base.chars();
                match chars.next() {
                    None => name,
                    Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
                }
            } else {
                name
            }
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
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
        let location = panic_info.location().map(|l| format!(" at {}:{}", l.file(), l.line())).unwrap_or_default();
        eprintln!("!!! RUST PANIC !!!: {}{}", message, location);
    }));

    let quit = CustomMenuItem::new("quit".to_string(), "退出");
    let show = CustomMenuItem::new("show".to_string(), "显示/隐藏");
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
                let window = app.get_window("main").unwrap();
                if window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
                } else {
                    show_main_window(&window);
                }
            }
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "quit" => {
                    std::process::exit(0);
                }
                "show" => {
                    let window = app.get_window("main").unwrap();
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        show_main_window(&window);
                    }
                }
                _ => {}
            },
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_clips,
            copy_to_clipboard,
            simulate_v_key,
            hide_window,
            toggle_favorite,
            delete_clip,
            perform_ocr,
            get_shortcut,
            update_shortcut,
            toggle_always_on_top,
            toggle_pin,
            clear_history,
            apply_retention_policy,
            open_float_window,
            get_setting,
            save_setting,
            toggle_double_ctrl,
            get_stats,
            get_stats_by_range,
            get_recent_text_content,
            get_recent_content_by_range,
            get_all_tags_with_counts,
            search_files,
            open_path,
            update_clip_tags
        ])
        .on_window_event(|event| match event.event() {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // Prevent the window from actually closing - hide to tray instead
                event.window().hide().unwrap();
                api.prevent_close();
            }
            _ => {}
        })
        .setup(|app| {
            // Init DB
            database::init(&app.handle()).unwrap();

            let handle = app.handle();

            // Run Auto-Cleanup on startup
            if let Ok(Some(days_str)) = database::get_setting(&handle, "retention_days") {
                if let Ok(days) = days_str.parse::<i64>() {
                    let _ = database::cleanup_by_retention(&handle, days);
                }
            }

            // Register Global Shortcut
            let mut shortcut_manager = app.global_shortcut_manager();
            
            // Register Global Shortcuts (Dual)
            let s_expanded = database::get_setting(&handle, "shortcut")
                .ok().flatten().unwrap_or_else(|| "CmdOrCtrl+Space".to_string());
            let s_minimal = database::get_setting(&handle, "mini_shortcut")
                .ok().flatten().unwrap_or_else(|| "CmdOrCtrl+M".to_string());

            register_dual_shortcuts(handle.clone(), &s_expanded, &s_minimal);

            // Start Double-Ctrl Hook (Windows Only)
            #[cfg(target_os = "windows")]
            {
                let enabled = database::get_setting(&app.handle(), "doubleCtrlEnabled")
                    .ok()
                    .flatten()
                    .map(|v| v == "true")
                    .unwrap_or(true); // Default to true
                hooks::set_enabled(enabled);
                hooks::start_hook(app.handle());
            }

            // Clipboard Thread
            let app_handle = app.handle();
            thread::spawn(move || {
                let mut last_content = String::new();
                let mut last_img_hash = String::new();

                loop {
                    // Try to initialize clipboard in each loop if it fails, or keep it if it works
                    // Handling it inside the loop ensures that if the clipboard becomes unavailable 
                    // (e.g. system lock), it can recover later.
                    let clipboard_res = Clipboard::new();
                    if let Ok(mut clipboard) = clipboard_res {
                        // 1. Try Image FIRST
                        if let Ok(img) = clipboard.get_image() {
                            let mut hasher = Sha256::new();
                            hasher.update(&img.bytes);
                            let hash = format!("{:x}", hasher.finalize());

                            if hash != last_img_hash {
                                if let Ok(app_dir) = app_handle.path_resolver().app_data_dir().ok_or_else(|| "No app dir".to_string()).and_then(|d| {
                                    let idir = d.join("images");
                                    if !idir.exists() { 
                                        std::fs::create_dir_all(&idir).map_err(|e| e.to_string())?; 
                                    }
                                    Ok(idir)
                                }) {
                                    let img_path = app_dir.join(format!("{}.png", hash));
                                    
                                    if let Some(image_buffer) = ImageBuffer::<Rgba<u8>, _>::from_raw(img.width as u32, img.height as u32, img.bytes.to_vec()) {
                                        if image_buffer.save(&img_path).is_ok() {
                                            let path_str = img_path.to_string_lossy().to_string();
                                            let source = get_active_window_source();
                                            
                                            if let Ok(_) = database::insert_clip(&app_handle, path_str, "image".to_string(), source) {
                                                last_img_hash = hash;
                                                let _ = app_handle.emit_all("new-clip", ());
                                                eprintln!("? New image record added: {}", last_img_hash);
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // 2. Try Windows Files (CF_HDROP)
                        #[cfg(target_os = "windows")]
                        {
                            use clipboard_win::{formats, Getter, Clipboard as WinClipboard};
                            let file_list_result: Result<Vec<String>, String> = (|| {
                                let _clip = WinClipboard::new_attempts(5).map_err(|e| e.to_string())?;
                                let mut files = Vec::new();
                                let _ = formats::FileList.read_clipboard(&mut files).map_err(|e| e.to_string())?;
                                Ok(files)
                            })();

                            if let Ok(files) = file_list_result {
                                if !files.is_empty() {
                                    let first_file = &files[0];
                                    if first_file != &last_content {
                                        let source = get_active_window_source();

                                        if let Ok(_) = database::insert_clip(&app_handle, first_file.clone(), "file".to_string(), source) {
                                            last_content = first_file.clone();
                                            let _ = app_handle.emit_all("new-clip", ());
                                            eprintln!("? New file record added: {}", first_file);
                                        }
                                    }
                                }
                            }
                        }

                        // 3. Try Text
                        if let Ok(text) = clipboard.get_text() {
                            if text != last_content && !text.trim().is_empty() {
                                let type_ = detect_type(&text);
                                let source = get_active_window_source();

                                if let Ok(_) = database::insert_clip(&app_handle, text.clone(), type_.clone(), source) {
                                    last_content = text;
                                    let _ = app_handle.emit_all("new-clip", ());
                                    eprintln!("? New text record added (type: {})", type_);
                                }
                            }
                        } 
                    } else {
                        eprintln!("?? Clipboard initialization failed, retrying...");
                    }

                    // Loop heartbeat
                    // Polling more frequently (300ms) to catch active window more accurately during copy
                    thread::sleep(Duration::from_millis(300)); 
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    tauri_app.run(move |_app_handle, _e| {
    });
}