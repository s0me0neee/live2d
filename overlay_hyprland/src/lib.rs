// Debug tracing to stderr (visible in `pnpm dev`). Prefixed so it's greppable and
// clearly attributable to the native module.
macro_rules! log {
    ($($arg:tt)*) => {{
        eprintln!("[overlay_hyprland] {}", format!($($arg)*));
    }};
}

mod command;
mod window_rule;

use hyprland::data::{Clients, Monitors};
use hyprland::dispatch::{Dispatch, DispatchType, Position, WindowIdentifier};
use hyprland::shared::{Address, HyprData, HyprDataVec};
use napi::bindgen_prelude::*;
use napi_derive::napi;

fn hypr_err(e: hyprland::error::HyprError) -> Error {
    Error::from_reason(e.to_string())
}

// Hyprland's wire format carries window geometry as i16.
fn wire(v: i32) -> i16 {
    v.clamp(i16::MIN as i32, i16::MAX as i32) as i16
}

/// True when running inside a Hyprland session (the IPC env vars are set).
/// Every other export fails cleanly when this is false — call it first and
/// skip the Hyprland path on other compositors.
#[napi]
pub fn is_hyprland() -> bool {
    std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some()
}

/// One mapped window, as reported by Hyprland (`hyprctl clients`).
/// `address` is the stable handle to pass to the move/resize functions.
#[napi(object)]
pub struct ClientInfo {
    pub address: String,
    pub pid: i32,
    pub class: String,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// All mapped windows. Find ours by `pid` (the Electron main process owns the
/// Wayland connection, so its `process.pid` is what Hyprland reports),
/// disambiguating multiple windows of the same process by `title`/`class`.
#[napi]
pub fn get_clients() -> Result<Vec<ClientInfo>> {
    let clients = Clients::get().map_err(hypr_err)?;
    Ok(clients
        .to_vec()
        .into_iter()
        .map(|c| ClientInfo {
            address: c.address.to_string(),
            pid: c.pid,
            class: c.class,
            title: c.title,
            x: c.at.0 as i32,
            y: c.at.1 as i32,
            width: c.size.0 as i32,
            height: c.size.1 as i32,
        })
        .collect())
}

/// One monitor, as reported by Hyprland (`hyprctl monitors`). `x`/`y` are the
/// monitor's origin in the global layout; `width`/`height` are physical pixels
/// (divide by `scale` for logical size).
#[napi(object)]
pub struct MonitorInfo {
    pub id: i64,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub focused: bool,
}

/// All connected monitors, for clamping window geometry to the visible layout.
#[napi]
pub fn get_monitors() -> Result<Vec<MonitorInfo>> {
    let monitors = Monitors::get().map_err(hypr_err)?;
    Ok(monitors
        .to_vec()
        .into_iter()
        .map(|m| MonitorInfo {
            id: m.id as i64,
            name: m.name,
            x: m.x,
            y: m.y,
            width: m.width as u32,
            height: m.height as u32,
            scale: m.scale as f64,
            focused: m.focused,
        })
        .collect())
}

/// Moves the window by a delta in pixels (`movewindowpixel` dispatch).
/// Deltas avoid needing global cursor coordinates, which Wayland doesn't expose.
#[napi]
pub fn move_window_by(address: String, dx: i32, dy: i32) -> Result<()> {
    dispatch_window(address, dx, dy, false, false)
}

/// Moves the window to an exact global position (`movewindowpixel exact`).
#[napi]
pub fn move_window_to(address: String, x: i32, y: i32) -> Result<()> {
    dispatch_window(address, x, y, true, false)
}

/// Resizes the window by a delta in pixels (`resizewindowpixel` dispatch).
#[napi]
pub fn resize_window_by(address: String, dw: i32, dh: i32) -> Result<()> {
    dispatch_window(address, dw, dh, false, true)
}

/// Resizes the window to an exact size (`resizewindowpixel exact`).
#[napi]
pub fn resize_window_to(address: String, width: i32, height: i32) -> Result<()> {
    dispatch_window(address, width, height, true, true)
}

fn dispatch_window(address: String, a: i32, b: i32, exact: bool, resize: bool) -> Result<()> {
    let pos = if exact {
        Position::Exact(wire(a), wire(b))
    } else {
        Position::Delta(wire(a), wire(b))
    };
    let window = WindowIdentifier::Address(Address::new(address));
    let dispatch = if resize {
        DispatchType::ResizeWindowPixel(pos, window)
    } else {
        DispatchType::MoveWindowPixel(pos, window)
    };
    Dispatch::call(dispatch).map_err(hypr_err)
}

/// Runtime `hyprctl keyword <key> <value>` equivalent over the IPC socket, with
/// the compositor's reply checked (a rejected keyword throws — the hyprland
/// crate's own Keyword::set discards the reply). Covers binds too:
/// `setKeyword("bind", "CTRL ALT, R, global, web2d:recenter")`.
#[napi]
pub fn set_keyword(key: String, value: String) -> Result<()> {
    command::send_ok(&format!("keyword {key} {value}"))
}
