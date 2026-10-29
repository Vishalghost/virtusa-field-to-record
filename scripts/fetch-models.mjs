// Dev-time setup: download the Whisper ONNX model and the ONNX Runtime WASM files
// into public/ so the app serves everything itself and never needs the network at
// run time. (transformers.js would otherwise pull the runtime from cdn.jsdelivr.net.)
//
// Usage: npm run fetch-models [-- base]     (default: tiny)

import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const size = process.argv[2] === 'base' ? 'base' : 'tiny';
const repo = `onnx-community/whisper-${size}.en`;
const files = [
  'config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json',
  'added_tokens.json', 'special_tokens_map.json', 'vocab.json', 'merges.txt', 'normalizer.json',
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx',
];

for (const f of files) {
  const dest = join(root, 'public', 'models', repo, f);
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`have  ${f}`);
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(`https://huggingface.co/${repo}/resolve/main/${f}`);
  if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log(`got   ${f} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
}

const ortSrc = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const ortDest = join(root, 'public', 'ort');
mkdirSync(ortDest, { recursive: true });
for (const f of readdirSync(ortSrc).filter((x) => /^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/.test(x))) {
  copyFileSync(join(ortSrc, f), join(ortDest, f));
  console.log(`copied ort/${f}`);
}
console.log(`\nModel ready: ${repo}`);
