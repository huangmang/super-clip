use serde::{Deserialize, Serialize};
use std::path::Path;
use ort::{inputs, value::Value, session::Session};
use image::{DynamicImage, GenericImageView, imageops::FilterType};

#[cfg(target_os = "windows")]
use windows::{
    Graphics::Imaging::BitmapDecoder,
    Media::Ocr::OcrEngine,
    Storage::{FileAccessMode, StorageFile},
};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OcrLine {
    pub text: String,
    pub confidence: f64,
    pub box_coords: Option<Vec<Vec<f64>>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OcrResult {
    pub text: String,
    pub lines: Vec<OcrLine>,
}

#[derive(Debug, Clone)]
struct Rect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

#[cfg(target_os = "windows")]
pub fn recognize_text(image_path: &str) -> Result<OcrResult, String> {
    // Windows API needs absolute path, usually canonicalized
    let path = Path::new(image_path);
    if !path.exists() {
        return Err(format!("File not found: {}", image_path));
    }
    let abs_path = path.canonicalize().map_err(|e| e.to_string())?;
    let abs_path_str = abs_path.to_string_lossy();
    // Remove \\?\ prefix if present (common in Rust canonicalize on Windows)
    let clean_path = abs_path_str.trim_start_matches(r"\\?\");

    // Execute async operations
    
    // 1. Load File
    // Windows 0.52+ uses windows::core::HSTRING implicitly from String/&str
    let file = StorageFile::GetFileFromPathAsync(&windows::core::HSTRING::from(clean_path))
        .map_err(|e| format!("Failed to get file: {}", e))?
        .get()
        .map_err(|e| format!("Failed to await file: {}", e))?;

    // 2. Open Stream
    let stream = file.OpenAsync(FileAccessMode::Read)
        .map_err(|e| format!("Failed to open stream: {}", e))?
        .get()
        .map_err(|e| format!("Failed to await stream: {}", e))?;

    // 3. Decode Bitmap
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| format!("Failed to create decoder: {}", e))?
        .get()
        .map_err(|e| format!("Failed to await decoder: {}", e))?;

    let bitmap = decoder.GetSoftwareBitmapAsync()
        .map_err(|e| format!("Failed to get bitmap: {}", e))?
        .get()
        .map_err(|e| format!("Failed to await bitmap: {}", e))?;

    // 4. Create OCR Engine
    // Try to use User's language
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|e| format!("Failed to create engine: {}", e))?;
    
    // Note: In older versions, returns Option or pointer, in 0.52 returns Result<OcrEngine>.
    // If we're here, engine is valid.

    // 5. Recognize
    let result = engine.RecognizeAsync(&bitmap)
        .map_err(|e| format!("Failed to recognize: {}", e))?
        .get()
        .map_err(|e| format!("Failed to await recognize: {}", e))?;

    // 6. Process Results
    let lines_list = result.Lines().map_err(|e| format!("Failed to get lines: {}", e))?;
    let mut ocr_lines = Vec::new();
    let mut full_text = String::new();

    for line in lines_list {
        let text_hstring = line.Text().map_err(|e| e.to_string())?;
        let text = text_hstring.to_string();
        
        full_text.push_str(&text);
        full_text.push('\n');

        // Windows OCR doesn't provide a direct line-level bounding box easily,
        // but it provides word-level boxes. We'll aggregate them or just use the whole line's implied bounds
        // Actually, for the UI, we want the polygon of the WHOLE line.
        // We can approximate it from the words.
        let words_list = match line.Words() {
            Ok(w) => w,
            Err(_) => continue,
        };

        let mut min_x = f64::MAX;
        let mut min_y = f64::MAX;
        let mut max_x = f64::MIN;
        let mut max_y = f64::MIN;

        for word in words_list {
            if let Ok(rect) = word.BoundingRect() {
                min_x = min_x.min(rect.X as f64);
                min_y = min_y.min(rect.Y as f64);
                max_x = max_x.max((rect.X + rect.Width) as f64);
                max_y = max_y.max((rect.Y + rect.Height) as f64);
            }
        }

        let box_coords = if min_x != f64::MAX {
            Some(vec![
                vec![min_x, min_y],
                vec![max_x, min_y],
                vec![max_x, max_y],
                vec![min_x, max_y],
            ])
        } else {
            None
        };

        ocr_lines.push(OcrLine {
            text,
            confidence: 1.0, // Windows OCR doesn't explicitly return per-line confidence easily
            box_coords,
        });
    }

    Ok(OcrResult {
        text: full_text,
        lines: ocr_lines,
    })
}

// ── Global cached OCR engine (avoids reloading ONNX models per call) ──

use std::sync::{OnceLock, Mutex as StdMutex};

static OCR_ENGINE: OnceLock<StdMutex<Option<LocalOcrEngine>>> = OnceLock::new();

const MAX_DET_WIDTH: u32 = 1280;

pub struct LocalOcrEngine {
    det_session: Session,
    rec_session: Session,
    keys: Vec<String>,
}

impl LocalOcrEngine {
    pub fn new(app_handle: &tauri::AppHandle) -> Result<Self, String> {
        let app_dir = app_handle.path_resolver().app_data_dir()
            .ok_or_else(|| "Could not resolve app data dir".to_string())?;
        let model_dir = app_dir.join("models").join("ocr");

        let det_path = model_dir.join("det.onnx");
        let rec_path = model_dir.join("rec.onnx");

        if !det_path.exists() || !rec_path.exists() {
            return Err("Local OCR models missing. Visit Settings to download.".to_string());
        }

        let det_session = Session::builder()
            .map_err(|e: ort::Error| e.to_string())?
            .commit_from_file(det_path)
            .map_err(|e: ort::Error| e.to_string())?;

        let rec_session = Session::builder()
            .map_err(|e: ort::Error| e.to_string())?
            .commit_from_file(rec_path)
            .map_err(|e: ort::Error| e.to_string())?;

        // Preload keys into struct
        let keys = Self::load_keys_from_path(&model_dir.join("keys.txt"));

        Ok(Self { det_session, rec_session, keys })
    }

    fn load_keys_from_path(keys_path: &std::path::Path) -> Vec<String> {
        if let Ok(content) = std::fs::read_to_string(keys_path) {
            let mut keys: Vec<String> = content.lines().map(|s| s.to_string()).collect();
            keys.insert(0, "".to_string()); // CTC blank
            keys.push(" ".to_string()); // space
            return keys;
        }
        vec!["".into(), "0".into(), "1".into(), "2".into(), "3".into(), "4".into(), "5".into(), "6".into(), "7".into(), "8".into(), "9".into()]
    }

    fn greedy_decode(logits: &ort::value::Value, keys: &[String]) -> Result<String, String> {
        let (shape, data) = logits.try_extract_tensor::<f32>().map_err(|e: ort::Error| e.to_string())?;
        let seq_len = shape[1] as usize;
        let num_classes = shape[2] as usize;

        let mut decoded = String::new();
        let mut last_idx = 0;

        for i in 0..seq_len {
            let mut max_val = f32::MIN;
            let mut max_idx = 0;
            for j in 0..num_classes {
                let val = data[i * num_classes + j];
                if val > max_val {
                    max_val = val;
                    max_idx = j;
                }
            }
            if max_idx != 0 && max_idx != last_idx {
                if let Some(key) = keys.get(max_idx) {
                    decoded.push_str(key);
                }
            }
            last_idx = max_idx;
        }
        Ok(decoded)
    }

    fn preprocess_det(img: &DynamicImage) -> Result<([usize; 4], Vec<f32>, f32, f32), String> {
        let (width, height) = img.dimensions();
        let target_w = (width as f32 / 32.0).ceil() as usize * 32;
        let target_h = (height as f32 / 32.0).ceil() as usize * 32;

        let resized = img.resize_exact(target_w as u32, target_h as u32, FilterType::Triangle);
        let mut data = vec![0.0f32; 3 * target_h * target_w];

        let r_offset = 0;
        let g_offset = target_h * target_w;
        let b_offset = 2 * target_h * target_w;

        for (x, y, pixel) in resized.pixels() {
            let idx = (y as usize) * target_w + (x as usize);
            data[r_offset + idx] = (pixel[0] as f32 / 255.0 - 0.485) / 0.229;
            data[g_offset + idx] = (pixel[1] as f32 / 255.0 - 0.456) / 0.224;
            data[b_offset + idx] = (pixel[2] as f32 / 255.0 - 0.406) / 0.225;
        }

        Ok(([1, 3, target_h, target_w], data, target_w as f32 / width as f32, target_h as f32 / height as f32))
    }

    fn postprocess_det(output: &ort::value::Value, scale_w: f32, scale_h: f32, _orig_w: u32, _orig_h: u32) -> Result<Vec<Rect>, String> {
        let (shape, data) = output.try_extract_tensor::<f32>().map_err(|e: ort::Error| e.to_string())?;
        let h = shape[2] as usize;
        let w = shape[3] as usize;

        let mut visited = vec![false; h * w];
        let mut rects = Vec::new();

        for y in 0..h {
            for x in 0..w {
                if !visited[y * w + x] && data[y * w + x] > 0.3 {
                    // Seed for connected component
                    let mut min_x = x;
                    let mut max_x = x;
                    let mut min_y = y;
                    let mut max_y = y;

                    let mut stack = vec![(x, y)];
                    visited[y * w + x] = true;

                    while let Some((cx, cy)) = stack.pop() {
                        min_x = min_x.min(cx);
                        max_x = max_x.max(cx);
                        min_y = min_y.min(cy);
                        max_y = max_y.max(cy);

                        // 4-connectivity
                        for (dx, dy) in [(0, 1), (0, -1), (1, 0), (-1, 0)] {
                            let nx = cx as i32 + dx;
                            let ny = cy as i32 + dy;
                            if nx >= 0 && nx < w as i32 && ny >= 0 && ny < h as i32 {
                                let nx = nx as usize;
                                let ny = ny as usize;
                                if !visited[ny * w + nx] && data[ny * w + nx] > 0.3 {
                                    visited[ny * w + nx] = true;
                                    stack.push((nx, ny));
                                }
                            }
                        }
                    }

                    // Filtering small noise
                    if (max_x - min_x) > 2 && (max_y - min_y) > 2 {
                        rects.push(Rect {
                            x: (min_x as f32 / scale_w).floor(),
                            y: (min_y as f32 / scale_h).floor(),
                            w: ((max_x - min_x + 1) as f32 / scale_w).ceil(),
                            h: ((max_y - min_y + 1) as f32 / scale_h).ceil(),
                        });
                    }
                }
            }
        }
        
        // Merge horizontally close rects.
        // partial_cmp can return None for NaN, which would panic via unwrap;
        // treat NaN as equal so sorting stays deterministic on degenerate input.
        rects.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal));
        // (Simplified merging omitted for brevity, but this provides the core boxes)

        Ok(rects)
    }

    fn preprocess_rec(img: &DynamicImage) -> Result<([usize; 4], Vec<f32>), String> {
        let target_h = 48;
        let target_w = 320; // Fixed width for simplicity or proportional
        let resized = img.resize_exact(target_w as u32, target_h as u32, FilterType::Triangle);
        let mut data = vec![0.0f32; 3 * target_h * target_w];

        let r_offset = 0;
        let g_offset = target_h * target_w;
        let b_offset = 2 * target_h * target_w;

        for (x, y, pixel) in resized.pixels() {
            let idx = (y as usize) * target_w + (x as usize);
            data[r_offset + idx] = (pixel[0] as f32 / 255.0 - 0.5) / 0.5;
            data[g_offset + idx] = (pixel[1] as f32 / 255.0 - 0.5) / 0.5;
            data[b_offset + idx] = (pixel[2] as f32 / 255.0 - 0.5) / 0.5;
        }
        Ok(([1, 3, target_h, target_w], data))
    }

    pub fn recognize(&mut self, image_path: &str) -> Result<OcrResult, String> {
        let mut img = image::open(image_path).map_err(|e| e.to_string())?;

        // Downscale large images for faster detection (cap width at MAX_DET_WIDTH)
        let (orig_w, orig_h) = img.dimensions();
        if orig_w > MAX_DET_WIDTH {
            let new_h = (orig_h as f64 * MAX_DET_WIDTH as f64 / orig_w as f64) as u32;
            img = img.resize(MAX_DET_WIDTH, new_h, FilterType::Triangle);
        }
        let (proc_w, proc_h) = img.dimensions();

        // 1. Detection
        let (det_shape, det_data, scale_w, scale_h) = Self::preprocess_det(&img)?;
        let det_input_value = Value::from_array((det_shape, det_data)).map_err(|e: ort::Error| e.to_string())?;

        let det_outputs = self.det_session.run(inputs!["x" => det_input_value])
            .map_err(|e: ort::Error| e.to_string())?;
        let det_map = det_outputs.get("maps").ok_or("No maps output from det model")?;
        let boxes = Self::postprocess_det(det_map, scale_w, scale_h, proc_w, proc_h)?;

        let mut ocr_lines = Vec::new();
        let mut full_text = String::new();

        // 2. Recognition for each box (using cached keys)
        for bbox in boxes {
            // Crop part of image
            let crop_x = (bbox.x as u32).min(proc_w - 1);
            let crop_y = (bbox.y as u32).min(proc_h - 1);
            let crop_w = (bbox.w as u32).min(proc_w - crop_x);
            let crop_h = (bbox.h as u32).min(proc_h - crop_y);
            
            if crop_w < 4 || crop_h < 4 { continue; }

            let crop = img.crop_imm(crop_x, crop_y, crop_w, crop_h);
            let (rec_shape, rec_data) = Self::preprocess_rec(&crop)?;
            let rec_input_value = Value::from_array((rec_shape, rec_data)).map_err(|e: ort::Error| e.to_string())?;
            
            let rec_outputs = self.rec_session.run(inputs!["x" => rec_input_value])
                .map_err(|e: ort::Error| e.to_string())?;
            
            let logits = rec_outputs.get("output").or_else(|| rec_outputs.get("logits")).ok_or("No output from rec model")?;
            let line_text = Self::greedy_decode(logits, &self.keys)?;
            
            if line_text.trim().is_empty() { continue; }

            ocr_lines.push(OcrLine {
                text: line_text.clone(),
                confidence: 0.9,
                box_coords: Some(vec![
                    vec![bbox.x as f64, bbox.y as f64],
                    vec![(bbox.x + bbox.w) as f64, bbox.y as f64],
                    vec![(bbox.x + bbox.w) as f64, (bbox.y + bbox.h) as f64],
                    vec![bbox.x as f64, (bbox.y + bbox.h) as f64],
                ]),
            });
            full_text.push_str(&line_text);
            full_text.push('\n');
        }

        if ocr_lines.is_empty() {
            // Fallback to Windows API if local fails to find anything or for demonstration
            return recognize_text(image_path);
        }

        Ok(OcrResult {
            text: full_text,
            lines: ocr_lines,
        })
    }
}

/// OCR a clipboard image using the cached local RapidOCR engine.
///
/// **Concurrency:** the entire engine is wrapped in a single `Mutex`, so
/// recognitions execute serially. ONNX `Session` is `!Sync` and reusing
/// it concurrently is undefined behaviour, so this serialization is
/// deliberate. Each call typically takes ~50-300ms after the model is
/// warm; back-to-back hovers will queue rather than parallelise.
pub fn recognize_text_local(app_handle: &tauri::AppHandle, image_path: &str) -> Result<OcrResult, String> {
    let cell = OCR_ENGINE.get_or_init(|| StdMutex::new(None));
    let mut guard = cell.lock().map_err(|e| format!("OCR engine lock poisoned: {}", e))?;

    // Lazy-init on first use, with fallback to the Windows.Media.Ocr engine
    // if RapidOCR fails (missing model files, ort runtime not loaded, etc.).
    if guard.is_none() {
        match LocalOcrEngine::new(app_handle) {
            Ok(engine) => {
                println!("[OCR] Local RapidOCR Engine initialized (cached)");
                *guard = Some(engine);
            }
            Err(e) => {
                println!("[OCR] Local Engine init failed: {}. Falling back to Windows API", e);
                return recognize_text(image_path);
            }
        }
    }

    // Safe: the if-block above guarantees guard is Some on this branch
    // (init success path) or already returned (init failure path).
    guard.as_mut().expect("OCR engine present after lazy init").recognize(image_path)
}

#[cfg(not(target_os = "windows"))]
pub fn recognize_text(_image_path: &str) -> Result<OcrResult, String> {
    Err("OCR is only supported on Windows".to_string())
}
