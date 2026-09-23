# Test guide: first real meeting

This guide prepares a Mac for a real Google Meet test. Do the setup steps once.

## Setup

1. Build the app with `./scripts/build.sh`, or use a build that you received.
2. Move `Tinta.app` to the Applications folder and open it.
3. If macOS asks whether Tinta can use its key in the Keychain, click Always Allow. The app stores its library key there.
4. Open Settings in the app and click Install models. The app downloads about 500 MB from Hugging Face. This is the only download.
5. In Settings, check "Your name". The app uses this name for your microphone.
6. Open `chrome://extensions` in Chrome and turn on Developer mode.
7. Click Load unpacked and select the `extension` folder of this repository.
8. Check that the extension ID is `ajncjfpbmkmiheokjfhfdlhnmfbaofij`.
9. Restart Chrome. The app writes the native host file for Chrome when it starts, so open the app at least once before the restart.

## During the meeting

1. Join the Google Meet call in Chrome.
2. Check that the app sidebar shows "Meet extension: in call" with the participant count.
3. Tell everyone in the call that you record and transcribe the meeting.
4. In the app, click New meeting. The title comes from Meet.
5. Keep "Meeting audio" set to Google Chrome, and click Start recording.
6. Allow the two macOS permission requests: microphone, and audio recording of other apps.
7. Check both level meters. "Meeting audio" moves when other people speak.
8. Write notes. Draft text with provisional names appears on the right.
9. Click Stop at the end of the meeting.

## After the meeting

1. Wait for the final pass. The self-test ran 30 seconds of audio in 1.8 seconds. A one-hour meeting is not measured yet. The target is 10 minutes or less.
2. Check the speaker names. Names from Meet show "Automatic (Meet)". Click Play sample to hear a speaker.
3. Correct wrong names, merge split speakers, or move a single turn to another speaker.
4. Click a transcript turn to correct its text.
5. Export the meeting as Markdown, JSON, SRT, or VTT, or click Copy.

## What to record for the pilot

Write down these results after each test meeting:

- The number of participants, and whether anyone joined from a meeting room.
- How many remote speakers got a correct automatic name, and how many got a wrong one.
- The time that you needed to correct names.
- Missing or wrong text, and whether it was your voice or a remote voice.
- Any gap in the audio, or a warning that the meeting audio was not detected.

## Known limits

- Meet names depend on the Meet page. When Google changes the page, names can stop. The transcript still works, and the speakers stay unnamed.
- A Meet room device shows as one participant. The app cannot name the people in the room.
- The app records the macOS default microphone. Change it in System Settings, Sound.
- One recording per meeting. After you stop, create a new meeting for a new recording.
- The app does not separate several people on your own microphone. All microphone speech gets your name.
- The Keychain key uses the login keychain. The device-only data protection keychain needs a Developer ID signature.

## Troubleshooting

| Symptom | Action |
|---|---|
| "Meet extension: not connected" | Open the app, then restart Chrome. Check the extension ID. |
| "Meeting audio (not detected)" | Check that the meeting plays in Chrome. Select "All system audio" for other apps. |
| Remote speech appears as your turns | Use headphones. With speakers, Tinta removes most echo, but loud speakers can leave a few words. |
| The final pass failed | Click "Run the final pass again" in the meeting. The audio stays for 7 days. |

## Import from Granola

1. Open Settings, or click "Import from Granola" on Home. Tinta finds `~/granola-export` automatically.
2. Check the number of meetings, and click Import.
3. Leave "Add the Granola AI summaries" off, unless you need them. Tinta marks imported summaries in the notes.
4. Open a few imported meetings. Check the notes, the transcript, and the speaker names.
5. Delete the export folder and empty the Trash in Finder. The export is not encrypted.

Imported meetings are in the folder "Granola" with the tag `granola`. Meetings that other people shared with you also have the tag `shared-with-me`. They have no audio and no timestamps. A second import skips the meetings that Tinta has already.

## Connect an MCP client

1. Open Settings and copy the MCP configuration.
2. Add it to Claude Desktop, or run the `claude mcp add` command in the settings.
3. Keep the app open. The MCP server works only while the app runs.
4. Check MCP activity in the sidebar. You can undo each change that a client makes.
