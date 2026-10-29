// Spoken read-back of a record before signing (closed-loop confirmation: the medic
// hears what will be sealed). Uses the OS speech engine via speechSynthesis.
//
// Privacy: some browser voices (e.g. Chrome's "Google ..." voices) synthesize on a
// server, which would send the record text off the device. Only voices that report
// `localService: true` are used; if none exists, read-back is unavailable.

import type { ClinicalRecord } from '../record/schema';

const UNIT_WORDS: Record<string, string> = {
  mcg: 'micrograms', mg: 'milligrams', g: 'grams', ml: 'millilitres', l: 'litres', lpm: 'litres per minute', units: 'units',
  meq: 'milliequivalents', j: 'joules', puffs: 'puffs', 'mg/kg': 'milligrams per kilo', 'mcg/kg': 'micrograms per kilo',
  'mcg/min': 'micrograms per minute', 'mcg/kg/min': 'micrograms per kilo per minute',
};
const ROUTE_WORDS: Record<string, string> = {
  IV: 'intravenous', IO: 'intraosseous', IM: 'intramuscular', SC: 'subcutaneous', PO: 'by mouth', SL: 'sublingual',
  IN: 'intranasal', NEB: 'nebulised', INH: 'inhaled', ETT: 'via the E T tube', TOP: 'topical', PR: 'rectal',
};

/** "14:05" -> "14 05" so engines say "fourteen oh five" rather than a ratio. */
const sayTime = (t: string | null) => (t ? `, at ${t.replace(':', ' ')}` : '');

export function readbackText(r: ClinicalRecord): string {
  const parts: string[] = [`Incident ${r.incidentId.split('-').at(-1)}.`];
  for (const m of r.medications) {
    const dose = m.dose !== null ? `${m.dose} ${UNIT_WORDS[m.unit ?? ''] ?? m.unit ?? 'no unit'}` : 'dose not recorded';
    parts.push(`${m.drug ?? 'Unidentified drug'}, ${dose}, ${m.route ? ROUTE_WORDS[m.route] ?? m.route : 'route not recorded'}${sayTime(m.administeredAt)}.`);
  }
  for (const p of r.procedures) {
    parts.push(`${p.procedure}${p.detail ? `, ${p.detail.replace(/G$/, ' gauge')}` : ''}${p.site ? `, ${p.site}` : ''}${sayTime(p.performedAt)}.`);
  }
  if (!r.medications.length && !r.procedures.length) parts.push('No medications or procedures recorded.');
  return parts.join(' ');
}

async function voices(): Promise<SpeechSynthesisVoice[]> {
  const now = speechSynthesis.getVoices();
  if (now.length) return now;
  // Voice lists load asynchronously in Chrome.
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

export const speechAvailable = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

/** Speak the text with an on-device English voice. Resolves false if no on-device voice exists. */
export async function speakLocally(text: string): Promise<boolean> {
  if (!speechAvailable()) return false;
  const local = (await voices()).filter((v) => v.localService);
  const voice = local.find((v) => v.lang === 'en-IN') ?? local.find((v) => v.lang.startsWith('en')) ?? null;
  if (!voice) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = 0.95;
  speechSynthesis.speak(u);
  return true;
}
