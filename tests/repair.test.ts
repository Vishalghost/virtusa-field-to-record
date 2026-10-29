import { describe, expect, it } from 'vitest';
import { repairTranscript } from '../src/asr/repair';
import { createDraft, signingBlockers } from '../src/record/record';

// Fixtures are real outputs of whisper-tiny.en on synthesized Tanglish dictation.
describe('speech repairs', () => {
  it('fixes the mishearings seen from the English model and reports each one', () => {
    const { text, repairs } = repairTranscript('Aspirin 300 mg Vazzyakudu then. 4 Line Potten');
    expect(text).toBe('Aspirin 300 mg Vazzyakudu then. IV Line Potten');
    expect(repairs).toEqual([{ heard: '4', readAs: 'IV', start: 32, end: 34 }]);
    expect(text.slice(repairs[0].start, repairs[0].end)).toBe('IV');

    expect(repairTranscript('Oxygen Nala Leader Per Minute').text).toBe('Oxygen naalu litre Per Minute');
    expect(repairTranscript('Morphine Rondu Ya').text).toBe('Morphine rendu Ya');
  });

  it('rejoins a split Tamil negation so a withheld drug is not recorded as given', () => {
    const { text } = repairTranscript('Morphine Kudu Kala, allergy irukku.'); // whisper-base.en output
    expect(text).toBe('Morphine kudukala, allergy irukku.');
    expect(createDraft(text, 'voice', 'INC-N').medications).toEqual([]);
  });

  it('leaves correct English dictation alone', () => {
    for (const t of ['Gave 4 mg zofran IV push at 14:32.', 'Started 18g IV left AC.', 'Oxygen 4 liters per minute via non rebreather.', 'The team leader arrived.']) {
      expect(repairTranscript(t)).toEqual({ text: t, repairs: [] });
    }
  });

  it('anything built from a repaired word blocks signing until a human confirms it', () => {
    const heard = 'Oxygen Nala Leader Per Minute non rebreather. Aspirin 300 mg PO.';
    const { text, repairs } = repairTranscript(heard);
    const r = createDraft(text, 'voice', 'INC-R', new Date('2026-10-29T10:00:00Z'), { rawTranscript: heard, repairs });
    expect(r.rawTranscript).toBe(heard);
    const [oxygen, aspirin] = r.medications;
    expect(oxygen).toMatchObject({ drug: 'oxygen', dose: 4, unit: 'lpm' });
    expect(oxygen.flags.some((f) => f.severity === 'block' && f.reason.includes('"Nala" as "naalu"'))).toBe(true);
    expect(aspirin.flags.some((f) => f.reason.startsWith('Speech fix-up'))).toBe(false);
    expect(signingBlockers(r).map((e) => e.id)).toEqual([oxygen.id]);
  });
});
