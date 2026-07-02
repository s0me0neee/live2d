// Raw command socket client, needed because the hyprland crate's Keyword::set
// discards the compositor's reply — we want rejected keywords to surface as errors.
// Same path derivation as the crate: $XDG_RUNTIME_DIR/hypr/$SIG/.socket.sock.

use napi::bindgen_prelude::*;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;

fn socket_path() -> Result<String> {
    let sig = std::env::var("HYPRLAND_INSTANCE_SIGNATURE").map_err(|_| {
        Error::from_reason("not a Hyprland session (HYPRLAND_INSTANCE_SIGNATURE unset)")
    })?;
    let runtime = std::env::var("XDG_RUNTIME_DIR")
        .map_err(|_| Error::from_reason("XDG_RUNTIME_DIR unset"))?;
    Ok(format!("{runtime}/hypr/{sig}/.socket.sock"))
}

pub(crate) fn send(command: &str) -> Result<String> {
    let path = socket_path()?;
    let io_err = |e: std::io::Error| Error::from_reason(format!("hyprland socket: {e}"));
    let mut stream = UnixStream::connect(&path).map_err(io_err)?;
    stream.write_all(command.as_bytes()).map_err(io_err)?;
    let mut reply = String::new();
    stream.read_to_string(&mut reply).map_err(io_err)?;
    Ok(reply)
}

pub(crate) fn send_ok(command: &str) -> Result<()> {
    let reply = send(command)?;
    if reply.trim() == "ok" {
        Ok(())
    } else {
        Err(Error::from_reason(format!(
            "hyprland rejected \"{command}\": {}",
            reply.trim()
        )))
    }
}
