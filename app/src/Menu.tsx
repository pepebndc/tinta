import { ReactNode, RefObject, useEffect, useRef, useState } from "react";
import { Icon } from "./Brand";

/** Closes a popover when the user clicks outside it or presses Escape. `close` gets true for Escape. */
export function useDismiss(ref: RefObject<HTMLElement>, open: boolean, close: (byKey: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close(true);
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
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Escape and a selection give the focus back to the button. A click outside keeps the focus where the user clicks.
  const close = (focus: boolean) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  useDismiss(box, open, close);

  function moveFocus(e: React.KeyboardEvent) {
    if (e.key === "Tab") return setOpen(false);
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }

  return (
    <div className="menu-box" ref={box}>
      <button ref={trigger} className="quiet icon-only" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="more" size={16} />
      </button>
      {open && (
        <div className="menu popover" role="menu" ref={list} onKeyDown={moveFocus}>
          {items.map((item, i) => (
            <button
              key={item.label}
              role="menuitem"
              className={`quiet ${item.danger ? "danger" : ""}`}
              disabled={item.disabled}
              title={item.title}
              autoFocus={i === 0}
              onClick={() => {
                close(true);
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
  const first = useRef<HTMLButtonElement>(null);
  // After Cancel or Escape, the focus goes back to the first button.
  const refocus = useRef(false);
  useEffect(() => {
    if (!armed && refocus.current) first.current?.focus();
    refocus.current = false;
  }, [armed]);
  const disarm = () => {
    refocus.current = true;
    setArmed(false);
  };
  if (!armed) {
    return (
      <button ref={first} className="quiet danger" onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm-row" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), disarm())}>
      <span className="small warn">{question} You cannot undo this.</span>
      <button className="quiet" autoFocus onClick={disarm}>
        Cancel
      </button>
      <button
        className="danger"
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
