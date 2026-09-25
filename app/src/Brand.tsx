import { useEffect, useState } from "react";

type IconName = "home" | "document" | "search" | "export" | "lock" | "trash" | "settings" | "activity" | "import" | "plus" | "mic" | "users" | "close" | "copy" | "check" | "more" | "folder" | "chevron";

const PATHS: Record<IconName, string[]> = {
  home: ["M4 11l8-7 8 7", "M6 9.5V20h12V9.5", "M10 20v-5h4v5"],
  document: ["M6 3h8l4 4v14H6z", "M14 3v5h4", "M9 12h6", "M9 16h6"],
  search: ["M10 4a6 6 0 1 1 0 12a6 6 0 1 1 0-12z", "m15 15 5 5"],
  export: ["M12 15V3", "m8 7 4-4 4 4", "M5 13v7h14v-7"],
  lock: ["M8 10V7a4 4 0 0 1 8 0v3", "M6 10h12v11H6z"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
  settings: ["M10.32 5.00L10.74 2.58L13.26 2.58L13.68 5.00L15.76 5.86L17.76 4.45L19.55 6.24L18.14 8.24L19.00 10.32L21.42 10.74L21.42 13.26L19.00 13.68L18.14 15.76L19.55 17.76L17.76 19.55L15.76 18.14L13.68 19.00L13.26 21.42L10.74 21.42L10.32 19.00L8.24 18.14L6.24 19.55L4.45 17.76L5.86 15.76L5.00 13.68L2.58 13.26L2.58 10.74L5.00 10.32L5.86 8.24L4.45 6.24L6.24 4.45L8.24 5.86z", "M12 9a3 3 0 1 1 0 6a3 3 0 1 1 0-6z"],
  activity: ["M3 12h4l3-8 4 16 3-8h4"],
  import: ["M12 3v12", "m8 11 4 4 4-4", "M5 13v7h14v-7"],
  plus: ["M12 5v14", "M5 12h14"],
  mic: ["M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z", "M6 11a6 6 0 0 0 12 0", "M12 17v4"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  check: ["m5 12 5 5 9-10"],
  more: ["M5 11.2a.8.8 0 1 1 0 1.6a.8.8 0 1 1 0-1.6z", "M12 11.2a.8.8 0 1 1 0 1.6a.8.8 0 1 1 0-1.6z", "M19 11.2a.8.8 0 1 1 0 1.6a.8.8 0 1 1 0-1.6z"],
  folder: ["M3 6h6l2 2h10v11H3z"],
  chevron: ["m6 9 6 6 6-6"],
  users: ["M9 11a3 3 0 1 0 0-6a3 3 0 0 0 0 6z", "M3 20a6 6 0 0 1 12 0", "M16 5a3 3 0 0 1 0 6", "M18 14a5 5 0 0 1 3 6"],
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="line-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** The cross at the right side of a banner. */
export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="bar-icon" onClick={onClick} aria-label="Close" title="Close">
      <Icon name="close" size={14} />
    </button>
  );
}

/** Copies a text, and shows a check mark for a short time after the copy. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      className="bar-icon"
      onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true), () => undefined)}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
    </button>
  );
}

export function InkMark({ size = 32 }: { size?: number }) {
  return (
    <span className="ink-icon" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 100 100">
        <path d="M24 19C38 8 59 10 69 22C80 36 64 46 55 57C48 65 47 82 32 82C15 82 8 66 9 49C9 36 14 27 24 19Z" />
        <path d="M79 58C81 68 91 71 87 80C83 91 69 90 67 81C65 72 75 67 79 58Z" />
      </svg>
    </span>
  );
}

export function Wordmark({ size = 40 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      tinta
    </span>
  );
}

export function Lockup() {
  return (
    <div className="lockup">
      <InkMark size={30} />
      <Wordmark size={40} />
    </div>
  );
}

const NAME_TONES = 6;

function hashTone(name: string): number {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return hash % NAME_TONES;
}

/** The color class of a name. The same name has the same color everywhere, unless a meeting gives it another one. */
export function nameTone(name: string, tones?: Map<string, number>): string {
  return `name-tone-${tones?.get(name) ?? hashTone(name)}`;
}

/**
 * Gives the people of one meeting different colors, up to 6 people.
 * Each name keeps its usual color when no other name in the meeting has it.
 */
export function meetingTones(names: string[]): Map<string, number> {
  const tones = new Map<string, number>();
  const used = new Set<number>();
  for (const name of names) {
    if (tones.has(name)) continue;
    let tone = hashTone(name);
    for (let i = 0; used.has(tone) && i < NAME_TONES; i++) tone = (tone + 1) % NAME_TONES;
    tones.set(name, tone);
    used.add(tone);
    if (used.size === NAME_TONES) used.clear();
  }
  return tones;
}

/** A person's name in the color of that person. */
export function Name({ name, tones }: { name: string; tones?: Map<string, number> }) {
  return <span className={`person ${nameTone(name, tones)}`}>{name}</span>;
}
