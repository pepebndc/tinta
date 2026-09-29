//! Mission Control shows all the windows on the screen. During Mission Control, the window shows the Tinta logo,
//! so that the user finds Tinta between the windows of the other apps.
//!
//! macOS sends no event for Mission Control. During Mission Control, the Dock has a window at the Dock level
//! that covers a full display. The app looks for this window a few times each second.

use crate::state;
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::AnyObject;
use objc2_foundation::{ns_string, NSArray, NSDictionary, NSNumber, NSRect, NSString};
use serde_json::json;
use std::time::Duration;

/// The time between two checks.
const TICK: Duration = Duration::from_millis(250);
/// `kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements`.
const ON_SCREEN: u32 = 1 | 16;
/// `kCGDockWindowLevel`.
const DOCK_LEVEL: i64 = 20;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *mut NSArray<NSDictionary<NSString, AnyObject>>;
    fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
    fn CGDisplayBounds(display: u32) -> NSRect;
}

fn number(dict: &NSDictionary<NSString, AnyObject>, key: &NSString) -> Option<f64> {
    Some(dict.objectForKey(key)?.downcast::<NSNumber>().ok()?.as_f64())
}

fn displays() -> Vec<NSRect> {
    let mut ids = [0u32; 16];
    let mut count = 0u32;
    if unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) } != 0 {
        return Vec::new();
    }
    ids[..count as usize].iter().map(|&id| unsafe { CGDisplayBounds(id) }).collect()
}

/// True when the Dock covers a full display, as during Mission Control.
fn active() -> bool {
    autoreleasepool(|_| {
        let Some(windows) = (unsafe { Retained::from_raw(CGWindowListCopyWindowInfo(ON_SCREEN, 0)) }) else {
            return false;
        };
        let displays = displays();
        windows.iter().any(|window| {
            let owner = window.objectForKey(ns_string!("kCGWindowOwnerName")).and_then(|o| o.downcast::<NSString>().ok());
            if owner.is_none_or(|o| o.to_string() != "Dock") {
                return false;
            }
            if number(&window, ns_string!("kCGWindowLayer")) != Some(DOCK_LEVEL as f64) {
                return false;
            }
            let Some(bounds) = window
                .objectForKey(ns_string!("kCGWindowBounds"))
                .and_then(|b| b.downcast::<NSDictionary>().ok())
            else {
                return false;
            };
            let bounds: &NSDictionary<NSString, AnyObject> = unsafe { bounds.cast_unchecked() };
            let (Some(width), Some(height)) = (number(bounds, ns_string!("Width")), number(bounds, ns_string!("Height"))) else {
                return false;
            };
            displays.iter().any(|d| width >= d.size.width && height >= d.size.height)
        })
    })
}

/// Sends the `overview` event to the window when Mission Control starts or stops.
pub fn watch() {
    std::thread::spawn(|| {
        let mut shown = false;
        loop {
            std::thread::sleep(TICK);
            let now = active();
            if now != shown {
                shown = now;
                state().emit("overview", json!(shown));
            }
        }
    });
}
