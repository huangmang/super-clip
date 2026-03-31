use std::time::Instant;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use windows::Win32::Foundation::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use tauri::Manager;

const DOUBLE_TAP_THRESHOLD_MS: u64 = 300;
static ENABLED: AtomicBool = AtomicBool::new(true);

// Use a Mutex for the handle and timestamp to ensure thread safety
static APP_HANDLE: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);
static LAST_INSTANT: Mutex<Option<Instant>> = Mutex::new(None);

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
}

pub fn start_hook(app_handle: tauri::AppHandle) {
    // Store the handle safely
    if let Ok(mut guard) = APP_HANDLE.lock() {
        *guard = Some(app_handle.clone());
    }

    std::thread::spawn(move || {
        unsafe {
            let h_instance = match GetModuleHandleW(None) {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("[ERROR] Failed to get module handle: {:?}", e);
                    return;
                }
            };

            let hook = match SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(keyboard_proc),
                h_instance,
                0,
            ) {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("[ERROR] Failed to set windows hook: {:?}", e);
                    return;
                }
            };

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, HWND(0), 0, 0).as_bool() {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let _ = UnhookWindowsHookEx(hook);
        }
    });
}

unsafe extern "system" fn keyboard_proc(code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    let result = std::panic::catch_unwind(|| {
        if code >= 0 {
            let msg = w_param.0 as u32;
            let kbd_ptr = l_param.0 as *const KBDLLHOOKSTRUCT;
            if kbd_ptr.is_null() {
                return;
            }
            let kbd = *kbd_ptr;
            
            // VK_LCONTROL = 0xA2, VK_RCONTROL = 0xA3, VK_CONTROL = 0x11
            let is_ctrl = kbd.vkCode == 0xA2 || kbd.vkCode == 0xA3 || kbd.vkCode == 0x11;

            if is_ctrl {
                if msg == WM_KEYUP || msg == WM_SYSKEYUP {
                    if ENABLED.load(Ordering::SeqCst) {
                        let now = Instant::now();
                        
                        let mut trigger_toggle = false;
                        if let Ok(mut last_guard) = LAST_INSTANT.lock() {
                            if let Some(last) = *last_guard {
                                if now.checked_duration_since(last).map(|d| d.as_millis()).unwrap_or(u128::MAX) < DOUBLE_TAP_THRESHOLD_MS as u128 {
                                    trigger_toggle = true;
                                    *last_guard = None; // Reset after detected
                                } else {
                                    *last_guard = Some(now);
                                }
                            } else {
                                *last_guard = Some(now);
                            }
                        }

                        if trigger_toggle {
                            if let Ok(handle_guard) = APP_HANDLE.lock() {
                                if let Some(handle) = &*handle_guard {
                                    if let Some(window) = handle.get_window("main") {
                                        let _ = (|| -> Result<(), Box<dyn std::error::Error>> {
                                            if window.is_visible().unwrap_or(false) {
                                                window.hide()?;
                                            } else {
                                                window.show()?;
                                                window.set_focus()?;
                                                if let Ok(hwnd_raw) = window.hwnd() {
                                                    let hwnd = windows::Win32::Foundation::HWND(hwnd_raw.0);
                                                    unsafe {
                                                        let _ = ShowWindow(hwnd, SW_RESTORE);
                                                        let _ = SetForegroundWindow(hwnd);
                                                    }
                                                }
                                            }
                                            Ok(())
                                        })();
                                    }
                                }
                            }
                        }
                    }
                }
            } else {
                // If ANY other key is pressed down, reset the tap sequence
                if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                    if let Ok(mut last_guard) = LAST_INSTANT.lock() {
                        *last_guard = None;
                    }
                }
            }
        }
    });

    if result.is_err() {
        eprintln!("[CRITICAL] Panic caught in keyboard_proc!");
    }

    CallNextHookEx(None, code, w_param, l_param)
}

