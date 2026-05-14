use serde::{Deserialize, Serialize};
use std::path::Path;
use ort::{inputs, value::Value, session::{Session, builder::GraphOptimizationLevel}};
use image::{DynamicImage, GenericImageView, imageops::FilterType};

#[cfg(target_os = "windows")]
use windows::{
    Graphics::Imaging::BitmapDecoder,
    Media::Ocr::OcrEngine,
    Storage::{FileAccessMode, StorageFile},
};

/// Temp file that auto-deletes when dropped. Used to feed an upsampled copy
/// of a small image to Windows OCR without leaving cruft behind.
#[cfg(target_os = "windows")]
struct TempPng(std::path::PathBuf);
#[cfg(target_os = "windows")]
impl Drop for TempPng {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CharBox {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Per-character confidence from the CTC peak softmax value [0..1].
    /// Frontend uses this for the red-tinted low-confidence heat-map.
    pub confidence: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OcrLine {
    pub text: String,
    pub confidence: f64,
    pub box_coords: Option<Vec<Vec<f64>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chars: Option<Vec<CharBox>>,
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

/// One CTC peak → one emitted character with the column index that produced it.
/// Used to later map back to pixel-space bounding boxes in the original image.
struct Emitted {
    text: String,
    col: usize,
    conf: f32,
}

#[cfg(target_os = "windows")]
pub fn recognize_text(image_path: &str) -> Result<OcrResult, String> {
    // Windows API needs absolute path, usually canonicalized
    let path = Path::new(image_path);
    if !path.exists() {
        return Err(format!("File not found: {}", image_path));
    }

    // Upsample small images before handing to Windows.Media.Ocr. Below ~800px
    // wide the engine starts missing small UI text and glyph interiors. 2×
    // Lanczos gives back lost resolution cheaply; anything larger passes through.
    let (src_path_str, _tmp_guard): (String, Option<TempPng>) = {
        let probe = image::open(image_path).map_err(|e| format!("image open failed: {}", e))?;
        let (w, h) = probe.dimensions();
        if w < 800 {
            let scaled = probe.resize_exact(w * 2, h * 2, FilterType::Lanczos3);
            let tmp = std::env::temp_dir().join(format!(
                "super-clip-ocr-{}-{}.png",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0),
            ));
            scaled.save(&tmp).map_err(|e| format!("temp save failed: {}", e))?;
            (tmp.to_string_lossy().to_string(), Some(TempPng(tmp)))
        } else {
            (image_path.to_string(), None)
        }
    };

    let abs_path = Path::new(&src_path_str).canonicalize().map_err(|e| e.to_string())?;
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
            chars: None,
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

// Cap for detection pre-resize. 1280 was too aggressive for modern 1440p/4K
// captures — small UI glyphs (~14-18 px tall) get blurred past the point the
// detector can find them. 1920 preserves small text while still keeping the
// det forward pass under ~60 ms on CPU.
const MAX_DET_WIDTH: u32 = 1920;

pub struct LocalOcrEngine {
    det_session: Session,
    rec_session: Session,
    keys: Vec<String>,
}

impl LocalOcrEngine {
    pub fn new(app_handle: &tauri::AppHandle) -> Result<Self, String> {
        // Resolve each model file: prefer bundled resources (shipped with the
        // installer via tauri.conf.json `resources`), fall back to the legacy
        // app_data_dir path for installs where users dropped models manually.
        let resolver = app_handle.path_resolver();
        let legacy_dir = resolver.app_data_dir().map(|d| d.join("models").join("ocr"));

        let resolve = |filename: &str| -> Option<std::path::PathBuf> {
            let rel = format!("resources/ocr/{}", filename);
            if let Some(p) = resolver.resolve_resource(&rel) {
                if p.exists() { return Some(p); }
            }
            if let Some(ref legacy) = legacy_dir {
                let p = legacy.join(filename);
                if p.exists() { return Some(p); }
            }
            None
        };

        let det_path = resolve("det.onnx").ok_or_else(|| "det.onnx not found in bundled resources or app_data_dir".to_string())?;
        let rec_path = resolve("rec.onnx").ok_or_else(|| "rec.onnx not found in bundled resources or app_data_dir".to_string())?;
        let keys_path = resolve("keys.txt");

        // ORT session config:
        //   - `Level3` graph optimization = constant folding + op fusion +
        //     layout propagation. 20–30% faster steady-state vs default
        //     (`Level1`). Paid once at load time.
        //   - `with_intra_threads` left on default ≈ physical core count,
        //     which is near-optimal for OCR's large-kernel conv workloads.
        //     Setting it too high (e.g. logical cores with HT) often *hurts*
        //     on CPU inference due to cache contention.
        let build_session = |path: std::path::PathBuf, name: &str| -> Result<Session, String> {
            // Note: `map_err` argument is left untyped because in ort 2.0
            // each builder stage returns its own `Error<Stage>` generic.
            Session::builder()
                .map_err(|e| e.to_string())?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|e| format!("opt-level for {}: {}", name, e))?
                .commit_from_file(path)
                .map_err(|e| e.to_string())
        };
        let det_session = build_session(det_path, "det")?;
        let rec_session = build_session(rec_path, "rec")?;

        let keys = match keys_path {
            Some(p) => Self::load_keys_from_path(&p),
            None => Self::load_keys_from_path(std::path::Path::new("")),
        };

        Ok(Self { det_session, rec_session, keys })
    }

    /// Prime both ORT sessions with a tiny dummy forward pass so the first
    /// real OCR call doesn't eat first-inference overhead (kernel dispatch
    /// init, memory arena bootstrap, thread-pool setup, ~2–4 s on server
    /// models). Best-effort: failures are logged and swallowed since the
    /// real pipeline is still able to run without warmup.
    pub fn warmup(&mut self) -> Result<(), String> {
        // Minimum valid det input: [1,3,H,W] with H,W multiples of 32.
        // Use 64×64 — smallest input that exercises all encoder stages.
        let det_dummy = vec![0.0f32; 3 * 64 * 64];
        let det_input = Value::from_array(([1usize, 3, 64, 64], det_dummy))
            .map_err(|e: ort::Error| e.to_string())?;
        let _ = self.det_session.run(inputs!["x" => det_input])
            .map_err(|e: ort::Error| format!("det warmup: {}", e))?;

        // Rec: [1,3,48,W] with W a multiple of 8. 320 matches the old v4
        // fixed geometry and the typical first real crop.
        let rec_dummy = vec![0.0f32; 3 * 48 * 320];
        let rec_input = Value::from_array(([1usize, 3, 48, 320], rec_dummy))
            .map_err(|e: ort::Error| e.to_string())?;
        let _ = self.rec_session.run(inputs!["x" => rec_input])
            .map_err(|e: ort::Error| format!("rec warmup: {}", e))?;

        Ok(())
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

    /// Greedy CTC decoder for a SINGLE batch item slice.
    /// `slice` is `[seq_len * num_classes]` floats (logits or softmax).
    /// Returns the joined text, per-character emissions, and mean peak confidence.
    fn greedy_decode_slice(
        slice: &[f32],
        seq_len: usize,
        num_classes: usize,
        keys: &[String],
    ) -> (String, Vec<Emitted>, f32) {
        let mut decoded = String::new();
        let mut chars: Vec<Emitted> = Vec::new();
        let mut last_idx = 0usize;
        let mut conf_sum = 0.0f32;
        let mut conf_n = 0usize;

        for i in 0..seq_len {
            let row = &slice[i * num_classes..(i + 1) * num_classes];
            let mut max_val = f32::MIN;
            let mut max_idx = 0usize;
            for (j, &v) in row.iter().enumerate() {
                if v > max_val {
                    max_val = v;
                    max_idx = j;
                }
            }
            if max_idx != 0 && max_idx != last_idx {
                if let Some(key) = keys.get(max_idx) {
                    if !key.is_empty() {
                        decoded.push_str(key);
                        chars.push(Emitted {
                            text: key.clone(),
                            col: i,
                            conf: max_val,
                        });
                        conf_sum += max_val;
                        conf_n += 1;
                    }
                }
            }
            last_idx = max_idx;
        }

        let avg_conf = if conf_n > 0 { conf_sum / conf_n as f32 } else { 0.0 };
        (decoded, chars, avg_conf)
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

    fn postprocess_det(output: &ort::value::Value, scale_w: f32, scale_h: f32, orig_w: u32, orig_h: u32) -> Result<Vec<Rect>, String> {
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
        
        // DBNet produces a SHRUNKEN probability map of each text region. Each
        // box has to be expanded (PaddleOCR's "unclip") to recover the real
        // text extent, otherwise rec sees clipped characters and drops quality.
        // For a rectangle the canonical offset distance is:
        //     d = area * ratio / perimeter
        // then we pad all four sides by d. 1.6 is PaddleOCR's default.
        const UNCLIP_RATIO: f32 = 1.6;
        let max_x = orig_w as f32;
        let max_y = orig_h as f32;
        for r in &mut rects {
            let perim = 2.0 * (r.w + r.h);
            if perim > 0.0 {
                let d = (r.w * r.h * UNCLIP_RATIO) / perim;
                r.x -= d;
                r.y -= d;
                r.w += 2.0 * d;
                r.h += 2.0 * d;
            }
            if r.x < 0.0 { r.w += r.x; r.x = 0.0; }
            if r.y < 0.0 { r.h += r.y; r.y = 0.0; }
            if r.x + r.w > max_x { r.w = max_x - r.x; }
            if r.y + r.h > max_y { r.h = max_y - r.y; }
        }

        // partial_cmp can return None for NaN, which would panic via unwrap;
        // treat NaN as equal so sorting stays deterministic on degenerate input.
        rects.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal));

        Ok(rects)
    }

    /// Dynamic-width rec preprocessing (PP-OCRv5 supports variable W).
    /// Keeps aspect ratio: scale to H=48, W proportional, rounded up to a
    /// multiple of 8 so rec's conv strides align cleanly. Max width is
    /// capped at `REC_W_MAX` as a safety net against pathological crops
    /// (full-width screen bars etc.) — those get split upstream.
    ///
    /// Why dynamic: PP-OCRv4 mobile had a fixed W=320 training geometry, so
    /// anything wider than ~6.7× the line height got squished to 320 and the
    /// rec head produced garbage past the first few chars. v5 server's rec
    /// input is `[N, 3, 48, W]` with dynamic W — we must use it, or the
    /// model's extra capacity buys nothing for long lines.
    fn preprocess_rec(img: &DynamicImage) -> Result<([usize; 4], Vec<f32>), String> {
        const TARGET_H: usize = 48;
        const STRIDE: u32 = 8;
        const REC_W_MAX: u32 = 1600; // safety cap; ~33× line height
        const REC_W_MIN: u32 = 16;

        let (src_w, src_h) = img.dimensions();
        let ratio = if src_h == 0 { 1.0 } else { TARGET_H as f32 / src_h as f32 };
        let raw_w = (src_w as f32 * ratio).ceil() as u32;
        let mut new_w = raw_w.max(REC_W_MIN).min(REC_W_MAX);
        // Round up to a multiple of STRIDE so conv output seq_len stays integer.
        new_w = ((new_w + STRIDE - 1) / STRIDE) * STRIDE;

        let resized = img.resize_exact(new_w, TARGET_H as u32, FilterType::Triangle);
        let w = new_w as usize;
        let mut data = vec![0.0f32; 3 * TARGET_H * w];

        let r_offset = 0;
        let g_offset = TARGET_H * w;
        let b_offset = 2 * TARGET_H * w;

        for (x, y, pixel) in resized.pixels() {
            let idx = (y as usize) * w + (x as usize);
            data[r_offset + idx] = (pixel[0] as f32 / 255.0 - 0.5) / 0.5;
            data[g_offset + idx] = (pixel[1] as f32 / 255.0 - 0.5) / 0.5;
            data[b_offset + idx] = (pixel[2] as f32 / 255.0 - 0.5) / 0.5;
        }
        Ok(([1, 3, TARGET_H, w], data))
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
        // PP-OCRv3: "maps"; PP-OCRv4 mobile: "sigmoid_0.tmp_0" etc.;
        // PP-OCRv5 server (RapidOCR build): "fetch_name_0". Fall back to the
        // first output if none match. Pre-extract the first key so the
        // fallback `.get()` doesn't borrow a temporary.
        let det_first_key: Option<String> = det_outputs.keys().next().map(|s| s.to_string());
        let det_map = det_outputs
            .get("fetch_name_0")
            .or_else(|| det_outputs.get("maps"))
            .or_else(|| det_outputs.get("sigmoid_0.tmp_0"))
            .or_else(|| det_outputs.get("save_infer_model/scale_0.tmp_1"))
            .or_else(|| det_outputs.get("tmp_0"))
            .or_else(|| det_first_key.as_deref().and_then(|k| det_outputs.get(k)))
            .ok_or("No detection output from det model")?;
        let boxes = Self::postprocess_det(det_map, scale_w, scale_h, proc_w, proc_h)?;

        if boxes.is_empty() {
            return recognize_text(image_path);
        }

        // 2. Per-line rec: each crop is preprocessed to its own native width
        //    (dynamic W supported by PP-OCRv5). We do NOT batch across crops —
        //    different widths can't be stacked without padding, and padding
        //    the narrow crops up to the max in the batch wastes more compute
        //    than it saves. Per-line calls on a warm session are 20-100ms
        //    each on CPU for typical screen lines.
        let mut ocr_lines = Vec::new();
        let mut full_text = String::new();

        for bbox in boxes {
            let crop_x = (bbox.x as u32).min(proc_w.saturating_sub(1));
            let crop_y = (bbox.y as u32).min(proc_h.saturating_sub(1));
            let crop_w = (bbox.w as u32).min(proc_w.saturating_sub(crop_x));
            let crop_h = (bbox.h as u32).min(proc_h.saturating_sub(crop_y));
            if crop_w < 4 || crop_h < 4 { continue; }

            let sub = img.crop_imm(crop_x, crop_y, crop_w, crop_h);
            let (rec_shape, rec_tensor) = Self::preprocess_rec(&sub)?;

            let rec_input_value = Value::from_array((rec_shape, rec_tensor))
                .map_err(|e: ort::Error| e.to_string())?;
            let rec_outputs = self.rec_session.run(inputs!["x" => rec_input_value])
                .map_err(|e: ort::Error| e.to_string())?;
            // PP-OCRv5 server (RapidOCR build) names it "fetch_name_0";
            // older v4 exports used "softmax_11.tmp_0" or "output"/"logits".
            let rec_first_key: Option<String> = rec_outputs.keys().next().map(|s| s.to_string());
            let logits = rec_outputs
                .get("fetch_name_0")
                .or_else(|| rec_outputs.get("output"))
                .or_else(|| rec_outputs.get("logits"))
                .or_else(|| rec_outputs.get("softmax_11.tmp_0"))
                .or_else(|| rec_outputs.get("save_infer_model/scale_0.tmp_1"))
                .or_else(|| rec_first_key.as_deref().and_then(|k| rec_outputs.get(k)))
                .ok_or("No output from rec model")?;

            let (shape, data) = logits.try_extract_tensor::<f32>()
                .map_err(|e: ort::Error| e.to_string())?;
            // shape = [1, seq_len, num_classes] — seq_len scales with W
            let seq_len = shape[1] as usize;
            let num_classes = shape[2] as usize;

            let (line_text, emissions, avg_conf) =
                Self::greedy_decode_slice(&data, seq_len, num_classes, &self.keys);
            if line_text.trim().is_empty() { continue; }

            let line_x = bbox.x as f64;
            let line_y = bbox.y as f64;
            let line_w = bbox.w as f64;
            let line_h = bbox.h as f64;
            // Seq-column-to-crop-pixel mapping. Because W now varies per crop
            // and seq_len = W / stride, this ratio stays proportional to the
            // original line's pixel width — independent of the exact W picked.
            let col_to_px = if seq_len > 0 { line_w / seq_len as f64 } else { 0.0 };

            let mut char_boxes: Vec<CharBox> = Vec::with_capacity(emissions.len());
            let ne = emissions.len();
            for (k, e) in emissions.iter().enumerate() {
                // Voronoi-ish: each char owns the interval from half-way-to-prev
                // to half-way-to-next. Endpoints snap to line edges.
                let left_bound = if k == 0 {
                    line_x
                } else {
                    line_x + (emissions[k - 1].col as f64 + e.col as f64) * 0.5 * col_to_px
                };
                let right_bound = if k + 1 >= ne {
                    line_x + line_w
                } else {
                    line_x + (e.col as f64 + emissions[k + 1].col as f64) * 0.5 * col_to_px
                };
                let w = (right_bound - left_bound).max(1.0);

                char_boxes.push(CharBox {
                    text: e.text.clone(),
                    x: left_bound,
                    y: line_y,
                    w,
                    h: line_h,
                    confidence: e.conf as f64,
                });
            }

            ocr_lines.push(OcrLine {
                text: line_text.clone(),
                confidence: avg_conf as f64,
                box_coords: Some(vec![
                    vec![line_x, line_y],
                    vec![line_x + line_w, line_y],
                    vec![line_x + line_w, line_y + line_h],
                    vec![line_x, line_y + line_h],
                ]),
                chars: Some(char_boxes),
            });
            full_text.push_str(&line_text);
            full_text.push('\n');
        }

        if ocr_lines.is_empty() {
            return recognize_text(image_path);
        }

        Ok(OcrResult {
            text: full_text,
            lines: ocr_lines,
        })
    }
}

/// Spawn a background thread to pre-load the ONNX models so the first OCR
/// invocation doesn't pay model-load cost (typically 200-800ms).
/// Safe to call even if models are missing — it'll just no-op.
pub fn warm_start(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        let cell = OCR_ENGINE.get_or_init(|| StdMutex::new(None));
        let mut guard = match cell.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if guard.is_some() { return; }
        match LocalOcrEngine::new(&app_handle) {
            Ok(mut engine) => {
                println!("[OCR] Warm-started RapidOCR engine at app boot");
                let t = std::time::Instant::now();
                match engine.warmup() {
                    Ok(_) => println!("[OCR] Warmup dummy passes done in {:.2}s — first OCR will be hot", t.elapsed().as_secs_f32()),
                    Err(e) => println!("[OCR] Warmup failed (non-fatal): {}", e),
                }
                *guard = Some(engine);
            }
            Err(e) => {
                println!("[OCR] Warm-start skipped: {}", e);
            }
        }
    });
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
