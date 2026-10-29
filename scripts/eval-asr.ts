// Measures the full speech path on REAL recordings: Whisper (same local model files as
// the app) -> speech repairs -> extraction, scored against the gold labels in
// data/real/script.json. Prints each line as heard, as repaired, and as expected, then
// scores both raw and repaired transcripts so the repair layer's effect is visible.
//
// Recordings: data/real/<id>.wav (16 kHz mono 16-bit PCM, as saved by the app's
// "Record test lines" panel). Lines without a recording are skipped.
//
// Usage: npm run eval:asr [-- --verbose] [-- base] [-- --dir other/folder]

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { repairTranscript } from '../src/asr/repair';
import { score, type Item } from './score';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const model = `onnx-community/whisper-${args.includes('base') ? 'base' : 'tiny'}.en`;
env.allowRemoteModels = false;
env.localModelPath = join(root, 'public', 'models') + '/';

/** Minimal 16-bit PCM mono WAV reader. */
function readWav(path: string): Float32Array {
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
  throw new Error(`${path}: no data chunk`);
}

const dirArg = args.indexOf('--dir');
const audioDir = dirArg >= 0 ? args[dirArg + 1] : join(root, 'data', 'real');
const script: Item[] = JSON.parse(readFileSync(join(root, 'data', 'real', 'script.json'), 'utf8'));
const recorded = script.filter((s) => existsSync(join(audioDir, `${s.id}.wav`)));
if (!recorded.length) {
  console.log(`No recordings found in ${audioDir}. Use "Record test lines" in the app, then move the WAVs there.`);
  process.exit(0);
}

const asr = await pipeline('automatic-speech-recognition', model, { dtype: 'q8' });
const raw: Item[] = [];
const repaired: Item[] = [];
for (const s of recorded) {
  const out = await asr(readWav(join(audioDir, `${s.id}.wav`)), { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });
  const heard = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim();
  const fixed = repairTranscript(heard);
  console.log(`${s.id}  said:     ${s.text}\n         heard:    ${heard}\n         repaired: ${fixed.text}${fixed.repairs.length ? '' : '  (no repairs)'}\n`);
  raw.push({ ...s, text: heard });
  repaired.push({ ...s, text: fixed.text });
}

const verbose = args.includes('--verbose');
const a = score(raw, `\nRAW speech (${model})`, verbose);
const b = score(repaired, `\nREPAIRED speech (${model})`, verbose);
console.log(`\nRepair layer: ${a} -> ${b} fully correct records out of ${recorded.length}.`);
