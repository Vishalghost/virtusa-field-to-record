// Record lifecycle: create a draft from a transcript, apply reviewer edits (each one
// logged), and amend a signed record as a new linked version.

import { toRawOffset, type SpeechRepair } from '../asr/repair';
import { secondsAt, type AsrSegment } from '../asr/timing';
import { processTranscript } from '../nlp/pipeline';
import { drugByName } from '../nlp/lexicon';
import { medicationFlags, procedureFlags, isBlocked } from '../nlp/review';
import type { ClinicalRecord, MedicationEvent, ProcedureEvent, TimeSource } from './schema';

const uuid = () => crypto.randomUUID();

export interface SpeechInfo {
  rawTranscript: string;
  repairs: SpeechRepair[];
  /** Device clock (epoch ms) when the audio started. */
  startedAt?: number;
  /** Whisper segment timings, for per-item spoken-at times. */
  segments?: AsrSegment[];
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * Give every event a time without anyone typing one. A time said aloud wins; otherwise
 * the device clock at the moment the item was spoken (voice) or the note was entered
 * (typed). The source is recorded so a clock stamp is never mistaken for a stated time.
 */
function stampTimes(meds: MedicationEvent[], procs: ProcedureEvent[], now: Date, speech?: SpeechInfo) {
  const clockFor = (ev: MedicationEvent | ProcedureEvent): { at: Date; source: TimeSource } => {
    if (!speech?.startedAt) return { at: now, source: 'entered' };
    const offset = toRawOffset(ev.sourceSpans[0]?.start ?? 0, speech.repairs);
    const seconds = speech.segments?.length ? secondsAt(offset, speech.rawTranscript, speech.segments) : 0;
    return { at: new Date(speech.startedAt + seconds * 1000), source: 'spoken' };
  };
  for (const m of meds) {
    if (m.administeredAt) m.timeSource = 'dictated';
    else { const c = clockFor(m); m.administeredAt = hhmm(c.at); m.timeSource = c.source; }
    m.flags = medicationFlags(m);
  }
  for (const p of procs) {
    if (p.performedAt) p.timeSource = 'dictated';
    else { const c = clockFor(p); p.performedAt = hhmm(c.at); p.timeSource = c.source; }
    p.flags = procedureFlags(p);
  }
}

/** Any event whose source text was produced by a speech repair must be confirmed by a human. */
function flagRepaired(events: (MedicationEvent | ProcedureEvent)[], repairs: SpeechRepair[]) {
  for (const ev of events) {
    const hit = repairs.filter((r) => ev.sourceSpans.some((s) => s.start < r.end && s.end > r.start));
    if (hit.length) {
      ev.flags.push({ severity: 'block', reason: `Speech fix-up: heard ${hit.map((r) => `"${r.heard}" as "${r.readAs}"`).join(', ')}; confirm` });
    }
  }
}

export function createDraft(transcript: string, source: 'voice' | 'text', incidentId: string, now = new Date(), speech?: SpeechInfo): ClinicalRecord {
  const { medications, procedures } = processTranscript(transcript);
  const repairs = speech?.repairs ?? [];
  stampTimes(medications, procedures, now, speech);
  flagRepaired([...medications, ...procedures], repairs);
  return {
    id: uuid(),
    version: 1,
    supersedes: null,
    incidentId,
    source,
    // Event times are "HH:MM" on this date, so use when speaking started, not when extraction ran.
    recordedAt: (speech?.startedAt ? new Date(speech.startedAt) : now).toISOString(),
    transcript,
    ...(repairs.length ? { rawTranscript: speech!.rawTranscript, speechRepairs: repairs } : {}),
    medications,
    procedures,
    edits: [],
    status: 'draft',
    signedBy: null,
    signedAt: null,
    prevHash: null,
    hash: null,
  };
}

type MedField = 'drug' | 'dose' | 'unit' | 'route' | 'site' | 'administeredAt';
type ProcField = 'procedure' | 'detail' | 'site' | 'performedAt';

function assertDraft(r: ClinicalRecord) {
  if (r.status !== 'draft') throw new Error('Signed records are read-only; amend instead');
}

/** Reviewer changes one field. The change is logged and counts as confirming the event. */
export function editMedication(r: ClinicalRecord, eventId: string, field: MedField, value: string | number | null, now = new Date()): ClinicalRecord {
  assertDraft(r);
  const next = structuredClone(r);
  const ev = next.medications.find((m) => m.id === eventId);
  if (!ev) throw new Error(`No medication ${eventId}`);
  const from = ev[field];
  if (from === value) return r;
  (ev as unknown as Record<string, unknown>)[field] = value;
  if (field === 'drug') {
    ev.rxnorm = typeof value === 'string' ? (drugByName(value)?.rxnorm ?? null) : null;
    ev.confidence = 1; // a human typed it
  }
  if (field === 'administeredAt') {
    if (value === null) delete ev.timeSource;
    else ev.timeSource = 'edited';
  }
  ev.confirmed = true;
  ev.flags = medicationFlags(ev);
  next.edits.push({ at: now.toISOString(), eventId, field, from, to: value });
  return next;
}

export function editProcedure(r: ClinicalRecord, eventId: string, field: ProcField, value: string | null, now = new Date()): ClinicalRecord {
  assertDraft(r);
  const next = structuredClone(r);
  const ev = next.procedures.find((p) => p.id === eventId);
  if (!ev) throw new Error(`No procedure ${eventId}`);
  const from = ev[field];
  if (from === value) return r;
  (ev as unknown as Record<string, unknown>)[field] = value;
  if (field === 'performedAt') {
    if (value === null) delete ev.timeSource;
    else ev.timeSource = 'edited';
  }
  ev.confirmed = true;
  ev.flags = procedureFlags(ev);
  next.edits.push({ at: now.toISOString(), eventId, field, from, to: value });
  return next;
}

/** Reviewer accepts an event as extracted. */
export function confirmEvent(r: ClinicalRecord, eventId: string, now = new Date()): ClinicalRecord {
  assertDraft(r);
  const next = structuredClone(r);
  const ev: MedicationEvent | ProcedureEvent | undefined =
    next.medications.find((m) => m.id === eventId) ?? next.procedures.find((p) => p.id === eventId);
  if (!ev || ev.confirmed) return r;
  ev.confirmed = true;
  next.edits.push({ at: now.toISOString(), eventId, field: 'confirmed', from: false, to: true });
  return next;
}

/** Reviewer deletes a wrongly extracted event (logged with the full removed event). */
export function removeEvent(r: ClinicalRecord, eventId: string, now = new Date()): ClinicalRecord {
  assertDraft(r);
  const next = structuredClone(r);
  const removed = next.medications.find((m) => m.id === eventId) ?? next.procedures.find((p) => p.id === eventId);
  if (!removed) return r;
  next.medications = next.medications.filter((m) => m.id !== eventId);
  next.procedures = next.procedures.filter((p) => p.id !== eventId);
  next.edits.push({ at: now.toISOString(), eventId, field: 'removed', from: removed, to: null });
  return next;
}

export function addMedication(r: ClinicalRecord, now = new Date()): ClinicalRecord {
  assertDraft(r);
  const next = structuredClone(r);
  const ev: MedicationEvent = {
    kind: 'medication', id: `med-manual-${next.edits.length + 1}-${Date.now()}`, drug: null, rxnorm: null, dose: null, unit: null,
    route: null, site: null, administeredAt: null, confidence: 1, sourceSpans: [], flags: [], confirmed: false,
  };
  ev.flags = medicationFlags(ev);
  next.medications.push(ev);
  next.edits.push({ at: now.toISOString(), eventId: ev.id, field: 'added', from: null, to: 'medication' });
  return next;
}

export const signingBlockers = (r: ClinicalRecord) => [...r.medications, ...r.procedures].filter(isBlocked);

/** Start a correction of a signed record: a new draft version pointing at the old one. */
export function amend(signed: ClinicalRecord): ClinicalRecord {
  if (signed.status !== 'signed') throw new Error('Only signed records can be amended');
  return {
    ...structuredClone(signed),
    id: uuid(),
    version: signed.version + 1,
    supersedes: signed.id,
    edits: [],
    status: 'draft',
    signedBy: null,
    signedAt: null,
    prevHash: null,
    hash: null,
  };
}
