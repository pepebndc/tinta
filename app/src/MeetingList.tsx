import { useEffect, useMemo, useState } from "react";
import { api, Meeting, relativeDate } from "./api";
import { Icon } from "./Brand";
import { Menu } from "./Menu";
import { prefetchMeeting } from "./MeetingView";

export type Notice = { text: string; undo?: () => void };

type Props = {
  /** All meetings, archived meetings too. */
  meetings: Meeting[];
  /** False until the first list arrives, so an old filter is not reset too early. */
  loaded: boolean;
  /** "all", "archived", "folder:<name>", or "tag:<name>". */
  filter: string;
  selectedId: string | null;
  activeId: string | null;
  onFilter: (filter: string) => void;
  onOpen: (id: string) => void;
  onError: (e: string) => void;
  onNotice: (notice: Notice) => void;
};

// The drag data type of a meeting in the list.
const DRAG_TYPE = "application/x-tinta-meeting";

/** The folders of the meetings that are not archived, with the number of meetings in each. */
function folderCounts(meetings: Meeting[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const m of meetings) if (!m.archived && m.folder) counts.set(m.folder, (counts.get(m.folder) ?? 0) + 1);
  return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
}

/** The tags of the meetings that are not archived. */
export function tagList(meetings: Meeting[]): string[] {
  return Array.from(new Set(meetings.filter((m) => !m.archived).flatMap((m) => m.tags))).sort();
}

/** The meeting list in the sidebar, with the folders above the meetings. */
export function MeetingList({ meetings, loaded, filter, selectedId, activeId, onFilter, onOpen, onError, onNotice }: Props) {
  const folders = useMemo(() => folderCounts(meetings), [meetings]);
  const tags = useMemo(() => tagList(meetings), [meetings]);
  const hasArchived = meetings.some((m) => m.archived);
  const folder = filter.startsWith("folder:") ? filter.slice(7) : null;
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  // A filter for a folder or a tag that no longer exists goes back to all meetings.
  // This runs only when the list changes, so a rename can set the new name before the list arrives.
  useEffect(() => {
    if (!loaded) return;
    if (folder && !folders.some(([f]) => f === folder)) {
      const match = folders.find(([f]) => f.toLowerCase() === folder.toLowerCase());
      onFilter(match ? `folder:${match[0]}` : "all");
    } else if (filter.startsWith("tag:") && !tags.includes(filter.slice(4))) {
      onFilter("all");
    } else if (filter === "archived" && !hasArchived) {
      onFilter("all");
    }
  }, [meetings, loaded]);

  const visible = meetings.filter((m) => {
    if (filter === "archived") return m.archived;
    if (m.archived) return false;
    if (folder) return m.folder === folder;
    if (filter.startsWith("tag:")) return m.tags.includes(filter.slice(4));
    return true;
  });

  function moveTo(id: string, name: string) {
    const meeting = meetings.find((m) => m.id === id);
    if (!meeting || meeting.folder === name) return;
    api
      .setFolder(id, name)
      .then(() =>
        onNotice({
          text: `Moved "${meeting.title}" to ${name}.`,
          undo: () => void api.setFolder(id, meeting.folder).catch((e) => onError(String(e))),
        }),
      )
      .catch((e) => onError(String(e)));
  }

  function rename(name: string) {
    setRenaming(false);
    const next = name.trim();
    if (!folder || !next || next === folder) return;
    api
      .renameFolder(folder, next)
      .then(() => onFilter(`folder:${next}`))
      .catch((e) => onError(String(e)));
  }

  function remove() {
    if (!folder) return;
    const ids = meetings.filter((m) => m.folder === folder).map((m) => m.id);
    api
      .removeFolder(folder)
      .then(() => {
        onFilter("all");
        onNotice({
          text: `Removed the folder "${folder}". Its meetings stay in the list.`,
          undo: () =>
            void Promise.all(ids.map((id) => api.setFolder(id, folder)))
              .then(() => onFilter(`folder:${folder}`))
              .catch((e) => onError(String(e))),
        });
      })
      .catch((e) => onError(String(e)));
  }

  const dropProps = (name: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(name);
    },
    onDragLeave: () => setDropTarget((t) => (t === name ? null : t)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropTarget(null);
      const id = e.dataTransfer.getData(DRAG_TYPE);
      if (id) moveTo(id, name);
    },
  });

  return (
    <>
      {folder ? (
        <div className="side-label-row folder-head">
          <button className="quiet icon-only back" onClick={() => onFilter("all")} aria-label="All meetings" title="All meetings">
            <Icon name="chevron" size={14} />
          </button>
          {renaming ? (
            <input
              className="folder-name-input"
              autoFocus
              defaultValue={folder}
              aria-label="Folder name"
              onKeyDown={(e) => {
                if (e.key === "Enter") rename(e.currentTarget.value);
                if (e.key === "Escape") setRenaming(false);
              }}
              onBlur={(e) => rename(e.target.value)}
            />
          ) : (
            <span className="side-label folder-title">
              <Icon name="folder" size={13} /> {folder}
            </span>
          )}
          <Menu
            label="Folder actions"
            items={[
              { label: "Rename the folder", onSelect: () => setRenaming(true) },
              { label: "Remove the folder", title: "The meetings stay in the list, without a folder.", onSelect: remove },
            ]}
          />
        </div>
      ) : (
        <div className="side-label-row">
          <span className="side-label">Your meetings</span>
          <select className="filter" value={filter} onChange={(e) => onFilter(e.target.value)} aria-label="Filter meetings">
            <option value="all">All</option>
            {tags.map((t) => (
              <option key={t} value={`tag:${t}`}>
                Tag: {t}
              </option>
            ))}
            {(hasArchived || filter === "archived") && <option value="archived">Archived</option>}
          </select>
        </div>
      )}
      <ul className="list">
        {filter === "all" &&
          folders.map(([name, count]) => (
            <li
              key={`folder-${name}`}
              className={`item folder-row ${dropTarget === name ? "drop" : ""}`}
              title={`Open the folder. Drag a meeting here to move it to ${name}.`}
              {...pressable(() => onFilter(`folder:${name}`))}
              {...dropProps(name)}
            >
              <Icon name="folder" />
              <strong>{name}</strong>
              <span className="count">{count}</span>
            </li>
          ))}
        {visible.length === 0 && (
          <li className="empty-list">{filter === "all" ? "No meetings yet." : folder ? "This folder is empty." : "No meetings match."}</li>
        )}
        {visible.map((m) => (
          <li
            key={m.id}
            className={`item ${selectedId === m.id ? "selected" : ""}`}
            aria-current={selectedId === m.id ? "page" : undefined}
            draggable={!m.archived}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, m.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            {...pressable(() => onOpen(m.id))}
            onMouseEnter={() => prefetchMeeting(m.id)}
          >
            {activeId === m.id ? <span className="rec-dot" /> : <Icon name="document" />}
            <div>
              <strong>{m.title}</strong>
              <span>
                {relativeDate(m.started_at ?? m.created_at)}
                {!folder && m.folder && <> · {m.folder}</>}
                {(m.state === "processing" || m.state === "failed") && (
                  <em className={`state state-${m.state}`}> · {m.state === "failed" ? "processing failed" : "processing"}</em>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Props that make a list item work with the mouse and the keyboard. */
export function pressable(action: () => void) {
  return {
    role: "button",
    tabIndex: 0,
    onClick: action,
    onKeyDown: (e: React.KeyboardEvent) => {
      // A button inside the item handles its own keys.
      if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      action();
    },
  };
}
