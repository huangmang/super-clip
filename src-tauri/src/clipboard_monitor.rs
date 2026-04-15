use arboard::Clipboard;
use image::{ImageBuffer, Rgba};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;

use crate::database::{self, DbState};
use crate::detect;

// ── Shared clipboard state ──

struct ClipboardState {
    last_content: String,
    last_img_hash: String,
    last_img_dims: (usize, usize, usize),
    clipboard: Option<Clipboard>,
}

impl ClipboardState {
    fn new() -> Self {
        Self {
            last_content: String::new(),
            last_img_hash: String::new(),
            last_img_dims: (0, 0, 0),
            clipboard: Clipboard::new().ok(),
        }
    }
}

// Globals for the wndproc callback (same pattern as hooks.rs)
static MONITOR_APP_HANDLE: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);
static MONITOR_STATE: Mutex<Option<ClipboardState>> = Mutex::new(None);
static LAST_CHECK: Mutex<Option<Instant>> = Mutex::new(None);

const DEBOUNCE_MS: u64 = 50;

/// Public entry — dispatches to platform-specific implementation
pub fn start(app_handle: tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    start_native(app_handle);

    #[cfg(not(target_os = "windows"))]
    start_polling(app_handle);
}

// ── Core clipboard check logic (shared between polling & event-driven) ──

fn check_clipboard(app_handle: &tauri::AppHandle, state: &mut ClipboardState) {
    // Reuse clipboard, only re-create on failure
    if state.clipboard.is_none() {
        state.clipboard = Clipboard::new().ok();
    }

    let cb = match state.clipboard.as_mut() {
        Some(cb) => cb,
        None => return,
    };

    // 1. Try Image
    if let Ok(img) = cb.get_image() {
        let dims = (img.width, img.height, img.bytes.len());

        if dims != state.last_img_dims {
            let mut hasher = Sha256::new();
            hasher.update(&img.bytes);
            let hash = format!("{:x}", hasher.finalize());

            if hash != state.last_img_hash {
                if let Ok(app_dir) = resolve_images_dir(app_handle) {
                    let img_path = app_dir.join(format!("{}.png", hash));
                    if let Some(image_buffer) = ImageBuffer::<Rgba<u8>, _>::from_raw(
                        img.width as u32, img.height as u32, img.bytes.to_vec(),
                    ) {
                        if image_buffer.save(&img_path).is_ok() {
                            let path_str = img_path.to_string_lossy().to_string();
                            let source = detect::get_active_window_source();
                            state.last_img_hash = hash;
                            state.last_img_dims = dims;
                            handle_new_clip(app_handle, path_str, "image".to_string(), source);
                        }
                    }
                }
            } else {
                state.last_img_dims = dims;
            }
        }
    }

    // 2. Try Files (Windows CF_HDROP)
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
            if !files.is_empty() && files[0] != state.last_content {
                let source = detect::get_active_window_source();
                state.last_content = files[0].clone();
                handle_new_clip(app_handle, files[0].clone(), "file".to_string(), source);
            }
        }
    }

    // 3. Try Text
    if let Ok(text) = cb.get_text() {
        if text != state.last_content && !text.trim().is_empty() {
            let type_ = detect::detect_type(&text);
            let source = detect::get_active_window_source();
            state.last_content = text.clone();
            handle_new_clip(app_handle, text, type_, source);
        }
    }
}

// ── Windows: Event-driven via AddClipboardFormatListener ──

#[cfg(target_os = "windows")]
fn start_native(app_handle: tauri::AppHandle) {
    // Store handle and state in globals for the wndproc callback
    if let Ok(mut guard) = MONITOR_APP_HANDLE.lock() {
        *guard = Some(app_handle.clone());
    }
    if let Ok(mut guard) = MONITOR_STATE.lock() {
        *guard = Some(ClipboardState::new());
    }

    thread::spawn(move || {
        use windows::Win32::Foundation::*;
        use windows::Win32::UI::WindowsAndMessaging::*;
        use windows::Win32::System::DataExchange::*;
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;

        unsafe {
            let h_instance = match GetModuleHandleW(None) {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("[CLIP] Failed to get module handle: {:?}. Falling back to polling.", e);
                    start_polling(app_handle);
                    return;
                }
            };

            let class_name = windows::core::w!("SuperClipMonitor");
            let h_inst = HINSTANCE(h_instance.0);
            let wc = WNDCLASSW {
                lpfnWndProc: Some(clipboard_wndproc),
                hInstance: h_inst,
                lpszClassName: class_name,
                ..Default::default()
            };

            if RegisterClassW(&wc) == 0 {
                eprintln!("[CLIP] Failed to register window class. Falling back to polling.");
                start_polling(app_handle);
                return;
            }

            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                class_name,
                windows::core::w!("ClipboardMonitor"),
                WINDOW_STYLE::default(),
                0, 0, 0, 0,
                HWND_MESSAGE,
                None,
                h_inst,
                None,
            );

            if hwnd == HWND(0) {
                eprintln!("[CLIP] Failed to create message window. Falling back to polling.");
                start_polling(app_handle);
                return;
            }

            if AddClipboardFormatListener(hwnd).is_err() {
                eprintln!("[CLIP] AddClipboardFormatListener failed. Falling back to polling.");
                let _ = DestroyWindow(hwnd);
                start_polling(app_handle);
                return;
            }

            println!("[CLIP] Event-driven clipboard monitoring active (WM_CLIPBOARDUPDATE)");

            // Message pump
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, HWND(0), 0, 0).as_bool() {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let _ = RemoveClipboardFormatListener(hwnd);
            let _ = DestroyWindow(hwnd);
        }
    });
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn clipboard_wndproc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::*;

    const WM_CLIPBOARDUPDATE: u32 = 0x031D;

    if msg == WM_CLIPBOARDUPDATE {
        // Debounce: skip if last check was < DEBOUNCE_MS ago
        let should_check = {
            let mut last = LAST_CHECK.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            if let Some(prev) = *last {
                if now.duration_since(prev).as_millis() < DEBOUNCE_MS as u128 {
                    false
                } else {
                    *last = Some(now);
                    true
                }
            } else {
                *last = Some(now);
                true
            }
        };

        if should_check {
            let _ = std::panic::catch_unwind(|| {
                let handle_guard = MONITOR_APP_HANDLE.lock().unwrap_or_else(|e| e.into_inner());
                let app_handle = match handle_guard.as_ref() {
                    Some(h) => h.clone(),
                    None => return,
                };
                drop(handle_guard);

                let mut state_guard = MONITOR_STATE.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(state) = state_guard.as_mut() {
                    check_clipboard(&app_handle, state);
                }
            });
        }

        return windows::Win32::Foundation::LRESULT(0);
    }

    DefWindowProcW(hwnd, msg, wparam, lparam)
}

// ── Polling fallback (non-Windows or if native init fails) ──

#[allow(dead_code)]
fn start_polling(app_handle: tauri::AppHandle) {
    thread::spawn(move || {
        let mut state = ClipboardState::new();

        loop {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                check_clipboard(&app_handle, &mut state);
            }));
            thread::sleep(Duration::from_millis(300));
        }
    });
}

// ── Helpers ──

fn resolve_images_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let app_dir = app_handle.path_resolver().app_data_dir()
        .ok_or_else(|| "No app dir".to_string())?;
    let idir = app_dir.join("images");
    if !idir.exists() {
        std::fs::create_dir_all(&idir).map_err(|e| e.to_string())?;
    }
    Ok(idir)
}

fn handle_new_clip(app_handle: &tauri::AppHandle, content: String, kind: String, source: Option<String>) {
    let db = app_handle.state::<DbState>();
    let conn = db.0.lock().unwrap();

    // Check sensitive app ignore list
    if let Some(ref src) = source {
        if let Ok(Some(ignored_json)) = database::get_setting(&conn, "ignored_apps") {
            if let Ok(ignored_list) = serde_json::from_str::<Vec<String>>(&ignored_json) {
                let src_lower = src.to_lowercase();
                if ignored_list.iter().any(|app| src_lower.contains(&app.to_lowercase())) {
                    eprintln!("[CLIP] Ignored clip from sensitive app: {}", src);
                    return;
                }
            }
        }
    }

    let mode = database::get_setting(&conn, "always_intercept_clip")
        .ok().flatten()
        .unwrap_or_else(|| "ask".to_string());

    if mode == "always" {
        if database::insert_clip(&conn, content, kind, source).is_ok() {
            let _ = app_handle.emit_all("clip:created", ());
        }
    } else {
        drop(conn);

        let state = app_handle.state::<crate::PendingClipState>();
        *state.0.lock().unwrap() = Some((content, kind, source));

        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let label = format!("prompt-window-{}", id);

        let window = tauri::WindowBuilder::new(
            app_handle,
            label,
            tauri::WindowUrl::App("index.html?mode=prompt".into()),
        )
        .title("Super Clip - Prompt")
        .always_on_top(true)
        .decorations(false)
        .transparent(true)
        .inner_size(280.0, 180.0)
        .resizable(false)
        .skip_taskbar(true)
        .build();

        if let Ok(window) = window {
            #[cfg(target_os = "windows")]
            {
                use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
                use windows::Win32::Foundation::POINT;
                let mut pt = POINT { x: 0, y: 0 };
                unsafe { GetCursorPos(&mut pt); }
                let _ = window.set_position(tauri::Position::Physical(
                    tauri::PhysicalPosition { x: pt.x + 20, y: pt.y + 20 },
                ));
            }
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}
