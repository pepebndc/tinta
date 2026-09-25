import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemeChoice = "system" | "light" | "dark";

// The library stores the choice. This copy applies it before the first paint.
const CACHE_KEY = "tinta-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
let choice: ThemeChoice = (localStorage.getItem(CACHE_KEY) as ThemeChoice) || "system";

function apply() {
  const dark = choice === "dark" || (choice === "system" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  if (import.meta.env.MODE !== "mock") {
    getCurrentWindow()
      .setTheme(choice === "system" ? null : choice)
      .catch(() => undefined);
  }
}

export function setTheme(next: ThemeChoice) {
  choice = next;
  localStorage.setItem(CACHE_KEY, next);
  apply();
}

media.addEventListener("change", apply);
apply();
