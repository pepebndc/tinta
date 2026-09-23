import { useEffect, useState } from "react";

type State = "idle" | "loading" | "playing" | "paused";

// One clip plays at a time. A new clip stops the current one.
let current: { key: string; audio: HTMLAudioElement | null; state: State } | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function stateOf(key: string): State {
  return current?.key === key ? current.state : "idle";
}

async function toggle(key: string, load: () => Promise<string>) {
  if (current?.key === key) {
    const audio = current.audio;
    if (!audio) return;
    if (audio.paused) {
      await audio.play();
      current.state = "playing";
    } else {
      audio.pause();
      current.state = "paused";
    }
    notify();
    return;
  }
  current?.audio?.pause();
  const entry: { key: string; audio: HTMLAudioElement | null; state: State } = { key, audio: null, state: "loading" };
  current = entry;
  notify();
  try {
    const base64 = await load();
    if (current !== entry) return;
    const audio = new Audio(`data:audio/wav;base64,${base64}`);
    audio.onended = () => {
      if (current === entry) current = null;
      notify();
    };
    entry.audio = audio;
    await audio.play();
    entry.state = "playing";
  } catch (e) {
    if (current === entry) current = null;
    throw e;
  } finally {
    notify();
  }
}

/** Stops the current clip, for example when its meeting closes. */
export function stopPlayback() {
  current?.audio?.pause();
  current = null;
  notify();
}

/** Plays a clip, and pauses or resumes it on the next click. */
export function PlayButton({ id, label, load, onError }: { id: string; label: string; load: () => Promise<string>; onError: (e: string) => void }) {
  const [state, setState] = useState<State>(() => stateOf(id));
  useEffect(() => {
    const update = () => setState(stateOf(id));
    listeners.add(update);
    update();
    return () => void listeners.delete(update);
  }, [id]);

  return (
    <button
      className={`link play-button ${state}`}
      disabled={state === "loading"}
      aria-pressed={state === "playing"}
      onClick={() => toggle(id, load).catch((e) => onError(String(e)))}
    >
      {state === "playing" ? "Pause" : state === "paused" ? "Resume" : state === "loading" ? "Loading…" : label}
    </button>
  );
}
