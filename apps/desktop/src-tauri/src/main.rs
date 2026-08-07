// The binary entrypoint; all real logic lives in `lib.rs` (`run()`), the
// usual Tauri v2 split so `plotroom_desktop_lib` stays testable as a library
// crate independent of the `windows_subsystem` attribute below.
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    plotroom_desktop_lib::run();
}
