// Chrome's built-in speech recognition (Web Speech API), as an alternative to Whisper.
//
// Privacy: by default Chrome sends the audio to Google's servers. Recent Chrome can
// instead recognize on the device for some languages (en-IN, en-US; not ta-IN yet).
// `processLocally = true` makes Chrome FAIL rather than silently fall back to the
// cloud, so 'on-device' here is a guarantee, not a hope.

import type { AsrSegment } from './timing';

export const CHROME_LANG = 'en-IN';

/** on-device: private + offline. downloadable: can become on-device after install(). online: audio goes to Google. */
export type ChromeMode = 'on-device' | 'downloadable' | 'online' | 'unavailable';

interface RecognitionResult { isFinal: boolean; 0: { transcript: string } }
interface RecognitionEvent { resultIndex: number; results: ArrayLike<RecognitionResult> }
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface RecognitionCtor {
  new (): Recognition;
  available?(o: { langs: string[]; processLocally: boolean }): Promise<string>;
  install?(o: { langs: string[]; processLocally: boolean }): Promise<boolean>;
}

const ctor = (): RecognitionCtor | null => {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export async function chromeSpeechMode(lang = CHROME_LANG): Promise<ChromeMode> {
  const C = ctor();
  if (!C) return 'unavailable';
  if (!C.available) return 'online'; // older Chrome: cloud only
  try {
    const local = await C.available({ langs: [lang], processLocally: true });
    if (local === 'available') return 'on-device';
    if (local === 'downloadable' || local === 'downloading') return 'downloadable';
  } catch { /* fall through to cloud check */ }
  try {
    return (await C.available({ langs: [lang], processLocally: false })) === 'unavailable' ? 'unavailable' : 'online';
  } catch {
    return 'online';
  }
}

/** Download Chrome's on-device language pack. Needs internet once; afterwards offline. */
export async function installOnDevice(lang = CHROME_LANG): Promise<boolean> {
  const C = ctor();
  return !!C?.install && (await C.install({ langs: [lang], processLocally: true }));
}

export interface ChromeResult {
  text: string;
  startedAt: number;
  /** One segment per recognized phrase, timed from when Chrome first heard it. */
  segments: AsrSegment[];
}

export interface ChromeSession {
  stop(): Promise<ChromeResult>;
  cancel(): void;
}

const MESSAGES: Record<string, string> = {
  'not-allowed': 'Microphone permission was denied. Allow the mic for this site in Chrome.',
  'audio-capture': 'No microphone found.',
  network: 'Chrome speech needs the internet in online mode. Download on-device speech, or switch to Whisper.',
  'language-not-supported': 'This language is not available for on-device recognition.',
};

/**
 * Listen continuously until stop(). `onText` gets the running transcript (final +
 * interim) for live display. Chrome ends sessions on its own after silence; we restart
 * until the medic presses Stop, so a pause mid-dictation doesn't lose the rest.
 */
export function startChromeSpeech(mode: ChromeMode, onText: (text: string) => void, onError: (msg: string) => void, lang = CHROME_LANG): ChromeSession {
  const C = ctor();
  if (!C) throw new Error('Chrome speech recognition is not available in this browser');
  const startedAt = Date.now();
  const finals: { text: string; at: number }[] = [];
  let interim: { text: string; at: number } | null = null;
  let interimStart: number | null = null; // when Chrome first heard the phrase in progress
  let stopping = false;
  let ended = false;
  let finish: (() => void) | null = null;
  let rec: Recognition;

  const running = () => [...finals.map((f) => f.text), interim?.text ?? ''].join(' ').replace(/\s+/g, ' ').trim();

  const launch = () => {
    rec = new C();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    if (mode === 'on-device') rec.processLocally = true;
    let sessionFinals = 0;
    rec.onresult = (e) => {
      interim = null;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          if (i >= sessionFinals) {
            finals.push({ text: r[0].transcript.trim(), at: interimStart ?? Date.now() });
            sessionFinals = i + 1;
            interimStart = null;
          }
        } else {
          interimStart ??= Date.now();
          interim = { text: r[0].transcript.trim(), at: interimStart };
        }
      }
      onText(running());
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      stopping = true;
      onError(MESSAGES[e.error] ?? `Chrome speech error: ${e.error}`);
    };
    rec.onend = () => {
      if (!stopping) return launch(); // Chrome stopped after a pause: keep listening
      ended = true;
      finish?.();
    };
    rec.start();
  };
  launch();

  return {
    stop: () =>
      new Promise((resolve) => {
        finish = () => {
          if (interim) finals.push(interim); // words still being recognized at Stop
          const text = finals.map((f) => f.text).filter(Boolean).join(' ');
          // Segment offsets index this exact text, so time stamping can find each phrase.
          resolve({ text, startedAt, segments: finals.filter((f) => f.text).map((f) => ({ text: f.text, start: (f.at - startedAt) / 1000, end: null })) });
        };
        stopping = true;
        if (ended) finish(); // already ended (e.g. after an error): no onend will come
        else rec.stop();
      }),
    cancel: () => {
      stopping = true;
      rec.onend = null;
      rec.abort();
    },
  };
}
