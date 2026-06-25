mod build_exp_keys;
mod command;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![command::load_pos, command::save_pos])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
