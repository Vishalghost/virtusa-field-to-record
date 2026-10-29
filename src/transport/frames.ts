// Loss-tolerant framing for low-bandwidth links (LoRa, SMS, BLE, QR).
//
// Frame layout (bytes):
//   [0]     magic 0xF2 (format version)
//   [1..4]  message id: first 4 bytes of SHA-256(message), so frames from different
//           messages never get mixed up
//   [5]     seq (0-based)
//   [6]     total frame count N
//   [7..]   payload chunk
//   [-4..]  CRC-32 of everything before it (big-endian)
//
// Each frame is checked on its own (CRC), so a corrupted or lost frame only costs that
// frame: the receiver asks for the missing seq numbers, not the whole message.
// Authenticity is checked once over the reassembled message (see compact.ts).

import type { Bytes } from '../record/signing';
import { fromB64url, toB64url } from '../record/signing';

const MAGIC = 0xf2;
const HEADER = 7;
const CRC = 4;
export const TEXT_PREFIX = 'F2R:';

/** Max bytes per frame for each link. SMS: 110 bytes -> 151 chars incl. prefix, fits one 160-char SMS. */
export const LINKS = {
  lora: { label: 'LoRa / BLE / QR', frameBytes: 180 },
  sms: { label: 'SMS', frameBytes: 110 },
} as const;
export type LinkKind = keyof typeof LINKS;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function toFrames(message: Bytes, frameBytes: number): Promise<Bytes[]> {
  const chunk = frameBytes - HEADER - CRC;
  const total = Math.ceil(message.length / chunk);
  if (total > 255) throw new Error(`Message too large for ${frameBytes}-byte frames (${total} frames)`);
  const id = new Uint8Array(await crypto.subtle.digest('SHA-256', message)).slice(0, 4);
  const frames: Bytes[] = [];
  for (let seq = 0; seq < total; seq++) {
    const part = message.slice(seq * chunk, (seq + 1) * chunk);
    const f = new Uint8Array(HEADER + part.length + CRC);
    f[0] = MAGIC;
    f.set(id, 1);
    f[5] = seq;
    f[6] = total;
    f.set(part, HEADER);
    new DataView(f.buffer).setUint32(f.length - CRC, crc32(f.subarray(0, f.length - CRC)));
    frames.push(f);
  }
  return frames;
}

export const frameToText = (f: Uint8Array) => TEXT_PREFIX + toB64url(f);

export interface ParsedFrame {
  messageId: string;
  seq: number;
  total: number;
  payload: Bytes;
}

/** null if the bytes are not a frame or the CRC does not match. */
export function parseFrame(f: Bytes): ParsedFrame | null {
  if (f.length <= HEADER + CRC || f[0] !== MAGIC) return null;
  const crc = new DataView(f.buffer, f.byteOffset, f.byteLength).getUint32(f.length - CRC);
  if (crc !== crc32(f.subarray(0, f.length - CRC))) return null;
  const total = f[6];
  if (total === 0 || f[5] >= total) return null;
  return { messageId: hex(f.subarray(1, 5)), seq: f[5], total, payload: f.slice(HEADER, f.length - CRC) };
}

export interface Reassembly {
  messageId: string | null;
  total: number;
  received: number[];
  missing: number[];
  /** Lines that looked like frames but failed decoding or CRC. */
  rejected: number;
  /** Valid frames that belong to a different message than the one being rebuilt. */
  foreign: number;
  /** The complete message once every frame is in, else null. */
  message: Bytes | null;
}

/**
 * Rebuild a message from received frame texts (any order, duplicates allowed, junk
 * lines ignored). If frames of several messages are present, the one with the most
 * frames is rebuilt and the rest are counted as foreign.
 */
export function reassemble(lines: string[]): Reassembly {
  const byMessage = new Map<string, Map<number, ParsedFrame>>();
  let rejected = 0;
  for (const line of lines.map((l) => l.trim()).filter((l) => l.startsWith(TEXT_PREFIX))) {
    let frame: ParsedFrame | null = null;
    try {
      frame = parseFrame(fromB64url(line.slice(TEXT_PREFIX.length)));
    } catch {
      frame = null;
    }
    if (!frame) { rejected++; continue; }
    const set = byMessage.get(frame.messageId) ?? new Map<number, ParsedFrame>();
    set.set(frame.seq, frame);
    byMessage.set(frame.messageId, set);
  }

  const best = [...byMessage.entries()].sort((a, b) => b[1].size - a[1].size)[0];
  const foreign = [...byMessage.values()].reduce((n, s) => n + s.size, 0) - (best?.[1].size ?? 0);
  if (!best) return { messageId: null, total: 0, received: [], missing: [], rejected, foreign, message: null };

  const [messageId, frames] = best;
  const total = [...frames.values()][0].total;
  const received = [...frames.keys()].sort((a, b) => a - b);
  const missing = Array.from({ length: total }, (_, i) => i).filter((i) => !frames.has(i));
  let message: Bytes | null = null;
  if (!missing.length) {
    const parts = received.map((i) => frames.get(i)!.payload);
    message = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of parts) { message.set(p, pos); pos += p.length; }
  }
  return { messageId, total, received, missing, rejected, foreign, message };
}
