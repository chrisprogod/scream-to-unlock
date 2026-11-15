// Scream to Unlock — lock screen logic.
//
// mic ─┬─► AnalyserNode ──► loudness (fake "dB", 0–100) ──► meter
//      └─► Vosk recognizer (grammar = the current phrase) ──► words heard
//
// Unlock when ≥ CONFIG.matchRatio of the phrase's words are heard AND the
// peak loudness during that utterance beat the target.

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
  matchRatio: 0.8,     // fraction of words that must be heard (screaming garbles words)
  victoryMs: 3200,     // how long the victory screen shows
};

const DEV = new URLSearchParams(location.search).has('dev');
const $ = (id) => document.getElementById(id);

// ---- Roasts -----------------------------------------------------------------
const TOO_QUIET = [
  "I heard you. I just don't BELIEVE you.",
  'Correct words. Pathetic volume.',
  'Your neighbours can\'t hear you yet.',
  'Was that a scream or a yawn?',
  'Say it like you mean it.',
  'Louder. The pigeons outside need to know.',
];
const WRONG_WORDS = [
  "That's not what I asked you to scream.",
  'Wrong. Read it again. Slowly. LOUDLY.',
  'I asked for one thing.',
  'Impressive volume. Zero reading comprehension.',
  'Are you even trying?',
];
const VICTORY_LINES = [
  'Your neighbours have been notified.',
  'A noise complaint has been filed on your behalf.',
  'Somewhere, a dog is barking back.',
  'Your throat will remember this.',
];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

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
let shame = [];
let calibrationSamples = null;
let ignoreMicUntil = 0; // don't count our own sound effects as screaming

// ---- Startup --------------------------------------------------------------------
async function init() {
  if (DEV) $('devHint').hidden = false;
  startClock();

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
    if (recognizer && state === 'listening') {
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

function renderMeter() {
  const fill = $('meterFill');
  fill.style.width = `${shown}%`;
  fill.classList.toggle('over', shown >= target);
  $('meterTarget').style.left = `${target}%`;
  $('levelNow').textContent = Math.round(shown);
  $('levelTarget').textContent = Math.round(target);
  $('levelPeak').textContent = Math.round(peak);

  const face = shown >= target ? '😱' : shown >= target - 12 ? '😮' : shown >= target - 30 ? '😐' : '😴';
  $('face').textContent = state === 'victory' ? '🥳' : face;

  // Shake the card in proportion to loudness.
  const s = state === 'listening' ? Math.max(0, shown - (target - 20)) / 4 : 0;
  document.body.style.setProperty('--shake-x', `${(Math.random() - 0.5) * s}px`);
  document.body.style.setProperty('--shake-y', `${(Math.random() - 0.5) * s}px`);
}

// ---- Lock flow ----------------------------------------------------------------
async function startLock() {
  lockRequested = false;
  failures = 0;
  difficulty = 0;
  shame = [];
  renderShame();
  setStatus('');
  $('heard').textContent = '';
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  // Measure the room so a noisy hackathon doesn't unlock it for you.
  state = 'calibrating';
  document.body.classList.remove('is-listening');
  setInstruction('Shhh… measuring how quiet you are');
  $('phrase').textContent = '';
  calibrationSamples = [];
  await sleep(CONFIG.calibrationMs);
  if (state !== 'calibrating') return; // force-unlocked mid-calibration

  const ambient = median(calibrationSamples);
  target = TEST_TARGET ?? clamp(ambient + CONFIG.aboveAmbient, CONFIG.minTarget, CONFIG.maxTarget);
  console.log(`ambient ${ambient.toFixed(1)} dB → target ${target.toFixed(1)} dB`);

  state = 'listening';
  document.body.classList.add('is-listening');
  setInstruction('Scream this to unlock');
  newChallenge();
  window.sendEvent?.({ type: 'start', phrase: phrase.text });
}

function newChallenge() {
  if (recognizer) { recognizer.remove(); recognizer = null; }
  phrase = Phrases.generate(difficulty);

  // Restrict Vosk to just this phrase (plus its words, so partial hits still
  // count). "[unk]" soaks up everything else.
  const grammar = JSON.stringify([phrase.text, ...new Set(phrase.words), '[unk]']);
  recognizer = new model.KaldiRecognizer(audioCtx.sampleRate, grammar);
  recognizer.on('partialresult', (m) => onHeard(m.result.partial, false));
  recognizer.on('result', (m) => onHeard(m.result.text, true));

  peak = 0;
  renderPhrase(phrase.words.map(() => false));
  if (DEV) console.log('phrase:', phrase.text);
}

function onHeard(text, isFinal) {
  if (state !== 'listening' || !phrase) return;
  const heardWords = (text || '').split(/\s+/).filter((w) => w && w !== '[unk]');
  if (heardWords.length) $('heard').textContent = `I heard: "${heardWords.join(' ')}"`;

  const hits = matchWords(heardWords, phrase.words);
  const ratio = hits.filter(Boolean).length / phrase.words.length;
  renderPhrase(hits);

  if (ratio >= CONFIG.matchRatio && peak >= target) return victory();
  if (!isFinal) return;

  // End of an utterance that didn't unlock.
  if (!heardWords.length) { peak = 0; return; } // just noise, not an attempt

  failures++;
  const tooQuiet = ratio >= CONFIG.matchRatio;
  logShame(heardWords.join(' '), peak, tooQuiet);
  window.sendEvent?.({ type: 'fail', db: Math.round(peak), phrase: phrase.text });
  if (TEST_TARGET == null) target = Math.min(CONFIG.hardCap, target + CONFIG.failBump);
  playSadTrombone();

  if (failures % CONFIG.levelUpEvery === 0) {
    difficulty++;
    setStatus(`${tooQuiet ? pick(TOO_QUIET) : pick(WRONG_WORDS)} New phrase. Longer. You did this.`, 'bad');
    newChallenge();
  } else {
    setStatus(tooQuiet ? pick(TOO_QUIET) : pick(WRONG_WORDS), 'bad');
    peak = 0;
    setTimeout(() => { if (state === 'listening') renderPhrase(phrase.words.map(() => false)); }, 900);
  }
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
  document.body.classList.remove('is-listening');
  if (recognizer) { recognizer.remove(); recognizer = null; }
  if (phrase) renderPhrase(phrase.words.map(() => true));
  setStatus('');
  $('victoryLine').textContent = `${Math.round(peak)} dB. ${pick(VICTORY_LINES)}`;
  document.body.classList.add('is-victory');
  playFanfare();

  setTimeout(() => {
    document.body.classList.remove('is-victory');
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

function logShame(text, db, tooQuiet) {
  shame.unshift({ text, db: Math.round(db), tooQuiet });
  shame = shame.slice(0, 4);
  renderShame();
}

function renderShame() {
  $('shameLog').replaceChildren(...shame.map((s) => {
    const li = document.createElement('li');
    li.append(`"${s.text}" — `);
    const b = document.createElement('b');
    b.textContent = `${s.db} dB`;
    li.append(b, s.tooQuiet ? ' — too quiet' : ' — wrong words');
    return li;
  }));
}

function setInstruction(t) { $('instruction').textContent = t; }
function setStatus(t, kind) { const el = $('status'); el.textContent = t; el.className = 'status' + (kind ? ` ${kind}` : ''); }

function fatal(title, detail) {
  document.body.classList.remove('is-loading');
  setInstruction(title);
  setStatus(detail, 'bad');
}

function startClock() {
  const update = () => {
    const now = new Date();
    $('time').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
    $('date').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  };
  update();
  setInterval(update, 1000);
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
