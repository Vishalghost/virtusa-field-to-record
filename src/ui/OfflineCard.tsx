import { useEffect, useState } from 'preact/hooks';
import { MODELS, modelInstalled, prepareModel } from '../asr/asrClient';

export type ModelKey = keyof typeof MODELS;

interface Props {
  model: ModelKey;
  onModel: (m: ModelKey) => void;
  ready: boolean;
  onReady: () => void;
}

export function OfflineCard({ model, onModel, ready, onReady }: Props) {
  const [online, setOnline] = useState(navigator.onLine);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Record<string, boolean>>({});

  // Only offer models whose files are on the server; fall back to one that is.
  useEffect(() => {
    (async () => {
      const keys = Object.keys(MODELS) as ModelKey[];
      const found = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await modelInstalled(MODELS[k])] as const)));
      setInstalled(found);
      if (found[model] === false) {
        const other = keys.find((k) => found[k]);
        if (other) onModel(other);
      }
    })();
  }, []);

  useEffect(() => {
    const up = () => setOnline(navigator.onLine);
    addEventListener('online', up);
    addEventListener('offline', up);
    return () => { removeEventListener('online', up); removeEventListener('offline', up); };
  }, []);

  const prepare = async () => {
    setBusy(true);
    setError(null);
    try {
      await prepareModel(MODELS[model], (file, pct) => setProgress((p) => ({ ...p, [file]: pct })));
      onReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const files = Object.entries(progress).filter(([f]) => f.endsWith('.onnx'));
  return (
    <section class="card offline">
      <div class="row">
        <span class={`badge ${online ? 'ok' : 'warn'}`}>{online ? 'Online' : 'Offline'}</span>
        <span class={`badge ${ready ? 'ok' : 'muted'}`}>{ready ? 'Speech model ready' : 'Speech model not loaded'}</span>
        <label class="inline">
          Model
          <select value={model} disabled={busy} onChange={(e) => onModel((e.target as HTMLSelectElement).value as ModelKey)}>
            <option value="tiny" disabled={installed.tiny === false}>Whisper tiny.en (~45 MB, fastest){installed.tiny === false ? ' (not installed)' : ''}</option>
            <option value="base" disabled={installed.base === false}>Whisper base.en (~80 MB, more accurate){installed.base === false ? ' (not installed)' : ''}</option>
          </select>
        </label>
        <button class="secondary" disabled={busy || ready} onClick={prepare}>
          {busy ? 'Loading…' : ready ? 'Ready for offline' : 'Prepare for offline'}
        </button>
      </div>
      {busy && files.map(([f, p]) => (
        <div class="progress" key={f}><span>{f.split('/').pop()}</span><progress max={100} value={p} /></div>
      ))}
      {error && <p class="error">Model failed to load: {error}. Run <code>npm run fetch-models{model === 'base' ? ' -- base' : ''}</code> on the build machine.</p>}
    </section>
  );
}
