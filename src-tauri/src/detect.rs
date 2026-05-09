use std::path::Path;
use std::sync::OnceLock;
use serde::{Serialize, Deserialize};
use regex::Regex;

/// Detect the content type of clipboard text.
/// Returns one of: "link", "image", "file", "code", "text"
pub fn detect_type(text: &str) -> String {
    let trimmed = text.trim();

    // 1. URL detection — use url crate for precision instead of substring matching
    if is_url(trimmed) {
        return "link".to_string();
    }

    // 2. File path detection — only do I/O if it looks like a path
    let clean_text = trimmed.replace('"', "").replace('\n', "").replace('\r', "");
    if looks_like_path(&clean_text) {
        let path = Path::new(&clean_text);
        if path.exists() {
            if path.is_dir() {
                return "file".to_string();
            }
            if let Some(ext) = path.extension() {
                let ext_str = ext.to_string_lossy().to_lowercase();
                if ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico"].contains(&ext_str.as_str()) {
                    return "image".to_string();
                }
            }
            return "file".to_string();
        }
    }

    // 3. Code detection (weighted heuristic)
    if is_code(text) {
        return "code".to_string();
    }

    "text".to_string()
}

/// Use url crate for precise URL validation instead of naive substring matching
fn is_url(text: &str) -> bool {
    // Quick prefix checks for common protocols
    if text.starts_with("http://")
        || text.starts_with("https://")
        || text.starts_with("ftp://")
    {
        return url::Url::parse(text).is_ok();
    }

    // www. prefix
    if text.starts_with("www.") && !text.contains(' ') {
        return url::Url::parse(&format!("https://{}", text)).is_ok();
    }

    // Other protocol schemes
    if text.contains("://") && !text.contains(' ') {
        return url::Url::parse(text).is_ok();
    }

    false
}

/// Quick heuristic to check if text looks like a file path before doing I/O
fn looks_like_path(text: &str) -> bool {
    if text.is_empty() || text.contains('\n') || text.len() > 500 {
        return false;
    }
    // Windows absolute path: C:\ D:\
    if text.len() >= 3 && text.as_bytes()[1] == b':' && (text.as_bytes()[2] == b'\\' || text.as_bytes()[2] == b'/') {
        return true;
    }
    // Unix absolute path
    if text.starts_with('/') && !text.contains(' ') {
        return true;
    }
    // UNC path
    if text.starts_with("\\\\") {
        return true;
    }
    false
}

fn is_code(text: &str) -> bool {
    let mut score = 0;
    let trimmed = text.trim();

    // JSON/Array structure
    if (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
    {
        score += 3;
    }

    // Strong indicators (weight: 2)
    let strong = [
        "function ", "class ", "import ", "export ", "impl ", "fn ",
        "<div>", "<html>", "<?php", "#include", "SELECT ", "UPDATE ", "INSERT ", "DELETE FROM",
    ];
    for ind in strong {
        if text.contains(ind) {
            score += 2;
        }
    }

    // Weak indicators (weight: 1)
    let weak = ["const ", "let ", "var ", "def ", "pub ", "match ", "=>"];
    for ind in weak {
        if text.contains(ind) {
            score += 1;
        }
    }

    // Structural: multi-line with braces/semicolons
    if text.lines().count() > 1 {
        if text.contains('{') && text.contains('}') {
            score += 2;
        }
        if text.contains(';') {
            score += 1;
        }
    }

    score >= 3
}

/// Get the name of the active foreground window's process (Windows only)
pub fn get_active_window_source() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        get_active_window_process_name().map(prettify_app_name)
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[cfg(target_os = "windows")]
fn get_active_window_process_name() -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT};
    use windows::Win32::Foundation::{CloseHandle, MAX_PATH};

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0 == 0 { return None; }

        let mut process_id: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == 0 { return None; }

        // PROCESS_QUERY_LIMITED_INFORMATION is enough for QueryFullProcessImageNameW
        // and works even on protected processes where QUERY_INFORMATION|VM_READ would fail.
        let process_handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;

        let mut buffer = [0u16; MAX_PATH as usize];
        let mut size = buffer.len() as u32;

        let result = QueryFullProcessImageNameW(
            process_handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );

        // Always close the handle — earlier versions of this function leaked
        // one process handle per active-window query (i.e. once per clipboard
        // change), which over hours/days could exhaust the handle table.
        let _ = CloseHandle(process_handle);

        if result.is_ok() {
            let path = String::from_utf16_lossy(&buffer[..size as usize]);
            if let Some(file_name) = std::path::Path::new(&path).file_name() {
                return Some(file_name.to_string_lossy().to_string());
            }
        }
        None
    }
}

#[cfg(target_os = "windows")]
fn prettify_app_name(name: String) -> String {
    let name_lower = name.to_lowercase();
    match name_lower.as_str() {
        "msedge.exe" => "Microsoft Edge".to_string(),
        "chrome.exe" => "Google Chrome".to_string(),
        "code.exe" => "Visual Studio Code".to_string(),
        "explorer.exe" => "File Explorer".to_string(),
        "notepad.exe" => "Notepad".to_string(),
        "discord.exe" => "Discord".to_string(),
        "telegram.exe" => "Telegram".to_string(),
        "super-clip.exe" => "Super Clipboard".to_string(),
        _ if name_lower.ends_with(".exe") => {
            let base = name.trim_end_matches(".exe");
            let mut chars = base.chars();
            match chars.next() {
                None => name,
                Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
            }
        }
        _ => name,
    }
}

// ── Entity Extraction ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExtractedEntity {
    pub entity_type: String,
    pub value: String,
    pub display: String,
}

struct EntityPatterns {
    email: Regex,
    phone: Regex,
    url: Regex,
    hex_color: Regex,
    ip_address: Regex,
}

static ENTITY_PATTERNS: OnceLock<EntityPatterns> = OnceLock::new();

fn patterns() -> &'static EntityPatterns {
    ENTITY_PATTERNS.get_or_init(|| EntityPatterns {
        email: Regex::new(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}").unwrap(),
        phone: Regex::new(r"(?:\+\d{1,3}[\s\-]?)?\(?\d{2,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{3,4}").unwrap(),
        url: Regex::new(r#"https?://[^\s<>"']+"#).unwrap(),
        hex_color: Regex::new(r"#[0-9a-fA-F]{3,8}\b").unwrap(),
        ip_address: Regex::new(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b").unwrap(),
    })
}

pub fn extract_entities(text: &str) -> Vec<ExtractedEntity> {
    let p = patterns();
    let mut entities = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Emails
    for m in p.email.find_iter(text) {
        let val = m.as_str().to_string();
        if seen.insert(("email".to_string(), val.clone())) {
            entities.push(ExtractedEntity {
                entity_type: "email".into(),
                display: val.clone(),
                value: val,
            });
        }
    }

    // URLs
    for m in p.url.find_iter(text) {
        let val = m.as_str().to_string();
        if seen.insert(("url".to_string(), val.clone())) {
            let display = if val.len() > 60 { format!("{}...", &val[..57]) } else { val.clone() };
            entities.push(ExtractedEntity {
                entity_type: "url".into(),
                display,
                value: val,
            });
        }
    }

    // Hex colors
    for m in p.hex_color.find_iter(text) {
        let val = m.as_str().to_string();
        if seen.insert(("color".to_string(), val.clone())) {
            entities.push(ExtractedEntity {
                entity_type: "color".into(),
                display: val.clone(),
                value: val,
            });
        }
    }

    // IP addresses
    for m in p.ip_address.find_iter(text) {
        let val = m.as_str().to_string();
        // Validate octets are 0-255
        let valid = val.split('.').all(|o| o.parse::<u16>().map(|n| n <= 255).unwrap_or(false));
        if valid && seen.insert(("ip".to_string(), val.clone())) {
            entities.push(ExtractedEntity {
                entity_type: "ip".into(),
                display: val.clone(),
                value: val,
            });
        }
    }

    // Phone numbers
    for m in p.phone.find_iter(text) {
        let val = m.as_str().to_string();
        let digits: String = val.chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.len() >= 7 && seen.insert(("phone".to_string(), val.clone())) {
            entities.push(ExtractedEntity {
                entity_type: "phone".into(),
                display: val.clone(),
                value: val,
            });
        }
    }

    // JSON detection
    let trimmed = text.trim();
    if (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
    {
        if serde_json::from_str::<serde_json::Value>(trimmed).is_ok() {
            entities.push(ExtractedEntity {
                entity_type: "json".into(),
                display: if trimmed.len() > 40 { format!("{}...", &trimmed[..37]) } else { trimmed.to_string() },
                value: trimmed.to_string(),
            });
        }
    }

    entities
}
