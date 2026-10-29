// Repairs predictable mishearings of romanized Tamil (and a few English terms) by the
// English-only Whisper model, BEFORE extraction. Applied to speech output only.
//
// Safety rules:
//   - The raw ASR text is kept on the record as evidence (record.rawTranscript).
//   - Every repair is reported with its span in the repaired text. Any event built from
//     a repaired span gets a blocking review flag, so a guess about what was said can
//     never reach a signed record without a human confirming it.
//
// The rules below are SEEDS from synthetic speech. Tune them only against real
// recordings (`npm run eval:asr`); a rule that only fixes synthetic voices is overfitting.

export interface SpeechRepair {
  /** What the speech model wrote. */
  heard: string;
  /** What it was repaired to. */
  readAs: string;
  /** Span of `readAs` in the repaired text. */
  start: number;
  end: number;
}

// Number words as they may appear in the RAW text (the look-behind below runs on it),
// so misheard forms ("nala", "rondu") count too.
const NUM = '(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|onnu|rendu|rondu|randu|moonu|naalu|nala|anju|aaru|ezhu|ettu|pathu)';

const RULES: [RegExp, string][] = [
  // "IV" heard as the number 4 in front of IV vocabulary: "4 line" -> "IV line".
  [/\b(?:4|four)(?=\s+(?:line|access|cannula|fluids?|push|started)\b)/gi, 'IV'],
  // Tamil numbers 1-10 as the English model tends to spell them.
  [/\b(?:rondu|randu|rondo|rendo|rendoo)\b/gi, 'rendu'],
  [/\b(?:moo\s?noo|moonoo|moono)\b/gi, 'moonu'],
  [/\b(?:nala|nahlu|naaloo|nalloo|naloo)\b/gi, 'naalu'],
  [/\b(?:on\s?ju|onjoo|anjoo|ancho)\b/gi, 'anju'],
  [/\b(?:paththu|pathoo|patthu)\b/gi, 'pathu'],
  // Units split or misspelled.
  [/\b(?:mila|milla|mili|meli)\s?grams?\b/gi, 'milligram'],
  [new RegExp(`(?<=\\b${NUM}\\s+)(?:leader|litter|lita|leeta|leeter)s?\\b`, 'gi'), 'litre'],
  // Verbs split into English words.
  [/\bkudu\s?then\b/gi, 'kuduthen'],
  [/\bpot\s?ten\b/gi, 'potten'],
];

/** Map an offset in the repaired text back to the raw ASR text (repairs sorted by start). */
export function toRawOffset(pos: number, repairs: SpeechRepair[]): number {
  let delta = 0;
  for (const r of repairs) {
    if (pos >= r.end) delta += r.heard.length - r.readAs.length;
    else if (pos >= r.start) return r.start + delta;
    else break;
  }
  return pos + delta;
}

export function repairTranscript(raw: string): { text: string; repairs: SpeechRepair[] } {
  // Collect matches against the raw text; earlier rules win on overlap.
  const hits: { start: number; end: number; to: string }[] = [];
  for (const [re, to] of RULES) {
    for (const m of raw.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (m[0].toLowerCase() === to.toLowerCase()) continue; // already right
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      hits.push({ start, end, to });
    }
  }
  hits.sort((a, b) => a.start - b.start);

  let text = '';
  let pos = 0;
  const repairs: SpeechRepair[] = [];
  for (const h of hits) {
    text += raw.slice(pos, h.start);
    repairs.push({ heard: raw.slice(h.start, h.end), readAs: h.to, start: text.length, end: text.length + h.to.length });
    text += h.to;
    pos = h.end;
  }
  text += raw.slice(pos);
  return { text, repairs };
}
