type IconName = "home" | "document" | "search" | "export" | "lock" | "trash" | "settings" | "activity" | "import" | "plus";

const PATHS: Record<IconName, string[]> = {
  home: ["M4 11l8-7 8 7", "M6 9.5V20h12V9.5", "M10 20v-5h4v5"],
  document: ["M6 3h8l4 4v14H6z", "M14 3v5h4", "M9 12h6", "M9 16h6"],
  search: ["M10 4a6 6 0 1 1 0 12a6 6 0 1 1 0-12z", "m15 15 5 5"],
  export: ["M12 15V3", "m8 7 4-4 4 4", "M5 13v7h14v-7"],
  lock: ["M8 10V7a4 4 0 0 1 8 0v3", "M6 10h12v11H6z"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
  settings: ["M12 9a3 3 0 1 1 0 6a3 3 0 1 1 0-6z", "M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"],
  activity: ["M3 12h4l3-8 4 16 3-8h4"],
  import: ["M12 3v12", "m8 11 4 4 4-4", "M5 13v7h14v-7"],
  plus: ["M12 5v14", "M5 12h14"],
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

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

const AVATAR_TONES = ["tone-a", "tone-b", "tone-c", "tone-d", "tone-e"];

export function Avatar({ name, muted }: { name: string; muted?: boolean }) {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span className={`avatar ${muted ? "muted-avatar" : AVATAR_TONES[hash % AVATAR_TONES.length]}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
