// Per-device signing identity (ECDSA P-256 via WebCrypto).
//
// The private key is generated non-extractable: page code can use it to sign but can
// never read its bytes, so it can't be copied off the device by script. The public key
// travels with every signed record and transmission so any receiver can verify.
//
// Trust caveat: a valid signature proves "the holder of this key signed it". Whether
// that key belongs to a known responder device is a registration question; receivers
// show the key fingerprint so it can be checked against a list of enrolled devices.

export type Bytes = Uint8Array<ArrayBuffer>;

export interface DeviceKey {
  privateKey: CryptoKey;
  /** Raw uncompressed P-256 public key (65 bytes), base64url. */
  publicKey: string;
}

const KEY_ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;
export const SIGNATURE_BYTES = 64; // WebCrypto ECDSA P-256 signatures are raw r||s

export function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text: string): Bytes {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function createDeviceKey(): Promise<DeviceKey> {
  const pair = await crypto.subtle.generateKey(KEY_ALG, false, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toB64url(raw) };
}

export async function signBytes(key: DeviceKey, data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.sign(SIGN_ALG, key.privateKey, data));
}

/** False for a wrong signature, a malformed key or a malformed signature; never throws. */
export async function verifyBytes(publicKey: string, data: Bytes, signature: Bytes): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', fromB64url(publicKey), KEY_ALG, false, ['verify']);
    return await crypto.subtle.verify(SIGN_ALG, key, signature, data);
  } catch {
    return false;
  }
}

/** Short human-comparable id for a public key, e.g. "3f9a-0c12-77de-b401". */
export async function keyFingerprint(publicKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fromB64url(publicKey)));
  const hex = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.match(/.{4}/g)!.join('-');
}
