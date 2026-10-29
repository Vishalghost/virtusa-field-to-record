import { useEffect, useMemo, useState } from 'preact/hooks';
import { keyFingerprint } from '../record/signing';
import type { TimeSource } from '../record/schema';
import { ROUTE_NAMES, TIME_LABEL } from '../render/format';
import { deviceKey } from '../store/db';
import { decodeMessage, type DecodedMessage } from '../transport/compact';
import { reassemble } from '../transport/frames';

interface Props {
  inbox: string;
  onInbox: (text: string) => void;
}

const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
const when = (t: string | null, source: TimeSource | undefined, recordedAt: string) =>
  t ? t + TIME_LABEL[source ?? 'dictated'] : `${hhmm(recordedAt)} (capture)`;

/** The doctor's side: paste or receive frames, see what is missing, verify, read the record. */
export function ReceiveCard({ inbox, onInbox }: Props) {
  const status = useMemo(() => reassemble(inbox.split(/\s+/)), [inbox]);
  const [decoded, setDecoded] = useState<DecodedMessage | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [ownFingerprint, setOwnFingerprint] = useState<string | null>(null);

  useEffect(() => { deviceKey().then((k) => keyFingerprint(k.publicKey)).then(setOwnFingerprint).catch(() => {}); }, []);
  useEffect(() => {
    setDecoded(null);
    setDecodeError(null);
    if (status.message) decodeMessage(status.message).then(setDecoded).catch(() => setDecodeError('Frames are complete but the message could not be decoded.'));
  }, [status.message]);

  const r = decoded?.record;
  return (
    <section class="card">
      <div class="row spread">
        <h2>5 · Receive (doctor's device)</h2>
        <button class="small ghost" disabled={!inbox} onClick={() => onInbox('')}>Clear</button>
      </div>
      <p class="hint">Frames arrive by LoRa, SMS, BLE or QR, in any order. Paste them here, one per line. Only missing frames need resending.</p>
      <textarea rows={4} placeholder="F2R:…" value={inbox} onInput={(e) => onInbox((e.target as HTMLTextAreaElement).value)} />

      {status.total > 0 && (
        <p class={status.missing.length ? 'status' : 'ok-text'}>
          {status.received.length}/{status.total} frames
          {status.missing.length > 0 && <> · missing frame {status.missing.map((i) => i + 1).join(', ')}: ask the sender to resend {status.missing.length === 1 ? 'it' : 'them'}</>}
        </p>
      )}
      {status.rejected > 0 && <p class="error">{status.rejected} frame(s) failed the CRC check (corrupted) and were dropped.</p>}
      {status.foreign > 0 && <p class="hint">{status.foreign} frame(s) belong to a different message and were ignored.</p>}
      {decodeError && <p class="error">{decodeError}</p>}

      {decoded && !r && <p class="error">✕ Signature INVALID and the content is unreadable: the message was corrupted or altered. Ask for a resend.</p>}
      {decoded && r && (
        <div class="received">
          {decoded.signatureValid
            ? <p class="ok-text">✓ Signature valid · device <code>{decoded.fingerprint}</code>{decoded.fingerprint === ownFingerprint ? ' (this device)' : ''}. Check it matches the responder's enrolled device.</p>
            : <p class="error">✕ Signature INVALID: the content was changed after sending, or was not sent by key <code>{decoded.fingerprint}</code>. Do not rely on this record.</p>}
          <p>
            <b>{r.incidentId}</b> v{r.version} · signed by {r.signedBy} at {new Date(r.signedAt).toLocaleString()}
            <span class="hint"> · record hash <code title={r.hash}>{r.hash.slice(0, 12)}…</code></span>
          </p>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Medication</th><th>Dose</th><th>Route</th><th>Site</th><th>Confirmed</th></tr></thead>
              <tbody>
                {r.medications.map((m, i) => (
                  <tr key={i}>
                    <td>{when(m.time, m.timeSource, r.recordedAt)}</td><td>{m.drug ?? '— unidentified —'}</td>
                    <td>{m.dose !== null ? `${m.dose} ${m.unit ?? '?'}` : '—'}</td><td>{m.route ? ROUTE_NAMES[m.route] ?? m.route : '—'}</td>
                    <td>{m.site ?? ''}</td><td>{m.confirmed ? 'yes' : 'no'}</td>
                  </tr>
                ))}
                {r.procedures.map((p, i) => (
                  <tr key={`p${i}`}>
                    <td>{when(p.time, p.timeSource, r.recordedAt)}</td><td colSpan={2}>{p.procedure}{p.detail ? ` (${p.detail})` : ''}</td>
                    <td>—</td><td>{p.site ?? ''}</td><td>{p.confirmed ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
