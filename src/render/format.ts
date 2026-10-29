// Shared display formatting for the HTML and PDF reports, so both stay identical.

import { eventTime } from '../record/fhir';
import type { ClinicalRecord, MedicationEvent, ProcedureEvent, TimeSource } from '../record/schema';

export const ROUTE_NAMES: Record<string, string> = {
  IV: 'IV', IO: 'IO', IM: 'IM', SC: 'SC', PO: 'PO', SL: 'SL', IN: 'IN', NEB: 'Neb', INH: 'Inhaled', ETT: 'ETT', TOP: 'Topical', PR: 'PR',
};

const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

/** Suffix shown after a time, so a report never hides where the time came from. Stated times have none. */
export const TIME_LABEL: Record<TimeSource | 'capture', string> = {
  dictated: '', spoken: ' (at speech)', entered: ' (at entry)', edited: ' (edited)', capture: ' (capture)',
};

/** "14:32" if stated aloud, "14:40 (at speech)" for a device-clock stamp, etc. */
export function timeCell(r: ClinicalRecord, t: string | null, source?: TimeSource): string {
  const { when, timeSource } = eventTime(r.recordedAt, t, source);
  return hhmm(when) + TIME_LABEL[timeSource];
}

export const medRow = (r: ClinicalRecord, m: MedicationEvent) => [
  timeCell(r, m.administeredAt, m.timeSource),
  m.drug ?? '— unidentified —',
  m.dose !== null ? `${m.dose} ${m.unit ?? '?'}` : '—',
  m.route ? ROUTE_NAMES[m.route] ?? m.route : '—',
  m.site ?? '',
  m.confirmed ? 'yes' : 'no',
];

export const procRow = (r: ClinicalRecord, p: ProcedureEvent) => [
  timeCell(r, p.performedAt, p.timeSource),
  p.procedure,
  p.detail ?? '',
  p.site ?? '',
  p.confirmed ? 'yes' : 'no',
];

export const MED_HEAD = ['Time', 'Medication', 'Dose', 'Route', 'Site', 'Confirmed'];
export const PROC_HEAD = ['Time', 'Procedure', 'Detail', 'Site', 'Confirmed'];

export const fileBase = (r: ClinicalRecord) => `field-record_${r.incidentId}_v${r.version}`.replace(/[^\w.-]+/g, '-');
