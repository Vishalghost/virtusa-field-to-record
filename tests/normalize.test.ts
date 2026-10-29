import { describe, expect, it } from 'vitest';
import { normalize, toOriginalSpan } from '../src/nlp/normalize';

describe('normalize', () => {
  it.each([
    ['three twenty four milligrams', '324 mg'],
    ['one twenty five mg', '125 mg'],
    ['two hundred fifty ml', '250 ml'],
    ['point four mg', '0.4 mg'],
    ['one point five mg', '1.5 mg'],
    ['1 point 5 mg', '1.5 mg'],
    ['point two five', '0.25'],
    ['fifteen liters per minute', '15 lpm'],
    ['fifty micrograms', '50 mcg'],
    ['ten cc', '10 ml'],
    ['at fourteen thirty two', 'at 14 32'],
    ['18g IV', '18 g iv'],
    ['C-collar', 'c collar'],
  ])('%s -> %s', (input, expected) => {
    expect(normalize(input).text).toBe(expected);
  });

  it('does not loop on a bare "hundred"', () => {
    expect(normalize('hundred').text).toBe('hundred');
  });

  it('maps normalized spans back to the verbatim transcript', () => {
    const original = 'Gave Narcan four milligrams IN';
    const n = normalize(original);
    const s = n.text.indexOf('4 mg');
    const span = toOriginalSpan(n, s, s + 4);
    expect(original.slice(span.start, span.end)).toBe('four milligrams');
  });
});
