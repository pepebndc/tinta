import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";

/**
 * Changes the size of the current window and keeps it on its screen. With `keepRight`, the right edge stays in place,
 * so a window at the right of the screen grows to the left. Without it, the top left corner stays in place, and the
 * size gets smaller when the screen has no space for it.
 */
export async function resizeWindow(width: number, height: number, keepRight: boolean) {
  if (import.meta.env.MODE === "mock") return;
  const win = getCurrentWindow();
  const scale = await win.scaleFactor();
  const pos = (await win.outerPosition()).toLogical(scale);
  const size = (await win.outerSize()).toLogical(scale);
  let x = keepRight ? pos.x + size.width - width : pos.x;
  let y = pos.y;
  const monitor = await currentMonitor();
  if (monitor) {
    const area = monitor.workArea;
    const left = area.position.x / monitor.scaleFactor;
    const top = area.position.y / monitor.scaleFactor;
    const right = left + area.size.width / monitor.scaleFactor;
    const bottom = top + area.size.height / monitor.scaleFactor;
    if (keepRight) {
      width = Math.min(width, right - left);
      height = Math.min(height, bottom - top);
      x = Math.min(Math.max(x, left), right - width);
      y = Math.min(Math.max(y, top), bottom - height);
    } else {
      width = Math.min(width, right - x);
      height = Math.min(height, bottom - y);
    }
  }
  if (keepRight) await win.setPosition(new LogicalPosition(x, y));
  await win.setSize(new LogicalSize(width, height));
}
