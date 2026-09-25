<p align="center">
  <img src="assets/tinta-icon.png" width="96" alt="Tinta icon">
</p>

<h1 align="center">Tinta</h1>

<p align="center"><strong>Meeting notes. On your Mac.</strong><br>
Write your notes, get a transcript with speaker names, and keep everything on your own computer.</p>

> [!NOTE]
> Tinta is in active development. Expect bugs and changes. All feedback is welcome. To report a bug or suggest an improvement, [open an issue](https://github.com/pepebndc/tinta/issues).

<p align="center">
  <img src="docs/images/meeting.png" alt="A meeting in Tinta: notes on the left, a transcript with speaker names on the right">
</p>

## What Tinta does

- **Notes and transcript side by side.** Write your notes while the draft transcript appears. Insert a timestamp with one click.
- **Local transcription.** Parakeet v3 runs on the Apple Neural Engine. It supports English, Spanish, and 23 other European languages. Tinta detects the language.
- **Speaker names.** Tinta separates the voices. On Google Meet, a small Chrome extension reads who speaks, and Tinta names each speaker. In the Zoom and Microsoft Teams apps, Tinta reads who speaks from the call window (beta). You can confirm, correct, merge, or split speakers.
- **Next meetings.** Tinta reads the calendars on your Mac, with no sign-in, and shows your next meetings. A reminder before each call lets you join it and take notes with one click.
- **Call detection.** Tinta detects calls in Google Meet, Zoom, and Microsoft Teams, offers to record them, and stops when you leave.
- **Local summaries.** After a call, the Apple on-device model writes a summary from your notes and the transcript: an overview, key points, decisions, and action items. It runs on your Mac.
- **Your library.** Search, folders, tags, and export to Markdown, JSON, SRT, and VTT.
- **Trash.** Deleted meetings stay in the trash for 7 days.
- **Import from Granola.** Bring your Granola export into Tinta, with notes, transcripts, and speaker names.
- **MCP server.** Connect Claude or another MCP client to your meetings when you choose to.

Tinta has no chat and no cloud AI. The transcription, the speaker separation, and the summaries run on your Mac.

## Privacy by design

| | |
|---|---|
| **Processing** | Transcription and speaker separation run on your Mac. Tinta has no server and no cloud service. |
| **Network** | Tinta downloads the speech models once, when you click Install. After that, it makes no network requests: no analytics, no crash reports, and no update checks. |
| **Storage** | SQLCipher encrypts the library, and AES-GCM encrypts the audio. The key is in your macOS Keychain. Time Machine does not back up the library. |
| **Audio** | By default, Tinta deletes the audio 7 days after a meeting. In Settings, under Storage, you can change this default from 0 to 30 days. You can also change the period of one meeting, or delete its audio at once. |
| **Summaries** | The Apple on-device model writes the summaries. Tinta does not use Private Cloud Compute or any other server. A summary can contain mistakes, so check it against the transcript. |
| **Browser** | The Meet extension reads only participant names, who speaks, and whether your microphone is muted. It does not read captions, chat, or audio. |
| **Zoom and Teams** | Tinta detects a call from the use of the microphone. It does not read the audio of the app to detect the call. When you turn on names from Zoom and Teams (beta), Tinta reads the participant names, who speaks, and whether your microphone is muted from the call window. This needs Accessibility access. Tinta does not keep other text of the window. |
| **MCP** | MCP access is local. An AI client that reads your meetings sends that content to its own model provider. Tinta records every MCP change, so you can undo it. |

Tinta does not tell other people in a call that you record. Always tell them.

## Screenshots

| Home | Recording |
|---|---|
| ![Home with a detected Google Meet call](docs/images/home.png) | ![A recording with level meters and a live draft](docs/images/recording.png) |

| Dark appearance | Chrome extension |
|---|---|
| ![The meeting view in the dark appearance](docs/images/meeting-dark.png) | <img src="docs/images/extension-popup.png" width="320" alt="The extension popup with the participants of a call"> |

## Status

Tinta is a pilot. Processing, the library, the Granola import, and MCP work in tests. Live capture works in local tests, and the first real meetings are in progress. Expect rough edges, and export the meetings that matter.

## Requirements

- A Mac with Apple Silicon (M1 or newer) and macOS 14.2 or later. 16 GB of memory is recommended.
- Google Chrome, for speaker names on Google Meet.
- The Zoom Workplace or the Microsoft Teams desktop app, for calls in Zoom or Teams. Tinta does not read Zoom or Teams calls in a browser.
- macOS 26 or later with Apple Intelligence turned on, for summaries. Summaries support English, Spanish, and the other Apple Intelligence languages.
- About 1 GB of free disk space for the app and the speech models.

## Install

Tinta has no signed download yet. Build it from source:

1. Install the Xcode Command Line Tools, Rust, Node.js 20 or later, and pnpm.
2. Clone this repository.
3. Run `./scripts/build.sh`.
4. Move `target/release/bundle/macos/Tinta.app` to your Applications folder.
5. Open Tinta. macOS blocks apps without Apple notarization. Open System Settings, then Privacy & Security, and click **Open Anyway**.
6. If macOS asks whether Tinta can use its key in the Keychain, click **Always Allow**.

## Set up

When you open Tinta for the first time, a short setup guides you through these steps. You can skip each step, or skip all of setup. Steps that you skip stay on Home, under Get ready. To see the setup again, open Settings and click **Run setup again**.

1. **Your name and appearance.** Tinta uses your name for your microphone in the transcript.
2. **Speech models.** Click **Install models**. Tinta downloads about 500 MB at pinned revisions and checks each file against its SHA-256 hash. The download continues if you go to the next step.
3. **Microphone.** Click **Allow microphone**. macOS asks for the audio of other apps at the first recording.
4. **Chrome extension.** Click **Show extension folder**. Tinta puts the extension in a "Chrome extension" folder and shows it in Finder. Open `chrome://extensions` in Chrome, turn on Developer mode, and drag the folder onto the page. Restart Chrome. The setup shows when the extension connects.

## Use

**Record a Google Meet call.** Join the call in Chrome. Home shows "Google Meet call detected". Tell everyone that you record, then click **Record this call**.

**Record a Zoom or Teams call.** Join the call in the Zoom or Microsoft Teams desktop app. Home shows "Zoom call detected" or "Microsoft Teams call detected". Tell everyone that you record, then click **Record this call**.

**Names from Zoom and Teams (beta).** Open Settings, and under Calls, turn on "Get speaker names from Zoom and Microsoft Teams". macOS asks for Accessibility access for Tinta. Allow it in System Settings, then Privacy & Security, then Accessibility. During the call, Tinta reads the participant names and the active speaker from the call window. In a call with one other person, the other voice gets that person's name. Without the beta, you name the speakers after the call.

**Next meetings.** Add your Google account in System Settings, then Internet Accounts, and turn on Calendars. On Home, click **Connect calendar**, and allow access when macOS asks. Tinta shows your meetings of the next 7 days. It reads the calendars on this Mac and needs no sign-in. One minute before a meeting with a Google Meet, Zoom, Microsoft Teams, or Webex link, Tinta shows a reminder. Click it, or click **Join and take notes** on Home. Tinta opens Meet in Chrome, and Zoom and Teams in their apps. Then it starts the recording and opens the notes. Tell everyone that you record. Tinta must be open to show reminders. Select the calendars in Settings, Calendar.

**Record other apps.** Click **New meeting**, select the app under "Meeting audio", and click **Start recording**. On other apps, you name the speakers after the call. To transcribe an audio file, click **New meeting**, then **Or import an audio file**.

**Headphones or speakers.** Tinta selects the echo handling from your sound output. With speakers, it removes the echo of the call from your microphone. With headphones, it records your microphone directly. Headphones give the best transcript.

**Mute in the call.** When you mute your microphone in Meet, Tinta does not record your microphone. It records it again when you unmute. With names from Zoom and Teams on, the same applies to Zoom and Teams.

**End of the call.** When you leave the call, Tinta stops the recording 3 seconds later. For Meet, closing the tab also ends the call. If you rejoin in that time, the recording continues. Turn this off in Settings, under Calls.

**While you record.** You can open other meetings, Home, or Settings. The recording, the live transcript, and processing continue.

**Notes and transcript.** The notes and the transcript fill the window. On a tall or narrow window, the notes show above the transcript. Drag the divider between them to change their size. Double-click the divider to reset it.

**After the call.** Tinta processes the recording on your Mac. Processing improves the text and matches speaker names. To name a speaker, click the speaker name in the transcript. Click the text of a turn to edit it. Under Speakers, play a sample of each speaker and merge speakers. Your notes stay separate from the transcript.

**Summaries.** After processing, Tinta writes a summary above the notes. Your notes show what is important to you, so the summary uses them with the transcript. Click **Write again** after you correct names or text, or **Write a summary** for an older meeting. To hide the summary, click **Summary**. To write summaries only when you ask, turn off "Write a summary after each call" in Settings.

**Folders and tags.** Under the title of a meeting, click **+ Folder** or **+ Tag**. You can also drag a meeting from the list onto a folder. The folders show above the meetings in the sidebar. Click a folder to open it, and click **…** next to its name to rename or remove it. A new meeting that you create in an open folder goes into that folder. To show the meetings with a tag, select the tag in the filter above the list, or click the tag on a Home card.

**Archive or delete a meeting.** Click **…** on the meeting, then **Archive** or **Move to the trash**. To see archived meetings, select **Archived** in the filter above the meeting list. The meeting stays in the trash for 7 days, and then Tinta deletes it permanently. To get it back, click **Undo** in the notice, or open **Trash** and click **Restore**. To delete it at once, open **Trash** and click **Delete now**, then **Delete permanently**.

**New meetings without input.** If you click **New meeting** and leave the meeting before you record, write notes, or add a title, tags, or a folder, Tinta does not keep it.

**Import from Granola.** Export your Granola meetings to a folder, then open Settings, and under Import, click **Import from Granola**. Granola transcripts have no timestamps and no audio. Delete the export folder after the import, because it is not encrypted.

## Connect an MCP client

Open **MCP** in the sidebar, and turn on "Allow MCP clients to read and change meetings". The MCP screen shows the configuration. For Claude Desktop, add:

```json
{
  "mcpServers": {
    "tinta": { "command": "/Applications/Tinta.app/Contents/MacOS/tinta-mcp" }
  }
}
```

For Claude Code, run `claude mcp add tinta /Applications/Tinta.app/Contents/MacOS/tinta-mcp`.

Tinta must be open. The tools can list, search, and read meetings, including notes, transcripts, and summaries. They can also change titles, tags, folders, notes, summaries, speaker names, and transcript text.

Each meeting has an ID. To give a meeting to an AI client, click **…** on the meeting, then **Copy the meeting ID**, and paste the ID in the client. The first 8 characters of the ID are enough when they are unique. Deletions through MCP go to the trash. The **MCP** screen lists every request and lets you undo each change.

Meeting text can contain instructions from other people. Do not let an AI client act on them.

## How it works

```mermaid
flowchart LR
    Mic[Microphone] --> Engine
    Call[Meeting app audio] --> Tap[Tap helper] --> Engine
    Engine[tinta-engine<br>Parakeet, VAD, diarization] --> App
    Apps[Zoom and Teams windows<br>names and active speaker] --> Reader[Call reader, Accessibility] --> Engine
    Ext[Chrome extension<br>names and active speaker] --> Host[tinta-native-host] --> App
    App[Tinta app<br>encrypted library] --> UI[Window]
    Client[MCP client] --> MCP[tinta-mcp] --> App
```

| Component | Path | Role |
|---|---|---|
| App | `app/` | Tauri 2 window with a React interface. It owns the encrypted library, name matching, retention, and the app socket. |
| Core | `crates/tinta-core` | Storage, keys, name matching, export, the Granola import, and the MCP tools. |
| Engine | `engine/` | Swift process for capture, encrypted audio chunks, and the speech models through FluidAudio. |
| MCP server | `crates/tinta-mcp` | MCP over stdio. It forwards tool calls to the running app. |
| Native host | `crates/tinta-native-host` | Chrome Native Messaging host for the Meet extension. |
| Extension | `extension/` | Reads Meet participants and active speakers. See its [README](extension/README.md). |

The helper binaries connect to the app over a private Unix socket. The app accepts only the signed helpers inside its own bundle.

## Speech models

| Model | Use | License |
|---|---|---|
| [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) by NVIDIA, [Core ML conversion](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml) by FluidInference | Transcription | CC-BY-4.0 |
| [Silero VAD](https://huggingface.co/FluidInference/silero-vad-coreml) | Voice activity detection | MIT |
| [pyannote Community-1](https://huggingface.co/pyannote/speaker-diarization-community-1), [Core ML conversion](https://huggingface.co/FluidInference/speaker-diarization-coreml) by FluidInference | Speaker separation | CC-BY-4.0 |

This repository does not include the models. Tinta downloads them at pinned revisions and checks every file against the hashes in `engine/Sources/TintaEngine/ModelManifest.swift`.

## Development

| Task | Command |
|---|---|
| Unit tests | `cargo test --workspace` |
| Extension tests | `node --test extension/test/speaking.test.mjs` |
| End-to-end self-test | `TINTA_DATA_DIR=$(mktemp -d) cargo run -p tinta-selftest` |
| Interface preview with sample data | `cd app && pnpm preview:mock`, then open `app/dist-mock/index.html` |
| App bundle | `./scripts/build.sh` |

The self-test builds a synthetic meeting with the macOS voices. It runs processing, name matching, export, the MCP tools, undo, the trash, and audio retention. It uses its own data folder and does not touch your library. Install the speech models before you run it.

The interface preview accepts these views after `index.html`: `#setup`, `#meeting`, `#recording`, `#settings`, `#mcp`, `#onboarding` (with the intro), and `#onboarding-welcome`, `#onboarding-models`, `#onboarding-microphone`, `#onboarding-meet`, or `#onboarding-done`. Production builds do not include the sample data.

See the [test guide](docs/TESTING.md) for a first real meeting.

## Known limits

- The app has no Developer ID signature or Apple notarization yet.
- The extension installs unpacked. It is not in the Chrome Web Store yet.
- Speaker names come from the Meet page. When Google changes the page, names can stop until the extension gets an update.
- A Meet room device shows as one participant, so Tinta cannot name the people in the room.
- Names from Zoom and Teams are a beta. Tinta reads the labels of the call window. When Zoom or Microsoft changes the window, names can stop until Tinta gets an update. The Zoom reader reads English and Spanish labels, and it is tested with Zoom Workplace 7.0 on macOS. The Teams reader reads English labels only, and it is tested with Teams 26225 on macOS.
- In Teams, Tinta reads the names from the video tiles. In a large meeting, Teams does not show a tile for each person, so Tinta does not get the names of the people without a tile.
- Zoom marks the last person who spoke as the active speaker until another person speaks. Short replies can get the name of the previous speaker, so check the names after the call.
- Tinta records the macOS default microphone. When the audio device changes during a recording, for example when Bluetooth headphones switch to their microphone mode, your microphone track and the meeting audio can have a gap of up to 3 seconds.
- With speakers, other audio plays a little quieter during a recording.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The speech models have their own licenses, listed above.
