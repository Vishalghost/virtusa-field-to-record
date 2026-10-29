import { useRef, useState } from 'preact/hooks';
import samples from '../../data/synthetic/dictations.json';
import { MODELS, transcribe } from '../asr/asrClient';
import { decodeTo16kMono, startRecording, type Recording } from '../capture/recorder';
import type { ModelKey } from './OfflineCard';

interface Props {
  model: ModelKey;
  onModelUsed: () => void;
  onExtract: (transcript: string, source: 'voice' | 'text') => void;
}

export function CaptureCard({ model, onModelUsed, onExtract }: Props) {
  const [text, setText] = useState('');
  const [source, setSource] = useState<'voice' | 'text'>('text');
  const [status, setStatus] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const rec = useRef<Recording | null>(null);

  const runAsr = async (audio: Float32Array) => {
    setStatus(`Transcribing ${(audio.length / 16000).toFixed(1)} s of audio on-device…`);
    try {
      const { text: t, ms } = await transcribe(MODELS[model], audio, () => setStatus('Loading speech model…'));
      onModelUsed();
      setText((prev) => (prev ? `${prev} ${t}` : t));
      setSource('voice');
      setStatus(`Transcribed in ${(ms / 1000).toFixed(1)} s. Check the text, then extract.`);
    } catch (e) {
      setStatus(`Transcription failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const toggleMic = async () => {
    if (recording) {
      setRecording(false);
      const audio = await rec.current!.stop();
      rec.current = null;
      await runAsr(audio);
      return;
    }
    try {
      rec.current = await startRecording();
      setRecording(true);
      setStatus('Recording… tap again to stop.');
    } catch (e) {
      setStatus(`Microphone unavailable: ${e instanceof Error ? e.message : e}`);
    }
  };

  const onFile = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    await runAsr(await decodeTo16kMono(await file.arrayBuffer()));
    (e.target as HTMLInputElement).value = '';
  };

  return (
    <section class="card">
      <h2>1 · Capture</h2>
      <div class="row">
        <button class={recording ? 'danger big' : 'primary big'} onClick={toggleMic}>
          {recording ? '■ Stop' : '● Dictate'}
        </button>
        <label class="button secondary">
          Audio file…
          <input type="file" accept="audio/*" hidden onChange={onFile} />
        </label>
        <select
          aria-label="Load a synthetic sample"
          onChange={(e) => {
            const s = samples.find((x) => x.id === (e.target as HTMLSelectElement).value);
            if (s) { setText(s.text); setSource('text'); setStatus(null); }
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
        placeholder="Dictate, or type the on-scene note, e.g. “Gave 0.3 mg epi IM right thigh at 14:32. Started 18g IV left AC.”"
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      <div class="row end">
        <span class="hint">No real patient information. Synthetic dictations only.</span>
        <button class="primary" disabled={!text.trim() || recording} onClick={() => { onExtract(text.trim(), source); setText(''); setStatus(null); }}>
          Extract record →
        </button>
      </div>
    </section>
  );
}
