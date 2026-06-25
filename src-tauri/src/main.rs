// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod build_exp_keys;
fn main() {
    // webkit2gtk's DMABUF renderer crashes on many Wayland setups with
    // "Error 71 (Protocol error) dispatching to Wayland display". Disabling it
    // forces a compatible rendering path. Must be set before GTK initializes.
    #[cfg(target_os = "linux")]
    {
        // Render through XWayland. webkit's native-Wayland path both crashes on
        // this NVIDIA setup (GDK "Error 71") and, when worked around by disabling
        // the DMABUF renderer, falls back to CPU compositing (100% CPU, no GPU).
        // The X11 backend keeps full GPU-accelerated compositing and is stable.
        if std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
        }

        // Route the webview's GL onto the discrete NVIDIA GPU (PRIME offload)
        // instead of the iGPU / software rasterizer.
        if std::env::var_os("__NV_PRIME_RENDER_OFFLOAD").is_none() {
            std::env::set_var("__NV_PRIME_RENDER_OFFLOAD", "1");
        }
        if std::env::var_os("__GLX_VENDOR_LIBRARY_NAME").is_none() {
            std::env::set_var("__GLX_VENDOR_LIBRARY_NAME", "nvidia");
        }

        // Unlock the framerate: the GL buffer-swap blocks on vblank (vsync),
        // pinning the render loop to the compositor's 60fps regardless of the
        // JS ticker rate. Must be set before the GL context is created.
        if std::env::var_os("__GL_SYNC_TO_VBLANK").is_none() {
            std::env::set_var("__GL_SYNC_TO_VBLANK", "0"); // NVIDIA
        }
        if std::env::var_os("vblank_mode").is_none() {
            std::env::set_var("vblank_mode", "0"); // Mesa (Intel/AMD)
        }

        // Safety net: if anything forces native Wayland (GDK_BACKEND overridden),
        // disable the DMABUF renderer so we don't crash — at the cost of GPU accel.
        if std::env::var("GDK_BACKEND").as_deref() != Ok("x11")
            && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    build_exp_keys::build_keys().expect("failed to generate expression keybinds");
    live2d_lib::run()
}
