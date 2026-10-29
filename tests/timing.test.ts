import { describe, expect, it } from 'vitest';
import { repairTranscript } from '../src/asr/repair';
import { signRecord } from '../src/record/audit';
import { toFhirBundle } from '../src/record/fhir';
import { createDraft, editMedication } from '../src/record/record';
import { createDeviceKey } from '../src/record/signing';
import { decodeMessage, encodeMessage } from '../src/transport/compact';

// Local clock times, so HH:MM assertions hold in any timezone.
const at = (h: number, m: number, s = 0) => new Date(2026, 9, 29, h, m, s);

describe('automatic event times (no typing)', () => {
  it('typed note: device clock at entry; a time said aloud wins', () => {
    const r = createDraft('Aspirin 324 mg PO. Zofran 4 mg IV at 10:15.', 'text', 'INC-T', at(10, 42));
    expect(r.medications.map((m) => [m.drug, m.administeredAt, m.timeSource])).toEqual([
      ['aspirin', '10:42', 'entered'],
      ['ondansetron', '10:15', 'dictated'],
    ]);
    expect(r.medications[0].flags.map((f) => f.reason).join()).not.toContain('No administration time');
  });

  it('voice: each item is stamped with the clock time its words were spoken', () => {
    const raw = 'Aspirin 300 mg PO. Oxygen 4 lpm via non rebreather. Started 18g IV left AC.';
    const segments = [
      { text: ' Aspirin 300 mg PO.', start: 0, end: 3 },
      { text: ' Oxygen 4 lpm via non rebreather.', start: 120, end: 124 },
      { text: ' Started 18g IV left AC.', start: 300, end: 303 },
    ];
    const r = createDraft(raw, 'voice', 'INC-V', at(10, 50), { rawTranscript: raw, repairs: [], startedAt: at(10, 42).getTime(), segments });
    expect(r.medications.map((m) => [m.drug, m.administeredAt, m.timeSource])).toEqual([
      ['aspirin', '10:42', 'spoken'],
      ['oxygen', '10:44', 'spoken'],
    ]);
    expect(r.procedures[0]).toMatchObject({ procedure: 'IV access', performedAt: '10:47', timeSource: 'spoken' });
    expect(r.recordedAt).toBe(at(10, 42).toISOString()); // recording start, not extraction time
  });

  it('maps through speech repairs to find the right segment', () => {
    const raw = 'Aspirin 300 mg PO. Oxygen Nala Leader per minute non rebreather.';
    const { text, repairs } = repairTranscript(raw);
    const segments = [{ text: ' Aspirin 300 mg PO.', start: 0, end: 2 }, { text: ' Oxygen Nala Leader per minute non rebreather.', start: 180, end: 185 }];
    const r = createDraft(text, 'voice', 'INC-R', at(11, 0), { rawTranscript: raw, repairs, startedAt: at(10, 40).getTime(), segments });
    expect(r.medications.map((m) => m.administeredAt)).toEqual(['10:40', '10:43']);
  });

  it('every output says where the time came from', async () => {
    let r = createDraft('Aspirin 324 mg PO', 'text', 'INC-O', at(9, 5));
    const fhirSource = (x: typeof r) => (toFhirBundle(x).entry[0].resource as any).extension[0].valueString;
    expect(fhirSource(r)).toBe('entered');
    r = editMedication(r, r.medications[0].id, 'administeredAt', '08:55');
    expect(r.medications[0].timeSource).toBe('edited');
    expect(fhirSource(r)).toBe('edited');

    const key = await createDeviceKey();
    const signed = await signRecord(r, 'EMT-1', null, at(9, 6), key);
    const { record } = await decodeMessage(await encodeMessage(signed, key));
    expect(record!.medications[0]).toMatchObject({ time: '08:55', timeSource: 'edited' });
  });
});
