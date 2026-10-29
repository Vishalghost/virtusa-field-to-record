// Approximate string matching used to recover drug names that speech recognition
// misspelled or split ("on dance a tron" -> ondansetron, "narcane" -> narcan).

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1.0 = identical, 0.0 = nothing in common (normalized by the longer string). */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/**
 * Coarse sound-alike key: maps letters that ASR commonly confuses onto one symbol
 * and drops non-leading vowels, so "zofran"/"sofran" or "ondansatron"/"ondansetron" collide.
 */
export function phoneticKey(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  w = w
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/gh/g, 'g')
    .replace(/y/g, 'i');
  const head = w[0];
  const tail = w.slice(1).replace(/[aeiou]/g, '');
  return (head + tail).replace(/(.)\1+/g, '$1');
}

export interface FuzzyHit {
  term: string;
  score: number;
}

/**
 * Best lexicon term for `candidate`, or null. A hit needs high edit similarity AND
 * either the same first letter or the same sound-alike key; that second guard keeps
 * ordinary words from drifting onto drug names.
 */
export function bestFuzzyMatch(candidate: string, terms: string[], minScore: number): FuzzyHit | null {
  const key = phoneticKey(candidate);
  let best: FuzzyHit | null = null;
  for (const term of terms) {
    const flat = term.replace(/\s+/g, '');
    let score = similarity(candidate, flat);
    const soundsAlike = key.length >= 3 && key === phoneticKey(flat);
    if (soundsAlike) score = Math.max(score, 0.86);
    if (score < minScore) continue;
    if (candidate[0] !== flat[0] && !soundsAlike) continue;
    if (!best || score > best.score) best = { term, score };
  }
  return best;
}
