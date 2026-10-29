import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeSpeechMode, startChromeSpeech } from '../src/asr/chromeSpeech';

// A fake of Chrome's SpeechRecognition, driven by the test.
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  static local = 'downloadable';
  static available = vi.fn(async ({ processLocally }: { processLocally: boolean }) => (processLocally ? FakeRecognition.local : 'available'));
  lang = '';
  continuous = false;
  interimResults = false;
  processLocally?: boolean;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  results: { isFinal: boolean; 0: { transcript: string } }[] = [];
  constructor() { FakeRecognition.instances.push(this); }
  start() {}
  stop() { queueMicrotask(() => this.onend?.()); }
  abort() {}
  say(transcript: string, isFinal: boolean) {
    const i = this.results.findIndex((r) => !r.isFinal);
    const r = { isFinal, 0: { transcript } };
    if (i === -1) this.results.push(r); else this.results[i] = r;
    this.onresult?.({ resultIndex: Math.max(0, i), results: this.results });
  }
}

beforeEach(() => {
  FakeRecognition.instances = [];
  vi.stubGlobal('window', { SpeechRecognition: FakeRecognition });
});
afterEach(() => vi.unstubAllGlobals());

describe('Chrome speech', () => {
  it('reports on-device only when the language pack is installed', async () => {
    FakeRecognition.local = 'downloadable';
    expect(await chromeSpeechMode()).toBe('downloadable');
    FakeRecognition.local = 'available';
    expect(await chromeSpeechMode()).toBe('on-device');
    FakeRecognition.local = 'unavailable';
    expect(await chromeSpeechMode()).toBe('online');
  });

  it('forces on-device processing so audio cannot silently go to the cloud', () => {
    startChromeSpeech('on-device', () => {}, () => {});
    expect(FakeRecognition.instances[0]).toMatchObject({ processLocally: true, continuous: true, lang: 'en-IN' });
    startChromeSpeech('online', () => {}, () => {});
    expect(FakeRecognition.instances[1].processLocally).toBeUndefined();
  });

  it('keeps listening after Chrome ends a session on a pause, and keeps all the text', async () => {
    const live: string[] = [];
    const s = startChromeSpeech('on-device', (t) => live.push(t), () => {});
    const first = FakeRecognition.instances[0];
    first.say('aspirin 300', false);
    first.say('aspirin 300 mg by mouth', true);
    first.onend!(); // Chrome stopped by itself after silence
    expect(FakeRecognition.instances).toHaveLength(2); // restarted
    FakeRecognition.instances[1].say('oxygen 4 litres', true);
    const r = await s.stop();
    expect(r.text).toBe('aspirin 300 mg by mouth oxygen 4 litres');
    expect(r.segments.map((x) => x.text)).toEqual(['aspirin 300 mg by mouth', 'oxygen 4 litres']);
    expect(live.at(-1)).toBe('aspirin 300 mg by mouth oxygen 4 litres');
  });

  it('keeps words still being recognized when Stop is pressed', async () => {
    const s = startChromeSpeech('on-device', () => {}, () => {});
    FakeRecognition.instances[0].say('morphine 2 mg', false);
    expect((await s.stop()).text).toBe('morphine 2 mg');
  });

  it('reports a permission error and still lets Stop finish', async () => {
    const errors: string[] = [];
    const s = startChromeSpeech('online', () => {}, (m) => errors.push(m));
    const rec = FakeRecognition.instances[0];
    rec.onerror!({ error: 'not-allowed' });
    rec.onend!();
    expect(errors[0]).toContain('permission');
    expect(FakeRecognition.instances).toHaveLength(1); // no restart loop after an error
    await expect(s.stop()).resolves.toMatchObject({ text: '' });
  });
});
