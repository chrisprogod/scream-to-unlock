// Verifies every word in app/phrases.js exists in the Vosk model's vocabulary.
// Words the model doesn't know are silently ignored by Vosk, which would make
// a phrase impossible to say. Run: npm run check-phrases

const fs = require('fs');
const path = require('path');
const Phrases = require('../app/phrases.js');

const vocab = new Set(
  fs.readFileSync(path.join(__dirname, 'vocab.txt'), 'utf8').split('\n')
);

const words = Phrases.allWords();
const missing = words.filter((w) => !vocab.has(w));

if (missing.length) {
  console.error(`✗ ${missing.length} word(s) the speech model doesn't know:`);
  for (const w of missing) console.error(`   - ${w}`);
  console.error('Replace them in app/phrases.js.');
  process.exit(1);
}

console.log(`✓ All ${words.length} phrase words are in the model's vocabulary.`);
console.log('Samples:');
for (let d = 0; d <= 3; d++) console.log(`  difficulty ${d}: "${Phrases.generate(d).text}"`);
