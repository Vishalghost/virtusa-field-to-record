import { describe, expect, it } from 'vitest';
import { canonicalJson, GENESIS_HASH, signRecord, verifyChain } from '../src/record/audit';
import { toFhirBundle } from '../src/record/fhir';
import { amend, confirmEvent, createDraft, editMedication, signingBlockers } from '../src/record/record';

const NOW = new Date('2026-10-28T14:40:00Z');

describe('record lifecycle', () => {
  it('blocks signing until flagged events are confirmed, and logs every edit', () => {
    let r = createDraft('Gave zofran IV for nausea.', 'text', 'INC-1', NOW);
    expect(signingBlockers(r)).toHaveLength(1); // no dose
    const id = r.medications[0].id;
    r = editMedication(r, id, 'dose', 4, NOW);
    r = editMedication(r, id, 'unit', 'mg', NOW);
    expect(signingBlockers(r)).toHaveLength(0);
    expect(r.edits.map((e) => [e.field, e.from, e.to])).toEqual([['dose', null, 4], ['unit', null, 'mg']]);
  });

  it('an unclear dose ("2 ya 5") blocks signing until a human enters one', () => {
    let r = createDraft('Morphine 2 ya 5 mg IV at 10:50', 'voice', 'INC-6', NOW);
    const m = r.medications[0];
    expect(m).toMatchObject({ drug: 'morphine', dose: null, doseAlternatives: [2, 5], unit: 'mg', route: 'IV' });
    expect(m.flags[0]).toMatchObject({ severity: 'block', reason: expect.stringContaining('Dose unclear: said 2 or 5 mg') });
    r = editMedication(r, m.id, 'dose', 2, NOW);
    expect(signingBlockers(r)).toHaveLength(0);
  });

  it('confirming an event is itself logged', () => {
    let r = createDraft('Gave narcane 2 mg IV at 19:05', 'voice', 'INC-2', NOW);
    r = confirmEvent(r, r.medications[0].id, NOW);
    expect(r.edits.at(-1)).toMatchObject({ field: 'confirmed', to: true });
  });
});

describe('audit chain', () => {
  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('detects tampering with a signed record and its successors', async () => {
    const a = await signRecord(createDraft('Epi 0.3 mg IM at 10:00', 'text', 'INC-3', NOW), 'medic-1', null, NOW);
    const b = await signRecord(createDraft('Aspirin 324 mg PO at 10:05', 'text', 'INC-3', NOW), 'medic-1', a.hash, NOW);
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(await verifyChain([a, b])).toEqual([]);

    const tampered = structuredClone(a);
    tampered.medications[0].dose = 3; // 10x overdose written in after signing
    expect(await verifyChain([tampered, b])).toEqual([{ index: 0, recordId: a.id, problem: 'hash-mismatch' }]);

    const rehashed = { ...tampered, hash: (await signRecord({ ...tampered, status: 'draft' }, 'x', null, NOW)).hash };
    expect((await verifyChain([rehashed, b])).map((p) => p.problem)).toContain('broken-link');
  });

  it('signed records cannot be edited; amendments link to the original', async () => {
    const signed = await signRecord(createDraft('Epi 0.3 mg IM', 'text', 'INC-4', NOW), 'medic-1', null, NOW);
    expect(() => editMedication(signed, signed.medications[0].id, 'dose', 0.5)).toThrow();
    const v2 = amend(signed);
    expect(v2).toMatchObject({ version: 2, supersedes: signed.id, status: 'draft', hash: null });
  });
});

describe('FHIR-lite', () => {
  it('maps medications with RxNorm + UCUM and marks the time source', () => {
    const r = createDraft('Gave 0.3 mg epi IM right thigh at 14:32. Started 18g IV left AC.', 'text', 'INC-5', NOW);
    const b = toFhirBundle(r);
    const ma = b.entry[0].resource as any;
    expect(ma.resourceType).toBe('MedicationAdministration');
    expect(ma.medicationCodeableConcept.coding[0]).toMatchObject({ code: '3992', display: 'epinephrine' });
    expect(ma.dosage.dose).toMatchObject({ value: 0.3, code: 'mg', system: 'http://unitsofmeasure.org' });
    expect(ma.extension[0].valueString).toBe('dictated');
    const proc = b.entry[1].resource as any;
    expect(proc).toMatchObject({ resourceType: 'Procedure', bodySite: [{ text: 'left antecubital' }] });
    expect(proc.extension[0].valueString).toBe('capture');
    expect(b.entry.at(-1)!.resource.resourceType).toBe('Provenance');
  });
});
