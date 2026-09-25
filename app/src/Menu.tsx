import { ReactNode, RefObject, useEffect, useRef, useState } from "react";
import { Icon } from "./Brand";

/** Closes a popover when the user clicks outside it or presses Escape. */
export function useDismiss(ref: RefObject<HTMLElement>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
}

type MenuItem = { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; title?: string };

/** A "…" button that opens a list of actions. */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, open, () => setOpen(false));
  return (
    <div className="menu-box" ref={box}>
      <button className="quiet icon-only" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="more" size={16} />
      </button>
      {open && (
        <div className="menu popover" role="menu">
          {items.map((item, i) => (
            <button
              key={item.label}
              role="menuitem"
              className={`quiet ${item.danger ? "danger" : ""}`}
              disabled={item.disabled}
              title={item.title}
              autoFocus={i === 0}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A button for an action that the user cannot undo. The first click asks the question in the row. */
export function ConfirmButton({ label, question, confirm, onConfirm }: { label: ReactNode; question: string; confirm: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button className="quiet danger" onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm-row">
      <span className="small warn">{question} You cannot undo this.</span>
      <button className="quiet" onClick={() => setArmed(false)}>
        Cancel
      </button>
      <button
        className="danger"
        autoFocus
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirm}
      </button>
    </span>
  );
}
