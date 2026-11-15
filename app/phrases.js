// Random phrases to scream: Gen Z / Gen Alpha brain rot, with a sprinkle of
// programmer memes. Works in the browser (window.Phrases) and in Node
// (require) so `npm run check-phrases` can verify the speech model can hear
// every word. Lowercase only, no punctuation.
//
// After editing these lists, run:  npm run check-phrases

(function (root) {
  // ---- Slang the 2020 speech model doesn't know --------------------------------
  // The screen shows the slang word; the recognizer listens for an in-vocabulary
  // sound-alike instead, and what it hears is translated back to the slang word.
  // (Words that can't be faked this way: gyatt, gronk, sybau.)
  const SOUNDS_LIKE = {
    rizz: 'riz',
    rizzler: 'riz ler',
    skibidi: 'skippy dee',
    delulu: 'the lulu',
    fanum: 'fay num',
    mewing: 'mew wing',
    mogged: 'mugged',
    clanker: 'clunker',
    bussin: 'bussing',
    grindset: 'grind set',
    situationship: 'situation ship',
    tralalero: 'tra la le row',
    tralala: 'tra la la',
    sahur: 'sa her',
    bombardiro: 'bombardier oh',
    crocodilo: 'crocodile oh',
    cappuccina: 'cappuccino',
    assassino: 'assassin oh',
    chimpanzini: 'chimpanzee knee',
    bananini: 'banana knee',
  };

  // ---- Phrase parts ----------------------------------------------------------------
  const SUBJECTS = [
    'my rizz', 'the rizzler', 'tung tung tung sahur', 'tralalero tralala',
    'bombardiro crocodilo', 'ballerina cappuccina', 'cappuccino assassino',
    'chimpanzini bananini', 'my sigma grindset', 'the skibidi toilet',
    'my aura', 'the npc', 'my unc', 'a clanker', 'my situationship',
    'the group chat', 'the ohio final boss', 'grandma', 'my code',
  ];

  const PREDICATES = [
    'has negative aura', 'is aura farming', 'has zero rizz', 'is so delulu',
    'is low key cooked', 'is mewing', 'took my fanum tax', 'is giving ohio',
    'is not bussin', 'got mogged', 'is chopped', 'keeps glazing me',
    'needs to lock in', 'is crashing out', 'is yapping again', 'is the final boss',
    'ate and left no crumbs', 'is in its villain era', 'is my roman empire',
    'is a canon event', 'did the griddy', 'is so skibidi', 'is so mid',
    'is kind of sus', 'needs to touch grass', 'is vibe coding',
  ];

  const TAILS = [
    'six seven', 'no cap', 'on god', 'for real for real', 'it is giving brain rot',
    'in ohio', 'respectfully', 'it is so over', 'we are so back',
    'chat is this real', 'goofy ahh', 'unc status', 'skibidi',
  ];

  const OPENERS = ['bro', 'chat', 'not gonna lie', 'low key', 'pov', 'be so for real', 'erm what the sigma'];

  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  // What the recognizer should listen for, word by word.
  const toSpoken = (words) => words.flatMap((w) => (SOUNDS_LIKE[w] || w).split(' '));

  // Turn heard words back into the words on screen ("riz" → "rizz",
  // "skippy dee" → "skibidi"). Longest sound-alikes are matched first.
  const ALIASES = Object.entries(SOUNDS_LIKE)
    .map(([display, spoken]) => ({ display, spoken: spoken.split(' ') }))
    .sort((a, b) => b.spoken.length - a.spoken.length);

  // Pass the phrase's words so a sound-alike is only translated when its slang
  // word is actually in the phrase ("cappuccino" stays "cappuccino" unless the
  // phrase says "cappuccina").
  function toDisplay(heard, phraseWords = null) {
    const out = [];
    const usable = phraseWords ? ALIASES.filter((a) => phraseWords.includes(a.display)) : ALIASES;
    for (let i = 0; i < heard.length;) {
      const alias = usable.find((a) => a.spoken.every((w, k) => heard[i + k] === w));
      if (alias) { out.push(alias.display); i += alias.spoken.length; }
      else { out.push(heard[i]); i++; }
    }
    return out;
  }

  // difficulty 0: "my rizz is so delulu"
  // difficulty 1: + a tail
  // difficulty 2: + an opener
  // difficulty 3+: + a second tail
  function generate(difficulty = 0) {
    const parts = [pick(SUBJECTS), pick(PREDICATES)];
    if (difficulty >= 1) parts.push(pick(TAILS));
    if (difficulty >= 2) parts.unshift(pick(OPENERS));
    if (difficulty >= 3) parts.push(pick(TAILS.filter((t) => !parts.includes(t))));
    const text = parts.join(' ');
    const words = text.split(' ');
    const spokenWords = toSpoken(words);
    return { text, words, spokenWords, spokenText: spokenWords.join(' ') };
  }

  // Every word the recognizer may need to hear (for the vocabulary check).
  function allSpokenWords() {
    const all = [...SUBJECTS, ...PREDICATES, ...TAILS, ...OPENERS].join(' ').split(' ');
    return [...new Set(toSpoken(all))];
  }

  const api = { generate, toDisplay, allSpokenWords, SOUNDS_LIKE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Phrases = api;
})(typeof window !== 'undefined' ? window : globalThis);
