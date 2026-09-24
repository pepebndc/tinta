# Test guide: first real meeting

This guide prepares a Mac for a real Google Meet test. Do the setup steps once.

## Setup

1. Build the app with `./scripts/build.sh`, or use a build that you received.
2. Move `Tinta.app` to the Applications folder and open it.
3. If macOS asks whether Tinta can use its key in the Keychain, click Always Allow. The app stores its library key there.
4. Follow the setup that opens at the first start. You can also open it later: Settings, Run setup again.
5. Check "Your name". The app uses this name for your microphone.
6. Click Install models. The app downloads about 500 MB from Hugging Face. This is the only download.
7. Click Allow microphone.
8. Click Show extension folder. Open `chrome://extensions` in Chrome, turn on Developer mode, and drag the "Chrome extension" folder from Finder onto the page.
9. Check that the extension ID is `ajncjfpbmkmiheokjfhfdlhnmfbaofij`.
10. Restart Chrome. The setup shows "The Meet extension is connected" when Chrome connects to the app.

## During the meeting

1. Join the Google Meet call in Chrome.
2. Check that the app sidebar shows "Meet extension: in call" with the participant count.
3. Tell everyone in the call that you record and transcribe the meeting.
4. In the app, click New meeting. The title comes from Meet.
5. Keep "Meeting audio" set to Google Chrome, and click Start recording.
6. Allow the two macOS permission requests: microphone, and audio recording of other apps.
7. Check both level meters. "Meeting audio" moves when other people speak.
8. Write notes. Draft text with provisional names appears next to the notes.
9. Mute your microphone in Meet and speak. The microphone meter shows "muted in Meet", and no draft text from your microphone appears. Unmute and check that your speech appears again.
10. Open the extension popup and turn on "Highlight who speaks on the page". Check that a lavender ring shows around the Meet speaking circle of the person who speaks.
11. Leave the call in Meet. After 3 seconds, Tinta stops the recording and shows a message. To stop earlier, click Stop.

## After the meeting

1. Wait for the final pass. The self-test ran 30 seconds of audio in 1.8 seconds. A one-hour meeting is not measured yet. The target is 10 minutes or less.
2. Check the speaker names. Names from the call show "Automatic (call app)". Click Play sample to hear a speaker.
3. Correct wrong names, merge split speakers, or move a single turn to another speaker.
4. Click a transcript turn to correct its text.
5. Export the meeting as Markdown, JSON, SRT, or VTT, or click Copy.

6. Read the summary above the notes. Check the facts, the names, and the action items against the transcript.

## Zoom and Microsoft Teams (beta)

Use the Zoom Workplace or the Microsoft Teams desktop app. Do the setup once:

1. In Tinta, open Settings. Under Calls, turn on "Get speaker names from Zoom and Microsoft Teams".
2. macOS asks for Accessibility access. Open System Settings, then Privacy & Security, then Accessibility, and turn on Tinta.
3. In Tinta, click Check again. The warning about Accessibility access goes away.

During the call:

1. Join the call in the app. Home shows "Zoom call detected" or "Microsoft Teams call detected", with the number of people.
2. Tell everyone in the call that you record and transcribe the meeting.
3. Click Record this call. The meeting view shows the participants that Tinta reads from the app.
4. Mute your microphone in the app and speak. The microphone meter shows "muted in Zoom" or "muted in Microsoft Teams". Unmute and check that your speech appears again.
5. If the participant count stays at zero, or names are wrong, open Settings and click "Save a report of the Zoom window" or "Save a report of the Microsoft Teams window" while the call is open. Read the file, remove private text, and send it to the Tinta team.
6. Leave the call. After about 5 seconds, Tinta stops the recording and shows a message.

After the call, check the speaker names as for Meet. For each call, also write down the app, the app version (in Zoom: zoom.us, About Zoom; in Teams: Settings, About Teams), and the language of the app.

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

1. Click "Import from Granola" on Home. Tinta finds `~/granola-export` automatically.
2. Check the number of meetings, and click Import.
3. Leave "Add the Granola AI summaries" off, unless you need them. Tinta marks imported summaries in the notes.
4. Open a few imported meetings. Check the notes, the transcript, and the speaker names.
5. Delete the export folder and empty the Trash in Finder. The export is not encrypted.

Imported meetings are in the folder "Granola" with the tag `granola`. Meetings that other people shared with you also have the tag `shared-with-me`. They have no audio and no timestamps. A second import skips the meetings that Tinta has already.

## Connect an MCP client

1. Open MCP in the sidebar, turn on MCP access, and copy the configuration.
2. Add it to Claude Desktop, or run the `claude mcp add` command from the MCP screen.
3. Keep the app open. The MCP server works only while the app runs.
4. On the MCP screen, you can undo each change that a client makes.
