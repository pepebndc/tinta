import { useEffect, useState } from "react";
import { on } from "./api";
import { InkMark } from "./Brand";

/**
 * During Mission Control, a big logo covers the window, so that the user finds Tinta between the other windows.
 * When the logo stays after Mission Control, the button and the Escape key show the app again.
 */
export function Overview() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const sub = on<boolean>("overview", setShown);
    return () => void sub.then((u) => u());
  }, []);
  useEffect(() => {
    if (!shown) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setShown(false);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [shown]);
  if (!shown) return null;
  return (
    <div className="overview">
      <InkMark size="42vmin" />
      <p className="overview-text">Tinta is here!</p>
      <button className="overview-back" onClick={() => setShown(false)}>
        Back to Tinta
      </button>
    </div>
  );
}
