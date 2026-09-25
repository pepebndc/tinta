import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, GranolaPreview, GranolaSummary, on } from "./api";
import { Icon } from "./Brand";

export function GranolaImport({ onError, onDone }: { onError: (e: string) => void; onDone: () => void }) {
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<GranolaPreview | null>(null);
  const [summaries, setSummaries] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<GranolaSummary | null>(null);

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

  useEffect(() => {
    api
      .granolaDefaultPath()
      .then((p) => {
        if (p) void choose(p);
      })
      .catch(() => undefined);
    const sub = on<{ done: number; total: number }>("granola_progress", setProgress);
    return () => void sub.then((u) => u());
  }, []);

  async function pick() {
    const folder = await open({ directory: true, multiple: false, title: "Select the Granola export folder" });
    if (typeof folder === "string") await choose(folder);
  }

  async function run() {
    if (!path) return;
    setProgress({ done: 0, total: preview?.total ?? 0 });
    try {
      setResult(await api.importGranola(path, summaries));
      setPreview(await api.granolaPreview(path));
      onDone();
    } catch (e) {
      onError(String(e));
    } finally {
      setProgress(null);
    }
  }

  const remaining = preview ? preview.total - preview.already_imported : 0;

  return (
    <section className="panel">
      <p className="small muted">
        Select the folder of a Granola export: it contains manifest.json and one folder for each meeting. Tinta imports titles,
        dates, participants, your notes, and transcripts with speaker names. Granola transcripts have no timestamps and no audio.
      </p>
      <div className="row">
        <button onClick={pick}>
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
            <div className="meter-bar wide">
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
          {result.failed.slice(0, 10).map((f) => (
            <div key={f.title} className="small warn">
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
