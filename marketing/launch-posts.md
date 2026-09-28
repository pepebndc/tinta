# Launch posts

Video: `marketing/launch-video/tinta-launch.mp4` (landscape) for X. `tinta-launch-vertical.mp4` for LinkedIn.

## X thread

### 1 (with the landscape video)

I built Tinta: meeting notes that stay on your Mac.

You write the notes. Tinta writes the transcript, names each speaker, and writes a summary. All of it runs on your Mac.

No cloud. No bot in the call. Free and open source.

🧵

### 2

The transcription runs on the Apple Neural Engine with Parakeet v3.

It supports 25 languages: English, Spanish, and 23 other European languages. Tinta detects the language.

### 3

Tinta separates the voices and names each speaker.

On Google Meet, a small Chrome extension reads who speaks. In the Zoom and Teams apps, Tinta reads the call window (beta).

After the call, you can correct, merge, or split speakers.

### 4

After the call, the Apple on-device model writes the summary: an overview, key points, decisions, and action items.

No server. Not even Private Cloud Compute.

(Summaries need macOS 26 and Apple Intelligence.)

### 5

Tinta downloads the speech models once. After that, it makes no network requests: no analytics, no crash reports, no update checks.

SQLCipher encrypts the library. AES-GCM encrypts the audio. The key stays in your Keychain.

### 6

Tinta reads the calendars on your Mac, with no sign-in. It detects calls in Meet, Zoom, and Teams, and it stops the recording when you leave.

Coming from Granola? Import your export with the notes, transcripts, and speaker names.

### 7

Want AI on top of your meetings? Connect Claude or another MCP client.

The access is local, and you turn it on. Tinta records every change that a client makes, so you can undo it.

### 8

Tinta is a pilot. It needs Apple Silicon and macOS 14.2 or later. Today you build it from source.

Try it, and tell me what breaks.

https://usetinta.com
https://github.com/pepebndc/tinta

## LinkedIn post (with the vertical video)

I built a meeting notes app that never sends your meetings to the cloud.

Most AI note takers upload every call to a server. For many teams, that is a problem: client calls, hiring interviews, legal and security discussions. So I built Tinta, a Mac app that does all the work on the computer.

How it works:
→ You write your own notes during the call. Tinta writes the full transcript next to them.
→ Tinta names each speaker. On Google Meet, a small Chrome extension reads who speaks. In the Zoom and Teams apps, Tinta reads the call window (beta).
→ After the call, the Apple on-device model writes a summary with key points, decisions, and action items.
→ Tinta reads your Mac calendars, detects calls in Meet, Zoom, and Teams, and stops when you leave.

What stays private:
→ The transcription runs on the Apple Neural Engine. It supports 25 languages.
→ After the one-time model download, Tinta makes no network requests. No analytics, no crash reports, no update checks.
→ The library and the audio are encrypted, and the key stays in your macOS Keychain.
→ No bot joins the call. Always tell the other people that you record.

If you want AI on top of your meetings, you can connect Claude or another MCP client. The access is local, you turn it on, and you can undo every change.

Tinta is free and open source (Apache 2.0). It is a pilot: it needs a Mac with Apple Silicon, and today you build it from source.

I want feedback from people who take a lot of meetings. Try it and tell me what works and what breaks.

https://usetinta.com

#privacy #macos #opensource #productivity
