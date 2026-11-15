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
  minTarget: 70,       // …but never below this
  maxTarget: 90,       // …or above this (before failure bumps)
  hardCap: 95,         // failure bumps never push the target past this
  failBump: 2,         // each failed attempt raises the target this much
  levelUpEvery: 3,     // every N failures, a longer phrase
  matchRatio: 1,       // every word in the displayed sentence must be recognized
  victoryMs: 3200,     // how long the victory screen shows
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
let difficulty = 0;
let calibrationSamples = null;
let ignoreMicUntil = 0; // don't count our own sound effects as screaming

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
  if (state === 'listening' && performance.now() > ignoreMicUntil) peak = Math.max(peak, level);

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
  renderPhrase(phrase.words.map(() => false));
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
  restartMessageCycle();

  // Restrict Vosk to just this phrase (plus its words, so partial hits still
  // count). "[unk]" soaks up everything else.
  const grammar = JSON.stringify([phrase.text, ...new Set(phrase.words), '[unk]']);
  recognizer = new model.KaldiRecognizer(audioCtx.sampleRate, grammar);
  const activeRecognizer = recognizer;
  recognizer.on('partialresult', (m) => {
    if (recognizer === activeRecognizer) onHeard(m.result.partial, false);
  });
  recognizer.on('result', (m) => {
    if (recognizer === activeRecognizer) onHeard(m.result.text, true);
  });

  peak = 0;
  renderPhrase(phrase.words.map(() => false));
  if (DEV) console.log('phrase:', phrase.text);
}

function onHeard(text, isFinal) {
  if (state !== 'listening' || !phrase) return;
  const heardWords = (text || '').split(/\s+/).filter((w) => w && w !== '[unk]');

  const hits = matchWords(heardWords, phrase.words);
  const ratio = hits.filter(Boolean).length / phrase.words.length;
  renderPhrase(hits);

  if (!isFinal) return;
  if (ratio >= CONFIG.matchRatio && peak >= target) return victory();

  // End of an utterance that didn't unlock.
  if (!heardWords.length) { peak = 0; return; } // just noise, not an attempt

  failures++;
  window.sendEvent?.({ type: 'fail', db: Math.round(peak), phrase: phrase.text }); // before newChallenge() swaps the phrase
  if (TEST_TARGET == null) target = Math.min(CONFIG.hardCap, target + CONFIG.failBump);
  playSadTrombone();
  if (failures % CONFIG.levelUpEvery === 0) difficulty++;
  newChallenge();
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
  window.sendEvent?.({ type: 'unlock', db: Math.round(peak), phrase: phrase?.text ?? null });
  clearInterval(messageTimer);
  document.body.classList.remove('is-listening');
  if (recognizer) { recognizer.remove(); recognizer = null; }
  if (phrase) renderPhrase(phrase.words.map(() => true));
  setStatus('');
  $('victory').setAttribute('aria-hidden', 'false');
  document.body.classList.add('is-victory');
  playFanfare();

  setTimeout(() => {
    state = 'idle';
    setInstruction('Unlocked. For now.');
    $('phrase').textContent = '';
    window.lockApi?.unlocked();
  }, CONFIG.victoryMs);
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
function tone(freq, start, dur, type = 'square', gain = 0.12, slideTo = null) {
  const t0 = audioCtx.currentTime + start;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.linearRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function playFanfare() {
  [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.25));
  tone(1047, 0.5, 0.8, 'square', 0.14);
}

function playSadTrombone() {
  ignoreMicUntil = performance.now() + 2200;
  [392, 370, 349].forEach((f, i) => tone(f, i * 0.32, 0.3, 'sawtooth', 0.08));
  tone(330, 0.96, 0.9, 'sawtooth', 0.08, 300);
}

// ---- Utils --------------------------------------------------------------------
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function median(arr) {
  if (!arr.length) return 40;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

init();
