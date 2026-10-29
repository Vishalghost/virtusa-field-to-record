// Rule-based named-entity recognition over normalized dictation text.
// Extractors run in priority order; each claims the characters it matched so a
// later, more generic extractor cannot reuse them (e.g. the "18 g" in "18 g iv"
// is an IV gauge, not 18 grams of something).

import type { Entity, EntityType } from '../record/schema';
import { bestFuzzyMatch } from './fuzzy';
import { DRUG_TERMS, PROCEDURES } from './lexicon';
import { normalize, toOriginalSpan, type Normalized } from './normalize';

export const UNITS = ['mcg/kg/min', 'mcg/kg', 'mg/kg', 'mcg/min', 'mcg', 'mg', 'g', 'ml', 'l', 'lpm', 'units', 'meq', 'j', 'puffs'];

const ROUTES: [string, RegExp][] = [
  ['IV', /\b(?:slow\s+)?(?:ivp|iv(?:\s+push)?|intravenous(?:ly)?)\b/g],
  ['IO', /\b(?:io|intraosseous(?:ly)?)\b/g],
  ['IM', /\b(?:im|intramuscular(?:ly)?)\b/g],
  ['SC', /\b(?:subq|sub\s+q|subcut|subcutaneous(?:ly)?|sq|sc)\b/g],
  ['PO', /\b(?:po|by\s+mouth|orally|oral|chewed|chewable)\b/g],
  ['SL', /\b(?:sl|sublingual(?:ly)?|under\s+the\s+tongue)\b/g],
  ['IN', /\b(?:intranasal(?:ly)?|nasally|via\s+(?:mad|atomizer)|per\s+nare|in\s+each\s+nare|in\s+the\s+nose|in)\b/g],
  ['NEB', /\b(?:via\s+)?(?:neb|nebulized|nebulised|nebulizer|nebuliser)\b/g],
  ['INH', /\b(?:via\s+)?(?:inhaled|mdi|non\s+rebreather|nrb|nasal\s+cannula|nc)\b/g],
  ['ETT', /\b(?:via\s+(?:the\s+)?ett|down\s+the\s+tube|endotracheally)\b/g],
  ['TOP', /\b(?:topical(?:ly)?|transdermal|paste)\b/g],
  ['PR', /\b(?:rectal(?:ly)?|pr)\b/g],
];

const CORRECTION_RE = /\b(?:scratch\s+that|strike\s+that|disregard\s+(?:that|the\s+last)|correction|i\s+mean)\b/g;

const SITE_RE =
  /\b(?:(left|right|l|r|bilateral)\s+)?(?:(?:anterior|lateral|upper|lower|proximal)\s+)?(thigh|deltoid|arm|antecubital|ac|hand|forearm|wrist|tibia|humerus|shoulder|leg|nares|nare|nostrils|nostril|external\s+jugular|ej|chest)\b/g;
/** Body parts too generic to count as a site unless a side was also said. */
const NEEDS_SIDE = new Set(['ac', 'arm', 'hand', 'leg', 'chest', 'ej', 'shoulder']);

const TIME_RES: RegExp[] = [
  /\b(?:at\s+)?(\d{1,2}):(\d{2})\b/g,
  /\bat\s+(\d{1,2})(\d{2})\b(?!\s*(?:mcg|mg|g|ml|j|units|lpm)\b)/g,
  /\bat\s+(\d{1,2})\s+(\d{2})\b(?!\s*(?:mcg|mg|g|ml|j|units|lpm)\b)/g,
  /\b(\d{1,2})(\d{2})\s*(?:hours|hrs|hundred\s+hours)\b/g,
];

// Common narrative words that must never be fuzzy-matched onto a drug name.
const FUZZY_STOP = new Set(
  ('patient pt gave given giving administered admin started start repeat repeated another second third dose doses push pushed ' +
    'flush flushed minutes minute later transport transported hospital pressure breathing alert oriented complains complaint ' +
    'chest pain after before improved unchanged history allergies around about with without then also over under ' +
    'right left thigh upper lower placed applied noted reports states stated scene arrival arrived found female male ' +
    'years old year approximately responsive unresponsive respirations airway sugar glucose blood check checked vitals')
    .split(' '),
);

const ALL_TERMS = [...DRUG_TERMS.keys()].sort((a, b) => b.length - a.length);
const FUZZY_TERMS = ALL_TERMS.filter((t) => t.replace(/\s+/g, '').length >= 5);
const EXACT_DRUG_RE = new RegExp(`\\b(?:${ALL_TERMS.map(escapeRe).join('|')})\\b`, 'g');
const UNIT_ALT = UNITS.map(escapeRe).join('|');
const UNIT_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_ALT})\\b`, 'g');
// "2 or 5 mg", "rendu ya anju" (-> "2 or 5"): the medic was unsure. Matched before plain
// doses so "5 mg" can't be taken alone and silently recorded as the dose.
// The trailing look-ahead keeps "repeat in 5 or 10 minutes" from becoming a dose.
const ALT_DOSE_RE = new RegExp(
  `\\b(\\d+(?:\\.\\d+)?)(?:\\s*(?:${UNIT_ALT}))?\\s+or\\s+(\\d+(?:\\.\\d+)?)(?![\\d.])(?:\\s*(${UNIT_ALT})\\b)?` +
    `(?!\\s+(?:minutes?|mins?|times|hours?|hrs?|seconds?|secs?|years?|days?|weeks?)\\b)`,
  'g',
);
const PROCEDURE_RES = PROCEDURES.map((p) => ({ p, res: p.patterns.map((src) => new RegExp(src, 'g')) }));

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

class Claims {
  private taken: boolean[];
  constructor(len: number) {
    this.taken = new Array(len).fill(false);
  }
  free(s: number, e: number): boolean {
    for (let i = s; i < e; i++) if (this.taken[i]) return false;
    return true;
  }
  claim(s: number, e: number): void {
    for (let i = s; i < e; i++) this.taken[i] = true;
  }
}

export function extract(transcript: string): { entities: Entity[]; normalized: Normalized } {
  const n = normalize(transcript);
  const text = n.text;
  const claims = new Claims(text.length);
  const entities: Entity[] = [];

  const normEnd = new Map<Entity, number>();
  const add = (type: EntityType, s: number, e: number, value: string, confidence: number, extra: Partial<Entity> = {}) => {
    const span = toOriginalSpan(n, s, e);
    const entity: Entity = { type, value, text: transcript.slice(span.start, span.end), span, normStart: s, confidence, ...extra };
    entities.push(entity);
    normEnd.set(entity, e);
    claims.claim(s, e);
  };

  // 1. Corrections ("scratch that") act as segment boundaries in the linker.
  for (const m of text.matchAll(CORRECTION_RE)) add('CORRECTION', m.index!, m.index! + m[0].length, 'correction', 1);

  // 2. Procedures: their patterns contain words routes/doses would otherwise steal (IV, 18 g, 200 j).
  for (const { p, res } of PROCEDURE_RES) {
    for (const re of res) {
      for (const m of text.matchAll(re)) {
        const s = m.index!;
        const e = s + m[0].trimEnd().length;
        if (!claims.free(s, e)) continue;
        const detail = m.groups?.detail?.replace(/\s+/g, '').replace(/gauge$/, 'g').toUpperCase() ?? undefined;
        add('PROCEDURE', s, e, p.name, 0.95, { code: p.code, detail });
      }
    }
  }

  // 3. Times.
  for (const re of TIME_RES) {
    for (const m of text.matchAll(re)) {
      const s = m.index!;
      const e = s + m[0].length;
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (hh > 23 || mm > 59 || !claims.free(s, e)) continue;
      add('TIME', s, e, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, 0.95);
    }
  }

  // 4. Doses. Alternatives first ("2 or 5 mg"): recorded as unresolved, never as one value.
  for (const m of text.matchAll(ALT_DOSE_RE)) {
    const s = m.index!;
    const e = s + m[0].length;
    if (!claims.free(s, e)) continue;
    add('DOSE', s, e, '', 0.5, { unit: m[3], alternatives: [Number(m[1]), Number(m[2])] });
  }
  for (const m of text.matchAll(UNIT_RE)) {
    const s = m.index!;
    const e = s + m[0].length;
    if (!claims.free(s, e)) continue;
    add('DOSE', s, e, m[1], 0.97, { unit: m[2] });
  }

  // 5. Exact drug names / synonyms (run before routes so "nasal" etc. inside names are safe).
  for (const m of text.matchAll(EXACT_DRUG_RE)) {
    const s = m.index!;
    const e = s + m[0].length;
    if (!claims.free(s, e)) continue;
    const d = DRUG_TERMS.get(m[0])!;
    add('DRUG', s, e, d.name, 0.97, { code: d.rxnorm ?? undefined });
  }

  // 6. Routes.
  for (const [code, re] of ROUTES) {
    for (const m of text.matchAll(re)) {
      const s = m.index!;
      const e = s + m[0].length;
      if (!claims.free(s, e)) continue;
      // The bare word "in" is only a route when dictated/typed as the abbreviation "IN".
      if (m[0] === 'in' && transcript.slice(toOriginalSpan(n, s, e).start, toOriginalSpan(n, s, e).end) !== 'IN') continue;
      add('ROUTE', s, e, code, 0.95);
    }
  }

  // 7. Sites.
  for (const m of text.matchAll(SITE_RE)) {
    const s = m.index!;
    const e = s + m[0].length;
    const side = m[1];
    if ((!side && NEEDS_SIDE.has(m[2])) || !claims.free(s, e)) continue;
    const value = m[0].replace(/^l\b/, 'left').replace(/^r\b/, 'right').replace(/\bac$/, 'antecubital');
    add('SITE', s, e, value, 0.9);
  }

  // 8. Fuzzy drug recovery over whatever alphabetic tokens are still unclaimed.
  fuzzyDrugs(n, claims, add);

  // 9. Negation / non-administration context: "no IV access", "allergic to morphine".
  // These are mentions, not things that were done, so they must not become events.
  const kept = entities.filter(
    (e) => !((e.type === 'DRUG' || e.type === 'PROCEDURE') && (isNegated(text, e.normStart) || isNegatedAfter(text, normEnd.get(e)!))),
  );

  kept.sort((a, b) => a.normStart - b.normStart);
  return { entities: kept, normalized: n };
}

// NegEx-lite: trigger phrase -> how many words may sit between it and the mention.
// Kept deliberately tight: "no improvement after epi" must NOT negate epi.
const NEGATION_TRIGGERS: [RegExp, number][] = [
  [/^(?:no|without|denies|denied)$/, 0],
  [/^(?:not|never)$/, 2],
  [/^(?:allergic\s+to|allergy\s+to|allergies|allergies\s+to|unable\s+to|failed|refused|refuses|withheld|held|takes|home\s+meds?|prescribed|history\s+of)$/, 3],
];

function isNegated(text: string, start: number): boolean {
  // Only look back within the current clause.
  const before = text.slice(0, start);
  const clauseStart = Math.max(before.lastIndexOf('.'), before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf(':'));
  const words = before.slice(clauseStart + 1).trim().split(/\s+/).filter(Boolean);
  for (const [re, gap] of NEGATION_TRIGGERS) {
    for (let between = 0; between <= gap; between++) {
      for (const len of [1, 2]) {
        const end = words.length - between;
        const phrase = words.slice(end - len, end).join(' ');
        if (end - len >= 0 && re.test(phrase)) return true;
      }
    }
  }
  return false;
}

// Tamil negates with the verb, which comes AFTER the object: "morphine kudukala"
// (morphine not given), "IV line podala" (IV not placed), "aspirin vendam" (no aspirin).
const TAMIL_NEGATION = /^(?:illa|illai|kudukala|kodukala|kudukkala|kudukkavillai|podala|poadala|podavillai|vendam|venam)$/;

function isNegatedAfter(text: string, end: number): boolean {
  const after = text.slice(end);
  const clauseEnd = after.search(/[.,;:]/);
  const words = (clauseEnd === -1 ? after : after.slice(0, clauseEnd)).trim().split(/\s+/).filter(Boolean);
  // Up to 4 words later: "morphine 2 mg iv kudukala".
  return words.slice(0, 5).some((w) => TAMIL_NEGATION.test(w));
}

type AddFn =(type: EntityType, s: number, e: number, value: string, confidence: number, extra?: Partial<Entity>) => void;

function fuzzyDrugs(n: Normalized, claims: Claims, add: AddFn): void {
  // char offset of each token in normalized text
  const offsets: number[] = [];
  let pos = 0;
  for (const t of n.tokens) {
    offsets.push(pos);
    pos += t.text.length + 1;
  }
  const isWord = (i: number) => /^[a-z]+$/.test(n.tokens[i].text);
  const freeTok = (i: number) => claims.free(offsets[i], offsets[i] + n.tokens[i].text.length);

  for (let i = 0; i < n.tokens.length; i++) {
    if (!isWord(i) || !freeTok(i)) continue;
    // Try the widest window first: ASR often splits one drug into several short words.
    for (let w = 4; w >= 1; w--) {
      const idx = Array.from({ length: w }, (_, k) => i + k);
      if (idx[w - 1] >= n.tokens.length || !idx.every((k) => isWord(k) && freeTok(k))) continue;
      const words = idx.map((k) => n.tokens[k].text);
      if (words.every((x) => FUZZY_STOP.has(x))) continue;
      if (w === 1 && (words[0].length < 5 || FUZZY_STOP.has(words[0]))) continue;
      const joined = words.join('');
      if (w > 1 && joined.length < 7) continue;
      // Long strings rarely collide by chance, so they may differ more ("on dandstrom" ->
      // ondansetron). The low score still lands below LOW_CONFIDENCE, forcing human review.
      const minScore = joined.length >= 10 ? 0.72 : w === 1 ? 0.8 : 0.82;
      const hit = bestFuzzyMatch(joined, FUZZY_TERMS, minScore);
      if (!hit) continue;
      const d = DRUG_TERMS.get(hit.term)!;
      const s = offsets[i];
      const e = offsets[idx[w - 1]] + n.tokens[idx[w - 1]].text.length;
      add('DRUG', s, e, d.name, +(hit.score * (w === 1 ? 0.9 : 0.85)).toFixed(2), { code: d.rxnorm ?? undefined });
      i = idx[w - 1];
      break;
    }
  }
}
