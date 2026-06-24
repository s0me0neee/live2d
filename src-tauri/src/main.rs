// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod build_exp_keys;
fn main() {
    build_exp_keys::build_keys().expect("failed to generate expression keybinds");
    live2d_lib::run()
}
