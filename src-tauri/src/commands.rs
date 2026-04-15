use crate::database::{self, Clip, ClipPage, DbState};
use tauri::GlobalShortcutManager;
use crate::ocr;
use crate::everything_search;
use crate::PendingClipState;
use std::borrow::Cow;
use std::collections::HashMap;
use arboard::{Clipboard, ImageData};
use tauri::Manager;

// ── Clip CRUD ──

#[tauri::command]
pub fn get_clips(db: tauri::State<DbState>) -> Result<Vec<Clip>, String> {
    let conn = db.0.lock().unwrap();
    database::get_all(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_clips_page(db: tauri::State<DbState>, limit: Option<i64>, offset: Option<i64>) -> Result<ClipPage, String> {
    let conn = db.0.lock().unwrap();
    database::get_clips_paginated(&conn, limit.unwrap_or(100), offset.unwrap_or(0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_favorite(db: tauri::State<DbState>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    database::toggle_favorite(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_pin(db: tauri::State<DbState>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    database::toggle_pin(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_clip(app_handle: tauri::AppHandle, db: tauri::State<DbState>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    database::delete_clip(&conn, &app_handle, id).map_err(|e| e.to_string())?;
    app_handle.emit_all("clip:created", ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn batch_delete_clips(app_handle: tauri::AppHandle, db: tauri::State<DbState>, ids: Vec<i64>) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    database::batch_delete_clips(&conn, &ids).map_err(|e| e.to_string())?;
    drop(conn);
    app_handle.emit_all("clip:created", ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_history(db: tauri::State<DbState>) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    database::clear_all(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn apply_retention_policy(app_handle: tauri::AppHandle, db: tauri::State<DbState>, days: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    database::set_setting(&conn, "retention_days", &days.to_string()).map_err(|e| e.to_string())?;
    database::cleanup_by_retention(&conn, days).map_err(|e| e.to_string())?;
    drop(conn);
    app_handle.emit_all("clip:created", ()).map_err(|e| e.to_string())
}

// ── Tags ──

#[tauri::command]
pub fn get_all_tags_with_counts(db: tauri::State<DbState>) -> Result<HashMap<String, i64>, String> {
    let conn = db.0.lock().unwrap();
    database::get_all_tags_with_counts(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_clip_tags(db: tauri::State<DbState>, id: i64, tags: String) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    database::update_clip_tags(&conn, id, tags).map_err(|e| e.to_string())
}

// ── OCR ──

#[tauri::command]
pub fn perform_ocr(app_handle: tauri::AppHandle, db: tauri::State<DbState>, id: i64, path: String) -> Result<ocr::OcrResult, String> {
    #[cfg(target_os = "windows")]
    {
        let conn = db.0.lock().unwrap();
        // Check DB cache
        if let Ok(Some(clip)) = database::get_clip_by_id(&conn, id) {
            if let Some(ocr_json) = &clip.ocr_lines {
                if !ocr_json.is_empty() {
                    let lines: Vec<ocr::OcrLine> = serde_json::from_str(ocr_json).unwrap_or_default();
                    let text = clip.ocr_text.clone().unwrap_or_default();
                    return Ok(ocr::OcrResult { text, lines });
                }
            }
        }
        drop(conn);

        let result = ocr::recognize_text_local(&app_handle, &path)?;

        let conn = db.0.lock().unwrap();
        let lines_json = serde_json::to_string(&result.lines).map_err(|e| e.to_string())?;
        let _ = database::update_clip_ocr(&conn, id, result.text.clone(), lines_json);

        Ok(result)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("OCR only supported on Windows".into())
    }
}

// ── Clipboard Operations ──

#[tauri::command]
pub fn copy_to_clipboard(_app_handle: tauri::AppHandle, content: String, kind: String) -> Result<(), String> {
    let handle = std::thread::spawn(move || {
        let mut last_error = String::new();

        for attempt in 1..=3 {
            let res: Result<(), String> = if kind == "image" {
                copy_image(&content)
            } else if kind == "file" {
                copy_file(&content)
            } else {
                copy_text(&content)
            };

            if res.is_ok() {
                return Ok(());
            }
            last_error = res.err().unwrap_or_default();
            eprintln!("[COPY] Attempt {} failed: {}", attempt, last_error);
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
        Err(format!("Copy failed after 3 attempts: {}", last_error))
    });

    handle.join().map_err(|_| "Clipboard thread panicked".to_string())?
}

fn copy_image(content: &str) -> Result<(), String> {
    let img_res = (|| -> Result<(), String> {
        let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard init failed: {}", e))?;
        let img = image::open(content).map_err(|e| format!("Image open failed: {}", e))?.to_rgba8();
        let (w, h) = img.dimensions();
        let img_data = ImageData {
            width: w as usize,
            height: h as usize,
            bytes: Cow::Owned(img.into_vec()),
        };
        clipboard.set_image(img_data).map_err(|e| format!("Set image failed: {}", e))
    })();

    if img_res.is_ok() {
        return img_res;
    }

    // Fallback to file copy on Windows
    #[cfg(target_os = "windows")]
    {
        use clipboard_win::{formats, Setter, Clipboard as WinClipboard};
        let _clip = WinClipboard::new_attempts(5).map_err(|_| "WinClipboard open failed".to_string())?;
        let _ = clipboard_win::empty();
        formats::FileList.write_clipboard(&[content.to_string()])
            .map_err(|e| format!("FileList fallback failed: {}", e))
    }
    #[cfg(not(target_os = "windows"))]
    { img_res }
}

fn copy_file(content: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use clipboard_win::{formats, Setter, Clipboard as WinClipboard};
        let _clip = WinClipboard::new_attempts(5).map_err(|_| "WinClipboard open failed".to_string())?;
        let _ = clipboard_win::empty();
        formats::FileList.write_clipboard(&[content.to_string()])
            .map_err(|e| format!("FileList write failed: {}", e))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard init failed: {}", e))?;
        clipboard.set_text(content).map_err(|e| e.to_string())
    }
}

fn copy_text(content: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use clipboard_win::{set_clipboard, formats};
        set_clipboard(formats::Unicode, content).map_err(|e| format!("Set text failed: {}", e))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard init failed: {}", e))?;
        clipboard.set_text(content).map_err(|e| format!("Set text failed: {}", e))
    }
}

// ── Keyboard Simulation ──

#[tauri::command]
pub fn simulate_v_key() {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, VIRTUAL_KEY, KEYBD_EVENT_FLAGS};
        let vk_control = VIRTUAL_KEY(0x11);
        let vk_v = VIRTUAL_KEY(0x56);
        let keyeventf_keyup = KEYBD_EVENT_FLAGS(0x0002);

        unsafe {
            keybd_event(vk_control.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
            keybd_event(vk_v.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
            keybd_event(vk_v.0 as u8, 0, keyeventf_keyup, 0);
            keybd_event(vk_control.0 as u8, 0, keyeventf_keyup, 0);
        }
    }
}

// ── Window Management ──

#[tauri::command]
pub fn hide_window(window: tauri::Window) {
    let _ = window.hide();
}

#[tauri::command]
pub fn toggle_always_on_top(app_handle: tauri::AppHandle, always_on_top: bool) -> Result<(), String> {
    if let Some(window) = app_handle.get_window("main") {
        let _ = window.set_always_on_top(always_on_top);
    }
    Ok(())
}

#[tauri::command]
pub async fn open_float_window(app_handle: tauri::AppHandle, id: i64, image_path: String) -> Result<(), String> {
    let label = format!("float-{}", id);

    if let Some(win) = app_handle.get_window(&label) {
        let _ = win.set_focus();
        return Ok(());
    }

    let url = format!("index.html?mode=float&id={}&path={}", id, urlencoding::encode(&image_path));

    let window = tauri::WindowBuilder::new(&app_handle, label, tauri::WindowUrl::App(url.into()))
        .title("Super Clip - Float")
        .always_on_top(true)
        .decorations(false)
        .transparent(true)
        .inner_size(400.0, 300.0)
        .resizable(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| e.to_string())?;

    let _ = window.show();
    Ok(())
}

// ── Settings ──

#[tauri::command]
pub fn get_setting(db: tauri::State<DbState>, key: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().unwrap();
    database::get_setting(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_setting(db: tauri::State<DbState>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    database::set_setting(&conn, &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_shortcut(db: tauri::State<DbState>) -> Result<String, String> {
    let conn = db.0.lock().unwrap();
    database::get_setting(&conn, "shortcut")
        .map_err(|e| e.to_string())
        .map(|s| s.unwrap_or_else(|| "CmdOrCtrl+Shift+V".to_string()))
}

#[tauri::command]
pub fn update_shortcut(app_handle: tauri::AppHandle, db: tauri::State<DbState>, shortcut_str: String, is_minimalist: bool) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    let key = if is_minimalist { "mini_shortcut" } else { "shortcut" };
    database::set_setting(&conn, key, &shortcut_str).map_err(|e| e.to_string())?;

    let _ = app_handle.global_shortcut_manager().unregister_all();

    let s_expanded = database::get_setting(&conn, "shortcut")
        .ok().flatten().unwrap_or_else(|| "CmdOrCtrl+Space".to_string());
    let s_minimal = database::get_setting(&conn, "mini_shortcut")
        .ok().flatten().unwrap_or_else(|| "CmdOrCtrl+M".to_string());

    drop(conn);
    crate::register_dual_shortcuts(app_handle, &s_expanded, &s_minimal);
    Ok(())
}

#[tauri::command]
pub fn toggle_double_ctrl(db: tauri::State<DbState>, enabled: bool) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    database::set_setting(&conn, "enable_double_ctrl", if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    crate::hooks::set_enabled(enabled);

    Ok(())
}

// ── Stats ──

#[tauri::command]
pub fn get_stats(db: tauri::State<DbState>) -> Result<HashMap<String, i64>, String> {
    let conn = db.0.lock().unwrap();
    database::get_stats_by_range(&conn, None).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_stats_by_range(db: tauri::State<DbState>, range: Option<String>) -> Result<HashMap<String, i64>, String> {
    let conn = db.0.lock().unwrap();
    database::get_stats_by_range(&conn, range.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_recent_text_content(db: tauri::State<DbState>) -> Result<Vec<String>, String> {
    let conn = db.0.lock().unwrap();
    database::get_recent_text_content(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_recent_content_by_range(db: tauri::State<DbState>, range: String) -> Result<Vec<String>, String> {
    let conn = db.0.lock().unwrap();
    database::get_recent_content_by_range(&conn, &range).map_err(|e| e.to_string())
}

// ── Source App Stats ──

#[tauri::command]
pub fn get_source_app_stats(db: tauri::State<DbState>, range: Option<String>) -> Result<Vec<(String, i64)>, String> {
    let conn = db.0.lock().unwrap();
    database::get_source_app_stats(&conn, range.as_deref()).map_err(|e| e.to_string())
}

// ── Snippets ──

#[tauri::command]
pub fn get_snippets(db: tauri::State<DbState>) -> Result<Vec<database::Snippet>, String> {
    let conn = db.0.lock().unwrap();
    database::get_all_snippets(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_snippet(db: tauri::State<DbState>, name: String, content: String, trigger_text: Option<String>) -> Result<i64, String> {
    let conn = db.0.lock().unwrap();
    database::insert_snippet(&conn, name, content, trigger_text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_snippet(db: tauri::State<DbState>, id: i64, name: String, content: String, trigger_text: Option<String>) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    database::update_snippet(&conn, id, name, content, trigger_text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_snippet(db: tauri::State<DbState>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    database::delete_snippet(&conn, id).map_err(|e| e.to_string())
}

// ── Entity Extraction ──

#[tauri::command]
pub fn extract_entities(content: String) -> Vec<crate::detect::ExtractedEntity> {
    crate::detect::extract_entities(&content)
}

// ── Fuzzy Search ──

#[tauri::command]
pub fn fuzzy_search_clips(db: tauri::State<DbState>, query: String, limit: Option<usize>) -> Result<Vec<Clip>, String> {
    use nucleo_matcher::pattern::{Pattern, CaseMatching, Normalization, AtomKind};
    use nucleo_matcher::{Matcher, Config};

    let conn = db.0.lock().unwrap();
    let searchable = database::get_searchable_clips(&conn, 2000).map_err(|e| e.to_string())?;
    drop(conn);

    if query.trim().is_empty() {
        let max = limit.unwrap_or(50);
        return Ok(searchable.into_iter().take(max).map(|s| s.clip).collect());
    }

    let mut matcher = Matcher::new(Config::DEFAULT);
    let pattern = Pattern::new(&query, CaseMatching::Ignore, Normalization::Smart, AtomKind::Fuzzy);

    let mut scored: Vec<(u32, Clip)> = searchable
        .into_iter()
        .filter_map(|s| {
            let mut buf = Vec::new();
            let haystack = nucleo_matcher::Utf32Str::new(&s.haystack, &mut buf);
            pattern.score(haystack, &mut matcher).map(|score| (score, s.clip))
        })
        .collect();

    scored.sort_by(|a, b| b.0.cmp(&a.0));

    let max = limit.unwrap_or(50);
    Ok(scored.into_iter().take(max).map(|(_, clip)| clip).collect())
}

// ── File Search ──

#[tauri::command]
pub fn search_files(query: String) -> Result<Vec<everything_search::FileResult>, String> {
    everything_search::search(&query, 50)
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
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

// ── Prompt Decision ──

#[tauri::command]
pub fn user_prompt_decision(app_handle: tauri::AppHandle, db: tauri::State<DbState>, decision: String, state: tauri::State<PendingClipState>) -> Result<(), String> {
    if decision == "always" {
        let conn = db.0.lock().unwrap();
        let _ = database::set_setting(&conn, "always_intercept_clip", "always");
    }

    if decision == "always" || decision == "once" {
        let mut data = state.0.lock().unwrap();
        if let Some((content, kind, source)) = data.take() {
            let conn = db.0.lock().unwrap();
            if database::insert_clip(&conn, content, kind, source).is_ok() {
                let _ = app_handle.emit_all("clip:created", ());
            }
        }
    } else if decision == "ignore" {
        let mut data = state.0.lock().unwrap();
        *data = None;
    }

    // Close all prompt windows
    for (label, win) in app_handle.windows() {
        if label.starts_with("prompt-window") {
            let _ = win.close();
        }
    }

    Ok(())
}
