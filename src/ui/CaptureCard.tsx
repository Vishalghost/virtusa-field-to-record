import { useRef, useState } from 'preact/hooks';
import samples from '../../data/synthetic/dictations.json';
import testLines from '../../data/real/script.json';
import { MODELS, transcribe } from '../asr/asrClient';
import { CHROME_LANG, startChromeSpeech, type ChromeMode, type ChromeSession } from '../asr/chromeSpeech';
import { repairTranscript } from '../asr/repair';
import type { AsrSegment } from '../asr/timing';
import { decodeTo16kMono, startRecording, type Recording } from '../capture/recorder';
import { encodeWav } from '../capture/wav';
import type { SpeechInfo } from '../record/record';
import { download } from './download';
import type { Engine, ModelKey } from './OfflineCard';

interface Props {
  model: ModelKey;
  engine: Engine;
  chromeMode: ChromeMode;
  onModelUsed: () => void;
  /** `handsFree`: the medic never looked at the text, so the app should read the result back. */
  onExtract: (transcript: string, source: 'voice' | 'text', speech?: SpeechInfo, handsFree?: boolean) => void;
}

const loadFlag = (k: string, dflt: boolean) => { try { const v = localStorage.getItem(k); return v === null ? dflt : v === '1'; } catch { return dflt; } };
const saveFlag = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* storage unavailable */ } };

export function CaptureCard({ model, engine, chromeMode, onModelUsed, onExtract }: Props) {
  const [text, setText] = useState('');
  const [source, setSource] = useState<'voice' | 'text'>('text');
  const [status, setStatus] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [handsFree, setHandsFree] = useState(() => loadFlag('ftr.handsFree', true));
  const rec = useRef<Recording | null>(null);
  const chromeRec = useRef<ChromeSession | null>(null);
  const recStartedAt = useRef(0);
  // Speech output + repairs for the text currently in the box (dropped if the text is edited).
  const speech = useRef<(SpeechInfo & { text: string }) | null>(null);

  /**
   * Shared by both engines: repair, then either extract straight away (hands-free) or
   * put the text in the box for checking. `startedAt` is the device clock when speech began.
   */
  const handleHeard = (heard: string, startedAt: number, segments: AsrSegment[], engineId: string, timing: string) => {
    if (!heard.trim()) {
      setStatus('Nothing was heard. Check the microphone and try again.');
      return;
    }
    const fixed = repairTranscript(heard);
    const info: SpeechInfo = { rawTranscript: heard, repairs: fixed.repairs, startedAt, segments, engine: engineId };
    const fixNote = fixed.repairs.length ? ` Speech fix-ups: ${fixed.repairs.map((r) => `"${r.heard}" → "${r.readAs}"`).join(', ')}.` : '';
    if (handsFree) {
      setStatus(null);
      onExtract(fixed.text, 'voice', info, true);
      return;
    }
    speech.current = text.trim() ? null : { ...info, text: fixed.text };
    setText((prev) => (prev ? `${prev} ${fixed.text}` : fixed.text));
    setSource('voice');
    setStatus(`${timing}${fixNote} Check the text, then extract.`);
  };

  /** Whisper path: transcribe recorded audio on the device. */
  const runAsr = async (audio: Float32Array, startedAt: number) => {
    setStatus(`Transcribing ${(audio.length / 16000).toFixed(1)} s of audio on-device…`);
    try {
      const { text: heard, ms, segments } = await transcribe(MODELS[model], audio, () => setStatus('Loading speech model…'));
      onModelUsed();
      handleHeard(heard, startedAt, segments, `whisper:${model}.en`, `Transcribed in ${(ms / 1000).toFixed(1)} s.`);
    } catch (e) {
      setStatus(`Transcription failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  /** Chrome path: Chrome transcribes while the medic speaks; Stop returns the text. */
  const toggleChrome = async () => {
    if (recording) {
      setRecording(false);
      const r = await chromeRec.current!.stop();
      chromeRec.current = null;
      const engineId = `chrome-${chromeMode === 'on-device' ? 'on-device' : 'online'}:${CHROME_LANG}`;
      handleHeard(r.text, r.startedAt, r.segments, engineId, 'Recognized by Chrome.');
      return;
    }
    try {
      chromeRec.current = startChromeSpeech(
        chromeMode,
        (live) => setStatus(live ? `Hearing: “${live}”` : 'Listening…'),
        (msg) => { chromeRec.current?.cancel(); chromeRec.current = null; setRecording(false); setStatus(msg); },
      );
      setRecording(true);
      setStatus(chromeMode === 'on-device' ? 'Listening on this device… tap Stop when done.' : 'Listening (online: audio goes to Google)… tap Stop when done.');
    } catch (e) {
      setStatus(`Chrome speech unavailable: ${e instanceof Error ? e.message : e}`);
    }
  };

  const toggleMic = async () => {
    if (engine === 'chrome') return toggleChrome();
    if (recording) {
      setRecording(false);
      const audio = await rec.current!.stop();
      rec.current = null;
      await runAsr(audio, recStartedAt.current);
      return;
    }
    try {
      rec.current = await startRecording();
      recStartedAt.current = Date.now();
      setRecording(true);
      setStatus(handsFree ? 'Recording… tap Stop when done; the record opens for review automatically.' : 'Recording… tap again to stop.');
    } catch (e) {
      setStatus(`Microphone unavailable: ${e instanceof Error ? e.message : e}`);
    }
  };

  const onFile = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const audio = await decodeTo16kMono(await file.arrayBuffer());
    // A file has no live clock: treat it as just recorded, ending now.
    await runAsr(audio, Date.now() - (audio.length / 16000) * 1000);
    (e.target as HTMLInputElement).value = '';
  };

  const extractTyped = () => {
    const t = text.trim();
    const s = speech.current && speech.current.text === t ? speech.current : undefined;
    onExtract(t, source, s);
    speech.current = null;
    setText('');
    setStatus(null);
  };

  return (
    <section class="card">
      <h2>1 · Capture</h2>
      <div class="row">
        <button class={recording ? 'danger big' : 'primary big'} onClick={toggleMic}>
          {recording ? '■ Stop' : '● Dictate'}
        </button>
        <label class="inline" title="Stop = transcribe, extract and read the record back, with no typing">
          <input type="checkbox" checked={handsFree} onChange={() => { setHandsFree(!handsFree); saveFlag('ftr.handsFree', !handsFree); }} />
          Hands-free
        </label>
        <label class="button secondary">
          Audio file…
          <input type="file" accept="audio/*" hidden onChange={onFile} />
        </label>
        <select
          aria-label="Load a synthetic sample"
          onChange={(e) => {
            const s = samples.find((x) => x.id === (e.target as HTMLSelectElement).value);
            if (s) { setText(s.text); setSource('text'); setStatus(null); speech.current = null; }
            (e.target as HTMLSelectElement).value = '';
          }}
        >
          <option value="">Load synthetic sample…</option>
          {samples.map((s) => <option key={s.id} value={s.id}>{s.id} · {s.tags.join(', ')}</option>)}
        </select>
      </div>
      {status && <p class="status">{status}</p>}
      <textarea
        rows={5}
        placeholder={handsFree
          ? 'Hands-free is on: tap Dictate, speak (English or Tanglish), tap Stop. Typing here also works.'
          : 'Dictate, or type the on-scene note, e.g. “Gave 0.3 mg epi IM right thigh at 14:32. Started 18g IV left AC.”'}
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      <div class="row end">
        <span class="hint">No real patient information. Synthetic dictations only.</span>
        <button class="primary" disabled={!text.trim() || recording} onClick={extractTyped}>
          Extract record →
        </button>
      </div>
      <TestLines disabled={recording} />
    </section>
  );
}

/**
 * Records the scripted test lines through the same microphone path as dictation and
 * saves each as <id>.wav, so `npm run eval:asr` can measure accuracy on real voices.
 */
function TestLines({ disabled }: { disabled: boolean }) {
  const [active, setActive] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recording | null>(null);

  const toggle = async (id: string) => {
    setError(null);
    if (active === id) {
      const audio = await rec.current!.stop();
      rec.current = null;
      setActive(null);
      download(`${id}.wav`, encodeWav(audio));
      setSaved(new Set(saved).add(id));
      return;
    }
    rec.current?.cancel();
    try {
      rec.current = await startRecording();
      setActive(id);
    } catch (e) {
      setError(`Microphone unavailable: ${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <details class="testlines">
      <summary>Record test lines (measure accuracy on real voices)</summary>
      <p class="hint">
        Read each line the way you would say it on scene. Each one downloads as <code>real-NN.wav</code>: move them into
        <code> data/real/</code> and run <code>npm run eval:asr</code>.
      </p>
      {error && <p class="error">{error}</p>}
      <ol>
        {testLines.map((l) => (
          <li key={l.id} class={active === l.id ? 'active' : ''}>
            <button class={active === l.id ? 'small danger' : 'small'} disabled={disabled || (active !== null && active !== l.id)} onClick={() => toggle(l.id)}>
              {active === l.id ? '■ Stop' : '● Record'}
            </button>
            <span><b>{l.id}</b> “{l.text}”</span>
            {saved.has(l.id) && <span class="ok-text">✓ saved</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}
