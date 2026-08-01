export const IS_LINUX = process.platform === "linux";

// Everything gated on Linux in this app besides the Hyprland IPC calls is really a
// Wayland problem (no global cursor, no self-positioning windows, no native global-
// shortcut grab) — X11 has none of them. WAYLAND_DISPLAY is set by the compositor for
// any Wayland client; XDG_SESSION_TYPE backs it up where the former is unset.
export const IS_WAYLAND =
	IS_LINUX && Boolean(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland");
