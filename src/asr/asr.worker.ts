// Speech-to-text worker: runs Whisper (ONNX, quantized) entirely in the browser.
// Runs off the main thread so the UI stays responsive during transcription.

import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

// Everything is served by this app; never reach out to the Hugging Face hub or a CDN.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.backends.onnx.wasm!.wasmPaths = {
  mjs: '/ort/ort-wasm-simd-threaded.asyncify.mjs',
  wasm: '/ort/ort-wasm-simd-threaded.asyncify.wasm',
};

export type AsrRequest = { type: 'load'; model: string } | { type: 'transcribe'; model: string; audio: Float32Array };

export type AsrResponse =
  | { type: 'progress'; file: string; progress: number }
  | { type: 'ready'; model: string }
  | { type: 'result'; text: string; ms: number }
  | { type: 'error'; message: string };

let loaded: { model: string; asr: Promise<AutomaticSpeechRecognitionPipeline> } | null = null;

function load(model: string) {
  if (loaded?.model !== model) {
    loaded = {
      model,
      asr: pipeline('automatic-speech-recognition', model, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (p: { status: string; file?: string; progress?: number }) => {
          if (p.status === 'progress' && p.file) post({ type: 'progress', file: p.file, progress: p.progress ?? 0 });
        },
      }) as Promise<AutomaticSpeechRecognitionPipeline>,
    };
  }
  return loaded.asr;
}

const post = (msg: AsrResponse) => self.postMessage(msg);

self.onmessage = async (e: MessageEvent<AsrRequest>) => {
  try {
    const asr = await load(e.data.model);
    if (e.data.type === 'load') return post({ type: 'ready', model: e.data.model });
    const t0 = performance.now();
    // return_timestamps switches Whisper to long-form decoding; without it small models
    // often stop at the first long pause and silently drop the rest of the dictation.
    const out = await asr(e.data.audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });
    const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
    post({ type: 'result', text: text.trim(), ms: Math.round(performance.now() - t0) });
  } catch (err) {
    loaded = null;
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
