use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use chrono::Utc;
use std::fs;


#[derive(Debug, Serialize, Deserialize)]
pub struct Clip {
    pub id: i64,
    pub content: String, // Text content or file path
    #[serde(rename = "type")]
    pub type_: String,   // "text", "image", "file", "link", "code"
    pub is_favorite: bool,
    pub is_pinned: bool,
    pub created_at: String,
    pub ocr_text: Option<String>,
    pub ocr_lines: Option<String>, // JSON string
    pub embedding: Option<Vec<u8>>, // Serialized f32 vector
    pub source_app: Option<String>, // Application name (e.g., "Code.exe", "Chrome")
    pub tags: Option<String>,      // AI-generated hashtags (e.g., "#Rust #UI")
}

fn get_db_path(app_handle: &AppHandle) -> std::path::PathBuf {
    let app_dir = app_handle.path_resolver().app_data_dir().unwrap_or_else(|| {
        std::path::PathBuf::from(".")
    });
    if !app_dir.exists() {
        let _ = std::fs::create_dir_all(&app_dir);
    }
    // Create images directory if needed
    let images_dir = app_dir.join("images");
    if !images_dir.exists() {
        let _ = std::fs::create_dir_all(&images_dir);
    }
    app_dir.join("clips_v2.db")
}

pub fn init(app_handle: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path)?;

    // ── Performance Pragmas ──
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA cache_size = -8000;
         PRAGMA temp_store = MEMORY;"
    )?;
    
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

    // Attempt to add columns if they don't exist
    let _ = conn.execute("ALTER TABLE clips ADD COLUMN ocr_text TEXT", []);
    let _ = conn.execute("ALTER TABLE clips ADD COLUMN ocr_lines TEXT", []);
    let _ = conn.execute("ALTER TABLE clips ADD COLUMN is_pinned BOOLEAN DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE clips ADD COLUMN embedding BLOB", []);
    let _ = conn.execute("ALTER TABLE clips ADD COLUMN source_app TEXT", []);
    let _ = conn.execute("ALTER TABLE clips ADD COLUMN tags TEXT", []);

    // ── Critical Indexes for query performance ──
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_clips_created_at ON clips(created_at)", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_clips_type ON clips(type)", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_clips_content ON clips(content)", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_clips_pinned_created ON clips(is_pinned DESC, created_at DESC)", []);
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_clips_favorite ON clips(is_favorite)", []);

    // Add settings table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )?;

    Ok(())
}

/// Fast single-clip lookup by ID (avoids loading entire table for OCR cache checks)
pub fn get_clip_by_id(app_handle: &AppHandle, id: i64) -> Result<Option<Clip>, Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT id, content, type, is_favorite, is_pinned, created_at, ocr_text, ocr_lines, embedding, source_app, tags FROM clips WHERE id = ?1")?;
    let clip = stmt.query_row(params![id], |row| {
        Ok(Clip {
            id: row.get(0)?,
            content: row.get(1)?,
            type_: row.get(2)?,
            is_favorite: row.get(3)?,
            is_pinned: row.get(4).unwrap_or(false),
            created_at: row.get(5)?,
            ocr_text: row.get(6).ok(),
            ocr_lines: row.get(7).ok(),
            embedding: row.get(8).ok(),
            source_app: row.get(9).ok(),
            tags: row.get(10).ok(),
        })
    }).ok();
    Ok(clip)
}

pub fn get_setting(app_handle: &AppHandle, key: &str) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let val = stmt.query_row(params![key], |row| row.get(0)).ok();
    Ok(val)
}

pub fn set_setting(app_handle: &AppHandle, key: &str, value: &str) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path)?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

pub fn insert_clip(app_handle: &AppHandle, content: String, type_: String, source_app: Option<String>) -> Result<i64, Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path)?;
    let now = Utc::now().to_rfc3339();
    
    // Deduplication: if most recent non-image clip has same content, update its timestamp
    if type_ != "image" {
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM clips WHERE content = ?1 AND type != 'image' LIMIT 1",
                params![content],
                |row| row.get(0),
            )
            .ok();

        if let Some(id) = existing {
            conn.execute(
                "UPDATE clips SET created_at = ?1 WHERE id = ?2",
                params![now, id],
            )?;
            return Ok(id);
        }
    }

    conn.execute(
        "INSERT INTO clips (content, type, created_at, source_app) VALUES (?1, ?2, ?3, ?4)",
        params![content, type_, now, source_app],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn get_all(app_handle: &AppHandle) -> Result<Vec<Clip>, Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, content, type, is_favorite, is_pinned, created_at, ocr_text, ocr_lines, embedding, source_app, tags FROM clips ORDER BY is_pinned DESC, created_at DESC")?;
    let clips_iter = stmt.query_map([], |row| {
        Ok(Clip {
            id: row.get(0)?,
            content: row.get(1)?,
            type_: row.get(2)?,
            is_favorite: row.get(3)?,
            is_pinned: row.get(4).unwrap_or(false),
            created_at: row.get(5)?,
            ocr_text: row.get(6).ok(),
            ocr_lines: row.get(7).ok(),
            embedding: row.get(8).ok(),
            source_app: row.get(9).ok(),
            tags: row.get(10).ok(),
        })
    })?;

    let mut clips = Vec::new();
    for clip in clips_iter {
        clips.push(clip?);
    }
    Ok(clips)
}

pub fn toggle_favorite(app_handle: &AppHandle, id: i64) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path)?;
    conn.execute(
        "UPDATE clips SET is_favorite = NOT is_favorite WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn toggle_pin(app_handle: &AppHandle, id: i64) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path)?;
    conn.execute(
        "UPDATE clips SET is_pinned = NOT is_pinned WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn delete_clip(app_handle: &AppHandle, id: i64) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let app_dir = app_handle.path_resolver().app_data_dir().ok_or("Could not resolve app data directory")?;
    let conn = Connection::open(db_path)?;

    // If image, delete local file
    let mut stmt = conn.prepare("SELECT content, type FROM clips WHERE id = ?1")?;
    if let Ok((content, type_)) = stmt.query_row(params![id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) {
        if type_ == "image" {
            let file_path = app_dir.join("images").join(&content);
            if file_path.exists() {
                let _ = fs::remove_file(file_path);
            }
        }
    }

    conn.execute("DELETE FROM clips WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn clear_all(app_handle: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let app_dir = app_handle.path_resolver().app_data_dir().ok_or("Could not resolve app data directory")?;
    let conn = Connection::open(db_path)?;

    // 1. Get all image paths that will be deleted
    let mut stmt = conn.prepare("SELECT content FROM clips WHERE is_favorite = 0 AND is_pinned = 0 AND type = 'image'")?;
    let img_paths_iter = stmt.query_map([], |row| row.get::<_, String>(0))?;

    for img_name in img_paths_iter {
        if let Ok(name) = img_name {
            let file_path = app_dir.join("images").join(name);
            if file_path.exists() {
                let _ = fs::remove_file(file_path);
            }
        }
    }

    // 2. Delete from DB
    conn.execute("DELETE FROM clips WHERE is_favorite = 0 AND is_pinned = 0", [])?;
    Ok(())
}

pub fn cleanup_by_retention(app_handle: &AppHandle, days: i64) -> Result<(), Box<dyn std::error::Error>> {
    if days <= 0 { return Ok(()); } // 0 means "Always keep"
    
    let db_path = get_db_path(app_handle);
    let app_dir = app_handle.path_resolver().app_data_dir().ok_or("Could not resolve app data directory")?;
    let conn = Connection::open(db_path)?;

    // Calculate the threshold date
    let threshold = Utc::now() - chrono::Duration::days(days);
    let threshold_str = threshold.to_rfc3339();

    // 1. Get all image paths that will be deleted
    let mut stmt = conn.prepare("SELECT content FROM clips WHERE is_favorite = 0 AND is_pinned = 0 AND type = 'image' AND created_at < ?1")?;
    let img_paths_iter = stmt.query_map(params![threshold_str], |row| row.get::<_, String>(0))?;

    for img_name in img_paths_iter {
        if let Ok(name) = img_name {
            let file_path = app_dir.join("images").join(name);
            if file_path.exists() {
                let _ = fs::remove_file(file_path);
            }
        }
    }

    // 2. Delete from DB
    conn.execute("DELETE FROM clips WHERE is_favorite = 0 AND is_pinned = 0 AND created_at < ?1", params![threshold_str])?;
    Ok(())
}

pub fn update_clip_ocr(app_handle: &AppHandle, id: i64, ocr_text: String, ocr_lines: String) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path)?;

    conn.execute(
        "UPDATE clips SET ocr_text = ?1, ocr_lines = ?2 WHERE id = ?3",
        params![ocr_text, ocr_lines, id],
    )?;

    Ok(())
}

pub fn update_clip_embedding(app_handle: &AppHandle, id: i64, embedding: Vec<u8>) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path)?;

    conn.execute(
        "UPDATE clips SET embedding = ?1 WHERE id = ?2",
        params![embedding, id],
    )?;

    Ok(())
}

pub fn get_stats_by_range(app_handle: &AppHandle, range_str: Option<&str>) -> Result<std::collections::HashMap<String, i64>, Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path)?;
    
    let query = if let Some(range) = range_str {
        if range == "all" {
            "SELECT type, COUNT(*) FROM clips GROUP BY type".to_string()
        } else {
            format!("SELECT type, COUNT(*) FROM clips WHERE created_at >= datetime('now', '{}') GROUP BY type", range)
        }
    } else {
        "SELECT type, COUNT(*) FROM clips GROUP BY type".to_string()
    };

    let mut stmt = conn.prepare(&query)?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;

    let mut stats = std::collections::HashMap::new();
    for row in rows {
        let (type_, count) = row?;
        stats.insert(type_, count);
    }
    Ok(stats)
}

pub fn get_stats(app_handle: &AppHandle) -> Result<std::collections::HashMap<String, i64>, Box<dyn std::error::Error>> {
    get_stats_by_range(app_handle, None)
}

pub fn get_recent_text_content(app_handle: &AppHandle) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare("SELECT content FROM clips WHERE type IN ('text', 'code', 'link') ORDER BY created_at DESC LIMIT 50")?;
    let rows = stmt.query_map([], |row| {
        Ok(row.get::<_, String>(0)?)
    })?;

    let mut contents = Vec::new();
    for row in rows {
        contents.push(row?);
    }
    Ok(contents)
}

pub fn get_recent_content_by_range(app_handle: &AppHandle, range_str: &str) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path)?;
    // range_str like '-30 minutes', '-2 hours', '-1 day', '-3 days'
    // Include all types so count is correct
    let query = if range_str == "all" {
        "SELECT content FROM clips ORDER BY created_at DESC LIMIT 500".to_string()
    } else {
        format!(
            "SELECT content FROM clips WHERE created_at >= datetime('now', '{}') ORDER BY created_at DESC LIMIT 100",
            range_str
        )
    };
    let mut stmt = conn.prepare(&query)?;
    let rows = stmt.query_map([], |row| {
        Ok(row.get::<_, String>(0)?)
    })?;

    let mut contents = Vec::new();
    for row in rows {
        contents.push(row?);
    }
    Ok(contents)
}

pub fn update_clip_tags(app_handle: &AppHandle, id: i64, tags: String) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path)?;
    conn.execute("UPDATE clips SET tags = ?1 WHERE id = ?2", params![tags, id])?;
    Ok(())
}

pub fn get_all_tags_with_counts(app_handle: &AppHandle) -> Result<std::collections::HashMap<String, i64>, Box<dyn std::error::Error>> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path)?;
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
