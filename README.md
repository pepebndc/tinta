<p align="center">
  <img src="assets/tinta-icon.png" width="96" alt="Tinta icon">
</p>

<h1 align="center">Tinta</h1>

<p align="center"><strong>Meeting notes. On your Mac.</strong><br>
Write your notes, get a transcript with speaker names, and keep everything on your own computer.</p>

<p align="center">
  <img src="docs/images/meeting.png" alt="A meeting in Tinta: notes on the left, a transcript with speaker names on the right">
</p>

## What Tinta does

- **Notes and transcript side by side.** Write your notes while the draft transcript appears. Insert a timestamp with one click.
- **Local transcription.** Parakeet v3 runs on the Apple Neural Engine. It supports English, Spanish, and 23 other European languages. Tinta detects the language.
- **Speaker names.** Tinta separates the voices. On Google Meet, a small Chrome extension reads who speaks, and Tinta names each speaker. You can confirm, correct, merge, or split speakers.
- **Your library.** Search, folders, tags, and export to Markdown, JSON, SRT, and VTT.
- **Import from Granola.** Bring your Granola export into Tinta, with notes, transcripts, and speaker names.
- **MCP server.** Connect Claude or another MCP client to your meetings when you choose to.

Tinta has no summaries, no chat, and no AI features of its own. It records, transcribes, and keeps your notes.

## Privacy by design

| | |
|---|---|
| **Processing** | Transcription and speaker separation run on your Mac. Tinta has no server and no cloud service. |
| **Network** | Tinta downloads the speech models once, when you click Install. After that, it makes no network requests: no analytics, no crash reports, and no update checks. |
| **Storage** | SQLCipher encrypts the library, and AES-GCM encrypts the audio. The key is in your macOS Keychain. Time Machine does not back up the library. |
| **Audio** | Tinta deletes the audio 7 days after a meeting. You can keep it for up to 30 days, or delete it at once. |
| **Browser** | The Meet extension reads only participant names and who speaks. It does not read captions, chat, or audio. |
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

1. **Speech models.** In Tinta, open Settings and click **Install models**. Tinta downloads about 500 MB at pinned revisions and checks each file against its SHA-256 hash.
2. **Chrome extension.** Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and select the `extension` folder of this repository. Keep the folder, because Chrome loads the extension from it.
3. **Restart Chrome.** Click the Tinta icon in the Chrome toolbar. The popup shows "Connected to Tinta".
4. **Permissions.** At the first recording, macOS asks for access to the microphone and to the audio of other apps. Allow both.

## Use

**Record a Google Meet call.** Join the call in Chrome. Home shows "Google Meet call detected". Tell everyone that you record, then click **Record this call**.

**Record other apps.** Click **New meeting**, select the app under "Meeting audio" (for example Zoom), and click **Start recording**. Speakers get automatic names on Google Meet only. On other apps, you name them after the call.

**Headphones or speakers.** Tinta selects the echo handling from your sound output. With speakers, it removes the echo of the call from your microphone. With headphones, it records your microphone directly. Headphones give the best transcript.

**After the call.** Tinta runs a final pass on your Mac. The final pass improves the text and matches speaker names. Play a sample of each speaker, correct names, and edit the transcript. Your notes stay separate from the transcript.

**Import from Granola.** Export your Granola meetings to a folder, then click **Import from Granola** on Home or in Settings. Granola transcripts have no timestamps and no audio. Delete the export folder after the import, because it is not encrypted.

## Connect an MCP client

Settings shows the configuration. For Claude Desktop, add:

```json
{
  "mcpServers": {
    "tinta": { "command": "/Applications/Tinta.app/Contents/MacOS/tinta-mcp" }
  }
}
```

For Claude Code, run `claude mcp add tinta /Applications/Tinta.app/Contents/MacOS/tinta-mcp`.

Tinta must be open. The tools can list, search, and read meetings. They can also change titles, tags, folders, notes, speaker names, and transcript text. Deletions through MCP go to a 7-day trash. **MCP activity** in the sidebar lists every request and lets you undo each change.

Meeting text can contain instructions from other people. Do not let an AI client act on them.

## How it works

```mermaid
flowchart LR
    Mic[Microphone] --> Engine
    Call[Meeting app audio] --> Tap[Tap helper] --> Engine
    Engine[tinta-engine<br>Parakeet, VAD, diarization] --> App
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

The interface preview accepts these views after `index.html`: `#setup`, `#meeting`, `#recording`, and `#settings`. Production builds do not include the sample data.

See the [test guide](docs/TESTING.md) for a first real meeting.

## Known limits

- The app has no Developer ID signature or Apple notarization yet.
- The extension installs unpacked. It is not in the Chrome Web Store yet.
- Speaker names come from the Meet page. When Google changes the page, names can stop until the extension gets an update.
- A Meet room device shows as one participant, so Tinta cannot name the people in the room.
- Tinta records the macOS default microphone.
- With speakers, other audio plays a little quieter during a recording.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The speech models have their own licenses, listed above.
