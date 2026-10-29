// Shared display formatting for the HTML and PDF reports, so both stay identical.

import { eventTime } from '../record/fhir';
import type { ClinicalRecord, MedicationEvent, ProcedureEvent } from '../record/schema';

export const ROUTE_NAMES: Record<string, string> = {
  IV: 'IV', IO: 'IO', IM: 'IM', SC: 'SC', PO: 'PO', SL: 'SL', IN: 'IN', NEB: 'Neb', INH: 'Inhaled', ETT: 'ETT', TOP: 'Topical', PR: 'PR',
};

const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

/** "14:32" if dictated, "14:40 (capture)" if not: the report never hides where a time came from. */
export function timeCell(r: ClinicalRecord, t: string | null): string {
  const { when, timeSource } = eventTime(r.recordedAt, t);
  return timeSource === 'dictated' ? hhmm(when) : `${hhmm(when)} (capture)`;
}

export const medRow = (r: ClinicalRecord, m: MedicationEvent) => [
  timeCell(r, m.administeredAt),
  m.drug ?? '— unidentified —',
  m.dose !== null ? `${m.dose} ${m.unit ?? '?'}` : '—',
  m.route ? ROUTE_NAMES[m.route] ?? m.route : '—',
  m.site ?? '',
  m.confirmed ? 'yes' : 'no',
];

export const procRow = (r: ClinicalRecord, p: ProcedureEvent) => [
  timeCell(r, p.performedAt),
  p.procedure,
  p.detail ?? '',
  p.site ?? '',
  p.confirmed ? 'yes' : 'no',
];

export const MED_HEAD = ['Time', 'Medication', 'Dose', 'Route', 'Site', 'Confirmed'];
export const PROC_HEAD = ['Time', 'Procedure', 'Detail', 'Site', 'Confirmed'];

export const fileBase = (r: ClinicalRecord) => `field-record_${r.incidentId}_v${r.version}`.replace(/[^\w.-]+/g, '-');
