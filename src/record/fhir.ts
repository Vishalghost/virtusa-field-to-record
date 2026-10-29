// "FHIR-lite": a FHIR R4-shaped Bundle (MedicationAdministration, Procedure,
// Provenance) so the record can be ingested by FHIR tooling, while staying small.
// Simplifications: no Patient/Encounter resources (synthetic data only), procedure
// and route codes are local code systems, not SNOMED CT.

import type { ClinicalRecord, MedicationEvent, ProcedureEvent, TimeSource } from './schema';

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const UCUM = 'http://unitsofmeasure.org';
const LOCAL = 'urn:field-to-record';

const UCUM_CODES: Record<string, string> = {
  mcg: 'ug', mg: 'mg', g: 'g', ml: 'mL', l: 'L', lpm: 'L/min', units: '[iU]', meq: 'meq', j: 'J', puffs: '{puff}',
  'mg/kg': 'mg/kg', 'mcg/kg': 'ug/kg', 'mcg/min': 'ug/min', 'mcg/kg/min': 'ug/kg/min',
};

const ROUTE_TEXT: Record<string, string> = {
  IV: 'Intravenous', IO: 'Intraosseous', IM: 'Intramuscular', SC: 'Subcutaneous', PO: 'Oral', SL: 'Sublingual',
  IN: 'Intranasal', NEB: 'Nebulized', INH: 'Inhalation', ETT: 'Endotracheal', TOP: 'Topical', PR: 'Rectal',
};

/**
 * Combine the capture date with the event's "HH:MM". Every output carries where the
 * time came from (`timeSource`), so a device-clock stamp is never read as a stated time.
 * No time at all falls back to the capture timestamp, labelled 'capture'.
 */
export function eventTime(recordedAt: string, hhmm: string | null, source?: TimeSource): { when: string; timeSource: TimeSource | 'capture' } {
  if (!hhmm) return { when: recordedAt, timeSource: 'capture' };
  const d = new Date(recordedAt);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  // Records from before timeSource existed only had stated times in this field.
  return { when: d.toISOString(), timeSource: source ?? 'dictated' };
}

const ext = (name: string, value: string | boolean) => ({
  url: `${LOCAL}/StructureDefinition/${name}`,
  ...(typeof value === 'boolean' ? { valueBoolean: value } : { valueString: value }),
});

function medicationResource(r: ClinicalRecord, m: MedicationEvent) {
  const t = eventTime(r.recordedAt, m.administeredAt, m.timeSource);
  return {
    resourceType: 'MedicationAdministration',
    id: m.id,
    status: 'completed',
    medicationCodeableConcept: {
      text: m.drug ?? 'UNIDENTIFIED',
      coding: m.rxnorm ? [{ system: RXNORM, code: m.rxnorm, display: m.drug }] : [],
    },
    subject: { display: 'Synthetic patient' },
    effectiveDateTime: t.when,
    dosage: {
      ...(m.route ? { route: { coding: [{ system: `${LOCAL}/route`, code: m.route, display: ROUTE_TEXT[m.route] ?? m.route }] } } : {}),
      ...(m.site ? { site: { text: m.site } } : {}),
      ...(m.dose !== null ? { dose: { value: m.dose, unit: m.unit ?? undefined, system: m.unit ? UCUM : undefined, code: m.unit ? UCUM_CODES[m.unit] : undefined } } : {}),
    },
    extension: [ext('timeSource', t.timeSource), ext('humanConfirmed', m.confirmed)],
  };
}

function procedureResource(r: ClinicalRecord, p: ProcedureEvent) {
  const t = eventTime(r.recordedAt, p.performedAt, p.timeSource);
  return {
    resourceType: 'Procedure',
    id: p.id,
    status: 'completed',
    code: { text: p.procedure, coding: [{ system: `${LOCAL}/procedure`, code: p.code, display: p.procedure }] },
    subject: { display: 'Synthetic patient' },
    performedDateTime: t.when,
    ...(p.site ? { bodySite: [{ text: p.site }] } : {}),
    ...(p.detail ? { note: [{ text: p.detail }] } : {}),
    extension: [ext('timeSource', t.timeSource), ext('humanConfirmed', p.confirmed)],
  };
}

export function toFhirBundle(r: ClinicalRecord) {
  const meds = r.medications.map((m) => medicationResource(r, m));
  const procs = r.procedures.map((p) => procedureResource(r, p));
  const provenance = {
    resourceType: 'Provenance',
    id: `prov-${r.id}`,
    target: [...meds, ...procs].map((x) => ({ reference: `${x.resourceType}/${x.id}` })),
    recorded: r.signedAt ?? r.recordedAt,
    agent: [{ who: { display: r.signedBy ?? 'unsigned' } }],
    extension: [
      ext('recordId', r.id),
      ext('recordVersion', String(r.version)),
      ...(r.supersedes ? [ext('supersedes', r.supersedes)] : []),
      ext('captureSource', r.source),
      ...(r.hash ? [ext('sha256', r.hash), ext('prevSha256', r.prevHash ?? '')] : []),
    ],
  };
  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: r.signedAt ?? r.recordedAt,
    identifier: { system: `${LOCAL}/incident`, value: r.incidentId },
    entry: [...meds, ...procs, provenance].map((resource) => ({ fullUrl: `${LOCAL}:${resource.resourceType}/${resource.id}`, resource })),
  };
}
