import { describe, expect, it } from 'vitest';
import { processTranscript } from '../src/nlp/pipeline';

const meds = (t: string) =>
  processTranscript(t).medications.map((m) => [m.drug, m.dose, m.unit, m.route, m.administeredAt]);

describe('link', () => {
  it('keeps attributes inside their sentence', () => {
    expect(meds('Epi 0.3 mg IM at 10:00. Then zofran 4 mg IV.')).toEqual([
      ['epinephrine', 0.3, 'mg', 'IM', '10:00'],
      ['ondansetron', 4, 'mg', 'IV', null],
    ]);
  });

  it('applies a correction by discarding what came before it', () => {
    expect(meds('Fentanyl 100 mcg IV, scratch that, fentanyl 50 mcg IV')).toEqual([['fentanyl', 50, 'mcg', 'IV', null]]);
  });

  it('records a repeated dose as a second administration', () => {
    expect(meds('Adenosine 6 mg IV then adenosine 12 mg IV')).toHaveLength(2);
  });

  it('keeps a dose with no drug as an unidentified event instead of dropping it', () => {
    const [m] = processTranscript('Gave 5 mg IV').medications;
    expect(m.drug).toBeNull();
    expect(m.flags.some((f) => f.severity === 'block')).toBe(true);
  });

  it('never invents a time', () => {
    const [m] = processTranscript('Morphine 4 mg IV').medications;
    expect(m.administeredAt).toBeNull();
    expect(m.flags.map((f) => f.reason)).toContain('No administration time stated (capture time will be used)');
  });

  it('assigns sites to the nearest event', () => {
    const r = processTranscript('Started 18g IV left AC. Versed 5 mg IM right deltoid.');
    expect(r.procedures[0].site).toBe('left antecubital');
    expect(r.medications[0].site).toBe('right deltoid');
  });
});
