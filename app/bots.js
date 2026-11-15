// Fake "bot" screamers so the live feed never looks empty on stage, and keeps
// moving if the Wi-Fi (and Firebase) dies.
//
// Bots only exist on this laptop: they call window.addFeedItem directly and
// are never sent to Firebase, so the database only holds real screams.

(function () {
  const CONFIG = {
    enabled: true,          // set false to see only real users
    maxActive: 3,           // bots screaming at the same time, at most
    spawnEveryMs: [4000, 12000],  // how often a new bot might start
    stepEveryMs: [2500, 8000],    // time between one bot's attempts
    maxFails: 3,            // a bot fails 0–3 times before unlocking…
    rageQuitChance: 0.15,   // …or gives up entirely
    seedSessions: 6,        // finished sessions to invent at startup (last 30 min)
  };

  const rand = (min, max) => min + Math.random() * (max - min);
  const randInt = (min, max) => Math.floor(rand(min, max + 1));
  const botName = () => `Screamer #${randInt(1000, 9999)}`;
  const failDb = () => randInt(42, 78);    // not loud enough
  const unlockDb = () => randInt(80, 99);  // loud enough

  function emit(name, type, phrase, db, time = Date.now()) {
    window.addFeedItem?.({ name, type, db, phrase, time, bot: true });
  }

  // ---- Live bots -------------------------------------------------------------
  let active = 0;

  // One bot = one person trying to unlock: start, fail a few times, then
  // unlock (or rage quit).
  function runBot() {
    active++;
    const name = botName();
    const phrase = Phrases.generate(randInt(0, 2)).text;
    const fails = randInt(0, CONFIG.maxFails);
    const quits = Math.random() < CONFIG.rageQuitChance;
    let attempts = 0;

    emit(name, "start", phrase, null);

    function nextStep() {
      setTimeout(() => {
        if (attempts < fails) {
          attempts++;
          emit(name, "fail", phrase, failDb());
          nextStep();
        } else {
          if (!quits) emit(name, "unlock", phrase, unlockDb());
          active--; // a rage-quitter just goes silent
        }
      }, rand(...CONFIG.stepEveryMs));
    }
    nextStep();
  }

  function spawnLoop() {
    if (active < CONFIG.maxActive) runBot();
    setTimeout(spawnLoop, rand(...CONFIG.spawnEveryMs));
  }

  // ---- Fake history, so the stats aren't all zero at launch --------------------
  function seedHistory() {
    const now = Date.now();
    for (let i = 0; i < CONFIG.seedSessions; i++) {
      const name = botName();
      const phrase = Phrases.generate(randInt(0, 2)).text;
      let t = now - rand(3, 30) * 60 * 1000; // started 3–30 minutes ago
      emit(name, "start", phrase, null, t);
      for (let f = randInt(0, CONFIG.maxFails); f > 0; f--) {
        t += rand(5, 20) * 1000;
        emit(name, "fail", phrase, failDb(), t);
      }
      t += rand(5, 20) * 1000;
      emit(name, "unlock", phrase, unlockDb(), t);
    }
  }

  if (CONFIG.enabled) {
    seedHistory();
    setTimeout(spawnLoop, rand(1000, 3000));
  }
})();
