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
pub fn copy_to_clipboard(
    _app_handle: tauri::AppHandle,
    content: String,
    kind: String,
    content_html: Option<String>,
) -> Result<(), String> {
    let handle = std::thread::spawn(move || {
        let mut last_error = String::new();

        for attempt in 1..=3 {
            let res: Result<(), String> = if kind == "image" {
                copy_image(&content)
            } else if kind == "file" {
                copy_file(&content)
            } else {
                copy_text(&content, content_html.as_deref())
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

fn copy_text(content: &str, html: Option<&str>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use clipboard_win::{set_clipboard, formats, Setter, Clipboard as WinClipboard, register_format};
        use clipboard_win::formats::RawData;

        // Simple case: no HTML → use single-format API
        let Some(html_body) = html else {
            return set_clipboard(formats::Unicode, content)
                .map_err(|e| format!("Set text failed: {}", e));
        };

        // Dual-format: write CF_UNICODETEXT + CF_HTML atomically
        let _clip = WinClipboard::new_attempts(5)
            .map_err(|e| format!("WinClipboard open failed: {:?}", e))?;
        clipboard_win::empty().map_err(|e| format!("empty failed: {:?}", e))?;

        // Write Unicode text (plain fallback for apps that don't accept HTML)
        formats::Unicode
            .write_clipboard(&content)
            .map_err(|e| format!("Write Unicode failed: {:?}", e))?;

        // Write CF_HTML with the required metadata header
        let fmt_id = register_format("HTML Format").ok_or_else(|| "register CF_HTML failed".to_string())?;
        let cf_html_blob = build_cf_html_blob(html_body);
        RawData(fmt_id.get())
            .write_clipboard(&cf_html_blob.as_bytes())
            .map_err(|e| format!("Write CF_HTML failed: {:?}", e))?;

        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = html; // silence unused on non-Windows
        let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard init failed: {}", e))?;
        clipboard.set_text(content).map_err(|e| format!("Set text failed: {}", e))
    }
}

/// Build a Windows CF_HTML clipboard blob with the required 4-offset metadata header.
/// Offsets are UTF-8 byte positions into the full blob (including the header itself).
#[cfg(target_os = "windows")]
fn build_cf_html_blob(html_fragment: &str) -> String {
    // Template with placeholder offsets we'll rewrite after we know real positions.
    const PREFIX: &str = "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";
    const HTML_OPEN: &str = "<html><body>\r\n<!--StartFragment-->";
    const HTML_CLOSE: &str = "<!--EndFragment-->\r\n</body></html>";

    let prefix_len = PREFIX.len();
    let html_open_len = HTML_OPEN.len();
    let html_close_len = HTML_CLOSE.len();
    let fragment_len = html_fragment.len();

    let start_html = prefix_len;                              // at "<html>"
    let start_fragment = prefix_len + html_open_len;          // right after <!--StartFragment-->
    let end_fragment = start_fragment + fragment_len;         // right before <!--EndFragment-->
    let end_html = end_fragment + html_close_len;             // end of </html>

    // Build with actual numbers
    let mut s = String::with_capacity(prefix_len + html_open_len + fragment_len + html_close_len);
    s.push_str(&format!(
        "Version:0.9\r\nStartHTML:{:010}\r\nEndHTML:{:010}\r\nStartFragment:{:010}\r\nEndFragment:{:010}\r\n",
        start_html, end_html, start_fragment, end_fragment
    ));
    s.push_str(HTML_OPEN);
    s.push_str(html_fragment);
    s.push_str(HTML_CLOSE);
    s
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
        if let Some((content, kind, source, html)) = data.take() {
            let conn = db.0.lock().unwrap();
            if database::insert_clip(&conn, content, kind, source, html).is_ok() {
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

// ── Export / Import ──

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ExportClip {
    #[serde(flatten)]
    pub clip: Clip,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub image_base64: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ExportBundle {
    pub version: u32,
    pub exported_at: String,
    pub app_version: String,
    pub clips: Vec<ExportClip>,
    pub snippets: Vec<database::Snippet>,
}

#[derive(serde::Serialize)]
pub struct ExportStats {
    pub count: usize,
    pub size_bytes: u64,
}

#[derive(serde::Serialize)]
pub struct ImportStats {
    pub imported: usize,
    pub skipped: usize,
    pub snippets_imported: usize,
    pub errors: usize,
}

const EXPORT_VERSION: u32 = 1;

#[tauri::command]
pub fn export_clips_to_json(db: tauri::State<DbState>, path: String) -> Result<ExportStats, String> {
    use base64::{engine::general_purpose, Engine};

    let conn = db.0.lock().unwrap();
    let clips = database::get_all(&conn).map_err(|e| e.to_string())?;
    let snippets = database::get_all_snippets(&conn).map_err(|e| e.to_string())?;
    drop(conn);

    // Embed image payloads as base64 so the backup is self-contained across machines.
    let export_clips: Vec<ExportClip> = clips
        .into_iter()
        .map(|c| {
            let image_base64 = if c.type_ == "image" {
                std::fs::read(&c.content)
                    .ok()
                    .map(|bytes| general_purpose::STANDARD.encode(&bytes))
            } else {
                None
            };
            ExportClip { clip: c, image_base64 }
        })
        .collect();

    let count = export_clips.len();
    let bundle = ExportBundle {
        version: EXPORT_VERSION,
        exported_at: chrono::Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        clips: export_clips,
        snippets,
    };

    let file = std::fs::File::create(&path).map_err(|e| format!("Create file failed: {}", e))?;
    let writer = std::io::BufWriter::new(file);
    serde_json::to_writer_pretty(writer, &bundle).map_err(|e| format!("Serialize failed: {}", e))?;

    let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(ExportStats { count, size_bytes })
}

#[tauri::command]
pub fn import_clips_from_json(
    app_handle: tauri::AppHandle,
    db: tauri::State<DbState>,
    path: String,
) -> Result<ImportStats, String> {
    use base64::{engine::general_purpose, Engine};
    use sha2::{Digest, Sha256};

    let raw = std::fs::read_to_string(&path).map_err(|e| format!("Read file failed: {}", e))?;
    let bundle: ExportBundle = serde_json::from_str(&raw)
        .map_err(|e| format!("Parse JSON failed: {}", e))?;

    if bundle.version > EXPORT_VERSION {
        return Err(format!(
            "Backup version {} is newer than supported ({}). Please update Super Clip.",
            bundle.version, EXPORT_VERSION
        ));
    }

    // Resolve images directory once — same path the clipboard monitor writes to.
    let images_dir = app_handle
        .path_resolver()
        .app_data_dir()
        .ok_or_else(|| "app_data_dir unavailable".to_string())?
        .join("images");
    let _ = std::fs::create_dir_all(&images_dir);

    let conn = db.0.lock().unwrap();
    let mut stats = ImportStats {
        imported: 0,
        skipped: 0,
        snippets_imported: 0,
        errors: 0,
    };

    // Clips
    for export_clip in bundle.clips {
        let mut clip = export_clip.clip;

        // For images: decode base64, dedup by SHA-256, write to images dir, rewrite content path.
        if clip.type_ == "image" {
            let Some(b64) = export_clip.image_base64 else {
                // Legacy / malformed: absolute path from another machine, skip.
                stats.errors += 1;
                continue;
            };
            let Ok(bytes) = general_purpose::STANDARD.decode(b64.as_bytes()) else {
                stats.errors += 1;
                continue;
            };
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            let hash = format!("{:x}", hasher.finalize());
            let img_path = images_dir.join(format!("{}.png", hash));

            if !img_path.exists() {
                if std::fs::write(&img_path, &bytes).is_err() {
                    stats.errors += 1;
                    continue;
                }
            }
            clip.content = img_path.to_string_lossy().to_string();
        }

        // Dedup: skip if identical (content, type) already present.
        let exists = database::clip_exists_by_content(&conn, &clip.content, &clip.type_)
            .unwrap_or(false);
        if exists {
            stats.skipped += 1;
            continue;
        }

        match database::insert_clip_raw(&conn, &clip) {
            Ok(_) => stats.imported += 1,
            Err(_) => stats.errors += 1,
        }
    }

    // Snippets — dedup by name
    for snippet in bundle.snippets {
        if database::snippet_exists_by_name(&conn, &snippet.name).unwrap_or(false) {
            continue;
        }
        if database::insert_snippet(&conn, snippet.name, snippet.content, snippet.trigger_text).is_ok() {
            stats.snippets_imported += 1;
        }
    }

    drop(conn);
    let _ = app_handle.emit_all("clip:created", ());

    Ok(stats)
}
