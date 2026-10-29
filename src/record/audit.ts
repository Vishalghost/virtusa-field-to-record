// Tamper-evident audit chain.
//
// Each signed record stores the hash of the previously signed record (prevHash)
// and its own hash over a canonical JSON form of everything except `hash`. Editing
// any signed record (even one character of the transcript) changes its hash, which
// breaks the link to the next record, and verifyChain() reports exactly where.
//
// The hash proves *integrity* (nothing changed after signing). When a device key is
// given, the hash is also signed with it (ECDSA P-256), which proves *which device*
// sealed the record. The public key is inside the hashed content, so it can't be
// swapped without breaking the hash.

import type { ClinicalRecord } from './schema';
import { fromB64url, signBytes, toB64url, verifyBytes, type DeviceKey } from './signing';

export const GENESIS_HASH = '0'.repeat(64);

/** Deterministic JSON: object keys sorted recursively, so the same record always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashRecord(record: ClinicalRecord): Promise<string> {
  const { hash: _omit, signature: _sig, ...rest } = record;
  return sha256Hex(canonicalJson(rest));
}

const utf8 = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

/** Seal a draft: stamp signer + time, link to the previous record, compute hash, sign it if a device key is given. */
export async function signRecord(
  draft: ClinicalRecord, signedBy: string, prevHash: string | null, now = new Date(), device?: DeviceKey,
): Promise<ClinicalRecord> {
  if (draft.status === 'signed') throw new Error('Record is already signed; create an amendment instead');
  const sealed: ClinicalRecord = {
    ...structuredClone(draft),
    status: 'signed',
    signedBy,
    signedAt: now.toISOString(),
    prevHash: prevHash ?? GENESIS_HASH,
    hash: null,
    ...(device ? { deviceKey: device.publicKey } : {}),
  };
  delete sealed.signature;
  sealed.hash = await hashRecord(sealed);
  if (device) sealed.signature = toB64url(await signBytes(device, utf8(sealed.hash)));
  return sealed;
}

export async function verifyRecordSignature(r: ClinicalRecord): Promise<boolean> {
  if (!r.signature || !r.deviceKey || !r.hash) return false;
  return verifyBytes(r.deviceKey, utf8(r.hash), fromB64url(r.signature));
}

export interface ChainProblem {
  index: number;
  recordId: string;
  problem: 'hash-mismatch' | 'broken-link' | 'bad-signature';
}

/** Verify signed records in signing order. Empty result = chain intact. */
export async function verifyChain(records: ClinicalRecord[]): Promise<ChainProblem[]> {
  const problems: ChainProblem[] = [];
  let expectedPrev = GENESIS_HASH;
  for (const [index, r] of records.entries()) {
    if ((await hashRecord(r)) !== r.hash) problems.push({ index, recordId: r.id, problem: 'hash-mismatch' });
    if (r.prevHash !== expectedPrev) problems.push({ index, recordId: r.id, problem: 'broken-link' });
    // Records sealed before device keys existed have no signature; those are hash-only.
    if (r.signature && !(await verifyRecordSignature(r))) problems.push({ index, recordId: r.id, problem: 'bad-signature' });
    expectedPrev = r.hash ?? '';
  }
  return problems;
}
