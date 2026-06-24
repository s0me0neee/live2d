use std::fs;

use anyhow::Ok;

macro_rules! model_path {
    () => {
        "/Users/maot27/JetBrain/rust/live2d/model/ariu/"
    };
}
fn build_keys() -> anyhow::Result<()> {
    let model_path = model_path!();
    let ctx_str = "";
    let files = fs::read_dir(model_path)?;
    for f in files {
        let file_name = f?.file_name();
        // if file_name[file_name.len() - 9..] == "exp3.json" {
        // }
    }
    Ok(())
}

#[test]
fn test() {
    build_keys();
}
