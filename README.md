# Scream to Unlock 😱

A MacBook lock screen you can only get past by **screaming a random phrase** at it.
Whisper it? Denied. Scream gibberish? Denied. Scream *"my toaster is judging me"* at 85 dB? Access grudgingly granted.

Built at Stupid Ideas Hackathon Ottawa (Nov 15, 2026).

## How it works

- A full-screen Electron window covers everything (kiosk mode hides the Dock and menu bar and blocks Cmd+Tab and Force Quit).
- It measures the room for 2 seconds, then sets a loudness target above the background noise.
- It shows a random phrase, and an offline speech recognizer ([Vosk](https://alphacephei.com/vosk/), via `vosk-browser`) listens for *only* that phrase.
- Words light up as they're recognized. Unlock = at least 80% of the words heard **and** the peak loudness during them beat the target.
- Every failure raises the target, plays a sad trombone, and lands in the shame log. Every 3 failures, the phrase gets longer.
- It re-locks when the Mac wakes from sleep, or when you unlock the real macOS lock screen.

Everything runs offline. No API keys.

## Run it

```bash
npm install
npm run dev     # windowed, safe for working on the design; re-locks 2.5 s after each unlock
npm start       # the real thing: full-screen kiosk lock
```

The first launch asks for microphone access. Click **Allow**.

## Hotkeys

| Keys | What it does |
|---|---|
| **⌘ ⇧ ⌥ Q** | **Escape hatch.** Quits instantly. Memorize this before running `npm start`. |
| ⌘ ⇧ ⌥ L | Lock now (for demos) |
| ⌘ ⇧ ⌥ U | Force unlock with the victory screen (demo plan B if recognition fails on stage) |

## Tweaking

- **Phrases:** `app/phrases.js`. After editing, run `npm run check-phrases`. It flags any word the speech model doesn't know, since those can never be recognized.
- **Difficulty and loudness:** the `CONFIG` block at the top of `app/renderer.js`.
- **Look:** `app/style.css` (colours are variables at the top), `app/index.html`.
- **Roasts:** the `TOO_QUIET` / `WRONG_WORDS` / `VICTORY_LINES` lists in `app/renderer.js`.

## Files

```
main.js              Electron: kiosk window, hotkeys, local server, re-lock on wake
preload.js           bridge between the page and Electron
app/index.html       lock screen layout
app/style.css        styles
app/renderer.js      mic → loudness meter, Vosk → phrase matching → unlock
app/phrases.js       random phrase generator
app/model/           Vosk small English model (vosk-model-small-en-us-0.15)
scripts/             phrase checker + the model's vocabulary list
```

The "dB" shown is microphone level shifted to a 0–100 scale, not a calibrated sound meter. Nobody will check.
