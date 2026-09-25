# Changelog

## 0.2.1 (2026-09-25)

### Fixed
- During a recording, a long transcript scrolls inside its box. The page no longer grows with the transcript.
- The notes and the transcript get their size from the window, with a minimum size for small windows.
- On narrow windows, Pause and Stop stay on the row of the recording controls.

## 0.2.0 (2026-09-25)

### Added
- Deleted meetings go to the trash for 7 days. You can restore them from **Trash**, or click **Undo** in the notice after a delete.
- Folders in the sidebar, with the number of meetings in each. Click a folder to open it. Drag a meeting onto a folder to move it. Rename or remove a folder from its **…** menu.
- A new meeting that you create in an open folder goes into that folder.
- Tags and folders show as chips under the meeting title. The fields suggest your existing tags and folders.
- Click a speaker name in the transcript to name the speaker, or to give the turn to another speaker.
- The Home cards show the first line of the summary and the people of the meeting.
- The summary can collapse.
- A **…** menu on each meeting: copy as Markdown, copy the meeting ID, archive, and move to the trash.
- Search opens from the icon next to **New meeting**, or with ⌘F. ⌘N creates a meeting.
- The language menu offers all 25 languages of the speech model.
- Settings has groups with links at the top, and shows the version of Tinta.
- Error notices have a button that copies the error.

### Changed
- Tinta starts a recording faster, because it loads the speech models when it opens.
- The sidebar and Home show dates as "Today", "Yesterday", or the weekday for the last 7 days.
- Speaker names have colors in place of the initials. The people of one meeting get different colors.
- "Final pass" is now "processing", for example "Processing failed" and "Process again".
- After Stop, the meeting shows "Saving the recording…", then one progress bar.
- The live transcript scrolls to new text only when you are at the end of it.
- Folder names match without regard to case, and search finds meetings by the folder name.
- The Granola import is in Settings, under Import.
- MCP access is off until you turn it on in the MCP screen.
- Archived meetings are in the **Archived** item of the sidebar filter.
- The Meet extension status in the sidebar shows only when the extension is connected.
- Actions that you cannot undo ask for confirmation in the row, not in a dialog.
- Notices close with a cross at the right side.
- Tinta does not keep a new meeting that you leave without a recording, notes, a title, tags, or a folder.

### Fixed
- The Meet call stays active while the call is in picture-in-picture.
- Two quick clicks no longer start two recordings.
- A crash of the recording engine no longer leaves the meeting in "Recording". Tinta stops the recording and processes the audio that it has.
- The app no longer freezes when the window opens during a Meet message.
- Tinta keeps the audio of a meeting whose processing failed, so you can process it again.
- A notes save no longer loses text that you type during a reload.
- Archive, the title, the tags, and the folder now update the sidebar at once.
- Search no longer shows the results of an old query.
- The sidebar filter no longer stays on a folder or tag that does not exist.
- The last seconds of the meeting audio are no longer lost at Stop.
- The extension badge no longer stays on REC after the call ends.
- The participant list in the extension popup keeps its scroll position.
- The level meters and the transcript no longer slow the window during a recording.

### Removed
- The status bar at the bottom of a meeting, the breadcrumb, and the repeated privacy and setup notes on Home.
