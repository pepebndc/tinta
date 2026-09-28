# Tinta landing page: shared brief

This brief is for the three landing page directions in `website/`. Each direction is one static single page. Each direction must be production ready.

## The product

Tinta is a free, open-source (Apache-2.0) macOS app for meeting notes. You write your notes, and Tinta makes a transcript with speaker names and a summary. Everything runs and stays on your Mac. It has no chat and no cloud AI.

- Tagline: "Meeting notes. On your Mac."
- Subline: "Write your notes, get a transcript with speaker names, and keep everything on your own computer."
- Repository: https://github.com/pepebndc/tinta (issues: https://github.com/pepebndc/tinta/issues)
- Current version: 0.3.1. Status: a pilot in active development. Expect bugs and changes. Say this honestly on the page.

The source of truth for all facts is `README.md` at the repository root. Read it. Do not invent features, numbers, or claims. Do not write "AI-powered" marketing language.

## Key features (the page must show all of them)

1. **Notes and transcript side by side.** Write notes while the draft transcript appears. Insert a timestamp with one click.
2. **Local transcription.** Parakeet v3 on the Apple Neural Engine. English, Spanish, and 23 other European languages (25 in total). Tinta detects the language.
3. **Speaker names.** Tinta separates the voices. On Google Meet, a small Chrome extension reads who speaks. In the Zoom and Microsoft Teams desktop apps, Tinta reads who speaks from the call window (beta). You can confirm, correct, merge, or split speakers.
4. **Next meetings.** Reads the calendars on your Mac, with no sign-in. A reminder 1 minute before each call. "Join and take notes" with one click.
5. **Call detection.** Detects calls in Google Meet, Zoom, and Microsoft Teams, offers to record them, and stops 3 seconds after you leave.
6. **Local summaries.** The Apple on-device model writes an overview, key points, decisions, and action items from your notes and the transcript. Needs macOS 26 and Apple Intelligence.
7. **Your library.** Search, folders, tags, and export to Markdown, JSON, SRT, and VTT.
8. **Trash.** Deleted meetings stay in the trash for 7 days.
9. **Import from Granola.** Notes, transcripts, and speaker names.
10. **MCP server.** Connect Claude or another MCP client to your meetings when you choose to. Every MCP change is recorded and can be undone. Claude Code: `claude mcp add tinta /Applications/Tinta.app/Contents/MacOS/tinta-mcp`

## Privacy (a core message)

- Transcription, speaker separation, and summaries run on your Mac. No server, no cloud service.
- After the one-time model download (about 500 MB), Tinta makes no network requests: no analytics, no crash reports, no update checks.
- SQLCipher encrypts the library. AES-GCM encrypts the audio. The key is in the macOS Keychain.
- By default, Tinta deletes the audio 7 days after a meeting (0 to 30 days in Settings).
- The Meet extension reads only participant names, who speaks, and the mute state. No captions, chat, or audio.
- Tinta does not tell other people in a call that you record. Always tell them. Put this on the page.

## Components (the "how it works" part)

App (Tauri 2 + React, owns the encrypted library), Engine (Swift, capture and speech models through FluidAudio), MCP server (`tinta-mcp`), Native host (Chrome Native Messaging), Chrome extension (Meet participants and active speakers). Speech models: Parakeet TDT 0.6B v3 (transcription), Silero VAD (voice activity), pyannote Community-1 (speaker separation). The models download at pinned revisions and each file is checked against its SHA-256 hash.

## Requirements

- A Mac with Apple Silicon (M1 or newer) and macOS 14.2 or later. 16 GB of memory is recommended.
- Google Chrome, for speaker names on Google Meet.
- The Zoom Workplace or Microsoft Teams desktop app, for Zoom or Teams calls.
- macOS 26 or later with Apple Intelligence, for summaries.
- About 1 GB of free disk space.

## Install (must be on the page, with copy buttons for commands)

Tinta has no signed download yet. Build it from source:

1. Install the Xcode Command Line Tools, Rust, Node.js 20 or later, and pnpm.
2. Clone the repository: `git clone https://github.com/pepebndc/tinta.git && cd tinta`
3. Run `./scripts/build.sh`.
4. Move `target/release/bundle/macos/Tinta.app` to your Applications folder.
5. Open Tinta. macOS blocks apps without Apple notarization. Open System Settings, then Privacy & Security, and click **Open Anyway**.
6. If macOS asks whether Tinta can use its key in the Keychain, click **Always Allow**.

Then the first-run setup guides you: your name, the speech models, the microphone, and the Chrome extension.

## Brand

Colors (light):

| Token | Value | Use |
|---|---|---|
| ink | `#292456` | Headings, primary buttons, the icon |
| paper | `#faf9f6` | Page background |
| accent | `#aaa4e8` | Lavender, small moments of focus |
| accent-strong | `#8174dc` | Links |
| soft | `#eeecf7` | Soft fills |
| muted | `#787586` | Secondary text |
| line | `#e5e2e9` | Borders |
| text | `#343141` | Body text |
| record | `#c2413b` | Recording state only. Never the accent. |

Dark: paper `#191824`, ink `#e7e3fc`, soft `#38324e`, muted `#aba6bc`, line `#393544`, panel `#24212f`, text `#ded9e8`, accent-strong `#b3aaf2`.

Speaker name colors (light / dark): `#5146b8`/`#aca4f6`, `#1c7466`/`#6fcdbd`, `#9c4a24`/`#f0a47d`, `#853b81`/`#df9bdb`, `#2c5f9f`/`#8fb7ee`, `#66651b`/`#cfcd78`.

Type: the app uses the system font stack (`-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif`). The wordmark "tinta" is a brush script. Use `wordmark.svg` (outlined paths, one `<path class="wm-letter">` per letter, `fill="currentColor"`). Never set the wordmark as live text.

The ink mark: a rounded square in ink with a paper-colored blot and a small drop. Paths (viewBox 0 0 100 100):

```
M24 19C38 8 59 10 69 22C80 36 64 46 55 57C48 65 47 82 32 82C15 82 8 66 9 49C9 36 14 27 24 19Z
M79 58C81 68 91 71 87 80C83 91 69 90 67 81C65 72 75 67 79 58Z
```

In the full icon (`icon.svg`), the rounded square is `rect x=100 y=100 width=824 height=824 rx=200` in a 1024 viewBox, and the mark is `translate(212 212) scale(6)`.

## Assets in `experiments/_shared/`

Copy the files that you use into `website/<your-direction>/assets/`. Each direction folder must work alone when a static host serves it as the site root.

- `wordmark.svg`, `icon.svg`, `favicon-32.png`, `apple-touch-icon.png`, `icon-512.png`, `og.png` (1200x630)
- Screenshots, 1440x900 and 960x600 WebP: `home-*.webp`, `meeting-*.webp`, `meeting-dark-*.webp`, `recording-*.webp`. Also `extension-popup.webp` (352x455).
  - home: Home with a Google Meet call, recent meetings, and next meetings from the calendar.
  - meeting: a meeting with a summary, notes on the left, and a transcript with speaker names on the right.
  - meeting-dark: the same in the dark appearance.
  - recording: a recording with level meters, notes, and a live draft transcript.
  - extension-popup: the Chrome extension popup with the call participants and the active speaker.

## Requirements for every direction

Structure and tech:
- One `index.html`, one `styles.css`, one `main.js` (optional), and `assets/`. No build step, no framework, no npm packages, no CDN.
- No external requests at all: no web fonts from Google, no analytics, no trackers. This matches the privacy message. Add a strict Content-Security-Policy `<meta>` (for example `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'`). No inline scripts or inline `style` attributes that the CSP blocks (SVG presentation attributes are fine).
- All content is in the HTML, not rendered by JS. The page works with JS off (the intro is skipped and all content shows).

The intro animation:
- The first impression is a short motion design intro that then opens up into the rest of the page.
- Every text in the intro stays on screen long enough to read comfortably. Hold each finished stage for at least 800 ms before the next stage starts. The total length can be up to about 8 seconds.
- A visible "Skip" control. Any key press, click, or scroll also ends it at once and jumps to the final state.
- `prefers-reduced-motion: reduce`: no intro, show the final state immediately.
- Play the full intro once per session (`sessionStorage`). On later loads in the same session, show the final state.
- Animate only `transform`, `opacity`, `clip-path`, and SVG stroke or mask properties. Keep 60 fps. No layout thrash.
- No flash of the final content before the intro starts (add a class on `<html>` from `main.js` in `<head>` with `defer` is too late; use a `<script src="intro-gate.js">` in the head without `defer`, which adds a class synchronously).

Page:
- Sections: hero, all key features, privacy, how it works (components), MCP, requirements, install, a short FAQ (optional), and a footer (license, GitHub, the pilot status, "Always tell people that you record", and the credit "Created by Pepe Blasco" with a link to https://github.com/pepebndc).
- A small sticky header with the logo, anchors, and a GitHub link. The primary call to action is "Install" (anchor to the install section) and "View on GitHub".
- Responsive from 360 px to 1920 px. Test at 390x844 and 1440x900.
- Accessibility: semantic landmarks, one `h1`, logical heading order, a skip link, visible focus, color contrast WCAG AA, `alt` text for every image, `aria-hidden` on decorative SVG, keyboard support for all controls.
- Performance: `width` and `height` on images, `loading="lazy"` below the fold, `srcset` with the 960 and 1440 WebP files, `decoding="async"`. The hero image (if any) is not lazy.
- SEO and sharing: `<title>`, meta description, canonical URL (`https://usetinta.com/`), Open Graph and Twitter tags with `assets/og.png`, `theme-color`, favicons, and a `robots.txt`-free setup is fine.
- Light and dark appearance support through `prefers-color-scheme` is recommended, unless the direction is dark by design.
- Scroll reveal animations for sections are fine, but keep them subtle, use `IntersectionObserver`, and turn them off for reduced motion.

Copy:
- Write all page copy in ASD-STE100 Simplified Technical English style, like the README: short sentences, active voice, present tense, simple words, one idea per sentence. No idioms or marketing hype.
- Never use the em dash character. Use colons, commas, or separate sentences.
- Do not name Apple, Google, Zoom, or Microsoft logos as images. Use text names only. Do not draw third-party logos.

Verification (do this before you finish):
- Serve the folder with `python3 -m http.server <port> -d website/<dir>` and take screenshots with headless Chrome: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1440,900 --virtual-time-budget=<ms> --screenshot=/tmp/<name>.png http://localhost:<port>/`. Use several `--virtual-time-budget` values (for example 300, 1200, 2500, 6000) to check the intro frames and the final state. Take a full-page final screenshot too (a tall window size, for example 1440x7000), and a mobile one at 390x844 and 390x6000.
- Read the screenshots and fix what looks wrong.
- Check the browser console for errors: `--enable-logging=stderr --v=0` or `--dump-dom`.
- Stop the server when you finish.
