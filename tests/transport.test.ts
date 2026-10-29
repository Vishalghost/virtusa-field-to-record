import { describe, expect, it } from 'vitest';
import { signRecord, verifyChain, verifyRecordSignature } from '../src/record/audit';
import { createDraft } from '../src/record/record';
import { createDeviceKey, fromB64url, toB64url } from '../src/record/signing';
import { decodeMessage, encodeMessage } from '../src/transport/compact';
import { crc32, frameToText, LINKS, reassemble, toFrames, TEXT_PREFIX } from '../src/transport/frames';

const NOW = new Date('2026-10-28T10:40:00Z');
const DICTATION = 'Aspirin 300 mg PO at 10:42. Oxygen 4 litre per minute via non rebreather at 10:44. 18g IV left AC at 10:47.';

async function signedRecord() {
  const key = await createDeviceKey();
  const r = await signRecord(createDraft(DICTATION, 'voice', 'INC-20261028-AB12', NOW), 'medic-7', null, NOW, key);
  return { key, r };
}

describe('device signatures', () => {
  it('signs the record hash and the chain verifies it', async () => {
    const { r } = await signedRecord();
    expect(r.deviceKey).toBeTruthy();
    expect(await verifyRecordSignature(r)).toBe(true);
    expect(await verifyChain([r])).toEqual([]);
  });

  it('a different key cannot be swapped in: the public key is inside the hash', async () => {
    const { r } = await signedRecord();
    const other = await createDeviceKey();
    const swapped = { ...r, deviceKey: other.publicKey };
    expect((await verifyChain([swapped])).map((p) => p.problem)).toEqual(['hash-mismatch', 'bad-signature']);
  });
});

describe('frames', () => {
  it('CRC-32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips a signed record through SMS-sized frames in any order', async () => {
    const { key, r } = await signedRecord();
    const frames = (await toFrames(await encodeMessage(r, key), LINKS.sms.frameBytes)).map(frameToText);
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(160); // one SMS each

    const got = reassemble([...frames].reverse());
    expect(got.missing).toEqual([]);
    const { record: rec, signatureValid } = await decodeMessage(got.message!);
    const record = rec!;
    expect(signatureValid).toBe(true);
    expect(record).toMatchObject({ incidentId: 'INC-20261028-AB12', recordId: r.id, hash: r.hash, signedBy: 'medic-7' });
    expect(record.medications.map((m) => [m.drug, m.dose, m.unit, m.route, m.time])).toEqual([
      ['aspirin', 300, 'mg', 'PO', '10:42'],
      ['oxygen', 4, 'lpm', 'INH', '10:44'],
    ]);
    expect(record.procedures[0]).toMatchObject({ procedure: 'IV access', detail: '18G', site: 'left antecubital', time: '10:47' });
  });

  it('reports exactly which frames are missing, and completes when they are resent', async () => {
    const { key, r } = await signedRecord();
    const frames = (await toFrames(await encodeMessage(r, key), LINKS.sms.frameBytes)).map(frameToText);
    const partial = reassemble(frames.filter((_, i) => i !== 1));
    expect(partial).toMatchObject({ missing: [1], message: null });
    expect(reassemble([...frames.filter((_, i) => i !== 1), frames[1], frames[0]]).message).not.toBeNull(); // duplicates ok
  });

  it('drops a corrupted frame by CRC instead of using it', async () => {
    const { key, r } = await signedRecord();
    const frames = (await toFrames(await encodeMessage(r, key), LINKS.lora.frameBytes)).map(frameToText);
    const bytes = fromB64url(frames[0].slice(TEXT_PREFIX.length));
    bytes[10] ^= 0xff;
    const got = reassemble([TEXT_PREFIX + toB64url(bytes), ...frames.slice(1)]);
    expect(got).toMatchObject({ rejected: 1, missing: [0], message: null });
  });

  it('a message altered in transit (and re-framed with valid CRCs) fails the signature', async () => {
    const { key, r } = await signedRecord();
    const tampered = structuredClone(r);
    tampered.medications[0].dose = 3000; // 10x
    const evil = await createDeviceKey();
    // Attacker can re-encode with their own key, but then the fingerprint changes...
    const reSigned = await decodeMessage(await encodeMessage(tampered, evil));
    const genuine = await decodeMessage(await encodeMessage(r, key));
    expect(reSigned.fingerprint).not.toBe(genuine.fingerprint);
    // ...and without the key, flipping body bytes breaks the signature.
    const msg = await encodeMessage(r, key);
    msg[msg.length - 1] ^= 0x01;
    await expect(decodeMessage(msg).then((d) => d.signatureValid)).resolves.toBe(false);
  });
});
