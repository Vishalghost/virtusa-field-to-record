// Dev check: transcribe WAVs with the same local Whisper files the PWA uses, then
// run the extraction pipeline on the transcript. Proves the speech path end-to-end
// without a browser. Usage: node scripts/asr-node.mjs data/synthetic/audio/*.wav
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
env.allowRemoteModels = false;
env.localModelPath = join(root, 'public', 'models') + '/';

/** Minimal 16-bit PCM mono WAV reader. */
function readWav(path) {
  const b = readFileSync(path);
  let off = 12;
  while (off < b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') {
      const pcm = new Float32Array(size / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return pcm;
    }
    off += 8 + size;
  }
  throw new Error('no data chunk');
}

const asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', { dtype: 'q8' });
for (const f of process.argv.slice(2)) {
  const t0 = Date.now();
  const { text } = await asr(readWav(f), { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });
  console.log(`${f} (${Date.now() - t0} ms)\n  ${text.trim()}`);
}
