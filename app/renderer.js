// Scream to Unlock — lock screen logic.
//
// mic ─┬─► AnalyserNode ──► loudness (fake "dB", 0–100) ──► meter
//      └─► Vosk recognizer (grammar = the current phrase) ──► words heard
//
// Unlock only after a completed utterance contains the sentence and its
// peak loudness reaches the target. Volume alone never unlocks.

// ---- TESTING ------------------------------------------------------------------
// Set to a number (e.g. 65) to force a fixed, easy loudness target so you can
// test by talking normally. Same 0–100 scale as the on-screen "dB" number —
// watch it while you talk to pick a value. Failures won't raise it.
// Set back to null for the real thing (calibrates to the room).
const TEST_TARGET = null;

// ---- Tuning knobs -----------------------------------------------------------
const CONFIG = {
  modelUrl: new URL('model/model.tar.gz', location.href).href,
  calibrationMs: 2000, // how long to listen to the room before each lock
  aboveAmbient: 25,    // target = room noise + this…
  minTarget: 90,       // …but never below this (≈ a real scream)
  maxTarget: 92,       // …or above this, so a loud room can't make it impossible
  hardCap: 94,         // failure bumps never push the target past this (100 = mic maxed out)
  failBump: 1,         // each failed attempt raises the target this much
  levelUpEvery: 3,     // every N failures, a longer phrase
  // A phrase counts as said when the heard words are worth at least
  // `matchScore` of the phrase. Words are weighted by position: the first word
  // is worth `firstWordWeight`, rising evenly to 1.0 for the last word, so
  // missing early words is cheap and missing middle/end words is expensive.
  matchScore: 0.75,
  firstWordWeight: 0.4,
  requireLastWord: true, // the last word must always be heard
  failGraceMs: 1500,   // after you stop talking, wait this long before calling it a fail
                       // (Vosk splits a scream into pieces when you pause for breath)
  victoryMs: 3200,     // how long the victory screen shows
  sounds: true,        // sound effects on/off
  voice: true,         // spoken roasts (macOS text-to-speech) on/off
  nagAfterMs: 12000,   // roast you if you haven't screamed for this long
};

const DEV = new URLSearchParams(location.search).has('dev');
const $ = (id) => document.getElementById(id);

// ---- State --------------------------------------------------------------------
let model = null;
let recognizer = null;
let audioCtx = null;
let analyser = null;
let sampleBuf = null;

let state = 'loading'; // loading | idle | calibrating | listening | victory
let ready = false;
let lockRequested = false;

let level = 0;    // instant loudness 0–100
let shown = 0;    // smoothed loudness for the meter
let peak = 0;     // loudest moment of the current utterance
let target = 80;
let phrase = null;
let failures = 0;
let heardSoFar = []; // words from earlier pieces of the current attempt
let failTimer = null;
let difficulty = 0;
let calibrationSamples = null;
let ignoreMicUntil = 0; // don't count our own sound effects as screaming
let lastHitCount = 0;    // words lit up so far (for the pop sound)
let segmentPeak = 0;     // loudest moment of the current stretch of speech
let wordPeak = 0;        // loudest stretch of speech that contained phrase words
let attemptDb = 0;       // the loudness that counted for this attempt (for stats)
let wasOverTarget = false;
let lastActivityAt = 0;  // last time you made noise or said a word (for nagging)

// ---- Startup --------------------------------------------------------------------
async function init() {
  phrase = Phrases.generate(0);
  renderPhrase(phrase.words.map(() => false));
  if (DEV) $('devHint').hidden = false;

  window.lockApi?.onLock(() => { lockRequested = true; if (ready) startLock(); });
  window.lockApi?.onForceUnlock(() => {
    if (state === 'listening' || state === 'calibrating') { peak = Math.max(peak, target); victory(); }
  });
  window.lockApi?.ready();

  try {
    await startMic();
  } catch (err) {
    console.error(err);
    fatal("I can't hear you. Literally.", 'Microphone blocked. Allow it in System Settings → Privacy & Security → Microphone. ⌘⇧⌥Q quits.');
    return;
  }

  setInstruction('Loading ears…');
  try {
    model = await Vosk.createModel(CONFIG.modelUrl);
  } catch (err) {
    console.error(err);
    fatal('My ears failed to load.', String(err && err.message || err) + ' · ⌘⇧⌥Q quits.');
    return;
  }

  ready = true;
  document.body.classList.remove('is-loading');
  setInstruction('Waiting…');
  if (lockRequested || !window.lockApi) startLock(); // no lockApi = opened in a plain browser
}

async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: false,
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false, // AGC would flatten screams — we want honest loudness
    },
  });

  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  sampleBuf = new Float32Array(analyser.fftSize);
  source.connect(analyser);

  // Feeds raw audio to Vosk. (ScriptProcessor is deprecated but it's what
  // vosk-browser expects, and it's fine for a hackathon.)
  const proc = audioCtx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => {
    if (recognizer && state === 'listening' && performance.now() > ignoreMicUntil) {
      try { recognizer.acceptWaveform(e.inputBuffer); }
      catch (err) { console.error('acceptWaveform failed', err); }
    }
  };
  source.connect(proc);
  proc.connect(audioCtx.destination); // required for onaudioprocess to fire; outputs silence

  requestAnimationFrame(tick);
}

// ---- Loudness loop ----------------------------------------------------------------
function tick() {
  analyser.getFloatTimeDomainData(sampleBuf);
  let sum = 0;
  for (let i = 0; i < sampleBuf.length; i++) sum += sampleBuf[i] * sampleBuf[i];
  const rms = Math.sqrt(sum / sampleBuf.length);
  // dBFS (-100…0) shifted to a friendlier 0…100 "dB" scale. Not real SPL. Nobody will check.
  level = clamp(20 * Math.log10(rms || 1e-8) + 100, 0, 100);
  shown = level > shown ? level : shown * 0.9 + level * 0.1; // fast attack, slow release

  if (state === 'calibrating') calibrationSamples.push(level);
  if (state === 'listening' && performance.now() > ignoreMicUntil) {
    peak = Math.max(peak, level);
    segmentPeak = Math.max(segmentPeak, level);
    if (level > target - 25) lastActivityAt = performance.now();
    const over = shown >= target;
    if (over && !wasOverTarget) playDing(); // you just got loud enough
    wasOverTarget = over;
  }

  renderMeter();
  requestAnimationFrame(tick);
}

const PROGRESS_MESSAGES = [
  'not even close',
  'eh ur quiet on da creek still',
  'mmmmm not quite my tempo',
  'ok its not too bad not good enough',
  'ahhh almost almost',
  'YOUR JUS A LIL TOO LOW PLS',
];
let messageTimer = null;
let messageIndex = -1;
let catStage = 0;

function randomizeMessage() {
  // Select a different message each time, independent of microphone volume.
  const offset = 1 + Math.floor(Math.random() * (PROGRESS_MESSAGES.length - 1));
  messageIndex = messageIndex < 0
    ? Math.floor(Math.random() * PROGRESS_MESSAGES.length)
    : (messageIndex + offset) % PROGRESS_MESSAGES.length;
  $('progress').textContent = PROGRESS_MESSAGES[messageIndex];
}

function restartMessageCycle() {
  clearInterval(messageTimer);
  randomizeMessage();
  messageTimer = setInterval(() => {
    if (state === 'listening') randomizeMessage();
  }, 20000);
}

function renderMeter() {
  $('levelNow').textContent = Math.round(shown);
  $('levelTarget').textContent = Math.round(target);
  $('levelPeak').textContent = Math.round(peak);
  const percent = clamp(shown / target * 100, 0, 100);
  $('meterFill').style.width = `${percent}%`;
  $('meter').setAttribute('aria-valuenow', Math.round(percent));
  // Discrete poses and tint levels with hysteresis prevent jitter and ghosting.
  const boundaries = [35, 65, 85];
  while (catStage < 3 && percent >= boundaries[catStage] + 4) catStage++;
  while (catStage > 0 && percent < boundaries[catStage - 1] - 4) catStage--;
  $('cat').setAttribute('data-stage', catStage);
  $('catGreen').setAttribute('exponent', 1 + catStage);
  $('catBlue').setAttribute('exponent', 1 + catStage * 1.3);
}

// ---- Lock flow ----------------------------------------------------------------
async function startLock() {
  lockRequested = false;
  failures = 0;
  difficulty = 0;
  setStatus('');
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  // Measure the room so a noisy hackathon doesn't unlock it for you.
  state = 'calibrating';
  document.body.classList.remove('is-listening', 'is-victory');
  $('victory').setAttribute('aria-hidden', 'true');
  setInstruction('Shhh… measuring how quiet you are');
  phrase = Phrases.generate(difficulty);
  // Don't show the phrase yet: words screamed during calibration aren't heard.
  $('phrase').textContent = 'get ready…';
  calibrationSamples = [];
  await sleep(CONFIG.calibrationMs);
  if (state !== 'calibrating') return; // force-unlocked mid-calibration

  const ambient = median(calibrationSamples);
  target = TEST_TARGET ?? clamp(ambient + CONFIG.aboveAmbient, CONFIG.minTarget, CONFIG.maxTarget);
  console.log(`ambient ${ambient.toFixed(1)} dB → target ${target.toFixed(1)} dB`);

  state = 'listening';
  document.body.classList.add('is-listening');
  setInstruction('Scream this to unlock');
  newChallenge(true);
  window.sendEvent?.({ type: 'start', phrase: phrase.text });
}

function newChallenge(keepPhrase = false) {
  if (recognizer) { recognizer.remove(); recognizer = null; }
  if (!keepPhrase) phrase = Phrases.generate(difficulty);
  heardSoFar = [];
  clearTimeout(failTimer);
  failTimer = null;
  restartMessageCycle();

  // Restrict Vosk to just this phrase (plus its words, so partial hits still
  // count). "[unk]" soaks up everything else.
  // Listen for the SPOKEN form (slang like "rizz" is swapped for a sound-alike
  // the model knows, e.g. "riz"; see SOUNDS_LIKE in phrases.js).
  const grammar = JSON.stringify([phrase.spokenText, ...new Set(phrase.spokenWords), '[unk]']);
  recognizer = new model.KaldiRecognizer(audioCtx.sampleRate, grammar);
  const activeRecognizer = recognizer;
  recognizer.on('partialresult', (m) => {
    if (recognizer === activeRecognizer) onHeard(m.result.partial, false);
  });
  recognizer.on('result', (m) => {
    if (recognizer === activeRecognizer) onHeard(m.result.text, true);
  });

  peak = 0;
  lastHitCount = 0;
  segmentPeak = 0;
  wordPeak = 0;
  lastActivityAt = performance.now();
  renderPhrase(phrase.words.map(() => false));
  playBoom(); // new phrase!
  if (DEV) console.log('phrase:', phrase.text);
}

function onHeard(text, isFinal) {
  if (state !== 'listening' || !phrase) return;
  // Translate sound-alikes back to the words on screen ("riz" → "rizz").
  const words = Phrases.toDisplay((text || '').split(/\s+/).filter((w) => w && w !== '[unk]'), phrase.words);

  // Still talking? Then it's not over yet: cancel any pending fail.
  if (words.length) { clearTimeout(failTimer); failTimer = null; }

  // Judge EVERYTHING heard in this attempt, not just the latest piece, so the
  // first words still count after a pause.
  const combined = [...heardSoFar, ...words];
  const result = matchPhrase(combined, phrase.words);
  renderPhrase(result.hits);
  const hitCount = result.hits.filter(Boolean).length;
  if (hitCount > lastHitCount) playPop(hitCount); // a word just lit up
  lastHitCount = hitCount;
  if (words.length) lastActivityAt = performance.now();

  // Loudness only counts while phrase words are being said: the loudest
  // stretch of speech that contained words. Screaming with no words (e.g.
  // after saying the phrase quietly) doesn't help.
  attemptDb = Math.max(wordPeak, words.length ? segmentPeak : 0);
  if (result.passes && attemptDb >= target) return victory();
  if (!isFinal) return;

  // A stretch of speech just ended.
  if (words.length) wordPeak = Math.max(wordPeak, segmentPeak);
  segmentPeak = 0;
  if (!words.length) return; // just noise, not an attempt

  heardSoFar = combined.slice(-40);

  // Said the phrase, but not loud enough: that's an attempt, and it failed.
  if (result.passes) return failAttempt('quiet');

  // Not enough of the phrase yet. Give the rest a moment to arrive (you may
  // have paused for breath) before calling it a fail.
  failTimer = setTimeout(() => failAttempt('words'), CONFIG.failGraceMs);
}

function failAttempt(reason = 'words') {
  clearTimeout(failTimer);
  failTimer = null;
  if (state !== 'listening') return;
  failures++;
  attemptDb = Math.max(wordPeak, segmentPeak);
  window.sendEvent?.({ type: 'fail', db: Math.round(attemptDb), phrase: phrase.text }); // before newChallenge() swaps the phrase
  if (TEST_TARGET == null) target = Math.min(CONFIG.hardCap, target + CONFIG.failBump);
  playSadTrombone();
  setTimeout(() => say(pick(reason === 'quiet' ? TOO_QUIET_LINES : FAIL_LINES)), 1900);
  if (failures % CONFIG.levelUpEvery === 0) difficulty++;
  newChallenge();
}

// Decide whether the heard words count as saying the phrase.
// Matches from the front AND from the back (the end of a phrase is often
// heard clearly when the start got lost) and keeps whichever scores better.
function matchPhrase(heard, targetWords) {
  const n = targetWords.length;
  const weights = targetWords.map((_, i) =>
    n === 1 ? 1 : CONFIG.firstWordWeight + (1 - CONFIG.firstWordWeight) * (i / (n - 1)));
  const total = weights.reduce((a, b) => a + b, 0);
  const score = (hits) => hits.reduce((sum, hit, i) => sum + (hit ? weights[i] : 0), 0) / total;

  const forward = matchWords(heard, targetWords);
  const backward = matchWords([...heard].reverse(), [...targetWords].reverse()).reverse();
  const hits = score(backward) >= score(forward) ? backward : forward;

  const lastOk = !CONFIG.requireLastWord || hits[n - 1];
  return { hits, score: score(hits), passes: lastOk && score(hits) >= CONFIG.matchScore };
}

// In-order matching: each heard word claims the next matching target word.
function matchWords(heard, targetWords) {
  const hits = targetWords.map(() => false);
  let j = 0;
  for (const w of heard) {
    let k = j;
    while (k < targetWords.length && targetWords[k] !== w) k++;
    if (k < targetWords.length) { hits[k] = true; j = k + 1; }
  }
  return hits;
}

function victory() {
  if (state === 'victory') return;
  state = 'victory';
  window.sendEvent?.({ type: 'unlock', db: Math.round(attemptDb || peak), phrase: phrase?.text ?? null });
  clearInterval(messageTimer);
  document.body.classList.remove('is-listening');
  if (recognizer) { recognizer.remove(); recognizer = null; }
  if (phrase) renderPhrase(phrase.words.map(() => true));
  setStatus('');
  $('victoryRank').textContent = rankLine(Math.round(attemptDb || peak));
  $('victory').setAttribute('aria-hidden', 'false');
  document.body.classList.add('is-victory');
  playAirhorn();
  setTimeout(playFanfare, 1100);
  setTimeout(() => say(pick(WIN_LINES)), 300);

  setTimeout(() => {
    state = 'idle';
    setInstruction('Unlocked. For now.');
    $('phrase').textContent = '';
    window.lockApi?.unlocked();
  }, CONFIG.victoryMs);
}

// "91 dB · #2 loudest of 3 screamers today" (real screamers only).
function rankLine(db) {
  const r = window.getTodayRank?.(db);
  if (!r) return `${db} dB`;
  if (r.total === 1) return `${db} dB · the only real screamer today. #1 by default.`;
  const suffix = r.best > db ? ` (your best today: ${r.best} dB)` : '';
  return `${db} dB · #${r.rank} loudest of ${r.total} screamers today${suffix}`;
}

// ---- Rendering helpers ------------------------------------------------------------
function renderPhrase(hits) {
  const el = $('phrase');
  el.replaceChildren(...phrase.words.map((w, i) => {
    const span = document.createElement('span');
    span.className = 'word' + (hits[i] ? ' hit' : '');
    span.textContent = w;
    return span;
  }));
}

function setInstruction(t) { $('instruction').textContent = t; }
function setStatus(t, kind) { const el = $('status'); el.textContent = t; el.className = 'status' + (kind ? ` ${kind}` : ''); }

function fatal(title, detail) {
  document.body.classList.remove('is-loading');
  setInstruction(title);
  setStatus(detail, 'bad');
}

// ---- Sounds (generated, no audio files needed) ---------------------------------------
const FAIL_LINES = [
  'skill issue', 'bro is cooked', 'L rizz', 'negative aura', 'that was not bussin',
  'chat, is this real?', 'that was mid', 'six seven', 'unc behavior', 'erm, what the sigma',
];
const TOO_QUIET_LINES = [
  'I heard you. I just do not believe you', 'right words, zero aura', 'louder, unc',
  'was that a scream or a whisper?', 'say it like you mean it, bro', 'the rizz is there, the volume is not',
];
const WIN_LINES = [
  'W rizz', 'plus one thousand aura', 'you ate', 'no cap, that was bussin',
  'sigma behavior', 'the rizzler has arrived',
];
const NAG_LINES = [
  'chat, is this guy gonna scream?', 'hello? anybody home?', 'bro is mewing instead of screaming',
  'I can hear you breathing', 'scream or touch grass', 'any day now, unc',
];

// Stop listening to the mic for a while, so our own sounds and voice don't
// count as screaming or as words.
function quietMic(ms) {
  ignoreMicUntil = Math.max(ignoreMicUntil, performance.now() + ms);
}

function tone(freq, start, dur, type = 'square', gain = 0.12, slideTo = null) {
  if (!CONFIG.sounds) return;
  const t0 = audioCtx.currentTime + start;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

// A note that holds steady, then cuts off (for the air horn).
function held(freq, start, dur, type, gain) {
  if (!CONFIG.sounds) return;
  const t0 = audioCtx.currentTime + start;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.setValueAtTime(gain, t0 + dur - 0.04);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

// A burst of filtered noise (the "thwack" in the boom).
function noise(start, dur, gain, cutoff) {
  if (!CONFIG.sounds) return;
  const t0 = audioCtx.currentTime + start;
  const buffer = audioCtx.createBuffer(1, Math.ceil(audioCtx.sampleRate * dur), audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(audioCtx.destination);
  src.start(t0);
}

// Deep dramatic boom: a new phrase appears.
function playBoom() {
  quietMic(700);
  tone(160, 0, 1.0, 'sine', 0.7, 35);
  tone(80, 0, 1.0, 'triangle', 0.4, 30);
  noise(0, 0.3, 0.3, 500);
}

// Rising pop: a word just lit up green (gets higher with every word).
// Doesn't mute the mic: you're mid-scream.
function playPop(n) {
  tone(480 + n * 60, 0, 0.1, 'sine', 0.2, 720 + n * 60);
}

// Bright ding: you just got loud enough.
function playDing() {
  tone(1568, 0, 0.5, 'sine', 0.12);
  tone(2349, 0.04, 0.4, 'sine', 0.06);
}

// Air horn: BWAA BWAA BWAAAAA.
function playAirhorn() {
  quietMic(2000);
  for (const [start, dur] of [[0, 0.16], [0.22, 0.16], [0.44, 0.7]]) {
    for (const f of [466, 471, 699]) held(f, start, dur, 'sawtooth', 0.06);
  }
}

function playFanfare() {
  [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.25));
  tone(1047, 0.5, 0.8, 'square', 0.14);
}

function playSadTrombone() {
  quietMic(2200);
  [392, 370, 349].forEach((f, i) => tone(f, i * 0.32, 0.3, 'sawtooth', 0.08));
  tone(330, 0.96, 0.9, 'sawtooth', 0.08, 300);
}

// Spoken roast via macOS text-to-speech. The mic is muted while it talks.
function say(text) {
  if (!CONFIG.voice || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find((v) => v.name === 'Fred') || voices.find((v) => v.lang === 'en-US') || null;
  u.rate = 0.85;   // a bit slower than normal (1 = normal speed)
  u.volume = 1;    // maximum (text-to-speech can't go louder than your Mac's volume)
  quietMic(800 + (text.length * 90) / u.rate); // estimate, in case 'end' never fires
  u.onend = () => { ignoreMicUntil = Math.min(ignoreMicUntil, performance.now() + 300); };
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// Haven't screamed in a while? Get roasted.
setInterval(() => {
  if (state !== 'listening' || performance.now() < ignoreMicUntil) return;
  if (performance.now() - lastActivityAt > CONFIG.nagAfterMs) {
    lastActivityAt = performance.now();
    say(pick(NAG_LINES));
  }
}, 1000);

// ---- Utils --------------------------------------------------------------------
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function median(arr) {
  if (!arr.length) return 40;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

init();
