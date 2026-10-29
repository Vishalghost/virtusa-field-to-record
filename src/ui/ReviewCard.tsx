import { useState } from 'preact/hooks';
import { DRUGS, drugByName } from '../nlp/lexicon';
import { UNITS } from '../nlp/extract';
import { addMedication, confirmEvent, editMedication, editProcedure, removeEvent, signingBlockers } from '../record/record';
import type { ClinicalRecord, ClinicalEvent, ReviewFlag, Span, TimeSource } from '../record/schema';
import { ROUTE_NAMES } from '../render/format';
import { readbackText, speakLocally, speechAvailable } from './readback';

interface Props {
  draft: ClinicalRecord;
  onChange: (r: ClinicalRecord) => void;
  onSign: (signer: string) => void;
  onDiscard: () => void;
}

const DRUG_NAMES = DRUGS.map((d) => d.name).sort();
const ROUTES = Object.keys(ROUTE_NAMES);

/** Transcript with the source text of every event underlined; the hovered event is highlighted. */
function Transcript({ text, events, active }: { text: string; events: ClinicalEvent[]; active: string | null }) {
  const marks: (Span & { id: string; kind: string })[] = events.flatMap((e) => e.sourceSpans.map((s) => ({ ...s, id: e.id, kind: e.kind })));
  marks.sort((a, b) => a.start - b.start);
  const parts: preact.JSX.Element[] = [];
  let pos = 0;
  for (const m of marks) {
    if (m.start < pos) continue; // overlapping spans: first one wins
    parts.push(<span key={`t${pos}`}>{text.slice(pos, m.start)}</span>);
    parts.push(<mark key={`m${m.start}`} class={`${m.kind} ${m.id === active ? 'active' : ''}`}>{text.slice(m.start, m.end)}</mark>);
    pos = m.end;
  }
  parts.push(<span key="tail">{text.slice(pos)}</span>);
  return <blockquote class="transcript">{parts}</blockquote>;
}

const TIME_TITLE: Record<TimeSource, string> = {
  dictated: 'Time said in the dictation',
  spoken: 'Device clock when this was spoken. Change it if it was given earlier.',
  entered: 'Device clock when the note was entered. Change it if it was given earlier.',
  edited: 'Set by hand',
};
const TimeTag = ({ source }: { source?: TimeSource }) =>
  source ? <small class="code" title={TIME_TITLE[source]}>{source === 'dictated' ? 'said' : source === 'edited' ? 'edited' : 'auto (clock)'}</small> : null;

const Flags = ({ flags, confirmed }: { flags: ReviewFlag[]; confirmed: boolean }) => (
  <ul class="flags">
    {flags.map((f) => <li key={f.reason} class={confirmed && f.severity === 'block' ? 'resolved' : f.severity}>{f.reason}</li>)}
  </ul>
);

export function ReviewCard({ draft, onChange, onSign, onDiscard }: Props) {
  const [active, setActive] = useState<string | null>(null);
  const [signer, setSigner] = useState(() => { try { return localStorage.getItem('ftr.signer') ?? ''; } catch { return ''; } });
  const [speechNote, setSpeechNote] = useState<string | null>(null);
  const readBack = async () => {
    const text = readbackText(draft);
    setSpeechNote((await speakLocally(text)) ? null : `No on-device voice available; read it yourself: "${text}"`);
  };
  const blockers = signingBlockers(draft);
  const val = (e: Event) => (e.target as HTMLInputElement).value;
  const nul = (s: string) => (s.trim() === '' ? null : s.trim());

  const actions = (id: string, confirmed: boolean) => (
    <td class="actions">
      <button class="small" disabled={confirmed} onClick={() => onChange(confirmEvent(draft, id))}>{confirmed ? '✓' : 'Confirm'}</button>
      <button class="small ghost" title="Remove" onClick={() => onChange(removeEvent(draft, id))}>✕</button>
    </td>
  );

  return (
    <section class="card">
      <h2>2 · Review</h2>
      <p class="hint">Underlined text is where each item came from. Hover a row to see its source. Editing a field logs the change and confirms the item.</p>
      <Transcript text={draft.transcript} events={[...draft.medications, ...draft.procedures]} active={active} />
      {draft.rawTranscript && (
        <p class="hint">
          Speech model heard: “{draft.rawTranscript}”. Fixed: {draft.speechRepairs!.map((r) => `“${r.heard}” → “${r.readAs}”`).join(', ')}. Items built from these need confirming.
        </p>
      )}

      <h3>Medications</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Medication</th><th>Dose</th><th>Unit</th><th>Route</th><th>Site</th><th>Time</th><th>Checks</th><th /></tr></thead>
          <tbody>
            {draft.medications.map((m) => (
              <tr key={m.id} class={m.confirmed ? 'confirmed' : ''} onMouseEnter={() => setActive(m.id)} onMouseLeave={() => setActive(null)}>
                <td>
                  <select value={m.drug ?? ''} onChange={(e) => onChange(editMedication(draft, m.id, 'drug', nul(val(e))))}>
                    <option value="">— unidentified —</option>
                    {DRUG_NAMES.map((d) => <option key={d}>{d}</option>)}
                  </select>
                  {m.rxnorm && <small class="code">RxNorm {m.rxnorm}</small>}
                  {m.confidence < 0.85 && m.drug && <small class="code warn">match {Math.round(m.confidence * 100)}%</small>}
                </td>
                <td><input class="num" inputMode="decimal" value={m.dose ?? ''} onChange={(e) => { const v = nul(val(e)); onChange(editMedication(draft, m.id, 'dose', v === null ? null : Number(v))); }} /></td>
                <td>
                  <select value={m.unit ?? ''} onChange={(e) => onChange(editMedication(draft, m.id, 'unit', nul(val(e))))}>
                    <option value="">—</option>
                    {UNITS.map((u) => <option key={u}>{u}</option>)}
                  </select>
                </td>
                <td>
                  <select value={m.route ?? ''} onChange={(e) => onChange(editMedication(draft, m.id, 'route', nul(val(e))))}>
                    <option value="">—</option>
                    {ROUTES.map((r) => (
                      <option key={r} value={r}>{ROUTE_NAMES[r]}{m.drug && !drugByName(m.drug)?.routes.includes(r) ? ' (unusual)' : ''}</option>
                    ))}
                  </select>
                </td>
                <td><input value={m.site ?? ''} onChange={(e) => onChange(editMedication(draft, m.id, 'site', nul(val(e))))} /></td>
                <td>
                  <input type="time" value={m.administeredAt ?? ''} onChange={(e) => onChange(editMedication(draft, m.id, 'administeredAt', nul(val(e))))} />
                  <TimeTag source={m.timeSource} />
                </td>
                <td><Flags flags={m.flags} confirmed={m.confirmed} /></td>
                {actions(m.id, m.confirmed)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button class="small secondary" onClick={() => onChange(addMedication(draft))}>+ Add medication</button>

      <h3>Procedures</h3>
      {draft.procedures.length === 0 ? <p class="hint">None detected.</p> : (
        <div class="table-wrap">
          <table>
            <thead><tr><th>Procedure</th><th>Detail</th><th>Site</th><th>Time</th><th>Checks</th><th /></tr></thead>
            <tbody>
              {draft.procedures.map((p) => (
                <tr key={p.id} class={p.confirmed ? 'confirmed' : ''} onMouseEnter={() => setActive(p.id)} onMouseLeave={() => setActive(null)}>
                  <td>{p.procedure}</td>
                  <td><input value={p.detail ?? ''} onChange={(e) => onChange(editProcedure(draft, p.id, 'detail', nul(val(e))))} /></td>
                  <td><input value={p.site ?? ''} onChange={(e) => onChange(editProcedure(draft, p.id, 'site', nul(val(e))))} /></td>
                  <td>
                    <input type="time" value={p.performedAt ?? ''} onChange={(e) => onChange(editProcedure(draft, p.id, 'performedAt', nul(val(e))))} />
                    <TimeTag source={p.timeSource} />
                  </td>
                  <td><Flags flags={p.flags} confirmed={p.confirmed} /></td>
                  {actions(p.id, p.confirmed)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>3 · Sign &amp; lock</h2>
      <div class="row">
        <input
          placeholder="Your provider ID"
          value={signer}
          onInput={(e) => { setSigner(val(e)); try { localStorage.setItem('ftr.signer', val(e)); } catch { /* storage unavailable */ } }}
        />
        <button class="primary" disabled={blockers.length > 0 || !signer.trim()} onClick={() => onSign(signer.trim())}>
          Sign &amp; lock
        </button>
        {speechAvailable() && <button class="secondary" title="Speak the record aloud with an on-device voice" onClick={readBack}>🔊 Read back</button>}
        <button class="ghost" onClick={onDiscard}>Discard draft</button>
      </div>
      {speechNote && <p class="hint">{speechNote}</p>}
      {blockers.length > 0 && <p class="error">{blockers.length} item(s) need review before signing (red checks).</p>}
      <p class="hint">Signing hashes this record together with the previous record's hash. After that it can't be edited, only amended.</p>
    </section>
  );
}
