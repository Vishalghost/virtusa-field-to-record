import { describe, expect, it } from 'vitest';
import { extract } from '../src/nlp/extract';
import { bestFuzzyMatch, phoneticKey } from '../src/nlp/fuzzy';

const types = (t: string) => extract(t).entities.map((e) => `${e.type}:${e.value}`);

describe('extract', () => {
  it('finds drug, dose, route, site and time', () => {
    expect(types('Gave 0.3 mg epi IM right thigh at 14:32')).toEqual([
      'DOSE:0.3', 'DRUG:epinephrine', 'ROUTE:IM', 'SITE:right thigh', 'TIME:14:32',
    ]);
  });

  it('treats an IV gauge as a procedure detail, not a gram dose', () => {
    const { entities } = extract('started 18g IV left AC');
    expect(entities.find((e) => e.type === 'DOSE')).toBeUndefined();
    expect(entities.find((e) => e.type === 'PROCEDURE')).toMatchObject({ value: 'IV access', detail: '18G' });
  });

  it('does not mistake 25 grams of D50 for a 25-gauge IV', () => {
    expect(types('D50 twenty five grams IV')).toEqual(['DRUG:dextrose', 'DOSE:25', 'ROUTE:IV']);
  });

  it('only reads "in" as a route when written as the abbreviation IN', () => {
    expect(types('narcan 4 mg IN')).toContain('ROUTE:IN');
    expect(types('narcan 4 mg in the field')).not.toContain('ROUTE:IN');
  });

  it('recovers ASR-split drug names with reduced confidence', () => {
    const drug = extract('gave on dance a tron 4 mg IV').entities.find((e) => e.type === 'DRUG')!;
    expect(drug.value).toBe('ondansetron');
    expect(drug.text).toBe('on dance a tron');
    expect(drug.confidence).toBeLessThan(0.85);
  });

  it('ignores negated and allergy mentions', () => {
    expect(types('No IV access possible')).not.toContain('PROCEDURE:IV access');
    expect(types('Allergic to morphine')).not.toContain('DRUG:morphine');
    expect(types('no improvement, repeated epi 0.3 mg')).toContain('DRUG:epinephrine');
    expect(types('no improvement after nitro')).toContain('DRUG:nitroglycerin');
  });

  it('keeps spans pointing at the verbatim transcript', () => {
    const t = 'Aspirin three twenty four milligrams PO';
    const dose = extract(t).entities.find((e) => e.type === 'DOSE')!;
    expect(dose.value).toBe('324');
    expect(t.slice(dose.span.start, dose.span.end)).toBe('three twenty four milligrams');
  });
});

describe('Tanglish (romanized Tamil-English)', () => {
  it('reads Tamil number words, British units and verbs', () => {
    expect(types('Oxygen naalu litre per minute')).toEqual(['DRUG:oxygen', 'DOSE:4']);
    expect(types('IV potten left hand')).toContain('PROCEDURE:IV access');
    expect(types('aspirin 300 mg vaai vazhiya kuduthen')).toEqual(['DRUG:aspirin', 'DOSE:300', 'ROUTE:PO']);
  });

  it('negation after the drug, as Tamil word order puts it', () => {
    expect(types('morphine kudukala')).not.toContain('DRUG:morphine');
    expect(types('IV line podala')).not.toContain('PROCEDURE:IV access');
    expect(types('aspirin kuduthen, morphine vendam')).toEqual(['DRUG:aspirin']);
  });

  it('"2 ya 5" is an unresolved dose, never silently 5', () => {
    const dose = extract('Morphine rendu ya anju mg IV').entities.find((e) => e.type === 'DOSE')!;
    expect(dose).toMatchObject({ alternatives: [2, 5], unit: 'mg' });
    expect(types('epi 0.3 mg IM, repeat in 5 or 10 minutes')).toEqual(['DRUG:epinephrine', 'DOSE:0.3', 'ROUTE:IM']);
  });
});

describe('fuzzy', () => {
  it('matches sound-alikes but not ordinary words', () => {
    expect(phoneticKey('zofran')).toBe(phoneticKey('sofran'));
    expect(bestFuzzyMatch('ketorolack', ['ketorolac', 'ketamine'], 0.8)?.term).toBe('ketorolac');
    expect(bestFuzzyMatch('patient', ['pitressin', 'promethazine'], 0.8)).toBeNull();
  });
});
