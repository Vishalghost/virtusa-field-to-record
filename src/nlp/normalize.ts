// Normalizes a raw dictation into a lowercase, single-spaced token stream that the
// rule extractor can match against, while keeping a map from every normalized
// character back to the verbatim transcript. Rewrites performed:
//   - spoken numbers -> digits   ("point three" -> "0.3", "two hundred fifty" -> "250")
//   - unit aliases  -> canonical ("micrograms" -> "mcg", "cc" -> "ml", "liters per minute" -> "lpm")
//   - romanized Tamil (Tanglish) -> English ("rendu" -> 2, "potten" -> "placed", "ya" -> "or")

import type { Span } from '../record/schema';

interface Token {
  text: string;
  start: number;
  end: number;
}

export interface Normalized {
  /** Normalized text; tokens joined by single spaces. */
  text: string;
  /** For each char in `text`, the index into `tokens`, or -1 for separator spaces. */
  charToken: number[];
  tokens: Token[];
  original: string;
}

const ONES: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
  // Romanized Tamil 1-10, with common spellings.
  onnu: 1, onru: 1, rendu: 2, randu: 2, moonu: 3, munu: 3, naalu: 4, nalu: 4, anju: 5, ainthu: 5,
  aaru: 6, ezhu: 7, elu: 7, ettu: 8, onbathu: 9, ombodhu: 9, pathu: 10,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

// Multi-word phrases first so they win over their single-word prefixes.
const UNIT_ALIASES: [string[], string][] = [
  [['liters', 'per', 'minute'], 'lpm'],
  [['liter', 'per', 'minute'], 'lpm'],
  [['litres', 'per', 'minute'], 'lpm'],
  [['litre', 'per', 'minute'], 'lpm'],
  [['l', 'per', 'minute'], 'lpm'],
  [['milligrams', 'per', 'kilogram'], 'mg/kg'],
  [['micrograms', 'per', 'kilogram'], 'mcg/kg'],
  [['micrograms', 'per', 'minute'], 'mcg/min'],
  [['international', 'units'], 'units'],
  [['milligrams'], 'mg'], [['milligram'], 'mg'], [['milligrammes'], 'mg'], [['mgs'], 'mg'], [['migs'], 'mg'],
  [['micrograms'], 'mcg'], [['microgram'], 'mcg'], [['mics'], 'mcg'], [['mikes'], 'mcg'], [['ug'], 'mcg'], [['µg'], 'mcg'],
  [['grams'], 'g'], [['gram'], 'g'], [['gm'], 'g'],
  [['milliliters'], 'ml'], [['milliliter'], 'ml'], [['mls'], 'ml'], [['cc'], 'ml'], [['ccs'], 'ml'],
  [['liters'], 'l'], [['liter'], 'l'], [['litres'], 'l'], [['litre'], 'l'], [['lpm'], 'lpm'],
  [['joules'], 'j'], [['joule'], 'j'],
  [['unit'], 'units'],
  [['milliequivalents'], 'meq'],
  [['puff'], 'puffs'],
];

// Code-mixed Tamil-English dictation, mapped onto the English words the extractor
// already understands. Verbs matter even though they carry no value: mapped to
// "gave"/"placed" they hit procedure patterns ("iv potten" -> "iv placed") and the
// fuzzy matcher's stop list, instead of being misread as a drug name.
// Negations ("kudukala" = did not give) are handled in extract.ts, because in Tamil
// they come after the drug, not before it.
const TANGLISH_ALIASES: [string[], string][] = [
  [['vaai', 'vazhiya'], 'orally'], [['vaai', 'vazhi'], 'orally'], [['vaayila'], 'orally'],
  [['naakku', 'keezha'], 'sublingual'], [['nakku', 'keela'], 'sublingual'],
  [['kuduthen'], 'gave'], [['kuduthom'], 'gave'], [['koduthen'], 'gave'], [['kuduthachu'], 'gave'], [['ethinen'], 'gave'],
  [['potten'], 'placed'], [['pottaen'], 'placed'], [['potaen'], 'placed'], [['pottom'], 'placed'], [['pottachu'], 'placed'],
  [['panninen'], 'performed'], [['pannom'], 'performed'],
  [['ya'], 'or'], [['illana'], 'or'],
];

// Letter-led alphanumerics stay whole (o2, d50, etco2); hyphens are dropped as separators.
const TOKEN_RE = /µg|[a-z][a-z0-9]*(?:'[a-z]+)?|\d+(?:[.:]\d+)?|[^\s-]/g;

function tokenize(original: string): Token[] {
  const lower = original.toLowerCase();
  const out: Token[] = [];
  for (const m of lower.matchAll(TOKEN_RE)) {
    out.push({ text: m[0], start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

const isDigits = (t: string) => /^\d+(?:\.\d+)?$/.test(t);
// 'hundred' alone never starts a run: it needs a multiplier in front ("two hundred").
const isNumberWord = (t: string) => t in ONES || t in TENS;

/** Collapse runs of spoken numbers into digit tokens. */
function collapseNumbers(tokens: Token[]): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const startsNumber =
      isNumberWord(t.text) ||
      (/^\d+$/.test(t.text) && tokens[i + 1]?.text === 'point') ||
      (t.text === 'point' && i + 1 < tokens.length && (tokens[i + 1].text in ONES || isDigits(tokens[i + 1].text)));
    // "oh" only counts as zero inside a number run, never on its own.
    if (!startsNumber || t.text === 'oh') {
      out.push(t);
      i++;
      continue;
    }

    let value: number | null = null;
    let first = t;
    let last = t;
    let afterHundred = false;
    const flush = () => {
      if (value !== null) out.push({ text: String(value), start: first.start, end: last.end });
      value = null;
    };

    while (i < tokens.length) {
      const w = tokens[i].text;
      if (w in ONES) {
        const v = ONES[w];
        // add the units digit to a tens value ("twenty four", "three twenty four") or after "hundred"
        const canAdd = value !== null && ((value % 100 >= 20 && value % 10 === 0 && v < 10) || (afterHundred && value % 100 === 0));
        if (canAdd) value! += v;
        else { flush(); value = v; first = tokens[i]; }
        afterHundred = false;
      } else if (w in TENS) {
        if (value !== null && afterHundred && value % 100 === 0) value += TENS[w];
        // dosing shorthand: single digit + tens = hundreds ("three twenty four" = 324, "one twenty five" = 125).
        // Teens are left alone so clock times ("fourteen thirty two") stay as two numbers.
        else if (value !== null && value >= 1 && value < 10 && !afterHundred) value = value * 100 + TENS[w];
        else { flush(); value = TENS[w]; first = tokens[i]; }
        afterHundred = false;
      } else if (w === 'hundred' && value !== null && value < 10) {
        value *= 100;
        afterHundred = true;
      } else if (w === 'point') {
        // decimal part: following single digits, spoken or written ("point two five", "point 5")
        let digits = '';
        let j = i + 1;
        while (j < tokens.length && (tokens[j].text in ONES && ONES[tokens[j].text] < 10)) {
          digits += ONES[tokens[j].text];
          j++;
        }
        if (!digits && j < tokens.length && /^\d+$/.test(tokens[j].text)) {
          digits = tokens[j].text;
          j++;
        }
        if (!digits) break;
        if (value === null) first = tokens[i];
        value = Number(`${value ?? 0}.${digits}`);
        last = tokens[j - 1];
        i = j;
        flush();
        break;
      } else if (/^\d+$/.test(w) && value === null && tokens[i + 1]?.text === 'point') {
        value = Number(w);
        first = tokens[i];
      } else {
        break;
      }
      last = tokens[i];
      i++;
    }
    flush();
  }
  return out;
}

/** Replace phrases from `table` with their canonical word; the new token spans the whole phrase. */
function rewritePhrases(tokens: Token[], table: [string[], string][]): Token[] {
  const out: Token[] = [];
  let i = 0;
  outer: while (i < tokens.length) {
    for (const [phrase, canon] of table) {
      if (phrase.every((w, k) => tokens[i + k]?.text === w)) {
        out.push({ text: canon, start: tokens[i].start, end: tokens[i + phrase.length - 1].end });
        i += phrase.length;
        continue outer;
      }
    }
    out.push(tokens[i]);
    i++;
  }
  return out;
}

export function normalize(original: string): Normalized {
  let tokens = tokenize(original);
  tokens = rewritePhrases(tokens, TANGLISH_ALIASES);
  tokens = collapseNumbers(tokens);
  tokens = rewritePhrases(tokens, UNIT_ALIASES);

  let text = '';
  const charToken: number[] = [];
  tokens.forEach((t, idx) => {
    if (idx > 0) {
      text += ' ';
      charToken.push(-1);
    }
    text += t.text;
    for (let k = 0; k < t.text.length; k++) charToken.push(idx);
  });
  return { text, charToken, tokens, original };
}

/** Map a [start, end) range in normalized text back to a span in the original transcript. */
export function toOriginalSpan(n: Normalized, start: number, end: number): Span {
  let s = start;
  while (s < end && n.charToken[s] === -1) s++;
  let e = end - 1;
  while (e > s && n.charToken[e] === -1) e--;
  const first = n.tokens[n.charToken[s]];
  const last = n.tokens[n.charToken[e]];
  return { start: first.start, end: last.end };
}
