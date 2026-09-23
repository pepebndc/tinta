import { useEffect, useState } from "react";
import { api, Bootstrap, ExtensionState, installModels, installRunning, on } from "./api";
import { Icon, InkMark, Wordmark } from "./Brand";
import { setTheme, ThemeChoice } from "./theme";

const COMPONENTS: Record<string, string> = {
  transcription: "Downloading the transcription model (1 of 3)",
  vad: "Downloading the voice detection model (2 of 3)",
  diarization: "Downloading the speaker model (3 of 3)",
};

/** Installs the speech models and reports the current component. */
export function useModelInstall(onChanged: () => void, onError: (e: string) => void) {
  const [progress, setProgress] = useState<string | null>(installRunning() ? "Downloading" : null);

  useEffect(() => {
    const sub = on<{ event: string; component?: string; state?: string }>("engine", (e) => {
      if (e.event !== "install_progress") return;
      setProgress(e.state === "done" ? null : (COMPONENTS[e.component ?? ""] ?? "Downloading"));
    });
    return () => void sub.then((u) => u());
  }, []);

  async function install() {
    setProgress("Starting the download");
    try {
      await installModels();
      onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setProgress(null);
    }
  }

  return { progress, install };
}

/** The steps to load the unpacked Meet extension in Chrome. */
export function ExtensionSteps({ onError }: { onError: (e: string) => void }) {
  const [folder, setFolder] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function copyAddress() {
    navigator.clipboard
      .writeText("chrome://extensions")
      .then(() => setCopied(true))
      .catch((e) => onError(String(e)));
  }

  return (
    <ol className="ext-steps">
      <li>
        <span>Put the extension folder on this Mac.</span>
        <button
          onClick={() =>
            api
              .prepareExtension()
              .then(setFolder)
              .catch((e) => onError(String(e)))
          }
        >
          {folder ? "Show the folder again" : "Show extension folder"}
        </button>
        {folder && <span className="small muted">Finder shows the folder "Chrome extension".</span>}
      </li>
      <li>
        <span>
          In Chrome, open <code>chrome://extensions</code> and turn on Developer mode.
        </span>
        <button onClick={copyAddress}>{copied ? "Address copied" : "Copy the address"}</button>
      </li>
      <li>
        <span>Drag the "Chrome extension" folder from Finder onto the Chrome extensions page.</span>
      </li>
      <li>
        <span>Restart Chrome. The Tinta icon in the Chrome toolbar shows "Connected to Tinta".</span>
      </li>
    </ol>
  );
}

type Step = "intro" | "welcome" | "models" | "microphone" | "meet" | "done";
const STEPS: Step[] = ["welcome", "models", "microphone", "meet", "done"];

type Props = {
  boot: Bootstrap;
  extension: ExtensionState | null;
  granolaExport: string | null;
  error: string | null;
  onChanged: () => void;
  onError: (e: string) => void;
  onFinish: (next: "home" | "granola") => void;
};

export function Onboarding({ boot, extension, granolaExport, error, onChanged, onError, onFinish }: Props) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [step, setStep] = useState<Step>(() => {
    const preview = import.meta.env.MODE === "mock" ? window.location.hash.slice("#onboarding-".length) : "";
    if (STEPS.includes(preview as Step)) return preview as Step;
    return reduceMotion ? "welcome" : "intro";
  });
  const [name, setName] = useState(boot.self_name);
  const [theme, setThemeChoice] = useState<ThemeChoice>(boot.theme);
  const { progress, install } = useModelInstall(onChanged, onError);

  useEffect(() => {
    if (step !== "intro") return;
    const skip = () => setStep("welcome");
    const t = setTimeout(skip, 2200);
    window.addEventListener("keydown", skip);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", skip);
    };
  }, [step]);

  const set = (key: string, value: string) => api.setSetting(key, value).catch((e) => onError(String(e)));

  function saveName() {
    if (name.trim() && name !== boot.self_name) void set("self_name", name.trim()).then(onChanged);
  }

  function next() {
    if (step === "welcome") saveName();
    setStep(STEPS[STEPS.indexOf(step) + 1] ?? "done");
  }

  async function finish(then: "home" | "granola") {
    saveName();
    await set("onboarded", "true");
    onFinish(then);
  }

  if (step === "intro") {
    return (
      <div className="onboarding intro" onClick={() => setStep("welcome")} role="button" aria-label="Skip the intro">
        <div className="intro-mark">
          <span className="intro-drop" />
          <InkMark size={96} />
        </div>
        <div className="intro-word">
          <Wordmark size={88} />
        </div>
        <p className="intro-line">A little ink. A clear record.</p>
        <span className="intro-skip small muted">Click to skip</span>
      </div>
    );
  }

  const connected = !!extension?.connected_at;
  const index = STEPS.indexOf(step);

  return (
    <div className="onboarding">
      <header className="onboarding-top">
        <div className="onboarding-dots" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <button
              key={s}
              className={`dot-step ${i === index ? "current" : i < index ? "past" : ""}`}
              onClick={() => setStep(s)}
              aria-label={`Go to step ${i + 1}`}
            />
          ))}
        </div>
        {step !== "done" && (
          <button className="quiet" onClick={() => void finish("home")}>
            Skip setup
          </button>
        )}
      </header>

      {error && (
        <div className="onboarding-error" onClick={() => onError("")} role="alert">
          {error} <span className="muted">Click to close.</span>
        </div>
      )}

      <div className="onboarding-stage">
        <section className="onboarding-card" key={step}>
          {step === "welcome" && (
            <>
              <InkMark size={48} />
              <h1>Welcome to Tinta</h1>
              <p className="muted">
                Write your notes, get a transcript with speaker names, and keep everything on this Mac. Setup takes about two minutes. You
                can skip any step.
              </p>
              <label className="field">
                <span>Your name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                <span className="small muted">Tinta uses this name for your microphone in the transcript.</span>
              </label>
              <div className="field">
                <span>Appearance</span>
                <div className="segmented" role="radiogroup" aria-label="Theme">
                  {(["system", "light", "dark"] as ThemeChoice[]).map((t) => (
                    <button
                      key={t}
                      role="radio"
                      aria-checked={theme === t}
                      className={theme === t ? "active" : ""}
                      onClick={() => {
                        setThemeChoice(t);
                        setTheme(t);
                        void set("theme", t);
                      }}
                    >
                      {t === "system" ? "System" : t === "light" ? "Light" : "Dark"}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {step === "models" && (
            <>
              <div className="step-icon">
                <Icon name="import" size={22} />
              </div>
              <h1>Install the speech models</h1>
              <p className="muted">
                Tinta transcribes on this Mac. It downloads about 500 MB from Hugging Face, once, and checks each file against its SHA-256
                hash. This is the only download.
              </p>
              {boot.models_installed ? (
                <p className="step-done">
                  <span className="check">✓</span> The models are installed.
                </p>
              ) : progress ? (
                <div className="step-progress">
                  <span className="small">{progress}</span>
                  <div className="meter-bar wide indeterminate">
                    <div />
                  </div>
                  <span className="small muted">You can continue. The download goes on in the background.</span>
                </div>
              ) : (
                <button className="primary big" onClick={() => void install()}>
                  Install models
                </button>
              )}
            </>
          )}

          {step === "microphone" && (
            <>
              <div className="step-icon">
                <Icon name="mic" size={22} />
              </div>
              <h1>Allow the microphone</h1>
              <p className="muted">
                Tinta records your microphone and the audio of the meeting app. macOS asks for the meeting audio at the first recording.
              </p>
              {boot.microphone === "granted" ? (
                <p className="step-done">
                  <span className="check">✓</span> Tinta can use the microphone.
                </p>
              ) : boot.microphone === "denied" ? (
                <p className="warn">
                  macOS blocks the microphone. Open System Settings, Privacy and Security, Microphone, and turn on Tinta.
                </p>
              ) : (
                <button
                  className="primary big"
                  onClick={() =>
                    api
                      .requestMicrophone()
                      .then(onChanged)
                      .catch((e) => onError(String(e)))
                  }
                >
                  Allow microphone
                </button>
              )}
              <p className="small muted">Headphones give the best transcript. With speakers, Tinta removes the echo of the call.</p>
            </>
          )}

          {step === "meet" && (
            <>
              <div className="step-icon">
                <Icon name="users" size={22} />
              </div>
              <h1>Get speaker names on Google Meet</h1>
              <p className="muted">
                A small Chrome extension tells Tinta who speaks. It reads only participant names and who speaks. It does not read captions,
                chat, or audio.
              </p>
              {connected ? (
                <p className="step-done">
                  <span className="check">✓</span> The Meet extension is connected.
                </p>
              ) : (
                <>
                  <ExtensionSteps onError={onError} />
                  <p className="small muted waiting">
                    <span className="dot live" /> Waiting for the extension
                  </p>
                </>
              )}
            </>
          )}

          {step === "done" && (
            <>
              <InkMark size={48} />
              <h1>{boot.models_installed && boot.microphone === "granted" && connected ? "You are ready" : "Setup is done for now"}</h1>
              <ul className="checklist summary">
                <Summary done={boot.models_installed || !!progress} label={progress ? "Speech models are downloading" : "Speech models"} />
                <Summary done={boot.microphone === "granted"} label="Microphone" />
                <Summary done={connected} label="Meet extension" />
                <Summary done={boot.filevault} label={boot.filevault ? "FileVault" : "FileVault is off. Turn it on in System Settings."} />
              </ul>
              <p className="muted">
                Steps that you skipped stay on Home, under Get ready. Always tell the people in a call that you record and transcribe it.
              </p>
            </>
          )}
        </section>

        <footer className="onboarding-actions">
          {step === "done" ? (
            <>
              {granolaExport && (
                <button onClick={() => void finish("granola")}>
                  <Icon name="import" /> Import from Granola
                </button>
              )}
              <button className="primary big" onClick={() => void finish("home")}>
                Open Tinta
              </button>
            </>
          ) : (
            <>
              {step !== "welcome" && (
                <button className="quiet" onClick={() => setStep(STEPS[index - 1])}>
                  Back
                </button>
              )}
              <span className="spacer" />
              <button className={step === "welcome" || stepDone(step, boot, connected) ? "primary big" : "big"} onClick={next}>
                {stepDone(step, boot, connected) ? "Continue" : step === "welcome" ? "Start" : "Skip this step"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function stepDone(step: Step, boot: Bootstrap, connected: boolean): boolean {
  if (step === "models") return boot.models_installed || installRunning();
  if (step === "microphone") return boot.microphone === "granted";
  if (step === "meet") return connected;
  return false;
}

function Summary({ done, label }: { done: boolean; label: string }) {
  return (
    <li className={done ? "done" : ""}>
      <span className="check">{done ? "✓" : ""}</span>
      <span>{label}</span>
    </li>
  );
}
