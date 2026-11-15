// Random phrases to scream. Works in the browser (window.Phrases) and in Node
// (require) so `npm run check-phrases` can verify every word is one the
// speech model knows. Lowercase only, no punctuation.
//
// After editing these lists, run:  npm run check-phrases

(function (root) {
  // Gen Z slang + software engineering memes. Words the 2020 speech model does
  // NOT know (can never be recognized): rizz, delulu, skibidi, gyatt, ratioed,
  // bussin, leetcode, npm, gpt, frontend. Write "lowkey" as "low key".
  const SUBJECTS = [
    'my code', 'the intern', 'the senior dev', 'the compiler', 'my linkedin',
    'the recruiter', 'my startup', 'the server', 'the database', 'copilot',
    'claude', 'my git history', 'the product manager', 'my side project',
    'the wifi', 'stack overflow', 'my laptop',
    'my toaster', 'grandma', 'a goose', // classics
  ];

  const PREDICATES = [
    'works on my machine', 'pushed to prod on a friday', 'has a skill issue',
    'needs to touch grass', 'is vibe coding', 'deleted the database',
    'is low key cooked', 'has negative aura', 'is aura farming',
    'is a beige flag', 'is a canon event', 'is giving main character',
    'is in its villain era', 'is my roman empire', 'ate and left no crumbs',
    'is so mid', 'is kind of sus', 'is very demure', 'keeps glazing my code',
    'has a merge conflict', 'crashed in production', 'wrote zero tests',
    'thinks tabs beat spaces', 'forgot a semicolon', 'skipped the standup',
    'got hit by layoffs', 'is the backend now',
  ];

  const TAILS = [
    'no cap', 'for real', 'six seven', 'respectfully', 'on god',
    'in this economy', 'send help', 'it is so over', 'we are so back',
    'and i am crying', 'and it is giving brain rot', 'before the deadline',
  ];

  const OPENERS = ['bro', 'chat', 'not gonna lie', 'low key', 'be so for real', 'okay so', 'pov'];

  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  // difficulty 0: "my toaster is judging me"
  // difficulty 1: + a tail
  // difficulty 2: + an opener
  // difficulty 3+: + a second tail
  function generate(difficulty = 0) {
    const parts = [pick(SUBJECTS), pick(PREDICATES)];
    if (difficulty >= 1) parts.push(pick(TAILS));
    if (difficulty >= 2) parts.unshift(pick(OPENERS));
    if (difficulty >= 3) parts.push(pick(TAILS.filter((t) => !parts.includes(t))));
    const text = parts.join(' ');
    return { text, words: text.split(' ') };
  }

  function allWords() {
    const all = [...SUBJECTS, ...PREDICATES, ...TAILS, ...OPENERS].join(' ').split(' ');
    return [...new Set(all)];
  }

  const api = { generate, allWords };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Phrases = api;
})(typeof window !== 'undefined' ? window : globalThis);
