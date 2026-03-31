use serde::Serialize;

#[derive(Serialize)]
pub struct FileResult {
    pub name: String,
    pub path: String,
    pub is_folder: bool,
    pub size: Option<u64>,
}

pub fn search(query: &str, max_results: u32) -> Result<Vec<FileResult>, String> {
    let mut global = everything_sdk::ergo::global().lock().map_err(|e| e.to_string())?;
    let mut searcher = global.searcher();
    
    // Set search string
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


