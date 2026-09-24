# Tinta for Meet

This Chrome extension sends Google Meet metadata to the Tinta app on the same computer.
The app uses the metadata to suggest names for speaker labels.
The extension sends the metadata through Chrome Native Messaging to the host `app.tinta`.

## What the extension reads

The extension runs only on `https://meet.google.com/*`.
It reads these items:

- The meeting code from the URL path, for example `abc-defg-hij`.
- The meeting title on the page. If the page does not show a title, it uses `document.title` without the `Meet - ` prefix.
- The participant list: the participant ID, the display name, and a flag for the local user.
- The set of participants that speak.
- The mute state of your microphone, from the `data-is-muted` attribute of the Meet microphone button.
- The `tinta-debug` key in the page `localStorage`.

## What the extension does not read or do

- It does not read captions, chat, or other page content.
- It does not capture audio or video.
- It does not make network requests. It does not load remote code. It does not collect analytics.
- It does not use the `tabs`, `storage`, or host permissions.

## Permissions

- `nativeMessaging`: the service worker connects to the app.
- The content script match `https://meet.google.com/*`.

## Limits on untrusted input

The extension treats the Meet page as untrusted input.
It removes control characters from each string and cuts each string to 200 characters.
It sends a maximum of 100 participants.

## How the detection works

The content script finds participant tiles by the `data-participant-id` attribute.
It finds names in the `data-self-name` and `data-name` attributes, then in short text in the tile.
The People panel gives better names when it is open.
It marks the local user from the `(You)` marker and similar markers, or from `data-self-name` outside a tile.

Meet animates the voice-level indicator only while a participant speaks.
The content script counts `class` and `style` changes in each tile, except in `video` and `canvas` elements.
A tile with 3 or more changes in 400 ms is above the threshold.
Speaking starts after 2 consecutive windows above the threshold.
Speaking ends after 800 ms below the threshold.
A speaking `aria-label` or tooltip in the tile also counts as a window above the threshold.
The `CONFIG` object at the top of `content.js` contains all selectors and thresholds.

The content script ignores tiles that show "Presentation" or "presenting".
Detection runs only when the URL has a meeting code and the page shows at least one tile.
The call ends when no tile is present for 3 seconds, when the meeting code changes, or when the page or the tab closes.

The microphone button in the Meet toolbar has a `data-is-muted` attribute and a label that names the microphone.
A mutation observer reports each change of this attribute at once. The extension also checks the state every 200 ms, and it reads only a visible button.
While Tinta records the call, the app silences your microphone track for each muted interval.

## Speaker highlight

The popup switch highlights the detected speakers on the Meet page.
Meet shows a small circle with animated bars in the corner of the tile of a speaker.
The extension finds this circle from the elements that animate, and draws a lavender ring around it.
If a tile has no circle, the extension draws a soft lavender frame inside the tile.

## Load the extension unpacked

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this `extension` directory.
5. Make sure that the extension ID is the same as the ID in `EXTENSION_ID.txt`.

The `key` value in `manifest.json` sets the extension ID.
The private key is in `keys/extension-key.pem` at the root of the repository, outside this folder. Chrome warns when an unpacked extension contains a key file. Do not commit the key. The root `.gitignore` file excludes the `keys` folder.

## Popup

Click the Tinta icon in the Chrome toolbar. The popup shows:

- The connection to the Tinta app: connected, not running, or not installed.
- The recording state and its time, when Tinta records.
- The Meet call in the current tab: the title, the number of people, and the participant list. The people that the extension detects as speaking are at the top, with a lavender highlight.
- The mute state of your microphone in Meet.
- A switch that highlights the detected speakers on the Meet page. Use it to check the detection during a call.

The action badge shows `REC` on a red background while Tinta records, and `II` while the recording is paused.

## Debug mode

The popup switch turns the speaker highlight on and off for the current tab.
To also log each change of speakers to the console:

1. Open a Meet page.
2. Open the Chrome developer tools console.
3. Run `localStorage.setItem("tinta-debug", "1")`.
4. Reload the page.

To turn off debug mode, run `localStorage.removeItem("tinta-debug")` and reload the page.

## Message formats

The content script sends JSON messages to the service worker.
The service worker sends them to the native host without changes.
The `t` value is the `Date.now()` time in epoch milliseconds from the content script.

`meet_state`: the extension sends this message when the user joins, when the participant list or title changes, and every 10 seconds.

`mic_muted` is true, false, or null when the page does not show the microphone button.

```json
{"type":"meet_state","meeting_code":"abc-defg-hij","title":"Weekly sync","t":1758625200000,"self_name":"Alice","participants":[{"id":"spaces/x/devices/1","name":"Alice","is_self":true}],"mic_muted":false}
```

`mic_state`: the extension sends this message when your microphone is muted or unmuted in Meet.

```json
{"type":"mic_state","meeting_code":"abc-defg-hij","t":1758625200000,"muted":true}
```

`active_speakers`: the extension sends this message when the set of speakers changes, and every 5 seconds.
The `speaking` array can be empty.

```json
{"type":"active_speakers","meeting_code":"abc-defg-hij","t":1758625200000,"speaking":["spaces/x/devices/1"]}
```

`meeting_ended`: the extension sends this message when the user leaves the call, or when the page or the tab closes.
`left_at` is the time the user left. When the tiles disappear, it is the time of the last tile, 3 seconds before the message.

```json
{"type":"meeting_ended","meeting_code":"abc-defg-hij","t":1758625203000,"left_at":1758625200000}
```

While the popup is open, the service worker sends this message every second, so that the popup shows the current app state:

```json
{"type":"ping","t":1758625200000}
```

The native host answers each message with the app state. `app` is false when the Tinta app does not answer. `recording_since` is the start time of the current recording, or null.

```json
{"type":"status","app":true,"recording":true,"recording_since":1758625200000}
```

## Native host connection

The service worker connects to the native host when it starts.
If the connection fails, it tries again with a longer delay each time, to a maximum of 30 seconds.
If the host is not installed, it tries again every 30 seconds and does not show an error.

## Tests

Run the tests for the speaking logic in `speaking.js`:

```sh
node --test test/speaking.test.mjs
```
