# ScreamLock 😱

**The lock screen you unlock with your lungs.** A MacBook lock screen you can only get past by **screaming a random brain rot phrase** at it.
Whisper it? Denied. Scream gibberish? Denied. Scream *"tung tung tung sahur took my fanum tax"* at 90 dB? Access grudgingly granted.

Built at Stupid Ideas Hackathon Ottawa (Nov 15, 2026).

**📊 Live Daily Scream Report: https://chrisprogod.github.io/scream-to-unlock/**

## How it works

1. **It locks your screen.** A full-screen window covers everything on every desktop, stays on top of other apps (yes, including your browser), and blocks ⌘Q, ⌘Tab and Force Quit. Extra monitors get blocked too.
2. **It measures the room** for 2 seconds, then sets a loudness target of about **90** (90–92 depending on background noise).
3. **It shows a random phrase** like *"bro my rizz is in its villain era no cap"*. An offline speech recognizer ([Vosk](https://alphacephei.com/vosk/), via `vosk-browser`) listens for only that phrase.
4. **Words light up green** as they're recognized, with a rising pop for each one.
5. **To unlock, you need both:**
   - **The words.** Words count more the later they are in the phrase (first word 0.4, last word 1.0). You need 75% of the total, and the last word must be heard. Pausing for breath mid-phrase is fine.
   - **The volume, while saying the words.** Only stretches of speech that contained phrase words count. Saying it quietly and then screaming "AAAA" doesn't work.
6. **Fail** (wrong words, or right words too quietly) and you get a sad trombone, a robot voice roast ("skill issue", "right words, zero aura"), a new phrase, and a slightly higher target. Every 3 fails, the phrase gets longer.
7. **Win** and you get an air horn, "W rizz", and your rank among today's screamers.
8. It re-locks when the Mac wakes from sleep, or when you unlock the real macOS lock screen.

Speech recognition runs entirely on your laptop. **No audio is ever recorded or sent anywhere.**

## Live stats (Firebase)

Every laptop running the app sends small events (start / fail / unlock, with a random "Screamer #1234" name, the loudness and the phrase) to a shared Firebase Realtime Database:

- **On the lock screen:** a live panel with people screaming right now, unlocks and fails today, the loudest unlock, and a feed. A few fake "bot" screamers keep it lively. Bots only exist on each laptop and are never saved.
- **[Daily Scream Report](https://chrisprogod.github.io/scream-to-unlock/)** (`docs/index.html`): a public page of today's real screams with awards (🏆 Loudest Screamer, 🐌 Most Stubborn, ⚡ Fastest Unlock, 🤫 The Whisperer, 😤 Rage Quits, 💀 Hardest Phrase), a leaderboard and screams per hour. Days run midnight to midnight, Ottawa time.

No internet? The lock screen still works fully. Only the stats stop updating.

## Run it

You need [Node.js](https://nodejs.org) and a Mac.

```bash
git clone https://github.com/chrisprogod/scream-to-unlock.git
cd scream-to-unlock
npm install
npm run dev     # windowed, for working on it; re-locks 2.5 s after each unlock
npm start       # the real thing: full-screen lock
```

The first launch asks for microphone access. Click **Allow**. Turn your volume up for the sound effects.

## Hotkeys

| Keys | What it does |
|---|---|
| **⌘ ⇧ ⌥ Q** | **Escape hatch.** Quits instantly. Memorize this before running `npm start`. |
| ⌘ ⇧ ⌥ L | Lock now (for demos) |
| ⌘ ⇧ ⌥ U | Force unlock with the victory screen (plan B if recognition fails on stage) |

Plain ⌘Q doesn't work while locked, on purpose. If the escape hatch ever fails: `pkill -9 -f scream-to-unlock` from another terminal.

## Tweaking

- **Phrases:** `app/phrases.js`. After editing, run `npm run check-phrases`: any word the 2020 speech model doesn't know can never be recognized.
  - Slang the model doesn't know (rizz, skibidi, delulu…) goes in `SOUNDS_LIKE` with an in-vocabulary sound-alike (`rizz: 'riz'`). The screen shows the slang, the recognizer listens for the sound-alike.
- **Difficulty, loudness, sounds:** the `CONFIG` block at the top of `app/renderer.js` (`minTarget`, `matchScore`, `firstWordWeight`, `sounds`, `voice`…).
- **Testing quietly:** set `TEST_TARGET` near the top of `app/renderer.js` to a low number like 60. **Set it back to `null` before a demo.**
- **Roasts:** `FAIL_LINES`, `TOO_QUIET_LINES`, `WIN_LINES` and `NAG_LINES` in `app/renderer.js`.
- **Bots:** the `CONFIG` block at the top of `app/bots.js` (`enabled: false` for real users only).
- **Look:** `app/style.css`, `app/index.html`.

## Files

```
main.js               Electron: lock window, keeping it on top, hotkeys, local server, re-lock on wake
preload.js            bridge between the page and Electron
app/index.html        lock screen layout
app/style.css         styles
app/renderer.js       mic → loudness, Vosk → phrase matching → unlock; sounds and voice
app/phrases.js        random phrase generator + slang sound-alikes
app/stats.js          live stats panel
app/bots.js           fake screamers for the panel
app/firebase.js       sends events to / reads events from Firebase
app/assets/           images
app/model/            Vosk small English model (vosk-model-small-en-us-0.15)
docs/index.html       Daily Scream Report (GitHub Pages)
scripts/              phrase checker + the model's vocabulary list
```

## Notes

- The "dB" shown is microphone level on a 0–100 scale (100 = mic maxed out), not a calibrated sound meter. Nobody will check.
- The Firebase database is in test mode: anyone with the config can read and write, and access **expires on December 15, 2026**. Update the rules in the Firebase console to keep the stats working after that.
- Newer macOS versions don't let apps steal keyboard focus. If another app was active, it stays active *behind* the lock screen: you can't see or click it, but keystrokes may still reach it. Click the lock screen to take focus back.
