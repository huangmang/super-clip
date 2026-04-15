use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use chrono::Utc;
use std::fs;
use std::sync::Mutex;

// ── Unified Error Type ──

#[derive(thiserror::Error, Debug)]
pub enum AppError {
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    General(String),
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::General(s.to_string())
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::General(s)
    }
}

// Make AppError serializable for Tauri commands
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = std::result::Result<T, AppError>;

// ── Managed Database State ──

pub struct DbState(pub Mutex<Connection>);

// ── Data Models ──

#[derive(Debug, Serialize, Deserialize)]
pub struct Clip {
    pub id: i64,
    pub content: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub is_favorite: bool,
    pub is_pinned: bool,
    pub created_at: String,
    pub ocr_text: Option<String>,
    pub ocr_lines: Option<String>,
    pub source_app: Option<String>,
    pub tags: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClipPage {
    pub items: Vec<Clip>,
    pub total: i64,
    pub has_more: bool,
}

// ── Helpers ──

fn get_db_path(app_handle: &AppHandle) -> std::path::PathBuf {
    let app_dir = app_handle.path_resolver().app_data_dir().unwrap_or_else(|| {
        std::path::PathBuf::from(".")
    });
    if !app_dir.exists() {
        let _ = std::fs::create_dir_all(&app_dir);
    }
    let images_dir = app_dir.join("images");
    if !images_dir.exists() {
        let _ = std::fs::create_dir_all(&images_dir);
    }
    app_dir.join("clips_v2.db")
}

/// Whitelist of allowed SQLite time modifiers to prevent SQL injection.
fn validate_time_modifier(range: &str) -> AppResult<()> {
    let re = regex::Regex::new(r"^-\d+ (minutes?|hours?|days?|months?)$").unwrap();
    if !re.is_match(range) {
        return Err(AppError::General(format!("Invalid time range modifier: {}", range)));
    }
    Ok(())
}

fn row_to_clip(row: &rusqlite::Row<'_>) -> rusqlite::Result<Clip> {
    Ok(Clip {
        id: row.get(0)?,
        content: row.get(1)?,
        type_: row.get(2)?,
        is_favorite: row.get(3)?,
        is_pinned: row.get(4).unwrap_or(false),
        created_at: row.get(5)?,
        ocr_text: row.get(6).ok(),
        ocr_lines: row.get(7).ok(),
        source_app: row.get(8).ok(),
        tags: row.get(9).ok(),
    })
}

const CLIP_SELECT_COLS: &str = "id, content, type, is_favorite, is_pinned, created_at, ocr_text, ocr_lines, source_app, tags";

// ── Public API (all take &Connection instead of reopening) ──

pub fn open_connection(app_handle: &AppHandle) -> AppResult<Connection> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA cache_size = -8000;
         PRAGMA temp_store = MEMORY;
         PRAGMA mmap_size = 268435456;"
    )?;
    Ok(conn)
}

pub fn init(app_handle: &AppHandle) -> AppResult<Connection> {
    let conn = open_connection(app_handle)?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS clips (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            type TEXT NOT NULL,
            is_favorite BOOLEAN DEFAULT 0,
            is_pinned BOOLEAN DEFAULT 0,
            created_at TEXT NOT NULL
        )",
        [],
    )?;

    // Migrate: add columns if they don't exist
    let _ = conn.execute("ALTER TABLE clips ADD COLUMN ocr_text TEXT", []);
    let _ = conn.execute("ALTER TABLE clips ADD COLUMN ocr_lines TEXT", []);
    let _ = conn.execute("ALTER TABLE clips ADD COLUMN is_pinned BOOLEAN DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE clips ADD COLUMN source_app TEXT", []);
    let _ = conn.execute("ALTER TABLE clips ADD COLUMN tags TEXT", []);

    // Indexes — optimized for actual query patterns
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_clips_created_at ON clips(created_at)", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_clips_type ON clips(type)", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_clips_pinned_created ON clips(is_pinned DESC, created_at DESC)", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_clips_favorite ON clips(is_favorite)", []);
    // Partial index for dedup query (WHERE content = ? AND type != 'image')
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_clips_dedup ON clips(content) WHERE type != 'image'", []);
    // Composite for cleanup/clear (WHERE is_favorite = 0 AND is_pinned = 0 AND created_at < ?)
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_clips_cleanup ON clips(is_favorite, is_pinned, created_at)", []);
    // Covering index for stats queries (GROUP BY type with created_at filter)
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_clips_stats ON clips(created_at, type)", []);
    // Drop redundant full content index (replaced by partial idx_clips_dedup)
    let _ = conn.execute("DROP INDEX IF EXISTS idx_clips_content", []);

    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS snippets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            trigger_text TEXT,
            created_at TEXT NOT NULL
        )",
        [],
    )?;

    Ok(conn)
}

pub fn get_clip_by_id(conn: &Connection, id: i64) -> AppResult<Option<Clip>> {
    let sql = format!("SELECT {} FROM clips WHERE id = ?1", CLIP_SELECT_COLS);
    let clip = conn.query_row(&sql, params![id], row_to_clip).ok();
    Ok(clip)
}

pub fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let val = conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    ).ok();
    Ok(val)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

pub fn insert_clip(conn: &Connection, content: String, type_: String, source_app: Option<String>) -> AppResult<i64> {
    let now = Utc::now().to_rfc3339();

    // Deduplication for non-image clips
    if type_ != "image" {
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM clips WHERE content = ?1 AND type != 'image' LIMIT 1",
                params![content],
                |row| row.get(0),
            )
            .ok();

        if let Some(id) = existing {
            conn.execute("UPDATE clips SET created_at = ?1 WHERE id = ?2", params![now, id])?;
            return Ok(id);
        }
    }

    conn.execute(
        "INSERT INTO clips (content, type, created_at, source_app) VALUES (?1, ?2, ?3, ?4)",
        params![content, type_, now, source_app],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Paginated query — excludes large blob fields, returns page info
pub fn get_clips_paginated(conn: &Connection, limit: i64, offset: i64) -> AppResult<ClipPage> {
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM clips", [], |row| row.get(0))?;

    let sql = format!(
        "SELECT {} FROM clips ORDER BY is_pinned DESC, created_at DESC LIMIT ?1 OFFSET ?2",
        CLIP_SELECT_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let clips_iter = stmt.query_map(params![limit, offset], row_to_clip)?;

    let mut items = Vec::new();
    for clip in clips_iter {
        items.push(clip?);
    }

    Ok(ClipPage {
        has_more: (offset + limit) < total,
        total,
        items,
    })
}

/// Legacy get_all for backward compat — now without embedding
pub fn get_all(conn: &Connection) -> AppResult<Vec<Clip>> {
    let sql = format!(
        "SELECT {} FROM clips ORDER BY is_pinned DESC, created_at DESC",
        CLIP_SELECT_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let clips_iter = stmt.query_map([], row_to_clip)?;

    let mut clips = Vec::new();
    for clip in clips_iter {
        clips.push(clip?);
    }
    Ok(clips)
}

/// For fuzzy search: returns clips with a combined search haystack
pub struct SearchableClip {
    pub clip: Clip,
    pub haystack: String,
}

pub fn get_searchable_clips(conn: &Connection, limit: i64) -> AppResult<Vec<SearchableClip>> {
    let sql = format!(
        "SELECT {}, content || ' ' || COALESCE(ocr_text, '') || ' ' || COALESCE(source_app, '') || ' ' || COALESCE(tags, '') as haystack FROM clips ORDER BY created_at DESC LIMIT ?1",
        CLIP_SELECT_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![limit], |row| {
        let clip = row_to_clip(row)?;
        let haystack: String = row.get(10)?; // 11th column (0-indexed: 10)
        Ok(SearchableClip { clip, haystack })
    })?;

    let mut result = Vec::new();
    for r in rows { result.push(r?); }
    Ok(result)
}

pub fn toggle_favorite(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("UPDATE clips SET is_favorite = NOT is_favorite WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn toggle_pin(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("UPDATE clips SET is_pinned = NOT is_pinned WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn delete_clip(conn: &Connection, _app_handle: &AppHandle, id: i64) -> AppResult<()> {
    // If image, delete local file using the absolute path stored in content
    let mut stmt = conn.prepare("SELECT content, type FROM clips WHERE id = ?1")?;
    if let Ok((content, type_)) = stmt.query_row(params![id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) {
        if type_ == "image" {
            let path = std::path::Path::new(&content);
            if path.exists() {
                let _ = fs::remove_file(path);
            }
        }
    }

    conn.execute("DELETE FROM clips WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn batch_delete_clips(conn: &Connection, ids: &[i64]) -> AppResult<()> {
    if ids.is_empty() { return Ok(()); }

    // Build parameterized IN clause
    let placeholders: Vec<String> = ids.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect();
    let in_clause = placeholders.join(",");

    // Delete associated image files
    let select_sql = format!("SELECT content FROM clips WHERE type = 'image' AND id IN ({})", in_clause);
    let mut stmt = conn.prepare(&select_sql)?;
    let img_paths = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |row| row.get::<_, String>(0))?;
    for img_path in img_paths {
        if let Ok(p) = img_path {
            let path = std::path::Path::new(&p);
            if path.exists() {
                let _ = fs::remove_file(path);
            }
        }
    }

    let delete_sql = format!("DELETE FROM clips WHERE id IN ({})", in_clause);
    conn.execute(&delete_sql, rusqlite::params_from_iter(ids.iter()))?;
    Ok(())
}

pub fn clear_all(conn: &Connection) -> AppResult<()> {
    // Delete image files
    let mut stmt = conn.prepare("SELECT content FROM clips WHERE is_favorite = 0 AND is_pinned = 0 AND type = 'image'")?;
    let img_paths = stmt.query_map([], |row| row.get::<_, String>(0))?;
    for img_path in img_paths {
        if let Ok(p) = img_path {
            let path = std::path::Path::new(&p);
            if path.exists() {
                let _ = fs::remove_file(path);
            }
        }
    }

    conn.execute("DELETE FROM clips WHERE is_favorite = 0 AND is_pinned = 0", [])?;
    Ok(())
}

pub fn cleanup_by_retention(conn: &Connection, days: i64) -> AppResult<()> {
    if days <= 0 { return Ok(()); }

    let threshold = Utc::now() - chrono::Duration::days(days);
    let threshold_str = threshold.to_rfc3339();

    // Delete image files
    let mut stmt = conn.prepare("SELECT content FROM clips WHERE is_favorite = 0 AND is_pinned = 0 AND type = 'image' AND created_at < ?1")?;
    let img_paths = stmt.query_map(params![threshold_str], |row| row.get::<_, String>(0))?;
    for img_path in img_paths {
        if let Ok(p) = img_path {
            let path = std::path::Path::new(&p);
            if path.exists() {
                let _ = fs::remove_file(path);
            }
        }
    }

    conn.execute("DELETE FROM clips WHERE is_favorite = 0 AND is_pinned = 0 AND created_at < ?1", params![threshold_str])?;
    Ok(())
}

pub fn update_clip_ocr(conn: &Connection, id: i64, ocr_text: String, ocr_lines: String) -> AppResult<()> {
    conn.execute(
        "UPDATE clips SET ocr_text = ?1, ocr_lines = ?2 WHERE id = ?3",
        params![ocr_text, ocr_lines, id],
    )?;
    Ok(())
}

pub fn get_stats_by_range(conn: &Connection, range_str: Option<&str>) -> AppResult<std::collections::HashMap<String, i64>> {
    let mut stats = std::collections::HashMap::new();

    // Use Rust's local time as threshold to match frontend's Date.now() filtering
    match range_str {
        Some("all") | None => {
            let mut stmt = conn.prepare("SELECT type, COUNT(*) FROM clips GROUP BY type")?;
            let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
            for row in rows { let (t, c) = row?; stats.insert(t, c); }
        }
        Some(range) => {
            validate_time_modifier(range)?;
            // Calculate threshold using chrono local time to stay consistent with frontend
            let threshold = compute_threshold(range)?;
            let mut stmt = conn.prepare("SELECT type, COUNT(*) FROM clips WHERE created_at >= ?1 GROUP BY type")?;
            let rows = stmt.query_map(params![threshold], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
            for row in rows { let (t, c) = row?; stats.insert(t, c); }
        }
    }

    Ok(stats)
}

/// Parse a time modifier like "-30 minutes" and return an RFC3339 threshold string
fn compute_threshold(range: &str) -> AppResult<String> {
    let parts: Vec<&str> = range.trim().split_whitespace().collect();
    if parts.len() != 2 { return Err(AppError::General(format!("Invalid range: {}", range))); }
    let n: i64 = parts[0].parse().map_err(|_| AppError::General(format!("Invalid number: {}", parts[0])))?;
    let unit = parts[1].trim_end_matches('s'); // "minutes" -> "minute"
    let duration = match unit {
        "minute" => chrono::Duration::minutes(-n),
        "hour" => chrono::Duration::hours(-n),
        "day" => chrono::Duration::days(-n),
        "month" => chrono::Duration::days(-n * 30),
        _ => return Err(AppError::General(format!("Unknown unit: {}", unit))),
    };
    let threshold = Utc::now() + duration;
    Ok(threshold.to_rfc3339())
}

pub fn get_recent_text_content(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT content FROM clips WHERE type IN ('text', 'code', 'link') ORDER BY created_at DESC LIMIT 50")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut contents = Vec::new();
    for row in rows { contents.push(row?); }
    Ok(contents)
}

pub fn get_recent_content_by_range(conn: &Connection, range_str: &str) -> AppResult<Vec<String>> {
    let mut contents = Vec::new();

    if range_str == "all" {
        let mut stmt = conn.prepare("SELECT content FROM clips ORDER BY created_at DESC LIMIT 500")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for row in rows { contents.push(row?); }
    } else {
        validate_time_modifier(range_str)?;
        let threshold = compute_threshold(range_str)?;
        let mut stmt = conn.prepare("SELECT content FROM clips WHERE created_at >= ?1 ORDER BY created_at DESC LIMIT 100")?;
        let rows = stmt.query_map(params![threshold], |row| row.get::<_, String>(0))?;
        for row in rows { contents.push(row?); }
    }

    Ok(contents)
}

pub fn update_clip_tags(conn: &Connection, id: i64, tags: String) -> AppResult<()> {
    conn.execute("UPDATE clips SET tags = ?1 WHERE id = ?2", params![tags, id])?;
    Ok(())
}

pub fn get_all_tags_with_counts(conn: &Connection) -> AppResult<std::collections::HashMap<String, i64>> {
    let mut stmt = conn.prepare("SELECT tags FROM clips WHERE tags IS NOT NULL")?;
    let tag_rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut tag_counts = std::collections::HashMap::new();
    for tags_str in tag_rows {
        if let Ok(s) = tags_str {
            for tag in s.split_whitespace() {
                if tag.starts_with('#') {
                    *tag_counts.entry(tag.to_string()).or_insert(0) += 1;
                }
            }
        }
    }
    Ok(tag_counts)
}

pub fn get_source_app_stats(conn: &Connection, range_str: Option<&str>) -> AppResult<Vec<(String, i64)>> {
    let mut result = Vec::new();

    match range_str {
        Some("all") | None => {
            let mut stmt = conn.prepare("SELECT COALESCE(source_app, 'Unknown'), COUNT(*) FROM clips GROUP BY source_app ORDER BY COUNT(*) DESC LIMIT 15")?;
            let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
            for row in rows { result.push(row?); }
        }
        Some(range) => {
            validate_time_modifier(range)?;
            let threshold = compute_threshold(range)?;
            let mut stmt = conn.prepare("SELECT COALESCE(source_app, 'Unknown'), COUNT(*) FROM clips WHERE created_at >= ?1 GROUP BY source_app ORDER BY COUNT(*) DESC LIMIT 15")?;
            let rows = stmt.query_map(params![threshold], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
            for row in rows { result.push(row?); }
        }
    }

    Ok(result)
}

// ── Snippets ──

#[derive(Debug, Serialize, Deserialize)]
pub struct Snippet {
    pub id: i64,
    pub name: String,
    pub content: String,
    pub trigger_text: Option<String>,
    pub created_at: String,
}

pub fn get_all_snippets(conn: &Connection) -> AppResult<Vec<Snippet>> {
    let mut stmt = conn.prepare("SELECT id, name, content, trigger_text, created_at FROM snippets ORDER BY created_at DESC")?;
    let rows = stmt.query_map([], |row| {
        Ok(Snippet {
            id: row.get(0)?,
            name: row.get(1)?,
            content: row.get(2)?,
            trigger_text: row.get(3).ok(),
            created_at: row.get(4)?,
        })
    })?;
    let mut snippets = Vec::new();
    for r in rows { snippets.push(r?); }
    Ok(snippets)
}

pub fn insert_snippet(conn: &Connection, name: String, content: String, trigger_text: Option<String>) -> AppResult<i64> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO snippets (name, content, trigger_text, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![name, content, trigger_text, now],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update_snippet(conn: &Connection, id: i64, name: String, content: String, trigger_text: Option<String>) -> AppResult<()> {
    conn.execute(
        "UPDATE snippets SET name = ?1, content = ?2, trigger_text = ?3 WHERE id = ?4",
        params![name, content, trigger_text, id],
    )?;
    Ok(())
}

pub fn delete_snippet(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])?;
    Ok(())
}
