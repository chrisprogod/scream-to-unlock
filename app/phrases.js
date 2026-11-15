// Random phrases to scream. Works in the browser (window.Phrases) and in Node
// (require) so `npm run check-phrases` can verify every word is one the
// speech model knows. Lowercase only, no punctuation.
//
// After editing these lists, run:  npm run check-phrases

(function (root) {
  const SUBJECTS = [
    'my toaster', 'the fridge', 'my cat', 'grandma', 'the printer',
    'my laptop', 'a goose', 'the moon', 'my landlord', 'the microwave',
    'my dentist', 'a pigeon', 'this computer', 'my left sock', 'a scuba diver',
  ];

  const PREDICATES = [
    'is judging me', 'owes me money', 'ate my homework', 'knows what i did',
    'wants a raise', 'is watching me', 'smells like soup', 'has a secret',
    'stole my socks', 'thinks i am weird', 'is a spy', 'hates mondays',
    'is my best friend', 'filed a complaint',
  ];

  const TAILS = [
    'and i am scared', 'at three in the morning', 'again', 'for no reason',
    'on a tuesday', 'and nobody cares', 'in my dreams', 'and it is my fault',
  ];

  const OPENERS = ['please believe me', 'i swear', 'help', 'listen to me'];

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
