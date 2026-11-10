# Changelog

## 0.10.0 (2026-11-10)

### Changed
- A close of the main window hides the window, and Tinta continues. Reminders, call detection, and a recording stay active. Click the Tinta icon in the Dock to show the window again. Press Command+Q to quit.
- A meeting whose processing failed keeps its audio for the audio period of Settings (7 days by default), and then Tinta deletes the audio. Before, this audio had no end date.
- "Process again" asks first when you set speaker names, merged speakers, or moved a turn to another speaker, because a new pass removes these changes.
- Undo on the MCP screen no longer removes later work. When you changed the same text or value after the MCP client, Tinta refuses the undo and tells you which part changed. Undo the newest change first.
- An MCP client can no longer set an audio period that ends in less than 7 days, because that deletes the audio without the trash. The client uses `delete_audio`, which moves the audio to the trash. The `move_to_folder` tool needs the `folder` argument: a name, or null to remove the folder.
- "Merge into…" asks before it merges two speakers.
- You cannot rename, merge, or edit speakers and transcript text while Tinta processes that meeting. Tinta tells you to wait, and the change is not lost.
- When "Process again" fails on a meeting that was ready, the meeting stays ready with its transcript. Tinta shows the reason.
- A reminder click during a recording of another meeting tells you that Tinta does not record the new call.
- The MCP screen shows the meeting name as a link, the field in words, and the values before and after each change.
- Command+comma opens Settings. "Install the speech models" opens Settings at the models panel.
- The open meeting and the current page are visible in the sidebar in the light appearance. Text, error, and focus colors have a higher contrast.
- Menus work with the arrow keys and give the focus back to their button. Confirm rows focus Cancel first, and Escape cancels.
- The Meet extension is version 0.5.0. Its popup and its description state that the extension reads the meeting code and the meeting title. Restart Chrome to load the new extension.
- To build Tinta, you need Rust 1.89 or later.

### Fixed
- A recording that starts from a reminder no longer takes the names of another Meet call that is open, and it no longer stops when you leave that other call.
- A second Meet tab no longer changes the mute state, the names, or the speakers of the recording. A Meet call that is open in two tabs ends when you leave the last tab.
- A recording no longer stops when Meet shows only a presentation.
- A short movement in a Meet tile, such as the pointer over it, no longer marks that person as the speaker. A person whose tile goes away no longer stays marked as the speaker.
- When a recording does not start in time, for example because a macOS permission request stays open, Tinta cancels it. Before, the recording could continue with no sign in Tinta.
- A meeting that you record some days after you created it now follows the audio period. Before, Tinta kept that audio with no end date and showed it as deleted. Tinta corrects these meetings at the first start, and then deletes audio that is past its period.
- A meeting with only a title or a folder is no longer deleted when you open it again.
- Notes no longer go back to older text after a slow reload. Tinta saves the last words when the window goes to the background or you click out of the notes, and it saves a title that you type when you open another view. A notes save that fails runs again.
- A damaged audio file no longer stops the processing of the whole meeting. Tinta processes the rest of the audio and tells you that the transcript can have gaps.
- Audio on the second channel of a stereo file or a stereo source now reaches the transcript.
- A speech model that fails to load one time no longer makes Tinta delete the speech models.
- When Tinta cannot save the audio of a recording, for example on a full disk, it stops the recording and tells you.
- When the app closes during a recording, the engine saves the last seconds of audio.
- Search finds words with an apostrophe, a hyphen, a period, or an at sign, such as "don't", "e-mail", and an email address. Search also finds the live transcript of a meeting whose processing failed.
- When Tinta cannot find a library that you moved, or the key of the library is not in the Keychain, it shows a message and does not create an empty library. A start that fails shows the reason in a dialog.
- A second copy of Tinta no longer starts on the same library.
- An audio file that Tinta cannot import no longer leaves an empty meeting in the library. "Or import an audio file" shows "Importing the audio file…" and cannot start two imports.
- Errors and notices show in the compact window, and they stay visible when a page scrolls.
- A meeting that an MCP client moves to the trash shows a bar with Restore, and its notes and title are read-only.
- Undo of a transcript correction by an MCP client lets you process the meeting again.
- The Markdown export says "written by an MCP client" for a summary that an MCP client wrote. Text with an empty line no longer breaks an SRT or VTT export.
- Folder names match in any case for all letters, so "Ámbito" and "ámbito" are one folder.
- A calendar link with a misleading address no longer shows as a Zoom, Teams, or Webex call.
- A Granola export with a time zone in its dates imports with the correct time.
- After Tinta starts again, the first request of an MCP client works. A request that is too large gets a clear error.
- The record panel tells you when macOS blocks the microphone, with a button to the Microphone settings.
- A click on a speaker name closes its popover, and the popover fits in a narrow column. A text selection in a transcript turn no longer opens the editor.
- The audio period of a meeting shows a period that is not in the usual list.
- The keyboard shortcuts do not work during setup, and Control+Command+F is full screen again.
- A live turn no longer shows twice or goes missing. The level meters stop while the recording is paused.
- A closed call notice stays closed after a search, and the Undo notice goes away after an undo.
- Search results mark the words that match, and a search error shows as an error.
- The Granola import shows its progress when you come back to the page.
- Home, the meeting view, and the sidebar no longer break in small windows. Long titles, names, and tags no longer break the layout.
- Summary errors on macOS 27 show a clear message, and a very long meeting gives an error instead of a summary that does not end.
- The extension popup shows "Tinta is not installed" when Chrome cannot start the connection, and it finds Tinta in about 2 seconds after you open it. It shows the call of the tab at once after Chrome restarts the extension.
- The extension folder updates when a file of the extension changes, also when its version number is the same.
- Deleted meetings and deleted text leave no content in the free space of the library file.
- The library uses a SQLite version without the security problem CVE-2026-119375.

## 0.9.3 (2026-10-21)

### Fixed
- Tinta finds Google Meet calls at the new Meet address, `meet.google.com/meet/...`. The participants, the speaker names, and the automatic stop at the end of the call work with these calls. Restart Chrome to load the new extension.
- A new recording no longer uses a Meet call that ended earlier. The recording stops automatically at the end of the new call, and it does not get the participants of the earlier call.
- The end of a Meet call is no longer lost when the extension connects to Tinta again at that time. The recording stops automatically. Restart Chrome to load the new extension.
- A short break in the connection to the Meet extension no longer ends the call in Tinta. Tinta waits 15 seconds for the call to send again.

## 0.9.2 (2026-10-19)

### Fixed
- Tinta no longer uses more memory each minute while it records the meeting audio.

## 0.9.1 (2026-10-17)

### Fixed
- Tinta no longer uses more memory after each meeting. You do not have to restart Tinta to make the memory free.

## 0.9.0 (2026-10-01)

### Added
- A recording bubble that floats above other apps while Tinta records and its window is not in front. Each recording starts with the bubble at the top right of your main display, the display with the menu bar. It shows the recording time and waves for your microphone and the meeting audio. Drag it to move it. Click it to see the live transcript, mute your microphone, or open the meeting in Tinta.
- **Next meetings** in the sidebar, above the past meetings. It shows up to 3 meetings of today. Click **more** to see all the meetings of the next 7 days. Click a meeting to open its notes.
- Make the window narrow to show only the sidebar. Click the band at the right to give the window its full size again.

### Changed
- The sidebar shows **Past meetings** under **Next meetings**. The Home button is gone. Click the Tinta logo to go to Home.
- When processing fails, the meeting tells you what happened in plain words. The technical details are under **Details**.

### Fixed
- A recording without speech no longer shows a technical error. The meeting says "No speech in this recording" and tells you what to check.

## 0.8.0 (2026-09-30)

### Added
- A notice above the meeting list when a meeting with a call link starts soon or runs now. Click **Join and record** to join the call and start the recording. In the Meet call already, click **Record**. Close the notice to hide it.
- Settings, Calendar, **Browser for calls**: select the browser that opens Google Meet and Webex calls.
- A microphone button in the recording controls. Click it to stop or start the recording of your microphone. It overrides the mute state of Meet, Zoom, or Microsoft Teams until you mute or unmute in the call again.

### Changed
- Calls from a reminder open in the default browser of macOS, not in Google Chrome. Tinta records all system audio for these calls.

## 0.7.3 (2026-09-30)

### Fixed
- If the Tinta logo stays in the window after Mission Control, click **Back to Tinta** or press Escape to see the app again.

## 0.7.2 (2026-09-29)

### Fixed
- Updates keep the permissions for the microphone, the meeting audio, and the calendars, and the access to the Keychain key. Build Tinta with a "Tinta Local" code signing certificate to get this. The README tells you how to make the certificate.

## 0.7.1 (2026-09-29)

### Fixed
- The Meet extension connects to Tinta again after an update, with no Chrome restart.

## 0.7.0 (2026-09-29)

### Added
- In Mission Control, the Tinta window shows the Tinta logo and "Tinta is here!" in big letters. This helps you find Tinta between the windows of your other apps. The usual view comes back when Mission Control closes.

## 0.6.0 (2026-09-28)

### Changed
- A meeting reminder stays on the screen for 2 minutes. It goes away earlier when you join the meeting or close the reminder. If Tinta already showed reminders on your Mac, open **System Settings > Notifications > Tinta** and set the style to **Persistent** (Alerts).

### Fixed
- Tinta finds the names of the speakers when Meet shows the call in its picture-in-picture window.

## 0.5.0 (2026-09-28)

### Fixed
- Audio capture and transcription work reliably when listening through Bluetooth headphones and headsets.
- Microsoft Teams participant names are recognized when Teams is set to Spanish.

## 0.4.0 (2026-09-28)

### Changed
- Tinta has a new macOS identity, `com.usetinta.tinta`, for the usetinta.com domain. Your meetings, settings, and library key move to it automatically on the first start.
- The Meet extension uses the new identity too. Tinta updates the extension in its "Chrome extension" folder, and Chrome loads the new extension the next time that it starts. Until then, the extension continues to work.
- After the update, macOS asks again one time for the microphone, the meeting audio, the calendars, and notifications. If macOS asks whether Tinta can use its key in the Keychain, click **Always Allow**.

## 0.3.1 (2026-09-25)

### Added
- After an export, the notice has **Copy path** and **Copy file** buttons. Paste the copied file in Finder, Mail, or a chat app.

### Fixed
- The summary text uses the full width of the summary card.

## 0.3.0 (2026-09-25)

### Added
- **Next meetings** on Home shows your meetings of the next 7 days from the calendars on this Mac. Tinta needs no Google sign-in: add your Google account in System Settings, Internet Accounts, and Tinta reads its calendar.
- When a meeting with a Google Meet, Zoom, Microsoft Teams, or Webex link starts soon, Home offers **Join and take notes**. Tinta opens the call, starts the recording, and opens the notes of the meeting.
- A reminder 1 minute before a meeting with a call link starts. Click it to join the call and take notes. Turn it off in Settings, Calendar.
- Click a meeting in **Next meetings** to write notes before the meeting starts.
- Settings, Calendar: select the calendars that Tinta shows.
- The MCP page lists the tools that a connected AI client can use, in two groups: the tools that read and the tools that change meetings. It also shows example requests.

### Changed
- When you record a Meet call from your calendar, the recording goes into the meeting of the calendar event, with the title of the event.
- The "tinta" name in the sidebar, the first-run setup, and the Chrome extension is easier to read. The letters have more space and less tilt.
## 0.2.2 (2026-09-25)

### Changed
- **Allow the microphone** on Home asks macOS at once, and does not open Settings.
- When macOS blocks the microphone, Home, Settings, and the first-run setup open the Microphone pane of System Settings.
- Home shows the new microphone state when you come back to Tinta from System Settings.

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
