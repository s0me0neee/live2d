//! Persists the model's on-screen position + zoom to `pos.toml` at the repo
//! root, so a drag/zoom survives across launches. Exposed to the frontend as
//! the `load_pos` / `save_pos` Tauri commands.

use serde::{Deserialize, Serialize};

// Absolute path, matching the style used in build_exp_keys.rs (dev-centric).
const POS_PATH: &str = "/Users/maot27/JetBrain/rust/live2d/pos.toml";

#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct Pos {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
}

/// Returns the saved position, or `None` if the file is missing/unparseable
/// (first launch) so the frontend falls back to its default layout.
#[tauri::command]
pub fn load_pos() -> Option<Pos> {
    let text = std::fs::read_to_string(POS_PATH).ok()?;
    toml::from_str(&text).ok()
}

#[tauri::command]
pub fn save_pos(pos: Pos) -> Result<(), String> {
    let text = toml::to_string(&pos).map_err(|e| e.to_string())?;
    std::fs::write(POS_PATH, text).map_err(|e| e.to_string())
}
