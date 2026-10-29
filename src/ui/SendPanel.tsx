import QRCode from 'qrcode';
import { useEffect, useState } from 'preact/hooks';
import { toFhirBundle } from '../record/fhir';
import type { ClinicalRecord } from '../record/schema';
import { deviceKey } from '../store/db';
import { encodeMessage } from '../transport/compact';
import { frameToText, LINKS, toFrames, type LinkKind } from '../transport/frames';

interface Props {
  record: ClinicalRecord;
  /** Hand frames to the receiver card on this device (demo of an offline link). */
  onDeliver: (lines: string[]) => void;
  onClose: () => void;
}

interface Built {
  frames: string[];
  frameBytes: number[];
  messageBytes: number;
  qr: string[];
}

export function SendPanel({ record, onDeliver, onClose }: Props) {
  const [link, setLink] = useState<LinkKind>('lora');
  const [built, setBuilt] = useState<Built | null>(null);
  const [lost, setLost] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const fhirBytes = new TextEncoder().encode(JSON.stringify(toFhirBundle(record))).length;

  useEffect(() => {
    let live = true;
    (async () => {
      const message = await encodeMessage(record, await deviceKey());
      const raw = await toFrames(message, LINKS[link].frameBytes);
      const frames = raw.map(frameToText);
      const qr = await Promise.all(frames.map((f) => QRCode.toDataURL(f, { errorCorrectionLevel: 'M', margin: 1, width: 168 })));
      if (live) { setBuilt({ frames, frameBytes: raw.map((f) => f.length), messageBytes: message.length, qr }); setLost(new Set()); }
    })().catch((e) => live && setError(String(e)));
    return () => { live = false; };
  }, [record, link]);

  const toggleLost = (i: number) => {
    const next = new Set(lost);
    if (next.has(i)) next.delete(i); else next.add(i);
    setLost(next);
  };
  const copyAll = () => navigator.clipboard?.writeText(built!.frames.join('\n')).catch(() => {});

  return (
    <div class="send">
      <div class="row spread">
        <div class="row">
          <b>Send offline</b>
          <select value={link} onChange={(e) => setLink((e.target as HTMLSelectElement).value as LinkKind)}>
            {Object.entries(LINKS).map(([k, l]) => <option key={k} value={k}>{l.label} · {l.frameBytes} B frames</option>)}
          </select>
        </div>
        <button class="small ghost" onClick={onClose}>Close</button>
      </div>
      {error && <p class="error">{error}</p>}
      {built && (
        <>
          <p class="hint">
            {built.frames.length} frame(s), {built.messageBytes} bytes signed + compressed, vs {fhirBytes} bytes as full FHIR JSON
            ({Math.round((100 * built.messageBytes) / fhirBytes)}%). Each frame has its own CRC-32; the whole message is ECDSA-signed.
          </p>
          <ol class="frames">
            {built.frames.map((f, i) => (
              <li key={f} class={lost.has(i) ? 'lost' : ''}>
                <img src={built.qr[i]} alt={`QR code for frame ${i + 1}`} width={120} height={120} />
                <div>
                  <div class="row">
                    <b>Frame {i + 1}/{built.frames.length}</b>
                    <span class="hint">{built.frameBytes[i]} bytes · {f.length} chars</span>
                    <label class="inline"><input type="checkbox" checked={lost.has(i)} onChange={() => toggleLost(i)} /> lose in transit</label>
                  </div>
                  <code class="frame-text">{f}</code>
                </div>
              </li>
            ))}
          </ol>
          <div class="row">
            <button class="primary small" onClick={() => onDeliver(built.frames.filter((_, i) => !lost.has(i)))}>
              Deliver {built.frames.length - lost.size} frame(s) to receiver ↓
            </button>
            <button class="small" onClick={copyAll}>Copy all frames</button>
            <a class="button small" href={`sms:?body=${encodeURIComponent(built.frames.join('\n'))}`}>Open in SMS app</a>
          </div>
        </>
      )}
    </div>
  );
}
