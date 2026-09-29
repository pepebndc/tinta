import { useEffect, useState } from "react";
import { on } from "./api";
import { InkMark } from "./Brand";

/** During Mission Control, a big logo covers the window, so that the user finds Tinta between the other windows. */
export function Overview() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const sub = on<boolean>("overview", setShown);
    return () => void sub.then((u) => u());
  }, []);
  if (!shown) return null;
  return (
    <div className="overview" aria-hidden="true">
      <InkMark size="42vmin" />
      <p className="overview-text">Tinta is here!</p>
    </div>
  );
}
