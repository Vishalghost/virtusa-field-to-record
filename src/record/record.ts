// Record lifecycle: create a draft from a transcript, apply reviewer edits (each one
// logged), and amend a signed record as a new linked version.

import type { SpeechRepair } from '../asr/repair';
import { processTranscript } from '../nlp/pipeline';
import { drugByName } from '../nlp/lexicon';
import { medicationFlags, procedureFlags, isBlocked } from '../nlp/review';
import type { ClinicalRecord, MedicationEvent, ProcedureEvent } from './schema';

const uuid = () => crypto.randomUUID();

export interface SpeechInfo {
  rawTranscript: string;
  repairs: SpeechRepair[];
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
  flagRepaired([...medications, ...procedures], repairs);
  return {
    id: uuid(),
    version: 1,
    supersedes: null,
    incidentId,
    source,
    recordedAt: now.toISOString(),
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
