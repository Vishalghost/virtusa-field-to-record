// Compact signed message: the part of a signed record a receiving clinician needs,
// small enough to cross LoRa / SMS in a few frames.
//
// Wire format:  signature (64) || public key (65, raw P-256) || deflate-raw( JSON with short keys )
//
// The key sits outside the compressed body so the receiver can check the signature
// BEFORE decompressing or parsing anything: untrusted bytes are authenticated first.
//
// What is left out: transcript, source spans, flags and the edit log. They stay in the
// full record on the device and sync later. The record hash is included so the full
// record can be matched up afterwards.
//
// Why a second signature (not just the record's): the receiver can't recompute the
// record hash without the transcript, so a signed hash alone would let someone change
// a dose in transit. This signature covers exactly the bytes that were sent.

import { PROCEDURES } from '../nlp/lexicon';
import type { ClinicalRecord, TimeSource } from '../record/schema';
import { fromB64url, keyFingerprint, signBytes, toB64url, verifyBytes, SIGNATURE_BYTES, type Bytes, type DeviceKey } from '../record/signing';

const PUBLIC_KEY_BYTES = 65;

export interface CompactMed {
  drug: string | null;
  dose: number | null;
  unit: string | null;
  route: string | null;
  site: string | null;
  /** "HH:MM", or null (receiver shows capture time, labelled). */
  time: string | null;
  timeSource?: TimeSource;
  confirmed: boolean;
}

export interface CompactProc {
  procedure: string;
  code: string;
  detail: string | null;
  site: string | null;
  time: string | null;
  timeSource?: TimeSource;
  confirmed: boolean;
}

// One letter per time source on the wire.
const SRC_CODE: Record<TimeSource, string> = { dictated: 'd', spoken: 's', entered: 'e', edited: 'x' };
const SRC_FROM = Object.fromEntries(Object.entries(SRC_CODE).map(([k, v]) => [v, k as TimeSource])) as Record<string, TimeSource>;

export interface CompactRecord {
  incidentId: string;
  recordId: string;
  version: number;
  signedBy: string;
  signedAt: string;
  recordedAt: string;
  /** SHA-256 of the full record (hex), for matching on later sync. */
  hash: string;
  /** Sending device public key (base64url). */
  deviceKey: string;
  medications: CompactMed[];
  procedures: CompactProc[];
}

export function toCompact(r: ClinicalRecord, deviceKey: string): CompactRecord {
  if (r.status !== 'signed' || !r.hash) throw new Error('Only signed records can be sent');
  return {
    incidentId: r.incidentId,
    recordId: r.id,
    version: r.version,
    signedBy: r.signedBy!,
    signedAt: r.signedAt!,
    recordedAt: r.recordedAt,
    hash: r.hash,
    deviceKey,
    medications: r.medications.map((m) => ({
      drug: m.drug, dose: m.dose, unit: m.unit, route: m.route, site: m.site, time: m.administeredAt, timeSource: m.timeSource, confirmed: m.confirmed,
    })),
    procedures: r.procedures.map((p) => ({
      procedure: p.procedure, code: p.code, detail: p.detail, site: p.site, time: p.performedAt, timeSource: p.timeSource, confirmed: p.confirmed,
    })),
  };
}

// ---- short-key wire form -------------------------------------------------------

const hexToBytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
const bytesToHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const uuidToB64 = (id: string) => (/^[0-9a-f-]{36}$/.test(id) ? btoa(String.fromCharCode(...hexToBytes(id.replace(/-/g, '')))) : id);
const b64ToUuid = (s: string) => {
  if (s.length !== 24) return s;
  const hex = bytesToHex(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const toEpoch = (iso: string) => Math.round(Date.parse(iso) / 1000);
const fromEpoch = (s: number) => new Date(s * 1000).toISOString();
const PROC_NAME = new Map(PROCEDURES.map((p) => [p.code, p.name]));

function pack(c: CompactRecord): unknown {
  return {
    i: c.incidentId, r: uuidToB64(c.recordId), v: c.version, b: c.signedBy, s: toEpoch(c.signedAt), c: toEpoch(c.recordedAt),
    h: btoa(String.fromCharCode(...hexToBytes(c.hash))),
    m: c.medications.map((m) => [m.drug, m.dose, m.unit, m.route, m.site, m.time, m.confirmed ? 1 : 0, m.timeSource ? SRC_CODE[m.timeSource] : '']),
    // Procedure names are looked up from the shared lexicon by code on the receiver.
    p: c.procedures.map((p) => [PROC_NAME.get(p.code) === p.procedure ? p.code : `${p.code}|${p.procedure}`, p.detail, p.site, p.time, p.confirmed ? 1 : 0, p.timeSource ? SRC_CODE[p.timeSource] : '']),
  };
}

type Packed = {
  i: string; r: string; v: number; b: string; s: number; c: number; h: string;
  m: [string | null, number | null, string | null, string | null, string | null, string | null, number, string?][];
  p: [string, string | null, string | null, string | null, number, string?][];
};

function unpack(w: Packed, deviceKey: string): CompactRecord {
  return {
    incidentId: w.i, recordId: b64ToUuid(w.r), version: w.v, signedBy: w.b, signedAt: fromEpoch(w.s), recordedAt: fromEpoch(w.c),
    hash: bytesToHex(Uint8Array.from(atob(w.h), (ch) => ch.charCodeAt(0))), deviceKey,
    medications: w.m.map(([drug, dose, unit, route, site, time, ok, src]) => ({
      drug, dose, unit, route, site, time, timeSource: SRC_FROM[src ?? ''], confirmed: ok === 1,
    })),
    procedures: w.p.map(([codeName, detail, site, time, ok, src]) => {
      const [code, name] = codeName.split('|');
      return { procedure: name ?? PROC_NAME.get(code) ?? code, code, detail, site, time, timeSource: SRC_FROM[src ?? ''], confirmed: ok === 1 };
    }),
  };
}

// ---- compression + signature ---------------------------------------------------

async function through(data: Bytes, stream: CompressionStream | DecompressionStream): Promise<Bytes> {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function encodeMessage(r: ClinicalRecord, device: DeviceKey): Promise<Bytes> {
  const json = new TextEncoder().encode(JSON.stringify(pack(toCompact(r, device.publicKey))));
  const body = await through(json as Bytes, new CompressionStream('deflate-raw'));
  const signed = new Uint8Array(PUBLIC_KEY_BYTES + body.length);
  signed.set(fromB64url(device.publicKey));
  signed.set(body, PUBLIC_KEY_BYTES);
  const sig = await signBytes(device, signed);
  const out = new Uint8Array(sig.length + signed.length);
  out.set(sig);
  out.set(signed, sig.length);
  return out;
}

export interface DecodedMessage {
  /** null when the signature failed and the body could not even be decoded. */
  record: CompactRecord | null;
  signatureValid: boolean;
  fingerprint: string;
}

/** A bad signature is reported, not thrown. Throws only for bytes too short to be a message. */
export async function decodeMessage(msg: Bytes): Promise<DecodedMessage> {
  if (msg.length <= SIGNATURE_BYTES + PUBLIC_KEY_BYTES) throw new Error('Not a Field-to-Record message');
  const sig = msg.slice(0, SIGNATURE_BYTES);
  const signed = msg.slice(SIGNATURE_BYTES);
  const deviceKey = toB64url(signed.subarray(0, PUBLIC_KEY_BYTES));
  const signatureValid = await verifyBytes(deviceKey, signed, sig);
  const fingerprint = await keyFingerprint(deviceKey);
  try {
    const json = new TextDecoder().decode(await through(signed.slice(PUBLIC_KEY_BYTES), new DecompressionStream('deflate-raw')));
    return { record: unpack(JSON.parse(json) as Packed, deviceKey), signatureValid, fingerprint };
  } catch (e) {
    if (signatureValid) throw e; // signed by the key holder yet malformed: a sender bug, surface it
    return { record: null, signatureValid, fingerprint };
  }
}
