// Live stats panel: everyone's screams, from Firebase (real laptops) and,
// later, bots. This is the meeting point of both halves of the feature.
//
// Anyone can add an item with:
//   window.addFeedItem({ name, type, db, phrase, time, bot })
//     type: "start" | "fail" | "unlock"
//     db:   number, or null/missing (Firebase drops null fields)
//
// It's a plain script (not a module) so bots, renderer.js and firebase.js can
// all reach window.addFeedItem.

(function () {
  const FEED_SIZE = 6;                     // feed lines shown
  const ACTIVE_WINDOW_MS = 2 * 60 * 1000;  // "screaming now" = activity in the last 2 min…
  const MAX_ITEMS = 500;                   // memory cap

  const items = []; // every item we know about, sorted oldest → newest
  const $ = (id) => document.getElementById(id);

  // ---- Public API ------------------------------------------------------------
  function addFeedItem(item) {
    if (!item || !item.type || !item.name) return; // ignore junk
    const clean = {
      name: String(item.name),
      type: item.type,
      db: typeof item.db === "number" ? item.db : null,
      phrase: item.phrase ?? null,
      time: Number(item.time) || Date.now(),
      bot: Boolean(item.bot),
    };

    // Insert in time order (events can arrive slightly out of order).
    let i = items.length;
    while (i > 0 && items[i - 1].time > clean.time) i--;
    items.splice(i, 0, clean);
    if (items.length > MAX_ITEMS) items.shift();

    scheduleRender();
  }

  function setLiveStatus(connected) {
    const el = $("liveStatus");
    el.textContent = connected ? "● live" : "offline";
    el.classList.toggle("is-live", connected);
  }

  // Where does a scream of `db` rank among today's REAL screamers (bots don't
  // count)? Compares your best unlock today against everyone else's best.
  function getTodayRank(db) {
    const midnight = new Date().setHours(0, 0, 0, 0);
    const me = window.myScreamerName;
    let myBest = db;
    const othersBest = new Map();
    for (const it of items) {
      if (it.bot || it.type !== "unlock" || it.db == null || it.time < midnight) continue;
      if (it.name === me) myBest = Math.max(myBest, it.db);
      else othersBest.set(it.name, Math.max(othersBest.get(it.name) ?? 0, it.db));
    }
    const others = [...othersBest.values()];
    return { rank: 1 + others.filter((v) => v > myBest).length, total: others.length + 1, best: myBest };
  }

  window.addFeedItem = addFeedItem;
  window.setLiveStatus = setLiveStatus;
  window.getTodayRank = getTodayRank;

  // ---- Stats -----------------------------------------------------------------
  function computeStats(now) {
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    const latestByName = new Map();
    let unlocksToday = 0;
    let failsToday = 0;
    let loudest = null;

    for (const it of items) {
      latestByName.set(it.name, it); // items are sorted, so the last one wins
      if (it.time < midnight) continue;
      if (it.type === "fail") failsToday++;
      if (it.type === "unlock") {
        unlocksToday++;
        if (it.db != null && (!loudest || it.db > loudest.db)) loudest = it;
      }
    }

    // …and their most recent event isn't an unlock.
    let screamingNow = 0;
    for (const it of latestByName.values()) {
      if (it.type !== "unlock" && now - it.time < ACTIVE_WINDOW_MS) screamingNow++;
    }

    return { screamingNow, unlocksToday, failsToday, loudest };
  }

  // ---- Rendering -------------------------------------------------------------
  let renderPending = false;
  function scheduleRender() {
    // Batch bursts (e.g. 200 events arriving at startup) into one render.
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => { renderPending = false; render(); }, 50);
  }

  function render() {
    const now = Date.now();
    const s = computeStats(now);
    $("statNow").textContent = s.screamingNow;
    $("statUnlocks").textContent = s.unlocksToday;
    $("statFails").textContent = s.failsToday;
    $("statLoudest").textContent = s.loudest ? `${s.loudest.db} dB` : "--";
    $("statLoudestWho").textContent = s.loudest
      ? `loudest unlock today · ${displayName(s.loudest.name)}`
      : "loudest unlock today";

    const recent = items.slice(-FEED_SIZE).reverse(); // newest first
    $("liveFeed").replaceChildren(...recent.map((it) => feedLine(it, now)));
  }

  function feedLine(it, now) {
    const li = document.createElement("li");
    li.className = `feed-item feed-${it.type}`;

    const who = document.createElement("b");
    who.textContent = displayName(it.name);

    const icon = { start: "🎤", fail: "💀", unlock: "🔓" }[it.type] || "•";
    li.append(`${icon} `, who);

    if (it.type === "start") li.append(" started screaming at their laptop");
    else if (it.type === "fail") li.append(` failed at ${it.db ?? "?"} dB`);
    else if (it.type === "unlock") li.append(` unlocked at ${it.db ?? "?"} dB`);

    if (it.type === "unlock" && it.phrase) {
      const q = document.createElement("div");
      q.className = "feed-phrase";
      q.textContent = `"${it.phrase}"`;
      li.append(q);
    }

    const t = document.createElement("span");
    t.className = "feed-time";
    t.textContent = timeAgo(now - it.time);
    li.append(t);
    return li;
  }

  function displayName(name) {
    return name === window.myScreamerName ? `${name} (you)` : name;
  }

  function timeAgo(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 10) return "just now";
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  // "screaming now" and "12s ago" depend on the clock, so refresh regularly.
  setInterval(render, 5000);
  render();
})();
