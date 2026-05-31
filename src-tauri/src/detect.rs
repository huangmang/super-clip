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

static CODE_ASSIGN: OnceLock<Regex> = OnceLock::new();
static CODE_FUNC: OnceLock<Regex> = OnceLock::new();

fn is_code(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }

    // Bracketed structure that actually carries code-ish punctuation. Bare
    // "{a stray thought}" prose no longer qualifies.
    if (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
    {
        if trimmed.contains(':') || trimmed.contains(',') || trimmed.contains('"') {
            return true;
        }
    }

    let mut score = 0;

    // Strong, near-zero-false-positive signals — any single one clears the bar.
    let strong = [
        "function ", "=> {", "});", "<?php", "#include", "public static",
        "println!", "console.log", "System.out", "#!/", "</", "</>",
    ];
    if strong.iter().any(|s| text.contains(s)) {
        score += 3;
    }

    // SQL: SELECT/UPDATE/DELETE co-occurring with FROM/WHERE/SET is unambiguous.
    let upper = text.to_uppercase();
    if (upper.contains("SELECT ") && upper.contains(" FROM "))
        || (upper.contains("INSERT INTO "))
        || (upper.contains("UPDATE ") && upper.contains(" SET "))
        || (upper.contains("DELETE FROM "))
    {
        score += 3;
    }

    // A real `const/let/var NAME =` or `def/fn/func NAME(` assignment/definition
    // — regex-anchored so prose like "let me", "var" (other languages), or a
    // lone "=>" in notes doesn't trip it.
    let assign = CODE_ASSIGN.get_or_init(|| {
        Regex::new(r"\b(const|let|var|val)\s+[A-Za-z_$][\w$]*\s*[:=]").unwrap()
    });
    if assign.is_match(text) {
        score += 3;
    }
    let func = CODE_FUNC.get_or_init(|| {
        Regex::new(r"\b(fn|def|func|function)\s+[A-Za-z_][\w]*\s*\(").unwrap()
    });
    if func.is_match(text) {
        score += 3;
    }

    // Medium signals (weight 2).
    let medium = [
        "class ", "import ", "export ", "impl ", "trait ",
        "SELECT ", "INSERT ", "UPDATE ", "DELETE FROM", "<div", "<span",
    ];
    for ind in medium {
        if text.contains(ind) {
            score += 2;
        }
    }

    // Structural: several lines that END in code punctuation (;, {, }). A lone
    // semicolon inside prose no longer counts — must be ≥2 code-terminated lines.
    let code_line_ends = text
        .lines()
        .filter(|l| {
            let t = l.trim_end();
            t.ends_with(';') || t.ends_with('{') || t.ends_with('}')
        })
        .count();
    if code_line_ends >= 2 {
        score += 2;
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

/// Per-type cap so a log or dump can't spray dozens of chips. Entities are
/// "quick actions for an actionable value", not "scrape everything".
const MAX_PER_TYPE: usize = 3;

/// A clipboard item this long is a document/log/dump, not "a value with an
/// entity in it". Skip extraction entirely — the chips were pure noise there.
const ENTITY_SCAN_MAX_LEN: usize = 4000;

/// Reject phone false positives: version numbers (1.0.20), build/timestamp/id
/// digit runs, etc. A real phone number we surface must either carry an
/// explicit `+CC` prefix, or be a plausible 7–15 digit number that is NOT just
/// a bare run of digits embedded in a larger token.
fn looks_like_phone(m: &regex::Match<'_>, text: &str) -> bool {
    let s = m.as_str();
    let digits: usize = s.chars().filter(|c| c.is_ascii_digit()).count();
    if !(7..=15).contains(&digits) {
        return false;
    }
    // Must contain a phone-ish separator or a country-code prefix; a bare
    // unseparated digit run (1234567, version/build/id) is rejected.
    let has_plus = s.trim_start().starts_with('+');
    let has_sep = s.contains(' ') || s.contains('-') || s.contains('(');
    if !has_plus && !has_sep {
        return false;
    }
    // Reject if the match sits inside a longer alphanumeric/dotted token
    // (version strings like 1.0.20.345, hashes, ids).
    let bytes = text.as_bytes();
    let start = m.start();
    let end = m.end();
    let prev_ok = start == 0 || {
        let c = bytes[start - 1] as char;
        !(c.is_ascii_alphanumeric() || c == '.')
    };
    let next_ok = end >= bytes.len() || {
        let c = bytes[end] as char;
        !(c.is_ascii_alphanumeric() || c == '.')
    };
    prev_ok && next_ok
}

pub fn extract_entities(text: &str) -> Vec<ExtractedEntity> {
    let mut entities = Vec::new();

    // Don't mine entities out of long documents/logs — that's where the chip
    // spam came from. JSON below is still detected (it keys off the whole clip).
    if text.len() <= ENTITY_SCAN_MAX_LEN {
        let p = patterns();
        let mut seen = std::collections::HashSet::new();
        let mut push = |entities: &mut Vec<ExtractedEntity>, kind: &str, value: String, display: String| {
            if entities.iter().filter(|e| e.entity_type == kind).count() >= MAX_PER_TYPE {
                return;
            }
            if seen.insert((kind.to_string(), value.clone())) {
                entities.push(ExtractedEntity { entity_type: kind.into(), display, value });
            }
        };

        // Emails — low false-positive, keep as-is (capped).
        for m in p.email.find_iter(text) {
            let val = m.as_str().to_string();
            push(&mut entities, "email", val.clone(), val);
        }

        // URLs — capped so a link-heavy log doesn't spray a row of chips.
        for m in p.url.find_iter(text) {
            let val = m.as_str().to_string();
            let display = if val.len() > 60 { format!("{}...", &val[..57]) } else { val.clone() };
            push(&mut entities, "url", val, display);
        }

        // Hex colors.
        for m in p.hex_color.find_iter(text) {
            let val = m.as_str().to_string();
            push(&mut entities, "color", val.clone(), val);
        }

        // IP addresses — octets 0-255 AND reject version-number shapes
        // (leading-zero octets like 01, or values that are really X.Y.Z.W
        // version strings are caught by the octet range; we additionally
        // require it not be glued to surrounding alphanumerics).
        for m in p.ip_address.find_iter(text) {
            let val = m.as_str().to_string();
            let octets_ok = val.split('.').all(|o| {
                // reject leading zeros ("01") which are version- not IP-style
                (o.len() == 1 || !o.starts_with('0'))
                    && o.parse::<u16>().map(|n| n <= 255).unwrap_or(false)
            });
            let bytes = text.as_bytes();
            let prev_ok = m.start() == 0 || !(bytes[m.start() - 1] as char).is_ascii_alphanumeric();
            let next_ok = m.end() >= bytes.len() || !(bytes[m.end()] as char).is_ascii_alphanumeric();
            if octets_ok && prev_ok && next_ok {
                push(&mut entities, "ip", val.clone(), val);
            }
        }

        // Phone numbers — strict, see looks_like_phone.
        for m in p.phone.find_iter(text) {
            if looks_like_phone(&m, text) {
                let val = m.as_str().trim().to_string();
                push(&mut entities, "phone", val.clone(), val);
            }
        }
    }

    // JSON detection — keys off the entire clip, so it's safe even for long
    // content (a big JSON blob is exactly when "Format" is most useful).
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

#[cfg(test)]
mod detection_quality_tests {
    use super::*;

    #[test]
    fn code_detection_accepts_real_code() {
        assert!(is_code("const x = 5;"));
        assert!(is_code("function foo() {\n  return 1;\n}"));
        assert!(is_code("fn main() {\n    println!(\"hi\");\n}"));
        assert!(is_code("def foo(x):\n    return x"));
        assert!(is_code("{\"a\": 1, \"b\": 2}"));
        assert!(is_code("SELECT * FROM users WHERE id = 1"));
    }

    #[test]
    fn code_detection_rejects_prose() {
        // The old heuristic tripped on a stray `=>`, a lone `;`, or `let`/`var`
        // appearing in natural-language text. These must all stay plain text.
        assert!(!is_code("我们今天讨论一下这个方案,然后 => 下一步"));
        assert!(!is_code("Let me know when you're done; thanks"));
        assert!(!is_code("会议纪要:第一项,第二项,第三项"));
        assert!(!is_code("Build 12133786 finished at 23:27"));
    }

    #[test]
    fn entities_reject_version_and_id_noise() {
        let kinds = |t: &str| {
            extract_entities(t).into_iter().map(|x| x.entity_type).collect::<Vec<_>>()
        };
        assert!(!kinds("version 1.0.20 released").contains(&"phone".to_string()));
        assert!(!kinds("build 12133786").contains(&"phone".to_string()));
        assert!(!kinds("1.0.20").contains(&"ip".to_string()));
        assert!(kinds("call me at +1 415-555-0199").contains(&"phone".to_string()));
        assert!(kinds("server 192.168.1.1 down").contains(&"ip".to_string()));
    }

    #[test]
    fn entities_skip_long_documents() {
        let long_log = "x".repeat(5000) + " http://a.com test@b.com";
        assert!(extract_entities(&long_log).is_empty());
    }
}
