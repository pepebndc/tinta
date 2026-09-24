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
- **Call detection.** Tinta detects calls in Google Meet, Zoom, and Microsoft Teams, offers to record them, and stops when you leave.
- **Local summaries.** After a call, the Apple on-device model writes a summary from your notes and the transcript: an overview, key points, decisions, and action items. It runs on your Mac.
- **Your library.** Search, folders, tags, and export to Markdown, JSON, SRT, and VTT.
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

Tinta is a pilot. The final pass, the library, the Granola import, and MCP work in tests. Live capture works in local tests, and the first real meetings are in progress. Expect rough edges, and export the meetings that matter.

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

**Record other apps.** Click **New meeting**, select the app under "Meeting audio", and click **Start recording**. On other apps, you name the speakers after the call.

**Headphones or speakers.** Tinta selects the echo handling from your sound output. With speakers, it removes the echo of the call from your microphone. With headphones, it records your microphone directly. Headphones give the best transcript.

**Mute in the call.** When you mute your microphone in Meet, Tinta does not record your microphone. It records it again when you unmute. With names from Zoom and Teams on, the same applies to Zoom and Teams.

**End of the call.** When you leave the call, Tinta stops the recording 3 seconds later. For Meet, closing the tab also ends the call. If you rejoin in that time, the recording continues. Turn this off in Settings, under Calls.

**While you record.** You can open other meetings, Home, or Settings. The recording, the live transcript, and the final pass continue.

**Notes and transcript.** The notes and the transcript fill the window. On a tall or narrow window, the notes show above the transcript. Drag the divider between them to change their size. Double-click the divider to reset it.

**After the call.** Tinta runs a final pass on your Mac. The final pass improves the text and matches speaker names. Play a sample of each speaker, correct names, and edit the transcript. Your notes stay separate from the transcript.

**Summaries.** After the final pass, Tinta writes a summary above the notes. Your notes show what is important to you, so the summary uses them with the transcript. Click **Write again** after you correct names or text, or **Write a summary** for an older meeting. To write summaries only when you ask, turn off "Write a summary after each call" in Settings.

**Import from Granola.** Export your Granola meetings to a folder, then click **Import from Granola** on Home. Granola transcripts have no timestamps and no audio. Delete the export folder after the import, because it is not encrypted.

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

Each meeting has an ID. To give a meeting to an AI client, click **ID · Copy** next to the date of the meeting, and paste the ID in the client. The first 8 characters of the ID are enough when they are unique. Deletions through MCP go to a 7-day trash. The **MCP** screen lists every request and lets you undo each change.

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

The self-test builds a synthetic meeting with the macOS voices. It runs the final pass, name matching, export, the MCP tools, undo, the trash, and audio retention. It uses its own data folder and does not touch your library. Install the speech models before you run it.

The interface preview accepts these views after `index.html`: `#setup`, `#meeting`, `#recording`, `#settings`, `#mcp`, `#onboarding` (with the intro), and `#onboarding-welcome`, `#onboarding-models`, `#onboarding-microphone`, `#onboarding-meet`, or `#onboarding-done`. Production builds do not include the sample data.

See the [test guide](docs/TESTING.md) for a first real meeting.

## Known limits

- The app has no Developer ID signature or Apple notarization yet.
- The extension installs unpacked. It is not in the Chrome Web Store yet.
- Speaker names come from the Meet page. When Google changes the page, names can stop until the extension gets an update.
- A Meet room device shows as one participant, so Tinta cannot name the people in the room.
- Names from Zoom and Teams are a beta. Tinta reads the labels of the call window, in English or Spanish. When Zoom or Microsoft changes the window, names can stop until Tinta gets an update. The Zoom reader is tested with Zoom Workplace 7.0 on macOS. The Teams reader is not tested with real calls yet.
- Zoom marks the last person who spoke as the active speaker until another person speaks. Short replies can get the name of the previous speaker, so check the names after the call.
- Tinta records the macOS default microphone. When the audio device changes during a recording, for example when Bluetooth headphones switch to their microphone mode, your microphone track has a gap of about 2 seconds.
- With speakers, other audio plays a little quieter during a recording.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The speech models have their own licenses, listed above.
