import { useState } from 'preact/hooks';
import type { ChainProblem } from '../record/audit';
import { toFhirBundle } from '../record/fhir';
import type { ClinicalRecord } from '../record/schema';
import { fileBase } from '../render/format';
import { renderHtml } from '../render/html';
import { renderPdf } from '../render/pdf';
import { verifyStoredChain } from '../store/db';
import { download } from './download';
import { SendPanel } from './SendPanel';

interface Props {
  records: ClinicalRecord[];
  onAmend: (r: ClinicalRecord) => void;
  onDeliver: (lines: string[]) => void;
}

export function RecordsCard({ records, onAmend, onDeliver }: Props) {
  const [check, setCheck] = useState<ChainProblem[] | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  const exportAs = (r: ClinicalRecord, kind: 'json' | 'fhir' | 'html' | 'pdf') => {
    const base = fileBase(r);
    if (kind === 'json') download(`${base}.json`, JSON.stringify(r, null, 2), 'application/json');
    if (kind === 'fhir') download(`${base}.fhir.json`, JSON.stringify(toFhirBundle(r), null, 2), 'application/fhir+json');
    if (kind === 'html') download(`${base}.html`, renderHtml(r), 'text/html');
    if (kind === 'pdf') download(`${base}.pdf`, renderPdf(r));
  };

  return (
    <section class="card">
      <div class="row spread">
        <h2>4 · Signed records ({records.length})</h2>
        <button class="secondary small" disabled={!records.length} onClick={async () => setCheck(await verifyStoredChain())}>Verify audit chain</button>
      </div>
      {check && (check.length === 0
        ? <p class="ok-text">✓ Chain intact: {records.length} record(s), no hash mismatches, broken links or bad signatures.</p>
        : <p class="error">✕ Chain problems: {check.map((p) => `#${p.index + 1} ${p.problem}`).join(', ')}</p>)}
      {records.length === 0 && <p class="hint">Nothing signed yet.</p>}
      <ul class="records">
        {[...records].reverse().map((r) => (
          <li key={r.id}>
            <div>
              <b>{r.incidentId}</b> v{r.version} · {r.medications.length} med(s), {r.procedures.length} procedure(s)
              <div class="hint">
                Signed by {r.signedBy} · {new Date(r.signedAt!).toLocaleString()} · <code title={r.hash!}>{r.hash!.slice(0, 12)}…</code>
                {r.signature ? ' · ECDSA device-signed' : ' · hash only (signed before device keys)'}
              </div>
            </div>
            <div class="row">
              <button class="small primary" onClick={() => setSending(sending === r.id ? null : r.id)}>Send</button>
              <button class="small" onClick={() => exportAs(r, 'pdf')}>PDF</button>
              <button class="small" onClick={() => exportAs(r, 'html')}>HTML</button>
              <button class="small" onClick={() => exportAs(r, 'fhir')}>FHIR</button>
              <button class="small" onClick={() => exportAs(r, 'json')}>JSON</button>
              <button class="small ghost" onClick={() => onAmend(r)}>Amend</button>
            </div>
            {sending === r.id && <SendPanel record={r} onDeliver={onDeliver} onClose={() => setSending(null)} />}
          </li>
        ))}
      </ul>
    </section>
  );
}
