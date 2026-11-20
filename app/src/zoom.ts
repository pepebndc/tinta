import { getCurrentWebview } from "@tauri-apps/api/webview";

// Command-plus and Command-minus change the size of the text and the interface. Command-0 sets the default size.
// The size of the main window stays after a restart.
const KEY = "tinta-zoom";
export const ZOOM_LEVELS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

let level = (() => {
  const saved = Number(localStorage.getItem(KEY));
  return ZOOM_LEVELS.includes(saved) ? saved : 1;
})();

/** The next level in the direction of `step`, or the default size for 0. The level stays at the smallest and the largest size. */
export function nextZoom(current: number, step: -1 | 0 | 1): number {
  if (step === 0) return 1;
  const index = ZOOM_LEVELS.indexOf(current);
  const next = (index < 0 ? ZOOM_LEVELS.indexOf(1) : index) + step;
  return ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, next))];
}

function apply() {
  if (import.meta.env.MODE === "mock") {
    document.documentElement.style.zoom = String(level);
    return;
  }
  getCurrentWebview()
    .setZoom(level)
    .catch(() => undefined);
}

/** Changes the size one step larger (1) or smaller (-1), or sets the default size (0). */
export function zoom(step: -1 | 0 | 1) {
  level = nextZoom(level, step);
  localStorage.setItem(KEY, String(level));
  apply();
}

/** Applies the saved size. */
export function restoreZoom() {
  if (level !== 1) apply();
}
