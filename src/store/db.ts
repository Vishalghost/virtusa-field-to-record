// On-device persistence (IndexedDB). Drafts are mutable; signed records are
// append-only and ordered by a separate `chain` store that fixes signing order.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { GENESIS_HASH, signRecord, verifyChain, type ChainProblem } from '../record/audit';
import type { ClinicalRecord } from '../record/schema';
import { createDeviceKey, type DeviceKey } from '../record/signing';

interface FtrDB extends DBSchema {
  records: { key: string; value: ClinicalRecord; indexes: { byStatus: string } };
  chain: { key: number; value: { seq?: number; recordId: string; hash: string } };
  keys: { key: string; value: DeviceKey & { id: string } };
}

let dbp: Promise<IDBPDatabase<FtrDB>> | null = null;
const db = () =>
  (dbp ??= openDB<FtrDB>('field-to-record', 2, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        const records = d.createObjectStore('records', { keyPath: 'id' });
        records.createIndex('byStatus', 'status');
        d.createObjectStore('chain', { keyPath: 'seq', autoIncrement: true });
      }
      if (oldVersion < 2) d.createObjectStore('keys', { keyPath: 'id' });
    },
  }));

let keyp: Promise<DeviceKey> | null = null;

/**
 * This device's signing key, created on first use. The CryptoKey is stored as-is
 * (IndexedDB can hold non-extractable keys). Clearing site data loses it, and the
 * device then signs with a new identity.
 */
export function deviceKey(): Promise<DeviceKey> {
  return (keyp ??= (async () => {
    const d = await db();
    const stored = await d.get('keys', 'device');
    if (stored) return stored;
    const key = await createDeviceKey();
    await d.put('keys', { id: 'device', ...key });
    return key;
  })());
}

export async function saveDraft(r: ClinicalRecord): Promise<void> {
  if (r.status !== 'draft') throw new Error('Use signAndStore for signed records');
  await (await db()).put('records', r);
}

export async function deleteDraft(id: string): Promise<void> {
  const d = await db();
  const r = await d.get('records', id);
  if (r?.status === 'draft') await d.delete('records', id);
}

export async function listDrafts(): Promise<ClinicalRecord[]> {
  return (await db()).getAllFromIndex('records', 'byStatus', 'draft');
}

/** Signed records in signing order. */
export async function listSigned(): Promise<ClinicalRecord[]> {
  const d = await db();
  const links = await d.getAll('chain');
  const out: ClinicalRecord[] = [];
  for (const l of links) {
    const r = await d.get('records', l.recordId);
    if (r) out.push(r);
  }
  return out;
}

async function chainHead(): Promise<string> {
  const d = await db();
  const cursor = await d.transaction('chain').store.openCursor(null, 'prev');
  return cursor?.value.hash ?? GENESIS_HASH;
}

/**
 * Sign a draft and append it to the chain. Hashing is async (WebCrypto), which would
 * auto-commit an open IndexedDB transaction, so we sign first and then verify inside
 * the write transaction that nobody else extended the chain meanwhile; retry if so.
 */
export async function signAndStore(draft: ClinicalRecord, signedBy: string): Promise<ClinicalRecord> {
  const key = await deviceKey();
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await chainHead();
    const signed = await signRecord(draft, signedBy, head, new Date(), key);
    const tx = (await db()).transaction(['records', 'chain'], 'readwrite');
    const cursor = await tx.objectStore('chain').openCursor(null, 'prev');
    if ((cursor?.value.hash ?? GENESIS_HASH) !== head) {
      tx.abort();
      continue;
    }
    await tx.objectStore('records').put(signed);
    await tx.objectStore('chain').add({ recordId: signed.id, hash: signed.hash! });
    await tx.done;
    return signed;
  }
  throw new Error('Could not append to audit chain (concurrent writes)');
}

export async function verifyStoredChain(): Promise<ChainProblem[]> {
  return verifyChain(await listSigned());
}
