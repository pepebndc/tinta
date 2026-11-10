import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, GranolaPreview, GranolaSummary, on } from "./api";
import { Icon } from "./Brand";

type Progress = { done: number; total: number };

// One import at a time. It continues when the user opens another page, and the page shows it again.
let running: { path: string; result: Promise<GranolaSummary>; progress: Progress } | null = null;

export function GranolaImport({ onError, onDone }: { onError: (e: string) => void; onDone: () => void }) {
  const [path, setPath] = useState<string | null>(running?.path ?? null);
  const [preview, setPreview] = useState<GranolaPreview | null>(null);
  const [summaries, setSummaries] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(running?.progress ?? null);
  const [result, setResult] = useState<GranolaSummary | null>(null);
  const mounted = useRef(true);

  async function choose(next: string | null) {
    setPath(next);
    setPreview(null);
    setResult(null);
    if (!next) return;
    try {
      setPreview(await api.granolaPreview(next));
    } catch (e) {
      onError(String(e));
    }
  }

  /** Shows the result of an import when it completes. */
  function follow(job: NonNullable<typeof running>) {
    job.result
      .then(async (summary) => {
        if (!mounted.current) return;
        setResult(summary);
        setPreview(await api.granolaPreview(job.path));
      })
      .catch((e) => onError(String(e)))
      .finally(() => mounted.current && setProgress(null));
  }

  useEffect(() => {
    mounted.current = true;
    if (running) {
      void api.granolaPreview(running.path).then((p) => mounted.current && setPreview(p)).catch(() => undefined);
      follow(running);
    } else {
      api
        .granolaDefaultPath()
        .then((p) => {
          if (p) void choose(p);
        })
        .catch(() => undefined);
    }
    // A progress event can arrive after the import completes. Only an import in progress shows it.
    const sub = on<Progress>("granola_progress", (p) => {
      if (!running) return;
      running.progress = p;
      setProgress(p);
    });
    return () => {
      mounted.current = false;
      void sub.then((u) => u());
    };
  }, []);

  async function pick() {
    const folder = await open({ directory: true, multiple: false, title: "Select the Granola export folder" });
    if (typeof folder === "string") await choose(folder);
  }

  function run() {
    if (!path || running) return;
    const job = { path, progress: { done: 0, total: preview?.total ?? 0 }, result: api.importGranola(path, summaries) };
    running = job;
    setProgress(job.progress);
    void job.result
      .then(onDone, () => undefined)
      .finally(() => {
        running = null;
      });
    follow(job);
  }

  const remaining = preview ? preview.total - preview.already_imported : 0;

  return (
    <section className="panel">
      <p className="small muted">
        Select the folder of a Granola export: it contains manifest.json and one folder for each meeting. Tinta imports titles,
        dates, participants, your notes, and transcripts with speaker names. Granola transcripts have no timestamps and no audio.
      </p>
      <div className="row">
        <button onClick={pick} disabled={!!progress}>
          <Icon name="import" /> {path ? "Select another folder" : "Select folder"}
        </button>
        {path && <span className="small muted ellipsis">{path}</span>}
      </div>
      {preview && (
        <div className="import-preview">
          <p>
            <strong>{preview.total}</strong> meetings: {preview.mine} that you captured and {preview.shared} shared with you.
            {preview.already_imported > 0 && ` ${preview.already_imported} are in Tinta already and stay unchanged.`}
          </p>
          <label className="small">
            <input type="checkbox" checked={summaries} onChange={(e) => setSummaries(e.target.checked)} /> Add the Granola AI
            summaries to the notes, marked as imported
          </label>
          <div className="row">
            <button className="primary" disabled={remaining === 0 || !!progress} onClick={run}>
              {progress
                ? `Importing ${progress.done} of ${progress.total}…`
                : remaining === 0
                  ? "All meetings are imported"
                  : `Import ${remaining} meetings`}
            </button>
          </div>
          {progress && (
            <div
              className="meter-bar wide"
              role="progressbar"
              aria-label="Import"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
            >
              <div style={{ transform: `scaleX(${progress.total ? progress.done / progress.total : 0})` }} />
            </div>
          )}
        </div>
      )}
      {result && (
        <div className="import-result">
          <p>
            Imported {result.imported} meetings. {result.skipped > 0 && `Skipped ${result.skipped} that were imported before.`}
            {result.failed.length > 0 && ` ${result.failed.length} could not be imported.`}
          </p>
          {result.failed.slice(0, 10).map((f, i) => (
            <div key={i} className="small warn">
              {f.title}: {f.error}
            </div>
          ))}
          <p className="small warn">
            The export folder is not encrypted. After you check the imported meetings, delete the folder and empty the Trash in Finder.
          </p>
        </div>
      )}
    </section>
  );
}
