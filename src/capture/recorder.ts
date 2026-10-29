// Microphone capture and audio decoding to what Whisper expects: 16 kHz mono Float32.

const SAMPLE_RATE = 16000;

export async function decodeTo16kMono(data: ArrayBuffer): Promise<Float32Array> {
  // An AudioContext at 16 kHz resamples during decode.
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const buf = await ctx.decodeAudioData(data);
    if (buf.numberOfChannels === 1) return buf.getChannelData(0);
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < ch.length; i++) out[i] += ch[i] / buf.numberOfChannels;
    }
    return out;
  } finally {
    await ctx.close();
  }
}

export interface Recording {
  stop(): Promise<Float32Array>;
  cancel(): void;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true } });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();
  const release = () => stream.getTracks().forEach((t) => t.stop());

  return {
    stop: () =>
      new Promise((resolve, reject) => {
        rec.onstop = async () => {
          release();
          try {
            resolve(await decodeTo16kMono(await new Blob(chunks, { type: rec.mimeType }).arrayBuffer()));
          } catch (err) {
            reject(err);
          }
        };
        rec.stop();
      }),
    cancel: () => {
      rec.onstop = null;
      if (rec.state !== 'inactive') rec.stop();
      release();
    },
  };
}
