use serde::Serialize;

#[derive(Serialize)]
pub struct FileResult {
    pub name: String,
    pub path: String,
    pub is_folder: bool,
    pub size: Option<u64>,
}

/// Stable error tags the frontend can match on to show a specific
/// remediation message. The actual diagnostic is appended after `: `.
pub const ERR_NOT_INSTALLED: &str = "EVERYTHING_NOT_INSTALLED";
pub const ERR_NOT_RUNNING: &str = "EVERYTHING_NOT_RUNNING";

pub fn search(query: &str, max_results: u32) -> Result<Vec<FileResult>, String> {
    let mut global = everything_sdk::ergo::global()
        .lock()
        .map_err(|e| classify_sdk_error(&e.to_string()))?;
    let mut searcher = global.searcher();

    searcher.set_search(query);
    searcher.set_max(max_results);

    let results = searcher.query();

    let mut out = Vec::new();
    for item in results.iter() {
        let name = item.filename().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let full_path = item.filepath().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();

        out.push(FileResult {
            name,
            path: full_path,
            is_folder: item.is_folder(),
            size: item.size().ok(),
        });
    }

    Ok(out)
}

/// Map raw SDK error strings to a `TAG: message` form the frontend can
/// pattern-match. The Everything IPC SDK loads `Everything*.dll` and
/// connects to the running Everything service via Win32 messages; failures
/// look like "library not found" (DLL absent → app not installed) or
/// "service not running" / "no IPC window" (DLL ok but Everything.exe
/// is not started).
fn classify_sdk_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("not found") || lower.contains("could not load") || lower.contains("no such file") {
        format!("{}: {}", ERR_NOT_INSTALLED, raw)
    } else if lower.contains("not running") || lower.contains("ipc") || lower.contains("connect") || lower.contains("timeout") {
        format!("{}: {}", ERR_NOT_RUNNING, raw)
    } else {
        // Fallback — surface raw error so we don't bury unknown failures.
        raw.to_string()
    }
}


