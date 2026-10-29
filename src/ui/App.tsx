import { useEffect, useState } from 'preact/hooks';
import { chromeSpeechMode, installOnDevice, type ChromeMode } from '../asr/chromeSpeech';
import { amend, createDraft, type SpeechInfo } from '../record/record';
import { readbackText, speakLocally } from './readback';
import type { ClinicalRecord } from '../record/schema';
import { deleteDraft, listDrafts, listSigned, saveDraft, signAndStore } from '../store/db';
import { CaptureCard } from './CaptureCard';
import { OfflineCard, type Engine, type ModelKey } from './OfflineCard';
import { ReceiveCard } from './ReceiveCard';
import { RecordsCard } from './RecordsCard';
import { ReviewCard } from './ReviewCard';

const loadEngine = (): Engine => { try { return localStorage.getItem('ftr.engine') === 'chrome' ? 'chrome' : 'whisper'; } catch { return 'whisper'; } };

const newIncidentId =() => `INC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

export function App() {
  const [model, setModel] = useState<ModelKey>('tiny');
  const [modelReady, setModelReady] = useState(false);
  const [incidentId, setIncidentId] = useState(newIncidentId);
  const [draft, setDraft] = useState<ClinicalRecord | null>(null);
  const [signed, setSigned] = useState<ClinicalRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inbox, setInbox] = useState('');
  const [engine, setEngine] = useState<Engine>(loadEngine);
  const [chromeMode, setChromeMode] = useState<ChromeMode>('unavailable');

  const chooseEngine = (e: Engine) => {
    setEngine(e);
    try { localStorage.setItem('ftr.engine', e); } catch { /* storage unavailable */ }
  };

  useEffect(() => {
    chromeSpeechMode().then(setChromeMode);
    listSigned().then(setSigned);
    // Resume an unfinished draft after a reload or crash.
    listDrafts().then((d) => d.length && setDraft(d.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0]));
  }, []);

  const update = (r: ClinicalRecord) => {
    setDraft(r);
    saveDraft(r).catch((e) => setError(String(e)));
  };

  const extract = (t: string, src: 'voice' | 'text', speech?: SpeechInfo, handsFree = false) => {
    const d = createDraft(t, src, incidentId, new Date(), speech);
    update(d);
    // Hands-free: the medic never saw the text, so say what was understood and what needs checking.
    if (handsFree) speakLocally(readbackText(d)).catch(() => {});
  };

  const sign = async (signer: string) => {
    try {
      await signAndStore(draft!, signer);
      await deleteDraft(draft!.id).catch(() => {});
      setDraft(null);
      setSigned(await listSigned());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main>
      <header>
        <h1>Field-to-Record</h1>
        <p>
          On-scene dictation → structured, timestamped medication &amp; procedure record.{' '}
          {engine === 'chrome' && chromeMode !== 'on-device'
            ? <b class="warn-text">Speech is sent to Google while Chrome speech is in online mode.</b>
            : 'Runs entirely on this device.'}
        </p>
        <label class="inline">
          Incident
          <input value={incidentId} onInput={(e) => setIncidentId((e.target as HTMLInputElement).value)} />
        </label>
      </header>
      <OfflineCard
        model={model}
        onModel={(m) => { setModel(m); setModelReady(false); }}
        ready={modelReady}
        onReady={() => setModelReady(true)}
        engine={engine}
        onEngine={chooseEngine}
        chromeMode={chromeMode}
        onInstallChrome={async () => { await installOnDevice(); setChromeMode(await chromeSpeechMode()); }}
      />
      {error && <p class="error" onClick={() => setError(null)}>{error}</p>}
      {draft
        ? <ReviewCard draft={draft} onChange={update} onSign={sign} onDiscard={() => { deleteDraft(draft.id); setDraft(null); }} />
        : <CaptureCard model={model} engine={engine} chromeMode={chromeMode} onModelUsed={() => setModelReady(true)} onExtract={extract} />}
      <RecordsCard
        records={signed}
        onAmend={(r) => update(amend(r))}
        onDeliver={(lines) => setInbox((prev) => [...prev.split('\n').filter(Boolean), ...lines].join('\n'))}
      />
      <ReceiveCard inbox={inbox} onInbox={setInbox} />
    </main>
  );
}
