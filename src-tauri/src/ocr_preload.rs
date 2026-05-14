//! Background OCR preload worker.
//!
//! Rationale: the on-demand flow (user clicks an image → `perform_ocr` fires
//! → wait 3–10 s for PP-OCRv5 server model on CPU) gives users a visible
//! latency hit on every first view. The viewer becomes noticeably sluggish
//! even when the model is warm. Since `perform_ocr` already caches results
//! in the `clips` table (`ocr_text` + `ocr_lines`), we can populate that
//! cache *ahead of time* — as soon as an image clip lands — so the viewer
//! finds cached data and renders instantly.
//!
//! Design constraints:
//!   • **One worker thread**. The ORT sessions live behind a single Mutex
//!     (see `ocr.rs::recognize_text_local`), so parallel workers would
//!     contend anyway. A single serialized worker matches the engine's
//!     inherent concurrency.
//!   • **Bounded queue**. Rapid-fire pastes (5 screenshots in 10 s) could
//!     otherwise backlog ~1 minute of CPU. Drop oldest on overflow so the
//!     *most recently pasted* image — which the user is most likely to
//!     open — is never lost.
//!   • **Cache-check before work**. Between enqueue and dequeue the user
//!     might click the image, triggering synchronous `perform_ocr` which
//!     writes the cache first. Worker double-checks and skips if already
//!     populated to avoid redundant recognition.
//!   • **Best-effort**. Preload failures (missing file, engine init fail,
//!     malformed image) are logged and swallowed. The UI's on-demand path
//!     stays as the authoritative fallback.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use tauri::{AppHandle, Manager};

use crate::database;

/// Max number of queued preload tasks. On overflow we drop the OLDEST so
/// the newest paste (most likely to be clicked next) always gets in.
const QUEUE_CAP: usize = 4;

struct PreloadTask {
    clip_id: i64,
    image_path: PathBuf,
}

struct SharedQueue {
    items: Mutex<VecDeque<PreloadTask>>,
    cv: Condvar,
}

static QUEUE: OnceLock<Arc<SharedQueue>> = OnceLock::new();

/// Spawn the single preload worker thread. Call once at app boot, after
/// the DB state is managed by tauri. Safe to call more than once — only
/// the first call has effect.
pub fn start_worker(app_handle: AppHandle) {
    let queue = Arc::new(SharedQueue {
        items: Mutex::new(VecDeque::with_capacity(QUEUE_CAP)),
        cv: Condvar::new(),
    });
    if QUEUE.set(queue.clone()).is_err() {
        // Already initialized — second call is a no-op.
        return;
    }

    thread::Builder::new()
        .name("ocr-preload".into())
        .spawn(move || {
            // Drop OS thread priority so the kernel's scheduler favours
            // the UI / main-render thread when CPUs are saturated. The
            // preload's job is "eventually done before the user clicks";
            // it never has to win a CPU race.
            #[cfg(windows)]
            unsafe {
                use windows::Win32::System::Threading::{
                    GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
                };
                let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
            }

            loop {
                // Block until there's a task.
                let task = {
                    let mut guard = queue.items.lock().unwrap();
                    while guard.is_empty() {
                        guard = queue.cv.wait(guard).unwrap();
                    }
                    guard.pop_front().unwrap()
                };

                // Cache re-check: user may have clicked the image between
                // enqueue and now, and the synchronous path already wrote
                // the cache. Skip redundant work.
                let state = app_handle.state::<database::DbState>();
                {
                    let conn = match state.0.lock() {
                        Ok(c) => c,
                        Err(_) => continue,
                    };
                    if let Ok(Some(clip)) = database::get_clip_by_id(&conn, task.clip_id) {
                        let already = clip
                            .ocr_lines
                            .as_ref()
                            .map(|s| !s.is_empty() && s != "[]")
                            .unwrap_or(false);
                        if already {
                            continue;
                        }
                    } else {
                        // Clip deleted between enqueue and now.
                        continue;
                    }
                }

                // File might have been cleaned up already.
                if !task.image_path.exists() {
                    continue;
                }

                let t0 = std::time::Instant::now();
                match crate::ocr::recognize_text_local(
                    &app_handle,
                    &task.image_path.to_string_lossy(),
                ) {
                    Ok(result) => {
                        let lines_json = serde_json::to_string(&result.lines).unwrap_or_else(|_| "[]".to_string());
                        if let Ok(conn) = state.0.lock() {
                            let _ = database::update_clip_ocr(
                                &conn,
                                task.clip_id,
                                result.text.clone(),
                                lines_json,
                            );
                        }
                        println!(
                            "[OCR preload] clip={} {} lines in {:.2}s",
                            task.clip_id,
                            result.lines.len(),
                            t0.elapsed().as_secs_f32(),
                        );
                        // Let the UI refresh any OCR-aware state (badges,
                        // card thumbnail overlays, search index) without
                        // another round-trip.
                        let _ = app_handle.emit_all(
                            "ocr:preloaded",
                            serde_json::json!({
                                "clipId": task.clip_id,
                                "lineCount": result.lines.len(),
                                "textPreview": result.text.chars().take(80).collect::<String>(),
                            }),
                        );
                    }
                    Err(e) => {
                        eprintln!("[OCR preload] clip={} failed: {}", task.clip_id, e);
                    }
                }
            }
        })
        .expect("spawn ocr-preload thread");
}

/// Queue an image clip for background OCR. Non-blocking; drops the oldest
/// task if the queue is full so the newest paste always lands.
pub fn enqueue(clip_id: i64, image_path: PathBuf) {
    let Some(queue) = QUEUE.get() else { return };
    let mut guard = match queue.items.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    // Skip duplicates (same clip id already pending).
    if guard.iter().any(|t| t.clip_id == clip_id) {
        return;
    }
    if guard.len() >= QUEUE_CAP {
        guard.pop_front();
    }
    guard.push_back(PreloadTask { clip_id, image_path });
    queue.cv.notify_one();
}
