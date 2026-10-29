import type { AsrRequest, AsrResponse } from './asr.worker';
import type { AsrSegment } from './timing';

export const MODELS = {
  tiny: 'onnx-community/whisper-tiny.en',
  base: 'onnx-community/whisper-base.en',
} as const;

type Progress = (file: string, pct: number) => void;

let worker: Worker | null = null;
const getWorker = () => (worker ??= new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' }));

function call(req: AsrRequest, onProgress?: Progress): Promise<AsrResponse> {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const handler = (e: MessageEvent<AsrResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') return onProgress?.(msg.file, msg.progress);
      w.removeEventListener('message', handler);
      if (msg.type === 'error') reject(new Error(msg.message));
      else resolve(msg);
    };
    w.addEventListener('message', handler);
    w.postMessage(req);
  });
}

/** Download (first time) and initialise the model. Afterwards it works offline. */
export async function prepareModel(model: string, onProgress?: Progress): Promise<void> {
  await call({ type: 'load', model }, onProgress);
}

export async function transcribe(model: string, audio: Float32Array, onProgress?: Progress): Promise<{ text: string; ms: number; segments: AsrSegment[] }> {
  const res = await call({ type: 'transcribe', model, audio }, onProgress);
  if (res.type !== 'result') throw new Error('Unexpected ASR response');
  return { text: res.text, ms: res.ms, segments: res.segments };
}
